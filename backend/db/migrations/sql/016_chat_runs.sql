ALTER TABLE agent_backend.agent_run ADD COLUMN auth_session_id UUID REFERENCES agent_backend.auth_session(id),
    ADD COLUMN lease_owner UUID, ADD COLUMN scope_signature TEXT;

CREATE FUNCTION agent_backend.scope_signature(p_user INT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    WITH actor AS (SELECT * FROM backend_api.account_snapshot(p_user))
    SELECT encode(sha256(convert_to((CASE WHEN a.role_code='admin' THEN
        jsonb_build_object('user_id',a.user_id,'role',a.role_code,'active',a.is_active)
    ELSE jsonb_build_array(to_jsonb(a)-'login',
        (SELECT jsonb_agg(jsonb_build_array(g.group_id,g.curriculum_id,c.program_id,p.department_id,d.institute_id) ORDER BY g.group_id)
            FROM backend_api.allowed_groups(p_user) allowed JOIN study_group g USING(group_id)
            JOIN curriculum c USING(curriculum_id) JOIN study_program p USING(program_id) JOIN department d USING(department_id)),
        (SELECT jsonb_agg(jsonb_build_array(s.student_id,s.group_id) ORDER BY s.student_id)
            FROM student s JOIN backend_api.allowed_students(p_user) allowed USING(student_id)),
        (SELECT jsonb_agg(employee_id ORDER BY employee_id) FROM backend_api.allowed_employees(p_user)),
        (SELECT jsonb_agg(jsonb_build_array(c.curriculum_id,c.program_id,p.department_id,d.institute_id) ORDER BY c.curriculum_id)
            FROM curriculum c JOIN study_program p USING(program_id) JOIN department d USING(department_id)
            WHERE (a.role_code IN ('director','dean_staff') AND d.institute_id=ANY(a.institute_ids))
               OR c.curriculum_id IN (SELECT g.curriculum_id FROM study_group g JOIN backend_api.allowed_groups(p_user) allowed USING(group_id))),
        (SELECT jsonb_agg(jsonb_build_array(ci.item_id,ci.curriculum_id,ci.discipline_id,ci.semester) ORDER BY ci.item_id)
            FROM curriculum_item ci JOIN curriculum c USING(curriculum_id) JOIN study_program p USING(program_id) JOIN department d USING(department_id)
            WHERE (a.role_code IN ('director','dean_staff') AND d.institute_id=ANY(a.institute_ids))
               OR (a.role_code='teacher' AND EXISTS(SELECT 1 FROM teaching_assignment ta WHERE ta.item_id=ci.item_id AND ta.teacher_id=a.teacher_id))
               OR (a.role_code='student' AND EXISTS(SELECT 1 FROM student s JOIN study_group g USING(group_id) WHERE s.student_id=a.student_id AND g.curriculum_id=ci.curriculum_id))),
        (SELECT jsonb_agg(jsonb_build_array(w.work_id,w.student_id) ORDER BY w.work_id) FROM academic_work w
            WHERE a.role_code<>'teacher' AND w.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user))),
        (SELECT jsonb_agg(jsonb_build_array(pp.placement_id,pp.student_id) ORDER BY pp.placement_id) FROM practice_placement pp
            WHERE a.role_code<>'teacher' AND pp.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user))),
        (SELECT jsonb_agg(jsonb_build_array(dr.request_id,dr.student_id) ORDER BY dr.request_id) FROM document_request dr
            WHERE a.role_code<>'teacher' AND dr.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user))),
        (SELECT jsonb_agg(jsonb_build_array(gs.sheet_id,gs.group_id,gs.examiner_id) ORDER BY gs.sheet_id)
            FROM grade_sheet gs WHERE (a.role_code='teacher' AND gs.examiner_id=a.teacher_id)
                OR (a.role_code<>'teacher' AND gs.group_id IN (SELECT group_id FROM backend_api.allowed_groups(p_user)))),
        (SELECT jsonb_agg(jsonb_build_array(gr.grade_id,gr.sheet_id,gr.student_id) ORDER BY gr.grade_id)
            FROM grade gr JOIN grade_sheet gs USING(sheet_id) WHERE
                (a.role_code='teacher' AND gs.examiner_id=a.teacher_id) OR
                (a.role_code<>'teacher' AND gr.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user)))),
        (SELECT jsonb_agg(jsonb_build_array(att.attendance_id,att.student_id,att.slot_id,ss.assignment_id) ORDER BY att.attendance_id)
            FROM attendance att JOIN schedule_slot ss USING(slot_id) JOIN teaching_assignment ta USING(assignment_id)
            WHERE att.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user))
                AND (a.role_code<>'teacher' OR ta.teacher_id=a.teacher_id)),
        (SELECT jsonb_agg(jsonb_build_array(gc.correction_id,gc.grade_id) ORDER BY gc.correction_id)
            FROM grade_correction gc JOIN grade gr USING(grade_id) JOIN grade_sheet gs USING(sheet_id) WHERE
                (a.role_code='teacher' AND gs.examiner_id=a.teacher_id) OR
                (a.role_code<>'teacher' AND gr.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user)))),
        CASE WHEN a.role_code<>'teacher' THEN jsonb_build_array(
            (SELECT jsonb_agg(jsonb_build_array(sc.student_id,sc.contact_person_id) ORDER BY sc.student_id,sc.contact_person_id)
                FROM student_contact sc WHERE sc.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user))),
            (SELECT jsonb_agg(jsonb_build_array(os.order_id,os.student_id) ORDER BY os.order_id,os.student_id)
                FROM order_student os WHERE os.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user))),
            (SELECT jsonb_agg(jsonb_build_array(sc.scholarship_id,sc.student_id) ORDER BY sc.scholarship_id)
                FROM scholarship sc WHERE sc.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user))),
            (SELECT jsonb_agg(jsonb_build_array(al.leave_id,al.student_id) ORDER BY al.leave_id)
                FROM academic_leave al WHERE al.student_id IN (SELECT student_id FROM backend_api.allowed_students(p_user)))) END,
        CASE WHEN a.role_code='teacher' THEN jsonb_build_array(
            (SELECT jsonb_agg(jsonb_build_array(assignment_id,item_id,group_id) ORDER BY assignment_id)
                FROM teaching_assignment WHERE teacher_id=a.teacher_id),
            (SELECT jsonb_agg(jsonb_build_array(ss.slot_id,ss.assignment_id) ORDER BY ss.slot_id)
                FROM schedule_slot ss JOIN teaching_assignment ta USING(assignment_id) WHERE ta.teacher_id=a.teacher_id),
            (SELECT jsonb_agg(jsonb_build_array(work_id,student_id,supervisor_id,reviewer_id) ORDER BY work_id)
                FROM academic_work WHERE supervisor_id=a.teacher_id OR reviewer_id=a.teacher_id),
            (SELECT jsonb_agg(jsonb_build_array(placement_id,student_id) ORDER BY placement_id)
                FROM practice_placement WHERE supervisor_id=a.teacher_id)) END
    ) END)::TEXT,'UTF8')),'hex') FROM actor a
