"""Bounded real-Qwen/form parity on the explicitly isolated P12 backend database."""

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
from time import monotonic, sleep
import traceback
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
import psycopg
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from backend.agent_config import AgentSettings
from backend.agent_runtime import execute_run
from backend.auth import hasher


ROOT = Path(__file__).resolve().parents[3]
LOCAL = ROOT / ".local"
DATABASE = "deanery_p12_backend_92004917"
ORIGIN = "http://127.0.0.1:8882"


def save(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, default=str)


class Runtime:
    def __init__(self, settings=None):
        self.prefix = LOCAL / ("p12-parity-" + secrets.token_hex(4))
        self.info = [json.loads((LOCAL / f"p12-backend-{kind}.json").read_text(encoding="utf-8"))
                     for kind in ("connection", "api", "agent")]
        assert all(info["dbname"] == DATABASE for info in self.info)
        self.clients, self.chats, self.runs = {}, [], []
        self.originals, self.process, self.log, self.environment = [], None, None, None
        self.settings = settings or AgentSettings(_env_file=None, database_file=LOCAL / "p12-backend-agent.json",
                                      base_url="http://127.0.0.1:1234/v1", model="qwen2.5-7b-instruct",
                                      OPENAI_API_KEY="local", prompt_tokens=4261, context_window=16384, max_tokens=1536, temperature=0, reasoning_effort=None,
                                      prompt_fingerprint="902a16950bcff470229bf14789b64134140dc47c22f8ce5ac14f6593579138d0")

    @contextmanager
    def admin(self):
        with psycopg.connect(**self.info[0], row_factory=dict_row) as db:
            db.execute("SET LOCAL TIME ZONE 'Europe/Moscow'")
            yield db

    def start(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 8882))
        with self.admin() as db:
            assert db.execute("SELECT version_num FROM public.alembic_version").fetchone()["version_num"] == "0039_scope_check_latency"
            assert db.execute("SELECT count(*) AS n FROM agent_backend.agent_run WHERE status IN ('queued','running')").fetchone()["n"] == 0
            self.originals = db.execute("SELECT user_id,login,password_hash,last_login_at FROM deanery.app_user "
                                        "WHERE login IN ('ivanov.ks','novikov','kuznetsova','vasilyeva','smirnov') ORDER BY user_id").fetchall()
            assert len(self.originals) == 5
            save(self.prefix.with_name(self.prefix.name + "-account-restore.json"), self.originals)
            password = secrets.token_urlsafe(32)
            db.execute("UPDATE deanery.app_user SET password_hash=%s WHERE user_id=ANY(%s)",
                       (hasher.hash(password), [row["user_id"] for row in self.originals]))
        storage = self.prefix.with_name(self.prefix.name + "-storage")
        storage.mkdir()
        env = os.environ.copy()
        env.update(TEST_DATABASE_DSN=make_conninfo(**self.info[0]), DATABASE_URL=make_conninfo(**self.info[1]),
                   WORKER_DATABASE_URL=make_conninfo(**self.info[2]), AGENT_DATABASE_FILE=str(self.settings.database_file),
                   FILES_DATABASE_FILE=str(LOCAL / "p12-backend-api.json"), FILES_STORAGE_ROOT=str(storage),
                   KNOWLEDGE_DATABASE_FILE=str(LOCAL / "p12-backend-api.json"), KNOWLEDGE_STORAGE_ROOT=str(storage),
                   KNOWLEDGE_TOKEN_FILE=str(self.prefix.with_name(self.prefix.name + "-unprovisioned-token.txt")),
                   AGENT_BASE_URL=self.settings.base_url, AGENT_MODEL=self.settings.model,
                   AGENT_CONTEXT_WINDOW=str(self.settings.context_window), AGENT_PROMPT_TOKENS=str(self.settings.prompt_tokens),
                   AGENT_MAX_TOKENS=str(self.settings.max_tokens),
                   AGENT_TEMPERATURE=str(self.settings.temperature),
                   AGENT_PROMPT_FINGERPRINT=self.settings.prompt_fingerprint, OPENAI_API_KEY="local",
                   DEANERY_ORIGIN=ORIGIN, DEANERY_DEV_INSECURE_COOKIE="1", PYTHONDONTWRITEBYTECODE="1",
                   PYTHONIOENCODING="utf-8")
        if self.settings.reasoning_effort is None:
            env.pop("AGENT_REASONING_EFFORT", None)
        else:
            env["AGENT_REASONING_EFFORT"] = self.settings.reasoning_effort
        self.environment = patch.dict(os.environ, env)
        self.environment.start()
        self.log = self.prefix.with_name(self.prefix.name + "-api.log").open("x", encoding="utf-8")
        self.process = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1",
                                         "--port", "8882", "--no-access-log"], cwd=ROOT, env=env,
                                        stdout=self.log, stderr=subprocess.STDOUT,
                                        creationflags=subprocess.CREATE_NO_WINDOW)
        deadline = monotonic() + 15
        with httpx.Client(base_url=ORIGIN, timeout=2, trust_env=False) as probe:
            while True:
                assert self.process.poll() is None, "Owned API failed to start; inspect private log"
                try:
                    if probe.get("/openapi.json").status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                assert monotonic() < deadline, "Owned API startup deadline"
                sleep(0.2)
        for row in self.originals:
            client = httpx.Client(base_url=ORIGIN, headers={"Origin": ORIGIN}, timeout=360, trust_env=False)
            self.clients[row["login"]] = client
            response = client.post("/api/v1/auth/login", json={"login": row["login"], "password": password})
            assert response.status_code == 200, "Password-verified ordinary login failed"
            client.headers["Authorization"] = "Bearer " + response.json()["access_token"]
        return self

    def call(self, login, method, path, body=None, status=200, key=None):
        headers = {"Idempotency-Key": str(key or uuid4())} if method in ("POST", "PATCH", "DELETE") else {}
        response = self.clients[login].request(method, "/api/v1/" + path, json=body, headers=headers)
        assert response.status_code == status, f"{method} {path}: {response.status_code}: {response.text}"
        return response.json() if response.content else None

    def row(self, table, key, value):
        assert (table, key) in {("academic_work", "work_id"), ("document_request", "request_id")}
        with self.admin() as db:
            return db.execute(f"SELECT * FROM deanery.{table} WHERE {key}=%s", (value,)).fetchone()

    def audit(self, table, key, value):
        with self.admin() as db:
            return db.execute("SELECT audit_id,app_user_id,agent_request_id,operation FROM deanery.audit_log "
                              "WHERE table_name=%s AND record_key=%s ORDER BY audit_id DESC LIMIT 1",
                              (table, f"{key}={value}")).fetchone()

    def model(self, case, login, message):
        chat = self.call(login, "POST", "agent/sessions", {"title": "P12 " + case}, status=201)
        self.chats.append((login, chat["id"]))
        frames = self.prefix.with_name(self.prefix.name + "-" + case + "-provider.jsonl")
        original = httpx.HTTPTransport.handle_request
        calls, result, run_id = 0, None, None
        wire = []
        with frames.open("x", encoding="utf-8") as stream:
            def record(transport, request):
                nonlocal calls
                capture = request.method == "POST" and request.url.path.endswith("/chat/completions")
                if capture:
                    calls += 1
                    stream.write(json.dumps({"call": calls, "request": json.loads(request.content)}, ensure_ascii=False) + "\n")
                    stream.flush()
                try:
                    response = original(transport, request)
                    if capture:
                        response.read()
                        stream.write(json.dumps({"call": calls, "status": response.status_code,
                                                 "response": response.json()}, ensure_ascii=False) + "\n")
                        stream.flush()
                    return response
                except BaseException as exc:
                    if capture:
                        stream.write(json.dumps({"call": calls, "transport_error": type(exc).__name__}) + "\n")
                        stream.flush()
                    raise
            body = {"session_id": chat["id"], "message": message, "attachments": []}
            try:
                with self.clients[login].stream("POST", "/api/v1/agent/chat/stream", json=body,
                                              headers={"Idempotency-Key": str(uuid4())}) as response:
                    assert response.status_code == 200
                    iterator = response.iter_lines()
                    for line in iterator:
                        wire.append(line)
                        if line.startswith("data:"):
                            session_event = json.loads(line[5:])
                            break
                    run_id = UUID(session_event["run_id"])
                    worker = uuid4()
                    self.runs.append((login, run_id, worker))
                    with self.settings.connect() as db:
                        claimed = db.execute("SELECT backend_api.claim_agent_run(%s) AS result", (worker,)).fetchone()["result"]
                    assert UUID(claimed["run_id"]) == run_id
                    with patch.object(httpx.HTTPTransport, "handle_request", record):
                        result = execute_run(self.settings, run_id, worker)
                    wire.extend(iterator)
            finally:
                with self.admin() as db:
                    persisted = db.execute("SELECT * FROM agent_backend.agent_run WHERE id=%s", (run_id,)).fetchone() if run_id else None
                    proposals = db.execute("SELECT id,command,agent_request_id,initiator_user_id,status FROM agent_backend.proposal WHERE run_id=%s", (run_id,)).fetchall() if run_id else []
                evidence = {"result": result, "run": persisted, "events": persisted["events"] if persisted else [],
                            "proposals": proposals, "sse": wire, "provider_calls": calls, "provider_frames": frames.name}
                save(self.prefix.with_name(self.prefix.name + "-" + case + "-run.json"), evidence)
        assert 0 < calls <= 8 and persisted["status"] == "succeeded", "Actual run failed; private evidence retained"
        assert len(proposals) == 1 and proposals[0]["status"] == "pending"
        return evidence

    def confirm(self, proposal):
        p = self.call("kuznetsova", "GET", "agent/proposals/" + str(proposal["id"]))
        assert p["routing"]["assignee_user_id"] is None
        p = self.call("kuznetsova", "POST", "agent/proposals/" + p["id"] + "/assignment",
                      {"assignee_user_id": self.me("kuznetsova")["user_id"], "reason": "Синтетическая проверка P12",
                       "expected_version": p["version"]})
        return self.call("kuznetsova", "POST", "agent/proposals/" + p["id"] + "/decision",
                         {"approve": True, "reason": "Проверено отдельно сотрудником для синтетической проверки P12",
                          "expected_version": p["version"]})

    def me(self, login):
        return self.call(login, "GET", "auth/me")

    def close(self):
        errors = []
        for login, run, worker in self.runs:
            try:
                self.call(login, "POST", f"agent/runs/{run}/cancel", {})
                with self.admin() as db:
                    state = db.execute("SELECT finished_at,lease_owner FROM agent_backend.agent_run WHERE id=%s", (run,)).fetchone()
                if state["finished_at"] is None and state["lease_owner"] == worker:
                    with self.settings.connect() as db:
                        db.execute("SELECT backend_api.finish_agent_run(%s,%s,'','agent_cancelled')", (run, worker))
            except Exception as exc:
                errors.append({"phase": "run_cleanup", "type": type(exc).__name__})
        for login, chat in self.chats:
            try:
                self.call(login, "DELETE", "agent/sessions/" + chat, status=204)
            except Exception as exc:
                errors.append({"phase": "chat_cleanup", "type": type(exc).__name__})
        for client in self.clients.values():
            try:
                response = client.post("/api/v1/auth/logout")
                assert response.status_code == 204
            except Exception as exc:
                errors.append({"phase": "logout", "type": type(exc).__name__})
            client.close()
        active = tokens = queued = None
        restored = False
        try:
            if self.originals:
                with self.admin() as db:
                    for row in self.originals:
                        db.execute("UPDATE deanery.app_user SET password_hash=%s,last_login_at=%s WHERE user_id=%s",
                                   (row["password_hash"], row["last_login_at"], row["user_id"]))
                    assert db.execute("SELECT user_id,login,password_hash,last_login_at FROM deanery.app_user "
                                      "WHERE user_id=ANY(%s) ORDER BY user_id", ([r["user_id"] for r in self.originals],)).fetchall() == self.originals
                    restored = True
                    active = db.execute("SELECT count(*) AS n FROM agent_backend.auth_session WHERE revoked_at IS NULL AND expires_at>now()").fetchone()["n"]
                    tokens = db.execute("SELECT count(*) AS n FROM agent_backend.auth_token WHERE revoked_at IS NULL AND expires_at>now()").fetchone()["n"]
                    queued = db.execute("SELECT count(*) AS n FROM agent_backend.agent_run WHERE status IN ('queued','running')").fetchone()["n"]
        except Exception as exc:
            errors.append({"phase": "restore_and_verify", "type": type(exc).__name__})
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.log:
            self.log.close()
        if self.environment:
            self.environment.stop()
        cleanup = {"errors": errors, "active_auth_sessions": active, "active_auth_tokens": tokens, "queued_or_running_runs": queued,
                   "owned_api_stopped": self.process is None or self.process.poll() is not None,
                   "passwords_restored": restored}
        save(self.prefix.with_name(self.prefix.name + "-cleanup.json"), cleanup)
        return cleanup


