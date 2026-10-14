CREATE FUNCTION backend_api.batch_snapshot(c JSONB,p_author INT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT jsonb_build_object('row',encode(sha256(convert_to(COALESCE(backend_api.command_row(c)::TEXT,'null'),'UTF8')),'hex'),
        'actor',encode(sha256(convert_to(COALESCE((SELECT to_jsonb(a)::TEXT FROM backend_api.account_snapshot(p_author) a),'null'),'UTF8')),'hex'))
$$;
REVOKE ALL ON FUNCTION backend_api.batch_snapshot(JSONB,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.batch_snapshot(JSONB,INT) TO backend_api,backend_executor;

CREATE OR REPLACE FUNCTION backend_api.command_snapshot(c JSONB,p_author INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item JSONB; result JSONB:='{}';
BEGIN
    IF c->>'kind' IS DISTINCT FROM 'batch' THEN
        IF current_setting('app.batch_preview',TRUE)='on' THEN RETURN backend_api.batch_snapshot(c,p_author); END IF;
        RETURN backend_api.command_snapshot_v1(c,p_author);
    END IF;
    FOR item IN SELECT jsonb_array_elements(c->'items') LOOP
        result:=result||jsonb_build_object(item->>'item_id',backend_api.batch_snapshot(item->'command',p_author));
    END LOOP;
    RETURN result;
END $$;

CREATE OR REPLACE FUNCTION backend_api.command_preview(p_command JSONB,p_author INT,p_request INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE c JSONB; item JSONB; out JSONB:='[]'; result JSONB; snapshot JSONB:='{}'; institutes INT[]:='{}'; inst INT;
    previous TEXT:=current_setting('app.batch_preview',TRUE);
BEGIN
    IF p_command->>'kind' IS DISTINCT FROM 'batch' THEN RETURN backend_api.command_preview_v1(p_command,p_author,p_request); END IF;
    c:=backend_api.command_normalize(p_command,p_author);
    PERFORM set_config('app.batch_preview','on',TRUE);
    FOR item IN SELECT jsonb_array_elements(c->'items') LOOP
        result:=backend_api.command_preview_v1(item->'command',p_author,p_request);
        snapshot:=snapshot||jsonb_build_object(item->>'item_id',result->'snapshot');
        inst:=(result->>'institute_id')::INT;
        IF inst IS NOT NULL AND NOT inst=ANY(institutes) THEN institutes:=array_append(institutes,inst); END IF;
        out:=out||((result->'preview')||jsonb_build_object('item_id',(item->>'item_id')::INT,
            'key',item->'command'->'key','field',ARRAY(SELECT jsonb_object_keys(item->'command'->'fields'))));
    END LOOP;
    PERFORM set_config('app.batch_preview',COALESCE(previous,''),TRUE);
    IF cardinality(institutes)>1 AND NOT EXISTS(SELECT FROM backend_api.account_snapshot(p_author) WHERE role_code='admin') THEN
        RAISE EXCEPTION 'Batch crosses institute scope' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('command',c,'snapshot',snapshot,'snapshot_hash',encode(sha256(convert_to(snapshot::TEXT,'UTF8')),'hex'),
        'institute_id',CASE WHEN cardinality(institutes)=1 THEN institutes[1] END,'preview',
        jsonb_build_object('operation','BATCH','table',NULL,'affected_rows',jsonb_array_length(out),'items',out,'effects','[]'::JSONB,'related_effects','[]'::JSONB));
END $$;
DO $$ DECLARE definition TEXT; BEGIN
    SELECT pg_get_functiondef('agent_backend.item_state(agent_backend.proposal,jsonb)'::regprocedure) INTO definition;
    definition:=replace(definition,'backend_api.command_snapshot(c,p.initiator_user_id)','backend_api.batch_snapshot(c,p.initiator_user_id)');
    EXECUTE replace(definition,'row @> c->''fields''','row @> (c->''fields'')');
END $$;