$$;

CREATE FUNCTION agent_backend.validate_agent_run(r agent_backend.agent_run,p_worker UUID) RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
BEGIN
    IF r.id IS NULL OR r.finished_at IS NOT NULL OR r.status<>'running' OR r.lease_owner IS DISTINCT FROM p_worker
       OR p_worker IS NULL OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'Lease lost' USING ERRCODE='P8009'; END IF;
    IF r.stop_requested_at IS NOT NULL THEN RAISE EXCEPTION 'Run stopped' USING ERRCODE='P8007'; END IF;
    IF NOT EXISTS(SELECT 1 FROM agent_backend.auth_session s JOIN deanery.app_user u ON u.user_id=s.user_id
        WHERE s.id=r.auth_session_id AND s.user_id=r.initiator_user_id AND s.revoked_at IS NULL
          AND s.expires_at>clock_timestamp() AND u.is_active) THEN RAISE EXCEPTION 'Authorization revoked' USING ERRCODE='42501'; END IF;
    IF r.scope_signature IS DISTINCT FROM agent_backend.scope_signature(r.initiator_user_id) THEN
        RAISE EXCEPTION 'Scope changed' USING ERRCODE='P8008'; END IF;
END $$;

CREATE FUNCTION agent_backend.lock_agent_run(p_run UUID,p_worker UUID) RETURNS agent_backend.agent_run
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run;
BEGIN
    SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run FOR UPDATE;
    PERFORM agent_backend.validate_agent_run(r,p_worker);
    RETURN r;
