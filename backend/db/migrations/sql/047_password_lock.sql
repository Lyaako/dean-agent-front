CREATE OR REPLACE FUNCTION backend_api.own_password_hash(p_token TEXT) RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor INT:=agent_backend.proposal_actor(p_token); result TEXT;
BEGIN
    -- Same lock order as reset/change; a waiting request must recheck its token.
    PERFORM pg_advisory_xact_lock(9231,actor);
    PERFORM agent_backend.proposal_actor(p_token);
    SELECT password_hash::TEXT INTO result FROM deanery.app_user WHERE user_id=actor FOR UPDATE;
    RETURN result;
END
$$;
