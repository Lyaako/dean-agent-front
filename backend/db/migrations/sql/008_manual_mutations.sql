CREATE OR REPLACE FUNCTION backend_api.record_in_scope(p_resource TEXT, p_row JSONB, p_user_id INT,
                                            p_role TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, deanery AS $$
DECLARE v_id INT;
BEGIN
    IF p_resource='person' THEN
        v_id := (p_row->>'person_id')::INT;
        RETURN EXISTS (
            SELECT 1 FROM deanery.employee e
            WHERE e.person_id=v_id AND (p_role='admin' OR EXISTS (
                SELECT 1 FROM backend_api.allowed_employees(p_user_id) a WHERE a.employee_id=e.employee_id))
        );
    END IF;
    IF p_role='admin' THEN RETURN TRUE; END IF;
    IF p_resource IN ('student','academic_work','practice_placement','document_request') THEN
        v_id := (p_row->>'student_id')::INT;
        RETURN EXISTS (SELECT 1 FROM backend_api.allowed_students(p_user_id) s WHERE s.student_id=v_id);
    ELSIF p_resource IN ('grade','attendance') THEN
        IF NOT EXISTS (SELECT 1 FROM backend_api.allowed_students(p_user_id) s WHERE s.student_id=(p_row->>'student_id')::INT) THEN RETURN FALSE; END IF;
        IF p_resource='grade' THEN
            RETURN EXISTS (SELECT 1 FROM grade_sheet gs JOIN backend_api.allowed_groups(p_user_id) g USING(group_id)
                           WHERE gs.sheet_id=(p_row->>'sheet_id')::INT);
        END IF;
        RETURN EXISTS (SELECT 1 FROM schedule_slot ss JOIN teaching_assignment ta USING(assignment_id)
                       JOIN backend_api.allowed_groups(p_user_id) g USING(group_id) WHERE ss.slot_id=(p_row->>'slot_id')::INT);
    ELSIF p_resource IN ('grade_sheet','teaching_assignment') THEN
        RETURN EXISTS (SELECT 1 FROM backend_api.allowed_groups(p_user_id) g WHERE g.group_id=(p_row->>'group_id')::INT);
    ELSIF p_resource='study_group' THEN
        v_id := (p_row->>'group_id')::INT;
        RETURN EXISTS (SELECT 1 FROM backend_api.allowed_groups(p_user_id) g WHERE g.group_id=v_id);
    ELSIF p_resource='schedule_slot' THEN
        RETURN EXISTS (
            SELECT 1 FROM deanery.teaching_assignment ta
            JOIN backend_api.allowed_groups(p_user_id) g ON g.group_id=ta.group_id
            WHERE ta.assignment_id=(p_row->>'assignment_id')::INT
        );
    ELSIF p_resource='employee' THEN
        v_id := (p_row->>'employee_id')::INT;
        RETURN EXISTS (SELECT 1 FROM backend_api.allowed_employees(p_user_id) e WHERE e.employee_id=v_id);
    END IF;
    RETURN FALSE;
END $$;

CREATE OR REPLACE FUNCTION backend_api.mutate_record_as(p_resource TEXT, p_action TEXT, p_key JSONB,
    p_data JSONB, p_author INT, p_actor INT, p_request INT, p_agent BOOLEAN, p_root_sql BOOLEAN) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, deanery AS $$
DECLARE
    a RECORD;
    v_pk TEXT;
    v_id INT;
    v_fields TEXT[];
    v_payload JSONB := p_data;
    v_before JSONB;
    v_result JSONB;
    v_cols TEXT;
    v_values TEXT;
    v_set TEXT;
    v_status INT;
    v_field TEXT;
    v_institute INT;
    v_policy JSONB;
BEGIN
    PERFORM pg_advisory_xact_lock(9174,1);
    SELECT snap.* INTO a FROM backend_api.account_snapshot(p_author) snap WHERE snap.is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;

    IF p_root_sql THEN
        PERFORM backend_api.root_change_normalize(jsonb_build_object('version',1,'kind','sql_change',
            'resource',p_resource,'operation',p_action,'key',p_key,'fields',p_data),p_author);
        v_policy:=backend_api.root_change_policy(p_resource);
        v_pk:=v_policy->>'pk';
        SELECT ARRAY(SELECT jsonb_array_elements_text(v_policy->CASE p_action WHEN 'create' THEN 'insert' ELSE 'update' END)) INTO v_fields;
        IF NOT p_agent OR NOT backend_api.root_change_authorized(jsonb_build_object('version',1,'kind','sql_change',
            'resource',p_resource,'operation',p_action,'key',p_key,'fields',p_data),p_author,'prepare') THEN
            RAISE EXCEPTION 'Root action denied' USING ERRCODE='42501';
        END IF;
    ELSIF p_resource='student' THEN
        v_pk := 'student_id';
        IF p_action='update' THEN v_fields := ARRAY['funding_type_id','needs_dormitory','is_foreign']; END IF;
    ELSIF p_resource='study_group' THEN
        v_pk := 'group_id';
        v_fields := ARRAY['name','curriculum_id','curator_id','headman_id','is_archived'];
    ELSIF p_resource='schedule_slot' THEN
        v_pk := 'slot_id';
        v_fields := ARRAY['assignment_id','classroom_id','weekday','pair_number','week_parity','term_id','valid_from','valid_to'];
    ELSIF p_resource='academic_work' THEN
        v_pk := 'work_id';
        v_fields := ARRAY['item_id','topic','supervisor_id','reviewer_id','order_id'];
        IF p_action='create' THEN v_fields := array_append(v_fields,'student_id'); END IF;
    ELSIF p_resource='practice_placement' THEN
        v_pk := 'placement_id';
        v_fields := ARRAY['item_id','supervisor_id','org_contact_id','start_date','end_date','order_id'];
        IF p_action='create' THEN v_fields := array_append(v_fields,'student_id'); END IF;
    ELSIF p_resource='document_request' THEN
        v_pk := 'request_id';
        IF a.role_code='student' THEN
            IF p_action='create' THEN v_fields := ARRAY['student_id','document_type_id','copies','purpose'];
            ELSIF p_action='update' THEN v_fields := ARRAY['copies','purpose']; END IF;
        ELSE
            v_fields := ARRAY['document_type_id','copies','purpose','request_status_id','processed_by_id'];
            IF p_action='create' THEN v_fields := array_append(v_fields,'student_id'); END IF;
        END IF;
    ELSIF p_resource='employee' THEN
        v_pk := 'employee_id';
        v_fields := ARRAY['personnel_number','position_id','employment_rate','hire_date','dismissal_date'];
        IF p_action='create' THEN v_fields := array_append(v_fields,'person_id'); END IF;
    ELSIF p_resource='person' THEN
        v_pk := 'person_id';
        IF p_action='update' THEN v_fields := ARRAY['last_name','first_name','middle_name']; END IF;
    ELSE
        RAISE EXCEPTION 'Unknown resource' USING ERRCODE='22023';
    END IF;

    IF NOT p_root_sql AND (p_action NOT IN ('create','update','delete') OR
       (p_resource IN ('student','person') AND p_action<>'update') OR
       (a.role_code NOT IN ('admin','director','dean_staff') AND
           NOT (a.role_code='student' AND p_resource='document_request') AND
           NOT (p_agent AND a.role_code='teacher' AND p_resource='academic_work' AND p_action='update'
                AND jsonb_typeof(p_data)='object' AND p_data ? 'topic' AND p_data-'topic'='{}'::JSONB)) OR
       (p_resource='employee' AND p_action='create' AND a.role_code<>'admin')) THEN
        RAISE EXCEPTION 'Action denied' USING ERRCODE='42501';
    END IF;
    IF p_action='create' THEN
        IF p_key IS NOT NULL AND p_key<>'{}'::JSONB THEN
            RAISE EXCEPTION 'Create has no key' USING ERRCODE='22023';
        END IF;
    ELSE
        IF jsonb_typeof(p_key) IS DISTINCT FROM 'object' OR NOT p_key ? v_pk OR
           (SELECT count(*) FROM jsonb_object_keys(p_key))<>1 OR
           (p_key->>v_pk) !~ '^[1-9][0-9]*$' THEN
            RAISE EXCEPTION 'Invalid key' USING ERRCODE='22023';
        END IF;
        v_id := (p_key->>v_pk)::INT;
        EXECUTE format('SELECT to_jsonb(r) FROM deanery.%I r WHERE %I=$1 FOR UPDATE', p_resource, v_pk)
            INTO v_before USING v_id;
        IF v_before IS NULL THEN RAISE EXCEPTION 'Record missing' USING ERRCODE='P0002'; END IF;
        IF NOT backend_api.record_in_scope(p_resource,v_before,a.user_id,a.role_code) THEN
            RAISE EXCEPTION 'Record out of scope' USING ERRCODE='42501';
        END IF;
        IF a.role_code='teacher' AND p_resource='academic_work' AND (v_before->>'supervisor_id')::INT IS DISTINCT FROM a.teacher_id THEN
            RAISE EXCEPTION 'Work outside supervision' USING ERRCODE='42501';
        END IF;
    END IF;

    IF p_action='delete' THEN
        IF p_data IS NOT NULL AND p_data<>'{}'::JSONB THEN
            RAISE EXCEPTION 'Delete has no body' USING ERRCODE='22023';
        END IF;
    ELSE
        IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' OR v_payload='{}'::JSONB THEN
            RAISE EXCEPTION 'Invalid body' USING ERRCODE='22023';
        END IF;
        FOR v_field IN SELECT jsonb_object_keys(v_payload) LOOP
            IF NOT v_field=ANY(v_fields) THEN
                RAISE EXCEPTION 'Forbidden field' USING ERRCODE='22023';
            END IF;
        END LOOP;
    END IF;

    IF p_root_sql AND p_resource='grade' AND NOT EXISTS (
        SELECT 1 FROM grade_sheet WHERE sheet_id=COALESCE((v_payload->>'sheet_id')::INT,(v_before->>'sheet_id')::INT) AND status='open') THEN
        RAISE EXCEPTION 'Closed grade requires correction' USING ERRCODE='P0001';
    END IF;
    IF p_root_sql AND a.role_code='student' THEN
        IF (p_action='create' AND v_payload-ARRAY['student_id','document_type_id','copies','purpose']<>'{}'::JSONB) OR
           (p_action='update' AND v_payload-ARRAY['copies','purpose']<>'{}'::JSONB) THEN
            RAISE EXCEPTION 'Student field denied' USING ERRCODE='42501';
        END IF;
    END IF;
    IF p_resource='document_request' THEN
        IF a.role_code='student' AND p_action='create' THEN
            IF v_payload ? 'student_id' AND (v_payload->>'student_id') IS DISTINCT FROM a.student_id::TEXT THEN
                RAISE EXCEPTION 'Wrong student' USING ERRCODE='42501';
            END IF;
            SELECT request_status_id INTO v_status FROM deanery.request_status WHERE name='Новая';
            IF v_status IS NULL THEN RAISE EXCEPTION 'New request status missing' USING ERRCODE='P0001'; END IF;
            v_payload := v_payload || jsonb_build_object('student_id',a.student_id,'request_status_id',v_status);
        ELSIF p_action<>'create' THEN
            IF EXISTS (SELECT 1 FROM deanery.document_request d
                       JOIN deanery.request_status s ON s.request_status_id=d.request_status_id
                       WHERE d.request_id=v_id AND s.is_final) THEN
                RAISE EXCEPTION 'Final request' USING ERRCODE='P0001';
            END IF;
            IF (a.role_code='student' OR p_action='delete') AND EXISTS (
                SELECT 1 FROM deanery.document_request d JOIN deanery.request_status s ON s.request_status_id=d.request_status_id
                WHERE d.request_id=v_id AND (s.name<>'Новая' OR d.processed_by_id IS NOT NULL)) THEN
                RAISE EXCEPTION 'Request already processed' USING ERRCODE='P0001';
            END IF;
        END IF;
    END IF;
    IF p_resource='employee' AND p_action='delete' AND EXISTS (
        SELECT 1 FROM deanery.employee e WHERE e.employee_id=v_id AND (
            EXISTS (SELECT 1 FROM deanery.teacher t WHERE t.employee_id=e.employee_id) OR
            EXISTS (SELECT 1 FROM deanery.dean_office_staff d WHERE d.employee_id=e.employee_id) OR
            EXISTS (SELECT 1 FROM deanery.app_user u WHERE u.person_id=e.person_id))) THEN
        RAISE EXCEPTION 'Employee has linked history' USING ERRCODE='P0001';
    END IF;
    IF p_resource='study_group' AND p_action='update' AND v_payload ? 'curriculum_id' AND
       (v_payload->>'curriculum_id')::INT IS DISTINCT FROM (v_before->>'curriculum_id')::INT AND
       EXISTS (SELECT 1 FROM deanery.student s WHERE s.group_id=v_id) THEN
        RAISE EXCEPTION 'Group already has students' USING ERRCODE='P0001';
    END IF;

    PERFORM set_config('app.user_id',p_actor::TEXT,TRUE);
    PERFORM set_config('app.agent_request_id',COALESCE(p_request::TEXT,''),TRUE);
    IF p_action='delete' THEN
        EXECUTE format('DELETE FROM deanery.%I r WHERE %I=$1 RETURNING to_jsonb(r)', p_resource,v_pk)
            INTO v_result USING v_id;
    ELSE
        SELECT string_agg(format('%I',k),','), string_agg(format('r.%I',k),','),
               string_agg(format('%I=r.%I',k,k),',')
        INTO v_cols,v_values,v_set FROM jsonb_object_keys(v_payload) k;
        IF p_action='create' THEN
            EXECUTE format('INSERT INTO deanery.%I AS t (%s) SELECT %s FROM jsonb_populate_record(NULL::deanery.%I,$1) r RETURNING to_jsonb(t)',
                           p_resource,v_cols,v_values,p_resource)
                INTO v_result USING v_payload;
        ELSE
            EXECUTE format('UPDATE deanery.%I AS t SET %s FROM jsonb_populate_record(NULL::deanery.%I,$1) r WHERE t.%I=$2 RETURNING to_jsonb(t)',
                           p_resource,v_set,p_resource,v_pk)
                INTO v_result USING v_payload,v_id;
        END IF;
    END IF;
    IF v_result IS NULL THEN RAISE EXCEPTION 'Record missing' USING ERRCODE='P0002'; END IF;
    IF p_action<>'delete' AND NOT backend_api.record_in_scope(p_resource,v_result,a.user_id,a.role_code) THEN
        RAISE EXCEPTION 'Record out of scope' USING ERRCODE='42501';
    END IF;
    IF p_action<>'delete' THEN
        IF p_resource='schedule_slot' THEN
            IF NOT EXISTS (
                SELECT 1 FROM deanery.teaching_assignment ta
                JOIN deanery.curriculum_item ci ON ci.item_id=ta.item_id
                JOIN deanery.curriculum c ON c.curriculum_id=ci.curriculum_id
                JOIN deanery.academic_term term ON term.term_id=(v_result->>'term_id')::INT
                WHERE ta.assignment_id=(v_result->>'assignment_id')::INT
                  AND ci.semester=2*(EXTRACT(YEAR FROM term.start_date)::INT-c.start_year)
                    + CASE WHEN EXTRACT(MONTH FROM term.start_date)>=7 THEN 1 ELSE 0 END
            ) THEN
                RAISE EXCEPTION 'Assignment and academic term mismatch' USING ERRCODE='P0001';
            END IF;
        ELSIF p_resource IN ('grade_sheet','teaching_assignment') THEN
            v_institute:=fn_group_institute((v_result->>'group_id')::INT);
            IF NOT EXISTS (SELECT 1 FROM teacher t JOIN department d USING(department_id)
                WHERE t.employee_id=(v_result->>CASE p_resource WHEN 'grade_sheet' THEN 'examiner_id' ELSE 'teacher_id' END)::INT
                  AND d.institute_id=v_institute) THEN
                RAISE EXCEPTION 'Teacher outside institute' USING ERRCODE='42501';
            END IF;
        ELSIF p_resource='study_group' THEN
            SELECT d.institute_id INTO v_institute FROM deanery.curriculum c
            JOIN deanery.study_program p ON p.program_id=c.program_id
            JOIN deanery.department d ON d.department_id=p.department_id
            WHERE c.curriculum_id=(v_result->>'curriculum_id')::INT;
            IF v_result->>'curator_id' IS NOT NULL AND (p_action='create' OR v_payload ? 'curator_id') AND
               NOT EXISTS (SELECT 1 FROM deanery.teacher t JOIN deanery.department d ON d.department_id=t.department_id
                           WHERE t.employee_id=(v_result->>'curator_id')::INT AND d.institute_id=v_institute) THEN
                RAISE EXCEPTION 'Curator outside institute' USING ERRCODE='42501';
            END IF;
        ELSIF p_resource IN ('academic_work','practice_placement','document_request') THEN
            SELECT deanery.fn_group_institute(s.group_id) INTO v_institute FROM deanery.student s
            WHERE s.student_id=(v_result->>'student_id')::INT;
            IF p_resource IN ('academic_work','practice_placement') THEN
                IF (p_action='create' OR v_payload ? 'supervisor_id') AND NOT EXISTS (
                    SELECT 1 FROM deanery.teacher t JOIN deanery.department d ON d.department_id=t.department_id
                    WHERE t.employee_id=(v_result->>'supervisor_id')::INT AND d.institute_id=v_institute) THEN
                    RAISE EXCEPTION 'Supervisor outside institute' USING ERRCODE='42501';
                END IF;
                IF p_resource='academic_work' AND v_result->>'reviewer_id' IS NOT NULL AND
                   (p_action='create' OR v_payload ? 'reviewer_id') AND NOT EXISTS (
                    SELECT 1 FROM deanery.teacher t JOIN deanery.department d ON d.department_id=t.department_id
                    WHERE t.employee_id=(v_result->>'reviewer_id')::INT AND d.institute_id=v_institute) THEN
                    RAISE EXCEPTION 'Reviewer outside institute' USING ERRCODE='42501';
                END IF;
            ELSIF v_result->>'processed_by_id' IS NOT NULL AND (p_action='create' OR v_payload ? 'processed_by_id') AND
                  NOT EXISTS (SELECT 1 FROM deanery.dean_office_staff d
                              WHERE d.employee_id=(v_result->>'processed_by_id')::INT AND d.institute_id=v_institute) THEN
                RAISE EXCEPTION 'Processor outside institute' USING ERRCODE='42501';
            END IF;
        END IF;
    END IF;
    IF p_resource='person' THEN
        RETURN jsonb_build_object('person_id',v_result->'person_id','last_name',v_result->'last_name',
                                  'first_name',v_result->'first_name','middle_name',v_result->'middle_name');
    END IF;
    RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION backend_api.mutate_record_as(p_resource TEXT,p_action TEXT,p_key JSONB,p_data JSONB,
    p_author INT,p_actor INT,p_request INT,p_agent BOOLEAN) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT backend_api.mutate_record_as(p_resource,p_action,p_key,p_data,p_author,p_actor,p_request,p_agent,FALSE)
$$;

CREATE OR REPLACE FUNCTION backend_api.mutate_record(p_resource TEXT,p_action TEXT,p_key JSONB,p_data JSONB,p_access_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT;
BEGIN
    SELECT sess.user_id INTO v_user FROM agent_backend.auth_token tok
    JOIN agent_backend.auth_session sess ON sess.id=tok.session_id
    WHERE tok.token_hash=sha256(convert_to(p_access_token,'UTF8')) AND tok.kind='access'
      AND tok.expires_at>now() AND tok.revoked_at IS NULL
      AND sess.expires_at>now() AND sess.revoked_at IS NULL;
    IF v_user IS NULL THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    RETURN backend_api.mutate_record_as(p_resource,p_action,p_key,p_data,v_user,v_user,NULL,FALSE);
END $$;

REVOKE ALL ON FUNCTION backend_api.record_in_scope(TEXT,JSONB,INT,TEXT),
    backend_api.mutate_record_as(TEXT,TEXT,JSONB,JSONB,INT,INT,INT,BOOLEAN),
    backend_api.mutate_record_as(TEXT,TEXT,JSONB,JSONB,INT,INT,INT,BOOLEAN,BOOLEAN),
    backend_api.mutate_record(TEXT,TEXT,JSONB,JSONB,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.mutate_record(TEXT,TEXT,JSONB,JSONB,TEXT) TO backend_api;
