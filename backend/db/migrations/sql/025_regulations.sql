CREATE FUNCTION agent_backend.knowledge_operator(p_token TEXT) RETURNS INT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token);
BEGIN
 IF NOT EXISTS(SELECT 1 FROM backend_api.account_snapshot(v_user) WHERE is_active AND role_code='admin')
 THEN RAISE EXCEPTION 'Operator admin required' USING ERRCODE='42501'; END IF;
 RETURN v_user;
END $$;

CREATE FUNCTION agent_backend.regulation_descriptor(p_version UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('regulation_id',r.id,'version_id',v.id,'title',r.title,'source',v.source,
 'storage_key',v.storage_key,'content_hash',encode(v.content_hash,'hex'),'processing_state',v.processing_state,
 'published_at',v.published_at,'published_by',v.published_by,'metadata',v.metadata,
 'version_label',v.metadata->'version_label','source_url',v.metadata->'source_url','scope',v.metadata->'scope',
 'filename',v.metadata->'filename','mime',v.metadata->'mime','byte_size',v.metadata->'byte_size',
 'extraction',COALESCE(v.metadata->'extraction','{}'::JSONB))
 FROM agent_backend.regulation_version v JOIN agent_backend.regulation r ON r.id=v.regulation_id WHERE v.id=p_version
$$;

CREATE FUNCTION agent_backend.regulation_version_visible(p_version UUID,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM agent_backend.regulation_version v CROSS JOIN backend_api.account_snapshot(p_user) a
 WHERE v.id=p_version AND a.is_active AND v.published_at IS NOT NULL
 AND v.metadata->>'withdrawn_at' IS NULL AND v.metadata->>'active_index_generation' IS NOT NULL
 AND (a.role_code='admin' OR v.metadata->'scope'->>'global'='true' OR EXISTS(
 SELECT 1 FROM jsonb_array_elements_text(v.metadata->'scope'->'institute_ids') x WHERE x::INT=ANY(a.institute_ids))))
$$;

CREATE FUNCTION agent_backend.regulation_chunk_view(p_chunk UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('regulation_id',r.id,'version_id',v.id,'chunk_id',c.id,'text',c.text,
 'text_hash',encode(sha256(convert_to(c.text,'UTF8')),'hex'),'generation_id',v.metadata->>'active_index_generation',
 'title',r.title,'version_label',v.metadata->'version_label','source',v.source,'source_url',v.metadata->'source_url','locator',c.locator)
 FROM agent_backend.regulation_chunk c JOIN agent_backend.regulation_version v ON v.id=c.version_id
 JOIN agent_backend.regulation r ON r.id=v.regulation_id WHERE c.id=p_chunk
$$;

CREATE FUNCTION agent_backend.regulation_chunk_evidence(p_chunk UUID,p_user INT,p_generation UUID) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT agent_backend.regulation_chunk_view(c.id) FROM agent_backend.regulation_chunk c
 JOIN agent_backend.regulation_version v ON v.id=c.version_id WHERE c.id=p_chunk
 AND agent_backend.regulation_version_visible(v.id,p_user)
 AND v.metadata->>'active_index_generation'=p_generation::TEXT
$$;

CREATE FUNCTION agent_backend.guard_regulation_original() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Normative evidence retained' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='regulation' THEN
   IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Title immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='regulation_chunk' THEN
   IF ROW(NEW.id,NEW.version_id,NEW.sequence,NEW.text,NEW.locator) IS DISTINCT FROM ROW(OLD.id,OLD.version_id,OLD.sequence,OLD.text,OLD.locator)
   THEN RAISE EXCEPTION 'Chunk immutable' USING ERRCODE='23514'; END IF;
 ELSE
   IF ROW(NEW.id,NEW.regulation_id,NEW.source,NEW.storage_key,NEW.content_hash,NEW.created_at,
       NEW.metadata-'extraction'-'chunk_manifest'-'index_manifest'-'active_index_generation'-'withdrawn_at'-'withdrawn_by'-'withdrawal_reason')
   IS DISTINCT FROM ROW(OLD.id,OLD.regulation_id,OLD.source,OLD.storage_key,OLD.content_hash,OLD.created_at,
       OLD.metadata-'extraction'-'chunk_manifest'-'index_manifest'-'active_index_generation'-'withdrawn_at'-'withdrawn_by'-'withdrawal_reason')
   OR (OLD.metadata ? 'chunk_manifest' AND NEW.metadata->'chunk_manifest' IS DISTINCT FROM OLD.metadata->'chunk_manifest')
   OR (OLD.published_at IS NOT NULL AND ROW(NEW.published_at,NEW.published_by,NEW.metadata->'extraction') IS DISTINCT FROM ROW(OLD.published_at,OLD.published_by,OLD.metadata->'extraction'))
   THEN RAISE EXCEPTION 'Normative original immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER regulation_immutable BEFORE UPDATE OR DELETE ON agent_backend.regulation FOR EACH ROW EXECUTE FUNCTION agent_backend.guard_regulation_original();
CREATE TRIGGER regulation_original_immutable BEFORE UPDATE OR DELETE ON agent_backend.regulation_version FOR EACH ROW EXECUTE FUNCTION agent_backend.guard_regulation_original();
CREATE TRIGGER regulation_chunk_immutable BEFORE UPDATE OR DELETE ON agent_backend.regulation_chunk FOR EACH ROW EXECUTE FUNCTION agent_backend.guard_regulation_original();

CREATE FUNCTION agent_backend.knowledge_audit(p_version UUID,p_user INT,p_action TEXT,p_detail JSONB) RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_audit BIGINT;
BEGIN
 INSERT INTO deanery.audit_log(table_name,record_key,operation,db_user,app_user_id)
 VALUES('regulation_version','id='||p_version::TEXT,CASE WHEN p_action='import' THEN 'I' ELSE 'U' END,session_user,p_user) RETURNING audit_id INTO v_audit;
 INSERT INTO deanery.audit_log_detail(audit_id,column_name,new_value) VALUES(v_audit,'knowledge_action',jsonb_build_object('action',p_action,'detail',p_detail)::TEXT);
END $$;

CREATE FUNCTION backend_api.reserve_regulation(p_input JSONB,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user INT:=agent_backend.knowledge_operator(p_token); saved agent_backend.idempotency_record;
 v_hash BYTEA; v_reg UUID; v_version UUID:=gen_random_uuid(); v_scope JSONB; v_meta JSONB; v_title TEXT; v_date DATE;
BEGIN
 IF p_key IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::TEXT)>16384
 OR p_input-'regulation_id'-'title'-'source'-'version_label'-'source_url'-'published_date'-'effective_date'-'scope'-'filename'-'mime'-'byte_size'-'content_hash'<>'{}'::JSONB
 OR length(btrim(COALESCE(p_input->>'title',''))) NOT BETWEEN 1 AND 255
 OR length(btrim(COALESCE(p_input->>'source',''))) NOT BETWEEN 1 AND 2000
 OR length(btrim(COALESCE(p_input->>'version_label',''))) NOT BETWEEN 1 AND 255
 OR length(COALESCE(p_input->>'filename','')) NOT BETWEEN 1 AND 255 OR p_input->>'filename' ~ '[[:cntrl:]/\\]'
 OR COALESCE(p_input->>'mime','') NOT IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain')
 OR COALESCE(p_input->>'byte_size','') !~ '^[0-9]{1,8}$' OR (p_input->>'byte_size')::BIGINT NOT BETWEEN 1 AND 10000000
 OR COALESCE(p_input->>'content_hash','') !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'Invalid regulation' USING ERRCODE='22023'; END IF;
 IF p_input->>'source_url' IS NOT NULL AND (length(p_input->>'source_url')>2000 OR p_input->>'source_url' !~ '^https?://[^/@[:space:]?#]+(:[0-9]+)?([/?#][^[:space:]]*)?$' OR p_input->>'source_url' ~ '[[:cntrl:]\\]')
 THEN RAISE EXCEPTION 'Invalid source URL' USING ERRCODE='22023'; END IF;
 FOREACH v_title IN ARRAY ARRAY['published_date','effective_date'] LOOP
   IF p_input->>v_title IS NOT NULL THEN
     IF p_input->>v_title !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid date' USING ERRCODE='22023'; END IF;
     v_date:=(p_input->>v_title)::DATE;
   END IF;
 END LOOP;
 v_scope:=p_input->'scope';
 IF jsonb_typeof(v_scope) IS DISTINCT FROM 'object' OR v_scope-'global'-'institute_ids'<>'{}'::JSONB
 OR jsonb_typeof(v_scope->'global') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_scope->'institute_ids') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'Explicit scope required' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(v_scope->'institute_ids')>1000 OR ((v_scope->>'global')::BOOLEAN AND jsonb_array_length(v_scope->'institute_ids')<>0)
 OR (NOT (v_scope->>'global')::BOOLEAN AND jsonb_array_length(v_scope->'institute_ids')=0)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_scope->'institute_ids') x WHERE jsonb_typeof(x)<>'number' OR x::TEXT !~ '^[1-9][0-9]{0,8}$')
 THEN RAISE EXCEPTION 'Invalid scope' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_scope->'institute_ids') x WHERE NOT EXISTS(SELECT 1 FROM deanery.institute WHERE institute_id=x::INT))
 THEN RAISE EXCEPTION 'Unknown institute' USING ERRCODE='22023'; END IF;
 v_hash:=sha256(convert_to(p_input::TEXT,'UTF8'));
 INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash) VALUES(v_user,'knowledge/import',p_key,v_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=v_user AND route='knowledge/import' AND key=p_key FOR UPDATE;
 IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Key conflict' USING ERRCODE='P6001'; END IF;
 IF saved.response_body IS NOT NULL THEN RETURN agent_backend.regulation_descriptor((saved.response_body->>'version_id')::UUID); END IF;
 v_reg:=COALESCE((p_input->>'regulation_id')::UUID,gen_random_uuid());
 v_title:=btrim(p_input->>'title');
 IF p_input->>'regulation_id' IS NULL THEN
   INSERT INTO agent_backend.regulation(id,title) VALUES(v_reg,v_title);
 ELSIF NOT EXISTS(SELECT 1 FROM agent_backend.regulation WHERE id=v_reg AND title=v_title) THEN
   RAISE EXCEPTION 'Regulation/title missing' USING ERRCODE='22023';
 END IF;
 v_meta:=(p_input-'regulation_id'-'title'-'source'-'content_hash')||jsonb_build_object('imported_by',v_user,'parser_revision','digital-v1');
 INSERT INTO agent_backend.regulation_version(id,regulation_id,source,storage_key,content_hash,processing_state,metadata)
 VALUES(v_version,v_reg,btrim(p_input->>'source'),'regulations/'||v_reg::TEXT||'/'||v_version::TEXT||'/original',decode(p_input->>'content_hash','hex'),'uploading',v_meta);
 UPDATE agent_backend.idempotency_record SET response_status=201,response_body=jsonb_build_object('version_id',v_version)
 WHERE user_id=v_user AND route='knowledge/import' AND key=p_key;
 PERFORM agent_backend.knowledge_audit(v_version,v_user,'import',jsonb_build_object('content_hash',p_input->>'content_hash','scope',v_scope));
 RETURN agent_backend.regulation_descriptor(v_version);
END $$;

CREATE FUNCTION agent_backend.knowledge_job_view(p_job UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',id,'status',status,'attempts',attempts,'max_attempts',max_attempts,'progress',progress,
 'error_code',error_code,'generation_id',payload->'generation_id','result',result) FROM agent_backend.job WHERE id=p_job AND kind='knowledge'
$$;

CREATE FUNCTION backend_api.get_regulation_version(p_version UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user INT:=agent_backend.knowledge_operator(p_token); result JSONB;
BEGIN
 result:=agent_backend.regulation_descriptor(p_version);
 IF result IS NULL THEN RAISE EXCEPTION 'Version missing' USING ERRCODE='P0002'; END IF;
 RETURN result||jsonb_build_object('job',(SELECT agent_backend.knowledge_job_view(id) FROM agent_backend.job
 WHERE kind='knowledge' AND payload->>'version_id'=p_version::TEXT ORDER BY created_at DESC,id DESC LIMIT 1));
END $$;

CREATE FUNCTION backend_api.queue_regulation(p_version UUID,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user INT:=agent_backend.knowledge_operator(p_token); v agent_backend.regulation_version; j agent_backend.job;
 saved agent_backend.idempotency_record; v_hash BYTEA:=sha256(convert_to(p_version::TEXT,'UTF8'));
BEGIN
 IF p_version IS NULL OR p_key IS NULL THEN RAISE EXCEPTION 'Version and key required' USING ERRCODE='22023'; END IF;
 SELECT * INTO v FROM agent_backend.regulation_version WHERE id=p_version FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Version missing' USING ERRCODE='P0002'; END IF;
 IF v.metadata->>'withdrawn_at' IS NOT NULL THEN RAISE EXCEPTION 'Version withdrawn' USING ERRCODE='22023'; END IF;
 INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash) VALUES(v_user,'knowledge/reindex',p_key,v_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=v_user AND route='knowledge/reindex' AND key=p_key FOR UPDATE;
 IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Key conflict' USING ERRCODE='P6001'; END IF;
 IF saved.response_body IS NOT NULL THEN RETURN agent_backend.knowledge_job_view((saved.response_body->>'job_id')::UUID); END IF;
 SELECT * INTO j FROM agent_backend.job WHERE kind='knowledge' AND payload->>'version_id'=p_version::TEXT AND status IN ('queued','running') LIMIT 1;
 IF NOT FOUND THEN
   INSERT INTO agent_backend.job(owner_user_id,kind,payload,max_attempts) VALUES(v_user,'knowledge',jsonb_build_object('version_id',p_version,'generation_id',gen_random_uuid()),3) RETURNING * INTO j;
   UPDATE agent_backend.regulation_version SET processing_state='queued' WHERE id=p_version;
   PERFORM agent_backend.knowledge_audit(p_version,v_user,'reindex',jsonb_build_object('job_id',j.id,'generation_id',j.payload->'generation_id'));
 END IF;
 UPDATE agent_backend.idempotency_record SET response_status=202,response_body=jsonb_build_object('job_id',j.id)
 WHERE user_id=v_user AND route='knowledge/reindex' AND key=p_key;
 RETURN agent_backend.knowledge_job_view(j.id);
END $$;

CREATE UNIQUE INDEX regulation_one_active_job ON agent_backend.job((payload->>'version_id')) WHERE kind='knowledge' AND status IN ('queued','running');

CREATE FUNCTION backend_api.withdraw_regulation(p_version UUID,p_reason TEXT,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user INT:=agent_backend.knowledge_operator(p_token); v agent_backend.regulation_version;
BEGIN
 IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='22023'; END IF;
 SELECT * INTO v FROM agent_backend.regulation_version WHERE id=p_version FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Version missing' USING ERRCODE='P0002'; END IF;
 IF v.metadata->>'withdrawn_at' IS NULL THEN
   UPDATE agent_backend.regulation_version SET metadata=metadata||jsonb_build_object('withdrawn_at',clock_timestamp(),'withdrawn_by',v_user,'withdrawal_reason',btrim(p_reason)),processing_state='withdrawn' WHERE id=p_version;
   UPDATE agent_backend.job SET status='failed',error_code='version_withdrawn',finished_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL
   WHERE kind='knowledge' AND payload->>'version_id'=p_version::TEXT AND status IN ('queued','running');
   PERFORM agent_backend.knowledge_audit(p_version,v_user,'withdraw',jsonb_build_object('reason',btrim(p_reason)));
 END IF;
 RETURN backend_api.get_regulation_version(p_version,p_token);
END $$;

CREATE FUNCTION agent_backend.require_knowledge_job(p_job UUID,p_worker UUID) RETURNS agent_backend.job
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE j agent_backend.job; v agent_backend.regulation_version;
BEGIN
 SELECT * INTO v FROM agent_backend.regulation_version WHERE id=(SELECT (payload->>'version_id')::UUID FROM agent_backend.job WHERE id=p_job AND kind='knowledge') FOR UPDATE;
 SELECT * INTO j FROM agent_backend.job WHERE id=p_job AND kind='knowledge' FOR UPDATE;
 IF NOT FOUND OR p_worker IS NULL OR j.status<>'running' OR j.lease_owner IS DISTINCT FROM p_worker OR j.lease_until<=clock_timestamp()
 OR v.metadata->>'withdrawn_at' IS NOT NULL THEN RAISE EXCEPTION 'Lease lost' USING ERRCODE='P8103'; END IF;
 IF NOT EXISTS(SELECT 1 FROM backend_api.account_snapshot(j.owner_user_id) WHERE is_active AND role_code='admin')
 THEN RAISE EXCEPTION 'Operator no longer active' USING ERRCODE='42501'; END IF;
 RETURN j;
END $$;

CREATE FUNCTION backend_api.claim_knowledge_job(p_worker UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agent_backend.job;
BEGIN
 IF p_worker IS NULL THEN RAISE EXCEPTION 'Worker required' USING ERRCODE='22023'; END IF;
 UPDATE agent_backend.job SET status='failed',error_code='lease_exhausted',finished_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL
 WHERE kind='knowledge' AND status='running' AND lease_until<=clock_timestamp() AND attempts>=max_attempts;
 SELECT * INTO j FROM agent_backend.job WHERE kind='knowledge' AND attempts<max_attempts AND
 ((status='queued' AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<=clock_timestamp()))
 ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE agent_backend.job SET status='running',attempts=attempts+1,lease_owner=p_worker,lease_until=clock_timestamp()+INTERVAL '120 seconds',error_code=NULL WHERE id=j.id RETURNING * INTO j;
 RETURN jsonb_build_object('job_id',j.id,'generation_id',j.payload->'generation_id','version',agent_backend.regulation_descriptor((j.payload->>'version_id')::UUID));
END $$;

CREATE FUNCTION backend_api.renew_knowledge_job(p_job UUID,p_worker UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE agent_backend.job SET lease_until=clock_timestamp()+INTERVAL '120 seconds' WHERE id=p_job AND kind='knowledge' AND status='running'
 AND lease_owner=p_worker AND lease_until>clock_timestamp();
 RETURN FOUND;
END $$;

CREATE FUNCTION backend_api.checkpoint_knowledge_job(p_job UUID,p_worker UUID,p_extraction JSONB,p_state TEXT,p_error TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agent_backend.job:=agent_backend.require_knowledge_job(p_job,p_worker); v_done BOOLEAN:=p_state IN ('partial','failed');
BEGIN
 IF p_state IS NULL OR p_state NOT IN ('processing','ready','partial','failed') OR jsonb_typeof(p_extraction) IS DISTINCT FROM 'object'
 OR octet_length(p_extraction::TEXT)>1048576 OR (p_state='ready' AND (p_extraction->'coverage'->>'complete' IS DISTINCT FROM 'true'
 OR COALESCE((p_extraction->>'total_chunks')::INT,0)<1 OR p_extraction->'warnings' IS DISTINCT FROM '[]'::JSONB))
 THEN RAISE EXCEPTION 'Invalid extraction' USING ERRCODE='22023'; END IF;
 UPDATE agent_backend.regulation_version SET metadata=jsonb_set(metadata,'{extraction}',p_extraction),
 processing_state=CASE WHEN p_state='ready' THEN 'indexing' ELSE p_state END WHERE id=(j.payload->>'version_id')::UUID AND published_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Published extraction immutable' USING ERRCODE='23514'; END IF;
 UPDATE agent_backend.job SET status=CASE WHEN v_done THEN 'failed' ELSE 'running' END,error_code=p_error,
 progress=CASE WHEN p_state='ready' THEN 50 ELSE LEAST(49,GREATEST(0,COALESCE((p_extraction->>'completed_units')::NUMERIC,0)*49/GREATEST(1,COALESCE((p_extraction->>'total_units')::NUMERIC,1)))) END,
 result=jsonb_build_object('extraction_state',p_state),lease_owner=CASE WHEN v_done THEN NULL ELSE lease_owner END,
 lease_until=CASE WHEN v_done THEN NULL ELSE lease_until END,finished_at=CASE WHEN v_done THEN clock_timestamp() ELSE NULL END WHERE id=j.id;
 RETURN agent_backend.knowledge_job_view(j.id);
END $$;

CREATE FUNCTION backend_api.save_knowledge_chunks(p_job UUID,p_worker UUID,p_chunks JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agent_backend.job:=agent_backend.require_knowledge_job(p_job,p_worker); v_id UUID:=(j.payload->>'version_id')::UUID;
 item JSONB; c agent_backend.regulation_chunk; v_sealed BOOLEAN;
BEGIN
 IF jsonb_typeof(p_chunks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_chunks)>200 OR octet_length(p_chunks::TEXT)>1048576
 THEN RAISE EXCEPTION 'Invalid chunks' USING ERRCODE='22023'; END IF;
 SELECT metadata ? 'chunk_manifest' INTO v_sealed FROM agent_backend.regulation_version WHERE id=v_id;
 FOR item IN SELECT value FROM jsonb_array_elements(p_chunks) LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR length(COALESCE(item->>'text','')) NOT BETWEEN 1 AND 1000
   OR COALESCE(item->>'sequence','') !~ '^[0-9]{1,8}$' OR jsonb_typeof(item->'locator') IS DISTINCT FROM 'object'
   OR item->>'text_hash' IS DISTINCT FROM encode(sha256(convert_to(item->>'text','UTF8')),'hex')
   THEN RAISE EXCEPTION 'Invalid chunk' USING ERRCODE='22023'; END IF;
   SELECT * INTO c FROM agent_backend.regulation_chunk WHERE version_id=v_id AND sequence=(item->>'sequence')::INT;
   IF FOUND THEN
     IF ROW(c.id,c.text,c.locator) IS DISTINCT FROM ROW((item->>'chunk_id')::UUID,item->>'text',item->'locator')
     THEN RAISE EXCEPTION 'Chunk changed' USING ERRCODE='23514'; END IF;
   ELSE
     IF v_sealed THEN RAISE EXCEPTION 'Chunks sealed' USING ERRCODE='23514'; END IF;
     INSERT INTO agent_backend.regulation_chunk(id,version_id,sequence,text,locator,index_state)
     VALUES((item->>'chunk_id')::UUID,v_id,(item->>'sequence')::INT,item->>'text',item->'locator','stored');
   END IF;
 END LOOP;
 RETURN jsonb_array_length(p_chunks);
END $$;

CREATE FUNCTION backend_api.knowledge_chunks(p_job UUID,p_worker UUID,p_offset INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agent_backend.job:=agent_backend.require_knowledge_job(p_job,p_worker); result JSONB;
BEGIN
 IF p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Invalid offset' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('chunk_id',id,'sequence',sequence,'text',text,'text_hash',encode(sha256(convert_to(text,'UTF8')),'hex'),'locator',locator) ORDER BY sequence),'[]'::JSONB)
 INTO result FROM (SELECT * FROM agent_backend.regulation_chunk WHERE version_id=(j.payload->>'version_id')::UUID ORDER BY sequence LIMIT 200 OFFSET p_offset) c;
 RETURN result;
END $$;

CREATE FUNCTION backend_api.seal_knowledge_chunks(p_job UUID,p_worker UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agent_backend.job:=agent_backend.require_knowledge_job(p_job,p_worker); v agent_backend.regulation_version; v_count INT; v_hash TEXT; result JSONB;
BEGIN
 SELECT * INTO v FROM agent_backend.regulation_version WHERE id=(j.payload->>'version_id')::UUID;
 SELECT count(*),encode(sha256(convert_to(string_agg(id::TEXT||':'||encode(sha256(convert_to(text,'UTF8')),'hex'),E'\n' ORDER BY sequence),'UTF8')),'hex')
 INTO v_count,v_hash FROM agent_backend.regulation_chunk WHERE version_id=v.id;
 IF v_count=0 OR v_count IS DISTINCT FROM (v.metadata->'extraction'->>'total_chunks')::INT
 OR v.metadata->'extraction'->'coverage'->>'complete' IS DISTINCT FROM 'true' OR v.metadata->'extraction'->'warnings' IS DISTINCT FROM '[]'::JSONB
 OR (SELECT COALESCE(max(sequence),-1)+1 FROM agent_backend.regulation_chunk WHERE version_id=v.id)<>v_count
 THEN RAISE EXCEPTION 'Incomplete chunks' USING ERRCODE='22023'; END IF;
 result:=jsonb_build_object('chunk_count',v_count,'manifest_hash',v_hash);
 IF v.metadata ? 'chunk_manifest' AND v.metadata->'chunk_manifest'<>result THEN RAISE EXCEPTION 'Chunk manifest changed' USING ERRCODE='23514'; END IF;
 UPDATE agent_backend.regulation_version SET metadata=jsonb_set(metadata,'{chunk_manifest}',result),processing_state='indexing' WHERE id=v.id;
 RETURN result;
END $$;

CREATE FUNCTION backend_api.publish_knowledge_job(p_job UUID,p_worker UUID,p_receipt JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agent_backend.job:=agent_backend.require_knowledge_job(p_job,p_worker); v agent_backend.regulation_version;
BEGIN
 SELECT * INTO v FROM agent_backend.regulation_version WHERE id=(j.payload->>'version_id')::UUID;
 IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR octet_length(p_receipt::TEXT)>2048
 OR p_receipt->>'generation_id' IS DISTINCT FROM j.payload->>'generation_id'
 OR p_receipt->'chunk_count' IS DISTINCT FROM v.metadata->'chunk_manifest'->'chunk_count'
 OR p_receipt->'manifest_hash' IS DISTINCT FROM v.metadata->'chunk_manifest'->'manifest_hash'
 OR p_receipt->>'model_revision' IS DISTINCT FROM '5617a9f61b028005a4858fdac845db406aefb181'
 OR v.metadata->'chunk_manifest' IS NULL OR v.metadata->'extraction'->'coverage'->>'complete' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'Unverified index receipt' USING ERRCODE='22023'; END IF;
 UPDATE agent_backend.regulation_version SET published_at=COALESCE(published_at,clock_timestamp()),published_by=COALESCE(published_by,j.owner_user_id),
 processing_state='ready',metadata=metadata||jsonb_build_object('active_index_generation',j.payload->'generation_id','index_manifest',p_receipt) WHERE id=v.id;
 UPDATE agent_backend.job SET status='succeeded',progress=100,result=p_receipt,error_code=NULL,finished_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL WHERE id=j.id;
 PERFORM agent_backend.knowledge_audit(v.id,j.owner_user_id,'publish',p_receipt);
 RETURN agent_backend.knowledge_job_view(j.id);
END $$;

CREATE FUNCTION backend_api.fail_knowledge_job(p_job UUID,p_worker UUID,p_error TEXT,p_retry BOOLEAN) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agent_backend.job:=agent_backend.require_knowledge_job(p_job,p_worker); v_retry BOOLEAN:=p_retry AND j.attempts<j.max_attempts;
BEGIN
 IF p_error IS NULL OR p_error !~ '^[a-z][a-z0-9_]{0,99}$' OR p_retry IS NULL THEN RAISE EXCEPTION 'Invalid error' USING ERRCODE='22023'; END IF;
 UPDATE agent_backend.job SET status=CASE WHEN v_retry THEN 'queued' ELSE 'failed' END,error_code=p_error,available_at=clock_timestamp()+INTERVAL '30 seconds'*attempts,
 lease_owner=NULL,lease_until=NULL,finished_at=CASE WHEN v_retry THEN NULL ELSE clock_timestamp() END WHERE id=j.id;
 UPDATE agent_backend.regulation_version SET processing_state=CASE WHEN v_retry THEN 'queued' ELSE 'failed' END WHERE id=(j.payload->>'version_id')::UUID;
 RETURN agent_backend.knowledge_job_view(j.id);
END $$;

REVOKE ALL ON FUNCTION agent_backend.knowledge_operator(TEXT),agent_backend.regulation_descriptor(UUID),agent_backend.regulation_version_visible(UUID,INT),
 agent_backend.regulation_chunk_view(UUID),agent_backend.regulation_chunk_evidence(UUID,INT,UUID),agent_backend.guard_regulation_original(),
 agent_backend.knowledge_audit(UUID,INT,TEXT,JSONB),agent_backend.knowledge_job_view(UUID),agent_backend.require_knowledge_job(UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION backend_api.reserve_regulation(JSONB,UUID,TEXT),backend_api.get_regulation_version(UUID,TEXT),backend_api.queue_regulation(UUID,UUID,TEXT),
 backend_api.withdraw_regulation(UUID,TEXT,TEXT),backend_api.claim_knowledge_job(UUID),backend_api.renew_knowledge_job(UUID,UUID),
 backend_api.checkpoint_knowledge_job(UUID,UUID,JSONB,TEXT,TEXT),backend_api.save_knowledge_chunks(UUID,UUID,JSONB),backend_api.knowledge_chunks(UUID,UUID,INT),
 backend_api.seal_knowledge_chunks(UUID,UUID),backend_api.publish_knowledge_job(UUID,UUID,JSONB),backend_api.fail_knowledge_job(UUID,UUID,TEXT,BOOLEAN) FROM PUBLIC;
-- Separate local logins receive only the exact functions listed by provision_local_knowledge; no broad runtime role gains grants.
