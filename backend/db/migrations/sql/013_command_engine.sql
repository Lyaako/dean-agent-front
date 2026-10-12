CREATE OR REPLACE FUNCTION backend_api.command_normalize(p_command JSONB,p_author INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE c JSONB:=p_command; a RECORD; v_keys TEXT[]; k TEXT;
BEGIN
    PERFORM set_config('TimeZone','Europe/Moscow',TRUE);
    IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c->'version' IS DISTINCT FROM '1'::JSONB OR
       jsonb_typeof(c->'fields') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Invalid command' USING ERRCODE='22023';
    END IF;
    IF c->>'kind' IN ('special_command','grade_correction') THEN
        RETURN backend_api.special_normalize(c,p_author);
    ELSIF c->>'kind'='sql_change' THEN
        RETURN backend_api.root_change_normalize(c,p_author);
    ELSIF c->>'kind'='record_change' THEN
        v_keys:=ARRAY['version','kind','resource','operation','key','fields'];
        IF c->>'resource' NOT IN ('student','study_group','schedule_slot','academic_work','practice_placement',
                                  'document_request','employee','person') OR c->>'resource' IS NULL OR
           c->>'operation' NOT IN ('create','update','delete') OR c->>'operation' IS NULL OR
           jsonb_typeof(c->'key') IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'Unsupported command' USING ERRCODE='22023';
        END IF;
        SELECT * INTO a FROM backend_api.account_snapshot(p_author);
        IF a.role_code='student' AND c->>'resource'='document_request' AND c->>'operation'='create'
           AND NOT c->'fields' ? 'student_id' THEN
            c:=jsonb_set(c,'{fields,student_id}',to_jsonb(a.student_id));
        END IF;
    ELSIF c->>'kind'='workflow' THEN
        v_keys:=ARRAY['version','kind','name','fields'];
        IF c->>'name' NOT IN ('enroll_student','transfer_student','expel_student','grant_academic_leave',
                              'return_from_leave','reinstate_student') OR c->>'name' IS NULL THEN
            RAISE EXCEPTION 'Unsupported workflow' USING ERRCODE='22023';
        END IF;
        IF c->>'name'<>'grant_academic_leave' AND NOT c->'fields' ? 'effective_date' THEN
            c:=jsonb_set(c,'{fields,effective_date}',to_jsonb(CURRENT_DATE::TEXT));
        END IF;
    ELSE RAISE EXCEPTION 'Unsupported command kind' USING ERRCODE='22023';
    END IF;
    FOR k IN SELECT jsonb_object_keys(c) LOOP
        IF NOT k=ANY(v_keys) THEN RAISE EXCEPTION 'Unexpected command field' USING ERRCODE='22023'; END IF;
    END LOOP;
    RETURN c;
END $$;

CREATE OR REPLACE FUNCTION backend_api.command_row(p_command JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_row JSONB;
BEGIN
    IF p_command->>'kind' IN ('special_command','grade_correction') THEN RETURN backend_api.special_row(p_command); END IF;
    IF p_command->>'kind' IN ('record_change','sql_change') THEN
        IF p_command->>'operation'='create' THEN RETURN p_command->'fields'; END IF;
        EXECUTE format('SELECT to_jsonb(t) FROM deanery.%I t WHERE to_jsonb(t) @> $1',p_command->>'resource')
            INTO v_row USING p_command->'key';
        RETURN v_row;
    END IF;
    SELECT to_jsonb(s) INTO v_row FROM deanery.student s
    WHERE s.student_id=(p_command->'fields'->>'student_id')::INT;
    RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION backend_api.command_institute(p_command JSONB) RETURNS INT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r JSONB:=backend_api.command_row(p_command); v_institute INT; v_employee INT;
BEGIN
    IF p_command->>'kind' IN ('special_command','grade_correction') THEN RETURN backend_api.special_institute(p_command); END IF;
    IF p_command->>'kind'='workflow' AND p_command->>'name'='enroll_student' THEN
        SELECT fn_group_institute(group_id) INTO v_institute FROM study_group
        WHERE name=p_command->'fields'->>'group_name';
    ELSIF p_command->>'kind'='workflow' OR p_command->>'resource'='student' THEN
        v_institute:=fn_group_institute((r->>'group_id')::INT);
    ELSIF p_command->>'resource' IN ('academic_work','practice_placement','document_request','grade','attendance') THEN
        SELECT fn_group_institute(group_id) INTO v_institute FROM student WHERE student_id=(r->>'student_id')::INT;
    ELSIF p_command->>'resource' IN ('grade_sheet','teaching_assignment') THEN
        v_institute:=fn_group_institute((r->>'group_id')::INT);
    ELSIF p_command->>'resource'='study_group' THEN
        SELECT d.institute_id INTO v_institute FROM curriculum c JOIN study_program p ON p.program_id=c.program_id
        JOIN department d ON d.department_id=p.department_id WHERE c.curriculum_id=(r->>'curriculum_id')::INT;
    ELSIF p_command->>'resource'='schedule_slot' THEN
        SELECT fn_group_institute(group_id) INTO v_institute FROM teaching_assignment WHERE assignment_id=(r->>'assignment_id')::INT;
    ELSIF p_command->>'resource' IN ('employee','person') THEN
        v_employee:=(r->>'employee_id')::INT;
        IF p_command->>'resource'='person' THEN
            SELECT employee_id INTO v_employee FROM employee WHERE person_id=(r->>'person_id')::INT;
        END IF;
        SELECT d.institute_id INTO v_institute FROM teacher t JOIN department d ON d.department_id=t.department_id
        WHERE t.employee_id=v_employee;
        IF v_institute IS NULL THEN
            SELECT institute_id INTO v_institute FROM dean_office_staff WHERE employee_id=v_employee;
        END IF;
        IF v_institute IS NULL THEN
            SELECT min(i.institute_id) INTO v_institute FROM (
                SELECT institute_id FROM institute WHERE director_id=v_employee
                UNION SELECT institute_id FROM department WHERE head_id=v_employee
                UNION SELECT fn_group_institute(group_id) FROM study_group WHERE curator_id=v_employee
            ) i;
        END IF;
    END IF;
    RETURN v_institute;
END $$;

CREATE OR REPLACE FUNCTION backend_api.command_authorized(p_command JSONB,p_user INT,p_mode TEXT,p_stored_institute INT DEFAULT NULL) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; r JSONB; v_group INT;
BEGIN
    IF p_command->>'kind' IN ('special_command','grade_correction') THEN
        RETURN backend_api.special_authorized(p_command,p_user,p_mode,p_stored_institute);
    ELSIF p_command->>'kind'='sql_change' THEN
        RETURN backend_api.root_change_authorized(p_command,p_user,p_mode,p_stored_institute);
    END IF;
    SELECT * INTO a FROM backend_api.account_snapshot(p_user) WHERE is_active;
    IF NOT FOUND OR p_mode NOT IN ('prepare','execute') OR p_mode IS NULL THEN RETURN FALSE; END IF;
    IF p_command->>'kind'='workflow' THEN
        IF a.role_code NOT IN ('admin','director','dean_staff') OR p_command->>'name' NOT IN (
            'enroll_student','transfer_student','expel_student','grant_academic_leave','return_from_leave','reinstate_student') THEN RETURN FALSE; END IF;
        IF p_command->'fields' ? 'student_id' AND NOT EXISTS(SELECT 1 FROM backend_api.allowed_students(p_user)
            WHERE student_id=(p_command->'fields'->>'student_id')::INT) THEN
            RETURN p_mode='execute' AND p_stored_institute IS NOT NULL AND NOT EXISTS(
                SELECT 1 FROM student WHERE student_id=(p_command->'fields'->>'student_id')::INT)
                AND (a.role_code='admin' OR p_stored_institute=ANY(a.institute_ids));
        END IF;
        IF p_command->'fields' ? 'group_name' THEN
            SELECT group_id INTO v_group FROM study_group WHERE name=p_command->'fields'->>'group_name';
            IF v_group IS NULL THEN
                RETURN p_mode='execute' AND p_stored_institute IS NOT NULL
                    AND (a.role_code='admin' OR p_stored_institute=ANY(a.institute_ids));
            END IF;
            IF NOT EXISTS(SELECT 1 FROM backend_api.allowed_groups(p_user) WHERE group_id=v_group) THEN RETURN FALSE; END IF;
        END IF;
        RETURN TRUE;
    END IF;
    IF p_command->>'kind' IS DISTINCT FROM 'record_change' OR p_command->>'resource' NOT IN (
        'student','study_group','schedule_slot','academic_work','practice_placement','document_request','employee','person') OR
        p_command->>'operation' NOT IN ('create','update','delete') THEN RETURN FALSE; END IF;
    IF p_command->>'resource' IN ('student','person') AND p_command->>'operation'<>'update' THEN RETURN FALSE; END IF;
    IF p_command->>'resource'='employee' AND p_command->>'operation'='create' AND a.role_code<>'admin' THEN RETURN FALSE; END IF;
    r:=backend_api.command_row(p_command);
    IF r IS NULL THEN
        RETURN p_mode='execute' AND a.role_code IN ('admin','director','dean_staff') AND
            (a.role_code='admin' OR (p_stored_institute IS NOT NULL AND p_stored_institute=ANY(a.institute_ids)));
    END IF;
    IF a.role_code IN ('admin','director','dean_staff') AND p_command->>'resource'='study_group'
        AND p_command->>'operation'='create' THEN
        RETURN a.role_code='admin' OR backend_api.command_institute(p_command)=ANY(a.institute_ids);
    END IF;
    IF a.role_code NOT IN ('admin','director','dean_staff') THEN
        IF p_mode<>'prepare' THEN RETURN FALSE; END IF;
        IF a.role_code='teacher' THEN
            IF p_command->>'resource'<>'academic_work' OR p_command->>'operation'<>'update' OR
               (p_command->'fields')-'topic'<>'{}'::JSONB OR NOT p_command->'fields' ? 'topic' OR
               (r->>'supervisor_id')::INT IS DISTINCT FROM a.teacher_id THEN RETURN FALSE; END IF;
        ELSIF a.role_code='student' THEN
            IF p_command->>'resource'<>'document_request' OR p_command->>'operation' NOT IN ('create','update') OR
                (r->>'student_id')::INT IS DISTINCT FROM a.student_id THEN RETURN FALSE; END IF;
        ELSE RETURN FALSE;
        END IF;
    END IF;
    IF NOT backend_api.record_in_scope(p_command->>'resource',r,p_user,a.role_code) THEN RETURN FALSE; END IF;
    IF p_command->>'operation'='update' AND NOT backend_api.record_in_scope(
        p_command->>'resource',r || (p_command->'fields'),p_user,a.role_code) THEN RETURN FALSE; END IF;
    RETURN TRUE;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN FALSE;
END $$;

CREATE OR REPLACE FUNCTION backend_api.command_relations(p_command JSONB) RETURNS TABLE(name TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_seeds TEXT[];
BEGIN
    IF p_command->>'kind' IN ('special_command','grade_correction') THEN
        SELECT array_agg(s.name) INTO v_seeds FROM backend_api.special_relations(p_command) s;
    ELSE
        v_seeds:=CASE WHEN p_command->>'kind'='workflow' THEN
            ARRAY['student','person','academic_order','order_student','academic_leave','scholarship']
            ELSE ARRAY[p_command->>'resource'] END;
    END IF;
    RETURN QUERY WITH RECURSIVE roots AS (
        SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='deanery' AND (c.relname=ANY(v_seeds)
            OR c.relname IN ('app_user','employee','dean_office_staff','teacher','institute','department'))
        UNION SELECT con.conrelid FROM pg_constraint con JOIN pg_class c ON c.oid=con.confrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE con.contype='f' AND n.nspname='deanery'
          AND c.relname=ANY(v_seeds)
    ), ancestors(oid) AS (
        SELECT oid FROM roots UNION SELECT c.confrelid FROM pg_constraint c JOIN ancestors a ON a.oid=c.conrelid WHERE c.contype='f'
    ) SELECT c.relname::TEXT FROM ancestors a JOIN pg_class c ON c.oid=a.oid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='deanery' AND c.relname NOT IN ('audit_log','audit_log_detail','agent_request') ORDER BY c.relname;
END $$;

CREATE OR REPLACE FUNCTION backend_api.command_lock(p_command JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r RECORD;
BEGIN
    PERFORM pg_advisory_xact_lock(9174,1);
    IF p_command->>'kind'='workflow' AND p_command->'fields' ? 'student_id' THEN
        PERFORM pg_advisory_xact_lock(7821,(p_command->'fields'->>'student_id')::INT);
    END IF;
    -- shortcut: relevant table locks serialize overlapping commands; use row/predicate locks if concurrent throughput needs it.
    FOR r IN SELECT name FROM backend_api.command_relations(p_command) LOOP
        EXECUTE format('LOCK TABLE deanery.%I IN SHARE ROW EXCLUSIVE MODE',r.name);
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION backend_api.command_dependencies(p_table TEXT,p_row JSONB,p_seen JSONB DEFAULT '{}',p_include BOOLEAN DEFAULT TRUE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE out JSONB:=p_seen; v_rel REGCLASS; v_key JSONB; v_marker TEXT; f RECORD; v_match JSONB; v_parent JSONB;
BEGIN
    IF p_row IS NULL THEN RETURN out; END IF;
    v_rel:=format('deanery.%I',p_table)::REGCLASS;
    SELECT jsonb_object_agg(a.attname,p_row->a.attname) INTO v_key FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey) k(attnum) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
    WHERE i.indrelid=v_rel AND i.indisprimary;
    v_marker:=p_table || ':' || COALESCE(v_key::TEXT,'{}');
    IF p_include AND out ? v_marker THEN RETURN out; END IF;
    IF p_include THEN
        out:=out || jsonb_build_object(v_marker,encode(sha256(convert_to(
            (p_row - ARRAY['password_hash','last_login_at'])::TEXT,'UTF8')),'hex'));
    END IF;
    FOR f IN SELECT c.*,cl.relname AS target FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.confrelid
        WHERE c.conrelid=v_rel AND c.contype='f' ORDER BY cl.relname,c.conname LOOP
        SELECT jsonb_object_agg(dst.attname,p_row->src.attname) INTO v_match
        FROM unnest(f.conkey,f.confkey) pair(srcnum,dstnum)
        JOIN pg_attribute src ON src.attrelid=f.conrelid AND src.attnum=pair.srcnum
        JOIN pg_attribute dst ON dst.attrelid=f.confrelid AND dst.attnum=pair.dstnum;
        IF EXISTS(SELECT 1 FROM jsonb_each(v_match) WHERE value='null'::JSONB OR value IS NULL) THEN CONTINUE; END IF;
        EXECUTE format('SELECT to_jsonb(t) FROM deanery.%I t WHERE to_jsonb(t) @> $1',f.target) INTO v_parent USING v_match;
        out:=backend_api.command_dependencies(f.target,v_parent,out);
    END LOOP;
    RETURN out;
END $$;

CREATE OR REPLACE FUNCTION backend_api.command_snapshot(p_command JSONB,p_author INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE out JSONB:='{}'; r JSONB; v_table TEXT; v_rel REGCLASS; f RECORD; match JSONB; child JSONB; a JSONB;
BEGIN
    IF p_command->>'kind' IN ('special_command','grade_correction') THEN RETURN backend_api.special_snapshot(p_command,p_author); END IF;
    v_table:=CASE WHEN p_command->>'kind'='workflow' THEN 'student' ELSE p_command->>'resource' END;
    r:=backend_api.command_row(p_command);
    SELECT to_jsonb(s) INTO a FROM backend_api.account_snapshot(p_author) s;
    out:=jsonb_build_object('author',encode(sha256(convert_to(COALESCE(a::TEXT,'null'),'UTF8')),'hex'));
    IF p_command->>'kind'='workflow' THEN
        out:=out || jsonb_build_object('calendar_date',(now() AT TIME ZONE 'Europe/Moscow')::DATE);
        FOR child IN SELECT to_jsonb(g) FROM study_group g WHERE name=p_command->'fields'->>'group_name' LOOP
            out:=backend_api.command_dependencies('study_group',child,out);
        END LOOP;
        FOR child IN SELECT to_jsonb(e) FROM employee e WHERE employee_id=(p_command->'fields'->>'signed_by')::INT LOOP
            out:=backend_api.command_dependencies('employee',child,out);
        END LOOP;
        FOR child IN SELECT to_jsonb(o) FROM academic_order o WHERE order_number=p_command->'fields'->>'order_number' LOOP
            out:=backend_api.command_dependencies('academic_order',child,out);
        END LOOP;
        FOR child IN SELECT to_jsonb(st) FROM student_status st LOOP
            out:=backend_api.command_dependencies('student_status',child,out);
        END LOOP;
        FOR child IN SELECT to_jsonb(ot) FROM order_type ot LOOP
            out:=backend_api.command_dependencies('order_type',child,out);
        END LOOP;
        FOR child IN SELECT to_jsonb(ft) FROM funding_type ft WHERE name=p_command->'fields'->>'funding' LOOP
            out:=backend_api.command_dependencies('funding_type',child,out);
        END LOOP;
        FOR child IN SELECT to_jsonb(lr) FROM leave_reason lr WHERE name=p_command->'fields'->>'reason' LOOP
            out:=backend_api.command_dependencies('leave_reason',child,out);
        END LOOP;
    ELSIF v_table='document_request' THEN
        FOR child IN SELECT to_jsonb(rs) FROM request_status rs LOOP
            out:=backend_api.command_dependencies('request_status',child,out);
        END LOOP;
    END IF;
    out:=backend_api.command_dependencies(v_table,r,out,p_command->>'operation' IS DISTINCT FROM 'create');
    IF r IS NOT NULL AND p_command->>'operation' IS DISTINCT FROM 'create' THEN
        v_rel:=format('deanery.%I',v_table)::REGCLASS;
        FOR f IN SELECT c.*,cl.relname AS target FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid
            WHERE c.confrelid=v_rel AND c.contype='f' AND cl.relname NOT IN ('audit_log','agent_request') ORDER BY cl.relname,c.conname LOOP
            SELECT jsonb_object_agg(src.attname,r->dst.attname) INTO match
            FROM unnest(f.conkey,f.confkey) pair(srcnum,dstnum)
            JOIN pg_attribute src ON src.attrelid=f.conrelid AND src.attnum=pair.srcnum
            JOIN pg_attribute dst ON dst.attrelid=f.confrelid AND dst.attnum=pair.dstnum;
            FOR child IN EXECUTE format('SELECT to_jsonb(t) FROM deanery.%I t WHERE to_jsonb(t) @> $1 ORDER BY to_jsonb(t)::TEXT',f.target) USING match LOOP
                out:=backend_api.command_dependencies(f.target,child,out);
            END LOOP;
        END LOOP;
        IF p_command->>'kind' IN ('record_change','sql_change') THEN
            out:=backend_api.command_dependencies(v_table,r || (p_command->'fields'),out,FALSE);
        END IF;
    END IF;
    IF v_table='schedule_slot' THEN
        FOR child IN SELECT to_jsonb(s) FROM schedule_slot s WHERE
            s.weekday=COALESCE((p_command->'fields'->>'weekday')::INT,(r->>'weekday')::INT) AND
            s.pair_number=COALESCE((p_command->'fields'->>'pair_number')::INT,(r->>'pair_number')::INT) LOOP
            out:=backend_api.command_dependencies('schedule_slot',child,out);
        END LOOP;
    END IF;
    IF p_command->>'kind'='sql_change' THEN out:=out || backend_api.root_change_snapshot(p_command,p_author); END IF;
    RETURN out;
END $$;

CREATE OR REPLACE FUNCTION backend_api.command_execute(p_command JSONB,p_author INT,p_actor INT,p_request INT,p_key UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
BEGIN
    IF NOT backend_api.command_authorized(p_command,p_author,'prepare') OR
       NOT backend_api.command_authorized(p_command,p_actor,'execute') OR NOT EXISTS(
        SELECT 1 FROM agent_request WHERE agent_request_id=p_request AND user_id=p_author) THEN
        RAISE EXCEPTION 'Command access denied' USING ERRCODE='42501';
    END IF;
    IF p_command->>'kind' IN ('special_command','grade_correction') THEN
        RETURN backend_api.special_execute(p_command,p_author,p_actor,p_request,p_key);
    ELSIF p_command->>'kind'='sql_change' THEN
        RETURN backend_api.mutate_record_as(p_command->>'resource',p_command->>'operation',p_command->'key',
            p_command->'fields',p_author,p_actor,p_request,TRUE,TRUE);
    ELSIF p_command->>'kind'='record_change' THEN
        RETURN backend_api.mutate_record_as(p_command->>'resource',p_command->>'operation',p_command->'key',
            p_command->'fields',p_author,p_actor,p_request,TRUE);
    END IF;
    RETURN backend_api.run_workflow_as(p_command->>'name',p_command->'fields',p_key,p_author,p_actor,p_request);
END $$;

CREATE OR REPLACE FUNCTION backend_api.command_capture_audit() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF current_setting('app.command_capture',TRUE)='on' THEN
        PERFORM set_config('app.command_audits',
            (COALESCE(NULLIF(current_setting('app.command_audits',TRUE),''),'[]')::JSONB || to_jsonb(NEW.audit_id))::TEXT,TRUE);
    END IF;
    RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER command_capture_audit AFTER INSERT ON deanery.audit_log
FOR EACH ROW EXECUTE FUNCTION backend_api.command_capture_audit();

CREATE OR REPLACE FUNCTION backend_api.command_expected(p_order INT,p_student INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE o RECORD; s JSONB; v_status TEXT; effects JSONB:='[]'; r RECORD;
BEGIN
    SELECT ot.code,os.new_group_id,fn_order_due_date(os.order_id,os.student_id) AS due INTO o
    FROM order_student os JOIN academic_order ao ON ao.order_id=os.order_id
    JOIN order_type ot ON ot.order_type_id=ao.order_type_id WHERE os.order_id=p_order AND os.student_id=p_student;
    SELECT to_jsonb(st) INTO s FROM student st WHERE student_id=p_student;
    -- Read-only projection of the source order's promised state; actual application still uses fn_apply_order.
    v_status:=CASE o.code WHEN 'enroll' THEN 'Обучается' WHEN 'expel' THEN 'Отчислен'
        WHEN 'leave' THEN 'Академический отпуск' WHEN 'leave_return' THEN 'Обучается'
        WHEN 'reinstate' THEN 'Обучается' END;
    IF v_status IS NOT NULL THEN
        s:=s || jsonb_build_object('status_id',(SELECT status_id FROM student_status WHERE name=v_status));
    END IF;
    IF o.code IN ('transfer','reinstate','leave_return') AND o.new_group_id IS NOT NULL THEN
        s:=s || jsonb_build_object('group_id',o.new_group_id);
    END IF;
    IF o.code IN ('expel','leave') THEN
        FOR r IN SELECT scholarship_id,end_date,GREATEST(o.due,start_date+1) AS next_end FROM scholarship
            WHERE student_id=p_student AND end_date>o.due ORDER BY scholarship_id LOOP
            effects:=effects || jsonb_build_object('table','scholarship','operation','UPDATE','phase','future',
                'key','scholarship_id=' || r.scholarship_id,
                'changes',jsonb_build_object('end_date',jsonb_build_object('before',r.end_date,'after',r.next_end)));
        END LOOP;
    END IF;
    FOR r IN SELECT g.group_id,g.headman_id FROM study_group g WHERE g.headman_id=p_student AND
        (g.group_id<>(s->>'group_id')::INT OR NOT (SELECT is_active FROM student_status WHERE status_id=(s->>'status_id')::INT)) LOOP
        effects:=effects || jsonb_build_object('table','study_group','operation','UPDATE','phase','future',
            'key','group_id=' || r.group_id,'changes',jsonb_build_object('headman_id',jsonb_build_object('before',r.headman_id,'after',NULL)));
    END LOOP;
    RETURN jsonb_build_object('after',s,'effects',effects);
END $$;

CREATE OR REPLACE FUNCTION backend_api.command_preview(p_command JSONB,p_author INT,p_request INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE c JSONB; v_snapshot JSONB; v_hash TEXT; v_before JSONB; v_result JSONB; v_table TEXT;
    v_preview JSONB; v_effects JSONB; v_related JSONB; v_audit BIGINT; v_actor INT; v_pk TEXT; v_after JSONB;
    v_changed JSONB; v_temp BOOLEAN; v_institute INT; v_date DATE; v_note TEXT; v_expected JSONB;
    v_meta JSONB; v_operation TEXT;
    v_generated JSONB:='{}'; v_ids BIGINT[]; x RECORD; e JSONB; changes JSONB; v_safe JSONB:='[]'; v_ref TEXT;
BEGIN
    c:=backend_api.command_normalize(p_command,p_author);
    IF NOT backend_api.command_authorized(c,p_author,'prepare') OR NOT EXISTS(
        SELECT 1 FROM agent_request WHERE agent_request_id=p_request AND user_id=p_author) THEN
        RAISE EXCEPTION 'Command access denied' USING ERRCODE='42501';
    END IF;
    PERFORM backend_api.command_lock(c);
    v_snapshot:=backend_api.command_snapshot(c,p_author);
    v_hash:=encode(sha256(convert_to(v_snapshot::TEXT,'UTF8')),'hex');
    v_institute:=backend_api.command_institute(c);
    IF c->>'kind' IN ('special_command','grade_correction') THEN
        v_meta:=backend_api.special_metadata(c);
    ELSE
        v_meta:=jsonb_build_object('resource',CASE WHEN c->>'kind'='workflow' THEN 'student' ELSE c->>'resource' END,
            'operation',c->>'operation','temp',COALESCE(c->>'operation'='create',FALSE) OR COALESCE(c->>'name'='enroll_student',FALSE));
    END IF;
    v_table:=v_meta->>'resource';
    v_operation:=v_meta->>'operation';
    v_before:=CASE WHEN v_operation='create' THEN NULL ELSE backend_api.command_row(c) END;
    v_temp:=(v_meta->>'temp')::BOOLEAN;
    SELECT a.user_id INTO v_actor FROM app_user a WHERE backend_api.command_authorized(c,a.user_id,'execute') ORDER BY a.user_id LIMIT 1;
    IF v_actor IS NULL THEN RAISE EXCEPTION 'No eligible staff for command' USING ERRCODE='42501'; END IF;
    BEGIN
        PERFORM set_config('app.command_capture','on',TRUE);
        PERFORM set_config('app.command_audits','[]',TRUE);
        v_result:=backend_api.command_execute(c,p_author,v_actor,p_request,gen_random_uuid());
        SET CONSTRAINTS ALL IMMEDIATE;
        IF c->>'kind'='workflow' THEN
            SELECT to_jsonb(s) INTO v_after FROM student s WHERE student_id=(v_result->>'student_id')::INT;
            v_date:=(v_result->>'effective_date')::DATE;
            IF v_result->>'status'='pending' THEN
                v_expected:=backend_api.command_expected((v_result->>'order_id')::INT,(v_result->>'student_id')::INT);
                v_after:=v_expected->'after';
            END IF;
        ELSE v_after:=CASE WHEN v_operation='delete' THEN '{}'::JSONB ELSE v_result END;
        END IF;
        SELECT ARRAY(SELECT value::TEXT::BIGINT FROM jsonb_array_elements(current_setting('app.command_audits')::JSONB)) INTO v_ids;
        SELECT COALESCE(jsonb_agg(jsonb_build_object('table',l.table_name,'operation',
            CASE l.operation WHEN 'I' THEN 'INSERT' WHEN 'U' THEN 'UPDATE' ELSE 'DELETE' END,
            'key',CASE WHEN l.operation='I' THEN NULL ELSE l.record_key END,
            'changes',(SELECT COALESCE(jsonb_object_agg(d.column_name,jsonb_build_object('before',d.old_value,'after',d.new_value)),'{}')
                       FROM audit_log_detail d WHERE d.audit_id=l.audit_id AND d.column_name NOT IN (
                       'password_hash','passport_series','passport_number','snils','inn'))
            ) ORDER BY l.audit_id),'[]') INTO v_effects FROM audit_log l
            WHERE l.audit_id=ANY(v_ids);
        FOR x IN SELECT l.table_name,d.column_name,d.new_value FROM audit_log l
            JOIN audit_log_detail d ON d.audit_id=l.audit_id
            JOIN pg_class cl ON cl.relname=l.table_name AND cl.relnamespace='deanery'::REGNAMESPACE
            JOIN pg_attribute at ON at.attrelid=cl.oid AND at.attname=d.column_name AND at.attidentity<>''
            WHERE l.audit_id=ANY(v_ids) AND l.operation='I' LOOP
            v_generated:=v_generated || jsonb_build_object(x.column_name || ':' || x.new_value,'new:' || x.table_name);
        END LOOP;
        RAISE EXCEPTION 'Preview rollback' USING ERRCODE='PZ001';
    EXCEPTION WHEN SQLSTATE 'PZ001' THEN NULL;
    END;
    IF c->>'kind'='sql_change' AND v_operation='update' AND v_before=v_after THEN
        RAISE EXCEPTION 'No effective change' USING ERRCODE='22023';
    END IF;
    v_effects:=v_effects || COALESCE(v_expected->'effects','[]') || COALESCE(v_meta->'effects','[]');
    FOR e IN SELECT value FROM jsonb_array_elements(v_effects) LOOP
        changes:=e->'changes';
        FOR x IN SELECT key,value FROM jsonb_each(changes) LOOP
            v_ref:=v_generated->>(x.key || ':' || (x.value->>'after'));
            IF v_ref IS NOT NULL THEN
                changes:=jsonb_set(changes,ARRAY[x.key],(x.value || jsonb_build_object('after',NULL,'after_reference',v_ref)));
            END IF;
            v_ref:=v_generated->>(x.key || ':' || (x.value->>'before'));
            IF v_ref IS NOT NULL THEN
                changes:=jsonb_set(changes,ARRAY[x.key],(changes->x.key || jsonb_build_object('before',NULL,'before_reference',v_ref)));
            END IF;
        END LOOP;
        IF e->>'key' IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_each_text(v_generated) g
            WHERE e->>'key'=replace(g.key,':','=')) THEN e:=e || jsonb_build_object('key',NULL); END IF;
        v_safe:=v_safe || (e || jsonb_build_object('changes',changes));
    END LOOP;
    v_effects:=v_safe;
    FOR x IN SELECT key,value FROM jsonb_each(v_after) LOOP
        IF v_generated ? (x.key || ':' || (x.value #>> '{}')) THEN
            v_after:=jsonb_set(v_after,ARRAY[x.key],'null');
        END IF;
    END LOOP;
    SELECT COALESCE(jsonb_agg(to_jsonb((effect->>'operation') || ' ' || (effect->>'table') ||
        CASE WHEN effect->>'phase'='future' THEN ' (при исполнении приказа)' ELSE '' END)),'[]') INTO v_related FROM jsonb_array_elements(v_effects) effect;
    IF v_table='person' THEN
        v_before:=v_before-ARRAY['gender','birth_date','phone','email','passport_series','passport_number','snils','inn','address','created_at'];
    END IF;
    IF v_temp THEN
        SELECT a.attname INTO v_pk FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) k(attnum)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
        WHERE i.indrelid=format('deanery.%I',v_table)::REGCLASS AND i.indisprimary;
        v_after:=v_after || jsonb_build_object(v_pk,NULL);
        v_note:='Идентификаторы новых записей будут присвоены при исполнении; номера из проверки не сохраняются.';
    END IF;
    -- Generated identities and their FK references have labels instead of values from the rolled-back preview.
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_effects) effect WHERE effect->>'operation'='INSERT') THEN
        v_note:=COALESCE(v_note,'') || ' Идентификаторы в связанных изменениях временные.';
    END IF;
    IF v_result->>'status'='pending' THEN
        v_note:=COALESCE(v_note,'') || ' Приказ будет исполнен ' || v_date::TEXT || '; показано ожидаемое состояние на эту дату.';
    END IF;
    v_note:=concat(v_note,v_meta->>'note');
    SELECT COALESCE(jsonb_agg(k ORDER BY k),'[]') INTO v_changed FROM (
        SELECT key AS k FROM jsonb_each(COALESCE(v_before,'{}') || COALESCE(v_after,'{}'))
        WHERE v_before->key IS DISTINCT FROM v_after->key) keys;
    v_preview:=jsonb_build_object('operation',CASE WHEN v_operation='delete' THEN 'DELETE'
        WHEN v_temp THEN 'INSERT' ELSE 'UPDATE' END,'table',v_table,'affected_rows',1,
        'before',v_before,'after',v_after,'changed_columns',v_changed,'snapshot_hash',v_hash,
        'related_effects',v_related,'effects',v_effects,'note',v_note,'applied',NULL);
    RETURN jsonb_build_object('command',c,'preview',v_preview,'snapshot',v_snapshot,'snapshot_hash',v_hash,
                             'institute_id',v_institute,'effective_date',v_date);
END $$;

REVOKE ALL ON FUNCTION backend_api.command_normalize(JSONB,INT),backend_api.command_row(JSONB),
    backend_api.command_institute(JSONB),backend_api.command_authorized(JSONB,INT,TEXT,INT),
    backend_api.command_relations(JSONB),backend_api.command_lock(JSONB),
    backend_api.command_dependencies(TEXT,JSONB,JSONB,BOOLEAN),backend_api.command_snapshot(JSONB,INT),
    backend_api.command_execute(JSONB,INT,INT,INT,UUID),backend_api.command_preview(JSONB,INT,INT),
    backend_api.command_capture_audit(),backend_api.command_expected(INT,INT) FROM PUBLIC;