END $$;

CREATE FUNCTION agent_backend.read_agent_run(p_run UUID,p_worker UUID) RETURNS agent_backend.agent_run
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run;
BEGIN
    SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run;
    PERFORM agent_backend.validate_agent_run(r,p_worker);
    RETURN r;
END $$;

CREATE FUNCTION agent_backend.chat_info(s agent_backend.chat_session) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
    SELECT jsonb_build_object('id',s.id,'sessionId',s.id,'title',s.title,'createdAt',s.created_at,'updatedAt',s.updated_at,
        'activeRunId',(SELECT id FROM agent_backend.agent_run WHERE session_id=s.id AND finished_at IS NULL))
$$;

CREATE FUNCTION backend_api.get_chat(p_id UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); s agent_backend.chat_session;
BEGIN
    SELECT * INTO s FROM agent_backend.chat_session WHERE id=p_id AND user_id=v_user;
    IF NOT FOUND THEN RAISE EXCEPTION 'Chat missing' USING ERRCODE='P8001'; END IF;
    RETURN agent_backend.chat_info(s);
END $$;

CREATE FUNCTION backend_api.list_chats(p_token TEXT,p_limit INT,p_offset INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); v_scope TEXT:=agent_backend.scope_signature(v_user); v_result JSONB;
BEGIN
    IF p_limit IS NULL OR p_offset IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR p_offset<0 THEN
        RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
    SELECT jsonb_build_object('items',COALESCE(jsonb_agg(x.item ORDER BY x.updated_at DESC,x.id),'[]'::JSONB),
        'limit',p_limit,'offset',p_offset,'has_more',(SELECT count(*) FROM agent_backend.chat_session WHERE user_id=v_user)>p_offset::BIGINT+p_limit)
    INTO v_result FROM (SELECT s.id,s.updated_at,jsonb_build_object('id',s.id,'title',s.title,'updatedAt',s.updated_at,
        'preview',COALESCE((SELECT CASE WHEN m.metadata->>'scope_signature'=v_scope THEN left(m.text,120) ELSE '' END
            FROM agent_backend.chat_message m WHERE m.session_id=s.id AND m.role<>'error' ORDER BY m.sequence DESC LIMIT 1),'')) AS item
        FROM agent_backend.chat_session s WHERE s.user_id=v_user ORDER BY s.updated_at DESC,s.id LIMIT p_limit OFFSET p_offset) x;
    RETURN v_result;
END $$;

CREATE FUNCTION backend_api.create_chat(p_title TEXT,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); saved agent_backend.idempotency_record;
    s agent_backend.chat_session; v_hash BYTEA;
BEGIN
    IF p_key IS NULL OR p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 255 THEN
        RAISE EXCEPTION 'Invalid chat' USING ERRCODE='22023'; END IF;
    v_hash:=sha256(convert_to(jsonb_build_object('title',btrim(p_title))::TEXT,'UTF8'));
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash)
        VALUES(v_user,'/agent/sessions',p_key,v_hash) ON CONFLICT DO NOTHING;
    SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=v_user AND route='/agent/sessions' AND key=p_key FOR UPDATE;
    IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Key conflict' USING ERRCODE='P6001'; END IF;
    IF saved.response_removed_at IS NOT NULL THEN RAISE EXCEPTION 'Chat deleted' USING ERRCODE='P8001'; END IF;
    IF saved.session_id IS NOT NULL THEN RETURN backend_api.get_chat(saved.session_id,p_token); END IF;
    INSERT INTO agent_backend.chat_session(user_id,title) VALUES(v_user,btrim(p_title)) RETURNING * INTO s;
    UPDATE agent_backend.idempotency_record SET session_id=s.id,response_status=201,response_body=jsonb_build_object('id',s.id)
        WHERE user_id=v_user AND route='/agent/sessions' AND key=p_key;
    RETURN agent_backend.chat_info(s);
END $$;

