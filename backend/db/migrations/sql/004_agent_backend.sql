CREATE SCHEMA agent_backend;
CREATE SCHEMA backend_api;
REVOKE ALL ON SCHEMA agent_backend, backend_api FROM PUBLIC;
GRANT USAGE ON SCHEMA backend_api TO backend_api, backend_executor, backend_read, backend_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA agent_backend REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA backend_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE agent_backend.auth_session (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INT NOT NULL REFERENCES deanery.app_user(user_id),
    csrf_hash BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
);
CREATE INDEX auth_session_user ON agent_backend.auth_session(user_id);

CREATE TABLE agent_backend.auth_token (
    token_hash BYTEA PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES agent_backend.auth_session(id),
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    generation INT NOT NULL CHECK (generation >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
);
CREATE INDEX auth_token_session ON agent_backend.auth_token(session_id, kind, generation);

CREATE TABLE agent_backend.chat_session (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INT NOT NULL REFERENCES deanery.app_user(user_id),
    title VARCHAR(255) NOT NULL CHECK (title = btrim(title) AND title <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX chat_session_owner_order ON agent_backend.chat_session(user_id, updated_at DESC, id);

CREATE TABLE agent_backend.chat_message (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES agent_backend.chat_session(id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'error')),
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
    UNIQUE (session_id, sequence)
);

CREATE TABLE agent_backend.agent_run (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES agent_backend.chat_session(id) ON DELETE SET NULL,
    initiator_user_id INT NOT NULL REFERENCES deanery.app_user(user_id),
    agent_request_id INT UNIQUE REFERENCES deanery.agent_request(agent_request_id),
    status TEXT NOT NULL,
    events JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(events) = 'array'),
    tools_used JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tools_used) = 'array'),
    result JSONB,
    error_code TEXT,
    stop_requested_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMPTZ,
    lease_until TIMESTAMPTZ,
    conversation_deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX agent_run_one_active_per_chat ON agent_backend.agent_run(session_id)
    WHERE finished_at IS NULL;
CREATE INDEX agent_run_owner ON agent_backend.agent_run(initiator_user_id, created_at DESC, id);

