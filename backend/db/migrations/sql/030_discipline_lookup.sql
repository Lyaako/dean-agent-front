CREATE OR REPLACE FUNCTION backend_api.visible_rows(p_resource TEXT, p_access_token TEXT) RETURNS SETOF TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, deanery AS $$
DECLARE a RECORD;
BEGIN
    SELECT snap.* INTO a
    FROM agent_backend.auth_token tok
    JOIN agent_backend.auth_session sess ON sess.id=tok.session_id
    CROSS JOIN LATERAL backend_api.account_snapshot(sess.user_id) snap
    WHERE tok.token_hash=sha256(convert_to(p_access_token,'UTF8'))
      AND tok.kind='access' AND tok.expires_at>now() AND tok.revoked_at IS NULL
      AND sess.expires_at>now() AND sess.revoked_at IS NULL AND snap.is_active;
    IF NOT FOUND THEN RETURN; END IF;
    IF p_resource='discipline' THEN
        RETURN QUERY SELECT * FROM agent_backend.agent_rows_for_actor(p_resource,a.user_id);
    ELSE
        RETURN QUERY SELECT * FROM agent_backend.visible_rows_for_actor(p_resource,a.user_id);
    END IF;
END $$;

REVOKE ALL ON FUNCTION backend_api.visible_rows(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.visible_rows(TEXT,TEXT) TO backend_api;
