-- Пять режимов экрана OLAP считаются в базе (вариант Г): в API уходит готовый ответ режима, а не набор фактов.
-- Правила те же, что в backend/olap.py (analysis_from_data) и docs/API.md; область прежняя:
-- студенты групп backend_api.allowed_groups(пользователь), роль из account_snapshot, студент — 42501.
-- Ядро — функция от пользователя (agent_backend.olap_<режим>_for_actor), обёртки — по токену API и по запуску агента.
-- Представления базы считают по всем студентам, поэтому каждое чтение фактов ограничено студентами области.
-- Ответ собирается в json (не jsonb): порядок ключей тот же, что у прежнего ответа.

-- Студенты области с фильтрами группы, курса и статуса; проверка роли — как в olap_dataset.
CREATE FUNCTION agent_backend.olap_students(p_user_id INT,p_group_id INT,p_course INT,p_status_id INT)
RETURNS TABLE(student_id INT,student TEXT,group_id INT,group_name VARCHAR,status_id INT,is_active BOOLEAN,
              course INT,current_semester INT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(p_user_id);
    IF a.role_code NOT IN ('admin','director','dean_staff','teacher') THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    RETURN QUERY SELECT x.* FROM (
        SELECT s.student_id,fn_full_name(p),s.group_id,g.name,s.status_id,st.is_active,
            fn_course(c.start_year,CURRENT_DATE) AS course,fn_semester(c.start_year,CURRENT_DATE)
        FROM student s JOIN person p ON p.person_id=s.person_id JOIN study_group g ON g.group_id=s.group_id
            JOIN curriculum c ON c.curriculum_id=g.curriculum_id JOIN student_status st ON st.status_id=s.status_id
        WHERE s.group_id IN (SELECT ag.group_id FROM backend_api.allowed_groups(a.user_id) ag)
    ) x WHERE (p_group_id IS NULL OR x.group_id=p_group_id) AND (p_course IS NULL OR x.course=p_course)
        AND (p_status_id IS NULL OR x.status_id=p_status_id);
END $$;

-- Защитный лимит: те же семь наборов фактов области, что раньше выгружал olap_dataset, только счётом.
CREATE FUNCTION agent_backend.olap_check_size(p_user_id INT) RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery SET plan_cache_mode=force_custom_plan AS $$
DECLARE ids INT[]; total BIGINT;
BEGIN
    SELECT COALESCE(array_agg(s.student_id),'{}') INTO ids FROM agent_backend.olap_students(p_user_id,NULL,NULL,NULL) s;
    SELECT cardinality(ids)
        +(SELECT count(*) FROM v_last_result lr WHERE lr.stage='final' AND lr.student_id=ANY(ids))
        +(SELECT count(*) FROM grade gr JOIN grade_sheet gs ON gs.sheet_id=gr.sheet_id
            WHERE gs.status<>'cancelled' AND gs.stage='final' AND gr.student_id=ANY(ids))
        +(SELECT count(*) FROM v_last_result lr JOIN student s ON s.student_id=lr.student_id
            JOIN study_group g ON g.group_id=s.group_id JOIN curriculum c ON c.curriculum_id=g.curriculum_id
            WHERE lr.stage='module_1' AND lr.semester=fn_semester(c.start_year,CURRENT_DATE) AND lr.student_id=ANY(ids))
        +(SELECT count(*) FROM agent_backend.olap_presence(ids))
        +(SELECT count(*) FROM v_debtors d WHERE d.student_id=ANY(ids))
        +(SELECT count(*) FROM order_student os WHERE os.student_id=ANY(ids))
    INTO total;
    IF total>100000 THEN RAISE EXCEPTION 'olap_too_large' USING ERRCODE='P6413'; END IF;
END $$;

-- Отметки посещаемости текущего семестра группы в пределах срока текущего периода обучения.
-- Помощники ниже — обычные SQL-функции без SECURITY DEFINER и SET: их встраивает в запрос функция режима,
-- которая уже работает с правами владельца; имена схем указаны полностью.
CREATE FUNCTION agent_backend.olap_presence(p_students INT[]) RETURNS TABLE(student_id INT,is_present BOOLEAN)
LANGUAGE sql STABLE AS $$
    SELECT at.student_id,at.is_present
    FROM (SELECT s.student_id,deanery.fn_semester(c.start_year,CURRENT_DATE) AS semester
          FROM deanery.student s JOIN deanery.study_group g ON g.group_id=s.group_id
              JOIN deanery.curriculum c ON c.curriculum_id=g.curriculum_id
          WHERE s.student_id=ANY(p_students) OFFSET 0) cur
        JOIN deanery.attendance at ON at.student_id=cur.student_id
        JOIN deanery.schedule_slot ss ON ss.slot_id=at.slot_id
        JOIN deanery.teaching_assignment ta ON ta.assignment_id=ss.assignment_id
        JOIN deanery.curriculum_item ci ON ci.item_id=ta.item_id AND ci.semester=cur.semester
        JOIN deanery.academic_term term ON term.term_id=ss.term_id
    WHERE CURRENT_DATE BETWEEN term.start_date AND term.session_end
$$;

-- Вид ведомости самой ранней попытки с баллами по ключу (студент, дисциплина, семестр): exam_date, затем sheet_id.
CREATE FUNCTION agent_backend.olap_passed(p_students INT[]) RETURNS TABLE(student_id INT,discipline_id INT,semester SMALLINT,sheet_kind VARCHAR)
LANGUAGE sql STABLE AS $$
    SELECT DISTINCT ON (gr.student_id,ci.discipline_id,ci.semester) gr.student_id,ci.discipline_id,ci.semester,gs.sheet_kind
    FROM deanery.grade gr JOIN deanery.grade_sheet gs ON gs.sheet_id=gr.sheet_id JOIN deanery.curriculum_item ci ON ci.item_id=gs.item_id
    WHERE gr.student_id=ANY(p_students) AND gs.status<>'cancelled' AND gs.stage='final' AND gr.points IS NOT NULL
    ORDER BY gr.student_id,ci.discipline_id,ci.semester,gs.exam_date NULLS LAST,gs.sheet_id
$$;

-- Итоговые результаты (v_last_result, этап final) студентов из списка, с фильтрами семестра и дисциплины.
CREATE FUNCTION agent_backend.olap_results(p_students INT[],p_semester INT,p_discipline_id INT)
RETURNS TABLE(student_id INT,discipline_id INT,discipline VARCHAR,semester SMALLINT,points SMALLINT,is_absent BOOLEAN,
              is_graded BOOLEAN,control_type VARCHAR,mark SMALLINT,result TEXT)
LANGUAGE sql STABLE AS $$
    SELECT lr.student_id,lr.discipline_id,d.name,lr.semester,lr.points,lr.is_absent,ct.is_graded,ct.name,
        deanery.fn_mark(lr.points),deanery.fn_result_name(lr.points,lr.is_absent,ct.is_graded,TRUE)
    FROM deanery.v_last_result lr JOIN deanery.discipline d ON d.discipline_id=lr.discipline_id
        JOIN deanery.curriculum_item ci ON ci.item_id=lr.item_id JOIN deanery.control_type ct ON ct.control_type_id=ci.control_type_id
    WHERE lr.stage='final' AND lr.student_id=ANY(p_students)
        AND (p_semester IS NULL OR lr.semester=p_semester) AND (p_discipline_id IS NULL OR lr.discipline_id=p_discipline_id)
$$;

-- Процент целый, половина вверх; NULL при пустом знаменателе.
CREATE FUNCTION agent_backend.olap_pct(p_part BIGINT,p_whole BIGINT) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN p_whole>0 THEN round(100.0*p_part/p_whole) END
$$;

-- Две цифры после запятой, как round(x,2) в Python: ровно посередине — к чётной.
CREATE FUNCTION agent_backend.olap_pct2(p_part BIGINT,p_whole BIGINT) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN 2*((10000*p_part)%p_whole)=p_whole AND ((10000*p_part)/p_whole)%2=0
        THEN ((10000*p_part)/p_whole)::NUMERIC/100 ELSE round(100.0*p_part/p_whole,2) END
$$;

-- total у heat и moves: {students, results, first_pass, debts, excellent} по результатам с фильтрами семестра и дисциплины.
-- plpgsql с force_custom_plan: запросы планируются с известным списком студентов; общий план с ANY(список) в разы медленнее.
CREATE FUNCTION agent_backend.olap_metrics(p_ids INT[],p_semester INT,p_discipline_id INT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery SET plan_cache_mode=force_custom_plan AS $$
DECLARE result JSON;
BEGIN
    WITH res AS MATERIALIZED (SELECT * FROM agent_backend.olap_results(p_ids,p_semester,p_discipline_id)),
    attempts AS MATERIALIZED (
        SELECT gr.student_id,ci.discipline_id,ci.semester,gs.sheet_kind,gr.points,d.name AS discipline
        FROM grade gr JOIN grade_sheet gs ON gs.sheet_id=gr.sheet_id JOIN curriculum_item ci ON ci.item_id=gs.item_id
            JOIN discipline d ON d.discipline_id=ci.discipline_id
        WHERE gr.student_id=ANY(p_ids) AND gs.status<>'cancelled' AND gs.stage='final'
            AND (p_semester IS NULL OR ci.semester=p_semester) AND (p_discipline_id IS NULL OR ci.discipline_id=p_discipline_id)
    ), first_pass AS (
        SELECT DISTINCT a.student_id,a.discipline_id,a.semester FROM attempts a
        WHERE a.sheet_kind IN ('main','individual') AND a.points IS NOT NULL
    ), per_student AS (
        SELECT bool_or(r.is_graded) AND bool_and(r.points IS NOT NULL AND (NOT r.is_graded OR COALESCE(r.mark,0)=5)) AS excellent
        FROM res r GROUP BY r.student_id
    )
    SELECT json_build_object('students',cardinality(p_ids),'results',(SELECT count(*) FROM res),
        'first_pass',(SELECT count(*) FROM res r JOIN first_pass f
            ON f.student_id=r.student_id AND f.discipline_id=r.discipline_id AND f.semester=r.semester),
        -- Долги v_debtors сопоставляются по названию дисциплины (в представлении нет discipline_id).
        'debts',(SELECT count(*) FROM v_debtors d WHERE d.student_id=ANY(p_ids)
            AND (p_semester IS NULL OR d.semester=p_semester)
            AND (p_discipline_id IS NULL OR d.discipline IN (SELECT r.discipline FROM res r UNION SELECT a.discipline FROM attempts a))),
        'excellent',(SELECT count(*) FILTER (WHERE excellent) FROM per_student)) INTO result;
    RETURN result;
END $$;

-- «Итоги сессии»: p_level course | group | discipline | result (синоним student заменяет API).
CREATE FUNCTION agent_backend.olap_session_for_actor(p_user_id INT,p_level TEXT,p_course INT,p_group_id INT,
    p_discipline_id INT,p_semester INT,p_status_id INT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery SET plan_cache_mode=force_custom_plan AS $$
DECLARE ids INT[]; result JSON;
BEGIN
    PERFORM agent_backend.olap_check_size(p_user_id);
    SELECT COALESCE(array_agg(s.student_id),'{}') INTO ids FROM agent_backend.olap_students(p_user_id,p_group_id,p_course,p_status_id) s;
    WITH st AS MATERIALIZED (SELECT * FROM agent_backend.olap_students(p_user_id,p_group_id,p_course,p_status_id)),
    passed AS MATERIALIZED (SELECT * FROM agent_backend.olap_passed(ids)),
    res AS MATERIALIZED (
        -- Сессия студента: заданный семестр или предыдущий семестр его группы.
        SELECT r.*,st.student,st.group_id,st.group_name,st.course,p.sheet_kind AS attempt,
            COALESCE(p.sheet_kind IN ('main','individual'),FALSE) AS first,
            CASE p_level WHEN 'course' THEN st.course WHEN 'group' THEN st.group_id WHEN 'discipline' THEN r.discipline_id END AS bucket,
            CASE p_level WHEN 'course' THEN st.course||' курс' WHEN 'group' THEN st.group_name WHEN 'discipline' THEN r.discipline END AS name
        FROM agent_backend.olap_results(ids,NULL,p_discipline_id) r JOIN st ON st.student_id=r.student_id
            LEFT JOIN passed p ON p.student_id=r.student_id AND p.discipline_id=r.discipline_id AND p.semester=r.semester
        WHERE r.semester=COALESCE(p_semester,st.current_semester-1) AND r.semester>=1
    ), per_student AS (
        -- Строка с is_total — итог по всей области; без него — по корзине уровня.
        SELECT b.is_total,b.bucket,r.student_id,bool_and(r.first) AS clean,
            bool_and(NOT r.is_graded OR COALESCE(r.mark,0)>=4) AS quality,
            bool_or(r.is_graded) AND bool_and(NOT r.is_graded OR COALESCE(r.mark,0)=5) AS excellent,
            count(*) FILTER (WHERE NOT r.first) AS debts
        FROM res r CROSS JOIN LATERAL (VALUES (TRUE,NULL::INT),(FALSE,r.bucket)) b(is_total,bucket)
        GROUP BY b.is_total,b.bucket,r.student_id
    ), summary AS (
        SELECT p.is_total,p.bucket,count(*) AS students,count(*) FILTER (WHERE p.clean) AS clean,
            count(*) FILTER (WHERE p.clean AND p.quality) AS quality,sum(p.debts) AS debts,
            count(*) FILTER (WHERE p.clean AND p.excellent) AS excellent
        FROM per_student p GROUP BY p.is_total,p.bucket
    ), named AS (SELECT DISTINCT ON (r.bucket) r.bucket,r.name FROM res r ORDER BY r.bucket)
    SELECT json_build_object('level',p_level,
        'rows',CASE WHEN p_level='result' THEN
            COALESCE((SELECT json_agg(json_build_object('student_id',r.student_id,'student',r.student,'control_type',r.control_type,
                'is_graded',r.is_graded,'points',r.points,'is_absent',r.is_absent,'mark',r.mark,'result',r.result,'attempt',r.attempt)
                ORDER BY r.student COLLATE "C",r.student_id) FROM res r),'[]')
        ELSE COALESCE((SELECT json_agg(json_build_object(
                CASE p_level WHEN 'course' THEN 'course' WHEN 'group' THEN 'group_id' ELSE 'discipline_id' END,s.bucket,
                'name',n.name,'students',s.students,'abs_pct',agent_backend.olap_pct(s.clean,s.students),
                'qual_pct',agent_backend.olap_pct(s.quality,s.students),'debts',s.debts,'excellent',s.excellent)
                ORDER BY CASE WHEN p_level='course' THEN s.bucket END,n.name COLLATE "C",s.bucket)
            FROM summary s JOIN named n ON n.bucket=s.bucket WHERE NOT s.is_total),'[]') END,
        'total',(SELECT json_build_object('students',COALESCE(s.students,0),'abs_pct',agent_backend.olap_pct(s.clean,s.students),
            'qual_pct',agent_backend.olap_pct(s.quality,s.students),'debts',COALESCE(s.debts,0),'excellent',COALESCE(s.excellent,0))
            FROM (SELECT 1) one LEFT JOIN summary s ON s.is_total)) INTO result;
    RETURN result;
END $$;

-- «Проблемные дисциплины»: доля результатов, не сданных с основной или индивидуальной ведомости, по дисциплине и группе.
CREATE FUNCTION agent_backend.olap_heat_for_actor(p_user_id INT,p_course INT,p_group_id INT,p_discipline_id INT,
    p_semester INT,p_status_id INT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery SET plan_cache_mode=force_custom_plan AS $$
DECLARE ids INT[]; result JSON;
BEGIN
    PERFORM agent_backend.olap_check_size(p_user_id);
    SELECT COALESCE(array_agg(s.student_id),'{}') INTO ids FROM agent_backend.olap_students(p_user_id,p_group_id,p_course,p_status_id) s;
    WITH st AS MATERIALIZED (SELECT * FROM agent_backend.olap_students(p_user_id,p_group_id,p_course,p_status_id)),
    first_pass AS MATERIALIZED (
        SELECT DISTINCT gr.student_id,ci.discipline_id,ci.semester
        FROM grade gr JOIN grade_sheet gs ON gs.sheet_id=gr.sheet_id JOIN curriculum_item ci ON ci.item_id=gs.item_id
        WHERE gr.student_id=ANY(ids) AND gs.status<>'cancelled' AND gs.stage='final'
            AND gs.sheet_kind IN ('main','individual') AND gr.points IS NOT NULL
    ), cells AS (
        SELECT r.discipline_id,min(r.discipline) AS discipline,st.group_id,min(st.group_name) AS group_name,count(*) AS results,
            count(f.student_id) AS first_pass
        FROM agent_backend.olap_results(ids,p_semester,p_discipline_id) r JOIN st ON st.student_id=r.student_id
            LEFT JOIN first_pass f ON f.student_id=r.student_id AND f.discipline_id=r.discipline_id AND f.semester=r.semester
        GROUP BY r.discipline_id,st.group_id
    )
    SELECT json_build_object(
        'rows',COALESCE((SELECT json_agg(json_build_object('discipline_id',c.discipline_id,'discipline',c.discipline,
            'group_id',c.group_id,'group_name',c.group_name,'results',c.results,'first_pass',c.first_pass,
            'not_first_pass_pct',agent_backend.olap_pct2(c.results-c.first_pass,c.results))
            ORDER BY c.discipline_id,c.group_id) FROM cells c),'[]'),
        'total',agent_backend.olap_metrics(ids,p_semester,p_discipline_id)) INTO result;
    RETURN result;
END $$;

-- «Раннее предупреждение»: обучающиеся студенты, факторы — слабый модуль 1, посещаемость, долги.
CREATE FUNCTION agent_backend.olap_risk_for_actor(p_user_id INT,p_course INT,p_group_id INT,p_status_id INT,
    p_mod_min INT,p_att_min DOUBLE PRECISION) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery SET plan_cache_mode=force_custom_plan AS $$
DECLARE ids INT[]; result JSON;
BEGIN
    PERFORM agent_backend.olap_check_size(p_user_id);
    SELECT COALESCE(array_agg(s.student_id),'{}') INTO ids
        FROM agent_backend.olap_students(p_user_id,p_group_id,p_course,p_status_id) s WHERE s.is_active;
    WITH pool AS MATERIALIZED (SELECT * FROM agent_backend.olap_students(p_user_id,p_group_id,p_course,p_status_id) s WHERE s.is_active),
    weak AS (
        -- Модуль 1 текущего семестра группы — последняя запись v_last_result.
        SELECT lr.student_id,count(*) AS n,json_agg(json_build_object('discipline_id',lr.discipline_id,'discipline',d.name,
            'points',lr.points,'is_absent',lr.is_absent) ORDER BY d.name COLLATE "C",lr.discipline_id) AS modules
        FROM v_last_result lr JOIN pool p ON p.student_id=lr.student_id JOIN discipline d ON d.discipline_id=lr.discipline_id
        WHERE lr.stage='module_1' AND lr.semester=p.current_semester AND (lr.points IS NULL OR lr.points<p_mod_min)
        GROUP BY lr.student_id
    ), presence AS (
        SELECT a.student_id,count(*) AS n,round(100.0*count(*) FILTER (WHERE a.is_present)/count(*),1) AS pct
        FROM agent_backend.olap_presence(ids) a GROUP BY a.student_id
    ), scored AS (
        -- Средний балл и долги — из v_student_summary (посещаемость оттуда не берётся: она за всё время).
        SELECT p.student_id,p.student,p.group_id,p.group_name,p.course,w.modules,COALESCE(w.n,0) AS weak_n,
            a.pct,COALESCE(a.n,0) AS att_n,COALESCE(a.pct::DOUBLE PRECISION<p_att_min,FALSE) AS att_low,
            vs.avg_points,vs.debts,
            (w.n IS NOT NULL)::INT+COALESCE(a.pct::DOUBLE PRECISION<p_att_min,FALSE)::INT+(vs.debts>0)::INT AS score
        FROM pool p LEFT JOIN weak w ON w.student_id=p.student_id LEFT JOIN presence a ON a.student_id=p.student_id
            JOIN v_student_summary vs ON vs.student_id=p.student_id
    )
    SELECT json_build_object(
        'rows',COALESCE((SELECT json_agg(json_build_object('student_id',s.student_id,'student',s.student,'group_id',s.group_id,
            'group_name',s.group_name,'course',s.course,'low_modules',COALESCE(s.modules,'[]'::JSON),'attendance_pct',s.pct,
            'attendance_count',s.att_n,'attendance_low',s.att_low,'debts',s.debts,'score',s.score,
            'risk',CASE WHEN s.score>=2 THEN 'high' ELSE 'medium' END)
            ORDER BY s.score DESC,s.weak_n DESC,s.student COLLATE "C",s.student_id) FROM scored s WHERE s.score>0),'[]'),
        'total',(SELECT json_build_object('pool',count(*),'at_risk',count(*) FILTER (WHERE s.score>0),
            'high',count(*) FILTER (WHERE s.score>=2),'low_module',count(*) FILTER (WHERE s.weak_n>0),
            'low_attendance',count(*) FILTER (WHERE s.att_low),'with_debts',count(*) FILTER (WHERE s.debts>0)) FROM scored s),
        'points',COALESCE((SELECT json_agg(json_build_object('student_id',s.student_id,'student',s.student,'group_name',s.group_name,
            'attendance_pct',s.pct,'avg_points',s.avg_points,'debts',s.debts) ORDER BY s.student COLLATE "C",s.student_id)
            FROM scored s WHERE s.avg_points IS NOT NULL),'[]')) INTO result;
    RETURN result;
END $$;

-- «Пересдачи»: долги сессий завершённых семестров обучающихся студентов и как они закрыты; level group | course.
CREATE FUNCTION agent_backend.olap_retake_for_actor(p_user_id INT,p_level TEXT,p_course INT,p_group_id INT,p_status_id INT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery SET plan_cache_mode=force_custom_plan AS $$
DECLARE ids INT[]; result JSON;
BEGIN
    PERFORM agent_backend.olap_check_size(p_user_id);
    SELECT COALESCE(array_agg(s.student_id),'{}') INTO ids
        FROM agent_backend.olap_students(p_user_id,p_group_id,p_course,p_status_id) s WHERE s.is_active;
    WITH pool AS MATERIALIZED (SELECT * FROM agent_backend.olap_students(p_user_id,p_group_id,p_course,p_status_id) s WHERE s.is_active),
    passed AS MATERIALIZED (SELECT * FROM agent_backend.olap_passed(ids)),
    debts AS MATERIALIZED (
        -- Закрыт пересдачей, комиссией или ещё открыт (такой ключ есть в v_debtors).
        SELECT CASE WHEN p_level='course' THEN p.course ELSE p.group_id END AS bucket,
            CASE WHEN p_level='course' THEN p.course||' курс' ELSE p.group_name END AS name,
            CASE ps.sheet_kind WHEN 'retake' THEN 'closed_retake' WHEN 'commission' THEN 'closed_commission' ELSE 'open' END AS col
        FROM agent_backend.olap_results(ids,NULL,NULL) r JOIN pool p ON p.student_id=r.student_id
            LEFT JOIN passed ps ON ps.student_id=r.student_id AND ps.discipline_id=r.discipline_id AND ps.semester=r.semester
        WHERE r.semester<p.current_semester AND ps.sheet_kind IS DISTINCT FROM 'main' AND ps.sheet_kind IS DISTINCT FROM 'individual'
    ), counted AS (
        SELECT d.bucket,min(d.name) AS name,count(*) AS failed,count(*) FILTER (WHERE d.col='closed_retake') AS closed_retake,
            count(*) FILTER (WHERE d.col='closed_commission') AS closed_commission,count(*) FILTER (WHERE d.col='open') AS open
        FROM debts d GROUP BY GROUPING SETS ((d.bucket),())
    )
    SELECT json_build_object('level',p_level,
        'rows',COALESCE((SELECT json_agg(json_build_object(CASE WHEN p_level='course' THEN 'course' ELSE 'group_id' END,c.bucket,
            'name',c.name,'failed',c.failed,'closed_retake',c.closed_retake,'closed_commission',c.closed_commission,'open',c.open,
            'closed_pct',agent_backend.olap_pct(c.closed_retake+c.closed_commission,c.failed))
            ORDER BY CASE WHEN p_level='course' THEN c.bucket END,c.name COLLATE "C",c.bucket)
            FROM counted c WHERE c.bucket IS NOT NULL),'[]'),
        'total',(SELECT json_build_object('failed',COALESCE(c.failed,0),'closed_retake',COALESCE(c.closed_retake,0),
            'closed_commission',COALESCE(c.closed_commission,0),'open',COALESCE(c.open,0),
            'closed_pct',agent_backend.olap_pct(c.closed_retake+c.closed_commission,c.failed),
            -- Правило v_expulsion_risk — по строкам самого представления для студентов области.
            'expulsion_candidates',(SELECT count(*) FROM v_expulsion_risk er WHERE er.student_id=ANY(ids)))
            FROM (SELECT 1) one LEFT JOIN counted c ON c.bucket IS NULL)) INTO result;
    RETURN result;
END $$;

-- «Движение контингента»: пары «приказ × студент» области по периодам даты приказа.
CREATE FUNCTION agent_backend.olap_moves_for_actor(p_user_id INT,p_period TEXT,p_pick TEXT,p_types TEXT[],p_from TEXT,p_to TEXT,
    p_list BOOLEAN,p_course INT,p_group_id INT,p_discipline_id INT,p_semester INT,p_status_id INT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery SET plan_cache_mode=force_custom_plan AS $$
DECLARE ids INT[]; result JSON;
BEGIN
    PERFORM agent_backend.olap_check_size(p_user_id);
    SELECT COALESCE(array_agg(s.student_id),'{}') INTO ids FROM agent_backend.olap_students(p_user_id,p_group_id,p_course,p_status_id) s;
    WITH st AS MATERIALIZED (SELECT * FROM agent_backend.olap_students(p_user_id,p_group_id,p_course,p_status_id)),
    pairs AS MATERIALIZED (
        -- Учебный год — с сентября по август: 2025/26, 2025/26-1 (сентябрь–январь), 2025/26-2 (февраль–август).
        SELECT o.order_id,o.order_number,o.order_date,o.effective_date,ot.code AS order_type_code,ot.name AS order_type,
            os.applied_at,st.student_id,st.student,st.group_id,st.group_name,st.course,
            CASE p_period WHEN 'month' THEN to_char(o.order_date,'YYYY-MM')
                ELSE y.year||'/'||right((y.year+1)::TEXT,2)||CASE WHEN p_period='semester'
                    THEN CASE WHEN extract(MONTH FROM o.order_date)>=9 OR extract(MONTH FROM o.order_date)=1 THEN '-1' ELSE '-2' END ELSE '' END
            END AS period
        FROM academic_order o JOIN order_type ot ON ot.order_type_id=o.order_type_id
            JOIN order_student os ON os.order_id=o.order_id JOIN st ON st.student_id=os.student_id
            CROSS JOIN LATERAL (SELECT extract(YEAR FROM o.order_date)::INT-CASE WHEN extract(MONTH FROM o.order_date)>=9 THEN 0 ELSE 1 END AS year) y
        WHERE (p_types IS NULL OR ot.code=ANY(p_types))
            AND (p_from IS NULL OR to_char(o.order_date,'YYYY-MM')>=p_from) AND (p_to IS NULL OR to_char(o.order_date,'YYYY-MM')<=p_to)
    ), periods AS (
        SELECT p.period,count(DISTINCT p.order_id) AS orders,count(DISTINCT p.student_id) AS students FROM pairs p GROUP BY p.period
    ), kinds AS (
        SELECT p.period,p.order_type_code,count(DISTINCT p.order_id) AS orders,count(*) AS pairs FROM pairs p GROUP BY p.period,p.order_type_code
    ), picked AS (
        SELECT p.order_id,p.order_number,p.order_date,p.effective_date,p.order_type_code,p.order_type,
            json_agg(json_build_object('student_id',p.student_id,'student',p.student,'group_id',p.group_id,'group_name',p.group_name,
                'applied_at',p.applied_at) ORDER BY p.student COLLATE "C",p.student_id) AS students
        FROM pairs p WHERE p.period=p_pick
        GROUP BY p.order_id,p.order_number,p.order_date,p.effective_date,p.order_type_code,p.order_type
    )
    SELECT json_build_object(
        'rows',CASE WHEN p_pick IS NULL THEN
            COALESCE((SELECT json_agg(json_build_object('period',pr.period,'orders',pr.orders,'students',pr.students,
                'by_type',(SELECT json_object_agg(k.order_type_code,k.orders ORDER BY k.order_type_code COLLATE "C") FROM kinds k WHERE k.period=pr.period),
                'students_by_type',(SELECT json_object_agg(k.order_type_code,k.pairs ORDER BY k.order_type_code COLLATE "C") FROM kinds k WHERE k.period=pr.period))
                ORDER BY pr.period COLLATE "C") FROM periods pr),'[]')
        ELSE COALESCE((SELECT json_agg(json_build_object('order_id',k.order_id,'order_number',k.order_number,'order_date',k.order_date,
                'effective_date',k.effective_date,'order_type_code',k.order_type_code,'order_type',k.order_type,'students',k.students)
                ORDER BY k.order_date DESC,k.order_number COLLATE "C",k.order_id) FROM picked k),'[]') END,
        'total',agent_backend.olap_metrics(ids,p_semester,p_discipline_id),
        'orders',CASE WHEN p_list THEN COALESCE((SELECT json_agg(json_build_object('order_id',p.order_id,'order_number',p.order_number,
            'order_date',p.order_date,'effective_date',p.effective_date,'order_type',p.order_type,'order_type_code',p.order_type_code,
            'applied_at',p.applied_at,'student_id',p.student_id,'student',p.student,'group_id',p.group_id,'group_name',p.group_name,
            'course',p.course,'period',p.period)
            ORDER BY p.order_date DESC,p.order_number COLLATE "C",p.student COLLATE "C",p.student_id) FROM pairs p),'[]') END) INTO result;
    RETURN result;
END $$;

-- Обёртки: API — пользователь по токену, агент — автор запуска (initiator_user_id); область та же.
CREATE FUNCTION backend_api.olap_session(p_token TEXT,p_level TEXT,p_course INT,p_group_id INT,p_discipline_id INT,p_semester INT,p_status_id INT)
RETURNS JSON LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT agent_backend.olap_session_for_actor(agent_backend.proposal_actor(p_token),p_level,p_course,p_group_id,p_discipline_id,p_semester,p_status_id)
$$;
CREATE FUNCTION backend_api.olap_heat(p_token TEXT,p_course INT,p_group_id INT,p_discipline_id INT,p_semester INT,p_status_id INT)
RETURNS JSON LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT agent_backend.olap_heat_for_actor(agent_backend.proposal_actor(p_token),p_course,p_group_id,p_discipline_id,p_semester,p_status_id)
$$;
CREATE FUNCTION backend_api.olap_risk(p_token TEXT,p_course INT,p_group_id INT,p_status_id INT,p_mod_min INT,p_att_min DOUBLE PRECISION)
RETURNS JSON LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT agent_backend.olap_risk_for_actor(agent_backend.proposal_actor(p_token),p_course,p_group_id,p_status_id,p_mod_min,p_att_min)
$$;
CREATE FUNCTION backend_api.olap_retake(p_token TEXT,p_level TEXT,p_course INT,p_group_id INT,p_status_id INT)
RETURNS JSON LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT agent_backend.olap_retake_for_actor(agent_backend.proposal_actor(p_token),p_level,p_course,p_group_id,p_status_id)
$$;
CREATE FUNCTION backend_api.olap_moves(p_token TEXT,p_period TEXT,p_pick TEXT,p_types TEXT[],p_from TEXT,p_to TEXT,p_list BOOLEAN,
    p_course INT,p_group_id INT,p_discipline_id INT,p_semester INT,p_status_id INT)
RETURNS JSON LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT agent_backend.olap_moves_for_actor(agent_backend.proposal_actor(p_token),p_period,p_pick,p_types,p_from,p_to,p_list,
        p_course,p_group_id,p_discipline_id,p_semester,p_status_id)
$$;

CREATE FUNCTION backend_api.agent_olap_session(p_run UUID,p_worker UUID,p_level TEXT,p_course INT,p_group_id INT,p_discipline_id INT,
    p_semester INT,p_status_id INT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run;
BEGIN
    r:=agent_backend.read_agent_run(p_run,p_worker);
    RETURN agent_backend.olap_session_for_actor(r.initiator_user_id,p_level,p_course,p_group_id,p_discipline_id,p_semester,p_status_id);
END $$;
CREATE FUNCTION backend_api.agent_olap_heat(p_run UUID,p_worker UUID,p_course INT,p_group_id INT,p_discipline_id INT,p_semester INT,
    p_status_id INT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run;
BEGIN
    r:=agent_backend.read_agent_run(p_run,p_worker);
    RETURN agent_backend.olap_heat_for_actor(r.initiator_user_id,p_course,p_group_id,p_discipline_id,p_semester,p_status_id);
END $$;
CREATE FUNCTION backend_api.agent_olap_risk(p_run UUID,p_worker UUID,p_course INT,p_group_id INT,p_status_id INT,p_mod_min INT,
    p_att_min DOUBLE PRECISION) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run;
BEGIN
    r:=agent_backend.read_agent_run(p_run,p_worker);
    RETURN agent_backend.olap_risk_for_actor(r.initiator_user_id,p_course,p_group_id,p_status_id,p_mod_min,p_att_min);
END $$;
CREATE FUNCTION backend_api.agent_olap_retake(p_run UUID,p_worker UUID,p_level TEXT,p_course INT,p_group_id INT,p_status_id INT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run;
BEGIN
    r:=agent_backend.read_agent_run(p_run,p_worker);
    RETURN agent_backend.olap_retake_for_actor(r.initiator_user_id,p_level,p_course,p_group_id,p_status_id);
END $$;
CREATE FUNCTION backend_api.agent_olap_moves(p_run UUID,p_worker UUID,p_period TEXT,p_pick TEXT,p_types TEXT[],p_from TEXT,p_to TEXT,
    p_list BOOLEAN,p_course INT,p_group_id INT,p_discipline_id INT,p_semester INT,p_status_id INT) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run;
BEGIN
    r:=agent_backend.read_agent_run(p_run,p_worker);
    RETURN agent_backend.olap_moves_for_actor(r.initiator_user_id,p_period,p_pick,p_types,p_from,p_to,p_list,
        p_course,p_group_id,p_discipline_id,p_semester,p_status_id);
END $$;

REVOKE ALL ON FUNCTION agent_backend.olap_students(INT,INT,INT,INT),agent_backend.olap_check_size(INT),
    agent_backend.olap_presence(INT[]),agent_backend.olap_passed(INT[]),agent_backend.olap_results(INT[],INT,INT),
    agent_backend.olap_pct(BIGINT,BIGINT),agent_backend.olap_pct2(BIGINT,BIGINT),agent_backend.olap_metrics(INT[],INT,INT),
    agent_backend.olap_session_for_actor(INT,TEXT,INT,INT,INT,INT,INT),agent_backend.olap_heat_for_actor(INT,INT,INT,INT,INT,INT),
    agent_backend.olap_risk_for_actor(INT,INT,INT,INT,INT,DOUBLE PRECISION),agent_backend.olap_retake_for_actor(INT,TEXT,INT,INT,INT),
    agent_backend.olap_moves_for_actor(INT,TEXT,TEXT,TEXT[],TEXT,TEXT,BOOLEAN,INT,INT,INT,INT,INT),
    backend_api.olap_session(TEXT,TEXT,INT,INT,INT,INT,INT),backend_api.olap_heat(TEXT,INT,INT,INT,INT,INT),
    backend_api.olap_risk(TEXT,INT,INT,INT,INT,DOUBLE PRECISION),backend_api.olap_retake(TEXT,TEXT,INT,INT,INT),
    backend_api.olap_moves(TEXT,TEXT,TEXT,TEXT[],TEXT,TEXT,BOOLEAN,INT,INT,INT,INT,INT),
    backend_api.agent_olap_session(UUID,UUID,TEXT,INT,INT,INT,INT,INT),backend_api.agent_olap_heat(UUID,UUID,INT,INT,INT,INT,INT),
    backend_api.agent_olap_risk(UUID,UUID,INT,INT,INT,INT,DOUBLE PRECISION),backend_api.agent_olap_retake(UUID,UUID,TEXT,INT,INT,INT),
    backend_api.agent_olap_moves(UUID,UUID,TEXT,TEXT,TEXT[],TEXT,TEXT,BOOLEAN,INT,INT,INT,INT,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.olap_session(TEXT,TEXT,INT,INT,INT,INT,INT),backend_api.olap_heat(TEXT,INT,INT,INT,INT,INT),
    backend_api.olap_risk(TEXT,INT,INT,INT,INT,DOUBLE PRECISION),backend_api.olap_retake(TEXT,TEXT,INT,INT,INT),
    backend_api.olap_moves(TEXT,TEXT,TEXT,TEXT[],TEXT,TEXT,BOOLEAN,INT,INT,INT,INT,INT) TO backend_api;
GRANT EXECUTE ON FUNCTION backend_api.agent_olap_session(UUID,UUID,TEXT,INT,INT,INT,INT,INT),
    backend_api.agent_olap_heat(UUID,UUID,INT,INT,INT,INT,INT),backend_api.agent_olap_risk(UUID,UUID,INT,INT,INT,INT,DOUBLE PRECISION),
    backend_api.agent_olap_retake(UUID,UUID,TEXT,INT,INT,INT),
    backend_api.agent_olap_moves(UUID,UUID,TEXT,TEXT,TEXT[],TEXT,TEXT,BOOLEAN,INT,INT,INT,INT,INT) TO backend_executor;
