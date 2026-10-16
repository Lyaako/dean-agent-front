-- Р1: grade_correction.decision_comment is VARCHAR(500); check it before the native procedure.
DO $fix$ DECLARE definition TEXT; needle TEXT; BEGIN
    SELECT pg_get_functiondef('backend_api.decide_proposal_v1(uuid,boolean,text,integer,uuid,text)'::regprocedure) INTO definition;
    needle:=$needle$        CALL deanery.sp_decide_grade_correction(p.correction_id,p_approve,btrim(p_reason));$needle$;
    IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Correction decision changed; operator review required'; END IF;
    EXECUTE replace(definition,needle,$check$        IF length(btrim(p_reason)) NOT BETWEEN 10 AND 500 THEN
            RAISE EXCEPTION 'Комментарий к решению по исправлению оценки — от 10 до 500 символов' USING ERRCODE='P6205',
                DETAIL=jsonb_build_object('field','reason','max',500)::TEXT; END IF;
$check$||needle);
END $fix$;

-- Р3: the transfer reason follows the product rule of 10–2000 characters.
DO $fix$ DECLARE definition TEXT; needle TEXT; BEGIN
    SELECT pg_get_functiondef('backend_api.assign_proposal(uuid,integer,text,integer,uuid,text)'::regprocedure) INTO definition;
    needle:='length(btrim(p_reason)) NOT BETWEEN 1 AND 2000';
    IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Assignment validator changed; operator review required'; END IF;
    EXECUTE replace(definition,needle,'length(btrim(p_reason)) NOT BETWEEN 10 AND 2000');
END $fix$;

-- Р9: one source for undo availability; NULL means the row can be reverted.
CREATE FUNCTION backend_api.undo_reason(item JSONB) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE c JSONB:=item->'command'; resource TEXT:=c->>'resource'; fields JSONB:=c->'fields';
BEGIN
    IF COALESCE((item->>'created')::BOOLEAN,TRUE) OR item->'before' IS NULL OR item->'before'='null'::JSONB THEN
        RETURN 'irreversible'; END IF;
    IF NOT COALESCE(CASE resource
        WHEN 'academic_work' THEN fields-'topic'='{}'::JSONB
        WHEN 'student' THEN fields-'needs_dormitory'='{}'::JSONB
        WHEN 'schedule_slot' THEN fields-ARRAY['classroom_id','weekday','pair_number']='{}'::JSONB
        WHEN 'attendance' THEN fields-ARRAY['is_present','absence_reason']='{}'::JSONB
        WHEN 'grade' THEN fields-ARRAY['points','is_absent']='{}'::JSONB
        WHEN 'document_request' THEN fields-'request_status_id'='{}'::JSONB
        ELSE FALSE END,FALSE) THEN RETURN 'irreversible'; END IF;
    IF resource='grade' AND NOT EXISTS(SELECT FROM grade_sheet
        WHERE sheet_id=(item->'after'->>'sheet_id')::INT AND status='open') THEN RETURN 'sheet_closed'; END IF;
    IF resource='document_request' AND COALESCE((SELECT bool_or(is_final) FROM request_status WHERE request_status_id IN
        ((item->'before'->>'request_status_id')::INT,(item->'after'->>'request_status_id')::INT)),FALSE) THEN
        RETURN 'request_final'; END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION backend_api.reversible_item(item JSONB) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT backend_api.undo_reason(item) IS NULL
$$;

