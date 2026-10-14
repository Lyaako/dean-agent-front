-- User approved this narrow source-database permission repair on 14.10.2026.
-- The validator reads only; table writes still use the caller's native privileges.
ALTER FUNCTION deanery.fn_check_slot(INT) SECURITY DEFINER SET search_path=deanery,pg_temp;
GRANT EXECUTE ON FUNCTION deanery.fn_check_slot(INT) TO deanery_staff,deanery_agent;

CREATE VIEW backend_api.v_accounts AS
    SELECT u.user_id,u.login,deanery.fn_full_name(p) AS person,r.code AS role,u.is_active,u.last_login_at
    FROM deanery.app_user u JOIN deanery.app_role r USING(role_id) JOIN deanery.person p USING(person_id);
CREATE VIEW backend_api.v_active_scholarships AS
    SELECT sc.scholarship_id,s.student_id,deanery.fn_full_name(p) AS student,g.name AS group_name,
        st.name AS scholarship,sc.amount,sc.start_date,sc.end_date,o.order_number
    FROM deanery.scholarship sc JOIN deanery.student s USING(student_id) JOIN deanery.person p USING(person_id)
        JOIN deanery.study_group g USING(group_id) JOIN deanery.scholarship_type st USING(scholarship_type_id)
        JOIN deanery.academic_order o USING(order_id) WHERE CURRENT_DATE BETWEEN sc.start_date AND sc.end_date;
CREATE VIEW backend_api.v_current_modules AS
    SELECT DISTINCT ON (gr.student_id,ci.discipline_id,ci.semester,gs.stage)
        gr.grade_id,gr.student_id,gs.sheet_id,gs.sheet_number,gs.stage,gs.status,gs.group_id,
        ci.discipline_id,d.name AS discipline,ci.semester,gr.points,gr.is_absent
    FROM deanery.grade gr JOIN deanery.grade_sheet gs USING(sheet_id) JOIN deanery.curriculum_item ci USING(item_id)
        JOIN deanery.discipline d USING(discipline_id) JOIN deanery.student s USING(student_id)
        JOIN deanery.study_group g ON g.group_id=s.group_id
        JOIN deanery.curriculum c ON c.curriculum_id=g.curriculum_id
    WHERE gs.stage IN ('module_1','module_2') AND gs.status<>'cancelled'
        AND ci.semester=deanery.fn_semester(c.start_year,CURRENT_DATE)
    ORDER BY gr.student_id,ci.discipline_id,ci.semester,gs.stage,gs.exam_date DESC NULLS LAST,gs.sheet_id DESC;

