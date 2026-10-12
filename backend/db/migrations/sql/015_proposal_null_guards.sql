CREATE OR REPLACE FUNCTION agent_backend.proposal_visible(p agent_backend.proposal,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
    SELECT COALESCE(p.initiator_user_id=p_user OR (agent_backend.proposal_eligible(p,p_user) AND
        (p.assignee_user_id=p_user OR p.decided_by=p_user OR p.assignee_user_id IS NULL OR
         EXISTS(SELECT 1 FROM backend_api.account_snapshot(p_user) a WHERE a.role_code IN ('admin','director')))),FALSE)
$$;

CREATE OR REPLACE FUNCTION agent_backend.proposal_can_assign(p agent_backend.proposal,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
    SELECT COALESCE(p.status='pending' AND p.execution->>'status'='not_started'
       AND agent_backend.proposal_eligible(p,p_user)
       AND (p.initiator_user_id=p_user OR p.assignee_user_id=p_user OR
            EXISTS(SELECT 1 FROM backend_api.account_snapshot(p_user) a WHERE a.role_code IN ('admin','director'))),FALSE)
$$;