-- Р4: the author may repeat an expired or rejected agent request unless the chat was deleted.
CREATE FUNCTION agent_backend.proposal_request_text(p agent_backend.proposal,p_user INT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT r.request_text FROM agent_request r
    WHERE p.initiator_user_id=p_user AND p.run_id IS NOT NULL AND r.agent_request_id=p.agent_request_id
$$;

ALTER FUNCTION agent_backend.proposal_view(agent_backend.proposal,INT) RENAME TO proposal_view_v2;
CREATE FUNCTION agent_backend.proposal_view(p agent_backend.proposal,p_user INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE result JSONB; item JSONB; items JSONB:='[]'; applied JSONB; reason TEXT; open_window BOOLEAN; request TEXT;
BEGIN
    result:=agent_backend.proposal_view_v2(p,p_user);
    request:=agent_backend.proposal_request_text(p,p_user);
    result:=jsonb_set(result,'{actions,can_redo}',to_jsonb(COALESCE(request IS DISTINCT FROM 'Переписка удалена'
        AND request IS NOT NULL AND (result->'validity'->>'state'='expired' OR p.status='rejected'),FALSE)));
    IF p.kind='batch' THEN
        open_window:=p.status='approved' AND p.execution->>'status'='succeeded' AND p.execution->>'undo_id' IS NULL
            AND p.decided_at>now()-INTERVAL '15 minutes';
        FOR item IN SELECT jsonb_array_elements(result->'items') LOOP
            IF p.status='approved' THEN
                SELECT value INTO applied FROM jsonb_array_elements(COALESCE(p.execution->'rollback_items','[]'))
                    WHERE value->>'item_id'=item->>'item_id';
                reason:=CASE WHEN applied IS NULL THEN NULL ELSE backend_api.undo_reason(applied) END;
                IF applied IS NOT NULL AND reason IS NULL AND NOT open_window THEN reason:='expired'; END IF;
                item:=item||jsonb_build_object('reversible',applied IS NOT NULL AND reason IS NULL,'undo_reason',reason);
            ELSE
                SELECT value INTO applied FROM jsonb_array_elements(p.command->'items') WHERE value->>'item_id'=item->>'item_id';
                reason:=backend_api.undo_reason(jsonb_build_object('command',applied->'command','before',item->'before',
                    'after',COALESCE(item->'before','{}'::JSONB)||COALESCE(item->'after','{}'::JSONB),
                    'created',applied->'command'->>'operation'='create'));
                item:=item||jsonb_build_object('reversible',reason IS NULL,'undo_reason',reason);
            END IF;
            items:=items||item;
        END LOOP;
        result:=result||jsonb_build_object('items',items);
    END IF;
    RETURN result;
END $$;

CREATE OR REPLACE FUNCTION backend_api.get_proposal(p_id UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE p agent_backend.proposal; v_user INT:=agent_backend.proposal_actor(p_token);
BEGIN
    SELECT * INTO p FROM agent_backend.proposal WHERE id=p_id;
    IF NOT FOUND OR NOT agent_backend.proposal_visible(p,v_user) THEN RAISE EXCEPTION 'Proposal missing' USING ERRCODE='P6006'; END IF;
    RETURN agent_backend.proposal_view(p,v_user)||jsonb_build_object('request_text',agent_backend.proposal_request_text(p,v_user));
END $$;

-- Р8/Р9: undo exactly the selected applied rows in one transaction; every refusal names its reason.
CREATE FUNCTION backend_api.undo_proposal(p_id UUID,p_key UUID,p_token TEXT,p_picked JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,deanery AS $$
DECLARE uid INT:=agent_backend.proposal_actor(p_token); p agent_backend.proposal; inverse agent_backend.proposal;
    saved agent_backend.idempotency_record; v_route TEXT:='/proposal/'||p_id::TEXT||'/undo'; v_hash BYTEA;
    item JSONB; c JSONB; current_row JSONB; fields JSONB; commands JSONB:='[]'; skipped JSONB:='[]';
    preview JSONB:='[]'; applied JSONB:='[]'; rollback JSONB:='[]'; v_snapshot JSONB; result JSONB;
    audit_marker BIGINT; record_key TEXT; v_inverse UUID:=gen_random_uuid(); rid INT;
    reason TEXT; reasons TEXT[]:='{}'; failure TEXT;
BEGIN
    IF p_picked IS NOT NULL THEN
        IF jsonb_typeof(p_picked)<>'array' OR jsonb_array_length(p_picked)=0
           OR EXISTS(SELECT FROM jsonb_array_elements(p_picked) x WHERE jsonb_typeof(x)<>'number' OR x::TEXT !~ '^[1-9][0-9]{0,9}$')
           OR (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(p_picked) x) THEN
            RAISE EXCEPTION 'Выберите применённые строки для отмены' USING ERRCODE='P6205',
                DETAIL=jsonb_build_object('field','picked_item_ids')::TEXT; END IF;
        SELECT jsonb_agg(x ORDER BY x::TEXT::BIGINT) INTO p_picked FROM jsonb_array_elements(p_picked) x;
    END IF;
    PERFORM pg_advisory_xact_lock(9174,1);
    SELECT * INTO p FROM agent_backend.proposal WHERE id=p_id FOR UPDATE;
    IF NOT FOUND OR p.decided_by IS DISTINCT FROM uid OR NOT agent_backend.proposal_visible(p,uid) THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    -- Without a selection the key keeps its previous meaning: all reversible rows.
    v_hash:=sha256(convert_to(CASE WHEN p_picked IS NULL THEN p_id::TEXT ELSE jsonb_build_array(p_id,p_picked)::TEXT END,'UTF8'));
    SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=uid AND route=v_route AND key=p_key;
    IF FOUND THEN
        IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='P6001'; END IF;
        SELECT * INTO inverse FROM agent_backend.proposal WHERE id=(saved.response_body->>'id')::UUID;
        RETURN agent_backend.proposal_view(inverse,uid);
    END IF;
    IF p.status<>'approved' OR p.execution->>'status'<>'succeeded' THEN
        RAISE EXCEPTION 'Это изменение уже нельзя отменить' USING ERRCODE='P6204',
            DETAIL=jsonb_build_object('reason','irreversible')::TEXT; END IF;
    IF p.execution->>'undo_id' IS NOT NULL OR p.decided_at<=now()-INTERVAL '15 minutes' THEN
        RAISE EXCEPTION 'Это изменение уже нельзя отменить' USING ERRCODE='P6204',
            DETAIL=jsonb_build_object('reason','expired')::TEXT; END IF;
    PERFORM backend_api.command_lock(p.command);
    IF p_picked IS NOT NULL AND EXISTS(SELECT FROM jsonb_array_elements(p_picked) x WHERE NOT EXISTS(
        SELECT FROM jsonb_array_elements(COALESCE(p.execution->'rollback_items','[]')) r WHERE r->>'item_id'=x::TEXT)) THEN
        RAISE EXCEPTION 'Можно отменить только применённые строки' USING ERRCODE='P6205',
            DETAIL=jsonb_build_object('field','picked_item_ids')::TEXT; END IF;
    FOR item IN SELECT jsonb_array_elements(COALESCE(p.execution->'rollback_items','[]')) LOOP
        IF p_picked IS NOT NULL AND NOT p_picked @> jsonb_build_array((item->>'item_id')::INT) THEN CONTINUE; END IF;
        reason:=backend_api.undo_reason(item);
        IF reason IS NOT NULL THEN
            IF p_picked IS NOT NULL THEN
                RAISE EXCEPTION 'Строку % отменить нельзя',item->>'item_id' USING ERRCODE='P6204',
                    DETAIL=jsonb_build_object('item_id',(item->>'item_id')::INT,'reason',reason)::TEXT; END IF;
            skipped:=skipped||jsonb_build_object('item_id',item->'item_id','code','undo_unavailable','reason',reason);
            reasons:=reasons||reason; CONTINUE;
        END IF;
        c:=item->'command'; current_row:=backend_api.command_row(c);
        SELECT string_agg(k||'='||v,', ' ORDER BY k) INTO record_key FROM jsonb_each_text(c->'key') e(k,v);
        audit_marker:=backend_api.record_audit(c);
        IF current_row IS DISTINCT FROM item->'after' OR audit_marker IS DISTINCT FROM (item->>'audit_id')::BIGINT THEN
            RAISE EXCEPTION 'После применения строка % была изменена',item->>'item_id' USING ERRCODE='P6203',
                DETAIL=jsonb_build_object('item_id',(item->>'item_id')::INT,'reason','changed')::TEXT; END IF;
        SELECT jsonb_object_agg(k,item->'before'->k) INTO fields FROM jsonb_object_keys(c->'fields') k;
        c:=jsonb_set(c,'{fields}',fields);
        IF NOT backend_api.command_authorized(c,uid,'prepare',p.institute_id) OR NOT backend_api.command_authorized(c,uid,'execute',p.institute_id) THEN
            RAISE EXCEPTION 'Право на обратное изменение утрачено' USING ERRCODE='P6204',
                DETAIL=jsonb_build_object('item_id',(item->>'item_id')::INT,'reason','irreversible')::TEXT; END IF;
        commands:=commands||jsonb_build_object('item_id',item->'item_id','command',c);
        preview:=preview||jsonb_build_object('item_id',item->'item_id','table',c->>'resource','operation','UPDATE',
            'before',current_row,'after',current_row||fields,'changed_columns',ARRAY(SELECT jsonb_object_keys(fields)));
    END LOOP;
    IF jsonb_array_length(commands)=0 THEN
        RAISE EXCEPTION 'Нет обратимых строк для отмены' USING ERRCODE='P6204',
            DETAIL=jsonb_build_object('reason',CASE WHEN cardinality(reasons)>0 AND reasons<@ARRAY[reasons[1]]
                THEN reasons[1] ELSE 'irreversible' END)::TEXT; END IF;
    rid:=backend_api.manual_request(p_token,'Отмена применённых изменений через форму');
    c:=backend_api.command_normalize(jsonb_build_object('version',1,'kind','batch','items',commands),uid);
    PERFORM backend_api.command_lock(c);
    v_snapshot:=backend_api.command_snapshot(c,uid);
    FOR item IN SELECT jsonb_array_elements(commands) LOOP
        current_row:=backend_api.command_row(item->'command');
        BEGIN
            result:=backend_api.command_execute(item->'command',uid,uid,rid,v_inverse);
        EXCEPTION WHEN raise_exception OR integrity_constraint_violation THEN
            -- A database rule refused this row (for example, the classroom is taken): undo nothing.
            GET STACKED DIAGNOSTICS failure=MESSAGE_TEXT;
            RAISE EXCEPTION '%',failure USING ERRCODE='P6204',
                DETAIL=jsonb_build_object('item_id',(item->>'item_id')::INT,'reason','conflict')::TEXT;
        END;
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
            'undo_of',p.id,'skipped',skipped,'picked_item_ids',p_picked),uid,now(),'Отмена пользователем, применившим предложение') RETURNING * INTO inverse;
    UPDATE agent_backend.proposal SET execution=execution||jsonb_build_object('undo_id',v_inverse,'undone_at',now(),'undo_skipped',skipped),
        version=version+1 WHERE id=p_id;
    INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,reason,data)
        VALUES(p_id,uid,'undone','Отмена применённых обратимых строк',jsonb_build_object('inverse_proposal_id',v_inverse,'skipped',skipped,'picked_item_ids',p_picked)),
            (v_inverse,uid,'approved','Обратное изменение применено',jsonb_build_object('undo_of',p_id));
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash,response_status,response_body)
        VALUES(uid,v_route,p_key,v_hash,200,jsonb_build_object('id',v_inverse));
    RETURN agent_backend.proposal_view(inverse,uid);
