CREATE FUNCTION backend_api.order_job_status(p_job UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; v_result JSONB;
BEGIN
    SELECT snap.* INTO a FROM agent_backend.auth_token tok
    JOIN agent_backend.auth_session sess ON sess.id=tok.session_id
    CROSS JOIN LATERAL backend_api.account_snapshot(sess.user_id) snap
    WHERE tok.token_hash=sha256(convert_to(p_token,'UTF8')) AND tok.kind='access'
      AND tok.expires_at>now() AND tok.revoked_at IS NULL
      AND sess.expires_at>now() AND sess.revoked_at IS NULL AND snap.is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    SELECT jsonb_build_object('id',j.id,'kind',j.kind,'status',j.status,
        'attempts',j.attempts,'max_attempts',j.max_attempts,'progress',j.progress,'error_code',j.error_code,
        'result',jsonb_build_object('order_id',o.order_id,'student_id',os.student_id,
            'effective_date',fn_order_due_date(o.order_id,os.student_id),'applied_at',os.applied_at))
    INTO v_result
    FROM agent_backend.job j
    JOIN deanery.order_student os ON j.payload->>'order_id'=os.order_id::TEXT
                                 AND j.payload->>'student_id'=os.student_id::TEXT
    JOIN deanery.academic_order o ON o.order_id=os.order_id
    WHERE j.id=p_job AND j.kind='apply_order' AND a.role_code IN ('admin','director','dean_staff')
      AND (a.role_code='admin' OR o.institute_id=ANY(a.institute_ids))
      AND EXISTS(SELECT 1 FROM backend_api.allowed_students(a.user_id) s WHERE s.student_id=os.student_id);
    IF v_result IS NULL THEN RAISE EXCEPTION 'Job missing' USING ERRCODE='P0002'; END IF;
    RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION backend_api.order_job_status(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.order_job_status(UUID,TEXT) TO backend_api;