ALTER FUNCTION backend_api.record_in_scope(TEXT,JSONB,INT,TEXT) RENAME TO record_in_scope_v1;
CREATE FUNCTION backend_api.record_in_scope(p_resource TEXT,p_row JSONB,p_user_id INT,p_role TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(p_user_id) WHERE is_active;
    IF NOT FOUND OR a.role_code<>p_role THEN RETURN FALSE; END IF;
    IF p_resource IN ('scholarship_type','document_type','request_status','order_type','leave_reason',
        'contact_relation','specialty','classroom','academic_term','holiday') THEN RETURN p_role IN ('admin','director','dean_staff'); END IF;
    IF p_resource='study_program' THEN RETURN p_role='admin' OR EXISTS(SELECT FROM department
        WHERE department_id=(p_row->>'department_id')::INT AND institute_id=ANY(a.institute_ids)); END IF;
    IF p_role='teacher' AND p_resource='grade' THEN RETURN EXISTS(SELECT FROM grade_sheet
        WHERE sheet_id=(p_row->>'sheet_id')::INT AND examiner_id=a.teacher_id); END IF;
    IF p_role='teacher' AND p_resource='attendance' THEN RETURN EXISTS(SELECT FROM schedule_slot ss
        JOIN teaching_assignment ta USING(assignment_id) WHERE ss.slot_id=(p_row->>'slot_id')::INT AND ta.teacher_id=a.teacher_id); END IF;
    RETURN backend_api.record_in_scope_v1(p_resource,p_row,p_user_id,p_role);
END $$;
REVOKE ALL ON FUNCTION backend_api.record_in_scope(TEXT,JSONB,INT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.record_in_scope(TEXT,JSONB,INT,TEXT) TO backend_api,backend_executor;

CREATE FUNCTION backend_api.sheet_missing(p_sheet INT,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; g INT; kind TEXT; result JSONB;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(agent_backend.proposal_actor(p_token));
    IF a.role_code NOT IN ('admin','director','dean_staff') THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    SELECT group_id,sheet_kind INTO g,kind FROM grade_sheet WHERE sheet_id=p_sheet;
    IF g IS NULL OR NOT EXISTS(SELECT FROM backend_api.allowed_groups(a.user_id) WHERE group_id=g) THEN
        RAISE EXCEPTION 'Sheet missing' USING ERRCODE='P0002'; END IF;
    IF kind<>'main' THEN RETURN '[]'::JSONB; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('student_id',s.student_id,'student',fn_full_name(p)) ORDER BY s.student_id),'[]'::JSONB)
        INTO result FROM student s JOIN student_status st USING(status_id) JOIN person p USING(person_id)
        WHERE s.group_id=g AND st.is_active AND NOT EXISTS(SELECT FROM grade WHERE sheet_id=p_sheet AND student_id=s.student_id);
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION backend_api.sheet_missing(INT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.sheet_missing(INT,TEXT) TO backend_api;

CREATE OR REPLACE FUNCTION backend_api.visible_rows(p_resource TEXT,p_access_token TEXT) RETURNS SETOF TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE uid INT:=agent_backend.proposal_actor(p_access_token); a RECORD;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(uid);
    IF p_resource='app_user' THEN RETURN QUERY SELECT accounts::TEXT FROM backend_api.accounts(p_access_token); RETURN; END IF;
    IF p_resource IN ('v_current_modules','v_active_scholarships') THEN
        RETURN QUERY EXECUTE format('SELECT to_jsonb(r)::TEXT FROM backend_api.%I r WHERE r.student_id IN (SELECT student_id FROM backend_api.allowed_students($1))',p_resource) USING uid;
        RETURN;
    END IF;
    IF p_resource='v_audit' THEN
        IF a.role_code NOT IN ('admin','director','dean_staff') THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
        RETURN QUERY SELECT to_jsonb(v)::TEXT FROM v_audit v JOIN audit_log l USING(audit_id)
            WHERE a.role_code='admin' OR EXISTS(SELECT FROM backend_api.account_snapshot(l.app_user_id) author
                WHERE author.institute_ids && a.institute_ids AND author.role_code<>'admin');
        RETURN;
    END IF;
    RETURN QUERY SELECT * FROM agent_backend.agent_rows_for_actor(p_resource,uid);
END $$;

-- Shared invoker mutation adapter, retaining existing relation and scope checks.
CREATE OR REPLACE FUNCTION backend_api.mutate_record_as(p_resource TEXT, p_action TEXT, p_key JSONB,
    p_data JSONB, p_author INT, p_actor INT, p_request INT, p_agent BOOLEAN, p_root_sql BOOLEAN) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, deanery AS $$
DECLARE
    a RECORD;
    v_pk TEXT;
    v_id TEXT;
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

    IF p_resource='employee' THEN RAISE EXCEPTION 'Employee is read only' USING ERRCODE='42501'; END IF;
    IF NOT p_root_sql AND p_action='update' AND p_resource='grade_sheet' AND p_data-ARRAY['status','exam_date','closed_date']<>'{}'::JSONB THEN
        RAISE EXCEPTION 'Sheet update fields denied' USING ERRCODE='42501'; END IF;
    IF p_action='update' AND p_resource='grade' AND p_data-ARRAY['points','is_absent']<>'{}'::JSONB THEN
        RAISE EXCEPTION 'Grade update fields denied' USING ERRCODE='42501'; END IF;
    IF p_action='update' AND p_resource='attendance' AND p_data-ARRAY['is_present','absence_reason']<>'{}'::JSONB THEN
        RAISE EXCEPTION 'Attendance update fields denied' USING ERRCODE='42501'; END IF;
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
    ELSIF p_resource='grade' THEN
        v_pk:='grade_id'; v_fields:=ARRAY['sheet_id','student_id','points','is_absent'];
    ELSIF p_resource='grade_sheet' THEN
        v_pk:='sheet_id'; v_fields:=ARRAY['sheet_number','item_id','group_id','examiner_id','stage','sheet_kind','issue_date','exam_date','closed_date','status'];
    ELSIF p_resource='attendance' THEN
        v_pk:='attendance_id'; v_fields:=ARRAY['slot_id','student_id','lesson_date','is_present','absence_reason'];
    ELSIF p_resource IN ('scholarship_type','document_type','request_status','order_type','leave_reason','contact_relation',
        'specialty','study_program','classroom','academic_term','holiday') THEN
        SELECT attr.attname INTO v_pk FROM pg_index i JOIN pg_attribute attr ON attr.attrelid=i.indrelid AND attr.attnum=i.indkey[0]
            WHERE i.indrelid=format('deanery.%I',p_resource)::regclass AND i.indisprimary;
        SELECT array_agg(attr.attname ORDER BY attr.attnum) INTO v_fields FROM pg_attribute attr
            WHERE attr.attrelid=format('deanery.%I',p_resource)::regclass AND attr.attnum>0 AND NOT attr.attisdropped AND attr.attidentity='' AND attr.attgenerated='';
    ELSIF p_resource='person' THEN
        v_pk := 'person_id';
        IF p_action='update' THEN v_fields := ARRAY['last_name','first_name','middle_name']; END IF;
    ELSE
        RAISE EXCEPTION 'Unknown resource' USING ERRCODE='22023';
    END IF;

    IF NOT p_root_sql AND (p_action NOT IN ('create','update','delete') OR
       (p_resource IN ('student','person') AND p_action<>'update') OR
       (p_resource IN ('grade','grade_sheet','attendance','scholarship_type','document_type','request_status','order_type',
          'leave_reason','contact_relation','specialty','study_program','classroom','academic_term','holiday') AND p_action='delete') OR
       (a.role_code NOT IN ('admin','director','dean_staff') AND
           NOT (a.role_code='student' AND p_resource='document_request' AND p_action IN ('create','update')) AND
           NOT (a.role_code='teacher' AND p_resource IN ('grade','attendance') AND p_action IN ('create','update')) AND
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
           (p_key->>v_pk) IS NULL OR (p_key->>v_pk)=''  THEN
            RAISE EXCEPTION 'Invalid key' USING ERRCODE='22023';
        END IF;
        v_id := p_key->>v_pk;
        EXECUTE format('SELECT to_jsonb(r) FROM deanery.%I r WHERE r.%I=(jsonb_populate_record(NULL::deanery.%I,$1)).%I FOR UPDATE',p_resource,v_pk,p_resource,v_pk)
            INTO v_before USING p_key;
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
            IF a.role_code='student' AND EXISTS (
                SELECT 1 FROM deanery.document_request d JOIN deanery.request_status s ON s.request_status_id=d.request_status_id
                WHERE d.request_id=v_id::INT AND (s.name<>'Новая' OR d.processed_by_id IS NOT NULL)) THEN
                RAISE EXCEPTION 'Request already processed' USING ERRCODE='P0001';
            END IF;
        END IF;
    END IF;
    IF p_resource='employee' AND p_action='delete' AND EXISTS (
        SELECT 1 FROM deanery.employee e WHERE e.employee_id=v_id::INT AND (
            EXISTS (SELECT 1 FROM deanery.teacher t WHERE t.employee_id=e.employee_id) OR
            EXISTS (SELECT 1 FROM deanery.dean_office_staff d WHERE d.employee_id=e.employee_id) OR
            EXISTS (SELECT 1 FROM deanery.app_user u WHERE u.person_id=e.person_id))) THEN
        RAISE EXCEPTION 'Employee has linked history' USING ERRCODE='P0001';
    END IF;
    IF p_resource='study_group' AND p_action='update' AND v_payload ? 'curriculum_id' AND
       (v_payload->>'curriculum_id')::INT IS DISTINCT FROM (v_before->>'curriculum_id')::INT AND
       EXISTS (SELECT 1 FROM deanery.student s WHERE s.group_id=v_id::INT) THEN
        RAISE EXCEPTION 'Group already has students' USING ERRCODE='P0001';
    END IF;

    PERFORM set_config('app.user_id',p_actor::TEXT,TRUE);
    PERFORM set_config('app.agent_request_id',COALESCE(p_request::TEXT,''),TRUE);
    IF p_action='delete' THEN
        EXECUTE format('DELETE FROM deanery.%I r WHERE r.%I=(jsonb_populate_record(NULL::deanery.%I,$1)).%I RETURNING to_jsonb(r)',p_resource,v_pk,p_resource,v_pk)
            INTO v_result USING p_key;
    ELSE
        SELECT string_agg(format('%I',k),','), string_agg(format('r.%I',k),','),
               string_agg(format('%I=r.%I',k,k),',')
        INTO v_cols,v_values,v_set FROM jsonb_object_keys(v_payload) k;
        IF p_action='create' THEN
            EXECUTE format('INSERT INTO deanery.%I AS t (%s) SELECT %s FROM jsonb_populate_record(NULL::deanery.%I,$1) r RETURNING to_jsonb(t)',
                           p_resource,v_cols,v_values,p_resource)
                INTO v_result USING v_payload;
        ELSE
            EXECUTE format('UPDATE deanery.%I AS t SET %s FROM jsonb_populate_record(NULL::deanery.%I,$1) r WHERE t.%I=(jsonb_populate_record(NULL::deanery.%I,$2)).%I RETURNING to_jsonb(t)',p_resource,v_set,p_resource,v_pk,p_resource,v_pk)
                INTO v_result USING v_payload,p_key;
        END IF;
    END IF;
    IF v_result IS NULL THEN RAISE EXCEPTION 'Record missing' USING ERRCODE='P0002'; END IF;
    IF p_action<>'delete' AND NOT backend_api.record_in_scope(p_resource,v_result,a.user_id,a.role_code) THEN
        RAISE EXCEPTION 'Record out of scope' USING ERRCODE='42501';
    END IF;
    IF p_action<>'delete' THEN
        IF p_resource IN ('grade_sheet','teaching_assignment') THEN
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
