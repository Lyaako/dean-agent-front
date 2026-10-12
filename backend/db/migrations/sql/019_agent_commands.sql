CREATE OR REPLACE FUNCTION backend_api.root_change_policy(p_resource TEXT) RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
    SELECT '{"document_request":{"pk":"request_id","insert":["copies","document_type_id","purpose","request_status_id","student_id"],"update":["completed_at","copies","processed_by_id","purpose","request_status_id"]},"academic_work":{"pk":"work_id","insert":["item_id","order_id","reviewer_id","student_id","supervisor_id","topic"],"update":["order_id","reviewer_id","supervisor_id","topic"]},"grade":{"pk":"grade_id","insert":["is_absent","points","sheet_id","student_id"],"update":["is_absent","points"]},"attendance":{"pk":"attendance_id","insert":["absence_reason","is_present","lesson_date","slot_id","student_id"],"update":["absence_reason","is_present"]},"grade_sheet":{"pk":"sheet_id","insert":["closed_date","exam_date","examiner_id","group_id","issue_date","item_id","sheet_kind","sheet_number","stage","status"],"update":["closed_date","exam_date","examiner_id","status"]},"practice_placement":{"pk":"placement_id","insert":["end_date","item_id","order_id","org_contact_id","start_date","student_id","supervisor_id"],"update":["end_date","order_id","org_contact_id","start_date","supervisor_id"]},"teaching_assignment":{"pk":"assignment_id","insert":["group_id","item_id","lesson_type_id","subgroup","teacher_id"],"update":["lesson_type_id","subgroup","teacher_id"]},"schedule_slot":{"pk":"slot_id","insert":["assignment_id","classroom_id","pair_number","term_id","valid_from","valid_to","week_parity","weekday"],"update":["classroom_id","pair_number","valid_from","valid_to","week_parity","weekday"]},"organization_contact":{"pk":"org_contact_id","insert":["email","first_name","job_title","last_name","middle_name","organization_id","phone"],"update":["email","first_name","job_title","last_name","middle_name","organization_id","phone"]},"contact_person":{"pk":"contact_person_id","insert":["email","first_name","last_name","middle_name","phone"],"update":["email","first_name","last_name","middle_name","phone"]}}'::JSONB -> p_resource
$$;

