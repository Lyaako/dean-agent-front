CREATE TABLE agent_backend.account_security (
    user_id INT PRIMARY KEY REFERENCES deanery.app_user ON DELETE CASCADE,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE FUNCTION backend_api.password_required(p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT COALESCE((SELECT must_change_password FROM agent_backend.account_security WHERE user_id=p_user),FALSE)
$$;

CREATE FUNCTION backend_api.own_password_hash(p_token TEXT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT password_hash::TEXT FROM deanery.app_user WHERE user_id=agent_backend.proposal_actor(p_token)
$$;

CREATE FUNCTION backend_api.reset_password(p_token TEXT,p_user INT,p_key UUID,p_hash TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor INT:=agent_backend.proposal_actor(p_token); v_route TEXT:='/admin/users/'||p_user||'/reset-password';
BEGIN
    IF NOT EXISTS(SELECT FROM backend_api.account_snapshot(actor) WHERE role_code='admin') THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    IF p_key IS NULL OR p_hash NOT LIKE '$argon2%' THEN RAISE EXCEPTION 'Invalid reset' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock(9231,p_user);
    IF EXISTS(SELECT FROM agent_backend.idempotency_record WHERE user_id=actor AND agent_backend.idempotency_record.route=v_route AND key=p_key) THEN RETURN FALSE; END IF;
    UPDATE deanery.app_user SET password_hash=p_hash WHERE user_id=p_user;
    IF NOT FOUND THEN RAISE EXCEPTION 'User missing' USING ERRCODE='P0002'; END IF;
    INSERT INTO agent_backend.account_security(user_id,must_change_password) VALUES(p_user,TRUE)
        ON CONFLICT(user_id) DO UPDATE SET must_change_password=TRUE;
    UPDATE agent_backend.auth_session SET revoked_at=now() WHERE user_id=p_user AND revoked_at IS NULL;
    UPDATE agent_backend.auth_token SET revoked_at=now() WHERE session_id IN
        (SELECT id FROM agent_backend.auth_session WHERE user_id=p_user) AND revoked_at IS NULL;
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash,response_status,response_body)
        VALUES(actor,v_route,p_key,sha256(convert_to(p_user::TEXT,'UTF8')),200,jsonb_build_object('user_id',p_user,'password_issued',TRUE));
    RETURN TRUE;
END $$;

CREATE FUNCTION backend_api.change_password(p_token TEXT,p_hash TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor INT:=agent_backend.proposal_actor(p_token); current_session UUID;
BEGIN
    IF p_hash NOT LIKE '$argon2%' THEN RAISE EXCEPTION 'Invalid password' USING ERRCODE='22023'; END IF;
    SELECT session_id INTO current_session FROM agent_backend.auth_token WHERE token_hash=sha256(convert_to(p_token,'UTF8'));
    PERFORM pg_advisory_xact_lock(9231,actor);
    UPDATE deanery.app_user SET password_hash=p_hash WHERE user_id=actor;
    INSERT INTO agent_backend.account_security(user_id,must_change_password) VALUES(actor,FALSE)
        ON CONFLICT(user_id) DO UPDATE SET must_change_password=FALSE;
    UPDATE agent_backend.auth_session SET revoked_at=now() WHERE user_id=actor AND id<>current_session AND revoked_at IS NULL;
    UPDATE agent_backend.auth_token SET revoked_at=now() WHERE session_id IN
        (SELECT id FROM agent_backend.auth_session WHERE user_id=actor AND id<>current_session) AND revoked_at IS NULL;
END $$;

CREATE FUNCTION backend_api.logout_all(p_token TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor INT:=agent_backend.proposal_actor(p_token);
BEGIN
    UPDATE agent_backend.auth_session SET revoked_at=now() WHERE user_id=actor AND revoked_at IS NULL;
    UPDATE agent_backend.auth_token SET revoked_at=now() WHERE session_id IN
        (SELECT id FROM agent_backend.auth_session WHERE user_id=actor) AND revoked_at IS NULL;
END $$;

CREATE FUNCTION backend_api.own_profile(p_token TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT jsonb_build_object('phone',p.phone,'email',p.email,'role',a.role_code) ||
        CASE WHEN a.role_code='student' THEN
            (SELECT jsonb_build_object('record_book_number',s.record_book_number,'group',g.name,
                'course',fn_course(c.start_year),'funding',f.name,'status',st.name)
             FROM student s JOIN study_group g USING(group_id) JOIN curriculum c USING(curriculum_id)
             JOIN funding_type f USING(funding_type_id) JOIN student_status st USING(status_id) WHERE s.student_id=a.student_id)
        ELSE COALESCE((SELECT jsonb_build_object('personnel_number',e.personnel_number,'position',pos.title,
            'employment_rate',e.employment_rate,'hire_date',e.hire_date,'unit',COALESCE(
                (SELECT d.name FROM teacher t JOIN department d USING(department_id) WHERE t.employee_id=e.employee_id),
                (SELECT i.name FROM dean_office_staff d JOIN institute i USING(institute_id) WHERE d.employee_id=e.employee_id),
                (SELECT i.name FROM institute i WHERE i.director_id=e.employee_id)))
            FROM employee e JOIN position pos USING(position_id) WHERE e.person_id=a.person_id),'{}'::JSONB) END
    FROM backend_api.account_snapshot(agent_backend.proposal_actor(p_token)) a JOIN person p USING(person_id)
$$;

CREATE FUNCTION backend_api.accounts(p_token TEXT) RETURNS SETOF JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
BEGIN
    IF NOT EXISTS(SELECT FROM backend_api.account_snapshot(agent_backend.proposal_actor(p_token)) WHERE role_code='admin') THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    RETURN QUERY SELECT jsonb_build_object('user_id',u.user_id,'login',u.login,'person',fn_full_name(p),
        'role',r.code,'is_active',u.is_active,'last_login_at',u.last_login_at)
        FROM app_user u JOIN app_role r USING(role_id) JOIN person p USING(person_id) ORDER BY u.user_id;
END $$;

REVOKE ALL ON FUNCTION backend_api.password_required(INT),backend_api.own_password_hash(TEXT),
    backend_api.reset_password(TEXT,INT,UUID,TEXT),backend_api.change_password(TEXT,TEXT),
    backend_api.logout_all(TEXT),backend_api.own_profile(TEXT),backend_api.accounts(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.password_required(INT),backend_api.own_password_hash(TEXT),
    backend_api.reset_password(TEXT,INT,UUID,TEXT),backend_api.change_password(TEXT,TEXT),
    backend_api.logout_all(TEXT),backend_api.own_profile(TEXT),backend_api.accounts(TEXT) TO backend_api;
