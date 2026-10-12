-- User-confirmed policy; original deanery rules and existing grants are preserved.
CREATE OR REPLACE FUNCTION backend_api.root_change_authorized(c JSONB,p_user INT,p_mode TEXT,p_stored_institute INT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; r JSONB; merged JSONB; resource TEXT:=c->>'resource';
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(p_user) WHERE is_active;
    IF NOT FOUND OR p_mode NOT IN ('prepare','execute') OR p_mode IS NULL OR
       backend_api.root_change_policy(resource) IS NULL OR c->>'operation' NOT IN ('create','update') THEN RETURN FALSE; END IF;
    IF resource IN ('contact_person','organization_contact') AND a.role_code<>'admin' THEN RETURN FALSE; END IF;
    r:=backend_api.command_row(c);
    IF r IS NULL THEN
        RETURN p_mode='execute' AND a.role_code IN ('admin','director','dean_staff') AND
            (a.role_code='admin' OR p_stored_institute=ANY(a.institute_ids));
    END IF;
    merged:=r || (c->'fields');
    IF a.role_code NOT IN ('admin','director','dean_staff') THEN
        IF p_mode<>'prepare' THEN RETURN FALSE; END IF;
        IF a.role_code='teacher' THEN
            IF resource='academic_work' THEN
                IF c->>'operation'<>'update' OR (c->'fields')-'topic'<>'{}'::JSONB OR
                    (r->>'supervisor_id')::INT IS DISTINCT FROM a.teacher_id THEN RETURN FALSE; END IF;
            ELSIF resource='grade' THEN
                IF NOT EXISTS(SELECT 1 FROM grade_sheet gs JOIN teaching_assignment ta
                    ON ta.item_id=gs.item_id AND ta.group_id=gs.group_id
                    WHERE gs.sheet_id=(r->>'sheet_id')::INT AND gs.examiner_id=a.teacher_id
                      AND ta.teacher_id=a.teacher_id) THEN RETURN FALSE; END IF;
            ELSIF resource='attendance' THEN
                IF NOT EXISTS(SELECT 1 FROM schedule_slot ss JOIN teaching_assignment ta USING(assignment_id)
                    WHERE ss.slot_id=(r->>'slot_id')::INT AND ta.teacher_id=a.teacher_id) THEN RETURN FALSE; END IF;
            ELSE RETURN FALSE;
            END IF;
        ELSIF a.role_code='student' THEN
            IF resource<>'document_request' OR (r->>'student_id')::INT IS DISTINCT FROM a.student_id OR
               (c->>'operation'='create' AND (c->'fields')-ARRAY['student_id','document_type_id','copies','purpose']<>'{}'::JSONB) OR
               (c->>'operation'='update' AND (c->'fields')-ARRAY['copies','purpose']<>'{}'::JSONB) THEN RETURN FALSE; END IF;
        ELSE RETURN FALSE;
        END IF;
    END IF;
    RETURN backend_api.record_in_scope(resource,r,p_user,a.role_code) AND
           backend_api.record_in_scope(resource,merged,p_user,a.role_code);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN FALSE;
END $$;

CREATE OR REPLACE FUNCTION backend_api.special_execute(c JSONB,p_author INT,p_actor INT,p_request INT,p_key UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE f JSONB:=c->'fields'; r JSONB:=backend_api.special_row(c); v_result JSONB; v_order INT; v_student INT;
    v_inst INT:=backend_api.special_institute(c); v_start DATE; v_end DATE; v_job UUID; v_due DATE; oldp agent_backend.proposal;
BEGIN
    IF NOT backend_api.special_authorized(c,p_author,'prepare') OR NOT backend_api.special_authorized(c,p_actor,'execute')
       OR NOT EXISTS(SELECT 1 FROM agent_request WHERE agent_request_id=p_request AND user_id=p_author) THEN
        RAISE EXCEPTION 'Special command access denied' USING ERRCODE='42501'; END IF;
    PERFORM pg_advisory_xact_lock(9174,1);
    PERFORM set_config('TimeZone','Europe/Moscow',TRUE);
    PERFORM set_config('app.user_id',p_actor::TEXT,TRUE);
    PERFORM set_config('app.agent_request_id',p_request::TEXT,TRUE);
    PERFORM set_config('app.order_job_id','',TRUE);
    IF c->>'kind'='grade_correction' THEN
        PERFORM backend_api.request_correction_as(c,p_author,p_request);
        RETURN r || jsonb_build_object('points',f->'new_points','is_absent',f->'new_is_absent');
    END IF;
    v_student:=(r->>'student_id')::INT;
    PERFORM pg_advisory_xact_lock(7821,v_student);
    CASE c->>'name'
    WHEN 'scholarship_assign' THEN
        v_start:=(f->>'start_date')::DATE; v_end:=(f->>'end_date')::DATE;
        IF v_start<CURRENT_DATE OR v_end<=v_start THEN RAISE EXCEPTION 'Scholarship must start today or later and end after its start' USING ERRCODE='22023'; END IF;
        IF f ? 'order_id' THEN v_order:=(f->>'order_id')::INT;
        ELSE
            INSERT INTO academic_order(order_number,order_date,order_type_id,institute_id,signed_by_id,title,effective_date)
            VALUES(f->>'order_number',(f->>'order_date')::DATE,(SELECT order_type_id FROM order_type WHERE code='scholarship'),
                v_inst,(f->>'signed_by')::INT,'О назначении стипендии',v_start) RETURNING order_id INTO v_order;
            INSERT INTO order_student(order_id,student_id,reason) VALUES(v_order,v_student,f->>'reason');
        END IF;
        INSERT INTO scholarship(student_id,scholarship_type_id,order_id,start_date,end_date)
            VALUES(v_student,(f->>'scholarship_type_id')::INT,v_order,v_start,v_end) RETURNING to_jsonb(scholarship) INTO v_result;
        RETURN v_result;
    WHEN 'scholarship_terminate' THEN
        v_end:=(f->>'end_date')::DATE;
        IF NOT (CURRENT_DATE BETWEEN (r->>'start_date')::DATE AND (r->>'end_date')::DATE)
           OR v_end<CURRENT_DATE OR v_end<=(r->>'start_date')::DATE OR v_end>=(r->>'end_date')::DATE THEN
            RAISE EXCEPTION 'Invalid scholarship termination date' USING ERRCODE='22023'; END IF;
        UPDATE scholarship SET end_date=v_end WHERE scholarship_id=(r->>'scholarship_id')::INT RETURNING to_jsonb(scholarship) INTO v_result;
        RETURN v_result;
    WHEN 'scholarship_cancel' THEN
        IF (r->>'start_date')::DATE<=CURRENT_DATE THEN RAISE EXCEPTION 'Scholarship already started' USING ERRCODE='22023'; END IF;
        DELETE FROM scholarship WHERE scholarship_id=(r->>'scholarship_id')::INT;
        RETURN '{}'::JSONB;
    WHEN 'scheduled_order_cancel' THEN
        v_order:=(r->>'order_id')::INT;
        IF r->>'applied_at' IS NOT NULL OR EXISTS(SELECT 1 FROM academic_order o JOIN order_type ot USING(order_type_id)
            WHERE o.order_id=v_order AND ot.code='enroll') THEN RAISE EXCEPTION 'Order cannot be cancelled' USING ERRCODE='22023'; END IF;
        v_due:=fn_order_due_date(v_order,v_student);
        v_job:=backend_api.track_order(v_order,v_student,p_actor);
        CALL sp_cancel_scheduled_order(f->>'order_number',v_student);
        UPDATE agent_backend.job SET status='cancelled',finished_at=now(),lease_owner=NULL,lease_until=NULL,error_code=NULL,
            result=COALESCE(result,'{}') || jsonb_build_object('cancelled_by',p_actor,'cancellation_proposal_id',p_key,
                'reason',f->>'reason','effective_date',v_due,'order_number',f->>'order_number','institute_id',v_inst,'order_id',v_order,'student_id',v_student)
        WHERE id=v_job;
        FOR oldp IN SELECT * FROM agent_backend.proposal WHERE status='approved'
            AND execution->>'order_id'=v_order::TEXT AND execution->>'student_id'=v_student::TEXT FOR UPDATE LOOP
            IF oldp.execution->>'status'<>'cancelled' THEN
                UPDATE agent_backend.proposal SET execution=execution || jsonb_build_object('status','cancelled',
                    'completed_at',now(),'error',NULL,'cancellation_proposal_id',p_key),version=version+1 WHERE id=oldp.id;
                INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,reason,data)
                    VALUES(oldp.id,p_actor,'execution',f->>'reason',jsonb_build_object('status','cancelled','cancellation_proposal_id',p_key));
            END IF;
        END LOOP;
        RETURN '{}'::JSONB;
    ELSE RAISE EXCEPTION 'Unknown special command' USING ERRCODE='22023';
    END CASE;
END $$;
