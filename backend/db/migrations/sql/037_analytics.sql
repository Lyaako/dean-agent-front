CREATE FUNCTION backend_api.olap_dataset(p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; result JSONB;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(agent_backend.proposal_actor(p_token));
    IF a.role_code NOT IN ('admin','director','dean_staff','teacher') THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    WITH students AS MATERIALIZED (
        SELECT s.student_id,fn_full_name(p) AS student,s.group_id,g.name AS group_name,s.status_id,
            fn_course(c.start_year,CURRENT_DATE) AS course,fn_semester(c.start_year,CURRENT_DATE) AS current_semester
        FROM student s JOIN person p USING(person_id) JOIN study_group g USING(group_id)
            JOIN curriculum c ON c.curriculum_id=g.curriculum_id
        WHERE s.group_id IN (SELECT group_id FROM backend_api.allowed_groups(a.user_id))
    ), results AS (
        SELECT lr.*,s.group_id,s.group_name,s.student,s.course,s.status_id,d.name AS discipline,
            ct.is_graded,fn_mark(lr.points) AS mark,gs.sheet_kind
        FROM v_last_result lr JOIN students s USING(student_id) JOIN discipline d USING(discipline_id)
            JOIN curriculum_item ci USING(item_id) JOIN control_type ct USING(control_type_id)
            JOIN grade_sheet gs USING(sheet_id) WHERE lr.stage='final'
    ), attempts AS (
        SELECT gr.grade_id,gr.student_id,gr.points,gr.is_absent,gs.sheet_kind,gs.sheet_id,gs.exam_date,
            ci.discipline_id,d.name AS discipline,ci.semester,s.group_id,s.group_name,s.course,s.status_id
        FROM grade gr JOIN grade_sheet gs USING(sheet_id) JOIN curriculum_item ci USING(item_id)
            JOIN discipline d USING(discipline_id) JOIN students s USING(student_id)
        WHERE gs.status<>'cancelled' AND gs.stage='final'
    ), modules AS (
        SELECT DISTINCT ON (gr.student_id,ci.discipline_id,ci.semester)
            gr.student_id,ci.discipline_id,d.name AS discipline,ci.semester,gr.points,gr.is_absent
        FROM grade gr JOIN grade_sheet gs USING(sheet_id) JOIN curriculum_item ci USING(item_id)
            JOIN discipline d USING(discipline_id) JOIN students s USING(student_id)
        WHERE gs.status<>'cancelled' AND gs.stage='module_1' AND ci.semester=s.current_semester
        ORDER BY gr.student_id,ci.discipline_id,ci.semester,gs.exam_date DESC NULLS LAST,gs.sheet_id DESC
    ), presence AS (
        SELECT at.student_id,ci.discipline_id,at.is_present,ci.semester
        FROM attendance at JOIN schedule_slot ss USING(slot_id) JOIN teaching_assignment ta USING(assignment_id)
            JOIN curriculum_item ci USING(item_id) JOIN students s USING(student_id)
            JOIN academic_term term USING(term_id)
        WHERE ci.semester=s.current_semester AND CURRENT_DATE BETWEEN term.start_date AND term.session_end
    ), debts AS (
        SELECT d.* FROM v_debtors d JOIN students s USING(student_id)
    ), orders AS (
        SELECT o.order_id,o.order_number,o.order_date,o.effective_date,ot.code AS order_type_code,ot.name AS order_type,
            os.student_id,os.applied_at,s.group_id,s.group_name,s.student,s.course
        FROM academic_order o JOIN order_type ot USING(order_type_id) JOIN order_student os USING(order_id)
            JOIN students s USING(student_id)
    ) SELECT jsonb_build_object('students',COALESCE((SELECT jsonb_agg(s) FROM students s),'[]'),
        'results',COALESCE((SELECT jsonb_agg(r) FROM results r),'[]'),
        'attempts',COALESCE((SELECT jsonb_agg(r) FROM attempts r),'[]'),
        'modules',COALESCE((SELECT jsonb_agg(r) FROM modules r),'[]'),
        'attendance',COALESCE((SELECT jsonb_agg(r) FROM presence r),'[]'),
        'debts',COALESCE((SELECT jsonb_agg(r) FROM debts r),'[]'),
        'orders',COALESCE((SELECT jsonb_agg(r) FROM orders r),'[]')) INTO result;
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION backend_api.olap_dataset(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.olap_dataset(TEXT) TO backend_api;

-- Background domain writes run with the agent's native privileges and no claimed user.
ALTER FUNCTION backend_api.apply_tracked_order(INT,INT) SECURITY INVOKER;
ALTER FUNCTION backend_api.perform_order_job(UUID,UUID) SECURITY INVOKER;
GRANT EXECUTE ON FUNCTION backend_api.apply_tracked_order(INT,INT),backend_api.perform_order_job(UUID,UUID)
    TO backend_api,backend_executor,backend_worker;
