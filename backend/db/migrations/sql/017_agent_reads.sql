CREATE OR REPLACE FUNCTION agent_backend.allowed_grades(p_user INT) RETURNS SETOF deanery.grade
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT gr.* FROM grade gr JOIN grade_sheet gs USING(sheet_id)
    CROSS JOIN backend_api.account_snapshot(p_user) a
    WHERE a.is_active AND ((a.role_code='teacher' AND gs.examiner_id=a.teacher_id) OR
        (a.role_code<>'teacher' AND gr.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user))))
$$;

CREATE OR REPLACE FUNCTION agent_backend.agent_rows_for_actor(p_resource TEXT,p_user INT) RETURNS SETOF TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; predicate TEXT;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(p_user) WHERE is_active;
    IF NOT FOUND THEN RETURN; END IF;
    IF p_resource='grade' THEN
        RETURN QUERY SELECT to_jsonb(g)::TEXT FROM agent_backend.allowed_grades(p_user) g;
        RETURN;
    ELSIF p_resource='v_last_result' THEN
        RETURN QUERY SELECT to_jsonb(r)::TEXT FROM (
            SELECT DISTINCT ON (gr.student_id,ci.discipline_id,ci.semester,gs.stage)
                gr.student_id,ci.discipline_id,ci.semester,gs.item_id,gs.stage,gr.points,gr.is_absent,gs.sheet_id,gs.exam_date
            FROM agent_backend.allowed_grades(p_user) gr JOIN grade_sheet gs USING(sheet_id)
            JOIN curriculum_item ci USING(item_id) WHERE gs.status<>'cancelled'
            ORDER BY gr.student_id,ci.discipline_id,ci.semester,gs.stage,gs.exam_date DESC NULLS LAST,gs.sheet_id DESC
        ) r;
        RETURN;
    ELSIF p_resource='v_debtors' THEN
        -- Preserve the source's stored-result metric, with authorized grades before aggregation.
        RETURN QUERY SELECT to_jsonb(r)::TEXT FROM (
            SELECT s.student_id,fn_full_name(p) AS student,g.name AS group_name,dis.name AS discipline,
                ci.semester,ct.name AS control_type,count(*) AS attempts,
                (array_agg(fn_result_name(gr.points,gr.is_absent,ct.is_graded,TRUE) ORDER BY gs.exam_date DESC NULLS LAST))[1] AS last_result
            FROM agent_backend.allowed_grades(p_user) gr JOIN grade_sheet gs USING(sheet_id)
            JOIN curriculum_item ci USING(item_id) JOIN discipline dis USING(discipline_id)
            JOIN control_type ct USING(control_type_id) JOIN student s USING(student_id)
            JOIN student_status st USING(status_id) JOIN person p USING(person_id)
            JOIN study_group g ON g.group_id=s.group_id
            WHERE gs.status<>'cancelled' AND gs.stage='final' AND st.is_active
            GROUP BY s.student_id,p.person_id,g.name,dis.name,ci.semester,ct.name HAVING NOT bool_or(gr.points IS NOT NULL)
        ) r;
        RETURN;
    ELSIF p_resource='grade_sheet' THEN
        predicate:='($2=''teacher'' AND r.examiner_id=$3) OR
            ($2<>''teacher'' AND r.group_id IN (SELECT group_id FROM backend_api.allowed_groups($1)))';
    ELSIF p_resource='attendance' THEN
        predicate:='r.student_id IN (SELECT student_id FROM backend_api.allowed_students($1)) AND
            ($2<>''teacher'' OR EXISTS(SELECT 1 FROM schedule_slot ss JOIN teaching_assignment ta USING(assignment_id)
                WHERE ss.slot_id=r.slot_id AND ta.teacher_id=$3))';
    ELSIF p_resource='grade_correction' THEN
        predicate:='r.grade_id IN (SELECT grade_id FROM agent_backend.allowed_grades($1))';
    ELSIF p_resource IN ('scholarship','academic_leave','order_student','student_contact','v_student_orders','v_pending_orders','v_academic_leaves') THEN
        predicate:='$2<>''teacher'' AND r.student_id IN (SELECT student_id FROM backend_api.allowed_students($1))';
    ELSIF p_resource='academic_order' AND a.role_code='student' THEN
        predicate:='EXISTS(SELECT 1 FROM order_student os WHERE os.order_id=r.order_id AND os.student_id=$4)';
    ELSIF p_resource='contact_person' THEN
        predicate:='$2=''admin'' OR ($2<>''teacher'' AND EXISTS(SELECT 1 FROM student_contact sc
            WHERE sc.contact_person_id=r.contact_person_id AND sc.student_id IN (SELECT student_id FROM backend_api.allowed_students($1))))';
    ELSIF p_resource='discipline' THEN predicate:='TRUE';
    ELSIF p_resource IN ('institute','department') THEN
        predicate:='$2=''admin'' OR r.institute_id=ANY($5) OR r.institute_id IN
            (SELECT fn_group_institute(group_id) FROM backend_api.allowed_groups($1))';
    ELSIF p_resource='teacher' THEN
        predicate:='r.employee_id IN (SELECT employee_id FROM backend_api.allowed_employees($1))';
    ELSE
        RETURN QUERY SELECT * FROM agent_backend.visible_rows_for_actor(p_resource,p_user);
        RETURN;
    END IF;
    RETURN QUERY EXECUTE format('SELECT to_jsonb(r)::TEXT FROM deanery.%I r WHERE %s',p_resource,predicate)
        USING a.user_id,a.role_code,a.teacher_id,a.student_id,a.institute_ids;
END $$;

REVOKE ALL ON FUNCTION agent_backend.allowed_grades(INT),agent_backend.agent_rows_for_actor(TEXT,INT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION backend_api.agent_visible_rows(p_run UUID,p_worker UUID,p_resource TEXT) RETURNS SETOF TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run;
BEGIN
    r:=agent_backend.read_agent_run(p_run,p_worker);
    RETURN QUERY SELECT * FROM agent_backend.agent_rows_for_actor(p_resource,r.initiator_user_id);
END $$;

CREATE OR REPLACE FUNCTION backend_api.agent_olap_facts(p_run UUID,p_worker UUID,p_group INT DEFAULT NULL,
    p_discipline INT DEFAULT NULL,p_semester INT DEFAULT NULL,p_status INT DEFAULT NULL) RETURNS SETOF JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run;
BEGIN
    r:=agent_backend.read_agent_run(p_run,p_worker);
    RETURN QUERY SELECT * FROM agent_backend.olap_facts_for_actor(r.initiator_user_id,p_group,p_discipline,p_semester,p_status);
END $$;

REVOKE ALL ON FUNCTION backend_api.agent_visible_rows(UUID,UUID,TEXT),
    backend_api.agent_olap_facts(UUID,UUID,INT,INT,INT,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.agent_visible_rows(UUID,UUID,TEXT),
    backend_api.agent_olap_facts(UUID,UUID,INT,INT,INT,INT) TO backend_executor;
