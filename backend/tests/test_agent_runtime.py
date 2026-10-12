"""Focused graph, trace, tool and durable-worker integration checks."""

from contextlib import contextmanager
from hashlib import sha256
import json
import os
from time import monotonic
from types import SimpleNamespace
from uuid import uuid4

from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_openai import ChatOpenAI
from pydantic import SecretStr
import pytest
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from backend.agent_runtime import AgentTraceHandler, create_agent_graph, execute_run
from backend.agent_tools import AgentAbort, TOOL_NAMES, build_tools, encode, run_context
from backend.agent_config import AgentSettings


def test_documented_private_api_key_name_and_compatibility_alias(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-private-key")
    assert AgentSettings(_env_file=None).api_key.get_secret_value() == "test-private-key"
    assert "test-private-key" not in repr(AgentSettings(_env_file=None))
    monkeypatch.delenv("OPENAI_API_KEY")
    monkeypatch.setenv("AGENT_API_KEY", "compatible-test-key")
    assert AgentSettings(_env_file=None).api_key.get_secret_value() == "compatible-test-key"


def test_temperature_setting_preserves_default_and_rejects_invalid_values(monkeypatch):
    monkeypatch.delenv("AGENT_TEMPERATURE", raising=False)
    assert AgentSettings(_env_file=None).temperature == 0
    monkeypatch.setenv("AGENT_TEMPERATURE", "0.6")
    assert AgentSettings(_env_file=None).temperature == 0.6
    for invalid in ("-1", "2.1", "nan", "inf"):
        monkeypatch.setenv("AGENT_TEMPERATURE", invalid)
        with pytest.raises(ValueError):
            AgentSettings(_env_file=None)


def test_reasoning_setting_is_optional_and_accepts_only_verified_override(monkeypatch):
    monkeypatch.delenv("AGENT_REASONING_EFFORT", raising=False)
    assert AgentSettings(_env_file=None).reasoning_effort is None
    monkeypatch.setenv("AGENT_REASONING_EFFORT", "none")
    assert AgentSettings(_env_file=None).reasoning_effort == "none"
    monkeypatch.setenv("AGENT_REASONING_EFFORT", "unsupported")
    with pytest.raises(ValueError):
        AgentSettings(_env_file=None)


def test_actual_deepagent_executable_tool_allowlist():
    tools = build_tools(None, uuid4(), uuid4(), None, None)
    model = ChatOpenAI(model="qwen2.5-7b-instruct", api_key="local", base_url="http://127.0.0.1:1234/v1", use_responses_api=False)
    graph = create_agent_graph(model, tools)
    assert set(graph.get_graph().nodes["tools"].data.tools_by_name) == TOOL_NAMES
    with pytest.raises(AgentAbort):
        create_agent_graph(model, tools[:-1])


def test_new_special_tools_forward_exact_typed_commands_without_decision_tools():
    commands = []
    class DB:
        def execute(self, query, args=()):
            if "prepare_run_proposal" in query:
                commands.append(args[2].obj)
                return SimpleNamespace(fetchone=lambda: {"result": {"id": str(uuid4()), "status": "pending"}})
            return SimpleNamespace(fetchone=lambda: {"result": {"actor": {"role_code": "admin"}}})
    @contextmanager
    def connect(read_only=False):
        assert not read_only
        yield DB()
    tools = {t.name:t for t in build_tools(connect, uuid4(), uuid4(), lambda *args: None, lambda: None)}
    common = {"explanation": "Подготовить указанное пользователем действие", "reason": "Письменное основание пользователя"}
    inputs = [
        ("prepare_scholarship_assignment", {"student_id": 1, "scholarship_type_id": 1, "start_date": "2027-01-01", "end_date": "2027-06-30", "order_id": 1}),
        ("prepare_scholarship_termination", {"scholarship_id": 1, "end_date": "2026-10-11"}),
        ("prepare_scholarship_cancellation", {"scholarship_id": 1}),
        ("prepare_scheduled_order_cancellation", {"order_number": "P09-ORDER", "student_id": 1}),
        ("prepare_grade_correction", {"sheet_number": "P09-SHEET", "record_book": "P09-BOOK", "new_points": None, "new_is_absent": True}),
    ]
    for name, args in inputs:
        assert json.loads(tools[name].invoke({**common, **args}))["status"] == "pending"
    assert [command.get("name", command["kind"]) for command in commands] == [
        "scholarship_assign", "scholarship_terminate", "scholarship_cancel", "scheduled_order_cancel", "grade_correction"]
    assert all(command["fields"]["reason"] == common["reason"] for command in commands)
    assert commands[-1]["fields"]["new_points"] is None
    assert not any(any(word in name for word in ("decide", "approve", "submit", "assign_proposal")) for name in TOOL_NAMES)


def test_workflow_missing_requisites_are_actionable_without_preparing_or_inventing_fields():
    commands = []
    class DB:
        def execute(self, query, args=()):
            if "prepare_run_proposal" in query:
                commands.append(args[2].obj)
                return SimpleNamespace(fetchone=lambda: {"result": {"id": str(uuid4()), "status": "pending"}})
            return SimpleNamespace(fetchone=lambda: {"result": {"actor": {"role_code": "dean_staff"}}})
    @contextmanager
    def connect(read_only=False):
        yield DB()
    tool = next(t for t in build_tools(connect, uuid4(), uuid4(), lambda *args: None, lambda: None) if t.name == "prepare_workflow")
    common = {"name": "transfer_student", "explanation": "Заданный пользователем перевод", "reason": "Личное заявление"}
    for extras in ({}, {"order_number": None, "signed_by": " "}):
        result = json.loads(tool.invoke({**common, "fields": {"student_id": 1, "group_name": "G", **extras}}))
        assert result["error"] == "missing_required_fields" and result["fields"] == ["order_number", "signed_by"]
        assert not commands
    fields = {"student_id": 1, "group_name": "G", "order_number": "ORDER-1", "signed_by": 2}
    assert json.loads(tool.invoke({**common, "fields": fields}))["status"] == "pending"
    assert commands == [{"version": 1, "kind": "workflow", "name": "transfer_student", "fields": fields}]


@pytest.mark.parametrize("name,arguments", [
    ("prepare_record_change", {"resource": "document_request", "operation": "create", "key": {},
                               "fields": {"document_type_id": 1, "copies": 2, "purpose": "Указанная цель"}}),
    ("prepare_grade_correction", {"sheet_number": "S-1", "record_book": "B-1", "new_points": 70, "new_is_absent": False}),
])
def test_prepare_model_result_preserves_full_preview_and_submission_state(name, arguments):
    preview = {"before": {"points": 20}, "after": {"points": 70}, "note": "Полное предупреждение",
               "effects": [{"table": "grade", "changes": {"points": {"before": "20", "after": "70"}}}]}
    full = {"id": str(uuid4()), "kind": "grade_correction" if name == "prepare_grade_correction" else "record_change",
            "status": "pending", "submission_status": "draft" if name == "prepare_grade_correction" else None,
            "preview": preview, "routing": {"institute_id": 1}, "actions": {"submit": True}, "version": 1,
            "reason": "Причина пользователя", "context_files": [{"file_id": str(uuid4())}]}
    original = encode(full)
    events = []
    class DB:
        def execute(self, query, args=()):
            result = full if "prepare_run_proposal" in query else {"actor": {"role_code": "admin"}}
            return SimpleNamespace(fetchone=lambda: {"result": result})
    @contextmanager
    def connect(read_only=False):
        assert not read_only
        yield DB()
    tools = {item.name: item for item in build_tools(connect, uuid4(), uuid4(), lambda *args: events.append(args), lambda: None)}
    result = json.loads(tools[name].invoke({**arguments, "explanation": "Показать изменения", "reason": "Причина пользователя"}))
    assert set(result) == {"id", "kind", "status", "submission_status", "preview"}
    assert result["preview"] == preview and result["submission_status"] == full["submission_status"]
    assert result["id"] == full["id"] and result["status"] == "pending"
    assert encode(full) == original
    assert json.loads(events[-1][1]["output"]) == result


def test_model_steps_are_bounded_and_stop_errors_propagate():
    handler = AgentTraceHandler(lambda *args: None, lambda: None)
    for _ in range(8):
        handler.on_chat_model_start({}, [])
    with pytest.raises(AgentAbort):
        handler.on_chat_model_start({}, [])
    assert handler.raise_error


def test_sql_validation_error_is_safe_json_and_never_executes_model_sql():
    calls, events = [], []
    class DB:
        def execute(self, query, args=()):
            calls.append(query)
            assert "agent_run_read_context" in query
            return SimpleNamespace(fetchone=lambda: {"result": {"actor": {"role_code": "student"}}})
    @contextmanager
    def connect(read_only=False):
        assert read_only
        yield DB()
    tools = build_tools(connect, uuid4(), uuid4(), lambda *args: events.append(args), lambda: None)
    result = tools[0].invoke({"resource": "app_user"})
    assert '"error":"not_found"' in result
    assert [e[0] for e in events] == ["tool_call", "tool_result"]
    assert "app_user" not in encode(events)
    assert json.loads(result)["resources"] == json.loads(tools[0].invoke({}))["resources"]
    assert all("agent_run_read_context" in query for query in calls)


@pytest.mark.parametrize("name", ["", "practice_orders"])
def test_unknown_resource_metadata_guides_to_existing_resource_without_schema_access(name):
    class DB:
        def execute(self, query, args=()):
            assert "agent_run_read_context" in query
            return SimpleNamespace(fetchone=lambda: {"result": {"actor": {"role_code": "dean_staff"}}})
    @contextmanager
    def connect(read_only=False):
        assert read_only
        yield DB()
    tools = build_tools(connect, uuid4(), uuid4(), lambda *args: None, lambda: None)
    result = json.loads(tools[0].invoke({"resource": name}))
    assert result["error"] == "not_found" and "practice_placement" in result["resources"]
    assert "app_user" not in result["resources"] and "audit_log" not in result["resources"]
    assert "точное имя" in result["message"] and "fields" not in result


@pytest.mark.parametrize("role", ["student", "admin"])
def test_resource_metadata_explains_authenticated_student_defaults(monkeypatch, role):
    class DB:
        def execute(self, query, args=()):
            assert "agent_run_read_context" in query
            return SimpleNamespace(fetchone=lambda: {"result": {"actor": {"role_code": role}}})
    @contextmanager
    def connect(read_only=False):
        assert read_only
        yield DB()
    original = {"fields": {"student_id": {"nullable": False, "default": None}}, "write_fields": ["student_id"]}
    monkeypatch.setattr("backend.agent_tools.resources.spec", lambda *args, **kwargs:
                        SimpleNamespace(model_dump=lambda **kwargs: original.copy()))
    tool = build_tools(connect, uuid4(), uuid4(), lambda *args: None, lambda: None)[0]
    available = json.loads(tool.invoke({}))
    detail = json.loads(tool.invoke({"resource": "document_request"}))
    assert available["actor_role"] == detail["actor_role"] == role
    assert "document_request" in available["resources"] and "app_user" not in available["resources"]
    assert detail["fields"] == original["fields"] and detail["write_fields"] == original["write_fields"]
    if role == "student":
        assert detail["root_sql"]["insert"] == ["student_id", "document_type_id", "copies", "purpose"]
        policy = detail["record_change"]
        assert policy["server_assigned_on_create"] == ["student_id", "request_status_id"]
        assert policy["recommended_create_fields"] == ["document_type_id", "copies", "purpose"]
        assert policy["update_fields"] == ["copies", "purpose"] and "null" in policy["note"]
    else:
        assert "student_id" in detail["root_sql"]["insert"]
        assert "record_change" not in detail


@pytest.mark.parametrize("outcome,expected", [(AIMessage(content="Ответ из модели"), None), (AIMessage(content=""), "agent_protocol_error"), (RuntimeError("SECRET_KEY should never persist"), "agent_error")])
def test_runtime_persists_only_valid_answer_and_sanitized_error(monkeypatch, outcome, expected):
    statements, captured = [], {}
    context = {"actor": {"role_code": "student"}, "message": "Текущий вопрос", "history": [{"role": "user", "text": str(i)} for i in range(30)]}
    class DB:
        def execute(self, query, args=()):
            statements.append((query, args))
            return SimpleNamespace(fetchone=lambda: {"result": context if "context" in query else {"error_code": args[-1]}})
    @contextmanager
    def connect(read_only=False):
        yield DB()
    class Graph:
        def invoke(self, inputs, config):
            captured.update(inputs)
            if isinstance(outcome, Exception):
                raise outcome
            return {"messages": [outcome]}
    def model_graph(model, tools):
        captured["model_temperature"] = model.temperature
        captured["model_reasoning"] = model.reasoning_effort
        return Graph()
    monkeypatch.setattr("backend.agent_runtime.create_agent_graph", model_graph)
    settings = SimpleNamespace(connect=connect, run_timeout=300, provider_timeout=2, base_url="http://127.0.0.1:1234/v1", model="test", api_key=SecretStr("local"), max_tokens=128, temperature=0.6, reasoning_effort="none")
    result = execute_run(settings, uuid4(), uuid4())
    assert captured["model_temperature"] == 0.6
    assert captured["model_reasoning"] == "none"
    assert result["error_code"] == expected
    assert len(captured["messages"]) == 21
    assert captured["messages"][-1]["content"] == "Текущий вопрос"
    assert "SECRET_KEY" not in str(statements)
    assert statements[-1][1][-2] == ("Ответ из модели" if expected is None else "")


@pytest.mark.parametrize("code", ["P8007", "P8008", "42501"])
def test_tool_guard_abort_prevents_next_real_graph_model_step(monkeypatch, code):
    model_calls, guard_calls, saved = [], [], []
    class GuardError(psycopg.Error):
        sqlstate = code
    context = {"actor": {"role_code": "student"}, "message": "Проверка", "history": []}
    class DB:
        def execute(self, query, args=()):
            if "context" in query:
                guard_calls.append(query)
                if len(guard_calls) == 4:
                    raise GuardError("Run guard denied")
            if "finish_agent_run" in query:
                saved.append(args)
            return SimpleNamespace(fetchone=lambda: {"result": context})
    @contextmanager
    def connect(read_only=False):
        yield DB()
    def generate(self, messages, **kwargs):
        model_calls.append(messages)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[{"name": "describe_resources", "args": {}, "id": "test_call"}]))])
    monkeypatch.setattr(ChatOpenAI, "_generate", generate)
    settings = SimpleNamespace(connect=connect, run_timeout=300, provider_timeout=2, base_url="http://127.0.0.1:1234/v1", model="test", api_key=SecretStr("local"), max_tokens=128, temperature=0, reasoning_effort=None)
    execute_run(settings, uuid4(), uuid4())
    assert len(model_calls) == 1 and saved[0][-1] == "agent_error"