CREATE FUNCTION backend_api.rename_chat(p_id UUID,p_title TEXT,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); s agent_backend.chat_session;
BEGIN
    IF p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'Invalid title' USING ERRCODE='22023'; END IF;
    UPDATE agent_backend.chat_session SET title=btrim(p_title),updated_at=clock_timestamp() WHERE id=p_id AND user_id=v_user RETURNING * INTO s;
    IF NOT FOUND THEN RAISE EXCEPTION 'Chat missing' USING ERRCODE='P8001'; END IF;
    RETURN agent_backend.chat_info(s);
END $$;

CREATE FUNCTION backend_api.delete_chat(p_id UUID,p_token TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); s agent_backend.chat_session;
BEGIN
    SELECT * INTO s FROM agent_backend.chat_session WHERE id=p_id AND user_id=v_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Chat missing' USING ERRCODE='P8001'; END IF;
    IF EXISTS(SELECT 1 FROM agent_backend.agent_run WHERE session_id=p_id AND finished_at IS NULL) THEN
        RAISE EXCEPTION 'Stop agent first' USING ERRCODE='P8002'; END IF;
    DELETE FROM agent_backend.chat_session WHERE id=p_id;
END $$;

CREATE FUNCTION agent_backend.run_proposals(p_run UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'preview',preview,'explanation',explanation,'reason',reason)
        ORDER BY created_at,id),'[]'::JSONB) FROM agent_backend.proposal WHERE run_id=p_run
$$;

CREATE FUNCTION backend_api.chat_messages(p_id UUID,p_token TEXT,p_limit INT,p_offset INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); v_scope TEXT:=agent_backend.scope_signature(v_user); v_result JSONB;
BEGIN
    PERFORM backend_api.get_chat(p_id,p_token);
    IF p_limit IS NULL OR p_offset IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR p_offset<0 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
    SELECT jsonb_build_object('items',COALESCE(jsonb_agg(x.item ORDER BY x.sequence),'[]'::JSONB),'limit',p_limit,'offset',p_offset,
        'has_more',(SELECT count(*) FROM agent_backend.chat_message WHERE session_id=p_id)>p_offset::BIGINT+p_limit) INTO v_result
    FROM (SELECT m.sequence,jsonb_build_object('id',m.id,'role',m.role,'at',m.created_at,
        'text',CASE WHEN m.metadata->>'scope_signature'=v_scope THEN m.text ELSE 'Сообщение скрыто: изменились права доступа' END,
        'runId',m.metadata->'run_id','proposals',CASE WHEN m.role IN ('agent','error') AND m.metadata->>'scope_signature'=v_scope
            THEN agent_backend.run_proposals((m.metadata->>'run_id')::UUID) ELSE '[]'::JSONB END,
        'tools',CASE WHEN m.metadata->>'scope_signature'=v_scope THEN COALESCE(r.tools_used,'[]'::JSONB) ELSE '[]'::JSONB END,
        'decisions',CASE WHEN m.metadata->>'scope_signature'=v_scope THEN COALESCE((SELECT jsonb_object_agg(p.id,p.status)
             FROM agent_backend.proposal p WHERE p.run_id=r.id AND p.status<>'pending'),'{}'::JSONB) ELSE '{}'::JSONB END) AS item
        FROM agent_backend.chat_message m LEFT JOIN agent_backend.agent_run r ON r.id=(m.metadata->>'run_id')::UUID
        WHERE m.session_id=p_id ORDER BY m.sequence LIMIT p_limit OFFSET p_offset) x;
    RETURN v_result;
END $$;

CREATE FUNCTION backend_api.start_agent_run(p_session UUID,p_message TEXT,p_attachments JSONB,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); v_auth UUID; v_scope TEXT; v_title TEXT; v_request INT;
    saved agent_backend.idempotency_record; v_hash BYTEA; s agent_backend.chat_session; r agent_backend.agent_run; v_sequence BIGINT;
