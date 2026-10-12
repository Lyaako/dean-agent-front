"""P13 readiness observes committed polls and never logs private request data."""

from contextlib import contextmanager
import asyncio
import importlib
import json
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import psycopg
import pytest

from backend import service_status as status
from backend.app import app, actor, db_connection
from backend.agent_config import AgentSettings
from backend.knowledge_config import KnowledgeSettings


@pytest.fixture
def health_root(tmp_path, monkeypatch):
    monkeypatch.setenv("DEANERY_HEALTH_ROOT", str(tmp_path))
    for service in status.SERVICES - {"api"}:
        (tmp_path / service).mkdir()
    return tmp_path


def test_marker_idle_fresh_stale_revoked_and_no_implicit_mount(health_root, monkeypatch):
    monkeypatch.setattr(status, "time", lambda: 1000)
    assert status.worker_status("agent") == "unavailable"
    status.mark_alive("agent")
    assert status.worker_status("agent") == "ready"
    monkeypatch.setattr(status, "time", lambda: 1046)
    assert status.worker_status("agent") == "unavailable"
    status.mark_alive("agent")
    status.mark_unavailable("agent")
    assert status.worker_status("agent") == "unavailable"
    missing = health_root / "not-mounted"
    monkeypatch.setenv("DEANERY_HEALTH_ROOT", str(missing))
    status.mark_alive("file")
    assert not missing.exists()


@pytest.mark.parametrize("payload", ["[]", "null", "garbage", "x" * 1025,
    '{"service":"file","checked_at":1000}', '{"service":"agent","checked_at":1001}',
    '{"service":"agent","checked_at":true}', '{"service":"agent","checked_at":NaN}'])
def test_bad_marker_is_unavailable(health_root, monkeypatch, payload):
    monkeypatch.setattr(status, "time", lambda: 1000)
    (health_root / "agent" / "status.json").write_text(payload, encoding="utf-8")
    assert status.worker_status("agent") == "unavailable"


def test_log_allowlist_drops_private_and_malformed_fields(capsys):
    request_id = uuid4()
    status.log_event("api", "http_response", request_id=request_id, route="/api/v1/files/{file_id}",
                     method="GET", http_status=200, duration_ms=12, body="PRIVATE_DOCUMENT",
                     query="SECRET_QUERY", authorization="SECRET_TOKEN", run_id="SECRET_RUN",
                     error_code="SECRET password=value", exception="SECRET_EXCEPTION")
    output = capsys.readouterr().out
    row = json.loads(output)
    assert row["request_id"] == str(request_id) and row["http_status"] == 200
    assert row["route"] == "/api/v1/files/{file_id}" and row["duration_ms"] == 12
    assert "PRIVATE" not in output and "SECRET" not in output


@pytest.mark.parametrize("ready,expected", [(True, "ready"), (False, "schema_unavailable")])
def test_database_readiness_uses_api_role_and_bounded_function_privileges(monkeypatch, ready, expected):
    calls = []
    class DB:
        def execute(self, query, args=()):
            calls.append((query, args))
            return SimpleNamespace(fetchone=lambda: (ready,))
    @contextmanager
    def connect(dsn, **kwargs):
        assert dsn == "private-test-dsn" and kwargs["connect_timeout"] == 1
        assert "statement_timeout=1000" in kwargs["options"] and "lock_timeout=1000" in kwargs["options"]
        yield DB()
    monkeypatch.setenv("DATABASE_URL", "private-test-dsn")
    monkeypatch.setattr(status.psycopg, "connect", connect)
    assert status.database_status() == expected
    assert calls[0][0] == "SET LOCAL ROLE backend_api"
    assert "has_function_privilege" in calls[1][0] and calls[1][1] == (list(status.REQUIRED_FUNCTIONS),)