END $$;

CREATE OR REPLACE FUNCTION backend_api.undo_proposal(p_id UUID,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
    SELECT backend_api.undo_proposal(p_id,p_key,p_token,NULL)
$$;

-- Р6: the audit journal grouped by event; v_audit itself stays unchanged.
CREATE FUNCTION backend_api.audit_events(p_token TEXT,p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_table TEXT,p_operation TEXT,
    p_changed_by TEXT,p_source TEXT,p_limit INT,p_offset INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE uid INT:=agent_backend.proposal_actor(p_token); a RECORD; result JSONB;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(uid) WHERE is_active;
    IF NOT FOUND OR a.role_code NOT IN ('admin','director','dean_staff') THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    IF p_limit IS NULL OR p_offset IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR p_offset<0
       OR (p_operation IS NOT NULL AND p_operation NOT IN ('I','U','D'))
       OR (p_source IS NOT NULL AND p_source NOT IN ('ui','agent')) THEN
        RAISE EXCEPTION 'Invalid audit filter' USING ERRCODE='22023'; END IF;
    WITH events AS (
        SELECT l.audit_id,l.changed_at,l.table_name,l.record_key,l.operation,l.agent_request_id,
            COALESCE(u.login,l.db_user) AS changed_by,NULLIF(fn_full_name(n),'') AS changed_by_name,
            CASE WHEN EXISTS(SELECT FROM agent_backend.agent_run r WHERE r.agent_request_id=l.agent_request_id)
                THEN 'agent' ELSE 'ui' END AS source
        FROM audit_log l LEFT JOIN app_user u ON u.user_id=l.app_user_id LEFT JOIN person n ON n.person_id=u.person_id
        WHERE (p_from IS NULL OR l.changed_at>=p_from) AND (p_to IS NULL OR l.changed_at<=p_to)
          AND (p_table IS NULL OR l.table_name=p_table) AND (p_operation IS NULL OR l.operation=p_operation)
          AND (p_changed_by IS NULL OR COALESCE(u.login,l.db_user)=p_changed_by)
          AND EXISTS(SELECT FROM audit_log_detail d WHERE d.audit_id=l.audit_id)
    ), page AS (
        SELECT * FROM events e WHERE (p_source IS NULL OR e.source=p_source)
          AND (a.role_code='admin' OR backend_api.audit_in_scope(e.audit_id,uid))
        ORDER BY e.changed_at DESC,e.audit_id DESC LIMIT p_limit+1 OFFSET p_offset
    )
    SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object('audit_id',e.audit_id::TEXT,
            'changed_at',e.changed_at,'table_name',e.table_name,'record_key',e.record_key,'operation',e.operation,
            'changed_by',e.changed_by,'changed_by_name',e.changed_by_name,'source',e.source,
            'proposal_id',(SELECT pr.id FROM agent_backend.proposal pr WHERE pr.agent_request_id=e.agent_request_id
                ORDER BY pr.decided_at=e.changed_at DESC NULLS LAST,pr.decided_at DESC NULLS LAST,pr.created_at DESC LIMIT 1),
            'changes',(SELECT jsonb_agg(jsonb_build_object('column',d.column_name,
                    'old',CASE WHEN d.column_name IN ('password_hash','passport_series','passport_number','snils','inn','birth_date','address')
                        AND d.old_value IS NOT NULL THEN '***' ELSE d.old_value END,
                    'new',CASE WHEN d.column_name IN ('password_hash','passport_series','passport_number','snils','inn','birth_date','address')
                        AND d.new_value IS NOT NULL THEN '***' ELSE d.new_value END) ORDER BY d.column_name)
                FROM audit_log_detail d WHERE d.audit_id=e.audit_id))
            ORDER BY e.changed_at DESC,e.audit_id DESC)
            FROM (SELECT * FROM page ORDER BY changed_at DESC,audit_id DESC LIMIT p_limit) e),'[]'::JSONB),
        'limit',p_limit,'offset',p_offset,'has_more',(SELECT count(*)>p_limit FROM page)) INTO result;
    RETURN result;
END $$;

REVOKE ALL ON FUNCTION backend_api.undo_reason(JSONB),agent_backend.proposal_request_text(agent_backend.proposal,INT),
    agent_backend.proposal_view(agent_backend.proposal,INT),
    backend_api.undo_proposal(UUID,UUID,TEXT,JSONB),backend_api.audit_events(TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT,INT,INT)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.undo_reason(JSONB),agent_backend.proposal_request_text(agent_backend.proposal,INT),
    agent_backend.proposal_view(agent_backend.proposal,INT) TO backend_api,backend_executor;
GRANT EXECUTE ON FUNCTION backend_api.undo_proposal(UUID,UUID,TEXT,JSONB),
    backend_api.audit_events(TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT,INT,INT) TO backend_api;