BEGIN
    IF p_message IS NULL OR length(btrim(p_message))=0 OR length(p_message)>16000 OR p_key IS NULL
       OR jsonb_typeof(p_attachments) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid message' USING ERRCODE='22023'; END IF;
    IF p_attachments<>'[]'::JSONB THEN RAISE EXCEPTION 'Attachments unavailable' USING ERRCODE='P8003'; END IF;
    v_hash:=sha256(convert_to(jsonb_build_array(p_session,p_message,p_attachments)::TEXT,'UTF8'));
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash)
        VALUES(v_user,'/agent/chat/stream',p_key,v_hash) ON CONFLICT DO NOTHING;
    SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=v_user AND route='/agent/chat/stream' AND key=p_key FOR UPDATE;
    IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Key conflict' USING ERRCODE='P6001'; END IF;
    IF saved.response_removed_at IS NOT NULL THEN RAISE EXCEPTION 'Chat deleted' USING ERRCODE='P8001'; END IF;
    IF saved.run_id IS NOT NULL THEN
        SELECT * INTO r FROM agent_backend.agent_run WHERE id=saved.run_id;
        IF r.session_id IS NULL THEN RAISE EXCEPTION 'Chat deleted' USING ERRCODE='P8001'; END IF;
        IF r.scope_signature IS DISTINCT FROM agent_backend.scope_signature(v_user) THEN RAISE EXCEPTION 'Scope changed' USING ERRCODE='P8008'; END IF;
        RETURN jsonb_build_object('run_id',r.id,'session_id',r.session_id);
    END IF;
    IF p_session IS NULL THEN
        v_title:=btrim(regexp_replace(p_message,'\s+',' ','g'));
        IF length(v_title)>60 THEN v_title:=left(v_title,59)||'…'; END IF;
        INSERT INTO agent_backend.chat_session(user_id,title) VALUES(v_user,v_title) RETURNING * INTO s;
    ELSE
        SELECT * INTO s FROM agent_backend.chat_session WHERE id=p_session AND user_id=v_user FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Chat missing' USING ERRCODE='P8001'; END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM agent_backend.agent_run WHERE session_id=s.id AND finished_at IS NULL) THEN
        RAISE EXCEPTION 'Chat busy' USING ERRCODE='P8002'; END IF;
    SELECT session_id INTO v_auth FROM agent_backend.auth_token WHERE token_hash=sha256(convert_to(p_token,'UTF8'));
    v_scope:=agent_backend.scope_signature(v_user);
    INSERT INTO deanery.agent_request(user_id,request_text) VALUES(v_user,p_message) RETURNING agent_request_id INTO v_request;
    INSERT INTO agent_backend.agent_run(session_id,initiator_user_id,agent_request_id,status,auth_session_id,scope_signature)
        VALUES(s.id,v_user,v_request,'queued',v_auth,v_scope) RETURNING * INTO r;
    UPDATE agent_backend.agent_run SET events=jsonb_build_array(jsonb_build_object('sequence',1,'event','session',
        'data',jsonb_build_object('session_id',s.id,'run_id',r.id))) WHERE id=r.id;
    SELECT COALESCE(max(sequence),0)+1 INTO v_sequence FROM agent_backend.chat_message WHERE session_id=s.id;
    INSERT INTO agent_backend.chat_message(session_id,sequence,role,text,metadata) VALUES(s.id,v_sequence,'user',p_message,
        jsonb_build_object('run_id',r.id,'scope_signature',v_scope));
    UPDATE agent_backend.chat_session SET updated_at=clock_timestamp() WHERE id=s.id;
    UPDATE agent_backend.idempotency_record SET run_id=r.id,session_id=s.id,response_status=200,
        response_body=jsonb_build_object('run_id',r.id,'session_id',s.id)
        WHERE user_id=v_user AND route='/agent/chat/stream' AND key=p_key;
    RETURN jsonb_build_object('run_id',r.id,'session_id',s.id);
END $$;