CREATE TABLE agent_backend.proposal (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    initiator_user_id INT NOT NULL REFERENCES deanery.app_user(user_id),
    run_id UUID REFERENCES agent_backend.agent_run(id),
    agent_request_id INT REFERENCES deanery.agent_request(agent_request_id),
    kind TEXT NOT NULL,
    command JSONB NOT NULL CHECK (jsonb_typeof(command) = 'object'),
    preview JSONB NOT NULL CHECK (jsonb_typeof(preview) = 'object'),
    snapshot JSONB,
    snapshot_hash TEXT,
    explanation TEXT NOT NULL,
    reason TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    institute_id INT REFERENCES deanery.institute(institute_id),
    assignee_user_id INT REFERENCES deanery.app_user(user_id),
    version INT NOT NULL DEFAULT 1 CHECK (version > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    validity TEXT NOT NULL DEFAULT 'current' CHECK (validity IN ('current', 'expired', 'stale', 'superseded')),
    execution JSONB NOT NULL DEFAULT '{"status":"not_started"}'
        CHECK (jsonb_typeof(execution) = 'object' AND execution ? 'status'
               AND execution->>'status' IN ('not_started', 'scheduled', 'running', 'succeeded', 'failed')),
    effective_date DATE,
    decided_by INT REFERENCES deanery.app_user(user_id),
    decided_at TIMESTAMPTZ,
    decision_reason TEXT,
    submission_status TEXT CHECK (submission_status IN ('draft', 'submitted')),
    correction_id INT UNIQUE REFERENCES deanery.grade_correction(correction_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((kind = 'grade_correction') = (submission_status IS NOT NULL)),
    CHECK (submission_status IS DISTINCT FROM 'submitted' OR correction_id IS NOT NULL),
    CHECK (correction_id IS NULL OR submission_status = 'submitted')
);
CREATE INDEX proposal_author_order ON agent_backend.proposal(initiator_user_id, created_at DESC, id);
CREATE INDEX proposal_incoming ON agent_backend.proposal(institute_id, status, assignee_user_id, created_at, id);
CREATE INDEX proposal_execution ON agent_backend.proposal((execution->>'status'), effective_date);

CREATE TABLE agent_backend.proposal_event (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id UUID NOT NULL REFERENCES agent_backend.proposal(id),
    actor_user_id INT REFERENCES deanery.app_user(user_id),
    event_type TEXT NOT NULL,
    reason TEXT,
    data JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX proposal_event_order ON agent_backend.proposal_event(proposal_id, id);

CREATE TABLE agent_backend.idempotency_record (
    user_id INT NOT NULL REFERENCES deanery.app_user(user_id),
    route TEXT NOT NULL,
    key UUID NOT NULL,
    request_hash BYTEA NOT NULL,
    response_status INT CHECK (response_status BETWEEN 100 AND 599),
    response_body JSONB,
    run_id UUID REFERENCES agent_backend.agent_run(id),
    session_id UUID REFERENCES agent_backend.chat_session(id) ON DELETE SET NULL,
    response_removed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, route, key)
);
CREATE INDEX idempotency_session ON agent_backend.idempotency_record(session_id);
CREATE INDEX idempotency_run ON agent_backend.idempotency_record(run_id);

CREATE TABLE agent_backend.file (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id INT NOT NULL REFERENCES deanery.app_user(user_id),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX file_owner ON agent_backend.file(owner_user_id, created_at, id);

CREATE TABLE agent_backend.file_version (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id UUID NOT NULL REFERENCES agent_backend.file(id),
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
    storage_key TEXT NOT NULL UNIQUE,
    content_hash BYTEA NOT NULL,
    extraction_state TEXT NOT NULL DEFAULT 'queued' CHECK (extraction_state IN ('queued', 'processing', 'ready', 'partial', 'failed')),
    extraction JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extraction) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX file_version_file ON agent_backend.file_version(file_id, created_at, id);

CREATE TABLE agent_backend.run_attachment (
    run_id UUID NOT NULL REFERENCES agent_backend.agent_run(id),
    version_id UUID NOT NULL REFERENCES agent_backend.file_version(id),
    context_state TEXT NOT NULL DEFAULT 'pending' CHECK (context_state IN ('pending', 'provided', 'used', 'not_used')),
    context_mode TEXT NOT NULL DEFAULT 'none' CHECK (context_mode IN ('text', 'vision', 'text_and_vision', 'none')),
    manifest JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(manifest) = 'object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (run_id, version_id)
);

CREATE TABLE agent_backend.job (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id INT REFERENCES deanery.app_user(user_id),
    kind TEXT NOT NULL,
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INT NOT NULL CHECK (max_attempts > 0),
    progress NUMERIC NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100 AND progress <> 'NaN'::NUMERIC),
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_owner UUID,
    lease_until TIMESTAMPTZ,
    result JSONB,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMPTZ
);
CREATE INDEX job_available ON agent_backend.job(status, available_at, id);
CREATE INDEX job_lease ON agent_backend.job(lease_until) WHERE status = 'running';

CREATE TABLE agent_backend.regulation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agent_backend.regulation_version (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    regulation_id UUID NOT NULL REFERENCES agent_backend.regulation(id),
    source TEXT NOT NULL,
    storage_key TEXT,
    content_hash BYTEA,
    processing_state TEXT NOT NULL,
    published_at TIMESTAMPTZ,
    published_by INT REFERENCES deanery.app_user(user_id),
    metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX regulation_version_document ON agent_backend.regulation_version(regulation_id, created_at, id);

CREATE TABLE agent_backend.regulation_chunk (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id UUID NOT NULL REFERENCES agent_backend.regulation_version(id),
    sequence INT NOT NULL CHECK (sequence >= 0),
    text TEXT NOT NULL,
    locator JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(locator) = 'object'),
    index_state TEXT NOT NULL,
    UNIQUE (version_id, sequence)
);

CREATE FUNCTION agent_backend.guard_proposal_command() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF ROW(NEW.id, NEW.initiator_user_id, NEW.run_id, NEW.agent_request_id, NEW.kind,
           NEW.command, NEW.preview, NEW.snapshot, NEW.snapshot_hash, NEW.explanation, NEW.reason,
           NEW.expires_at, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.initiator_user_id, OLD.run_id, OLD.agent_request_id, OLD.kind,
           OLD.command, OLD.preview, OLD.snapshot, OLD.snapshot_hash, OLD.explanation, OLD.reason,
           OLD.expires_at, OLD.created_at) THEN
        RAISE EXCEPTION 'Сохранённая команда предложения неизменяема' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER proposal_command_immutable BEFORE UPDATE ON agent_backend.proposal
FOR EACH ROW EXECUTE FUNCTION agent_backend.guard_proposal_command();

CREATE FUNCTION agent_backend.guard_proposal_event() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'История предложений доступна только для добавления' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER proposal_event_append_only BEFORE UPDATE OR DELETE ON agent_backend.proposal_event
FOR EACH ROW EXECUTE FUNCTION agent_backend.guard_proposal_event();

CREATE FUNCTION agent_backend.guard_file_original() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF ROW(NEW.id, NEW.file_id, NEW.original_name, NEW.mime_type, NEW.byte_size,
           NEW.storage_key, NEW.content_hash, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.file_id, OLD.original_name, OLD.mime_type, OLD.byte_size,
           OLD.storage_key, OLD.content_hash, OLD.created_at) THEN
        RAISE EXCEPTION 'Оригинал версии файла неизменяем' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER file_original_immutable BEFORE UPDATE ON agent_backend.file_version
FOR EACH ROW EXECUTE FUNCTION agent_backend.guard_file_original();

CREATE FUNCTION agent_backend.clear_deleted_conversation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF EXISTS (SELECT FROM agent_backend.agent_run WHERE session_id = OLD.id AND finished_at IS NULL) THEN
        RAISE EXCEPTION 'Сначала остановите агента' USING ERRCODE = '55000';
    END IF;
    UPDATE deanery.agent_request SET request_text = 'Переписка удалена', response_text = NULL
    WHERE agent_request_id IN (SELECT agent_request_id FROM agent_backend.agent_run WHERE session_id = OLD.id);
    UPDATE agent_backend.idempotency_record SET response_body = NULL, response_removed_at = CURRENT_TIMESTAMP
    WHERE session_id = OLD.id OR run_id IN (SELECT id FROM agent_backend.agent_run WHERE session_id = OLD.id);
    UPDATE agent_backend.agent_run SET events = '[]', result = NULL, conversation_deleted_at = CURRENT_TIMESTAMP
    WHERE session_id = OLD.id;
    RETURN OLD;
END $$;
CREATE TRIGGER chat_clear_copies BEFORE DELETE ON agent_backend.chat_session
FOR EACH ROW EXECUTE FUNCTION agent_backend.clear_deleted_conversation();

REVOKE ALL ON ALL TABLES IN SCHEMA agent_backend FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA agent_backend FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA agent_backend FROM PUBLIC;
-- Runtime grants and protected projections are introduced with the scoped access layer in P02.

