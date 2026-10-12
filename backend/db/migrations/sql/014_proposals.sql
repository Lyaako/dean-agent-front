CREATE OR REPLACE FUNCTION agent_backend.proposal_actor(p_token TEXT) RETURNS INT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT;
BEGIN
    SELECT s.user_id INTO v_user FROM agent_backend.auth_token t
    JOIN agent_backend.auth_session s ON s.id=t.session_id
    JOIN deanery.app_user u ON u.user_id=s.user_id
    WHERE t.token_hash=sha256(convert_to(p_token,'UTF8')) AND t.kind='access'
      AND t.expires_at>now() AND t.revoked_at IS NULL
      AND s.expires_at>now() AND s.revoked_at IS NULL AND u.is_active;
    IF v_user IS NULL THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    RETURN v_user;
END $$;

CREATE OR REPLACE FUNCTION agent_backend.proposal_eligible(p agent_backend.proposal,p_user INT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,deanery AS $$
BEGIN
    RETURN CASE WHEN p.kind='grade_correction' THEN COALESCE(p.submission_status='submitted'
        AND p.initiator_user_id<>p_user AND backend_api.special_authorized(p.command,p_user,'execute'),FALSE)
    ELSE COALESCE((SELECT a.is_active AND a.role_code IN ('admin','director','dean_staff')
        AND (a.role_code='admin' OR p.institute_id=ANY(a.institute_ids))
        AND p.kind IN ('record_change','workflow','special_command','sql_change')
        AND backend_api.command_authorized(p.command,p_user,'execute',p.institute_id)
        FROM backend_api.account_snapshot(p_user) a),FALSE) END;
END $$;

CREATE OR REPLACE FUNCTION agent_backend.proposal_visible(p agent_backend.proposal,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
    SELECT COALESCE(p.initiator_user_id=p_user OR (p.submission_status IS DISTINCT FROM 'draft' AND agent_backend.proposal_eligible(p,p_user) AND
        (p.assignee_user_id=p_user OR p.decided_by=p_user OR p.assignee_user_id IS NULL OR
         EXISTS(SELECT 1 FROM backend_api.account_snapshot(p_user) a WHERE a.role_code IN ('admin','director')))),FALSE)
$$;

CREATE OR REPLACE FUNCTION agent_backend.proposal_validity(p agent_backend.proposal) RETURNS TEXT
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,deanery AS $$
BEGIN
    IF p.status<>'pending' THEN RETURN p.validity; END IF;
    IF p.validity='superseded' THEN RETURN 'superseded'; END IF;
    IF p.kind='grade_correction' AND p.submission_status='submitted' THEN
        RETURN agent_backend.correction_validity(p);
    END IF;
    IF p.expires_at<=now() THEN RETURN 'expired'; END IF;
    IF p.validity='stale' OR p.snapshot IS DISTINCT FROM backend_api.command_snapshot(p.command,p.initiator_user_id)
       THEN RETURN 'stale'; END IF;
    RETURN 'current';
EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE 'P0002' THEN RETURN 'stale';
END $$;

CREATE OR REPLACE FUNCTION agent_backend.proposal_can_assign(p agent_backend.proposal,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
    SELECT COALESCE(p.status='pending' AND p.execution->>'status'='not_started'
       AND agent_backend.proposal_eligible(p,p_user)
       AND (p.initiator_user_id=p_user OR p.assignee_user_id=p_user OR
            EXISTS(SELECT 1 FROM backend_api.account_snapshot(p_user) a WHERE a.role_code IN ('admin','director'))),FALSE)
$$;

CREATE OR REPLACE FUNCTION agent_backend.proposal_view(p agent_backend.proposal,p_user INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,deanery AS $$
DECLARE v_valid TEXT; v_eligible BOOLEAN; v_decide BOOLEAN; v_author TEXT; v_assignee TEXT; v_decider TEXT;
BEGIN
    v_valid:=agent_backend.proposal_validity(p);
    v_eligible:=agent_backend.proposal_eligible(p,p_user);
    v_decide:=p.status='pending' AND p.assignee_user_id=p_user AND v_eligible;
    SELECT COALESCE(concat_ws(' ',n.last_name,n.first_name,n.middle_name),u.login) INTO v_author
        FROM deanery.app_user u LEFT JOIN deanery.person n ON n.person_id=u.person_id WHERE u.user_id=p.initiator_user_id;
    SELECT COALESCE(concat_ws(' ',n.last_name,n.first_name,n.middle_name),u.login) INTO v_assignee
        FROM deanery.app_user u LEFT JOIN deanery.person n ON n.person_id=u.person_id WHERE u.user_id=p.assignee_user_id;
    SELECT u.login INTO v_decider FROM deanery.app_user u WHERE u.user_id=p.decided_by;
    RETURN jsonb_build_object('id',p.id,'kind',p.kind,'submission_status',p.submission_status,'correction_id',p.correction_id,'status',p.status,'version',p.version,'explanation',p.explanation,
        'reason',p.reason,'sql_text','','created_at',p.created_at,'expires_at',p.expires_at,
        'initiator',jsonb_build_object('user_id',p.initiator_user_id,'full_name',v_author),
        'decided_by',v_decider,'decided_at',p.decided_at,'decision_reason',p.decision_reason,
        'validity',jsonb_build_object('state',v_valid,'reason',CASE WHEN v_valid='current' THEN NULL ELSE v_valid END),
        'routing',jsonb_build_object('institute_id',p.institute_id,'assignee_user_id',p.assignee_user_id,'assignee_name',v_assignee),
        'execution',jsonb_build_object('effective_date',p.effective_date,'order_id',NULL,'job_id',NULL,
             'started_at',NULL,'completed_at',NULL,'error',NULL) || p.execution,
        'actions',jsonb_build_object('can_claim',p.status='pending' AND p.assignee_user_id IS NULL AND v_eligible,
             'can_assign',agent_backend.proposal_can_assign(p,p_user),
             'can_submit',COALESCE(p.kind='grade_correction' AND p.submission_status='draft' AND p.initiator_user_id=p_user
                AND p.status='pending' AND v_valid='current' AND backend_api.command_authorized(p.command,p_user,'prepare'),FALSE),
             'can_approve',COALESCE(v_decide AND v_valid='current'
                AND (p.submission_status='submitted' OR backend_api.command_authorized(p.command,p.initiator_user_id,'prepare'))
                AND backend_api.command_authorized(p.command,p_user,'execute'),FALSE),
             'can_reject',COALESCE(v_decide,FALSE)),
        'preview',p.preview || jsonb_build_object('applied',p.execution->'applied'), 'context_files','[]'::JSONB);
END $$;

CREATE OR REPLACE FUNCTION backend_api.get_proposal(p_id UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE p agent_backend.proposal; v_user INT:=agent_backend.proposal_actor(p_token);
BEGIN
    SELECT * INTO p FROM agent_backend.proposal WHERE id=p_id;
    IF NOT FOUND OR NOT agent_backend.proposal_visible(p,v_user) THEN RAISE EXCEPTION 'Proposal missing' USING ERRCODE='P6006'; END IF;
    RETURN agent_backend.proposal_view(p,v_user);
END $$;

CREATE OR REPLACE FUNCTION backend_api.list_proposals(p_token TEXT,p_box TEXT,p_status TEXT,p_execution TEXT,p_limit INT,p_offset INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); v_result JSONB;
BEGIN
    IF p_box IS NULL OR p_limit IS NULL OR p_offset IS NULL OR p_box NOT IN ('incoming','mine','completed') OR p_limit NOT BETWEEN 1 AND 100 OR p_offset<0
       OR (p_status IS NOT NULL AND p_status NOT IN ('pending','approved','rejected'))
       OR (p_execution IS NOT NULL AND p_execution NOT IN ('not_started','scheduled','running','succeeded','failed','cancelled')) THEN
        RAISE EXCEPTION 'Invalid queue filter' USING ERRCODE='22023'; END IF;
    WITH visible AS MATERIALIZED (
        SELECT p,agent_backend.proposal_validity(p) AS validity FROM agent_backend.proposal p
        WHERE agent_backend.proposal_visible(p,v_user)
    ), boxes AS MATERIALIZED (
        SELECT p,(p).initiator_user_id=v_user AS mine,
            ((p).status<>'pending' OR (validity<>'current' AND NOT ((p).kind='grade_correction' AND (p).submission_status='submitted'))) AS completed,
            ((p).status='pending' AND (validity='current' OR ((p).kind='grade_correction' AND (p).submission_status='submitted')) AND agent_backend.proposal_eligible(p,v_user)
             AND ((p).assignee_user_id IS NULL OR (p).assignee_user_id=v_user OR EXISTS(
                SELECT 1 FROM backend_api.account_snapshot(v_user) a WHERE a.role_code IN ('admin','director')))) AS incoming
        FROM visible
    ), filtered AS MATERIALIZED (
        SELECT p FROM boxes WHERE CASE p_box WHEN 'mine' THEN mine WHEN 'completed' THEN completed ELSE incoming END
          AND (p_status IS NULL OR (p).status=p_status) AND (p_execution IS NULL OR (p).execution->>'status'=p_execution)
    ), page AS (SELECT p FROM filtered ORDER BY (p).created_at DESC,(p).id DESC LIMIT p_limit OFFSET p_offset)
    SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(agent_backend.proposal_view(p,v_user)
            ORDER BY (p).created_at DESC,(p).id DESC) FROM page),'[]'::JSONB),
        'limit',p_limit,'offset',p_offset,'has_more',(SELECT count(*) FROM filtered)>p_offset::BIGINT+p_limit,
        'counts',jsonb_build_object('incoming',count(*) FILTER(WHERE incoming),
             'mine',count(*) FILTER(WHERE mine),'completed',count(*) FILTER(WHERE completed))) INTO v_result FROM boxes;
    RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION backend_api.proposal_assignees(p_id UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); p agent_backend.proposal; v_result JSONB;
BEGIN
    SELECT * INTO p FROM agent_backend.proposal WHERE id=p_id;
    IF NOT FOUND OR NOT agent_backend.proposal_visible(p,v_user) THEN RAISE EXCEPTION 'Proposal missing' USING ERRCODE='P6006'; END IF;
    IF NOT agent_backend.proposal_can_assign(p,v_user) THEN RAISE EXCEPTION 'Assignment forbidden' USING ERRCODE='42501'; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',u.user_id,
        'full_name',COALESCE(NULLIF(concat_ws(' ',n.last_name,n.first_name,n.middle_name),''),u.login),'role',r.code)
        ORDER BY u.user_id),'[]'::JSONB) INTO v_result
    FROM deanery.app_user u JOIN deanery.app_role r ON r.role_id=u.role_id
    LEFT JOIN deanery.person n ON n.person_id=u.person_id
    WHERE agent_backend.proposal_eligible(p,u.user_id);
    RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION backend_api.assign_proposal(p_id UUID,p_assignee INT,p_reason TEXT,p_version INT,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); p agent_backend.proposal; saved agent_backend.idempotency_record;
    v_route TEXT:='/proposal/'||p_id::TEXT||'/assignment'; v_hash BYTEA; v_previous INT;
