-- Explicitly approved 15.10.2026: the API requires 10–2000 characters.
DO $$ DECLARE definition TEXT; grants JSONB; item JSONB; owner_name TEXT; comment_text TEXT;
BEGIN
    SELECT pg_get_viewdef(c.oid,TRUE),r.rolname,obj_description(c.oid,'pg_class') INTO definition,owner_name,comment_text
        FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='deanery.v_grade_corrections'::regclass;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('role',COALESCE(r.rolname,'PUBLIC'),'privilege',a.privilege_type,
        'grantable',a.is_grantable)),'[]') INTO grants FROM pg_class c
        CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
        LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE c.oid='deanery.v_grade_corrections'::regclass;
    -- No CASCADE: unknown dependent objects stop the migration without removing them.
    DROP VIEW deanery.v_grade_corrections;
    ALTER TABLE deanery.grade_correction ALTER COLUMN reason TYPE VARCHAR(2000);
    EXECUTE 'CREATE VIEW deanery.v_grade_corrections AS '||definition;
    EXECUTE format('ALTER VIEW deanery.v_grade_corrections OWNER TO %I',owner_name);
    EXECUTE format('COMMENT ON VIEW deanery.v_grade_corrections IS %L',comment_text);
    FOR item IN SELECT jsonb_array_elements(grants) LOOP
        EXECUTE format('GRANT %s ON deanery.v_grade_corrections TO %s%s',item->>'privilege',
            CASE WHEN item->>'role'='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(item->>'role') END,
            CASE WHEN (item->>'grantable')::BOOLEAN THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
END $$;
DO $$ DECLARE definition TEXT; BEGIN
    SELECT pg_get_functiondef('backend_api.special_normalize(jsonb,integer)'::regprocedure) INTO definition;
    IF position('WHEN k=''reason'' AND n=''grade_correction'' THEN 500' IN definition)=0 THEN
        RAISE EXCEPTION 'Pinned correction validator changed; operator review required'; END IF;
    EXECUTE replace(definition,'WHEN k=''reason'' AND n=''grade_correction'' THEN 500','WHEN k=''reason'' AND n=''grade_correction'' THEN 2000');
END $$;

CREATE FUNCTION backend_api.undo_proposal(p_id UUID,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,deanery AS $$
DECLARE uid INT:=agent_backend.proposal_actor(p_token); p agent_backend.proposal; inverse agent_backend.proposal;
    saved agent_backend.idempotency_record; v_route TEXT:='/proposal/'||p_id::TEXT||'/undo';
    item JSONB; c JSONB; current_row JSONB; fields JSONB; commands JSONB:='[]'; skipped JSONB:='[]';
    preview JSONB:='[]'; applied JSONB:='[]'; rollback JSONB:='[]'; v_snapshot JSONB; result JSONB;
    audit_marker BIGINT; record_key TEXT; v_inverse UUID:=gen_random_uuid(); rid INT;
BEGIN
    PERFORM pg_advisory_xact_lock(9174,1);
    SELECT * INTO p FROM agent_backend.proposal WHERE id=p_id FOR UPDATE;
    IF NOT FOUND OR p.decided_by IS DISTINCT FROM uid OR NOT agent_backend.proposal_visible(p,uid) THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=uid AND route=v_route AND key=p_key;
    IF FOUND THEN
        SELECT * INTO inverse FROM agent_backend.proposal WHERE id=(saved.response_body->>'id')::UUID;
        RETURN agent_backend.proposal_view(inverse,uid);
    END IF;
    IF p.status<>'approved' OR p.execution->>'status'<>'succeeded' OR p.execution->>'undo_id' IS NOT NULL
        OR p.decided_at<=now()-INTERVAL '15 minutes' THEN
        RAISE EXCEPTION 'Это изменение уже нельзя отменить' USING ERRCODE='P6204'; END IF;
    PERFORM backend_api.command_lock(p.command);
    FOR item IN SELECT jsonb_array_elements(COALESCE(p.execution->'rollback_items','[]')) LOOP
        IF NOT backend_api.reversible_item(item) THEN
            skipped:=skipped||jsonb_build_object('item_id',item->'item_id','code','undo_unavailable'); CONTINUE;
        END IF;
        c:=item->'command'; current_row:=backend_api.command_row(c);
        SELECT string_agg(k||'='||v,', ' ORDER BY k) INTO record_key FROM jsonb_each_text(c->'key') e(k,v);
        SELECT max(audit_id) INTO audit_marker FROM audit_log l WHERE l.table_name=c->>'resource' AND l.record_key=record_key;
        IF current_row IS DISTINCT FROM item->'after' OR audit_marker IS DISTINCT FROM (item->>'audit_id')::BIGINT THEN
            RAISE EXCEPTION 'После применения строка % была изменена',item->>'item_id' USING ERRCODE='P6203',
                DETAIL=jsonb_build_object('item_id',(item->>'item_id')::INT)::TEXT; END IF;
        SELECT jsonb_object_agg(k,item->'before'->k) INTO fields FROM jsonb_object_keys(c->'fields') k;
        c:=jsonb_set(c,'{fields}',fields);
        IF NOT backend_api.command_authorized(c,uid,'prepare',p.institute_id) OR NOT backend_api.command_authorized(c,uid,'execute',p.institute_id) THEN
            RAISE EXCEPTION 'Право на обратное изменение утрачено' USING ERRCODE='P6204'; END IF;
        commands:=commands||jsonb_build_object('item_id',item->'item_id','command',c);
        preview:=preview||jsonb_build_object('item_id',item->'item_id','table',c->>'resource','operation','UPDATE',
            'before',current_row,'after',current_row||fields,'changed_columns',ARRAY(SELECT jsonb_object_keys(fields)));
    END LOOP;
    IF jsonb_array_length(commands)=0 THEN RAISE EXCEPTION 'Нет обратимых строк для отмены' USING ERRCODE='P6204'; END IF;
    rid:=backend_api.manual_request(p_token,'Отмена применённых изменений через форму');
    c:=backend_api.command_normalize(jsonb_build_object('version',1,'kind','batch','items',commands),uid);
    PERFORM backend_api.command_lock(c);
    v_snapshot:=backend_api.command_snapshot(c,uid);
    FOR item IN SELECT jsonb_array_elements(commands) LOOP
        current_row:=backend_api.command_row(item->'command');
        result:=backend_api.command_execute(item->'command',uid,uid,rid,v_inverse);
        applied:=applied||jsonb_build_object('item_id',item->'item_id','record',result);
        rollback:=rollback||backend_api.rollback_item(item->'command',current_row,result,(item->>'item_id')::INT);
    END LOOP;
    SET CONSTRAINTS ALL IMMEDIATE;
    INSERT INTO agent_backend.proposal(id,initiator_user_id,agent_request_id,kind,command,preview,snapshot,snapshot_hash,
        explanation,reason,expires_at,institute_id,assignee_user_id,status,execution,decided_by,decided_at,decision_reason)
    VALUES(v_inverse,uid,rid,'batch',c,jsonb_build_object('operation','BATCH','items',preview,'affected_rows',jsonb_array_length(commands),
        'effects','[]'::JSONB,'related_effects','[]'::JSONB),v_snapshot,encode(sha256(convert_to(v_snapshot::TEXT,'UTF8')),'hex'),
        'Отмена применённых изменений','Отмена пользователем, применившим предложение',now()+INTERVAL '24 hours',p.institute_id,uid,'approved',
        jsonb_build_object('status','succeeded','started_at',now(),'completed_at',now(),'applied',applied,
            'undo_of',p.id,'skipped',skipped),uid,now(),'Отмена пользователем, применившим предложение') RETURNING * INTO inverse;
    UPDATE agent_backend.proposal SET execution=execution||jsonb_build_object('undo_id',v_inverse,'undone_at',now(),'undo_skipped',skipped),
        version=version+1 WHERE id=p_id;
    INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,reason,data)
        VALUES(p_id,uid,'undone','Отмена применённых обратимых строк',jsonb_build_object('inverse_proposal_id',v_inverse,'skipped',skipped)),
            (v_inverse,uid,'approved','Обратное изменение применено',jsonb_build_object('undo_of',p_id));
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash,response_status,response_body)
        VALUES(uid,v_route,p_key,sha256(convert_to(p_id::TEXT,'UTF8')),200,jsonb_build_object('id',v_inverse));
    RETURN agent_backend.proposal_view(inverse,uid);
END $$;
REVOKE ALL ON FUNCTION backend_api.undo_proposal(UUID,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.undo_proposal(UUID,UUID,TEXT) TO backend_api;
GRANT EXECUTE ON FUNCTION backend_api.reversible_item(JSONB),backend_api.rollback_item(JSONB,JSONB,JSONB,INT),
    backend_api.command_normalize(JSONB,INT),backend_api.command_lock(JSONB),backend_api.command_snapshot(JSONB,INT)
    TO backend_api,backend_executor;
