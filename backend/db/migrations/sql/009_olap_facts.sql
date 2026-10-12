CREATE OR REPLACE FUNCTION agent_backend.olap_facts_for_actor(p_user_id INT, p_group_id INT DEFAULT NULL,
                                       p_discipline_id INT DEFAULT NULL, p_semester INT DEFAULT NULL,
                                       p_status_id INT DEFAULT NULL) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, deanery AS $$
WITH actor AS MATERIALIZED (
    SELECT * FROM backend_api.account_snapshot(p_user_id) WHERE is_active
), allowed AS MATERIALIZED (
    SELECT s.student_id FROM actor a CROSS JOIN LATERAL backend_api.allowed_students(a.user_id) s
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
CROSS JOIN actor a
WHERE lr.stage='final'
  AND (a.role_code<>'teacher' OR EXISTS (
      SELECT 1 FROM deanery.teaching_assignment ta
      JOIN deanery.curriculum_item ti ON ti.item_id=ta.item_id
      WHERE ta.teacher_id=a.teacher_id AND ta.group_id=s.group_id
        AND ti.discipline_id=lr.discipline_id AND ti.semester=lr.semester))
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
CROSS JOIN actor a
WHERE (a.role_code<>'teacher' OR EXISTS (
      SELECT 1 FROM deanery.teaching_assignment ta
      JOIN deanery.curriculum_item ti ON ti.item_id=ta.item_id
      WHERE ta.teacher_id=a.teacher_id AND ta.group_id=s.group_id
        AND ti.discipline_id=dis.discipline_id AND ti.semester=d.semester))
  AND (p_group_id IS NULL OR s.group_id=p_group_id)
  AND (p_discipline_id IS NULL OR dis.discipline_id=p_discipline_id)
  AND (p_semester IS NULL OR d.semester=p_semester)
  AND (p_status_id IS NULL OR s.status_id=p_status_id)
$$;

CREATE OR REPLACE FUNCTION backend_api.olap_facts(p_access_token TEXT, p_group_id INT DEFAULT NULL,
    p_discipline_id INT DEFAULT NULL, p_semester INT DEFAULT NULL, p_status_id INT DEFAULT NULL) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
WITH actor AS (
    SELECT snap.*
    FROM agent_backend.auth_token tok
    JOIN agent_backend.auth_session sess ON sess.id=tok.session_id
    CROSS JOIN LATERAL backend_api.account_snapshot(sess.user_id) snap
    WHERE tok.token_hash=sha256(convert_to(p_access_token,'UTF8'))
      AND tok.kind='access' AND tok.expires_at>now() AND tok.revoked_at IS NULL
      AND sess.expires_at>now() AND sess.revoked_at IS NULL AND snap.is_active
)
SELECT f.* FROM actor a CROSS JOIN LATERAL agent_backend.olap_facts_for_actor(
    a.user_id,p_group_id,p_discipline_id,p_semester,p_status_id) f
$$;
REVOKE ALL ON FUNCTION agent_backend.olap_facts_for_actor(INT,INT,INT,INT,INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION backend_api.olap_facts(TEXT,INT,INT,INT,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.olap_facts(TEXT,INT,INT,INT,INT) TO backend_api;
