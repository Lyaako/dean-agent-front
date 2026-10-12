-- Run once as the database administrator in a separate, empty environment.
DO $$
DECLARE role_name TEXT;
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'backend_migration') THEN
        CREATE ROLE backend_migration NOLOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOBYPASSRLS;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['backend_api', 'backend_executor', 'backend_read', 'backend_worker'] LOOP
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', role_name);
        END IF;
    END LOOP;
    EXECUTE format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', current_database());
    EXECUTE format('GRANT CREATE ON DATABASE %I TO backend_migration', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO backend_api, backend_executor, backend_read, backend_worker', current_database());
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO backend_migration;

