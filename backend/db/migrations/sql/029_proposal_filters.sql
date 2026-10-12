CREATE FUNCTION backend_api.list_proposals(p_token TEXT,p_box TEXT,p_status TEXT,p_execution TEXT,
    p_limit INT,p_offset INT,p_author TEXT,p_created_from DATE,p_created_to DATE) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); v_result JSONB;
BEGIN
    IF p_box IS NULL OR p_limit IS NULL OR p_offset IS NULL OR p_box NOT IN ('incoming','mine','completed')
       OR p_limit NOT BETWEEN 1 AND 100 OR p_offset<0
       OR (p_status IS NOT NULL AND p_status NOT IN ('pending','approved','rejected'))
       OR (p_execution IS NOT NULL AND p_execution NOT IN ('not_started','scheduled','running','succeeded','failed','cancelled'))
       OR length(p_author)>200 OR NOT isfinite(p_created_from) OR NOT isfinite(p_created_to)
       OR p_created_from>p_created_to THEN
        RAISE EXCEPTION 'Invalid queue filter' USING ERRCODE='22023'; END IF;
    WITH visible AS MATERIALIZED (
        SELECT p,agent_backend.proposal_validity(p) AS validity FROM agent_backend.proposal p
        WHERE agent_backend.proposal_visible(p,v_user)
    ), matching AS MATERIALIZED (
        SELECT v.p,v.validity FROM visible v
        JOIN deanery.app_user u ON u.user_id=(v.p).initiator_user_id
        LEFT JOIN deanery.person n ON n.person_id=u.person_id
        WHERE (p_status IS NULL OR (v.p).status=p_status)
          AND (p_execution IS NULL OR (v.p).execution->>'status'=p_execution)
          AND (p_author IS NULL OR strpos(lower(concat_ws(' ',n.last_name,n.first_name,n.middle_name,u.login)),lower(btrim(p_author)))>0)
          AND (p_created_from IS NULL OR (v.p).created_at >= (p_created_from::TIMESTAMP AT TIME ZONE 'Europe/Moscow'))
          AND (p_created_to IS NULL OR (v.p).created_at < ((p_created_to+1)::TIMESTAMP AT TIME ZONE 'Europe/Moscow'))
    ), boxes AS MATERIALIZED (
        SELECT p,(p).initiator_user_id=v_user AS mine,
            ((p).status<>'pending' OR (validity<>'current' AND NOT ((p).kind='grade_correction' AND (p).submission_status='submitted'))) AS completed,
            ((p).status='pending' AND (validity='current' OR ((p).kind='grade_correction' AND (p).submission_status='submitted')) AND agent_backend.proposal_eligible(p,v_user)
             AND ((p).assignee_user_id IS NULL OR (p).assignee_user_id=v_user OR EXISTS(
                SELECT 1 FROM backend_api.account_snapshot(v_user) a WHERE a.role_code IN ('admin','director')))) AS incoming
        FROM matching
    ), filtered AS MATERIALIZED (
        SELECT p FROM boxes WHERE CASE p_box WHEN 'mine' THEN mine WHEN 'completed' THEN completed ELSE incoming END
    ), page AS (SELECT p FROM filtered ORDER BY (p).created_at DESC,(p).id DESC LIMIT p_limit OFFSET p_offset)
    SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(agent_backend.proposal_view(p,v_user)
            ORDER BY (p).created_at DESC,(p).id DESC) FROM page),'[]'::JSONB),
        'limit',p_limit,'offset',p_offset,'has_more',(SELECT count(*) FROM filtered)>p_offset::BIGINT+p_limit,
        'counts',jsonb_build_object('incoming',count(*) FILTER(WHERE incoming),
             'mine',count(*) FILTER(WHERE mine),'completed',count(*) FILTER(WHERE completed))) INTO v_result FROM boxes;
    RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION backend_api.list_proposals(p_token TEXT,p_box TEXT,p_status TEXT,p_execution TEXT,p_limit INT,p_offset INT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT backend_api.list_proposals(p_token,p_box,p_status,p_execution,p_limit,p_offset,NULL::TEXT,NULL::DATE,NULL::DATE)
$$;

REVOKE ALL ON FUNCTION backend_api.list_proposals(TEXT,TEXT,TEXT,TEXT,INT,INT,TEXT,DATE,DATE),
    backend_api.list_proposals(TEXT,TEXT,TEXT,TEXT,INT,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.list_proposals(TEXT,TEXT,TEXT,TEXT,INT,INT,TEXT,DATE,DATE),
    backend_api.list_proposals(TEXT,TEXT,TEXT,TEXT,INT,INT) TO backend_api;