BEGIN
    IF p_key IS NULL OR p_assignee IS NULL OR p_version IS NULL OR p_version<1 OR p_reason IS NULL
       OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Invalid assignment' USING ERRCODE='22023'; END IF;
    SELECT * INTO p FROM agent_backend.proposal WHERE id=p_id FOR UPDATE;
    IF NOT FOUND OR NOT agent_backend.proposal_visible(p,v_user) THEN RAISE EXCEPTION 'Proposal missing' USING ERRCODE='P6006'; END IF;
    IF NOT agent_backend.proposal_eligible(p,v_user) THEN RAISE EXCEPTION 'Assignment forbidden' USING ERRCODE='42501'; END IF;
    v_hash:=sha256(convert_to(jsonb_build_array(p_assignee,p_reason,p_version)::TEXT,'UTF8'));
    SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=v_user AND route=v_route AND key=p_key;
    IF FOUND THEN
        IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='P6001'; END IF;
        RETURN agent_backend.proposal_view(p,v_user);
    END IF;
    IF p.status<>'pending' OR p.version<>p_version OR p.execution->>'status'<>'not_started' THEN
        RAISE EXCEPTION 'Proposal changed' USING ERRCODE='P6005'; END IF;
    IF NOT agent_backend.proposal_can_assign(p,v_user)
       AND NOT (p.assignee_user_id IS NULL AND p_assignee=v_user) THEN RAISE EXCEPTION 'Assignment forbidden' USING ERRCODE='42501'; END IF;
    IF NOT agent_backend.proposal_eligible(p,p_assignee) THEN RAISE EXCEPTION 'Ineligible assignee' USING ERRCODE='42501'; END IF;
    v_previous:=p.assignee_user_id;
    UPDATE agent_backend.proposal SET assignee_user_id=p_assignee,version=version+1 WHERE id=p_id RETURNING * INTO p;
    INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,reason,data)
        VALUES(p_id,v_user,CASE WHEN v_previous IS NULL AND p_assignee=v_user THEN 'claimed' ELSE 'assigned' END,
            btrim(p_reason),jsonb_build_object('from_user_id',v_previous,'to_user_id',p_assignee,'version',p.version));
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash,response_status,response_body)
        VALUES(v_user,v_route,p_key,v_hash,200,jsonb_build_object('id',p.id));
    RETURN agent_backend.proposal_view(p,v_user);
