ALTER FUNCTION backend_api.command_normalize(JSONB,INT) RENAME TO command_normalize_v2;
CREATE FUNCTION backend_api.command_normalize(c JSONB,p_author INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE item JSONB; child JSONB; items JSONB:='[]'; ids INT[]:='{}'; id INT; key TEXT; seen TEXT[]:='{}'; field TEXT;
BEGIN
    IF c->>'kind' IS DISTINCT FROM 'batch' THEN RETURN backend_api.command_normalize_v2(c,p_author); END IF;
    IF c->'version' IS DISTINCT FROM '1'::JSONB OR c-ARRAY['version','kind','items']<>'{}'::JSONB
        OR jsonb_typeof(c->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'items')=0 THEN
        RAISE EXCEPTION 'Invalid batch' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(c->'items')>200 THEN RAISE EXCEPTION 'В одном пакете допускается не более 200 строк' USING ERRCODE='P6201'; END IF;
    FOR item IN SELECT jsonb_array_elements(c->'items') LOOP
        IF item-ARRAY['item_id','command']<>'{}'::JSONB OR jsonb_typeof(item->'item_id') IS DISTINCT FROM 'number'
            OR item->>'item_id' !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'Invalid item' USING ERRCODE='22023'; END IF;
        id:=(item->>'item_id')::INT;
        IF id=ANY(ids) THEN RAISE EXCEPTION 'Duplicate item id' USING ERRCODE='22023'; END IF;
        ids:=array_append(ids,id);
        child:=item->'command';
        IF child->>'kind'='record_change' AND backend_api.root_change_policy(child->>'resource') IS NOT NULL THEN
            child:=jsonb_set(child,'{kind}','"sql_change"'); END IF;
        child:=backend_api.command_normalize_v2(child,p_author);
        IF child->>'operation' NOT IN ('create','update') OR NOT (
            (child->>'kind'='sql_change' AND backend_api.root_change_policy(child->>'resource') IS NOT NULL) OR
            (child->>'kind'='record_change' AND child->>'resource'='student' AND child->>'operation'='update'
                AND (child->'fields')-'needs_dormitory'='{}'::JSONB)) THEN
            RAISE EXCEPTION 'Batch supports agent inserts/updates only' USING ERRCODE='22023'; END IF;
        FOR field IN SELECT jsonb_object_keys(child->'fields') LOOP
            IF NOT has_column_privilege('deanery_agent',format('deanery.%I',child->>'resource'),field,
                CASE WHEN child->>'operation'='create' THEN 'INSERT' ELSE 'UPDATE' END) THEN
                RAISE EXCEPTION 'Native agent privilege denied' USING ERRCODE='42501'; END IF;
            IF child->>'operation'='update' THEN
                key:=(child->>'resource')||':'||(child->'key')::TEXT||':'||field;
                IF key=ANY(seen) THEN RAISE EXCEPTION 'Duplicate field in batch' USING ERRCODE='22023'; END IF;
                seen:=array_append(seen,key);
            END IF;
        END LOOP;
        items:=items||jsonb_build_object('item_id',id,'command',child);
    END LOOP;
    IF EXISTS(SELECT FROM backend_api.account_snapshot(p_author) WHERE role_code='teacher') AND
        EXISTS(SELECT FROM jsonb_array_elements(items) WHERE value->'command'->>'resource' IN ('grade','attendance')) AND
        EXISTS(SELECT FROM jsonb_array_elements(items) WHERE value->'command'->>'resource' NOT IN ('grade','attendance')) THEN
        RAISE EXCEPTION 'Разделите собственные оценки и другие изменения на разные пакеты' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('version',1,'kind','batch','items',items);
END $$;

ALTER FUNCTION backend_api.command_authorized(JSONB,INT,TEXT,INT) RENAME TO command_authorized_v1;
CREATE FUNCTION backend_api.command_authorized(c JSONB,p_user INT,p_mode TEXT,p_stored_institute INT DEFAULT NULL) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item JSONB;
BEGIN
    IF c->>'kind' IS DISTINCT FROM 'batch' THEN RETURN backend_api.command_authorized_v1(c,p_user,p_mode,p_stored_institute); END IF;
    IF jsonb_typeof(c->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'items') NOT BETWEEN 1 AND 200 THEN RETURN FALSE; END IF;
    FOR item IN SELECT jsonb_array_elements(c->'items') LOOP
        IF NOT backend_api.command_authorized_v1(item->'command',p_user,p_mode,p_stored_institute) THEN RETURN FALSE; END IF;
    END LOOP;
    RETURN TRUE;
END $$;

ALTER FUNCTION backend_api.command_snapshot(JSONB,INT) RENAME TO command_snapshot_v1;
CREATE FUNCTION backend_api.command_snapshot(c JSONB,p_author INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item JSONB; result JSONB:='{}';
BEGIN
    IF c->>'kind' IS DISTINCT FROM 'batch' THEN RETURN backend_api.command_snapshot_v1(c,p_author); END IF;
    FOR item IN SELECT jsonb_array_elements(c->'items') LOOP
        result:=result||jsonb_build_object(item->>'item_id',backend_api.command_snapshot_v1(item->'command',p_author));
    END LOOP;
    RETURN result;
END $$;

ALTER FUNCTION backend_api.command_lock(JSONB) RENAME TO command_lock_v1;
CREATE FUNCTION backend_api.command_lock(c JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item JSONB;
BEGIN
    IF c->>'kind' IS DISTINCT FROM 'batch' THEN PERFORM backend_api.command_lock_v1(c); RETURN; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(c->'items') ORDER BY value->>'item_id' LOOP
        PERFORM backend_api.command_lock_v1(item->'command');
    END LOOP;
END $$;

ALTER FUNCTION backend_api.command_preview(JSONB,INT,INT) RENAME TO command_preview_v1;
CREATE FUNCTION backend_api.command_preview(p_command JSONB,p_author INT,p_request INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE c JSONB; item JSONB; out JSONB:='[]'; result JSONB; snapshot JSONB:='{}'; institutes INT[]:='{}'; inst INT;
BEGIN
    IF p_command->>'kind' IS DISTINCT FROM 'batch' THEN RETURN backend_api.command_preview_v1(p_command,p_author,p_request); END IF;
    c:=backend_api.command_normalize(p_command,p_author);
    FOR item IN SELECT jsonb_array_elements(c->'items') LOOP
        result:=backend_api.command_preview_v1(item->'command',p_author,p_request);
        snapshot:=snapshot||jsonb_build_object(item->>'item_id',result->'snapshot');
        inst:=(result->>'institute_id')::INT;
        IF inst IS NOT NULL AND NOT inst=ANY(institutes) THEN institutes:=array_append(institutes,inst); END IF;
        out:=out||((result->'preview')||jsonb_build_object('item_id',(item->>'item_id')::INT,
            'key',item->'command'->'key','field',ARRAY(SELECT jsonb_object_keys(item->'command'->'fields'))));
    END LOOP;
    IF cardinality(institutes)>1 AND NOT EXISTS(SELECT FROM backend_api.account_snapshot(p_author) WHERE role_code='admin') THEN
        RAISE EXCEPTION 'Batch crosses institute scope' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('command',c,'snapshot',snapshot,'snapshot_hash',encode(sha256(convert_to(snapshot::TEXT,'UTF8')),'hex'),
        'institute_id',CASE WHEN cardinality(institutes)=1 THEN institutes[1] END,'preview',
        jsonb_build_object('operation','BATCH','table',NULL,'affected_rows',jsonb_array_length(out),'items',out,'effects','[]'::JSONB,'related_effects','[]'::JSONB));
END $$;

ALTER FUNCTION agent_backend.proposal_eligible(agent_backend.proposal,INT) RENAME TO proposal_eligible_v2;
CREATE FUNCTION agent_backend.proposal_eligible(p agent_backend.proposal,p_user INT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE author RECORD; viewer RECORD;
BEGIN
    IF p.kind<>'batch' THEN RETURN agent_backend.proposal_eligible_v2(p,p_user); END IF;
    SELECT * INTO author FROM backend_api.account_snapshot(p.initiator_user_id);
    SELECT * INTO viewer FROM backend_api.account_snapshot(p_user);
    IF author.role_code='teacher' AND NOT EXISTS(SELECT FROM jsonb_array_elements(p.command->'items') item
        WHERE item->'command'->>'resource' NOT IN ('grade','attendance')) THEN
        RETURN p_user=p.initiator_user_id AND backend_api.command_authorized(p.command,p_user,'execute',p.institute_id);
    END IF;
    RETURN viewer.is_active AND viewer.role_code IN ('admin','director','dean_staff')
        AND backend_api.command_authorized(p.command,p_user,'execute',p.institute_id);
END $$;

CREATE FUNCTION agent_backend.item_state(p agent_backend.proposal,item JSONB) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE c JSONB:=item->'command'; row JSONB; applied JSONB;
BEGIN
    SELECT value INTO applied FROM jsonb_array_elements(COALESCE(p.execution->'rollback_items','[]'))
        WHERE value->>'item_id'=item->>'item_id';
    IF applied IS NOT NULL THEN
        row:=backend_api.command_row(applied->'command');
        IF row IS NULL THEN RETURN 'gone'; END IF;
        IF row=applied->'after' THEN RETURN 'already_done'; END IF;
        RETURN 'conflict';
    END IF;
    row:=backend_api.command_row(c);
    IF c->>'operation'='update' AND row IS NULL THEN RETURN 'gone'; END IF;
    IF c->>'operation'='update' AND row @> (c->'fields') THEN RETURN 'already_done'; END IF;
    IF backend_api.command_snapshot(c,p.initiator_user_id) IS DISTINCT FROM p.snapshot->(item->>'item_id') THEN RETURN 'conflict'; END IF;
    IF c->>'resource'='grade' AND NOT EXISTS(SELECT FROM grade_sheet
        WHERE sheet_id=(row->>'sheet_id')::INT AND status='open') THEN RETURN 'rule_violation'; END IF;
    RETURN 'ok';
EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE 'P0002' THEN RETURN 'rule_violation';
END $$;

CREATE FUNCTION backend_api.rollback_item(c JSONB,p_before JSONB,p_after JSONB,p_item INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE key TEXT; marker BIGINT; command JSONB:=c;
BEGIN
    IF c->>'operation'='create' THEN
        command:=jsonb_set(c,'{key}',jsonb_build_object(backend_api.root_change_policy(c->>'resource')->>'pk',
            p_after->(backend_api.root_change_policy(c->>'resource')->>'pk')));
        command:=jsonb_set(command,'{operation}','"update"');
    END IF;
    SELECT string_agg(k||'='||v,', ' ORDER BY k) INTO key FROM jsonb_each_text(command->'key') e(k,v);
    SELECT max(audit_id) INTO marker FROM audit_log WHERE table_name=c->>'resource' AND record_key=key;
    RETURN jsonb_build_object('item_id',p_item,'command',command,'before',p_before,'after',p_after,'audit_id',marker,
        'created',c->>'operation'='create');
END $$;

CREATE FUNCTION backend_api.reversible_item(item JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE c JSONB:=item->'command'; resource TEXT:=c->>'resource'; fields JSONB:=c->'fields';
BEGIN
    IF COALESCE((item->>'created')::BOOLEAN,TRUE) OR item->'before'='null'::JSONB THEN RETURN FALSE; END IF;
    CASE resource
    WHEN 'academic_work' THEN RETURN fields-'topic'='{}'::JSONB;
    WHEN 'student' THEN RETURN fields-'needs_dormitory'='{}'::JSONB;
    WHEN 'schedule_slot' THEN RETURN fields-ARRAY['classroom_id','weekday','pair_number']='{}'::JSONB;
    WHEN 'attendance' THEN RETURN fields-ARRAY['is_present','absence_reason']='{}'::JSONB;
    WHEN 'grade' THEN RETURN fields-ARRAY['points','is_absent']='{}'::JSONB AND EXISTS(SELECT FROM grade_sheet
        WHERE sheet_id=(item->'after'->>'sheet_id')::INT AND status='open');
    WHEN 'document_request' THEN RETURN fields-'request_status_id'='{}'::JSONB AND
        (SELECT NOT bool_or(is_final) FROM request_status WHERE request_status_id IN
            ((item->'before'->>'request_status_id')::INT,(item->'after'->>'request_status_id')::INT));
    ELSE RETURN FALSE;
    END CASE;
END $$;

ALTER FUNCTION agent_backend.proposal_view(agent_backend.proposal,INT) RENAME TO proposal_view_v1;
CREATE FUNCTION agent_backend.proposal_view(p agent_backend.proposal,p_user INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE result JSONB; item JSONB; items JSONB:='[]'; state TEXT; eligible BOOLEAN;
BEGIN
    result:=agent_backend.proposal_view_v1(p,p_user);
    IF p.kind='batch' THEN
        FOR item IN SELECT jsonb_array_elements(p.command->'items') LOOP
            state:=agent_backend.item_state(p,item);
            items:=items||jsonb_build_object('item_id',(item->>'item_id')::INT,'table',item->'command'->>'resource',
                'key',item->'command'->'key','field',ARRAY(SELECT jsonb_object_keys(item->'command'->'fields')),
                'before',(SELECT value->'before' FROM jsonb_array_elements(p.preview->'items') WHERE value->>'item_id'=item->>'item_id'),
                'after',item->'command'->'fields','snapshot_hash',encode(sha256(convert_to((p.snapshot->(item->>'item_id'))::TEXT,'UTF8')),'hex'),
                'state',state,'message',CASE state WHEN 'ok' THEN NULL WHEN 'gone' THEN 'Запись удалена'
                    WHEN 'conflict' THEN 'Данные изменились после подготовки' WHEN 'already_done' THEN 'Изменение уже выполнено'
                    ELSE 'Правило базы не позволяет применить строку' END);
        END LOOP;
        result:=result||jsonb_build_object('items',items);
        eligible:=p.status='pending' AND p.expires_at>now() AND p.assignee_user_id=p_user AND agent_backend.proposal_eligible(p,p_user);
        result:=jsonb_set(result,'{actions,can_approve}',to_jsonb(eligible AND EXISTS(SELECT FROM jsonb_array_elements(items) WHERE value->>'state'='ok')));
    END IF;
    result:=jsonb_set(result,'{actions,can_undo}',to_jsonb(p.status='approved' AND p.decided_by=p_user
        AND p.execution->>'undo_id' IS NULL AND p.execution->>'status'='succeeded' AND p.decided_at>now()-INTERVAL '15 minutes'
        AND EXISTS(SELECT FROM jsonb_array_elements(COALESCE(p.execution->'rollback_items','[]')) WHERE backend_api.reversible_item(value))));
    RETURN result;
END $$;

ALTER FUNCTION backend_api.decide_proposal(UUID,BOOLEAN,TEXT,INT,UUID,TEXT) RENAME TO decide_proposal_v1;
CREATE FUNCTION backend_api.decide_proposal(p_id UUID,p_approve BOOLEAN,p_reason TEXT,p_version INT,p_key UUID,p_token TEXT,p_picked JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,deanery AS $$
DECLARE uid INT:=agent_backend.proposal_actor(p_token); p agent_backend.proposal; saved agent_backend.idempotency_record;
    v_route TEXT:='/proposal/'||p_id::TEXT||'/decision'; v_hash BYTEA; item JSONB; result JSONB; applied JSONB:='[]'; rollback JSONB:='[]';
    before JSONB; command JSONB; selected INT; original_version INT;
BEGIN
    PERFORM pg_advisory_xact_lock(9174,1);
    SELECT * INTO p FROM agent_backend.proposal WHERE id=p_id FOR UPDATE;
    IF NOT FOUND OR NOT agent_backend.proposal_visible(p,uid) THEN RAISE EXCEPTION 'Proposal missing' USING ERRCODE='P6006'; END IF;
    IF p.kind<>'batch' THEN
        IF p_picked IS NOT NULL THEN RAISE EXCEPTION 'Selection requires batch' USING ERRCODE='22023'; END IF;
        original_version:=p.version;
        result:=backend_api.decide_proposal_v1(p_id,p_approve,p_reason,p_version,p_key,p_token);
        SELECT * INTO p FROM agent_backend.proposal WHERE id=p_id;
        IF p_approve AND p.version<>original_version AND p.kind IN ('record_change','sql_change') AND p.command->>'operation' IN ('create','update') THEN
            rollback:=jsonb_build_array(backend_api.rollback_item(p.command,p.preview->'before',p.execution->'applied',1));
            UPDATE agent_backend.proposal SET execution=execution||jsonb_build_object('rollback_items',rollback) WHERE id=p_id RETURNING * INTO p;
        END IF;
        RETURN agent_backend.proposal_view(p,uid);
    END IF;
    IF p_key IS NULL OR p_approve IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 2000 OR p_reason IS NULL THEN
        RAISE EXCEPTION 'Invalid decision' USING ERRCODE='22023'; END IF;
    IF p_approve AND (jsonb_typeof(p_picked) IS DISTINCT FROM 'array' OR jsonb_array_length(p_picked) NOT BETWEEN 1 AND 200) THEN
        RAISE EXCEPTION 'Select batch items' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT FROM jsonb_array_elements(COALESCE(p_picked,'[]')) x WHERE jsonb_typeof(x)<>'number' OR x::TEXT !~ '^[1-9][0-9]*$') OR
        (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(COALESCE(p_picked,'[]')) x) THEN
        RAISE EXCEPTION 'Invalid selection' USING ERRCODE='22023'; END IF;
    v_hash:=sha256(convert_to(jsonb_build_array(p_approve,p_reason,p_version,p_picked)::TEXT,'UTF8'));
    SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=uid AND route=v_route AND key=p_key;
    IF FOUND THEN
        IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='P6001'; END IF;
        RETURN agent_backend.proposal_view(p,uid);
    END IF;
    IF p.assignee_user_id IS DISTINCT FROM uid OR NOT agent_backend.proposal_eligible(p,uid) THEN
        RAISE EXCEPTION 'Decision forbidden' USING ERRCODE='42501'; END IF;
    IF p.status<>'pending' THEN RAISE EXCEPTION 'Proposal decided' USING ERRCODE='P6004'; END IF;
    IF p_version IS NOT NULL AND p.version<>p_version THEN RAISE EXCEPTION 'Proposal changed' USING ERRCODE='P6005'; END IF;
    IF p.expires_at<=now() THEN RAISE EXCEPTION 'Proposal expired' USING ERRCODE='P6002'; END IF;
    IF p_approve THEN
        PERFORM backend_api.command_lock(p.command);
        FOR selected IN SELECT value::TEXT::INT FROM jsonb_array_elements(p_picked) LOOP
            SELECT value INTO item FROM jsonb_array_elements(p.command->'items') WHERE value->>'item_id'=selected::TEXT;
            IF item IS NULL THEN RAISE EXCEPTION 'Unknown selected item' USING ERRCODE='22023'; END IF;
            IF agent_backend.item_state(p,item)<>'ok' THEN
                RAISE EXCEPTION 'Строка пакета % изменилась или недоступна',selected USING ERRCODE='P6202',DETAIL=jsonb_build_object('item_id',selected)::TEXT; END IF;
        END LOOP;
        FOR item IN SELECT value FROM jsonb_array_elements(p.command->'items') WHERE p_picked @> jsonb_build_array((value->>'item_id')::INT) LOOP
            command:=item->'command'; before:=backend_api.command_row(command);
            result:=backend_api.command_execute(command,p.initiator_user_id,uid,p.agent_request_id,p.id);
            applied:=applied||jsonb_build_object('item_id',(item->>'item_id')::INT,'record',result);
            rollback:=rollback||backend_api.rollback_item(command,CASE WHEN command->>'operation'='create' THEN NULL ELSE before END,result,(item->>'item_id')::INT);
        END LOOP;
        SET CONSTRAINTS ALL IMMEDIATE;
        -- Snapshots and audit markers represent the final batch, including disjoint edits of one row.
        FOR item IN SELECT jsonb_array_elements(rollback) LOOP
            command:=item->'command'; result:=backend_api.command_row(command);
            item:=backend_api.rollback_item(command,item->'before',result,(item->>'item_id')::INT)||jsonb_build_object('created',item->'created');
            rollback:=jsonb_set(rollback,ARRAY[(SELECT (ord-1)::TEXT FROM jsonb_array_elements(rollback) WITH ORDINALITY e(v,ord) WHERE v->>'item_id'=item->>'item_id')],item);
        END LOOP;
    END IF;
    UPDATE agent_backend.proposal SET status=CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
        decided_by=uid,decided_at=now(),decision_reason=btrim(p_reason),version=version+1,
        execution=CASE WHEN p_approve THEN jsonb_build_object('status','succeeded','started_at',now(),'completed_at',now(),
            'applied',applied,'rollback_items',rollback,'picked_item_ids',p_picked) ELSE execution END WHERE id=p_id RETURNING * INTO p;
    INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,reason,data)
        VALUES(p_id,uid,p.status,p_reason,jsonb_build_object('picked_item_ids',p_picked));
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash,response_status,response_body)
        VALUES(uid,v_route,p_key,v_hash,200,jsonb_build_object('id',p_id));
    RETURN agent_backend.proposal_view(p,uid);
END $$;
CREATE FUNCTION backend_api.decide_proposal(p_id UUID,p_approve BOOLEAN,p_reason TEXT,p_version INT,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
    SELECT backend_api.decide_proposal(p_id,p_approve,p_reason,p_version,p_key,p_token,NULL)
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA backend_api,agent_backend FROM PUBLIC;
-- Repeat the dependency closure for new invoker wrappers, stopping at service definers.
DO $$ DECLARE f RECORD; BEGIN
    FOR f IN WITH RECURSIVE needed(oid) AS (
        SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('backend_api','agent_backend') AND p.proname IN
            ('decide_proposal','command_preview','create_correction','prepare_proposal_as','prepare_run_proposal')
        UNION
        SELECT child.oid FROM needed a JOIN pg_proc parent ON parent.oid=a.oid
            CROSS JOIN LATERAL regexp_matches(parent.prosrc,'((backend_api|agent_backend)\.[a-z_]+)[[:space:]]*\(','g') m
            JOIN pg_proc child ON TRUE JOIN pg_namespace ns ON ns.oid=child.pronamespace
            WHERE NOT parent.prosecdef AND ns.nspname||'.'||child.proname=m[1]
    ) SELECT p.oid::regprocedure AS signature FROM needed n JOIN pg_proc p ON p.oid=n.oid
    LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO backend_api,backend_executor',f.signature); END LOOP;
END $$;
