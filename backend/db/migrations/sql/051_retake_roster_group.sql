-- Состав пересдачи (retake/commission/individual) — только студенты с несданной попыткой в ведомости этой группы.
-- Прежняя версия (050) брала несданные попытки из любой группы: в состав попадали чужие студенты.
-- Состав ведомости по правилам trg_grade_check / trg_sheet_status: кому можно или уже выставлен результат.
CREATE OR REPLACE FUNCTION backend_api.sheet_roster(p_sheet INT,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; sh grade_sheet; me curriculum_item; result JSONB; allowed BOOLEAN;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(agent_backend.proposal_actor(p_token)) WHERE is_active;
    SELECT * INTO sh FROM grade_sheet WHERE sheet_id=p_sheet;
    allowed:=CASE WHEN a.user_id IS NULL OR sh.sheet_id IS NULL THEN FALSE
        WHEN a.role_code='teacher' THEN sh.examiner_id IS NOT DISTINCT FROM a.teacher_id
        WHEN a.role_code IN ('admin','director','dean_staff') THEN
            EXISTS(SELECT FROM backend_api.allowed_groups(a.user_id) WHERE group_id=sh.group_id)
        ELSE FALSE END;
    -- Недоступная ведомость неотличима от несуществующей.
    IF NOT allowed THEN RAISE EXCEPTION 'Sheet missing' USING ERRCODE='P0002'; END IF;
    SELECT * INTO me FROM curriculum_item WHERE item_id=sh.item_id;
    WITH attempts AS (
        -- Попытки этапа дисциплины (дисциплина + семестр, как v_last_result) в других неотменённых ведомостях.
        SELECT g.student_id,bool_or(g.points IS NOT NULL) AS passed,bool_or(gs.status='open') AS in_open,
            -- Попытка в ведомости этой группы: состав пересдачи — только свои несдавшие (и переведённые с долгом).
            -- passed и in_open считаются по всем группам, как в trg_grade_check.
            bool_or(gs.group_id=sh.group_id) AS here
        FROM grade g JOIN grade_sheet gs ON gs.sheet_id=g.sheet_id AND gs.status<>'cancelled'
            JOIN curriculum_item ci ON ci.item_id=gs.item_id
        WHERE ci.discipline_id=me.discipline_id AND ci.semester=me.semester AND gs.stage=sh.stage AND gs.sheet_id<>sh.sheet_id
        GROUP BY g.student_id
    ), members AS (
        SELECT student_id FROM grade WHERE sheet_id=sh.sheet_id
        UNION
        SELECT s.student_id FROM student s JOIN student_status st USING(status_id)
        WHERE sh.status='open' AND st.is_active AND CASE WHEN sh.sheet_kind='main' THEN s.group_id=sh.group_id
            ELSE EXISTS(SELECT FROM attempts t WHERE t.student_id=s.student_id AND t.here AND NOT t.passed AND NOT t.in_open) END
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('student_id',s.student_id,'student',fn_full_name(p),'active',st.is_active,
            'grade_id',g.grade_id,'points',g.points,'is_absent',COALESCE(g.is_absent,FALSE))
            ORDER BY p.last_name,p.first_name,p.middle_name NULLS FIRST,s.student_id),'[]'::JSONB) INTO result
    FROM members m JOIN student s USING(student_id) JOIN student_status st USING(status_id) JOIN person p USING(person_id)
        LEFT JOIN grade g ON g.sheet_id=sh.sheet_id AND g.student_id=s.student_id;
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION backend_api.sheet_roster(INT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.sheet_roster(INT,TEXT) TO backend_api;
