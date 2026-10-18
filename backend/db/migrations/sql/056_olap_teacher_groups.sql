-- Прежние восемь режимов OLAP: область преподавателя — как у пяти новых режимов (решение пользователя 18.10.2026):
-- студенты групп его поручений (allowed_groups), все дисциплины этих групп. Раньше факты отбирались по
-- дисциплине и семестру поручения, а студенты — через allowed_students (у преподавателя шире: руководство
-- курсовыми/ВКР в чужих группах). Остальные роли не меняются.
CREATE OR REPLACE FUNCTION agent_backend.olap_facts_for_actor(p_user_id INT, p_group_id INT DEFAULT NULL,
                                       p_discipline_id INT DEFAULT NULL, p_semester INT DEFAULT NULL,
                                       p_status_id INT DEFAULT NULL) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, deanery AS $$
WITH actor AS MATERIALIZED (
    SELECT * FROM backend_api.account_snapshot(p_user_id) WHERE is_active
), allowed AS MATERIALIZED (
    SELECT s.student_id FROM actor a CROSS JOIN LATERAL backend_api.allowed_students(a.user_id) s
    WHERE a.role_code<>'teacher'
    UNION ALL
    SELECT st.student_id FROM actor a JOIN deanery.student st
        ON st.group_id IN (SELECT group_id FROM backend_api.allowed_groups(a.user_id))
    WHERE a.role_code='teacher'
)
SELECT jsonb_build_object(
    'kind','result','student_id',s.student_id,'student',deanery.fn_full_name(p),
    'group_id',s.group_id,'group_name',g.name,'status_id',s.status_id,
    'discipline_id',dis.discipline_id,'discipline',dis.name,'semester',lr.semester,
    'control_type',ct.name,'points',lr.points,'is_graded',ct.is_graded,
    'mark',deanery.fn_mark(lr.points),'exam_date',lr.exam_date,
    'result',deanery.fn_result_name(lr.points,lr.is_absent,ct.is_graded,TRUE)
) FROM deanery.v_last_result lr
JOIN deanery.curriculum_item ci ON ci.item_id=lr.item_id
JOIN deanery.discipline dis ON dis.discipline_id=lr.discipline_id
JOIN deanery.control_type ct ON ct.control_type_id=ci.control_type_id
JOIN deanery.student s ON s.student_id=lr.student_id
JOIN deanery.person p ON p.person_id=s.person_id
JOIN deanery.study_group g ON g.group_id=s.group_id
JOIN allowed scope ON scope.student_id=s.student_id
WHERE lr.stage='final'
  AND (p_group_id IS NULL OR s.group_id=p_group_id)
  AND (p_discipline_id IS NULL OR dis.discipline_id=p_discipline_id)
  AND (p_semester IS NULL OR lr.semester=p_semester)
  AND (p_status_id IS NULL OR s.status_id=p_status_id)
UNION ALL
SELECT jsonb_build_object(
    'kind','debt','student_id',s.student_id,'student',d.student,
    'group_id',s.group_id,'group_name',d.group_name,'status_id',s.status_id,
    'discipline_id',dis.discipline_id,'discipline',d.discipline,'semester',d.semester,
    'control_type',d.control_type,'attempts',d.attempts,'result',d.last_result
) FROM deanery.v_debtors d
JOIN deanery.student s ON s.student_id=d.student_id
JOIN deanery.discipline dis ON dis.name=d.discipline
JOIN allowed scope ON scope.student_id=s.student_id
WHERE (p_group_id IS NULL OR s.group_id=p_group_id)
  AND (p_discipline_id IS NULL OR dis.discipline_id=p_discipline_id)
  AND (p_semester IS NULL OR d.semester=p_semester)
  AND (p_status_id IS NULL OR s.status_id=p_status_id)
$$;
REVOKE ALL ON FUNCTION agent_backend.olap_facts_for_actor(INT,INT,INT,INT,INT) FROM PUBLIC;
