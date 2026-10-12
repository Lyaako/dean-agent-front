CREATE FUNCTION agent_backend.file_version_visible(p_version UUID,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM agent_backend.file_version v JOIN agent_backend.file f ON f.id=v.file_id
 JOIN deanery.app_user u ON u.user_id=f.owner_user_id WHERE v.id=p_version AND f.owner_user_id=p_user AND u.is_active)
$$;

CREATE FUNCTION agent_backend.file_descriptor(p_version UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('file_id',f.id,'version_id',v.id,'filename',v.original_name,'title',f.name,
 'mime',v.mime_type,'byte_size',v.byte_size,'content_hash',encode(v.content_hash,'hex'),'storage_key',v.storage_key,
 'extraction_state',v.extraction_state,'extraction',v.extraction)
 FROM agent_backend.file_version v JOIN agent_backend.file f ON f.id=v.file_id WHERE v.id=p_version
$$;

CREATE FUNCTION backend_api.download_file(p_file UUID,p_version UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); result JSONB;
BEGIN
 IF NOT agent_backend.file_version_visible(p_version,v_user) THEN RAISE EXCEPTION 'File missing' USING ERRCODE='P0002'; END IF;
 result:=agent_backend.file_descriptor(p_version);
 IF result->>'file_id' IS DISTINCT FROM p_file::TEXT THEN RAISE EXCEPTION 'File missing' USING ERRCODE='P0002'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION agent_backend.file_job_view(j agent_backend.job) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',j.id,'kind',j.kind,'status',j.status,'attempts',j.attempts,'max_attempts',j.max_attempts,
 'progress',j.progress,'error_code',j.error_code,'result',
 (agent_backend.file_descriptor((j.payload->>'version_id')::UUID)-'storage_key'-'content_hash'-'extraction') ||
 jsonb_build_object('coverage',v.extraction->'coverage','warnings',COALESCE(v.extraction->'warnings','[]'::JSONB)))
 FROM agent_backend.file_version v WHERE v.id=(j.payload->>'version_id')::UUID
$$;

CREATE FUNCTION backend_api.job_status(p_job UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); j agent_backend.job;
BEGIN
 SELECT * INTO j FROM agent_backend.job WHERE id=p_job;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job missing' USING ERRCODE='P0002'; END IF;
 IF j.kind<>'attachment' THEN RETURN backend_api.order_job_status(p_job,p_token); END IF;
 IF j.owner_user_id IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'Job missing' USING ERRCODE='P0002'; END IF;
 RETURN agent_backend.file_job_view(j);
END $$;

CREATE FUNCTION backend_api.register_file(p_file UUID,p_version UUID,p_name TEXT,p_title TEXT,p_mime TEXT,p_size BIGINT,
 p_hash BYTEA,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); saved agent_backend.idempotency_record; v_hash BYTEA;
 j agent_backend.job; result JSONB;