END $$;

CREATE OR REPLACE FUNCTION backend_api.decide_proposal(p_id UUID,p_approve BOOLEAN,p_reason TEXT,p_version INT,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); p agent_backend.proposal; saved agent_backend.idempotency_record;
    v_route TEXT:='/proposal/'||p_id::TEXT||'/decision'; v_hash BYTEA; v_result JSONB; v_execution JSONB; v_valid TEXT;
BEGIN
    IF p_key IS NULL OR p_approve IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 2000
       OR (p_version IS NOT NULL AND p_version<1) THEN RAISE EXCEPTION 'Invalid decision' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock(9174,1);
    SELECT * INTO p FROM agent_backend.proposal WHERE id=p_id FOR UPDATE;
    IF NOT FOUND OR NOT agent_backend.proposal_visible(p,v_user) THEN RAISE EXCEPTION 'Proposal missing' USING ERRCODE='P6006'; END IF;
    IF p.assignee_user_id IS DISTINCT FROM v_user OR NOT agent_backend.proposal_eligible(p,v_user) THEN
        RAISE EXCEPTION 'Decision forbidden' USING ERRCODE='42501'; END IF;
    v_hash:=sha256(convert_to(jsonb_build_array(p_approve,p_reason,p_version)::TEXT,'UTF8'));
    SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=v_user AND route=v_route AND key=p_key;
    IF FOUND THEN
        IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='P6001'; END IF;
        RETURN agent_backend.proposal_view(p,v_user);
    END IF;
    IF p.status<>'pending' THEN
        IF p.status<>(CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END) OR p.decided_by<>v_user THEN
            RAISE EXCEPTION 'Proposal decided' USING ERRCODE='P6004'; END IF;
        RETURN agent_backend.proposal_view(p,v_user);
    END IF;
    IF p_version IS NOT NULL AND p.version<>p_version THEN RAISE EXCEPTION 'Proposal changed' USING ERRCODE='P6005'; END IF;
    IF p.kind='grade_correction' THEN
        PERFORM backend_api.command_lock(p.command);
        IF p.submission_status IS DISTINCT FROM 'submitted' THEN RAISE EXCEPTION 'Correction not submitted' USING ERRCODE='P6005'; END IF;
        IF p_approve AND agent_backend.proposal_validity(p)<>'current' THEN
            RAISE EXCEPTION 'Correction stale' USING ERRCODE='P6003'; END IF;
        PERFORM set_config('app.user_id',v_user::TEXT,TRUE);
        PERFORM set_config('app.agent_request_id',p.agent_request_id::TEXT,TRUE);
        PERFORM set_config('app.order_job_id','',TRUE);
        CALL deanery.sp_decide_grade_correction(p.correction_id,p_approve,btrim(p_reason));
        v_execution:=CASE WHEN p_approve THEN jsonb_build_object('status','succeeded','started_at',now(),
            'completed_at',now(),'error',NULL,'applied',backend_api.special_row(p.command)) ELSE p.execution END;
    ELSIF p_approve THEN
        PERFORM backend_api.command_lock(p.command);
        v_valid:=agent_backend.proposal_validity(p);
        IF v_valid='expired' THEN RAISE EXCEPTION 'Proposal expired' USING ERRCODE='P6002'; END IF;
        IF v_valid<>'current' THEN RAISE EXCEPTION 'Proposal stale' USING ERRCODE='P6003'; END IF;
        IF NOT backend_api.command_authorized(p.command,p.initiator_user_id,'prepare')
           OR NOT backend_api.command_authorized(p.command,v_user,'execute') THEN
            RAISE EXCEPTION 'Current authorization lost' USING ERRCODE='42501'; END IF;
        v_result:=backend_api.command_execute(p.command,p.initiator_user_id,v_user,p.agent_request_id,p.id);
        IF v_result ? 'job_id' THEN
            v_execution:=jsonb_build_object('status',CASE WHEN v_result->>'status'='applied' THEN 'succeeded' ELSE 'scheduled' END,
                'order_id',v_result->'order_id','student_id',v_result->'student_id','job_id',v_result->'job_id',
                'effective_date',v_result->'effective_date','started_at',CASE WHEN v_result->>'status'='applied' THEN now() END,
                'completed_at',CASE WHEN v_result->>'status'='applied' THEN now() END,'error',NULL,'applied',v_result);
        ELSE
            v_execution:=jsonb_build_object('status','succeeded','started_at',now(),'completed_at',now(),'error',NULL,'applied',v_result);
        END IF;
    ELSE v_execution:=p.execution; END IF;
    UPDATE agent_backend.proposal SET status=CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
        validity=CASE WHEN p_approve THEN 'current' ELSE agent_backend.proposal_validity(p) END,
        execution=v_execution,decided_by=v_user,decided_at=now(),
        decision_reason=btrim(p_reason),version=version+1 WHERE id=p_id RETURNING * INTO p;
    INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,reason,data)
        VALUES(p_id,v_user,p.status,p.decision_reason,jsonb_build_object('execution_status',p.execution->>'status','version',p.version));
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash,response_status,response_body)
        VALUES(v_user,v_route,p_key,v_hash,200,jsonb_build_object('id',p.id));
    RETURN agent_backend.proposal_view(p,v_user);
