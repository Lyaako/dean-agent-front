CREATE FUNCTION backend_api.claim_order_job(p_worker UUID) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_job UUID;
BEGIN
    IF p_worker IS NULL THEN RAISE EXCEPTION 'Worker required' USING ERRCODE='22023'; END IF;
    PERFORM set_config('TimeZone','Europe/Moscow',TRUE);
    -- Recover pending orders created by the original procedures outside this API too.
    INSERT INTO agent_backend.job(kind,payload,max_attempts,available_at)
    SELECT 'apply_order',jsonb_build_object('order_id',os.order_id,'student_id',os.student_id),3,
           fn_order_due_date(os.order_id,os.student_id)::TIMESTAMP AT TIME ZONE 'Europe/Moscow'
    FROM deanery.order_student os WHERE os.applied_at IS NULL
    ON CONFLICT ((payload->>'order_id'),(payload->>'student_id')) WHERE kind='apply_order' DO NOTHING;

    UPDATE agent_backend.job j SET status='succeeded',progress=100,finished_at=os.applied_at,
        lease_owner=NULL,lease_until=NULL,error_code=NULL,
        result=COALESCE(j.result,'{}') || jsonb_build_object('applied_at',os.applied_at)
    FROM deanery.order_student os WHERE j.kind='apply_order' AND j.status<>'succeeded'
        AND j.payload->>'order_id'=os.order_id::TEXT AND j.payload->>'student_id'=os.student_id::TEXT
        AND os.applied_at IS NOT NULL;
    UPDATE agent_backend.job j SET status='failed',error_code='order_missing',finished_at=now(),lease_owner=NULL,lease_until=NULL
    WHERE kind='apply_order' AND status IN ('queued','running') AND NOT EXISTS(
        SELECT 1 FROM deanery.order_student os WHERE j.payload->>'order_id'=os.order_id::TEXT
        AND j.payload->>'student_id'=os.student_id::TEXT);
    UPDATE agent_backend.job SET status='failed',error_code='lease_exhausted',finished_at=now(),lease_owner=NULL,lease_until=NULL
    WHERE kind='apply_order' AND status='running' AND lease_until<=now() AND attempts>=max_attempts;

    SELECT id INTO v_job FROM agent_backend.job WHERE kind='apply_order' AND attempts<max_attempts
        AND ((status='queued' AND available_at<=now()) OR (status='running' AND lease_until<=now()))
        ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF v_job IS NULL THEN RETURN NULL; END IF;
    UPDATE agent_backend.job SET status='running',attempts=attempts+1,lease_owner=p_worker,
        lease_until=now()+INTERVAL '2 minutes',error_code=NULL WHERE id=v_job;
    RETURN v_job;
END $$;

CREATE FUNCTION backend_api.perform_order_job(p_job UUID,p_worker UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE j agent_backend.job%ROWTYPE; v_student INT; v_code TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(9174,1);
    PERFORM set_config('TimeZone','Europe/Moscow',TRUE);
    SELECT (payload->>'student_id')::INT INTO v_student FROM agent_backend.job WHERE id=p_job AND kind='apply_order';
    IF NOT FOUND THEN RAISE EXCEPTION 'Job missing' USING ERRCODE='P0002'; END IF;
    -- Same order as run_workflow: student serialization before the job row lock.
    PERFORM pg_advisory_xact_lock(7821,v_student);
    PERFORM 1 FROM deanery.student WHERE student_id=v_student FOR UPDATE;
    SELECT * INTO j FROM agent_backend.job WHERE id=p_job FOR UPDATE;
    IF j.status='succeeded' THEN RETURN jsonb_build_object('id',j.id,'status',j.status); END IF;
    IF j.status<>'running' OR j.lease_owner IS DISTINCT FROM p_worker OR j.lease_until<=now() THEN
        RAISE EXCEPTION 'Lease lost' USING ERRCODE='40001';
    END IF;
    BEGIN
        PERFORM backend_api.apply_tracked_order((j.payload->>'order_id')::INT,v_student);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE;
        UPDATE agent_backend.job SET
            status=CASE WHEN (v_code LIKE '40%' OR v_code='55P03') AND attempts<max_attempts THEN 'queued' ELSE 'failed' END,
            available_at=now()+INTERVAL '30 seconds'*attempts,
            error_code=v_code,lease_owner=NULL,lease_until=NULL,
            finished_at=CASE WHEN (v_code LIKE '40%' OR v_code='55P03') AND attempts<max_attempts THEN NULL ELSE now() END
        WHERE id=p_job;
    END;
    SELECT * INTO j FROM agent_backend.job WHERE id=p_job;
    RETURN jsonb_build_object('id',j.id,'status',j.status,'error_code',j.error_code);
END $$;

REVOKE ALL ON FUNCTION backend_api.claim_order_job(UUID),backend_api.perform_order_job(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.claim_order_job(UUID),backend_api.perform_order_job(UUID,UUID) TO backend_worker;
