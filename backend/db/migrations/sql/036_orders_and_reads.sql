CREATE VIEW backend_api.v_attendance AS
    SELECT a.*,ss.pair_number,ci.discipline_id,d.name AS discipline,ta.group_id,ta.teacher_id
    FROM deanery.attendance a JOIN deanery.schedule_slot ss USING(slot_id)
        JOIN deanery.teaching_assignment ta USING(assignment_id)
        JOIN deanery.curriculum_item ci USING(item_id) JOIN deanery.discipline d USING(discipline_id);

CREATE FUNCTION backend_api.audit_in_scope(p_audit BIGINT,p_user INT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; l audit_log; key JSONB; current_row JSONB; old_row JSONB; changes JSONB;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(p_user) WHERE is_active;
    IF a.role_code NOT IN ('admin','director','dean_staff') THEN RETURN FALSE; END IF;
    IF a.role_code='admin' THEN RETURN TRUE; END IF;
    SELECT * INTO l FROM audit_log WHERE audit_id=p_audit;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    SELECT jsonb_object_agg(split_part(part,'=',1),substring(part FROM position('=' IN part)+1))
        INTO key FROM unnest(string_to_array(l.record_key,', ')) part;
    EXECUTE format('SELECT to_jsonb(r) FROM deanery.%I r WHERE to_jsonb(r) @> to_jsonb(jsonb_populate_record(NULL::deanery.%I,$1)) - ARRAY(SELECT attname FROM pg_attribute WHERE attrelid=$2::regclass AND attnum>0 AND NOT attisdropped AND NOT $1 ? attname)',l.table_name,l.table_name)
        INTO current_row USING key,format('deanery.%I',l.table_name);
    SELECT jsonb_object_agg(column_name,to_jsonb(old_value)) INTO changes FROM audit_log_detail WHERE audit_id=p_audit;
    old_row:=CASE WHEN l.operation='D' THEN changes ELSE current_row || changes END;
    IF l.table_name='person' THEN
        RETURN EXISTS(SELECT FROM student s JOIN backend_api.allowed_students(p_user) allowed USING(student_id)
            WHERE s.person_id=COALESCE((current_row->>'person_id')::INT,(old_row->>'person_id')::INT))
            OR backend_api.record_in_scope('person',COALESCE(current_row,old_row),p_user,a.role_code);
    END IF;
    RETURN CASE WHEN l.operation='D' THEN backend_api.record_in_scope(l.table_name,old_row,p_user,a.role_code)
        WHEN l.operation='I' THEN backend_api.record_in_scope(l.table_name,current_row,p_user,a.role_code)
        ELSE backend_api.record_in_scope(l.table_name,current_row,p_user,a.role_code)
            AND backend_api.record_in_scope(l.table_name,old_row,p_user,a.role_code) END;
EXCEPTION WHEN invalid_text_representation OR undefined_table THEN RETURN FALSE;
END $$;
REVOKE ALL ON FUNCTION backend_api.audit_in_scope(BIGINT,INT) FROM PUBLIC;

ALTER FUNCTION agent_backend.agent_rows_for_actor(TEXT,INT) RENAME TO agent_rows_for_actor_v1;
CREATE FUNCTION agent_backend.agent_rows_for_actor(p_resource TEXT,p_user INT) RETURNS SETOF TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(p_user) WHERE is_active;
    IF NOT FOUND THEN RETURN; END IF;
    IF p_resource='app_user' THEN
        IF a.role_code<>'admin' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
        RETURN QUERY SELECT to_jsonb(v)::TEXT FROM backend_api.v_accounts v; RETURN;
    ELSIF p_resource='v_audit' THEN
        IF a.role_code NOT IN ('admin','director','dean_staff') THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
        RETURN QUERY SELECT to_jsonb(v)::TEXT FROM v_audit v
            WHERE backend_api.audit_in_scope(v.audit_id,p_user) AND v.column_name NOT IN
                ('password_hash','passport_series','passport_number','snils','inn','birth_date','address'); RETURN;
    ELSIF p_resource='v_current_modules' THEN
        RETURN QUERY SELECT to_jsonb(v)::TEXT FROM backend_api.v_current_modules v
            WHERE v.grade_id IN (SELECT grade_id FROM agent_backend.allowed_grades(p_user)); RETURN;
    ELSIF p_resource='v_active_scholarships' THEN
        IF a.role_code='teacher' THEN RETURN; END IF;
        RETURN QUERY SELECT to_jsonb(v)::TEXT FROM backend_api.v_active_scholarships v
            WHERE v.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user)); RETURN;
    ELSIF p_resource='v_attendance' THEN
        RETURN QUERY SELECT to_jsonb(v)::TEXT FROM backend_api.v_attendance v
            WHERE (a.role_code='teacher' AND v.teacher_id=a.teacher_id) OR
                (a.role_code<>'teacher' AND v.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user))); RETURN;
    ELSIF p_resource='attendance' AND a.role_code='teacher' THEN
        RETURN QUERY SELECT to_jsonb(r)::TEXT FROM attendance r JOIN backend_api.v_attendance v USING(attendance_id)
            WHERE v.teacher_id=a.teacher_id; RETURN;
    END IF;
    RETURN QUERY SELECT * FROM agent_backend.agent_rows_for_actor_v1(p_resource,p_user);
