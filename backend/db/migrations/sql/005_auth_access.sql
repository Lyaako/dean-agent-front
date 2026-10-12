GRANT USAGE ON SCHEMA agent_backend TO backend_api;
GRANT SELECT, INSERT, UPDATE ON agent_backend.auth_session, agent_backend.auth_token TO backend_api;

CREATE FUNCTION backend_api.login_account(p_login TEXT)
RETURNS TABLE (user_id INT, password_hash TEXT, is_active BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT u.user_id, u.password_hash::TEXT, u.is_active
    FROM deanery.app_user u WHERE lower(u.login) = lower(p_login)
$$;

CREATE FUNCTION backend_api.account_snapshot(p_user_id INT)
RETURNS TABLE (
    user_id INT, login TEXT, role_code TEXT, person_id INT, is_active BOOLEAN,
    institute_ids INT[], student_id INT, teacher_id INT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT u.user_id, u.login::TEXT, r.code::TEXT, u.person_id, u.is_active,
        CASE r.code
          WHEN 'admin' THEN ARRAY(SELECT i.institute_id FROM deanery.institute i ORDER BY i.institute_id)
          WHEN 'director' THEN ARRAY(
            SELECT i.institute_id FROM deanery.institute i
            JOIN deanery.employee e ON e.person_id = u.person_id AND e.dismissal_date IS NULL
            WHERE deanery.fn_manages_institute(e.employee_id, i.institute_id)
            ORDER BY i.institute_id)
          WHEN 'dean_staff' THEN ARRAY(
            SELECT d.institute_id FROM deanery.dean_office_staff d
            JOIN deanery.employee e ON e.employee_id = d.employee_id
            WHERE e.person_id = u.person_id AND e.dismissal_date IS NULL
            ORDER BY d.institute_id)
          WHEN 'teacher' THEN ARRAY(
            SELECT DISTINCT d.institute_id FROM deanery.teacher t
            JOIN deanery.employee e ON e.employee_id = t.employee_id
            JOIN deanery.department d ON d.department_id = t.department_id
            WHERE e.person_id = u.person_id AND e.dismissal_date IS NULL
            ORDER BY d.institute_id)
          WHEN 'student' THEN ARRAY(
            SELECT DISTINCT d.institute_id FROM deanery.student s
            JOIN deanery.study_group g ON g.group_id = s.group_id
            JOIN deanery.curriculum c ON c.curriculum_id = g.curriculum_id
            JOIN deanery.study_program p ON p.program_id = c.program_id
            JOIN deanery.department d ON d.department_id = p.department_id
            WHERE s.person_id = u.person_id ORDER BY d.institute_id)
          ELSE ARRAY[]::INT[]
        END,
        (SELECT s.student_id FROM deanery.student s WHERE s.person_id = u.person_id),
        (SELECT t.employee_id FROM deanery.teacher t
         JOIN deanery.employee e ON e.employee_id = t.employee_id
         WHERE e.person_id = u.person_id AND e.dismissal_date IS NULL)
    FROM deanery.app_user u JOIN deanery.app_role r ON r.role_id = u.role_id
    WHERE u.user_id = p_user_id
$$;

CREATE FUNCTION backend_api.mark_login(p_user_id INT) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
    UPDATE deanery.app_user SET last_login_at = CURRENT_TIMESTAMP
    WHERE user_id = p_user_id AND is_active
$$;

REVOKE ALL ON FUNCTION backend_api.login_account(TEXT), backend_api.account_snapshot(INT), backend_api.mark_login(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.login_account(TEXT), backend_api.account_snapshot(INT), backend_api.mark_login(INT) TO backend_api;