@pytest.fixture
def live_runs():
    """Committed synthetic auth/runs let tools prove fresh independent connections."""
    if not os.environ.get("TEST_DATABASE_DSN"):
        pytest.skip("TEST_DATABASE_DSN required for isolated agent integration")
    dsn = os.environ["TEST_DATABASE_DSN"]
    settings, runs = AgentSettings(), []
    def start(login="ivanov.ks", message="Синтетическая проверка агента", attachments=()):
        token, worker = str(uuid4()), uuid4()
        with psycopg.connect(dsn, row_factory=dict_row) as db:
            actor = db.execute("SELECT user_id FROM deanery.app_user WHERE login=%s", (login,)).fetchone()["user_id"]
            auth_session = db.execute("INSERT INTO agent_backend.auth_session(user_id,csrf_hash,expires_at) VALUES(%s,%s,now()+interval '1 hour') RETURNING id",
                                      (actor, sha256(b"synthetic-csrf").digest())).fetchone()["id"]
            db.execute("INSERT INTO agent_backend.auth_token(token_hash,session_id,kind,generation,expires_at) VALUES(%s,%s,'access',0,now()+interval '1 hour')",
                       (sha256(token.encode()).digest(), auth_session))
            db.execute("SET LOCAL ROLE backend_api")
            run = db.execute("SELECT backend_api.start_agent_run(NULL,%s,%s,%s,%s) AS run", (message, Jsonb(list(attachments)), uuid4(), token)).fetchone()["run"]
        with settings.connect() as db:
            assert db.execute("SELECT backend_api.claim_agent_run(%s) AS run", (worker,)).fetchone()["run"] == run
        run.update(worker=worker, token=token, auth_session=auth_session, settings=settings)
        runs.append(run)
        return run
    yield start
    for run in runs:
        with settings.connect() as db:
            db.execute("SELECT backend_api.finish_agent_run(%s,%s,'','agent_cancelled')", (run["run_id"],run["worker"]))
        with psycopg.connect(dsn) as db:
            # Use the ordinary deletion path, preserving proposals and audit as required.
            db.execute("SELECT backend_api.delete_chat(%s,%s)", (run["session_id"],run["token"]))
            db.execute("UPDATE agent_backend.auth_session SET revoked_at=now() WHERE id=%s", (run["auth_session"],))
            db.execute("UPDATE agent_backend.auth_token SET revoked_at=now() WHERE session_id=%s", (run["auth_session"],))