CREATE FUNCTION agent_backend.end_agent_run(p_run UUID,p_answer TEXT,p_error TEXT) RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; v_result JSONB; v_data JSONB; v_text TEXT; v_sequence BIGINT; v_event TEXT;
BEGIN
    SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run FOR UPDATE;
    IF r.finished_at IS NOT NULL THEN RETURN r.result; END IF;
    IF r.session_id IS NULL THEN RAISE EXCEPTION 'Chat missing' USING ERRCODE='P8001'; END IF;
    IF p_error IS NULL THEN v_event:='done'; v_text:=COALESCE(p_answer,'');
    ELSE
        v_event:='error';
        v_text:=CASE p_error WHEN 'agent_cancelled' THEN 'Запуск остановлен. Подготовленные предложения сохранены.'
            WHEN 'agent_scope_changed' THEN 'Права доступа изменились. Отправьте новый запрос.'
            WHEN 'forbidden' THEN 'Доступ отозван. Войдите снова.'
            WHEN 'agent_outcome_unknown' THEN 'Запуск прерван на сервере. Он не будет повторён автоматически.'
            WHEN 'agent_unavailable' THEN 'Модель временно недоступна.' ELSE 'Агент не смог завершить запрос.' END;
    END IF;
    v_result:=jsonb_build_object('run_id',r.id,'session_id',r.session_id,'answer',v_text,
        'proposals',agent_backend.run_proposals(r.id),'tools_used',r.tools_used);
    v_data:=CASE WHEN p_error IS NULL THEN v_result ELSE jsonb_build_object('type',p_error,'message',v_text,
        'run_id',r.id,'session_id',r.session_id,'manifest',jsonb_build_object('proposals',v_result->'proposals','tools_used',r.tools_used)) END;
    UPDATE agent_backend.agent_run SET status=CASE WHEN p_error IS NULL THEN 'succeeded' WHEN p_error='agent_cancelled' THEN 'cancelled' ELSE 'failed' END,
        result=v_result,error_code=p_error,finished_at=clock_timestamp(),lease_until=NULL,
        events=events||jsonb_build_array(jsonb_build_object('sequence',jsonb_array_length(events)+1,'event',v_event,'data',v_data)) WHERE id=r.id;
    UPDATE deanery.agent_request SET response_text=v_text,status=CASE WHEN p_error IS NULL THEN 'success' ELSE 'error' END,
        execution_ms=LEAST(2147483647,GREATEST(0,extract(epoch FROM (clock_timestamp()-r.created_at))*1000))::INT
        WHERE agent_request_id=r.agent_request_id;
    SELECT COALESCE(max(sequence),0)+1 INTO v_sequence FROM agent_backend.chat_message WHERE session_id=r.session_id;
    INSERT INTO agent_backend.chat_message(session_id,sequence,role,text,metadata)
        VALUES(r.session_id,v_sequence,CASE WHEN p_error IS NULL THEN 'agent' ELSE 'error' END,v_text,
            jsonb_build_object('run_id',r.id,'scope_signature',r.scope_signature));
    UPDATE agent_backend.chat_session SET updated_at=clock_timestamp() WHERE id=r.session_id;
    RETURN v_result;
END $$;

CREATE FUNCTION backend_api.claim_agent_run(p_worker UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run;
BEGIN
    IF p_worker IS NULL THEN RAISE EXCEPTION 'Worker required' USING ERRCODE='22023'; END IF;
    FOR r IN SELECT * FROM agent_backend.agent_run WHERE status='running' AND finished_at IS NULL AND lease_until<=clock_timestamp()
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LOOP
        PERFORM agent_backend.end_agent_run(r.id,'','agent_outcome_unknown');
    END LOOP;
    LOOP
        SELECT * INTO r FROM agent_backend.agent_run WHERE status='queued' AND finished_at IS NULL
            ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
        IF NOT FOUND THEN RETURN NULL; END IF;
        UPDATE agent_backend.agent_run SET status='running',lease_owner=p_worker,lease_until=clock_timestamp()+interval '60 seconds'
            WHERE id=r.id RETURNING * INTO r;
        BEGIN
            PERFORM agent_backend.validate_agent_run(r,p_worker);
        EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE 'P8008' OR SQLSTATE 'P8007' THEN
            PERFORM agent_backend.end_agent_run(r.id,'',CASE SQLSTATE WHEN 'P8008' THEN 'agent_scope_changed'
                WHEN 'P8007' THEN 'agent_cancelled' ELSE 'forbidden' END);
            CONTINUE;
        END;
        RETURN jsonb_build_object('run_id',r.id,'session_id',r.session_id);
    END LOOP;
END $$;

CREATE FUNCTION agent_backend.agent_context(r agent_backend.agent_run) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
    SELECT jsonb_build_object('run_id',r.id,'session_id',r.session_id,'initiator_user_id',r.initiator_user_id,
        'agent_request_id',r.agent_request_id,'actor',(SELECT to_jsonb(a) FROM backend_api.account_snapshot(r.initiator_user_id) a),
        'message',(SELECT request_text FROM deanery.agent_request WHERE agent_request_id=r.agent_request_id),
        'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('role',x.role,'text',x.text) ORDER BY x.sequence)
            FROM (SELECT m.role,m.text,m.sequence FROM agent_backend.chat_message m WHERE m.session_id=r.session_id
                AND m.role IN ('user','agent') AND m.metadata->>'run_id'<>r.id::TEXT
                AND m.metadata->>'scope_signature'=r.scope_signature ORDER BY m.sequence DESC LIMIT 20) x),'[]'::JSONB))
