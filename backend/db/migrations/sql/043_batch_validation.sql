CREATE FUNCTION backend_api.probe_batch(p_id UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE p agent_backend.proposal; item JSONB; result JSONB:='[]'; message TEXT; previous TEXT:=current_setting('app.batch_preview',TRUE);
BEGIN
    SELECT * INTO p FROM agent_backend.proposal WHERE id=p_id;
    IF NOT FOUND OR NOT agent_backend.proposal_visible(p,agent_backend.proposal_actor(p_token)) THEN
        RAISE EXCEPTION 'Proposal missing' USING ERRCODE='P6006'; END IF;
    IF p.kind<>'batch' OR p.status<>'pending' THEN RETURN result; END IF;
    PERFORM set_config('app.batch_preview','on',TRUE);
    FOR item IN SELECT jsonb_array_elements(p.command->'items') LOOP
        IF agent_backend.item_state(p,item)<>'ok' THEN CONTINUE; END IF;
        BEGIN
            PERFORM backend_api.command_preview_v1(item->'command',p.initiator_user_id,p.agent_request_id);
        EXCEPTION WHEN integrity_constraint_violation OR data_exception
            OR raise_exception OR insufficient_privilege OR no_data_found THEN
            GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
            result:=result||jsonb_build_object('item_id',item->'item_id','state','rule_violation',
                'message',regexp_replace(message,'\s*[—:]\s*(CALL\s|fn_[a-z_]+\s*\().*$','','i'));
        END;
    END LOOP;
    PERFORM set_config('app.batch_preview',COALESCE(previous,''),TRUE);
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION backend_api.probe_batch(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.probe_batch(UUID,TEXT) TO backend_api;