def bound_tools(run):
    events = []
    def check():
        with run["settings"].connect(read_only=True) as db:
            run_context(db, run["run_id"], run["worker"], True)
    def emit(event, data):
        events.append(event)
        with run["settings"].connect() as db:
            db.execute("SELECT backend_api.append_agent_event(%s,%s,%s,%s)", (run["run_id"], run["worker"], event, Jsonb(data)))
    return {t.name:t for t in build_tools(run["settings"].connect, run["run_id"], run["worker"], emit, check)}, events


def test_real_read_only_scope_before_join_and_aggregate(live_runs):
    run = live_runs()
    tools, _ = bound_tools(run)
    result = json.loads(tools["query_deanery"].invoke({"sql": "SELECT g.name, count(*) AS n FROM student s JOIN study_group g ON g.group_id=s.group_id GROUP BY g.name LIMIT 60"}))
    assert len(result["rows"]) == 1 and result["rows"][0]["n"] == 1
    with run["settings"].connect(read_only=True) as db:
        assert db.execute("SHOW transaction_read_only").fetchone()["transaction_read_only"] == "on"
        assert db.execute("SELECT backend_api.agent_run_read_context(%s,%s) AS context", (run["run_id"],run["worker"])).fetchone()["context"]
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with db.transaction():
                db.execute("SELECT student_id FROM deanery.student")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with db.transaction():
                db.execute("SELECT agent_backend.visible_rows_for_actor('student',1)")