$$;

CREATE FUNCTION backend_api.agent_run_context(p_run UUID,p_worker UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
BEGIN RETURN agent_backend.agent_context(agent_backend.lock_agent_run(p_run,p_worker)); END $$;

CREATE FUNCTION backend_api.agent_run_read_context(p_run UUID,p_worker UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
BEGIN RETURN agent_backend.agent_context(agent_backend.read_agent_run(p_run,p_worker)); END $$;

CREATE FUNCTION backend_api.renew_agent_run(p_run UUID,p_worker UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
BEGIN
    PERFORM agent_backend.lock_agent_run(p_run,p_worker);
    UPDATE agent_backend.agent_run SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id=p_run;
    RETURN TRUE;
END $$;

CREATE FUNCTION backend_api.append_agent_event(p_run UUID,p_worker UUID,p_event TEXT,p_data JSONB) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; v_seq BIGINT;
BEGIN
    r:=agent_backend.lock_agent_run(p_run,p_worker);
    IF p_event NOT IN ('status','tool_call','tool_result') OR p_event IS NULL OR jsonb_typeof(p_data) IS DISTINCT FROM 'object'
       OR octet_length(p_data::TEXT)>131072 THEN RAISE EXCEPTION 'Invalid event' USING ERRCODE='22023'; END IF;
    IF p_event='tool_call' AND (length(p_data->>'name') NOT BETWEEN 1 AND 100 OR p_data->>'name' IS NULL) THEN
        RAISE EXCEPTION 'Tool name required' USING ERRCODE='22023'; END IF;
    v_seq:=jsonb_array_length(r.events)+1;
    UPDATE agent_backend.agent_run SET events=events||jsonb_build_array(jsonb_build_object('sequence',v_seq,'event',p_event,'data',p_data)),
        tools_used=CASE WHEN p_event='tool_call' AND NOT tools_used ? (p_data->>'name') THEN tools_used||jsonb_build_array(p_data->>'name') ELSE tools_used END
        WHERE id=p_run;
    RETURN v_seq;
END $$;

CREATE FUNCTION backend_api.prepare_run_proposal(p_run UUID,p_worker UUID,p_command JSONB,p_explanation TEXT,p_reason TEXT,
    p_key UUID,p_supersedes UUID DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run;
BEGIN
    r:=agent_backend.lock_agent_run(p_run,p_worker);
    RETURN agent_backend.prepare_proposal_as(p_run,p_command,p_explanation,p_reason,p_key,r.initiator_user_id,p_supersedes);
END $$;

CREATE FUNCTION backend_api.finish_agent_run(p_run UUID,p_worker UUID,p_answer TEXT,p_error TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; v_error TEXT:=p_error;
BEGIN
    SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run FOR UPDATE;
    IF NOT FOUND OR p_worker IS NULL OR r.lease_owner IS DISTINCT FROM p_worker OR r.session_id IS NULL THEN
        RAISE EXCEPTION 'Lease lost' USING ERRCODE='P8009'; END IF;
    IF r.finished_at IS NOT NULL THEN RETURN r.result; END IF;
    IF v_error IS NOT NULL AND v_error NOT IN ('agent_error','agent_unavailable','agent_protocol_error','agent_outcome_unknown',
        'agent_cancelled','agent_scope_changed','forbidden') THEN v_error:='agent_error'; END IF;
    IF length(p_answer)>64000 THEN v_error:='agent_protocol_error'; END IF;
    BEGIN
        PERFORM agent_backend.validate_agent_run(r,p_worker);
    EXCEPTION WHEN SQLSTATE 'P8009' THEN v_error:='agent_outcome_unknown';
        WHEN SQLSTATE 'P8007' THEN v_error:='agent_cancelled';
        WHEN SQLSTATE 'P8008' THEN v_error:='agent_scope_changed';
        WHEN SQLSTATE '42501' THEN v_error:='forbidden';
    END;
    RETURN agent_backend.end_agent_run(p_run,p_answer,v_error);
END $$;

CREATE FUNCTION backend_api.cancel_agent_run(p_run UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); r agent_backend.agent_run;
BEGIN
    SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run AND initiator_user_id=v_user AND session_id IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Run missing' USING ERRCODE='P8001'; END IF;
    IF r.finished_at IS NOT NULL THEN RETURN jsonb_build_object('run_id',r.id,'stop_requested',FALSE); END IF;
    UPDATE agent_backend.agent_run SET stop_requested_at=COALESCE(stop_requested_at,clock_timestamp()) WHERE id=r.id;
    IF r.status='queued' THEN PERFORM agent_backend.end_agent_run(r.id,'','agent_cancelled'); END IF;
    RETURN jsonb_build_object('run_id',r.id,'stop_requested',TRUE);
END $$;

CREATE FUNCTION backend_api.read_agent_events(p_run UUID,p_token TEXT,p_after BIGINT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); r agent_backend.agent_run;
BEGIN
    IF p_after IS NULL OR p_after<0 THEN RAISE EXCEPTION 'Invalid event cursor' USING ERRCODE='22023'; END IF;
    SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run AND initiator_user_id=v_user AND session_id IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Run missing' USING ERRCODE='P8001'; END IF;
    IF r.scope_signature IS DISTINCT FROM agent_backend.scope_signature(v_user) THEN RAISE EXCEPTION 'Scope changed' USING ERRCODE='P8008'; END IF;
    IF p_after>jsonb_array_length(r.events) THEN RAISE EXCEPTION 'Invalid event cursor' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('events',COALESCE((SELECT jsonb_agg(e ORDER BY (e->>'sequence')::BIGINT)
        FROM jsonb_array_elements(r.events) e WHERE (e->>'sequence')::BIGINT>p_after),'[]'::JSONB),
        'finished',r.finished_at IS NOT NULL,'status',r.status);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA agent_backend FROM PUBLIC;
REVOKE ALL ON FUNCTION backend_api.get_chat(UUID,TEXT),backend_api.list_chats(TEXT,INT,INT),backend_api.create_chat(TEXT,UUID,TEXT),
    backend_api.rename_chat(UUID,TEXT,TEXT),backend_api.delete_chat(UUID,TEXT),backend_api.chat_messages(UUID,TEXT,INT,INT),
    backend_api.start_agent_run(UUID,TEXT,JSONB,UUID,TEXT),backend_api.claim_agent_run(UUID),backend_api.agent_run_context(UUID,UUID),
    backend_api.agent_run_read_context(UUID,UUID),backend_api.renew_agent_run(UUID,UUID),backend_api.append_agent_event(UUID,UUID,TEXT,JSONB),
    backend_api.prepare_run_proposal(UUID,UUID,JSONB,TEXT,TEXT,UUID,UUID),backend_api.finish_agent_run(UUID,UUID,TEXT,TEXT),
    backend_api.cancel_agent_run(UUID,TEXT),backend_api.read_agent_events(UUID,TEXT,BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.get_chat(UUID,TEXT),backend_api.list_chats(TEXT,INT,INT),backend_api.create_chat(TEXT,UUID,TEXT),
    backend_api.rename_chat(UUID,TEXT,TEXT),backend_api.delete_chat(UUID,TEXT),backend_api.chat_messages(UUID,TEXT,INT,INT),
    backend_api.start_agent_run(UUID,TEXT,JSONB,UUID,TEXT),backend_api.cancel_agent_run(UUID,TEXT),backend_api.read_agent_events(UUID,TEXT,BIGINT) TO backend_api;
GRANT EXECUTE ON FUNCTION backend_api.claim_agent_run(UUID),backend_api.agent_run_context(UUID,UUID),backend_api.agent_run_read_context(UUID,UUID),
    backend_api.renew_agent_run(UUID,UUID),backend_api.append_agent_event(UUID,UUID,TEXT,JSONB),
    backend_api.prepare_run_proposal(UUID,UUID,JSONB,TEXT,TEXT,UUID,UUID),backend_api.finish_agent_run(UUID,UUID,TEXT,TEXT) TO backend_executor;