def test_database_failure_is_safe_and_api_status_has_no_provider_dependency(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "PRIVATE_DSN")
    def fail(*args, **kwargs):
        raise psycopg.OperationalError("PRIVATE_PASSWORD and document")
    monkeypatch.setattr(status.psycopg, "connect", fail)
    with TestClient(app) as client:
        response = client.get("/api/v1/health/ready?SECRET_QUERY", headers={"Authorization": "SECRET_TOKEN"})
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable", "error_code": "database_unavailable"}
    assert "PRIVATE" not in response.text + capsys.readouterr().out
    assert response.headers["X-Request-ID"]


@pytest.mark.parametrize("state,code", [("ready", 200), ("schema_unavailable", 503)])
def test_readiness_http_contract(monkeypatch, state, code):
    monkeypatch.setattr("backend.app.database_status", lambda: state)
    with TestClient(app) as client:
        response = client.get("/api/v1/health/ready")
    assert response.status_code == code


def test_unexpected_http_failure_hides_exception_and_private_url(monkeypatch, capsys):
    def fail():
        raise RuntimeError("SECRET_DOCUMENT_PASSWORD")
    monkeypatch.setattr("backend.app.database_status", fail)
    with TestClient(app) as client:
        response = client.get("/api/v1/health/ready?SECRET_QUERY", headers={"Authorization": "SECRET_TOKEN"})
    logs = capsys.readouterr().out
    assert response.status_code == 500 and response.json()["error"]["code"] == "internal_error"
    assert "SECRET" not in response.text + logs
    assert json.loads(logs)["http_status"] == 500


@pytest.mark.parametrize("commit_fails", [False, True])
def test_upload_correlation_is_logged_only_after_successful_commit(monkeypatch, capsys, commit_fails):
    job_id = uuid4()
    def connection():
        yield None
        if commit_fails:
            raise psycopg.OperationalError("SECRET_COMMIT_ERROR")
    async def uploaded(*args):
        return {"job": {"id": str(job_id)}}
    app.dependency_overrides[actor] = lambda: None
    app.dependency_overrides[db_connection] = connection
    monkeypatch.setattr("backend.app.files.upload", uploaded)
    monkeypatch.setenv("DEANERY_ORIGIN", "http://testserver")
    try:
        with TestClient(app) as client:
            response = client.post("/api/v1/files", headers={"Origin": "http://testserver",
                "Authorization": "Bearer SECRET_TOKEN", "Idempotency-Key": str(uuid4())})
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == (503 if commit_fails else 201)
    output = capsys.readouterr().out
    logged = json.loads(output)
    assert ("job_id" not in logged) if commit_fails else logged["job_id"] == str(job_id)
    assert "SECRET" not in output


@pytest.mark.parametrize("service", ["agent", "file", "knowledge", "order"])
@pytest.mark.parametrize("commit_fails", [False, True])
def test_worker_marks_alive_after_commit_only(monkeypatch, service, commit_fails):
    module = importlib.import_module("backend." + ("file_worker" if service == "file" else service + "_worker"))
    events = []
    class DB:
        def execute(self, *args):
            return SimpleNamespace(fetchone=lambda: (None,) if service == "order" else {"result": None})
    @contextmanager
    def connect(*args, **kwargs):
        if service == "order":
            assert kwargs["connect_timeout"] == 5
            assert "statement_timeout=30000" in kwargs["options"]
        yield DB()
        if commit_fails:
            raise psycopg.OperationalError("SECRET_COMMIT_FAILURE")
        events.append("commit")
    monkeypatch.setattr(module, "mark_alive", lambda name: events.append(name))
    if service == "order":
        monkeypatch.setattr(module.psycopg, "connect", connect)
        settings = "private-dsn"
    else:
        settings = SimpleNamespace(connect=connect)
    if commit_fails:
        with pytest.raises(psycopg.OperationalError):
            module.run_once(settings, uuid4())
        assert not events
    else:
        assert module.run_once(settings, uuid4()) is None
        assert events == ["commit", service]