BEGIN
 IF p_file IS NULL OR p_version IS NULL OR p_key IS NULL OR p_size IS NULL OR p_size NOT BETWEEN 1 AND 10000000
 OR p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 255 OR p_name ~ '[[:cntrl:]/\\]'
 OR p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 255 OR p_hash IS NULL OR octet_length(p_hash)<>32
 OR p_mime IS NULL OR p_mime NOT IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain')
 THEN RAISE EXCEPTION 'Invalid file' USING ERRCODE='22023'; END IF;
 v_hash:=sha256(convert_to(jsonb_build_array(p_name,btrim(p_title),p_mime,p_size,encode(p_hash,'hex'))::TEXT,'UTF8'));
 INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash) VALUES(v_user,'/files',p_key,v_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=v_user AND route='/files' AND key=p_key FOR UPDATE;
 IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Key conflict' USING ERRCODE='P6001'; END IF;
 IF saved.response_body IS NOT NULL THEN
   SELECT * INTO j FROM agent_backend.job WHERE id=(saved.response_body->>'job_id')::UUID;
   RETURN jsonb_build_object('file_id',saved.response_body->'file_id','version_id',saved.response_body->'version_id','job',agent_backend.file_job_view(j));
 END IF;
 INSERT INTO agent_backend.file(id,owner_user_id,name) VALUES(p_file,v_user,btrim(p_title));
 INSERT INTO agent_backend.file_version(id,file_id,original_name,mime_type,byte_size,storage_key,content_hash)
 VALUES(p_version,p_file,p_name,p_mime,p_size,'originals/'||p_file::TEXT||'/'||p_version::TEXT,p_hash);
 INSERT INTO agent_backend.job(owner_user_id,kind,payload,max_attempts) VALUES(v_user,'attachment',jsonb_build_object('version_id',p_version),3) RETURNING * INTO j;
 result:=jsonb_build_object('file_id',p_file,'version_id',p_version,'job',agent_backend.file_job_view(j));
 UPDATE agent_backend.idempotency_record SET response_status=201,response_body=jsonb_build_object('file_id',p_file,'version_id',p_version,'job_id',j.id)
 WHERE user_id=v_user AND route='/files' AND key=p_key;
 RETURN result;
END $$;

CREATE FUNCTION backend_api.claim_file_job(p_worker UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agent_backend.job;
BEGIN
 IF p_worker IS NULL THEN RAISE EXCEPTION 'Worker required' USING ERRCODE='22023'; END IF;
 WITH lost AS (UPDATE agent_backend.job SET status='failed',error_code='lease_exhausted',finished_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL
 WHERE kind='attachment' AND status='running' AND lease_until<=clock_timestamp() AND attempts>=max_attempts RETURNING payload)
 UPDATE agent_backend.file_version SET extraction_state=CASE WHEN COALESCE((extraction->>'total_chunks')::INT,0)>0 THEN 'partial' ELSE 'failed' END,
 extraction=jsonb_set(extraction,'{warnings}',COALESCE(extraction->'warnings','[]')||'"lease_exhausted"'::JSONB)
 WHERE id IN (SELECT (payload->>'version_id')::UUID FROM lost);
 SELECT * INTO j FROM agent_backend.job WHERE kind='attachment' AND attempts<max_attempts AND
 ((status='queued' AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<=clock_timestamp()))
 ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE agent_backend.job SET status='running',attempts=attempts+1,lease_owner=p_worker,
 lease_until=clock_timestamp()+INTERVAL '120 seconds',error_code=NULL WHERE id=j.id RETURNING * INTO j;
 UPDATE agent_backend.file_version SET extraction_state='processing' WHERE id=(j.payload->>'version_id')::UUID;
 RETURN jsonb_build_object('job_id',j.id,'attempts',j.attempts,'max_attempts',j.max_attempts,'file',agent_backend.file_descriptor((j.payload->>'version_id')::UUID));
END $$;

CREATE FUNCTION backend_api.renew_file_job(p_job UUID,p_worker UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE agent_backend.job SET lease_until=clock_timestamp()+INTERVAL '120 seconds'
 WHERE id=p_job AND kind='attachment' AND status='running' AND lease_owner=p_worker AND lease_until>clock_timestamp();
 RETURN FOUND;
END $$;

CREATE FUNCTION backend_api.checkpoint_file_job(p_job UUID,p_worker UUID,p_extraction JSONB,p_state TEXT,p_error TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agent_backend.job; v_done BOOLEAN:=p_state IN ('ready','partial','failed'); v_progress NUMERIC;
BEGIN
 SELECT * INTO j FROM agent_backend.job WHERE id=p_job AND kind='attachment' FOR UPDATE;
 IF NOT FOUND OR p_worker IS NULL OR j.status<>'running' OR j.lease_owner IS DISTINCT FROM p_worker OR j.lease_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'Lease lost' USING ERRCODE='P8103'; END IF;
 IF p_state IS NULL OR p_state NOT IN ('processing','ready','partial','failed') OR jsonb_typeof(p_extraction) IS DISTINCT FROM 'object'
 OR octet_length(p_extraction::TEXT)>1048576 THEN RAISE EXCEPTION 'Invalid checkpoint' USING ERRCODE='22023'; END IF;
 v_progress:=LEAST(100,GREATEST(0,COALESCE((p_extraction->>'completed_units')::NUMERIC,0)*100/GREATEST(1,COALESCE((p_extraction->>'total_units')::NUMERIC,1))));
 UPDATE agent_backend.file_version SET extraction=p_extraction,extraction_state=p_state WHERE id=(j.payload->>'version_id')::UUID;
 UPDATE agent_backend.job SET status=CASE WHEN p_state='failed' THEN 'failed' WHEN v_done THEN 'succeeded' ELSE 'running' END,
 progress=v_progress,error_code=p_error,result=jsonb_build_object('extraction_state',p_state),
 lease_owner=CASE WHEN v_done THEN NULL ELSE lease_owner END,lease_until=CASE WHEN v_done THEN NULL ELSE lease_until END,
 finished_at=CASE WHEN v_done THEN clock_timestamp() ELSE NULL END WHERE id=j.id RETURNING * INTO j;
 RETURN agent_backend.file_job_view(j);
END $$;

REVOKE ALL ON FUNCTION agent_backend.file_version_visible(UUID,INT),agent_backend.file_descriptor(UUID),agent_backend.file_job_view(agent_backend.job) FROM PUBLIC;
REVOKE ALL ON FUNCTION backend_api.download_file(UUID,UUID,TEXT),backend_api.job_status(UUID,TEXT),
 backend_api.register_file(UUID,UUID,TEXT,TEXT,TEXT,BIGINT,BYTEA,UUID,TEXT),backend_api.claim_file_job(UUID),
 backend_api.renew_file_job(UUID,UUID),backend_api.checkpoint_file_job(UUID,UUID,JSONB,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.download_file(UUID,UUID,TEXT),backend_api.job_status(UUID,TEXT),
 backend_api.register_file(UUID,UUID,TEXT,TEXT,TEXT,BIGINT,BYTEA,UUID,TEXT) TO backend_api;
GRANT EXECUTE ON FUNCTION backend_api.claim_file_job(UUID),backend_api.renew_file_job(UUID,UUID),
 backend_api.checkpoint_file_job(UUID,UUID,JSONB,TEXT,TEXT) TO backend_worker;
