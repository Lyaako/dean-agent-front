CREATE UNIQUE INDEX job_order_pair ON agent_backend.job
    ((payload->>'order_id'), (payload->>'student_id')) WHERE kind='apply_order';

CREATE FUNCTION backend_api.track_order(p_order INT, p_student INT, p_owner INT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_id UUID; v_applied TIMESTAMPTZ; v_due DATE;
BEGIN
    SELECT applied_at, fn_order_due_date(order_id,student_id) INTO v_applied,v_due
    FROM deanery.order_student WHERE order_id=p_order AND student_id=p_student;
    IF NOT FOUND THEN RAISE EXCEPTION 'Order missing' USING ERRCODE='P0002'; END IF;
    INSERT INTO agent_backend.job(owner_user_id,kind,payload,max_attempts,available_at,status,progress,finished_at,result)
    VALUES(p_owner,'apply_order',jsonb_build_object('order_id',p_order,'student_id',p_student),3,
        v_due::TIMESTAMP AT TIME ZONE 'Europe/Moscow',
        CASE WHEN v_applied IS NULL THEN 'queued' ELSE 'succeeded' END,
        CASE WHEN v_applied IS NULL THEN 0 ELSE 100 END,v_applied,
        CASE WHEN v_applied IS NOT NULL THEN jsonb_build_object('applied_at',v_applied) END)
    ON CONFLICT ((payload->>'order_id'),(payload->>'student_id')) WHERE kind='apply_order'
    DO NOTHING;
    SELECT id INTO v_id FROM agent_backend.job WHERE kind='apply_order'
        AND payload->>'order_id'=p_order::TEXT AND payload->>'student_id'=p_student::TEXT;
    IF v_applied IS NOT NULL THEN
        UPDATE agent_backend.job SET status='succeeded',progress=100,finished_at=v_applied,
            lease_owner=NULL,lease_until=NULL,error_code=NULL,
            result=COALESCE(result,'{}') || jsonb_build_object('applied_at',v_applied)
        WHERE id=v_id;
    END IF;
    RETURN v_id;
END $$;

CREATE FUNCTION backend_api.track_order_audit() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_job UUID := NULLIF(current_setting('app.order_job_id',TRUE),'')::UUID;
BEGIN
    IF v_job IS NOT NULL THEN
        UPDATE agent_backend.job SET result=jsonb_set(COALESCE(result,'{}'),'{audit_ids}',
            COALESCE(result->'audit_ids','[]') || to_jsonb(NEW.audit_id))
        WHERE id=v_job AND kind='apply_order';
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER track_order_audit AFTER INSERT ON deanery.audit_log
FOR EACH ROW EXECUTE FUNCTION backend_api.track_order_audit();

-- Apply old orders in their own audit context before the source procedure prepares a new one.
CREATE FUNCTION backend_api.apply_tracked_order(p_order INT, p_student INT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_job UUID; v_actor TEXT; v_request TEXT; v_context TEXT;
BEGIN
    PERFORM set_config('TimeZone','Europe/Moscow',TRUE);
    PERFORM pg_advisory_xact_lock(7821,p_student);
    PERFORM 1 FROM deanery.student WHERE student_id=p_student FOR UPDATE;
    v_job := backend_api.track_order(p_order,p_student);
    IF EXISTS(SELECT 1 FROM deanery.order_student WHERE order_id=p_order AND student_id=p_student AND applied_at IS NOT NULL) THEN
        RETURN;
    END IF;
    v_actor := current_setting('app.user_id',TRUE);
    v_request := current_setting('app.agent_request_id',TRUE);
    v_context := current_setting('app.order_job_id',TRUE);
    PERFORM set_config('app.user_id','',TRUE);
    PERFORM set_config('app.agent_request_id','',TRUE);
    PERFORM set_config('app.order_job_id',v_job::TEXT,TRUE);
    PERFORM deanery.fn_apply_order(p_order,p_student);
    PERFORM backend_api.track_order(p_order,p_student);
    PERFORM set_config('app.order_job_id',COALESCE(v_context,''),TRUE);
    PERFORM set_config('app.user_id',COALESCE(v_actor,''),TRUE);
    PERFORM set_config('app.agent_request_id',COALESCE(v_request,''),TRUE);
END $$;

CREATE FUNCTION backend_api.run_workflow_as(p_name TEXT,p_data JSONB,p_key UUID,p_author INT,p_actor INT,p_request INT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE
    a RECORD; v_required TEXT[]; v_allowed TEXT[]; k TEXT; v_route TEXT;
    v_hash BYTEA; v_saved RECORD; v_student INT; v_group INT; v_institute INT;
    v_signer INT; v_eff DATE; v_order INT; v_existing RECORD; v_old RECORD;
    v_result JSONB; v_job UUID; v_applied TIMESTAMPTZ; v_due DATE;
BEGIN
    PERFORM pg_advisory_xact_lock(9174,1);
    PERFORM set_config('TimeZone','Europe/Moscow',TRUE);
    PERFORM set_config('app.order_job_id','',TRUE);
    SELECT snap.* INTO a FROM backend_api.account_snapshot(p_author) snap WHERE snap.is_active;
    IF NOT FOUND OR a.role_code NOT IN ('admin','director','dean_staff') THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
    END IF;
    IF p_key IS NULL OR jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Invalid command' USING ERRCODE='22023';
    END IF;
    v_required := ARRAY['order_number','signed_by'];
    CASE p_name
    WHEN 'enroll_student' THEN
        v_required := v_required || ARRAY['last_name','first_name','gender','birth_date','group_name','funding','record_book'];
        v_allowed := v_required || ARRAY['middle_name','email','phone','effective_date'];
    WHEN 'transfer_student','reinstate_student' THEN
        v_required := v_required || ARRAY['student_id','group_name'];
        v_allowed := v_required || ARRAY['effective_date'];
    WHEN 'expel_student' THEN
        v_required := v_required || ARRAY['student_id','reason'];
        v_allowed := v_required || ARRAY['effective_date'];
    WHEN 'grant_academic_leave' THEN
        v_required := v_required || ARRAY['student_id','reason','start','end'];
        v_allowed := v_required;
    WHEN 'return_from_leave' THEN
        v_required := v_required || ARRAY['student_id'];
        v_allowed := v_required || ARRAY['effective_date','group_name'];
    ELSE RAISE EXCEPTION 'Unknown workflow' USING ERRCODE='P0002';
    END CASE;
    FOREACH k IN ARRAY v_required LOOP
        IF p_data->>k IS NULL OR btrim(p_data->>k)='' THEN
            RAISE EXCEPTION 'Missing field' USING ERRCODE='22023';
        END IF;
    END LOOP;
    FOR k IN SELECT jsonb_object_keys(p_data) LOOP
        IF NOT k=ANY(v_allowed) THEN RAISE EXCEPTION 'Unknown field' USING ERRCODE='22023'; END IF;
        IF k IN ('student_id','signed_by') THEN
            IF jsonb_typeof(p_data->k)<>'number' OR (p_data->>k)!~'^[1-9][0-9]*$' THEN
                RAISE EXCEPTION 'Invalid identifier' USING ERRCODE='22023';
            END IF;
        ELSIF jsonb_typeof(p_data->k) IS DISTINCT FROM 'string' OR btrim(p_data->>k)='' THEN
            RAISE EXCEPTION 'Invalid field' USING ERRCODE='22023';
        END IF;
        IF k IN ('effective_date','birth_date','start','end') AND (p_data->>k)!~'^\d{4}-\d{2}-\d{2}$' THEN
            RAISE EXCEPTION 'Invalid date' USING ERRCODE='22023';
        END IF;
    END LOOP;
    v_student := (p_data->>'student_id')::INT;
    v_signer := (p_data->>'signed_by')::INT;
    IF v_student IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(7821,v_student);
        PERFORM 1 FROM deanery.student WHERE student_id=v_student FOR UPDATE;
        IF NOT EXISTS(SELECT 1 FROM backend_api.allowed_students(a.user_id) s WHERE s.student_id=v_student) THEN
            RAISE EXCEPTION 'Student out of scope' USING ERRCODE='42501';
        END IF;
    END IF;
    IF p_data ? 'group_name' THEN
        SELECT group_id,fn_group_institute(group_id) INTO v_group,v_institute
        FROM deanery.study_group WHERE name=p_data->>'group_name';
        IF v_group IS NULL OR NOT EXISTS(SELECT 1 FROM backend_api.allowed_groups(a.user_id) g WHERE g.group_id=v_group) THEN
            RAISE EXCEPTION 'Group out of scope' USING ERRCODE='42501';
        END IF;
    END IF;
    v_route := '/workflows/' || p_name;
    v_hash := sha256(convert_to(p_data::TEXT,'UTF8'));
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash)
    VALUES(a.user_id,v_route,p_key,v_hash) ON CONFLICT DO NOTHING;
    SELECT * INTO v_saved FROM agent_backend.idempotency_record
    WHERE user_id=a.user_id AND route=v_route AND key=p_key FOR UPDATE;
    IF v_saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Idempotency body conflict' USING ERRCODE='40001'; END IF;
    IF v_saved.response_body IS NOT NULL THEN
        IF NOT EXISTS(SELECT 1 FROM backend_api.allowed_students(a.user_id) s
                      WHERE s.student_id=(v_saved.response_body->>'student_id')::INT) THEN
            RAISE EXCEPTION 'Saved result out of scope' USING ERRCODE='42501';
        END IF;
        RETURN v_saved.response_body;
    END IF;
    v_eff := COALESCE((p_data->>'effective_date')::DATE,CURRENT_DATE);
    IF v_student IS NOT NULL THEN
        FOR v_old IN SELECT order_id FROM deanery.order_student WHERE student_id=v_student
            AND applied_at IS NULL AND fn_order_due_date(order_id,student_id)<=CURRENT_DATE
            ORDER BY fn_order_due_date(order_id,student_id),order_id LOOP
            PERFORM backend_api.apply_tracked_order(v_old.order_id,v_student);
        END LOOP;
        IF NOT EXISTS(SELECT 1 FROM backend_api.allowed_students(a.user_id) s WHERE s.student_id=v_student) THEN
            RAISE EXCEPTION 'Student out of scope' USING ERRCODE='42501';
        END IF;
    END IF;
    IF p_name<>'enroll_student' AND p_name<>'reinstate_student' THEN
        SELECT fn_group_institute(group_id) INTO v_institute FROM deanery.student WHERE student_id=v_student;
    END IF;
    IF NOT deanery.fn_manages_institute(v_signer,v_institute) THEN
        RAISE EXCEPTION 'Invalid signer' USING ERRCODE='42501';
    END IF;
    PERFORM set_config('app.user_id',p_actor::TEXT,TRUE);
    PERFORM set_config('app.agent_request_id',COALESCE(p_request::TEXT,''),TRUE);
    CASE p_name
    WHEN 'enroll_student' THEN
        IF v_eff<CURRENT_DATE OR (p_data->>'gender') NOT IN ('M','F') THEN
            RAISE EXCEPTION 'Invalid enrollment' USING ERRCODE='22023';
        END IF;
        -- Serialize joining a shared enrollment order, including its first insert.
        PERFORM pg_advisory_xact_lock(hashtextextended('enroll:' || (p_data->>'order_number'),0));
        SELECT o.*,ot.code INTO v_existing FROM deanery.academic_order o
        JOIN deanery.order_type ot ON ot.order_type_id=o.order_type_id WHERE order_number=p_data->>'order_number';
        IF FOUND AND (v_existing.code<>'enroll' OR v_existing.institute_id<>v_institute OR
                      v_existing.signed_by_id<>v_signer OR v_existing.effective_date<>v_eff) THEN
            RAISE EXCEPTION 'Enrollment order conflict' USING ERRCODE='P0001';
        END IF;
        v_student := deanery.fn_enroll_student(p_data->>'last_name',p_data->>'first_name',p_data->>'middle_name',
            (p_data->>'gender')::CHAR,(p_data->>'birth_date')::DATE,p_data->>'email',p_data->>'phone',
            p_data->>'group_name',p_data->>'funding',p_data->>'record_book',p_data->>'order_number',CURRENT_DATE,v_signer,v_eff);
    WHEN 'transfer_student' THEN
        CALL deanery.sp_transfer_student(v_student,p_data->>'group_name',p_data->>'order_number',v_signer,v_eff);
    WHEN 'expel_student' THEN
        CALL deanery.sp_expel_student(v_student,p_data->>'order_number',p_data->>'reason',v_signer,v_eff);
    WHEN 'grant_academic_leave' THEN
        CALL deanery.sp_grant_academic_leave(v_student,p_data->>'reason',(p_data->>'start')::DATE,
                                             (p_data->>'end')::DATE,p_data->>'order_number',v_signer);
    WHEN 'return_from_leave' THEN
        CALL deanery.sp_return_from_leave(v_student,p_data->>'order_number',v_signer,v_eff,p_data->>'group_name');
    WHEN 'reinstate_student' THEN
        CALL deanery.sp_reinstate_student(v_student,p_data->>'group_name',p_data->>'order_number',v_signer,v_eff);
    END CASE;
    SELECT o.order_id,os.applied_at,fn_order_due_date(o.order_id,os.student_id)
        INTO v_order,v_applied,v_due FROM deanery.academic_order o
        JOIN deanery.order_student os ON os.order_id=o.order_id
        WHERE o.order_number=p_data->>'order_number' AND os.student_id=v_student;
    v_job := backend_api.track_order(v_order,v_student,a.user_id);
    v_result := jsonb_build_object('student_id',v_student,'order_id',v_order,
        'status',CASE WHEN v_applied IS NULL THEN 'pending' ELSE 'applied' END,
        'effective_date',v_due,'job_id',v_job);
    UPDATE agent_backend.idempotency_record SET response_status=200,response_body=v_result
        WHERE user_id=a.user_id AND route=v_route AND key=p_key;
    RETURN v_result;
END $$;

CREATE FUNCTION backend_api.run_workflow(p_name TEXT,p_data JSONB,p_key UUID,p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT;
BEGIN
    SELECT sess.user_id INTO v_user FROM agent_backend.auth_token tok
    JOIN agent_backend.auth_session sess ON sess.id=tok.session_id
    WHERE tok.token_hash=sha256(convert_to(p_token,'UTF8')) AND tok.kind='access'
      AND tok.expires_at>now() AND tok.revoked_at IS NULL
      AND sess.expires_at>now() AND sess.revoked_at IS NULL;
    IF v_user IS NULL THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    RETURN backend_api.run_workflow_as(p_name,p_data,p_key,v_user,v_user,NULL);
END $$;

REVOKE ALL ON FUNCTION backend_api.track_order(INT,INT,INT),backend_api.apply_tracked_order(INT,INT),
    backend_api.track_order_audit(),backend_api.run_workflow(TEXT,JSONB,UUID,TEXT),
    backend_api.run_workflow_as(TEXT,JSONB,UUID,INT,INT,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.run_workflow(TEXT,JSONB,UUID,TEXT) TO backend_api;
