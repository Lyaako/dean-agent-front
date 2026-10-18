-- Подписи строк пакета: «кто/что» и уточнение по-русски, по текущим данным; в снимок и проверки не входят.
-- Права — как у предложения: SECURITY DEFINER, подпись видна всем, кто видит само предложение.
CREATE FUNCTION backend_api.batch_item_label(item JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE c JSONB:=item->'command'; resource TEXT:=c->>'resource'; created BOOLEAN:=c->>'operation'='create';
    r JSONB; v_record TEXT; v_sub TEXT; fields JSONB;
BEGIN
    -- Новая запись — по её значениям, существующая — по текущей строке (удалённая — по снимку до изменения).
    r:=CASE WHEN created THEN c->'fields' ELSE COALESCE(backend_api.command_row(c),item->'before',c->'key') END;
    CASE resource
    WHEN 'student' THEN
        SELECT fn_full_name(p),g.name INTO v_record,v_sub FROM student s JOIN person p USING(person_id)
            JOIN study_group g ON g.group_id=s.group_id WHERE s.student_id=(r->>'student_id')::INT;
    WHEN 'grade' THEN
        SELECT fn_full_name(p),(SELECT sheet_number FROM grade_sheet WHERE sheet_id=(r->>'sheet_id')::INT)
            INTO v_record,v_sub FROM student s JOIN person p USING(person_id) WHERE s.student_id=(r->>'student_id')::INT;
    WHEN 'attendance' THEN
        SELECT fn_full_name(p),concat_ws(' · ',to_char((r->>'lesson_date')::DATE,'DD.MM.YYYY'),
                (SELECT ss.pair_number||' пара' FROM schedule_slot ss WHERE ss.slot_id=(r->>'slot_id')::INT),
                (SELECT d.name FROM schedule_slot ss JOIN teaching_assignment ta USING(assignment_id)
                    JOIN curriculum_item ci USING(item_id) JOIN discipline d USING(discipline_id)
                    WHERE ss.slot_id=(r->>'slot_id')::INT))
            INTO v_record,v_sub FROM student s JOIN person p USING(person_id) WHERE s.student_id=(r->>'student_id')::INT;
    WHEN 'document_request' THEN
        v_record:=CASE WHEN r ? 'request_id' THEN 'Заявка № '||(r->>'request_id') END;
        SELECT concat_ws(' · ',(SELECT name FROM document_type WHERE document_type_id=(r->>'document_type_id')::INT),
                p.last_name||' '||left(p.first_name,1)||'.'||COALESCE(' '||left(p.middle_name,1)||'.',''))
            INTO v_sub FROM student s JOIN person p USING(person_id) WHERE s.student_id=(r->>'student_id')::INT;
        IF v_record IS NULL AND v_sub IS NOT NULL THEN v_record:='Новая заявка'; END IF;
    WHEN 'academic_work' THEN
        -- Вид работы — как в v_academic_works.
        SELECT fn_full_name(p),(SELECT CASE d.kind WHEN 'coursework' THEN 'Курсовая работа' ELSE 'ВКР' END
                FROM curriculum_item ci JOIN discipline d USING(discipline_id) WHERE ci.item_id=(r->>'item_id')::INT)
            INTO v_record,v_sub FROM student s JOIN person p USING(person_id) WHERE s.student_id=(r->>'student_id')::INT;
    WHEN 'schedule_slot' THEN
        SELECT d.name||' · '||g.name INTO v_record FROM teaching_assignment ta JOIN study_group g USING(group_id)
            JOIN curriculum_item ci USING(item_id) JOIN discipline d USING(discipline_id)
            WHERE ta.assignment_id=(r->>'assignment_id')::INT;
        -- Названия дней — как в fn_check_slot.
        v_sub:=CASE WHEN r ? 'weekday' THEN (ARRAY['пн','вт','ср','чт','пт','сб'])[(r->>'weekday')::INT]
            ||COALESCE(' · '||(r->>'pair_number')||' пара','') END;
    ELSE NULL;
    END CASE;
    IF v_record IS NULL THEN
        v_record:=COALESCE(obj_description(format('deanery.%I',resource)::regclass,'pg_class'),resource);
        v_sub:=CASE WHEN created THEN 'новая запись' ELSE
            (SELECT string_agg(k||'='||v,', ' ORDER BY k) FROM jsonb_each_text(c->'key') e(k,v)) END;
    END IF;
    SELECT jsonb_object_agg(f,col_description(format('deanery.%I',resource)::regclass,a.attnum))
        INTO fields FROM jsonb_object_keys(c->'fields') f
        JOIN pg_attribute a ON a.attrelid=format('deanery.%I',resource)::regclass AND a.attname=f;
    RETURN jsonb_build_object('record',v_record,'sub',NULLIF(v_sub,''),'fields',COALESCE(fields,'{}'::JSONB));
EXCEPTION WHEN undefined_table OR invalid_text_representation THEN
    RETURN jsonb_build_object('record',resource,'sub',NULL,'fields','{}'::JSONB);
END $$;

ALTER FUNCTION agent_backend.proposal_view(agent_backend.proposal,INT) RENAME TO proposal_view_v4;
CREATE FUNCTION agent_backend.proposal_view(p agent_backend.proposal,p_user INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE result JSONB:=agent_backend.proposal_view_v4(p,p_user); labels JSONB:='{}'; item JSONB; items JSONB:='[]'; preview JSONB:='[]';
BEGIN
    IF p.kind<>'batch' THEN RETURN result; END IF;
    FOR item IN SELECT jsonb_array_elements(p.command->'items') LOOP
        labels:=labels||jsonb_build_object(item->>'item_id',backend_api.batch_item_label(item||jsonb_build_object('before',
            (SELECT value->'before' FROM jsonb_array_elements(p.preview->'items') WHERE value->>'item_id'=item->>'item_id'))));
    END LOOP;
    FOR item IN SELECT jsonb_array_elements(COALESCE(result->'items','[]')) LOOP
        items:=items||(item||jsonb_build_object('label',labels->(item->>'item_id')));
    END LOOP;
    FOR item IN SELECT jsonb_array_elements(COALESCE(result->'preview'->'items','[]')) LOOP
        preview:=preview||(item||jsonb_build_object('label',labels->(item->>'item_id')));
    END LOOP;
    result:=result||jsonb_build_object('items',items);
    IF jsonb_typeof(result->'preview'->'items')='array' THEN
        result:=jsonb_set(result,'{preview,items}',preview);
    END IF;
    RETURN result;
END $$;

REVOKE ALL ON FUNCTION backend_api.batch_item_label(JSONB),agent_backend.proposal_view(agent_backend.proposal,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.batch_item_label(JSONB),agent_backend.proposal_view(agent_backend.proposal,INT)
    TO backend_api,backend_executor;
