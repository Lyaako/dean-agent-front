CREATE OR REPLACE FUNCTION backend_api.apply_tracked_order(p_order INT,p_student INT) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,deanery AS $$
DECLARE v_job UUID; v_actor TEXT; v_request TEXT; v_context TEXT; previous TEXT:=current_setting('role');
BEGIN
    PERFORM set_config('TimeZone','Europe/Moscow',TRUE);
    PERFORM pg_advisory_xact_lock(7821,p_student);
    v_job:=backend_api.track_order(p_order,p_student);
    IF EXISTS(SELECT FROM deanery.order_student WHERE order_id=p_order AND student_id=p_student AND applied_at IS NOT NULL) THEN RETURN; END IF;
    IF deanery.fn_order_due_date(p_order,p_student)>CURRENT_DATE THEN RAISE EXCEPTION 'Order is not due' USING ERRCODE='22023'; END IF;
    v_actor:=current_setting('app.user_id',TRUE); v_request:=current_setting('app.agent_request_id',TRUE);
    v_context:=current_setting('app.order_job_id',TRUE);
    SET LOCAL ROLE deanery_agent;
    PERFORM set_config('app.user_id','',TRUE); PERFORM set_config('app.agent_request_id','',TRUE);
    PERFORM set_config('app.order_job_id',v_job::TEXT,TRUE);
    -- Native pending-order uniqueness guarantees one due order per student.
    PERFORM deanery.fn_apply_due_orders(p_student);
    PERFORM backend_api.track_order(p_order,p_student);
    IF previous='none' THEN SET LOCAL ROLE NONE; ELSE EXECUTE format('SET LOCAL ROLE %I',previous); END IF;
    PERFORM set_config('app.order_job_id',COALESCE(v_context,''),TRUE);
    PERFORM set_config('app.user_id',COALESCE(v_actor,''),TRUE);
    PERFORM set_config('app.agent_request_id',COALESCE(v_request,''),TRUE);
END $$;