END $$;

CREATE OR REPLACE FUNCTION backend_api.proposal_events(p_id UUID,p_token TEXT,p_after BIGINT,p_limit INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); p agent_backend.proposal; v_result JSONB;
BEGIN
    SELECT * INTO p FROM agent_backend.proposal WHERE id=p_id;
    IF NOT FOUND OR NOT agent_backend.proposal_visible(p,v_user) THEN RAISE EXCEPTION 'Proposal missing' USING ERRCODE='P6006'; END IF;
    IF p_after IS NULL OR p_limit IS NULL OR p_after<0 OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid event page' USING ERRCODE='22023'; END IF;
    SELECT jsonb_build_object('items',COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::JSONB),
        'has_more',(SELECT count(*)>p_limit FROM agent_backend.proposal_event WHERE proposal_id=p_id AND id>p_after)) INTO v_result
    FROM (SELECT id,actor_user_id,event_type,reason,data,created_at FROM agent_backend.proposal_event
          WHERE proposal_id=p_id AND id>p_after ORDER BY id LIMIT p_limit) e;
    RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION agent_backend.reconcile_proposal_job() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE p agent_backend.proposal; v_applied TIMESTAMPTZ; v_state TEXT; v_execution JSONB;
BEGIN
    IF NEW.kind<>'apply_order' THEN RETURN NEW; END IF;
    SELECT os.applied_at INTO v_applied FROM deanery.order_student os
        WHERE os.order_id=(NEW.payload->>'order_id')::INT AND os.student_id=(NEW.payload->>'student_id')::INT;
    v_state:=CASE WHEN v_applied IS NOT NULL THEN 'succeeded' WHEN NEW.status='cancelled' THEN 'cancelled' WHEN NEW.status='failed' THEN 'failed'
                 WHEN NEW.status='running' THEN 'running' ELSE 'scheduled' END;
    FOR p IN SELECT * FROM agent_backend.proposal WHERE status='approved' AND execution->>'job_id'=NEW.id::TEXT FOR UPDATE LOOP
        v_execution:=p.execution || jsonb_build_object('status',v_state,
            'started_at',CASE WHEN v_state IN ('running','succeeded') THEN COALESCE(p.execution->>'started_at',now()::TEXT) ELSE p.execution->>'started_at' END,
            'completed_at',CASE WHEN v_state='succeeded' THEN v_applied WHEN v_state IN ('failed','cancelled') THEN NEW.finished_at END,
            'error',CASE WHEN v_state='failed' THEN COALESCE(NEW.error_code,'execution_failed') END)
            || CASE WHEN v_state='cancelled' THEN jsonb_build_object('cancellation_proposal_id',NEW.result->'cancellation_proposal_id') ELSE '{}'::JSONB END;
        IF v_execution IS DISTINCT FROM p.execution THEN
            UPDATE agent_backend.proposal SET execution=v_execution,version=version+1 WHERE id=p.id;
            INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,reason,data)
                VALUES(p.id,CASE WHEN v_state='cancelled' THEN (NEW.result->>'cancelled_by')::INT END,'execution',
                    CASE WHEN v_state='cancelled' THEN NEW.result->>'reason' END,
                    jsonb_build_object('status',v_state,'job_id',NEW.id,'error',v_execution->'error')
                    || CASE WHEN v_state='cancelled' THEN jsonb_build_object('cancellation_proposal_id',NEW.result->'cancellation_proposal_id') ELSE '{}'::JSONB END);
        END IF;
    END LOOP;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proposal_job_state ON agent_backend.job;