def test_real_p09_root_sql_tool_returns_pending_and_new_scoped_fact_read(live_runs):
    run = live_runs()
    tools, _ = bound_tools(run)
    with psycopg.connect(os.environ["TEST_DATABASE_DSN"], row_factory=dict_row) as db:
        document = db.execute("SELECT document_type_id FROM deanery.document_type LIMIT 1").fetchone()["document_type_id"]
        before = db.execute("SELECT count(*) AS n FROM deanery.document_request").fetchone()["n"]
    read = json.loads(tools["query_deanery"].invoke({"sql": "SELECT count(*) AS n FROM grade LIMIT 1"}))
    assert read["rows"][0]["n"] >= 0
    proposal = json.loads(tools["propose_sql_change"].invoke({
        "sql": f"INSERT INTO document_request(document_type_id,copies,purpose) VALUES({document},1,'P09 runtime check')",
        "explanation": "Подготовить собственную новую заявку для адресной проверки",
        "reason": "Явное тестовое основание: проверить подготовку без исполнения"}))
    assert proposal["id"] and proposal["status"] == "pending"
    with psycopg.connect(os.environ["TEST_DATABASE_DSN"], row_factory=dict_row) as db:
        stored = db.execute("SELECT command FROM agent_backend.proposal WHERE id=%s", (proposal["id"],)).fetchone()["command"]
        assert stored["kind"] == "sql_change" and "sql" not in stored
        assert db.execute("SELECT count(*) AS n FROM deanery.document_request").fetchone()["n"] == before


