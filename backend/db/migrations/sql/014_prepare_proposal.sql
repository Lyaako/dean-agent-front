CREATE OR REPLACE FUNCTION agent_backend.prepare_proposal_as(p_run UUID,p_command JSONB,p_explanation TEXT,p_reason TEXT,
    p_key UUID,p_author INT,p_supersedes UUID DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=p_author; r agent_backend.agent_run;
    p agent_backend.proposal; old agent_backend.proposal; v_data JSONB; v_hash BYTEA;
    saved agent_backend.idempotency_record; v_route TEXT:='/proposal/prepare/'||p_run::TEXT;
BEGIN
    IF p_key IS NULL OR length(btrim(p_explanation)) NOT BETWEEN 1 AND 4000
       OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 OR p_explanation IS NULL OR p_reason IS NULL THEN
        RAISE EXCEPTION 'Invalid preparation' USING ERRCODE='22023'; END IF;
    SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run FOR UPDATE;
    IF NOT FOUND OR r.initiator_user_id<>v_user OR r.status<>'running' OR r.finished_at IS NOT NULL OR r.stop_requested_at IS NOT NULL
       OR r.session_id IS NULL OR r.agent_request_id IS NULL
       OR NOT EXISTS(SELECT 1 FROM agent_backend.chat_session s WHERE s.id=r.session_id AND s.user_id=v_user)
       OR NOT EXISTS(SELECT 1 FROM deanery.agent_request q WHERE q.agent_request_id=r.agent_request_id AND q.user_id=v_user)
       THEN RAISE EXCEPTION 'Run unavailable' USING ERRCODE='42501'; END IF;
    v_hash:=sha256(convert_to(jsonb_build_array(p_command,p_explanation,p_reason,p_supersedes)::TEXT,'UTF8'));
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash,run_id,session_id)
        VALUES(v_user,v_route,p_key,v_hash,p_run,r.session_id) ON CONFLICT DO NOTHING;
    SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=v_user AND route=v_route AND key=p_key FOR UPDATE;
    IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='P6001'; END IF;
    IF saved.response_body IS NOT NULL THEN
        SELECT * INTO p FROM agent_backend.proposal WHERE id=(saved.response_body->>'id')::UUID;
        IF NOT FOUND OR NOT backend_api.command_authorized(p.command,v_user,'prepare') THEN
            RAISE EXCEPTION 'Preparation forbidden' USING ERRCODE='42501'; END IF;
        RETURN agent_backend.proposal_view(p,v_user);
    END IF;
    PERFORM pg_advisory_xact_lock(9174,1);
    IF p_supersedes IS NOT NULL THEN
        SELECT * INTO old FROM agent_backend.proposal WHERE id=p_supersedes FOR UPDATE;
        IF NOT FOUND OR old.initiator_user_id<>v_user OR old.status<>'pending' OR old.submission_status='submitted' THEN
            RAISE EXCEPTION 'Replacement conflict' USING ERRCODE='40001'; END IF;
    END IF;
    v_data:=backend_api.command_preview(p_command,v_user,r.agent_request_id);
    p.id:=gen_random_uuid(); p.kind:=v_data->'command'->>'kind'; p.command:=v_data->'command';
    p.initiator_user_id:=v_user; p.institute_id:=(v_data->>'institute_id')::INT;
    IF p.kind='grade_correction' THEN
        p.submission_status:='draft';
        IF NOT EXISTS(SELECT 1 FROM deanery.app_user u WHERE u.user_id<>v_user
            AND backend_api.special_authorized(p.command,u.user_id,'execute')) THEN
            RAISE EXCEPTION 'No eligible correction manager' USING ERRCODE='42501'; END IF;
    ELSIF agent_backend.proposal_eligible(p,v_user) AND backend_api.command_authorized(p.command,v_user,'execute') THEN
        p.assignee_user_id:=v_user;
    ELSIF NOT EXISTS(SELECT 1 FROM deanery.app_user u WHERE agent_backend.proposal_eligible(p,u.user_id)
                     AND backend_api.command_authorized(p.command,u.user_id,'execute')) THEN
        RAISE EXCEPTION 'No eligible approver' USING ERRCODE='42501';
    END IF;
    IF p_supersedes IS NOT NULL THEN
        UPDATE agent_backend.proposal SET validity='superseded',version=version+1 WHERE id=old.id;
        INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,data)
            VALUES(old.id,v_user,'superseded',jsonb_build_object('replacement_id',p.id));
    END IF;
    INSERT INTO agent_backend.proposal(id,initiator_user_id,run_id,agent_request_id,kind,command,preview,snapshot,
        snapshot_hash,explanation,reason,expires_at,institute_id,assignee_user_id,effective_date,submission_status)
    VALUES(p.id,v_user,p_run,r.agent_request_id,p.kind,p.command,v_data->'preview',v_data->'snapshot',
        v_data->>'snapshot_hash',btrim(p_explanation),btrim(p_reason),now()+INTERVAL '24 hours',p.institute_id,
        p.assignee_user_id,(v_data->>'effective_date')::DATE,p.submission_status) RETURNING * INTO p;
    INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,reason,data)
        VALUES(p.id,v_user,'created',p.reason,jsonb_build_object('assignee_user_id',p.assignee_user_id));
    UPDATE agent_backend.idempotency_record SET response_status=200,response_body=jsonb_build_object('id',p.id)
        WHERE user_id=v_user AND route=v_route AND key=p_key;
    RETURN agent_backend.proposal_view(p,v_user);
END $$;

CREATE OR REPLACE FUNCTION backend_api.prepare_proposal(p_run UUID,p_command JSONB,p_explanation TEXT,p_reason TEXT,
    p_key UUID,p_token TEXT,p_supersedes UUID DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
BEGIN
    RETURN agent_backend.prepare_proposal_as(p_run,p_command,p_explanation,p_reason,p_key,
        agent_backend.proposal_actor(p_token),p_supersedes);
END $$;
REVOKE ALL ON FUNCTION agent_backend.prepare_proposal_as(UUID,JSONB,TEXT,TEXT,UUID,INT,UUID),
    backend_api.prepare_proposal(UUID,JSONB,TEXT,TEXT,UUID,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.prepare_proposal(UUID,JSONB,TEXT,TEXT,UUID,TEXT,UUID) TO backend_executor;