def document_request(runtime):
    with runtime.admin() as db:
        document_type = db.execute("SELECT document_type_id FROM deanery.document_type ORDER BY document_type_id LIMIT 1").fetchone()["document_type_id"]
    fields = {"document_type_id": document_type, "copies": 2, "purpose": "Синтетическая проверка P12: справка для учебного сценария"}
    form = runtime.call("ivanov.ks", "POST", "resources/document_request", fields)
    ids = [form["request_id"]]
    try:
        form_row = runtime.row("document_request", "request_id", ids[0])
        form_audit = runtime.audit("document_request", "request_id", ids[0])
        runtime.call("ivanov.ks", "POST", "resources/document_request", {**fields, "copies": 0}, status=422)
        with runtime.admin() as db:
            before = db.execute("SELECT count(*) AS n FROM deanery.document_request").fetchone()["n"]
        trace = runtime.model("document_request", "ivanov.ks",
            "Я явно прошу подготовить мою новую заявку document_request. Сначала опиши ресурс. Затем вызови "
            "prepare_record_change: resource=document_request, operation=create, key={}, fields=" + json.dumps(fields, ensure_ascii=False) +
            ". student_id не указывай: сервер определит меня. Объяснение: заявка на две справки. "
            "Причина: синтетическая проверка согласованного процесса выдачи справки P12. Подготовь только одно предложение; не подтверждай.")
        with runtime.admin() as db:
            assert db.execute("SELECT count(*) AS n FROM deanery.document_request").fetchone()["n"] == before
        proposal = trace["proposals"][0]
        command = proposal["command"]
        assert command["resource"] == "document_request" and command["operation"] == "create"
        assert command["fields"] == {**fields, "student_id": runtime.me("ivanov.ks")["student_id"]}
        runtime.call("ivanov.ks", "POST", "agent/proposals/" + str(proposal["id"]) + "/decision",
                     {"approve": True, "reason": "Студент не подтверждает предложение сотрудника", "expected_version": 1}, status=403)
        approved = runtime.confirm(proposal)
        assert (approved["status"], approved["execution"]["status"]) == ("approved", "succeeded")
        applied = approved["execution"]["applied"]
        ids.append(applied["request_id"])
        agent_row = runtime.row("document_request", "request_id", ids[1])
        assert {k: v for k, v in form_row.items() if k not in ("request_id", "created_at")} == {
            k: v for k, v in agent_row.items() if k not in ("request_id", "created_at")}
        agent_audit = runtime.audit("document_request", "request_id", ids[1])
        assert form_audit["app_user_id"] == runtime.me("ivanov.ks")["user_id"] and form_audit["agent_request_id"] is None
        assert agent_audit["app_user_id"] == runtime.me("kuznetsova")["user_id"] and agent_audit["agent_request_id"] == proposal["agent_request_id"]
        return {"case": "document_request", "provider_calls": trace["provider_calls"], "proposal_id": str(proposal["id"]),
                "domain_parity": True, "prepare_no_effect": True, "form_audit": form_audit, "agent_audit": agent_audit,
                "constraints": {"copies_zero": 422, "student_decision": 403}}
    finally:
        for request_id in ids:
            runtime.call("ivanov.ks", "DELETE", f"resources/document_request?request_id={request_id}")


