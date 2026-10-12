CREATE OR REPLACE FUNCTION backend_api.allowed_groups(p_user_id INT) RETURNS TABLE(group_id INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, deanery AS $$
    SELECT g.group_id FROM deanery.study_group g
    JOIN deanery.curriculum c ON c.curriculum_id=g.curriculum_id
    JOIN deanery.study_program p ON p.program_id=c.program_id
    JOIN deanery.department d ON d.department_id=p.department_id
    CROSS JOIN backend_api.account_snapshot(p_user_id) a
    WHERE a.is_active AND (
        a.role_code='admin'
        OR (a.role_code IN ('director','dean_staff') AND d.institute_id=ANY(a.institute_ids))
        OR (a.role_code='teacher' AND EXISTS (
            SELECT 1 FROM deanery.teaching_assignment ta
            WHERE ta.group_id=g.group_id AND ta.teacher_id=a.teacher_id))
        OR (a.role_code='student' AND EXISTS (
            SELECT 1 FROM deanery.student s WHERE s.student_id=a.student_id AND s.group_id=g.group_id))
    )
$$;

CREATE OR REPLACE FUNCTION backend_api.allowed_students(p_user_id INT) RETURNS TABLE(student_id INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, deanery AS $$
    SELECT s.student_id FROM deanery.student s
    CROSS JOIN backend_api.account_snapshot(p_user_id) a
    WHERE a.is_active AND (
        a.role_code='admin'
        OR (a.role_code IN ('director','dean_staff')
            AND s.group_id IN (SELECT group_id FROM backend_api.allowed_groups(p_user_id)))
        OR (a.role_code='student' AND s.student_id=a.student_id)
        OR (a.role_code='teacher' AND (
            EXISTS (SELECT 1 FROM deanery.teaching_assignment ta
                    WHERE ta.group_id=s.group_id AND ta.teacher_id=a.teacher_id)
            OR EXISTS (SELECT 1 FROM deanery.academic_work w
                       WHERE w.student_id=s.student_id
                         AND (w.supervisor_id=a.teacher_id OR w.reviewer_id=a.teacher_id))
        ))
    )
$$;

CREATE OR REPLACE FUNCTION backend_api.allowed_employees(p_user_id INT) RETURNS TABLE(employee_id INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, deanery AS $$
    SELECT e.employee_id FROM deanery.employee e
    CROSS JOIN backend_api.account_snapshot(p_user_id) a
    WHERE a.is_active AND (
        a.role_code='admin'
        OR (a.role_code='teacher' AND e.employee_id=a.teacher_id)
        OR (a.role_code IN ('director','dean_staff') AND (
            EXISTS (SELECT 1 FROM deanery.teacher t JOIN deanery.department d ON d.department_id=t.department_id
                    WHERE t.employee_id=e.employee_id AND d.institute_id=ANY(a.institute_ids))
            OR EXISTS (SELECT 1 FROM deanery.dean_office_staff ds
                       WHERE ds.employee_id=e.employee_id AND ds.institute_id=ANY(a.institute_ids))
            OR EXISTS (SELECT 1 FROM deanery.institute i
                       WHERE i.director_id=e.employee_id AND i.institute_id=ANY(a.institute_ids))
            OR EXISTS (SELECT 1 FROM deanery.department d
                       WHERE d.head_id=e.employee_id AND d.institute_id=ANY(a.institute_ids))
            OR EXISTS (SELECT 1 FROM deanery.study_group g JOIN deanery.curriculum c ON c.curriculum_id=g.curriculum_id
                       JOIN deanery.study_program p ON p.program_id=c.program_id
                       JOIN deanery.department d ON d.department_id=p.department_id
                       WHERE g.curator_id=e.employee_id AND d.institute_id=ANY(a.institute_ids))
        ))
    )
$$;

CREATE OR REPLACE FUNCTION agent_backend.visible_rows_for_actor(p_resource TEXT, p_user_id INT) RETURNS SETOF TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, deanery AS $$
DECLARE
    a RECORD;
    source_schema TEXT := 'deanery';
    predicate TEXT;
    row_expression TEXT := 'to_jsonb(r)::text';
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(p_user_id) WHERE is_active;
    IF NOT FOUND THEN RETURN; END IF;

    IF p_resource IN ('student','v_students','v_student_summary') THEN
        predicate := 'r.student_id IN (SELECT student_id FROM backend_api.allowed_students($1))';
        IF a.role_code='teacher' AND p_resource='student' THEN
            row_expression := '(to_jsonb(r) - ''funding_type_id'' - ''needs_dormitory'' - ''is_foreign'')::text';
        ELSIF a.role_code='teacher' AND p_resource='v_student_summary' THEN
            row_expression := '(to_jsonb(r) - ''funding'' - ''scholarships'' - ''needs_dormitory'' - ''is_foreign'')::text';
        ELSIF a.role_code='teacher' AND p_resource='v_students' THEN
            row_expression := '(to_jsonb(r) - ''gender'' - ''birth_date'' - ''phone'' - ''email''
                                - ''funding'' - ''enrollment_date'')::text';
        END IF;
    ELSIF p_resource IN ('study_group','v_groups') THEN
        predicate := 'r.group_id IN (SELECT group_id FROM backend_api.allowed_groups($1))';
    ELSIF p_resource IN ('schedule_slot','v_schedule_calendar') THEN
        predicate := 'EXISTS (SELECT 1 FROM deanery.schedule_slot s JOIN deanery.teaching_assignment ta ON ta.assignment_id=s.assignment_id
                      WHERE s.slot_id=r.slot_id AND ta.group_id IN (SELECT group_id FROM backend_api.allowed_groups($1))
                      AND ($2<>''teacher'' OR ta.teacher_id=$3))';
    ELSIF p_resource IN ('academic_work','v_academic_works') THEN
        IF p_resource='v_academic_works' THEN source_schema := 'backend_api'; END IF;
        predicate := 'EXISTS (SELECT 1 FROM deanery.academic_work w WHERE w.work_id=r.work_id AND
                      (($2<>''teacher'' AND w.student_id IN (SELECT student_id FROM backend_api.allowed_students($1)))
                       OR ($2=''teacher'' AND (w.supervisor_id=$3 OR w.reviewer_id=$3))))';
    ELSIF p_resource IN ('practice_placement','v_practice') THEN
        IF p_resource='v_practice' THEN source_schema := 'backend_api'; END IF;
        predicate := 'EXISTS (SELECT 1 FROM deanery.practice_placement pp WHERE pp.placement_id=r.placement_id AND
                      (($2<>''teacher'' AND pp.student_id IN (SELECT student_id FROM backend_api.allowed_students($1)))
                       OR ($2=''teacher'' AND pp.supervisor_id=$3)))';
    ELSIF p_resource IN ('document_request','v_document_queue') THEN
        predicate := '$2<>''teacher'' AND r.student_id IN (SELECT student_id FROM backend_api.allowed_students($1))';
        IF p_resource='v_document_queue' THEN
            predicate := '$2<>''teacher'' AND EXISTS (SELECT 1 FROM deanery.document_request dr
                          WHERE dr.request_id=r.request_id AND dr.student_id IN
                          (SELECT student_id FROM backend_api.allowed_students($1)))';
        END IF;
    ELSIF p_resource IN ('employee','v_employees','v_teachers','dean_office_staff') THEN
        predicate := 'r.employee_id IN (SELECT employee_id FROM backend_api.allowed_employees($1))';
    ELSIF p_resource='person' THEN
        row_expression := 'jsonb_build_object(''person_id'',r.person_id,''last_name'',r.last_name,
                           ''first_name'',r.first_name,''middle_name'',r.middle_name,''email'',r.email)::text';
        predicate := 'r.person_id=$4 OR $2=''admin'' OR
                      ($2 IN (''director'',''dean_staff'') AND EXISTS
                       (SELECT 1 FROM deanery.employee e WHERE e.person_id=r.person_id
                        AND e.employee_id IN (SELECT employee_id FROM backend_api.allowed_employees($1))))';
    ELSIF p_resource IN ('teaching_assignment','v_schedule_hours') THEN
        IF p_resource='v_schedule_hours' THEN source_schema := 'backend_api'; END IF;
        predicate := 'EXISTS (SELECT 1 FROM deanery.teaching_assignment ta
                      WHERE ta.assignment_id=r.assignment_id
                        AND ta.group_id IN (SELECT group_id FROM backend_api.allowed_groups($1))
                        AND ($2<>''teacher'' OR ta.teacher_id=$3))';
    ELSIF p_resource IN ('curriculum_item','v_curriculum') THEN
        IF p_resource='v_curriculum' THEN source_schema := 'backend_api'; END IF;
        predicate := 'EXISTS (SELECT 1 FROM deanery.curriculum_item ci JOIN deanery.curriculum c ON c.curriculum_id=ci.curriculum_id
                      JOIN deanery.study_program p ON p.program_id=c.program_id
                      JOIN deanery.department d ON d.department_id=p.department_id
                      WHERE ci.item_id=r.item_id AND
                        ($2=''admin'' OR ($2 IN (''director'',''dean_staff'') AND d.institute_id=ANY($5))
                         OR ($2=''teacher'' AND EXISTS (SELECT 1 FROM deanery.teaching_assignment ta
                             WHERE ta.item_id=ci.item_id AND ta.teacher_id=$3))
                         OR ($2=''student'' AND EXISTS (SELECT 1 FROM deanery.student s
                             JOIN deanery.study_group g ON g.group_id=s.group_id
                             WHERE s.student_id=$6 AND g.curriculum_id=ci.curriculum_id))))';
    ELSIF p_resource='curriculum' THEN
        predicate := 'EXISTS (SELECT 1 FROM deanery.study_program p JOIN deanery.department d ON d.department_id=p.department_id
                      WHERE p.program_id=r.program_id AND ($2=''admin''
                        OR ($2 IN (''director'',''dean_staff'') AND d.institute_id=ANY($5))
                        OR r.curriculum_id IN (SELECT g.curriculum_id FROM deanery.study_group g
                            WHERE g.group_id IN (SELECT group_id FROM backend_api.allowed_groups($1)))))';
    ELSIF p_resource='study_program' THEN
        predicate := 'EXISTS (SELECT 1 FROM deanery.department d WHERE d.department_id=r.department_id
                      AND ($2=''admin'' OR ($2 IN (''director'',''dean_staff'') AND d.institute_id=ANY($5))
                           OR r.program_id IN (SELECT c.program_id FROM deanery.curriculum c
                              JOIN deanery.study_group g ON g.curriculum_id=c.curriculum_id
                              WHERE g.group_id IN (SELECT group_id FROM backend_api.allowed_groups($1)))))';
    ELSIF p_resource='academic_order' THEN
        predicate := '$2=''admin'' OR ($2 IN (''director'',''dean_staff'') AND r.institute_id=ANY($5))';
    ELSIF p_resource='organization' THEN
        predicate := '$2 IN (''admin'',''director'',''dean_staff'')';
    ELSIF p_resource='organization_contact' THEN
        predicate := '$2 IN (''admin'',''director'',''dean_staff'')';
    ELSIF p_resource IN (
        'funding_type','student_status','document_type','request_status','leave_reason',
        'academic_term','pair_time','holiday','study_form','specialty','score_band',
        'control_type','lesson_type','position','education_level','scholarship_type',
        'academic_degree','academic_title','contact_relation','order_type','classroom'
    ) THEN
        predicate := 'true';
    ELSE
        RAISE EXCEPTION 'Unknown resource' USING ERRCODE='22023';
    END IF;
    RETURN QUERY EXECUTE format('SELECT %s FROM %I.%I r WHERE %s', row_expression, source_schema, p_resource, predicate)
        USING a.user_id, a.role_code, a.teacher_id, a.person_id, a.institute_ids, a.student_id;
END $$;

CREATE OR REPLACE FUNCTION backend_api.visible_rows(p_resource TEXT, p_access_token TEXT) RETURNS SETOF TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, deanery AS $$
DECLARE a RECORD;
BEGIN
    SELECT snap.* INTO a
    FROM agent_backend.auth_token tok
    JOIN agent_backend.auth_session sess ON sess.id=tok.session_id
    CROSS JOIN LATERAL backend_api.account_snapshot(sess.user_id) snap
    WHERE tok.token_hash=sha256(convert_to(p_access_token,'UTF8'))
      AND tok.kind='access' AND tok.expires_at>now() AND tok.revoked_at IS NULL
      AND sess.expires_at>now() AND sess.revoked_at IS NULL AND snap.is_active;
    IF NOT FOUND THEN RETURN; END IF;
    RETURN QUERY SELECT * FROM agent_backend.visible_rows_for_actor(p_resource,a.user_id);
END $$;

REVOKE ALL ON FUNCTION agent_backend.visible_rows_for_actor(TEXT,INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION backend_api.allowed_groups(INT), backend_api.allowed_students(INT),
    backend_api.allowed_employees(INT), backend_api.visible_rows(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.visible_rows(TEXT,TEXT) TO backend_api;