def test_real_p09_correction_tool_returns_draft_without_source_submission(live_runs):
    run = live_runs("novikov")
    tools, _ = bound_tools(run)
    with psycopg.connect(os.environ["TEST_DATABASE_DSN"], row_factory=dict_row) as db:
        row = db.execute("SELECT gs.sheet_number,s.record_book_number,gr.points FROM deanery.grade gr JOIN deanery.grade_sheet gs USING(sheet_id) JOIN deanery.student s USING(student_id) JOIN deanery.employee e ON e.employee_id=gs.examiner_id JOIN deanery.app_user u ON u.person_id=e.person_id WHERE u.login='novikov' AND gs.status='closed' LIMIT 1").fetchone()
        before = db.execute("SELECT count(*) AS n FROM deanery.grade_correction").fetchone()["n"]
    proposal = json.loads(tools["prepare_grade_correction"].invoke({"sheet_number": row["sheet_number"], "record_book": row["record_book_number"],
        "new_points": 30 if row["points"] != 30 else 31, "new_is_absent": False,
        "explanation": "Подготовить черновик исправления закрытой оценки",
        "reason": "Явное тестовое основание: ошибка переноса результата"}))
    assert proposal["id"] and proposal["status"] == "pending"
    with psycopg.connect(os.environ["TEST_DATABASE_DSN"], row_factory=dict_row) as db:
        stored = db.execute("SELECT command,submission_status FROM agent_backend.proposal WHERE id=%s", (proposal["id"],)).fetchone()
        assert stored["command"]["kind"] == "grade_correction" and stored["submission_status"] == "draft"
        assert db.execute("SELECT count(*) AS n FROM deanery.grade_correction").fetchone()["n"] == before


