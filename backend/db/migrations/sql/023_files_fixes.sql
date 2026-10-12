CREATE FUNCTION backend_api.reserve_file_upload(p_name TEXT,p_title TEXT,p_mime TEXT,p_size BIGINT,p_hash BYTEA,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); v_hash BYTEA; saved agent_backend.idempotency_record; j agent_backend.job;
BEGIN
 IF p_key IS NULL OR p_name IS NULL OR p_title IS NULL OR p_mime IS NULL OR p_size IS NULL OR p_hash IS NULL
 THEN RAISE EXCEPTION 'Invalid upload' USING ERRCODE='22023'; END IF;
 v_hash:=sha256(convert_to(jsonb_build_array(p_name,btrim(p_title),p_mime,p_size,encode(p_hash,'hex'))::TEXT,'UTF8'));
 INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash) VALUES(v_user,'/files',p_key,v_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=v_user AND route='/files' AND key=p_key FOR UPDATE;
 IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Key conflict' USING ERRCODE='P6001'; END IF;
 IF saved.response_body IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO j FROM agent_backend.job WHERE id=(saved.response_body->>'job_id')::UUID;
 RETURN jsonb_build_object('file_id',saved.response_body->'file_id','version_id',saved.response_body->'version_id','job',agent_backend.file_job_view(j));
END $$;

CREATE FUNCTION backend_api.retry_file_job(p_job UUID,p_worker UUID,p_error TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agent_backend.job; v_state TEXT; v_retry BOOLEAN;
BEGIN
 SELECT * INTO j FROM agent_backend.job WHERE id=p_job AND kind='attachment' FOR UPDATE;
 IF NOT FOUND OR p_worker IS NULL OR j.status<>'running' OR j.lease_owner IS DISTINCT FROM p_worker OR j.lease_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'Lease lost' USING ERRCODE='P8103'; END IF;
 IF p_error IS NULL OR p_error NOT IN ('storage_unavailable','parser_resource_limit','ocr_unavailable')
 THEN RAISE EXCEPTION 'Invalid retry' USING ERRCODE='22023'; END IF;
 v_retry:=j.attempts<j.max_attempts;
 SELECT CASE WHEN v_retry THEN 'queued' WHEN COALESCE((extraction->>'total_chunks')::INT,0)>0 THEN 'partial' ELSE 'failed' END
 INTO v_state FROM agent_backend.file_version WHERE id=(j.payload->>'version_id')::UUID;
 UPDATE agent_backend.file_version SET extraction_state=v_state,
 extraction=CASE WHEN v_retry THEN extraction ELSE jsonb_set(extraction,'{warnings}',COALESCE(extraction->'warnings','[]')||to_jsonb(p_error)) END
 WHERE id=(j.payload->>'version_id')::UUID;
 UPDATE agent_backend.job SET status=CASE WHEN v_retry THEN 'queued' WHEN v_state='partial' THEN 'succeeded' ELSE 'failed' END,
 available_at=clock_timestamp()+INTERVAL '30 seconds'*attempts,lease_owner=NULL,lease_until=NULL,error_code=p_error,
 finished_at=CASE WHEN v_retry THEN NULL ELSE clock_timestamp() END WHERE id=j.id RETURNING * INTO j;
 RETURN agent_backend.file_job_view(j);
END $$;

REVOKE ALL ON FUNCTION backend_api.reserve_file_upload(TEXT,TEXT,TEXT,BIGINT,BYTEA,UUID,TEXT),backend_api.retry_file_job(UUID,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.reserve_file_upload(TEXT,TEXT,TEXT,BIGINT,BYTEA,UUID,TEXT) TO backend_api;
GRANT EXECUTE ON FUNCTION backend_api.retry_file_job(UUID,UUID,TEXT) TO backend_worker;
DO $$ DECLARE worker RECORD; BEGIN
 FOR worker IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'backend_files_%' AND rolcanlogin
 AND has_function_privilege(oid,'backend_api.claim_file_job(uuid)','EXECUTE') LOOP
   EXECUTE format('GRANT EXECUTE ON FUNCTION backend_api.retry_file_job(UUID,UUID,TEXT) TO %I',worker.rolname);
 END LOOP;
END $$;