CREATE TRIGGER proposal_job_state AFTER UPDATE ON agent_backend.job FOR EACH ROW EXECUTE FUNCTION agent_backend.reconcile_proposal_job();

REVOKE ALL ON FUNCTION agent_backend.proposal_actor(TEXT),agent_backend.proposal_eligible(agent_backend.proposal,INT),
    agent_backend.proposal_visible(agent_backend.proposal,INT),agent_backend.proposal_validity(agent_backend.proposal),
    agent_backend.proposal_can_assign(agent_backend.proposal,INT),agent_backend.proposal_view(agent_backend.proposal,INT),
    agent_backend.reconcile_proposal_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION backend_api.get_proposal(UUID,TEXT),
    backend_api.list_proposals(TEXT,TEXT,TEXT,TEXT,INT,INT),backend_api.proposal_assignees(UUID,TEXT),
    backend_api.assign_proposal(UUID,INT,TEXT,INT,UUID,TEXT),backend_api.decide_proposal(UUID,BOOLEAN,TEXT,INT,UUID,TEXT),
    backend_api.proposal_events(UUID,TEXT,BIGINT,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.get_proposal(UUID,TEXT),backend_api.list_proposals(TEXT,TEXT,TEXT,TEXT,INT,INT),
    backend_api.proposal_assignees(UUID,TEXT),backend_api.assign_proposal(UUID,INT,TEXT,INT,UUID,TEXT),
    backend_api.decide_proposal(UUID,BOOLEAN,TEXT,INT,UUID,TEXT),backend_api.proposal_events(UUID,TEXT,BIGINT,INT) TO backend_api;
