CREATE FUNCTION backend_api.validation_preview(c JSONB,p_author INT,p_request INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE context JSONB:=backend_api.database_actor(p_author); result JSONB;
    previous TEXT:=current_setting('role'); previous_user TEXT:=current_setting('app.user_id',TRUE);
BEGIN
    IF context->>'role' IN ('admin','director','dean_staff') THEN
        IF context->>'db_login' IS NULL THEN RAISE EXCEPTION 'Personal role not provisioned' USING ERRCODE='42501'; END IF;
        EXECUTE format('SET LOCAL ROLE %I',context->>'db_login');
        PERFORM set_config('app.user_id',p_author::TEXT,TRUE);
    END IF;
    -- This adapter always rolls back domain writes before returning; it is not an executor.
    result:=backend_api.command_preview_v1(c,p_author,p_request);
    IF previous='none' THEN SET LOCAL ROLE NONE; ELSE EXECUTE format('SET LOCAL ROLE %I',previous); END IF;
    PERFORM set_config('app.user_id',COALESCE(previous_user,''),TRUE);
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION backend_api.validation_preview(JSONB,INT,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.validation_preview(JSONB,INT,INT) TO backend_api,backend_executor;
DO $$ DECLARE definition TEXT; signature REGPROCEDURE; BEGIN
    FOREACH signature IN ARRAY ARRAY['backend_api.command_preview(jsonb,integer,integer)'::REGPROCEDURE,
        'backend_api.probe_batch(uuid,text)'::REGPROCEDURE] LOOP
        SELECT pg_get_functiondef(signature) INTO definition;
        EXECUTE replace(definition,'backend_api.command_preview_v1(','backend_api.validation_preview(');
    END LOOP;
END $$;