END $$;
REVOKE ALL ON FUNCTION agent_backend.agent_rows_for_actor(TEXT,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_backend.agent_rows_for_actor(TEXT,INT) TO backend_api,backend_executor,backend_read;
CREATE OR REPLACE FUNCTION backend_api.visible_rows(p_resource TEXT,p_access_token TEXT) RETURNS SETOF TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT * FROM agent_backend.agent_rows_for_actor(p_resource,agent_backend.proposal_actor(p_access_token))
$$;

CREATE FUNCTION backend_api.order_signers(p_institute INT,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; result JSONB;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(agent_backend.proposal_actor(p_token));
    IF a.role_code NOT IN ('admin','director','dean_staff') OR
        (a.role_code<>'admin' AND NOT p_institute=ANY(a.institute_ids)) THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    IF NOT EXISTS(SELECT FROM institute WHERE institute_id=p_institute) THEN RAISE EXCEPTION 'Institute missing' USING ERRCODE='P0002'; END IF;
    SELECT COALESCE(jsonb_agg(x ORDER BY NOT x.is_director,x.person,x.employee_id),'[]'::JSONB) INTO result FROM (
        SELECT e.employee_id,fn_full_name(p) AS person,pos.title AS position,e.employee_id=i.director_id AS is_director
        FROM employee e JOIN person p USING(person_id) JOIN position pos USING(position_id)
            CROSS JOIN institute i WHERE i.institute_id=p_institute AND fn_manages_institute(e.employee_id,p_institute)
    ) x;
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION backend_api.order_signers(INT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.order_signers(INT,TEXT) TO backend_api;

CREATE FUNCTION backend_api.cancel_order(p_number TEXT,p_student INT,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,deanery AS $$
DECLARE uid INT:=agent_backend.proposal_actor(p_token); a RECORD; saved agent_backend.idempotency_record;
    v_route TEXT:='/orders/cancel'; v_hash BYTEA; oid INT; jid UUID; v_result JSONB;
BEGIN
    PERFORM pg_advisory_xact_lock(9174,1);
    SELECT * INTO a FROM backend_api.account_snapshot(uid);
    IF a.role_code NOT IN ('admin','director','dean_staff') OR NOT EXISTS(
        SELECT FROM backend_api.allowed_students(uid) WHERE student_id=p_student) THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    v_hash:=sha256(convert_to(jsonb_build_array(p_number,p_student)::TEXT,'UTF8'));
    SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=uid AND route=v_route AND key=p_key;
    IF FOUND THEN
        IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='P6001'; END IF;
        RETURN saved.response_body;
    END IF;
    SELECT o.order_id INTO oid FROM academic_order o JOIN order_student os USING(order_id)
        WHERE order_number=p_number AND student_id=p_student;
    IF oid IS NOT NULL THEN jid:=backend_api.track_order(oid,p_student,uid); END IF;
    CALL sp_cancel_scheduled_order(p_number,p_student);
    UPDATE agent_backend.job SET status='cancelled',finished_at=now(),lease_owner=NULL,lease_until=NULL,
        result=COALESCE(result,'{}')||jsonb_build_object('cancelled_by',uid,'reason','Отмена через форму',
            'order_number',p_number,'institute_id',(SELECT fn_group_institute(group_id) FROM student WHERE student_id=p_student))
        WHERE id=jid;
    v_result:=jsonb_build_object('order_number',p_number,'student_id',p_student,'status','cancelled','job_id',jid);
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash,response_status,response_body)
        VALUES(uid,v_route,p_key,v_hash,200,v_result);
    RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION backend_api.cancel_order(TEXT,INT,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.cancel_order(TEXT,INT,UUID,TEXT) TO backend_api;

ALTER FUNCTION backend_api.run_workflow_as(TEXT,JSONB,UUID,INT,INT,INT) RENAME TO run_workflow_as_v1;
CREATE FUNCTION backend_api.run_workflow_as(p_name TEXT,p_data JSONB,p_key UUID,p_author INT,p_actor INT,p_request INT)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,deanery AS $$
DECLARE data JSONB:=p_data; value TEXT;
BEGIN
    IF data ? 'effective_date' AND COALESCE(data->>'effective_date','')='' THEN data:=data-'effective_date'; END IF;
    -- Replay uses the stored result even after the original effective date passed.
    IF NOT EXISTS(SELECT FROM agent_backend.idempotency_record WHERE user_id=p_author
        AND route='/workflows/'||p_name AND key=p_key AND response_body IS NOT NULL) THEN
        value:=CASE WHEN p_name='grant_academic_leave' THEN data->>'start' ELSE data->>'effective_date' END;
        IF value IS NOT NULL AND value::DATE<(now() AT TIME ZONE 'Europe/Moscow')::DATE THEN
            RAISE EXCEPTION 'Дата вступления не может быть в прошлом' USING ERRCODE='P6110'; END IF;
    END IF;
    RETURN backend_api.run_workflow_as_v1(p_name,data,p_key,p_author,p_actor,p_request);
END $$;
REVOKE ALL ON FUNCTION backend_api.run_workflow_as(TEXT,JSONB,UUID,INT,INT,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.run_workflow_as(TEXT,JSONB,UUID,INT,INT,INT) TO backend_api,backend_executor;