def academic_work(runtime):
    with runtime.admin() as db:
        baseline = db.execute("SELECT w.* FROM deanery.academic_work w JOIN deanery.employee e ON e.employee_id=w.supervisor_id "
                              "JOIN deanery.app_user u ON u.person_id=e.person_id WHERE u.login='novikov' ORDER BY w.work_id LIMIT 1").fetchone()
    assert baseline is not None
    path = f"resources/academic_work?work_id={baseline['work_id']}"
    fields = {"topic": "Синтетическая тема P12: сопоставление формы и агентного предложения"}
    try:
        runtime.call("novikov", "PATCH", path, fields, status=403)
        runtime.call("kuznetsova", "PATCH", path, {"student_id": baseline["student_id"]}, status=422)
        runtime.call("kuznetsova", "PATCH", path, fields)
        form_row = runtime.row("academic_work", "work_id", baseline["work_id"])
        form_audit = runtime.audit("academic_work", "work_id", baseline["work_id"])
        runtime.call("kuznetsova", "PATCH", path, {"topic": baseline["topic"]})
        trace = runtime.model("academic_work", "novikov",
            "Я явно прошу подготовить изменение темы моей руководимой academic_work с work_id=" + str(baseline["work_id"]) +
            ". Сначала опиши ресурс. Вызови prepare_record_change: resource=academic_work, operation=update, key=" +
            json.dumps({"work_id": baseline["work_id"]}) + ", fields=" + json.dumps(fields, ensure_ascii=False) +
            ". Объяснение: уточнить тему руководимой работы. Причина: синтетическая проверка точного соответствия формы и предложения P12. "
            "Другие поля не меняй. Подготовь только одно предложение; не подтверждай.")
        assert runtime.row("academic_work", "work_id", baseline["work_id"]) == baseline
        proposal = trace["proposals"][0]
        assert proposal["command"] == {"version": 1, "kind": "record_change", "resource": "academic_work", "operation": "update",
                                       "key": {"work_id": baseline["work_id"]}, "fields": fields}
        approved = runtime.confirm(proposal)
        assert (approved["status"], approved["execution"]["status"]) == ("approved", "succeeded")
        assert runtime.row("academic_work", "work_id", baseline["work_id"]) == form_row
        agent_audit = runtime.audit("academic_work", "work_id", baseline["work_id"])
        assert form_audit["app_user_id"] == agent_audit["app_user_id"] == runtime.me("kuznetsova")["user_id"]
        assert form_audit["agent_request_id"] is None and agent_audit["agent_request_id"] == proposal["agent_request_id"]
        assert proposal["initiator_user_id"] == runtime.me("novikov")["user_id"] != agent_audit["app_user_id"]
        return {"case": "academic_work", "provider_calls": trace["provider_calls"], "proposal_id": str(proposal["id"]),
                "domain_parity": True, "prepare_no_effect": True, "form_audit": form_audit, "agent_audit": agent_audit,
                "constraints": {"teacher_form_write": 403, "locked_student_id": 422}}
    finally:
        runtime.call("kuznetsova", "PATCH", path, {"topic": baseline["topic"]})
        assert runtime.row("academic_work", "work_id", baseline["work_id"]) == baseline


