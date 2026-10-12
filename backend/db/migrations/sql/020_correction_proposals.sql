CREATE OR REPLACE FUNCTION agent_backend.correction_validity(p agent_backend.proposal) RETURNS TEXT
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,deanery AS $$
DECLARE gc grade_correction; g RECORD;
BEGIN
    SELECT * INTO gc FROM grade_correction WHERE correction_id=p.correction_id;
    IF NOT FOUND OR gc.status<>'pending' OR gc.requested_by_id<>p.initiator_user_id THEN RETURN 'stale'; END IF;
    SELECT gr.points,gr.is_absent,gr.student_id,gs.* INTO g FROM grade gr JOIN grade_sheet gs USING(sheet_id) WHERE gr.grade_id=gc.grade_id;
    IF NOT FOUND OR g.status<>'closed' OR (g.points,g.is_absent) IS DISTINCT FROM (gc.old_points,gc.old_is_absent)
        OR EXISTS(SELECT 1 FROM grade g2 JOIN grade_sheet gs2 USING(sheet_id) WHERE g2.student_id=g.student_id
            AND gs2.item_id=g.item_id AND gs2.stage=g.stage AND gs2.status<>'cancelled'
            AND (COALESCE(gs2.exam_date,DATE 'infinity'),gs2.sheet_id)>(g.exam_date,g.sheet_id)) THEN RETURN 'stale'; END IF;
    RETURN 'current';
END $$;

CREATE OR REPLACE FUNCTION backend_api.submit_proposal(p_id UUID,p_version INT,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); p agent_backend.proposal; saved agent_backend.idempotency_record;
    v_route TEXT:='/proposal/'||p_id::TEXT||'/submit'; v_hash BYTEA; v_correction INT; v_valid TEXT;
BEGIN
    IF p_key IS NULL OR p_version IS NULL OR p_version<1 THEN RAISE EXCEPTION 'Invalid submission' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock(9174,1);
    SELECT * INTO p FROM agent_backend.proposal WHERE id=p_id FOR UPDATE;
    IF NOT FOUND OR p.initiator_user_id<>v_user THEN RAISE EXCEPTION 'Proposal missing' USING ERRCODE='P6006'; END IF;
    IF p.kind<>'grade_correction' THEN RAISE EXCEPTION 'Submission not supported' USING ERRCODE='22023'; END IF;
    v_hash:=sha256(convert_to(jsonb_build_array(p_version)::TEXT,'UTF8'));
    SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=v_user AND route=v_route AND key=p_key;
    IF FOUND THEN
        IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='P6001'; END IF;
        RETURN agent_backend.proposal_view(p,v_user);
    END IF;
    IF p.submission_status='submitted' THEN RETURN agent_backend.proposal_view(p,v_user); END IF;
    IF p.status<>'pending' OR p.version<>p_version THEN RAISE EXCEPTION 'Proposal changed' USING ERRCODE='P6005'; END IF;
    PERFORM backend_api.command_lock(p.command);
    v_valid:=agent_backend.proposal_validity(p);
    IF v_valid='expired' THEN RAISE EXCEPTION 'Proposal expired' USING ERRCODE='P6002'; END IF;
    IF v_valid<>'current' THEN RAISE EXCEPTION 'Proposal stale' USING ERRCODE='P6003'; END IF;
    IF NOT EXISTS(SELECT 1 FROM app_user u WHERE u.user_id<>p.initiator_user_id
        AND backend_api.special_authorized(p.command,u.user_id,'execute')) THEN
        RAISE EXCEPTION 'No correction manager' USING ERRCODE='42501'; END IF;
    v_correction:=backend_api.request_correction_as(p.command,v_user,p.agent_request_id);
    SET CONSTRAINTS ALL IMMEDIATE;
    UPDATE agent_backend.proposal SET submission_status='submitted',correction_id=v_correction,assignee_user_id=NULL,
        version=version+1 WHERE id=p_id RETURNING * INTO p;
    INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,reason,data)
        VALUES(p_id,v_user,'submitted',p.reason,jsonb_build_object('correction_id',v_correction,'version',p.version));
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash,response_status,response_body)
        VALUES(v_user,v_route,p_key,v_hash,200,jsonb_build_object('id',p_id));
    RETURN agent_backend.proposal_view(p,v_user);
END $$;

CREATE OR REPLACE FUNCTION agent_backend.guard_proposal_command() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF ROW(NEW.id,NEW.initiator_user_id,NEW.run_id,NEW.agent_request_id,NEW.kind,NEW.command,NEW.preview,NEW.snapshot,
           NEW.snapshot_hash,NEW.explanation,NEW.reason,NEW.expires_at,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.initiator_user_id,OLD.run_id,OLD.agent_request_id,OLD.kind,OLD.command,OLD.preview,OLD.snapshot,
           OLD.snapshot_hash,OLD.explanation,OLD.reason,OLD.expires_at,OLD.created_at)
       OR (OLD.submission_status='submitted' AND (NEW.submission_status,NEW.correction_id)
           IS DISTINCT FROM (OLD.submission_status,OLD.correction_id)) THEN
        RAISE EXCEPTION 'Saved proposal is immutable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION agent_backend.correction_validity(agent_backend.proposal),backend_api.submit_proposal(UUID,INT,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.submit_proposal(UUID,INT,UUID,TEXT) TO backend_api;