def test_real_teacher_hidden_fields_and_shared_olap(live_runs):
    from backend import olap
    run = live_runs("novikov")
    tools, _ = bound_tools(run)
    result = json.loads(tools["query_deanery"].invoke({"sql": "SELECT funding_type_id FROM student LIMIT 1"}))
    assert result["error"] == "column_forbidden_or_ambiguous"
    actual = json.loads(tools["get_olap_report"].invoke({"mode": "rollup-group"}))
    with psycopg.connect(os.environ["TEST_DATABASE_DSN"], row_factory=dict_row) as db:
        db.execute("SET LOCAL ROLE backend_api")
        expected = olap.report(db, run["token"], "rollup-group", None, None, None, None)
    assert actual == json.loads(encode(expected))


@pytest.mark.parametrize("change,code", [("stop", "P8007"), ("scope", "P8008")])
def test_real_stop_and_scope_guard_prevent_new_tool(live_runs, change, code):
    run = live_runs()
    tools, events = bound_tools(run)
    with psycopg.connect(os.environ["TEST_DATABASE_DSN"]) as db:
        if change == "stop":
            db.execute("SELECT backend_api.cancel_agent_run(%s,%s)", (run["run_id"], run["token"]))
        else:
            db.execute("UPDATE agent_backend.agent_run SET scope_signature='expired-test-scope' WHERE id=%s", (run["run_id"],))
    with pytest.raises(psycopg.Error) as error:
        tools["query_deanery"].invoke({"sql": "SELECT count(*) AS n FROM student LIMIT 1"})
    assert error.value.sqlstate == code and events == []


@pytest.mark.skipif(os.environ.get("TEST_AGENT_LIVE_MODEL") != "1", reason="Explicit local provider smoke only")
def test_real_local_qwen_scoped_read_and_prepare(live_runs):
    read = live_runs(message="Выполни query_deanery с SQL SELECT count(*) AS total FROM student LIMIT 1. Сообщи число доступных студентов по результату. Это только чтение.")
    started = monotonic()
    result = execute_run(read["settings"], read["run_id"], read["worker"])
    assert "query_deanery" in result["tools_used"] and result["proposals"] == []
    assert "1" in result["answer"]
    print(f"Local Qwen scoped SELECT completed in {monotonic()-started:.1f}s")
    with psycopg.connect(os.environ["TEST_DATABASE_DSN"], row_factory=dict_row) as db:
        document_type = db.execute("SELECT document_type_id FROM deanery.document_type ORDER BY document_type_id LIMIT 1").fetchone()["document_type_id"]
        before = db.execute("SELECT count(*) AS n FROM deanery.document_request").fetchone()["n"]
    prepare = live_runs(message=f"Я явно прошу подготовить предложение на создание document_request. Используй prepare_record_change: resource=document_request, operation=create, key={{}}, fields={{document_type_id:{document_type},copies:1,purpose:'Для синтетической проверки'}}. Причина: проверка согласованного процесса выдачи справки. student_id не указывай: сервер определяет меня из учётной записи. Объяснение: новая заявка на одну справку. Не выполняй и не подтверждай изменение.")
    started = monotonic()
    result = execute_run(prepare["settings"], prepare["run_id"], prepare["worker"])
    assert "prepare_record_change" in result["tools_used"] and len(result["proposals"]) == 1
    with psycopg.connect(os.environ["TEST_DATABASE_DSN"], row_factory=dict_row) as db:
        assert db.execute("SELECT count(*) AS n FROM deanery.document_request").fetchone()["n"] == before
        proposal = db.execute("SELECT status FROM agent_backend.proposal WHERE run_id=%s", (prepare["run_id"],)).fetchone()
        assert proposal["status"] == "pending"
    print(f"Local Qwen proposal preparation completed in {monotonic()-started:.1f}s without a domain mutation")


