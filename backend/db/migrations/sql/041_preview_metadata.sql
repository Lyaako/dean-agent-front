CREATE FUNCTION backend_api.captured_audit_logs(p_ids BIGINT[]) RETURNS SETOF deanery.audit_log
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT l.* FROM audit_log l WHERE l.audit_id=ANY(p_ids) AND
        COALESCE(NULLIF(current_setting('app.command_audits',TRUE),''),'[]')::JSONB @> jsonb_build_array(l.audit_id)
$$;
CREATE FUNCTION backend_api.captured_audit_details(p_ids BIGINT[]) RETURNS SETOF deanery.audit_log_detail
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT d.* FROM audit_log_detail d WHERE d.audit_id=ANY(p_ids) AND
        COALESCE(NULLIF(current_setting('app.command_audits',TRUE),''),'[]')::JSONB @> jsonb_build_array(d.audit_id)
$$;
CREATE FUNCTION backend_api.record_audit(c JSONB) RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT max(audit_id) FROM audit_log WHERE table_name=c->>'resource' AND record_key=
        (SELECT string_agg(k||'='||v,', ' ORDER BY k) FROM jsonb_each_text(c->'key') e(k,v))
$$;
REVOKE ALL ON FUNCTION backend_api.captured_audit_logs(BIGINT[]),backend_api.captured_audit_details(BIGINT[]),
    backend_api.record_audit(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.captured_audit_logs(BIGINT[]),backend_api.captured_audit_details(BIGINT[]),
    backend_api.record_audit(JSONB) TO backend_api,backend_executor;
DO $$ DECLARE definition TEXT; BEGIN
    SELECT pg_get_functiondef('backend_api.command_preview_v1(jsonb,integer,integer)'::regprocedure) INTO definition;
    IF position('FROM audit_log l' IN definition)=0 OR position('FROM audit_log_detail d' IN definition)=0 THEN
        RAISE EXCEPTION 'Pinned preview changed; operator review required'; END IF;
    definition:=replace(definition,'FROM audit_log l','FROM backend_api.captured_audit_logs(v_ids) l');
    definition:=replace(definition,'FROM audit_log_detail d','FROM backend_api.captured_audit_details(v_ids) d');
    definition:=replace(definition,'JOIN audit_log_detail d','JOIN backend_api.captured_audit_details(v_ids) d');
    EXECUTE definition;
    SELECT pg_get_functiondef('backend_api.undo_proposal(uuid,uuid,text)'::regprocedure) INTO definition;
    definition:=replace(definition,'SELECT max(audit_id) INTO audit_marker FROM audit_log l WHERE l.table_name=c->>''resource'' AND l.record_key=record_key;',
        'audit_marker:=backend_api.record_audit(c);');
    EXECUTE definition;
END $$;
