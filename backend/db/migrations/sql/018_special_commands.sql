CREATE OR REPLACE FUNCTION backend_api.special_normalize(c JSONB,p_author INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE f JSONB:=c->'fields'; required TEXT[]; k TEXT; n TEXT;
BEGIN
    PERFORM set_config('TimeZone','Europe/Moscow',TRUE);
    IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c->'version' IS DISTINCT FROM '1'::JSONB
       OR jsonb_typeof(f) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid command' USING ERRCODE='22023'; END IF;
    n:=CASE WHEN c->>'kind'='grade_correction' THEN 'grade_correction' ELSE c->>'name' END;
    IF c->>'kind' NOT IN ('special_command','grade_correction') OR c->>'kind' IS NULL
       OR c - (CASE WHEN c->>'kind'='grade_correction' THEN ARRAY['version','kind','fields']
                    ELSE ARRAY['version','kind','name','fields'] END) <> '{}'::JSONB THEN
        RAISE EXCEPTION 'Invalid special command' USING ERRCODE='22023'; END IF;
    CASE n
    WHEN 'scholarship_assign' THEN
        required:=ARRAY['student_id','scholarship_type_id','start_date','end_date','reason'];
        IF f ? 'order_id' THEN required:=required || ARRAY['order_id'];
        ELSE required:=required || ARRAY['order_number','order_date','signed_by']; END IF;
    WHEN 'scholarship_terminate' THEN required:=ARRAY['scholarship_id','end_date','reason'];
    WHEN 'scholarship_cancel' THEN required:=ARRAY['scholarship_id','reason'];
    WHEN 'scheduled_order_cancel' THEN required:=ARRAY['order_number','student_id','reason'];
    WHEN 'grade_correction' THEN required:=ARRAY['sheet_number','record_book','new_points','new_is_absent','reason'];
    ELSE RAISE EXCEPTION 'Unknown special command' USING ERRCODE='22023';
    END CASE;
    IF NOT f ?& required OR f-required<>'{}'::JSONB THEN RAISE EXCEPTION 'Invalid fields' USING ERRCODE='22023'; END IF;
    FOREACH k IN ARRAY required LOOP
        IF k IN ('student_id','scholarship_id','scholarship_type_id','order_id','signed_by','new_points') THEN
            IF k='new_points' AND f->k='null'::JSONB THEN CONTINUE; END IF;
            IF jsonb_typeof(f->k) IS DISTINCT FROM 'number' OR f->>k !~ '^[1-9][0-9]*$'
               OR (f->>k)::NUMERIC>2147483647 THEN RAISE EXCEPTION 'Invalid number' USING ERRCODE='22023'; END IF;
        ELSIF k='new_is_absent' THEN
            IF jsonb_typeof(f->k) IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid absence' USING ERRCODE='22023'; END IF;
        ELSE
            IF jsonb_typeof(f->k) IS DISTINCT FROM 'string' OR btrim(f->>k)='' THEN
                RAISE EXCEPTION 'Invalid text' USING ERRCODE='22023'; END IF;
            IF k IN ('start_date','end_date','order_date') THEN
                IF f->>k !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Invalid date' USING ERRCODE='22023'; END IF;
                PERFORM (f->>k)::DATE;
            END IF;
            IF length(f->>k)>(CASE WHEN k IN ('sheet_number','record_book') THEN 20 WHEN k='order_number' THEN 30
                WHEN k='reason' AND n='grade_correction' THEN 500 WHEN k='reason' AND n='scholarship_assign' THEN 300 ELSE 2000 END) THEN
                RAISE EXCEPTION 'Text too long' USING ERRCODE='22023'; END IF;
        END IF;
    END LOOP;
    IF n='grade_correction' AND f->'new_points'<>'null'::JSONB AND (f->>'new_is_absent')::BOOLEAN THEN
        RAISE EXCEPTION 'Points and absence conflict' USING ERRCODE='22023'; END IF;
    RETURN c;
END $$;

CREATE OR REPLACE FUNCTION backend_api.special_row(c JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r JSONB;
BEGIN
    IF c->>'kind'='grade_correction' THEN
        SELECT to_jsonb(g) INTO r FROM grade g JOIN grade_sheet gs USING(sheet_id) JOIN student s USING(student_id)
        WHERE gs.sheet_number=c->'fields'->>'sheet_number' AND s.record_book_number=c->'fields'->>'record_book';
    ELSIF c->>'name'='scholarship_assign' THEN
        r:=(c->'fields')-ARRAY['reason','order_number','order_date','signed_by'];
    ELSIF c->>'name' IN ('scholarship_terminate','scholarship_cancel') THEN
        SELECT to_jsonb(sc) INTO r FROM scholarship sc WHERE scholarship_id=(c->'fields'->>'scholarship_id')::INT;
    ELSIF c->>'name'='scheduled_order_cancel' THEN
        SELECT to_jsonb(os) INTO r FROM order_student os JOIN academic_order o USING(order_id)
        WHERE o.order_number=c->'fields'->>'order_number' AND os.student_id=(c->'fields'->>'student_id')::INT;
    END IF;
    RETURN r;
END $$;

CREATE OR REPLACE FUNCTION backend_api.special_institute(c JSONB) RETURNS INT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r JSONB:=backend_api.special_row(c); v_inst INT;
BEGIN
    IF c->>'kind'='grade_correction' THEN
        SELECT fn_group_institute(group_id) INTO v_inst FROM grade_sheet WHERE sheet_id=(r->>'sheet_id')::INT;
    ELSE SELECT fn_group_institute(group_id) INTO v_inst FROM student WHERE student_id=(r->>'student_id')::INT;
    END IF;
    RETURN v_inst;
END $$;

CREATE OR REPLACE FUNCTION backend_api.special_authorized(c JSONB,p_user INT,p_mode TEXT,p_stored_institute INT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; r JSONB:=backend_api.special_row(c); v_inst INT:=backend_api.special_institute(c); v_emp INT;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(p_user) WHERE is_active;
    IF NOT FOUND OR p_mode IS NULL OR p_mode NOT IN ('prepare','execute') THEN RETURN FALSE; END IF;
    IF c->>'kind'='grade_correction' THEN
        SELECT employee_id INTO v_emp FROM employee WHERE person_id=a.person_id AND dismissal_date IS NULL;
        IF p_mode='execute' THEN RETURN COALESCE(fn_manages_institute(v_emp,v_inst),FALSE); END IF;
        IF v_emp IS NULL OR a.role_code='student' OR r IS NULL THEN RETURN FALSE; END IF;
        IF a.role_code='teacher' THEN RETURN EXISTS(SELECT 1 FROM grade_sheet WHERE sheet_id=(r->>'sheet_id')::INT AND examiner_id=v_emp); END IF;
        RETURN a.role_code IN ('admin','director','dean_staff') AND
            (a.role_code='admin' OR v_inst=ANY(a.institute_ids)) AND EXISTS(
                SELECT 1 FROM backend_api.allowed_students(p_user) WHERE student_id=(r->>'student_id')::INT);
    END IF;
    IF c->>'kind'<>'special_command' OR a.role_code NOT IN ('admin','director','dean_staff') THEN RETURN FALSE; END IF;
    IF r IS NULL THEN RETURN p_mode='execute' AND p_stored_institute IS NOT NULL
        AND (a.role_code='admin' OR p_stored_institute=ANY(a.institute_ids)); END IF;
    RETURN EXISTS(SELECT 1 FROM backend_api.allowed_students(p_user) WHERE student_id=(r->>'student_id')::INT)
        AND (a.role_code='admin' OR v_inst=ANY(a.institute_ids));
END $$;

CREATE OR REPLACE FUNCTION backend_api.special_metadata(c JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r JSONB:=backend_api.special_row(c); effects JSONB:='[]'; x RECORD;
BEGIN
    IF c->>'kind'='grade_correction' THEN RETURN jsonb_build_object('resource','grade','operation','update','temp',FALSE,
        'note',format('Ведомость %s, зачётная книжка %s. Основание: %s. Автор подаёт заявку; другой директор или заместитель принимает решение.',
            c->'fields'->>'sheet_number',c->'fields'->>'record_book',c->'fields'->>'reason')); END IF;
    IF c->>'name'='scheduled_order_cancel' THEN
        FOR x IN SELECT id,status FROM agent_backend.job WHERE kind='apply_order' AND payload->>'order_id'=r->>'order_id'
            AND payload->>'student_id'=r->>'student_id' ORDER BY id LOOP
            effects:=effects || jsonb_build_object('table','job','operation','UPDATE','key','id='||x.id,
                'changes',jsonb_build_object('status',jsonb_build_object('before',x.status,'after','cancelled')));
        END LOOP;
        FOR x IN SELECT id,execution FROM agent_backend.proposal WHERE status='approved'
            AND execution->>'order_id'=r->>'order_id' AND execution->>'student_id'=r->>'student_id' ORDER BY id LOOP
            effects:=effects || jsonb_build_object('table','proposal','operation','UPDATE','key','id='||x.id,
                'changes',jsonb_build_object('execution_status',jsonb_build_object('before',x.execution->>'status','after','cancelled')));
        END LOOP;
        RETURN jsonb_build_object('resource','order_student','operation','delete','temp',FALSE,'effects',effects,
            'note',format('Отменяется только приказ № %s для студента %s. Связанные изменения отпуска показаны в последствиях.',
                c->'fields'->>'order_number',c->'fields'->>'student_id'));
    END IF;
    RETURN jsonb_build_object('resource','scholarship','operation',CASE c->>'name' WHEN 'scholarship_assign' THEN 'create'
        WHEN 'scholarship_cancel' THEN 'delete' ELSE 'update' END,'temp',c->>'name'='scholarship_assign');
END $$;

CREATE OR REPLACE FUNCTION backend_api.special_relations(c JSONB) RETURNS TABLE(name TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    WITH RECURSIVE seeds AS (
        SELECT unnest(CASE WHEN c->>'kind'='grade_correction' THEN ARRAY['grade','grade_sheet','grade_correction']
            ELSE ARRAY['scholarship','student','academic_order','order_student','academic_leave'] END) AS name
    ), roots AS (
        SELECT cl.oid FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='deanery'
            AND cl.relname IN (SELECT name FROM seeds UNION SELECT unnest(ARRAY['app_user','employee','institute','dean_office_staff','teacher','department']))
    ), ancestors(oid) AS (SELECT oid FROM roots UNION SELECT x.confrelid FROM pg_constraint x
        JOIN ancestors a ON a.oid=x.conrelid WHERE x.contype='f')
    SELECT cl.relname::TEXT FROM ancestors a JOIN pg_class cl ON cl.oid=a.oid
        JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='deanery' ORDER BY cl.relname
$$;

CREATE OR REPLACE FUNCTION backend_api.special_snapshot(c JSONB,p_author INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r JSONB:=backend_api.special_row(c); out JSONB; x JSONB; v_student INT:=(r->>'student_id')::INT;
BEGIN
    SELECT jsonb_build_object('author',encode(sha256(convert_to(to_jsonb(a)::TEXT,'UTF8')),'hex')) INTO out
        FROM backend_api.account_snapshot(p_author) a;
    out:=COALESCE(out,'{}') || jsonb_build_object('calendar_date',(now() AT TIME ZONE 'Europe/Moscow')::DATE);
    out:=backend_api.command_dependencies(backend_api.special_metadata(c)->>'resource',r,out,c->>'name' IS DISTINCT FROM 'scholarship_assign');
    IF c->>'kind'='grade_correction' THEN
        FOR x IN SELECT to_jsonb(g) FROM grade g WHERE student_id=v_student ORDER BY grade_id LOOP
            out:=backend_api.command_dependencies('grade',x,out);
        END LOOP;
    ELSE
        FOR x IN SELECT to_jsonb(s) FROM scholarship s WHERE student_id=v_student ORDER BY scholarship_id LOOP
            out:=backend_api.command_dependencies('scholarship',x,out);
        END LOOP;
        FOR x IN SELECT to_jsonb(l) FROM academic_leave l WHERE student_id=v_student ORDER BY leave_id LOOP
            out:=backend_api.command_dependencies('academic_leave',x,out);
        END LOOP;
        FOR x IN SELECT to_jsonb(os) FROM order_student os WHERE student_id=v_student OR order_id=(r->>'order_id')::INT
            ORDER BY order_id,student_id LOOP out:=backend_api.command_dependencies('order_student',x,out); END LOOP;
        FOR x IN SELECT to_jsonb(o) FROM academic_order o WHERE order_number=c->'fields'->>'order_number' LOOP
            out:=backend_api.command_dependencies('academic_order',x,out); END LOOP;
        FOR x IN SELECT to_jsonb(e) FROM employee e WHERE employee_id=(c->'fields'->>'signed_by')::INT LOOP
            out:=backend_api.command_dependencies('employee',x,out); END LOOP;
        FOR x IN SELECT to_jsonb(ot) FROM order_type ot WHERE code='scholarship' LOOP
            out:=backend_api.command_dependencies('order_type',x,out); END LOOP;
    END IF;
    RETURN out;
END $$;

CREATE OR REPLACE FUNCTION backend_api.request_correction_as(c JSONB,p_author INT,p_request INT) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE f JSONB:=c->'fields'; result INT;
BEGIN
    IF c->>'kind' IS DISTINCT FROM 'grade_correction' OR NOT backend_api.special_authorized(c,p_author,'prepare')
       OR NOT EXISTS(SELECT 1 FROM agent_request WHERE agent_request_id=p_request AND user_id=p_author) THEN
        RAISE EXCEPTION 'Correction access denied' USING ERRCODE='42501'; END IF;
    PERFORM set_config('app.user_id',p_author::TEXT,TRUE);
    PERFORM set_config('app.agent_request_id',p_request::TEXT,TRUE);
    PERFORM set_config('app.order_job_id','',TRUE);
    SELECT fn_request_grade_correction(f->>'sheet_number',f->>'record_book',(f->>'new_points')::INT,
        (f->>'new_is_absent')::BOOLEAN,f->>'reason') INTO result;
    RETURN result;
END $$;

CREATE OR REPLACE FUNCTION backend_api.special_execute(c JSONB,p_author INT,p_actor INT,p_request INT,p_key UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE f JSONB:=c->'fields'; r JSONB:=backend_api.special_row(c); v_result JSONB; v_order INT; v_student INT;
    v_inst INT:=backend_api.special_institute(c); v_start DATE; v_end DATE; v_job UUID; v_due DATE; oldp agent_backend.proposal;
BEGIN
    IF NOT backend_api.special_authorized(c,p_author,'prepare') OR NOT backend_api.special_authorized(c,p_actor,'execute')
       OR NOT EXISTS(SELECT 1 FROM agent_request WHERE agent_request_id=p_request AND user_id=p_author) THEN
        RAISE EXCEPTION 'Special command access denied' USING ERRCODE='42501'; END IF;
    PERFORM pg_advisory_xact_lock(9174,1);
    PERFORM set_config('TimeZone','Europe/Moscow',TRUE);
    PERFORM set_config('app.user_id',p_actor::TEXT,TRUE);
    PERFORM set_config('app.agent_request_id',p_request::TEXT,TRUE);
    PERFORM set_config('app.order_job_id','',TRUE);
    IF c->>'kind'='grade_correction' THEN
        PERFORM backend_api.request_correction_as(c,p_author,p_request);
        RETURN r || jsonb_build_object('points',f->'new_points','is_absent',f->'new_is_absent');
    END IF;
    v_student:=(r->>'student_id')::INT;
    PERFORM pg_advisory_xact_lock(7821,v_student);
    CASE c->>'name'
    WHEN 'scholarship_assign' THEN
        v_start:=(f->>'start_date')::DATE; v_end:=(f->>'end_date')::DATE;
        IF v_end<=v_start THEN RAISE EXCEPTION 'Invalid scholarship period' USING ERRCODE='22023'; END IF;
        IF f ? 'order_id' THEN v_order:=(f->>'order_id')::INT;
        ELSE
            INSERT INTO academic_order(order_number,order_date,order_type_id,institute_id,signed_by_id,title,effective_date)
            VALUES(f->>'order_number',(f->>'order_date')::DATE,(SELECT order_type_id FROM order_type WHERE code='scholarship'),
                v_inst,(f->>'signed_by')::INT,'О назначении стипендии',v_start) RETURNING order_id INTO v_order;
            INSERT INTO order_student(order_id,student_id,reason) VALUES(v_order,v_student,f->>'reason');
        END IF;
        INSERT INTO scholarship(student_id,scholarship_type_id,order_id,start_date,end_date)
            VALUES(v_student,(f->>'scholarship_type_id')::INT,v_order,v_start,v_end) RETURNING to_jsonb(scholarship) INTO v_result;
        RETURN v_result;
    WHEN 'scholarship_terminate' THEN
        v_end:=(f->>'end_date')::DATE;
        IF NOT (CURRENT_DATE BETWEEN (r->>'start_date')::DATE AND (r->>'end_date')::DATE)
           OR v_end<CURRENT_DATE OR v_end<=(r->>'start_date')::DATE OR v_end>=(r->>'end_date')::DATE THEN
            RAISE EXCEPTION 'Invalid scholarship termination date' USING ERRCODE='22023'; END IF;
        UPDATE scholarship SET end_date=v_end WHERE scholarship_id=(r->>'scholarship_id')::INT RETURNING to_jsonb(scholarship) INTO v_result;
        RETURN v_result;
    WHEN 'scholarship_cancel' THEN
        IF (r->>'start_date')::DATE<=CURRENT_DATE THEN RAISE EXCEPTION 'Scholarship already started' USING ERRCODE='22023'; END IF;
        DELETE FROM scholarship WHERE scholarship_id=(r->>'scholarship_id')::INT;
        RETURN '{}'::JSONB;
    WHEN 'scheduled_order_cancel' THEN
        v_order:=(r->>'order_id')::INT;
        IF r->>'applied_at' IS NOT NULL OR EXISTS(SELECT 1 FROM academic_order o JOIN order_type ot USING(order_type_id)
            WHERE o.order_id=v_order AND ot.code='enroll') THEN RAISE EXCEPTION 'Order cannot be cancelled' USING ERRCODE='22023'; END IF;
        v_due:=fn_order_due_date(v_order,v_student);
        v_job:=backend_api.track_order(v_order,v_student,p_actor);
        CALL sp_cancel_scheduled_order(f->>'order_number',v_student);
        UPDATE agent_backend.job SET status='cancelled',finished_at=now(),lease_owner=NULL,lease_until=NULL,error_code=NULL,
            result=COALESCE(result,'{}') || jsonb_build_object('cancelled_by',p_actor,'cancellation_proposal_id',p_key,
                'reason',f->>'reason','effective_date',v_due,'order_number',f->>'order_number','institute_id',v_inst,'order_id',v_order,'student_id',v_student)
        WHERE id=v_job;
        FOR oldp IN SELECT * FROM agent_backend.proposal WHERE status='approved'
            AND execution->>'order_id'=v_order::TEXT AND execution->>'student_id'=v_student::TEXT FOR UPDATE LOOP
            IF oldp.execution->>'status'<>'cancelled' THEN
                UPDATE agent_backend.proposal SET execution=execution || jsonb_build_object('status','cancelled',
                    'completed_at',now(),'error',NULL,'cancellation_proposal_id',p_key),version=version+1 WHERE id=oldp.id;
                INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,reason,data)
                    VALUES(oldp.id,p_actor,'execution',f->>'reason',jsonb_build_object('status','cancelled','cancellation_proposal_id',p_key));
            END IF;
        END LOOP;
        RETURN '{}'::JSONB;
    ELSE RAISE EXCEPTION 'Unknown special command' USING ERRCODE='22023';
    END CASE;
END $$;

DO $$ DECLARE constraint_name TEXT; BEGIN
    SELECT conname INTO constraint_name FROM pg_constraint WHERE conrelid='agent_backend.proposal'::REGCLASS AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%execution%not_started%';
    EXECUTE format('ALTER TABLE agent_backend.proposal DROP CONSTRAINT %I',constraint_name);
    ALTER TABLE agent_backend.proposal ADD CONSTRAINT proposal_execution_check CHECK(jsonb_typeof(execution)='object'
        AND execution ? 'status' AND execution->>'status' IN ('not_started','scheduled','running','succeeded','failed','cancelled'));
    ALTER TABLE agent_backend.job DROP CONSTRAINT job_status_check;
    ALTER TABLE agent_backend.job ADD CONSTRAINT job_status_check CHECK(status IN ('queued','running','succeeded','failed','cancelled'));
END $$;

REVOKE ALL ON FUNCTION backend_api.special_normalize(JSONB,INT),backend_api.special_row(JSONB),
    backend_api.special_institute(JSONB),backend_api.special_authorized(JSONB,INT,TEXT,INT),backend_api.special_metadata(JSONB),
    backend_api.special_relations(JSONB),backend_api.special_snapshot(JSONB,INT),backend_api.special_execute(JSONB,INT,INT,INT,UUID),
    backend_api.request_correction_as(JSONB,INT,INT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION backend_api.claim_order_job(p_worker UUID) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_job UUID;
BEGIN
    PERFORM pg_advisory_xact_lock(9174,1);
    IF p_worker IS NULL THEN RAISE EXCEPTION 'Worker required' USING ERRCODE='22023'; END IF;
    PERFORM set_config('TimeZone','Europe/Moscow',TRUE);
    -- Recover pending orders created by the original procedures outside this API too.
    INSERT INTO agent_backend.job(kind,payload,max_attempts,available_at)
    SELECT 'apply_order',jsonb_build_object('order_id',os.order_id,'student_id',os.student_id),3,
           fn_order_due_date(os.order_id,os.student_id)::TIMESTAMP AT TIME ZONE 'Europe/Moscow'
    FROM deanery.order_student os WHERE os.applied_at IS NULL
    ON CONFLICT ((payload->>'order_id'),(payload->>'student_id')) WHERE kind='apply_order' DO NOTHING;

    UPDATE agent_backend.job j SET status='succeeded',progress=100,finished_at=os.applied_at,
        lease_owner=NULL,lease_until=NULL,error_code=NULL,
        result=COALESCE(j.result,'{}') || jsonb_build_object('applied_at',os.applied_at)
    FROM deanery.order_student os WHERE j.kind='apply_order' AND j.status NOT IN ('succeeded','cancelled')
        AND j.payload->>'order_id'=os.order_id::TEXT AND j.payload->>'student_id'=os.student_id::TEXT
        AND os.applied_at IS NOT NULL;
    UPDATE agent_backend.job j SET status='failed',error_code='order_missing',finished_at=now(),lease_owner=NULL,lease_until=NULL
    WHERE kind='apply_order' AND status IN ('queued','running') AND NOT EXISTS(
        SELECT 1 FROM deanery.order_student os WHERE j.payload->>'order_id'=os.order_id::TEXT
        AND j.payload->>'student_id'=os.student_id::TEXT);
    UPDATE agent_backend.job SET status='failed',error_code='lease_exhausted',finished_at=now(),lease_owner=NULL,lease_until=NULL
    WHERE kind='apply_order' AND status='running' AND lease_until<=now() AND attempts>=max_attempts;

    SELECT id INTO v_job FROM agent_backend.job WHERE kind='apply_order' AND attempts<max_attempts
        AND ((status='queued' AND available_at<=now()) OR (status='running' AND lease_until<=now()))
        ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF v_job IS NULL THEN RETURN NULL; END IF;
    UPDATE agent_backend.job SET status='running',attempts=attempts+1,lease_owner=p_worker,
        lease_until=now()+INTERVAL '2 minutes',error_code=NULL WHERE id=v_job;
    RETURN v_job;
END $$;

CREATE OR REPLACE FUNCTION backend_api.perform_order_job(p_job UUID,p_worker UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE j agent_backend.job%ROWTYPE; v_student INT; v_code TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(9174,1);
    PERFORM set_config('TimeZone','Europe/Moscow',TRUE);
    SELECT (payload->>'student_id')::INT INTO v_student FROM agent_backend.job WHERE id=p_job AND kind='apply_order';
    IF NOT FOUND THEN RAISE EXCEPTION 'Job missing' USING ERRCODE='P0002'; END IF;
    -- Same order as run_workflow: student serialization before the job row lock.
    PERFORM pg_advisory_xact_lock(7821,v_student);
    PERFORM 1 FROM deanery.student WHERE student_id=v_student FOR UPDATE;
    SELECT * INTO j FROM agent_backend.job WHERE id=p_job FOR UPDATE;
    IF j.status IN ('succeeded','cancelled') THEN RETURN jsonb_build_object('id',j.id,'status',j.status); END IF;
    IF j.status<>'running' OR j.lease_owner IS DISTINCT FROM p_worker OR j.lease_until<=now() THEN
        RAISE EXCEPTION 'Lease lost' USING ERRCODE='40001';
    END IF;
    BEGIN
        PERFORM backend_api.apply_tracked_order((j.payload->>'order_id')::INT,v_student);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE;
        UPDATE agent_backend.job SET
            status=CASE WHEN (v_code LIKE '40%' OR v_code='55P03') AND attempts<max_attempts THEN 'queued' ELSE 'failed' END,
            available_at=now()+INTERVAL '30 seconds'*attempts,
            error_code=v_code,lease_owner=NULL,lease_until=NULL,
            finished_at=CASE WHEN (v_code LIKE '40%' OR v_code='55P03') AND attempts<max_attempts THEN NULL ELSE now() END
        WHERE id=p_job;
    END;
    SELECT * INTO j FROM agent_backend.job WHERE id=p_job;
    RETURN jsonb_build_object('id',j.id,'status',j.status,'error_code',j.error_code);
END $$;

REVOKE ALL ON FUNCTION backend_api.claim_order_job(UUID),backend_api.perform_order_job(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.claim_order_job(UUID),backend_api.perform_order_job(UUID,UUID) TO backend_worker;
CREATE OR REPLACE FUNCTION backend_api.order_job_status(p_job UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; v_result JSONB;
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(agent_backend.proposal_actor(p_token)) WHERE is_active;
    SELECT jsonb_build_object('id',j.id,'kind',j.kind,'status',j.status,'attempts',j.attempts,
        'max_attempts',j.max_attempts,'progress',j.progress,'error_code',j.error_code,
        'result',jsonb_build_object('order_id',(j.payload->>'order_id')::INT,'student_id',(j.payload->>'student_id')::INT,
            'effective_date',CASE WHEN os.order_id IS NOT NULL THEN fn_order_due_date(os.order_id,os.student_id) ELSE (j.result->>'effective_date')::DATE END,
            'applied_at',os.applied_at,'cancelled_by',j.result->'cancelled_by','cancellation_proposal_id',j.result->'cancellation_proposal_id'))
    INTO v_result FROM agent_backend.job j
    LEFT JOIN order_student os ON j.payload->>'order_id'=os.order_id::TEXT AND j.payload->>'student_id'=os.student_id::TEXT
    LEFT JOIN academic_order o ON o.order_id=os.order_id
    WHERE j.id=p_job AND j.kind='apply_order' AND a.role_code IN ('admin','director','dean_staff')
        AND (a.role_code='admin' OR COALESCE(o.institute_id,(j.result->>'institute_id')::INT)=ANY(a.institute_ids))
        AND EXISTS(SELECT 1 FROM backend_api.allowed_students(a.user_id) s WHERE s.student_id=(j.payload->>'student_id')::INT)
        AND (os.order_id IS NOT NULL OR j.status='cancelled');
    IF v_result IS NULL THEN RAISE EXCEPTION 'Job missing' USING ERRCODE='P0002'; END IF;
    RETURN v_result;
END $$;