@pytest.mark.parametrize("service", ["agent", "order"])
def test_worker_error_invalidates_marker_and_hides_exception(health_root, monkeypatch, capsys, service):
    module = importlib.import_module("backend." + service + "_worker")
    status.mark_alive(service)
    def fail(*args):
        raise psycopg.OperationalError("SECRET_DOCUMENT_PASSWORD")
    monkeypatch.setattr(module, "run_once", fail)
    monkeypatch.setattr("sys.argv", ["worker", "--once"])
    monkeypatch.setenv("WORKER_DATABASE_URL", "private-dsn")
    if service == "agent":
        monkeypatch.setattr(module, "AgentSettings", lambda: None)
    with pytest.raises(SystemExit) as stopped:
        module.main()
    assert stopped.value.code == 1 and status.worker_status(service) == "unavailable"
    assert "SECRET" not in capsys.readouterr().out


def test_offline_calibration_matches_native_13_tool_contract():
    assert status.calibration_fingerprint("qwen2.5-7b-instruct", "http://127.0.0.1:1234/v1", 16384) == (
        "902a16950bcff470229bf14789b64134140dc47c22f8ce5ac14f6593579138d0")


@pytest.mark.parametrize("fault,component,expected", [
    ("none", "model", "ready"), ("context", "model", "uncalibrated"),
    ("fingerprint", "calibration", "uncalibrated"), ("temperature", "calibration", "uncalibrated"),
    ("reasoning", "calibration", "uncalibrated"), ("model_down", "model", "unavailable"),
    ("model_large", "model", "unavailable"), ("embedding", "embedding", "incompatible"),
    ("index_missing", "index", "missing"), ("index_empty", "index", "empty"),
    ("index_bad", "index", "incompatible"), ("index_down", "index", "unavailable"),
    ("worker", "agent_worker", "unavailable")])
def test_dependencies_are_independent_bounded_metadata_only(monkeypatch, fault, component, expected):
    settings = AgentSettings(_env_file=None)
    knowledge = KnowledgeSettings()
    if fault == "fingerprint":
        settings.prompt_fingerprint = "wrong"
    elif fault == "temperature":
        settings.temperature = 0.6
    elif fault == "reasoning":
        settings.reasoning_effort = "none"
    requests = []
    def handler(request):
        requests.append(request)
        assert request.method == "GET"
        if request.url.path == "/api/v0/models":
            assert request.headers["Authorization"] == "Bearer " + settings.api_key.get_secret_value()
            if fault == "model_down":
                raise httpx.ConnectError("SECRET_PROVIDER_BODY", request=request)
            payload = {"data": [{"id": settings.model, "state": "loaded",
                "loaded_context_length": 4096 if fault == "context" else settings.context_window}]}
            if fault == "model_large":
                payload["padding"] = "x" * 65536
        else:
            assert "authorization" not in request.headers
            if request.url.path == "/health":
                payload = {"ready": True, "model": "BAAI/bge-m3", "revision": knowledge.embedding_revision,
                    "dense_dimensions": 512 if fault == "embedding" else 1024, "sparse": True}
            else:
                assert request.url.path == "/collections/" + knowledge.qdrant_collection
                if fault in {"index_missing", "index_down"}:
                    return httpx.Response(404 if fault == "index_missing" else 503, stream=httpx.ByteStream(b'{}'))
                payload = {"result": {"points_count": 0 if fault == "index_empty" else 1,
                    "config": {"params": {"vectors": {"dense": {"size": 512 if fault == "index_bad" else 1024,
                        "distance": "Cosine"}}, "sparse_vectors": {"sparse": {}}}}}}
        return httpx.Response(200, stream=httpx.ByteStream(json.dumps(payload).encode()))
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    def factory(**kwargs):
        assert kwargs == {"timeout": 1.5, "trust_env": False, "follow_redirects": False}
        return client
    monkeypatch.setattr(status.httpx, "AsyncClient", factory)
    monkeypatch.setattr(status, "worker_status", lambda service: "unavailable" if fault == "worker" and service == "agent" else "ready")
    result = asyncio.run(status.dependency_status(settings, knowledge))
    assert result[component] == expected and len(requests) == 3
    assert "SECRET" not in json.dumps(result)
    if component in {"embedding", "index"}:
        assert result["model"] == result["calibration"] == result["agent_worker"] == "ready"
