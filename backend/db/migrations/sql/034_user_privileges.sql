CREATE FUNCTION backend_api.database_actor(p_user INT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT jsonb_build_object('role',r.code,'db_login',u.db_login,'must_change_password',backend_api.password_required(u.user_id)) FROM app_user u
        JOIN app_role r USING(role_id) WHERE u.user_id=p_user AND u.is_active
$$;
REVOKE ALL ON FUNCTION backend_api.database_actor(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.database_actor(INT) TO backend_api,backend_executor,backend_read,backend_worker;

-- NOLOGIN user roles get private application metadata rights, never owner rights on domain tables.
GRANT USAGE ON SCHEMA agent_backend TO backend_api,backend_executor,backend_worker;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA agent_backend TO backend_api,backend_executor;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA agent_backend TO backend_api,backend_executor;
DO $$ DECLARE f RECORD; BEGIN
    FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('backend_api','agent_backend') AND p.proname IN
        ('mutate_record_as','run_workflow_as','special_execute','request_correction_as','command_execute',
         'command_preview','mutate_record','run_workflow','decide_proposal','submit_proposal',
         'prepare_proposal_as','prepare_proposal','prepare_run_proposal')
    LOOP
        EXECUTE format('ALTER FUNCTION %s SECURITY INVOKER',f.signature);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO backend_api,backend_executor',f.signature);
    END LOOP;
END $$;
DO $$ DECLARE f RECORD; BEGIN
    FOR f IN WITH RECURSIVE needed(oid) AS (
        SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('backend_api','agent_backend') AND p.proname IN
            ('mutate_record_as','run_workflow_as','special_execute','request_correction_as','command_execute',
             'command_preview','mutate_record','run_workflow','decide_proposal','submit_proposal',
             'prepare_proposal_as','prepare_proposal','prepare_run_proposal')
        UNION
        SELECT child.oid FROM needed a JOIN pg_proc parent ON parent.oid=a.oid
            CROSS JOIN LATERAL regexp_matches(parent.prosrc,'((backend_api|agent_backend)\.[a-z_]+)[[:space:]]*\(','g') m
            JOIN pg_proc child ON TRUE JOIN pg_namespace ns ON ns.oid=child.pronamespace
            WHERE NOT parent.prosecdef AND ns.nspname||'.'||child.proname=m[1]
    ) SELECT p.oid::regprocedure AS signature FROM needed n JOIN pg_proc p ON p.oid=n.oid
    LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO backend_api,backend_executor',f.signature); END LOOP;
END $$;
-- Membership in backend_read is assigned by the owner provisioning script.
