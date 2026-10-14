CREATE OR REPLACE VIEW backend_api.v_current_modules AS
    SELECT DISTINCT ON (gr.student_id,ci.discipline_id,ci.semester,gs.stage)
        gr.grade_id,gr.student_id,gs.sheet_id,gs.sheet_number,gs.stage,gs.status,gs.group_id,
        ci.discipline_id,d.name AS discipline,ci.semester,gr.points,gr.is_absent
    FROM deanery.grade gr JOIN deanery.grade_sheet gs USING(sheet_id) JOIN deanery.curriculum_item ci USING(item_id)
        JOIN deanery.discipline d USING(discipline_id) JOIN deanery.student s USING(student_id)
        JOIN deanery.study_group g ON g.group_id=s.group_id
        JOIN deanery.curriculum c ON c.curriculum_id=g.curriculum_id
    WHERE gs.stage IN ('module_1','module_2') AND gs.status<>'cancelled'
        AND ci.semester=deanery.fn_semester(c.start_year,CURRENT_DATE)
    ORDER BY gr.student_id,ci.discipline_id,ci.semester,gs.stage,gs.exam_date DESC NULLS LAST,gs.sheet_id DESC;


CREATE OR REPLACE FUNCTION backend_api.audit_in_scope(p_audit BIGINT,p_user INT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; l audit_log; key JSONB; current_row JSONB; old_row JSONB; changes JSONB;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(p_user) WHERE is_active;
    IF a.role_code NOT IN ('admin','director','dean_staff') THEN RETURN FALSE; END IF;
    IF a.role_code='admin' THEN RETURN TRUE; END IF;
    SELECT * INTO l FROM audit_log WHERE audit_id=p_audit;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    SELECT jsonb_object_agg(split_part(part,'=',1),substring(part FROM position('=' IN part)+1))
        INTO key FROM unnest(string_to_array(l.record_key,', ')) part;
    EXECUTE format('SELECT to_jsonb(r) FROM deanery.%I r WHERE to_jsonb(r) @> to_jsonb(jsonb_populate_record(NULL::deanery.%I,$1)) - ARRAY(SELECT attname FROM pg_attribute WHERE attrelid=$2::regclass AND attnum>0 AND NOT attisdropped AND NOT $1 ? attname)',l.table_name,l.table_name)
        INTO current_row USING key,format('deanery.%I',l.table_name);
    SELECT jsonb_object_agg(column_name,to_jsonb(old_value)) INTO changes FROM audit_log_detail WHERE audit_id=p_audit;
    old_row:=CASE WHEN l.operation='D' THEN changes ELSE current_row || changes END;
    IF l.table_name='person' THEN
        RETURN EXISTS(SELECT FROM student s JOIN backend_api.allowed_students(p_user) allowed USING(student_id)
            WHERE s.person_id=COALESCE((current_row->>'person_id')::INT,(old_row->>'person_id')::INT))
            OR backend_api.record_in_scope('person',COALESCE(current_row,old_row),p_user,a.role_code);
    END IF;
    RETURN CASE WHEN l.operation='D' THEN backend_api.record_in_scope(l.table_name,old_row,p_user,a.role_code)
        WHEN l.operation='I' THEN backend_api.record_in_scope(l.table_name,current_row,p_user,a.role_code)
        ELSE backend_api.record_in_scope(l.table_name,current_row,p_user,a.role_code)
            AND backend_api.record_in_scope(l.table_name,old_row,p_user,a.role_code) END;
EXCEPTION WHEN invalid_text_representation OR undefined_table THEN RETURN FALSE;
END $$;

CREATE OR REPLACE FUNCTION backend_api.olap_dataset(p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; result JSONB;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(agent_backend.proposal_actor(p_token));
    IF a.role_code NOT IN ('admin','director','dean_staff','teacher') THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    WITH students AS MATERIALIZED (
        SELECT s.student_id,fn_full_name(p) AS student,s.group_id,g.name AS group_name,s.status_id,
            fn_course(c.start_year,CURRENT_DATE) AS course,fn_semester(c.start_year,CURRENT_DATE) AS current_semester
        FROM student s JOIN person p USING(person_id) JOIN study_group g USING(group_id)
            JOIN curriculum c ON c.curriculum_id=g.curriculum_id
        WHERE s.group_id IN (SELECT group_id FROM backend_api.allowed_groups(a.user_id))
    ), results AS (
        SELECT lr.*,s.group_id,s.group_name,s.student,s.course,s.status_id,d.name AS discipline,
            ct.is_graded,fn_mark(lr.points) AS mark,gs.sheet_kind
        FROM v_last_result lr JOIN students s USING(student_id) JOIN discipline d USING(discipline_id)
            JOIN curriculum_item ci USING(item_id) JOIN control_type ct USING(control_type_id)
            JOIN grade_sheet gs USING(sheet_id) WHERE lr.stage='final'
    ), attempts AS (
        SELECT gr.grade_id,gr.student_id,gr.points,gr.is_absent,gs.sheet_kind,gs.sheet_id,gs.exam_date,
            ci.discipline_id,d.name AS discipline,ci.semester,s.group_id,s.group_name,s.course,s.status_id
        FROM grade gr JOIN grade_sheet gs USING(sheet_id) JOIN curriculum_item ci USING(item_id)
            JOIN discipline d USING(discipline_id) JOIN students s USING(student_id)
        WHERE gs.status<>'cancelled' AND gs.stage='final'
    ), modules AS (
        SELECT DISTINCT ON (gr.student_id,ci.discipline_id,ci.semester)
            gr.student_id,ci.discipline_id,d.name AS discipline,ci.semester,gr.points,gr.is_absent
        FROM grade gr JOIN grade_sheet gs USING(sheet_id) JOIN curriculum_item ci USING(item_id)
            JOIN discipline d USING(discipline_id) JOIN students s USING(student_id)
        WHERE gs.status<>'cancelled' AND gs.stage='module_1' AND ci.semester=s.current_semester
        ORDER BY gr.student_id,ci.discipline_id,ci.semester,gs.exam_date DESC NULLS LAST,gs.sheet_id DESC
    ), presence AS (
        SELECT at.student_id,ci.discipline_id,at.is_present,ci.semester
        FROM attendance at JOIN schedule_slot ss USING(slot_id) JOIN teaching_assignment ta USING(assignment_id)
            JOIN curriculum_item ci USING(item_id) JOIN students s USING(student_id)
            JOIN academic_term term USING(term_id)
        WHERE ci.semester=s.current_semester AND CURRENT_DATE BETWEEN term.start_date AND term.session_end
    ), debts AS (
        SELECT d.* FROM v_debtors d JOIN students s USING(student_id)
    ), orders AS (
        SELECT o.order_id,o.order_number,o.order_date,o.effective_date,ot.code AS order_type_code,ot.name AS order_type,
            os.student_id,os.applied_at,s.group_id,s.group_name,s.student,s.course
        FROM academic_order o JOIN order_type ot USING(order_type_id) JOIN order_student os USING(order_id)
            JOIN students s USING(student_id)
    ) SELECT jsonb_build_object('students',COALESCE((SELECT jsonb_agg(s) FROM students s),'[]'),
        'results',COALESCE((SELECT jsonb_agg(r) FROM results r),'[]'),
        'attempts',COALESCE((SELECT jsonb_agg(r) FROM attempts r),'[]'),
        'modules',COALESCE((SELECT jsonb_agg(r) FROM modules r),'[]'),
        'attendance',COALESCE((SELECT jsonb_agg(r) FROM presence r),'[]'),
        'debts',COALESCE((SELECT jsonb_agg(r) FROM debts r),'[]'),
        'orders',COALESCE((SELECT jsonb_agg(r) FROM orders r),'[]')) INTO result;
    RETURN result;
END $$;

CREATE OR REPLACE FUNCTION backend_api.decide_proposal(p_id UUID,p_approve BOOLEAN,p_reason TEXT,p_version INT,p_key UUID,p_token TEXT,p_picked JSONB) RETURNS JSONB
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

-- A successful replay does not require a still-open sheet; no new write occurs.
DO $fix$ DECLARE definition TEXT; guard TEXT; BEGIN
    SELECT pg_get_functiondef('backend_api.decide_proposal_v1(uuid,boolean,text,integer,uuid,text)'::regprocedure) INTO definition;
    guard:=$guard$    IF p.assignee_user_id IS DISTINCT FROM v_user OR NOT agent_backend.proposal_eligible(p,v_user) THEN
        RAISE EXCEPTION 'Decision forbidden' USING ERRCODE='42501'; END IF;
$guard$;
    IF position(guard IN definition)=0 THEN RAISE EXCEPTION 'Decision guard changed'; END IF;
    definition:=replace(definition,guard,'');
    definition:=replace(definition,$target$    IF p.status<>'pending' THEN$target$,guard||$target$    IF p.status<>'pending' THEN$target$);
    EXECUTE definition;
END $fix$;

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

-- Lock rows before comparing their before/after images, including concurrent forms.
DO $fix$ DECLARE definition TEXT; needle TEXT; BEGIN
    SELECT pg_get_functiondef('backend_api.undo_proposal(uuid,uuid,text)'::regprocedure) INTO definition;
    needle:=$needle$    FOR item IN SELECT jsonb_array_elements(COALESCE(p.execution->'rollback_items','[]')) LOOP$needle$;
    IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Undo validator changed'; END IF;
    IF position('PERFORM backend_api.command_lock(p.command);' IN definition)=0 THEN
        EXECUTE replace(definition,needle,'    PERFORM backend_api.command_lock(p.command);'||E'\n'||needle);
    END IF;
END $fix$;