def first_two(phase="first_two"):
    runtime = Runtime()
    cases, error = [], None
    selected = (document_request, academic_work) if phase == "first_two" else (academic_work,)
    try:
        runtime.start()
        for case in selected:
            cases.append(case(runtime))
            save(runtime.prefix.with_name(runtime.prefix.name + "-" + case.__name__ + "-parity.json"), cases[-1])
            print(json.dumps({"case": case.__name__, "passed": True, "provider_calls": cases[-1]["provider_calls"]}), flush=True)
    except BaseException as exc:
        error = type(exc).__name__
        runtime.prefix.with_name(runtime.prefix.name + "-error.log").write_text(traceback.format_exc(), encoding="utf-8")
    finally:
        cleanup = runtime.close()
    summary = {"time": datetime.now(timezone.utc).isoformat(), "database": DATABASE, "phase": phase, "cases": cases,
               "error_type": error, "cleanup": cleanup, "evidence_prefix": runtime.prefix.name}
    save(runtime.prefix.with_name(runtime.prefix.name + "-summary.json"), summary)
    print(json.dumps({"phase": phase, "passed_cases": len(cases), "error_type": error,
                      "cleanup": cleanup, "evidence_prefix": runtime.prefix.name}), flush=True)
    return 0 if error is None and len(cases) == len(selected) and not cleanup["errors"] and cleanup["active_auth_sessions"] == cleanup["active_auth_tokens"] == cleanup["queued_or_running_runs"] == 0 else 1


if __name__ == "__main__":
    assert Path.cwd().resolve() == ROOT
    assert len(sys.argv) == 2 and sys.argv[1] in ("first_two", "academic_work"), "Only root-approved first-batch model cases may run"
    sys.exit(first_two(sys.argv[1]))