CREATE OR REPLACE FUNCTION backend_api.root_change_normalize(c JSONB,p_author INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE policy JSONB:=backend_api.root_change_policy(c->>'resource'); k TEXT; a RECORD;
BEGIN
    IF policy IS NULL OR c->>'operation' NOT IN ('create','update') OR c->>'operation' IS NULL OR
       jsonb_typeof(c->'key') IS DISTINCT FROM 'object' OR jsonb_typeof(c->'fields') IS DISTINCT FROM 'object' OR
       c->'fields'='{}'::JSONB OR c-ARRAY['version','kind','resource','operation','key','fields']<>'{}'::JSONB THEN
        RAISE EXCEPTION 'Invalid root command' USING ERRCODE='22023';
    END IF;
    IF c->>'operation'='create' THEN
        IF c->'key'<>'{}'::JSONB THEN RAISE EXCEPTION 'Create has no key' USING ERRCODE='22023'; END IF;
    ELSIF (c->'key')-(policy->>'pk')<>'{}'::JSONB OR
          jsonb_typeof(c->'key'->(policy->>'pk')) IS DISTINCT FROM 'number' OR
          (c->'key'->>(policy->>'pk')) !~ '^[1-9][0-9]*$' THEN
        RAISE EXCEPTION 'Exact primary key required' USING ERRCODE='22023';
    END IF;
    FOR k IN SELECT jsonb_object_keys(c->'fields') LOOP
        IF NOT (policy->CASE c->>'operation' WHEN 'create' THEN 'insert' ELSE 'update' END) ? k OR
           jsonb_typeof(c->'fields'->k) NOT IN ('null','string','number','boolean') THEN
            RAISE EXCEPTION 'Forbidden root field' USING ERRCODE='22023';
        END IF;
    END LOOP;
    SELECT * INTO a FROM backend_api.account_snapshot(p_author);
    IF a.role_code='student' AND c->>'resource'='document_request' AND c->>'operation'='create'
       AND NOT c->'fields' ? 'student_id' THEN
        c:=jsonb_set(c,'{fields,student_id}',to_jsonb(a.student_id));
    END IF;
    RETURN c;
END $$;

CREATE OR REPLACE FUNCTION backend_api.root_change_authorized(c JSONB,p_user INT,p_mode TEXT,p_stored_institute INT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE a RECORD; r JSONB; merged JSONB; resource TEXT:=c->>'resource';
BEGIN
    SELECT * INTO a FROM backend_api.account_snapshot(p_user) WHERE is_active;
    IF NOT FOUND OR p_mode NOT IN ('prepare','execute') OR p_mode IS NULL OR
       backend_api.root_change_policy(resource) IS NULL OR c->>'operation' NOT IN ('create','update') THEN RETURN FALSE; END IF;
    r:=backend_api.command_row(c);
    IF r IS NULL THEN
        RETURN p_mode='execute' AND a.role_code IN ('admin','director','dean_staff') AND
            (a.role_code='admin' OR p_stored_institute=ANY(a.institute_ids));
    END IF;
    merged:=r || (c->'fields');
    IF a.role_code NOT IN ('admin','director','dean_staff') THEN
        IF p_mode<>'prepare' THEN RETURN FALSE; END IF;
        IF a.role_code='teacher' THEN
            IF resource='academic_work' THEN
                IF c->>'operation'<>'update' OR (c->'fields')-'topic'<>'{}'::JSONB OR
                    (r->>'supervisor_id')::INT IS DISTINCT FROM a.teacher_id THEN RETURN FALSE; END IF;
            ELSIF resource='grade' THEN
                IF NOT EXISTS(SELECT 1 FROM grade_sheet gs JOIN teaching_assignment ta
                    ON ta.item_id=gs.item_id AND ta.group_id=gs.group_id
                    WHERE gs.sheet_id=(r->>'sheet_id')::INT AND gs.examiner_id=a.teacher_id
                      AND ta.teacher_id=a.teacher_id) THEN RETURN FALSE; END IF;
            ELSIF resource='attendance' THEN
                IF NOT EXISTS(SELECT 1 FROM schedule_slot ss JOIN teaching_assignment ta USING(assignment_id)
                    WHERE ss.slot_id=(r->>'slot_id')::INT AND ta.teacher_id=a.teacher_id) THEN RETURN FALSE; END IF;
            ELSE RETURN FALSE;
            END IF;
        ELSIF a.role_code='student' THEN
            IF resource<>'document_request' OR (r->>'student_id')::INT IS DISTINCT FROM a.student_id OR
               (c->>'operation'='create' AND (c->'fields')-ARRAY['student_id','document_type_id','copies','purpose']<>'{}'::JSONB) OR
               (c->>'operation'='update' AND (c->'fields')-ARRAY['copies','purpose']<>'{}'::JSONB) THEN RETURN FALSE; END IF;
        ELSE RETURN FALSE;
        END IF;
    END IF;
    RETURN backend_api.record_in_scope(resource,r,p_user,a.role_code) AND
           backend_api.record_in_scope(resource,merged,p_user,a.role_code);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN FALSE;
END $$;

CREATE OR REPLACE FUNCTION backend_api.root_change_snapshot(c JSONB,p_author INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE out JSONB:='{}'; r JSONB:=backend_api.command_row(c); child JSONB;
BEGIN
    IF c->>'resource' IN ('grade','attendance','grade_sheet') THEN
        out:=jsonb_build_object('calendar_date',(now() AT TIME ZONE 'Europe/Moscow')::DATE);
        FOR child IN SELECT to_jsonb(g) FROM grade g WHERE g.student_id=(r->>'student_id')::INT LOOP
            out:=backend_api.command_dependencies('grade',child,out);
        END LOOP;
        FOR child IN SELECT to_jsonb(b) FROM score_band b LOOP
            out:=backend_api.command_dependencies('score_band',child,out);
        END LOOP;
        FOR child IN SELECT to_jsonb(h) FROM holiday h WHERE h.holiday_date=(r->>'lesson_date')::DATE LOOP
            out:=backend_api.command_dependencies('holiday',child,out);
        END LOOP;
    END IF;
    RETURN out;
END $$;

REVOKE ALL ON FUNCTION backend_api.root_change_policy(TEXT),backend_api.root_change_normalize(JSONB,INT),
    backend_api.root_change_authorized(JSONB,INT,TEXT,INT),backend_api.root_change_snapshot(JSONB,INT) FROM PUBLIC;