@pytest.mark.skipif(os.environ.get("TEST_AGENT_LIVE_MODEL") != "1", reason="Explicit local attachment model smoke only")
def test_real_local_qwen_file_citation_and_private_download(live_runs, monkeypatch):
    from pathlib import Path
    import httpx
    from fastapi.testclient import TestClient
    from backend.app import app, db_connection
    from backend.files import read_chunks
    fixture = json.loads(Path(".local/p10-real-file-fixture.json").read_text(encoding="utf-8"))
    monkeypatch.setenv("FILES_STORAGE_ROOT", fixture["storage_root"])
    refs = [{key: fixture[key] for key in ("file_id", "version_id")}]
    run = live_runs("vasilyeva", "Только прочитай приложенный документ. Назови контрольный код и процитируй источник точным токеном [[attachment:chunk_id]] из переданного фрагмента. Никакие изменения или предложения не готовь.", refs)
    with run["settings"].connect(read_only=True) as db:
        descriptor = db.execute("SELECT backend_api.run_attachment_descriptor(%s,%s,%s) AS result", (run["run_id"], run["worker"], fixture["version_id"])).fetchone()["result"]
    chunks = [{**c, **refs[0], "citation": "[[attachment:" + c["chunk_id"] + "]]"} for c in read_chunks(descriptor)["chunks"]]
    frames = []
    original = httpx.HTTPTransport.handle_request
    def capture(transport, request):
        if request.method == "POST" and request.url.path.endswith("/chat/completions"):
            frames.append(json.loads(request.content))
        return original(transport, request)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", capture)
    started = monotonic()
    result = execute_run(run["settings"], run["run_id"], run["worker"])
    file = result["attachment_context"]["files"][0]
    observed = sorted({c["chunk_id"] for c in chunks for frame in frames for message in frame["messages"]
                       if message["role"] in {"user", "tool"} and encode(c) in message.get("content", "")})
    evidence = {"model": run["settings"].model, "run_id": run["run_id"], "version_id": fixture["version_id"],
                "elapsed_seconds": round(monotonic()-started, 2), "provider_requests": len(frames),
                "exact_wire_chunk_ids": observed, "manifest": result["attachment_context"],
                "answer_contains_fixture_code": "SAPPHIRE-742" in result["answer"] or "САПФИР-742" in result["answer"],
                "canonical_download_hash_matches": False, "proposal_count": len(result["proposals"])}
    evidence_path = Path(".local/p10-real-agent-evidence.json")
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    assert observed and sorted(file["provided_chunk_ids"]) == observed
    assert "image_url" not in encode(frames)
    assert file["delivery_state"] == "acknowledged" and file["context_state"] == "used"
    assert file["cited_chunk_ids"] and set(file["cited_chunk_ids"]) <= set(observed)
    assert result["proposals"] == [] and ("SAPPHIRE-742" in result["answer"] or "САПФИР-742" in result["answer"])
    expected_path = f"/api/v1/files/{fixture['file_id']}/versions/{fixture['version_id']}/download"
    assert expected_path in result["answer"]
    def api_db():
        with psycopg.connect(os.environ["TEST_DATABASE_DSN"], row_factory=dict_row) as db:
            db.execute("SET LOCAL ROLE backend_api")
            yield db
    app.dependency_overrides[db_connection] = api_db
    try:
        with TestClient(app) as client:
            response = client.get(expected_path, headers={"Authorization": "Bearer " + run["token"]})
        assert response.status_code == 200 and sha256(response.content).hexdigest() == descriptor["content_hash"]
    finally:
        app.dependency_overrides.pop(db_connection, None)
    evidence.update(elapsed_seconds=round(monotonic()-started, 2), canonical_download_hash_matches=True)
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Actual Qwen attachment citation and authenticated original download verified in {evidence['elapsed_seconds']}s")
