CREATE OR REPLACE FUNCTION backend_api.claim_knowledge_job(p_worker UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j agent_backend.job; v_version UUID;
BEGIN
 IF p_worker IS NULL THEN RAISE EXCEPTION 'Worker required' USING ERRCODE='22023'; END IF;
 -- Match queue/withdraw/checkpoint lock order: version first, then its job.
 FOR v_version IN SELECT v.id FROM agent_backend.regulation_version v JOIN agent_backend.job lost ON lost.payload->>'version_id'=v.id::TEXT
 WHERE lost.kind='knowledge' AND lost.status='running' AND lost.lease_until<=clock_timestamp() AND lost.attempts>=lost.max_attempts
 ORDER BY lost.lease_until LIMIT 20 FOR UPDATE OF v SKIP LOCKED LOOP
   UPDATE agent_backend.job SET status='failed',error_code='lease_exhausted',finished_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL
   WHERE kind='knowledge' AND payload->>'version_id'=v_version::TEXT AND status='running' AND lease_until<=clock_timestamp() AND attempts>=max_attempts;
   IF FOUND THEN UPDATE agent_backend.regulation_version SET processing_state='failed' WHERE id=v_version AND metadata->>'withdrawn_at' IS NULL; END IF;
 END LOOP;
 SELECT * INTO j FROM agent_backend.job WHERE kind='knowledge' AND attempts<max_attempts AND
 ((status='queued' AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<=clock_timestamp()))
 ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE agent_backend.job SET status='running',attempts=attempts+1,lease_owner=p_worker,lease_until=clock_timestamp()+INTERVAL '120 seconds',error_code=NULL WHERE id=j.id RETURNING * INTO j;
 RETURN jsonb_build_object('job_id',j.id,'generation_id',j.payload->'generation_id','version',agent_backend.regulation_descriptor((j.payload->>'version_id')::UUID));
END $$;
