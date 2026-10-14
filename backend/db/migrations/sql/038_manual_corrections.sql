-- Audit-request creation is service metadata; the correction itself uses native caller rights.
CREATE FUNCTION backend_api.manual_request(p_token TEXT,p_text TEXT) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE uid INT:=agent_backend.proposal_actor(p_token); result INT;
BEGIN
    INSERT INTO agent_request(user_id,request_text) VALUES(uid,p_text) RETURNING agent_request_id INTO result;
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION backend_api.manual_request(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.manual_request(TEXT,TEXT) TO backend_api;

CREATE FUNCTION backend_api.create_correction(p_sheet INT,p_student INT,p_points INT,p_absent BOOLEAN,
    p_reason TEXT,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,deanery AS $$
DECLARE uid INT:=agent_backend.proposal_actor(p_token); a RECORD; sheet TEXT; book TEXT; c JSONB;
    saved agent_backend.idempotency_record; hash BYTEA; cid INT; rid INT; p agent_backend.proposal; before JSONB;
BEGIN
    PERFORM pg_advisory_xact_lock(9174,1);
    SELECT * INTO a FROM backend_api.account_snapshot(uid);
    IF a.role_code NOT IN ('admin','director','dean_staff','teacher') THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    SELECT gs.sheet_number,s.record_book_number INTO sheet,book FROM grade gr JOIN grade_sheet gs USING(sheet_id)
        JOIN student s USING(student_id) WHERE gs.sheet_id=p_sheet AND s.student_id=p_student;
    IF sheet IS NULL THEN RAISE EXCEPTION 'Grade missing' USING ERRCODE='P0002'; END IF;
    c:=jsonb_build_object('version',1,'kind','grade_correction','fields',jsonb_build_object(
        'sheet_number',sheet,'record_book',book,'new_points',p_points,'new_is_absent',p_absent,'reason',p_reason));
    IF NOT backend_api.special_authorized(c,uid,'prepare') THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    hash:=sha256(convert_to(jsonb_build_array(p_sheet,p_student,p_points,p_absent,p_reason)::TEXT,'UTF8'));
    SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=uid AND route='/grade-corrections' AND key=p_key;
    IF FOUND THEN
        IF saved.request_hash<>hash THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='P6001'; END IF;
        SELECT * INTO p FROM agent_backend.proposal WHERE id=(saved.response_body->>'id')::UUID;
        RETURN agent_backend.proposal_view(p,uid);
    END IF;
    IF NOT EXISTS(SELECT FROM app_user u WHERE u.user_id<>uid AND backend_api.special_authorized(c,u.user_id,'execute')) THEN
        RAISE EXCEPTION 'Нет другого директора или заместителя, который может рассмотреть коррекцию' USING ERRCODE='P6120'; END IF;
    rid:=backend_api.manual_request(p_token,'Запрос коррекции оценки через форму');
    PERFORM set_config('app.agent_request_id',rid::TEXT,TRUE);
    cid:=fn_request_grade_correction(sheet,book,p_points,p_absent,p_reason);
    before:=backend_api.special_row(c);
    INSERT INTO agent_backend.proposal(initiator_user_id,agent_request_id,kind,command,preview,snapshot,snapshot_hash,
        explanation,reason,expires_at,institute_id,submission_status,correction_id)
    VALUES(uid,rid,'grade_correction',c,jsonb_build_object('operation','UPDATE','table','grade','affected_rows',1,
        'before',before,'after',before||jsonb_build_object('points',p_points,'is_absent',p_absent),
        'changed_columns',jsonb_build_array('points','is_absent'),'related_effects',jsonb_build_array('Заявка на коррекцию'),
        'effects','[]'::JSONB,'applied',NULL),backend_api.command_snapshot(c,uid),'',
        'Исправление оценки в закрытой ведомости',p_reason,now()+INTERVAL '24 hours',backend_api.special_institute(c),'submitted',cid)
    RETURNING * INTO p;
    INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,reason,data)
        VALUES(p.id,uid,'submitted',p_reason,jsonb_build_object('correction_id',cid));
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash,response_status,response_body)
        VALUES(uid,'/grade-corrections',p_key,hash,200,jsonb_build_object('id',p.id));
    RETURN agent_backend.proposal_view(p,uid);
END $$;
REVOKE ALL ON FUNCTION backend_api.create_correction(INT,INT,INT,BOOLEAN,TEXT,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.create_correction(INT,INT,INT,BOOLEAN,TEXT,UUID,TEXT) TO backend_api;

-- Teacher confirmation concerns only their own grades and attendance.
ALTER FUNCTION backend_api.root_change_authorized(JSONB,INT,TEXT,INT) RENAME TO root_change_authorized_v1;
CREATE FUNCTION backend_api.root_change_authorized(c JSONB,p_user INT,p_mode TEXT,p_stored_institute INT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; r JSONB; resource TEXT:=c->>'resource';
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(p_user) WHERE is_active;
    IF a.role_code='teacher' AND resource IN ('grade','attendance') AND p_mode IN ('prepare','execute') THEN
        r:=backend_api.command_row(c);
        IF r IS NULL OR c->>'operation' NOT IN ('create','update') THEN RETURN FALSE; END IF;
        IF resource='grade' AND NOT EXISTS(SELECT FROM grade_sheet WHERE sheet_id=(r->>'sheet_id')::INT
            AND status='open' AND examiner_id=a.teacher_id) THEN RETURN FALSE; END IF;
        RETURN backend_api.record_in_scope(resource,r,p_user,a.role_code) AND
            backend_api.record_in_scope(resource,r||(c->'fields'),p_user,a.role_code);
    END IF;
    RETURN backend_api.root_change_authorized_v1(c,p_user,p_mode,p_stored_institute);
END $$;
REVOKE ALL ON FUNCTION backend_api.root_change_authorized(JSONB,INT,TEXT,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.root_change_authorized(JSONB,INT,TEXT,INT) TO backend_api,backend_executor;

ALTER FUNCTION agent_backend.proposal_eligible(agent_backend.proposal,INT) RENAME TO proposal_eligible_v1;
CREATE FUNCTION agent_backend.proposal_eligible(p agent_backend.proposal,p_user INT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,deanery AS $$
BEGIN
    IF p.command->>'resource' IN ('grade','attendance') AND p.kind='sql_change' AND EXISTS(
        SELECT FROM backend_api.account_snapshot(p.initiator_user_id) WHERE role_code='teacher') THEN
        RETURN p_user=p.initiator_user_id AND backend_api.command_authorized(p.command,p_user,'execute',p.institute_id);
    END IF;
    RETURN agent_backend.proposal_eligible_v1(p,p_user);
END $$;
REVOKE ALL ON FUNCTION agent_backend.proposal_eligible(agent_backend.proposal,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_backend.proposal_eligible(agent_backend.proposal,INT) TO backend_api,backend_executor;

ALTER FUNCTION backend_api.command_normalize(JSONB,INT) RENAME TO command_normalize_v1;
CREATE FUNCTION backend_api.command_normalize(c JSONB,p_author INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF c->>'kind'='record_change' AND c->>'resource' IN ('grade','attendance') THEN c:=jsonb_set(c,'{kind}','"sql_change"'); END IF;
    RETURN backend_api.command_normalize_v1(c,p_author);
END $$;
REVOKE ALL ON FUNCTION backend_api.command_normalize(JSONB,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.command_normalize(JSONB,INT) TO backend_api,backend_executor;
