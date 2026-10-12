"""Normative wire proof and current PostgreSQL access, using only synthetic sources."""

from hashlib import sha256
import json
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import psycopg
from psycopg.types.json import Jsonb
import pytest

from backend import chats
from backend.agent_attachments import AttachmentContext, AttachmentTransport, static_fingerprint
from backend.agent_tools import encode
from backend.tests.test_auth import DatabaseHttpCase
from backend.tests import test_chats
from backend.tests import test_attachments


@pytest.mark.parametrize("mode", ["insert", "missing", "guessed", "changed", "tool", "step_limit", "cancel", "already_cited", "unacknowledged"])
def test_bounded_runtime_citation_repair_preserves_facts_and_blocks_tools(monkeypatch, mode):
    from contextlib import contextmanager
    from langchain_core.messages import AIMessage
    from pydantic import SecretStr
    from backend.agent_runtime import execute_run
    from backend.agent_tools import AgentAbort

    chunk_id = str(uuid4())
    token = "[[regulation:" + chunk_id + "]]"
    draft = "Срок — семь дней. Студентов: 1. Дата подачи неизвестна."
    context = {"actor": {"role_code": "student"}, "message": "Исходный вопрос", "history": []}
    statements, calls, contexts = [], [], []
    cancelled = False

    class DB:
        def execute(self, query, args=()):
            statements.append((query, args))
            if "context" in query and cancelled:
                raise AgentAbort("agent_cancelled")
            return SimpleNamespace(fetchone=lambda: {"result": context if "context" in query else {"answer": args[-2], "error_code": args[-1]}})

    @contextmanager
    def connect(read_only=False):
        yield DB()

    def attachments(*args):
        value = AttachmentContext(*args)
        contexts.append(value)
        return value

    class Graph:
        def __init__(self, tools):
            self.tools = tools

        def invoke(self, inputs, config):
            nonlocal cancelled
            calls.append(inputs)
            for _ in range(8 if mode == "step_limit" and len(calls) == 1 else 1):
                config["callbacks"][0].on_chat_model_start({}, [])
            if len(calls) == 1:
                contexts[0].regulations[chunk_id] = {"chunk_id": chunk_id}
                if mode != "unacknowledged":
                    contexts[0].acknowledged_regulations.add(chunk_id)
                cancelled = mode == "cancel"
                text = draft + (" " + token if mode == "already_cited" else "")
            else:
                assert len(calls) == 2 and inputs["messages"][0]["content"] == "Исходный вопрос"
                assert inputs["messages"][-1]["role"] == "user"
                if mode == "tool":
                    self.tools[0].invoke({})
                    raise AssertionError("Repair tools must never execute")
                quote = draft.replace("семь", "сто") if mode == "changed" else draft
                text = encode({"citations": [] if mode == "missing" else [{"quote": quote, "chunk_id": "guessed" if mode == "guessed" else chunk_id}]})
            return {"messages": [*inputs["messages"], AIMessage(content=text)]}

    monkeypatch.setattr("backend.agent_runtime.AttachmentContext", attachments)
    monkeypatch.setattr("backend.agent_runtime.create_agent_graph", lambda model, tools: Graph(tools))
    settings = SimpleNamespace(connect=connect, run_timeout=300, provider_timeout=2, base_url="http://127.0.0.1:1234/v1",
                               model="test", api_key=SecretStr("local"), max_tokens=128,
                               temperature=0, reasoning_effort=None)
    result = execute_run(settings, uuid4(), uuid4())
    expected = None if mode in {"insert", "already_cited", "unacknowledged"} else "agent_cancelled" if mode == "cancel" else "agent_protocol_error"
    assert result["error_code"] == expected
    assert result["answer"] == (draft + (" " + token if mode != "unacknowledged" else "") if expected is None else "")
    assert len(calls) == (1 if mode in {"already_cited", "unacknowledged"} else 2)
    assert context["message"] == "Исходный вопрос"
    assert len([s for s in statements if "finish_agent_run" in s[0]]) == 1
    assert not any("append_agent_event" in q and args[2] in {"tool_call", "tool_result", "done"} for q, args in statements)


def test_citation_repair_inserts_only_selected_nonoverlapping_sources_without_rewriting():
    from backend.agent_runtime import apply_citation_repair
    draft = "Срок семь дней. Код ЯНТАРЬ. Студентов: 1."
    annotations = {"citations": [{"quote": "Код ЯНТАРЬ.", "chunk_id": "two"}, {"quote": "Срок семь дней.", "chunk_id": "one"}]}
    assert apply_citation_repair(draft, encode(annotations), {"one", "two", "unused"}) == (
        "Срок семь дней. [[regulation:one]] Код ЯНТАРЬ. [[regulation:two]] Студентов: 1.")


@pytest.mark.parametrize("data", [
    None, [], {}, {"citations": []}, {"citations": "one"}, {"citations": [], "answer": "Новое утверждение"},
    {"citations": [{"quote": "Срок восемь дней.", "chunk_id": "one"}]},
    {"citations": [{"quote": "Срок семь дней.", "chunk_id": "other"}]},
    {"citations": [{"quote": "Срок семь дней.", "chunk_id": "one", "text": "Новое утверждение"}]},
    {"citations": [{"quote": None, "chunk_id": "one"}]},
    {"citations": [{"quote": "Срок семь дней.", "chunk_id": ["one"]}]},
    {"citations": [{"quote": " ", "chunk_id": "one"}]},
    {"citations": [{"quote": "Срок семь дней.", "chunk_id": "one"}, {"quote": "семь дней", "chunk_id": "one"}]},
    {"citations": [{"quote": "Срок семь дней.", "chunk_id": "one"}] * 21},
])
def test_citation_repair_rejects_invalid_annotations(data):
    from backend.agent_runtime import apply_citation_repair
    from backend.agent_tools import AgentAbort
    with pytest.raises(AgentAbort, match="agent_protocol_error"):
        apply_citation_repair("Срок семь дней.", encode(data), {"one"})


@pytest.mark.parametrize("draft,quote", [("Код. Код.", "Код."), ("aaaa", "aaa")])
def test_citation_repair_requires_unique_quote_including_overlapping_occurrences(draft, quote):
    from backend.agent_runtime import apply_citation_repair
    from backend.agent_tools import AgentAbort
    with pytest.raises(AgentAbort, match="agent_protocol_error"):
        apply_citation_repair(draft, encode({"citations": [{"quote": quote, "chunk_id": "one"}]}), {"one"})


def test_citation_repair_rejects_non_json_and_markdown_wrapping():
    from backend.agent_runtime import apply_citation_repair
    from backend.agent_tools import AgentAbort
    for text in ("Ответ с новой ссылкой", '```json\n{"citations":[]}\n```'):
        with pytest.raises(AgentAbort, match="agent_protocol_error"):
            apply_citation_repair("Ответ", text, {"one"})


@pytest.mark.parametrize("mode", ["acknowledged", "unknown", "truncated", "repair_budget"])
def test_live_http_shared_evidence_unknown_truncation_and_repair_budget(monkeypatch, mode):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread
    from backend.agent_tools import AgentAbort

    monkeypatch.setattr("backend.agent_attachments.verify_provider_context", lambda settings: None)
    context = AttachmentContext(None, uuid4(), uuid4())
    descriptor = {"file_id": str(uuid4()), "version_id": str(uuid4())}
    file_chunk = context.register(descriptor, [test_attachments.make_chunk(descriptor["version_id"], text="F" * 2000)])[0]
    regulation = norm("Подтверждённая норма")
    regulation["citation"] = "[[regulation:" + regulation["chunk_id"] + "]]"
    context.regulations[regulation["chunk_id"]] = regulation
    file_records, norm_records, bodies = [], [], []
    context.record = lambda action, items: file_records.append((action, [c["chunk_id"] for c in items]))
    context.record_regulations = lambda action, items: norm_records.append((action, [c["chunk_id"] for c in items]))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            bodies.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            if mode == "unknown":
                self.close_connection = True
                return
            body = b'{"choices":[{"message":{"content":"answer"}}]}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/v1"
    block = "\n<attachment_chunk>\n" + encode(file_chunk) + "\n</attachment_chunk>"
    context.initial_blocks = [block]
    body = {"model": "synthetic-wire", "messages": [{"role": "system", "content": "Fixed"},
            {"role": "user", "content": "Исходный вопрос" + block},
            {"role": "tool", "tool_call_id": "norm", "content": encode({"chunks": [regulation]})}]}
    window = 4096 if mode in {"truncated", "repair_budget"} else 16384
    settings = SimpleNamespace(context_window=window, max_tokens=128, prompt_tokens=1000, base_url=url,
                               prompt_fingerprint=static_fingerprint(body, window, url))
    transport = AttachmentTransport(httpx.HTTPTransport(), context, lambda: None, settings)
    if mode == "repair_budget":
        body["messages"] += [{"role": "assistant", "content": "D" * 2500}, {"role": "user", "content": "Добавь ссылку"}]
        transport.citation_repair = True
    try:
        with httpx.Client(transport=transport, timeout=2, trust_env=False) as client:
            if mode == "unknown":
                with pytest.raises(httpx.RemoteProtocolError):
                    client.post(url + "/chat/completions", json=body)
            elif mode == "repair_budget":
                with pytest.raises(AgentAbort, match="agent_context_limit"):
                    client.post(url + "/chat/completions", json=body)
            else:
                client.post(url + "/chat/completions", json=body)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    if mode == "repair_budget":
        assert not bodies and not file_records and not norm_records
        assert not context.acknowledged_regulations
    else:
        assert len(bodies) == 1 and encode(regulation) in bodies[0]["messages"][-1]["content"]
        outcome = "unknown" if mode == "unknown" else "acknowledged"
        assert norm_records[-2:] == [("submitted", [regulation["chunk_id"]]), (outcome, [regulation["chunk_id"]])]
        assert context.acknowledged_regulations == (set() if mode == "unknown" else {regulation["chunk_id"]})
        file_ids = [] if mode == "truncated" else [file_chunk["chunk_id"]]
        assert file_records[-2:] == [("submitted", file_ids), (outcome, file_ids)]
        assert (encode(file_chunk) in bodies[0]["messages"][1]["content"]) == (mode != "truncated")


@pytest.mark.skipif(os.environ.get("P11_LIVE_RACE") != "1", reason="Explicit isolated database/operator concurrency check")
@pytest.mark.parametrize("withdraw_first", [True, False])
def test_real_multiconnection_withdrawal_serializes_final_answer(withdraw_first):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from time import monotonic, sleep
    import secrets
    from psycopg.rows import dict_row
    from backend.agent_config import AgentSettings
    from backend.auth import access_actor, hasher, login, logout
    from backend.knowledge_config import KnowledgeSettings

    dsn = os.environ["TEST_DATABASE_DSN"]
    settings = AgentSettings()
    operator = KnowledgeSettings(database_file=Path(".local/p11-knowledge-operator.json"))
    item, worker = norm(), uuid4()
    sessions, tokens, run = [], {}, None
    try:
        with psycopg.connect(dsn, row_factory=dict_row) as db:
            for name in ("vasilyeva", "ivanov.ks"):
                account = db.execute("SELECT user_id,password_hash FROM deanery.app_user WHERE login=%s FOR UPDATE", (name,)).fetchone()
                password = secrets.token_urlsafe(32)
                db.execute("UPDATE deanery.app_user SET password_hash=%s WHERE user_id=%s", (hasher.hash(password), account["user_id"]))
                db.execute("SET LOCAL ROLE backend_api")
                token, _, _ = login(db, name, password)
                _, session = access_actor(db, token)
                tokens[name] = token
                sessions.append(session)
                db.execute("RESET ROLE")
                db.execute("UPDATE deanery.app_user SET password_hash=%s WHERE user_id=%s", (account["password_hash"], account["user_id"]))
            admin = db.execute("SELECT user_id FROM deanery.app_user WHERE login='vasilyeva'").fetchone()["user_id"]
            metadata = {"active_index_generation": item["generation_id"], "version_label": item["version_label"],
                        "source_url": item["source_url"], "scope": {"global": True, "institute_ids": []}}
            db.execute("INSERT INTO agent_backend.regulation(id,title) VALUES(%s,%s)", (item["regulation_id"], item["title"]))
            db.execute("""INSERT INTO agent_backend.regulation_version(id,regulation_id,source,processing_state,published_at,published_by,metadata)
                          VALUES(%s,%s,%s,'ready',now(),%s,%s)""", (item["version_id"], item["regulation_id"], item["source"], admin, Jsonb(metadata)))
            db.execute("INSERT INTO agent_backend.regulation_chunk(id,version_id,sequence,text,locator,index_state) VALUES(%s,%s,0,%s,%s,'ready')",
                       (item["chunk_id"], item["version_id"], item["text"], Jsonb(item["locator"])))
            db.execute("SET LOCAL ROLE backend_api")
            run = db.execute("SELECT backend_api.start_agent_run(NULL,%s,'[]',%s,%s) AS run",
                             ("Синтетическая гонка отзыва источника", uuid4(), tokens["ivanov.ks"])).fetchone()["run"]
        with settings.connect() as db:
            assert db.execute("SELECT backend_api.claim_agent_run(%s) AS run", (worker,)).fetchone()["run"] == run
            evidence = {k: item[k] for k in ("regulation_id", "version_id", "chunk_id", "generation_id", "text_hash")}
            for action in ("read", "submitted", "acknowledged"):
                db.execute("SELECT backend_api.record_regulation_context(%s,%s,%s,%s)", (run["run_id"], worker, action, Jsonb([evidence])))

        def finish(db):
            return db.execute("SELECT backend_api.finish_agent_run(%s,%s,%s,NULL) AS result",
                              (run["run_id"], worker, item["text"] + " [[regulation:" + item["chunk_id"] + "]]")).fetchone()["result"]

        def withdraw(db):
            return db.execute("SELECT backend_api.withdraw_regulation(%s,%s,%s) AS result",
                              (item["version_id"], "Синтетическая проверка конкурентного отзыва", tokens["vasilyeva"])).fetchone()["result"]

        started, connection_id, blocked_result = Event(), [], []
        first_connect, second_connect = (operator.connect, settings.connect) if withdraw_first else (settings.connect, operator.connect)
        first_action, second_action = (withdraw, finish) if withdraw_first else (finish, withdraw)

        def second():
            with second_connect() as db:
                connection_id.append(db.info.backend_pid)
                started.set()
                blocked_result.append(second_action(db))

        with ThreadPoolExecutor(max_workers=1) as pool:
            with first_connect() as first:
                first_pid = first.info.backend_pid
                first_result = first_action(first)
                future = pool.submit(second)
                assert started.wait(2)
                deadline, blocked = monotonic() + 3, False
                with psycopg.connect(dsn, autocommit=True) as observer:
                    while monotonic() < deadline:
                        blockers = observer.execute("SELECT pg_blocking_pids(%s)", (connection_id[0],)).fetchone()[0]
                        if first_pid in blockers:
                            blocked = True
                            break
                        sleep(0.01)
                assert blocked and not future.done()
            future.result(timeout=6)
        result = blocked_result[0] if withdraw_first else first_result
        with psycopg.connect(dsn, row_factory=dict_row) as db:
            audit = db.execute("SELECT status,error_code,regulation_context FROM agent_backend.agent_run WHERE id=%s", (run["run_id"],)).fetchone()
            assert audit["error_code"] == ("agent_scope_changed" if withdraw_first else None)
            assert audit["status"] == ("failed" if withdraw_first else "succeeded")
            if withdraw_first:
                assert item["text"] not in result["answer"] and not audit["regulation_context"]["cited_chunk_ids"]
            else:
                assert item["source_url"] in result["answer"] and audit["regulation_context"]["cited_chunk_ids"] == [item["chunk_id"]]
            db.execute("SET LOCAL ROLE backend_api")
            with pytest.raises(psycopg.Error) as denied:
                with db.transaction():
                    chats.events(db, UUID(run["run_id"]), tokens["ivanov.ks"], 0)
            assert denied.value.sqlstate == "P8008"
            history = chats.messages(db, UUID(run["session_id"]), tokens["ivanov.ks"], 20, 0)
            assert item["text"] not in encode(history)
    finally:
        if run is not None:
            with settings.connect() as db:
                try:
                    with db.transaction():
                        db.execute("SELECT backend_api.finish_agent_run(%s,%s,'','agent_cancelled')", (run["run_id"], worker))
                except psycopg.Error as exc:
                    assert exc.sqlstate == "P8008"
        with psycopg.connect(dsn, row_factory=dict_row) as db:
            db.execute("SET LOCAL ROLE backend_api")
            for session in sessions:
                logout(db, session)


def norm(text="Синтетическая норма", **updates):
    return {"regulation_id": str(uuid4()), "version_id": str(uuid4()), "chunk_id": str(uuid4()),
            "generation_id": str(uuid4()), "title": "Тестовое положение", "version_label": "v1", "source": "Учебный источник",
            "source_url": "https://example.edu/norm", "text": text, "text_hash": sha256(text.encode()).hexdigest(),
            "locator": {"page": 2}, **updates}


def test_norm_wire_acknowledgment_and_shared_file_budget(monkeypatch):
    monkeypatch.setattr("backend.agent_attachments.verify_provider_context", lambda settings: None)
    context = AttachmentContext(None, uuid4(), uuid4())
    chunks = [norm()]
    db = SimpleNamespace(execute=lambda *args: SimpleNamespace(fetchone=lambda: {"result": chunks}))
    chunk = context.regulation_results(db, [])["chunks"][0]
    context.record = lambda *args: None
    recorded, bodies = [], []
    context.record_regulations = lambda action, items: recorded.append((action, [c["chunk_id"] for c in items]))
    body = {"model": "test", "messages": [{"role": "system", "content": "Fixed"}, {"role": "user", "content": "Вопрос"}]}
    settings = SimpleNamespace(context_window=16384, max_tokens=128, prompt_tokens=1000,
                               prompt_fingerprint=static_fingerprint(body, 16384), base_url="http://127.0.0.1:1234/v1")
    def send(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": []})
    transport = AttachmentTransport(httpx.MockTransport(send), context, lambda: None, settings)
    with httpx.Client(transport=transport) as client:
        body["messages"].append({"role": "assistant", "content": encode(chunk)})
        client.post("http://provider/chat/completions", json=body)
        assert recorded[-2:] == [("submitted", []), ("acknowledged", [])]
        body["messages"].append({"role": "tool", "tool_call_id": "1", "content": encode({"chunks": [chunk]})})
        client.post("http://provider/chat/completions", json=body)
    assert recorded[-2:] == [("submitted", [chunk["chunk_id"]]), ("acknowledged", [chunk["chunk_id"]])]
    assert encode(chunk) in bodies[-1]["messages"][-1]["content"]
    assert context.remaining() == 8000-len(chunk["text"])
    context.chunks["fake-file-budget"] = {"text": "x" * context.remaining()}
    chunks[:] = [norm("Не помещается")]
    assert context.regulation_results(db, [])["status"] == "context_budget_exhausted"


class RegulationCitationTests(DatabaseHttpCase):
    login, query, work, start = test_chats.ChatTests.login, test_chats.ChatTests.query, test_chats.ChatTests.work, test_chats.ChatTests.start

    def setUp(self):
        super().setUp()
        self.worker = uuid4()
        self.headers = self.login("vasilyeva")
        self.token = self.headers["Authorization"][7:]

    def source(self, scope=None, published=True):
        item = norm()
        self.query("INSERT INTO agent_backend.regulation(id,title) VALUES(%s,%s) RETURNING id", (item["regulation_id"], item["title"]))
        metadata = {"active_index_generation": item["generation_id"], "version_label": item["version_label"],
                    "source_url": item["source_url"], "scope": scope or {"global": True, "institute_ids": []}}
        self.query("""INSERT INTO agent_backend.regulation_version(id,regulation_id,source,processing_state,published_at,published_by,metadata)
                   VALUES(%s,%s,%s,'ready',CASE WHEN %s THEN now() END,%s,%s) RETURNING id""",
                   (item["version_id"], item["regulation_id"], item["source"], published, self.user_id if published else None, Jsonb(metadata)))
        self.query("""INSERT INTO agent_backend.regulation_chunk(id,version_id,sequence,text,locator,index_state)
                   VALUES(%s,%s,0,%s,%s,'ready') RETURNING id""", (item["chunk_id"], item["version_id"], item["text"], Jsonb(item["locator"])))
        return item

    def evidence(self, item):
        return {k: item[k] for k in ("regulation_id", "version_id", "chunk_id", "generation_id", "text_hash")}

    def record(self, run, item, *actions):
        for action in actions:
            self.work("record_regulation_context", (run["run_id"], self.worker, action, Jsonb([self.evidence(item)])))

    def test_database_rehydration_rejects_stale_generation_hash_and_scope(self):
        item = self.source()
        student = self.login("ivanov.ks")["Authorization"][7:]
        run = self.start(token=student)
        self.work("claim_agent_run", (self.worker,))
        candidate = {**self.evidence(item), "text": "Injected index payload"}
        def read(c):
            return self.work("rehydrate_regulation_candidates", (run["run_id"], self.worker, Jsonb([c])))
        assert read(candidate)[0]["text"] == item["text"]
        assert read({**candidate, "generation_id": str(uuid4())}) == []
        assert read({**candidate, "text_hash": "0" * 64}) == []
        own = self.work("run_regulation_scope", (run["run_id"], self.worker))
        other = self.query("SELECT institute_id FROM deanery.institute WHERE institute_id<>ALL(%s) LIMIT 1", (own["institute_ids"],))[0]["institute_id"]
        hidden = self.source({"global": False, "institute_ids": [other]})
        assert read(self.evidence(hidden)) == []

    def test_current_scope_excludes_withdrawn_unpublished_and_other_institutes(self):
        current, withdrawn, draft = self.source(), self.source(), self.source(published=False)
        self.query("UPDATE agent_backend.regulation_version SET metadata=metadata||jsonb_build_object('withdrawn_at',clock_timestamp()) WHERE id=%s RETURNING id", (withdrawn["version_id"],))
        run = self.start(token=self.login("ivanov.ks")["Authorization"][7:])
        self.work("claim_agent_run", (self.worker,))
        scope = self.work("run_regulation_scope", (run["run_id"], self.worker))
        other = self.query("SELECT institute_id FROM deanery.institute WHERE institute_id<>ALL(%s) LIMIT 1", (scope["institute_ids"],))[0]["institute_id"]
        hidden = self.source({"global": False, "institute_ids": [other]})
        generations = self.work("run_regulation_scope", (run["run_id"], self.worker))["generation_ids"]
        assert current["generation_id"] in generations
        assert not {withdrawn["generation_id"], draft["generation_id"], hidden["generation_id"]}.intersection(generations)

    def test_terminal_error_marks_norm_submission_unknown(self):
        item, run = self.source(), self.start()
        self.work("claim_agent_run", (self.worker,))
        self.record(run, item, "read", "submitted")
        self.query("SELECT agent_backend.end_agent_run(%s,NULL,'agent_outcome_unknown')", (run["run_id"],))
        saved = self.query("SELECT regulation_context FROM agent_backend.agent_run WHERE id=%s", (run["run_id"],))[0]["regulation_context"]
        assert saved["delivery_state"] == "unknown" and saved["acknowledged_chunk_ids"] == []

    def test_shared_chunk_budget_rejects_both_registration_orders(self):
        ref = test_attachments.AttachmentSqlTests.file(self)
        for norms_first in (True, False):
            run = test_attachments.AttachmentSqlTests.start(self, [ref])
            self.work("claim_agent_run", (self.worker,))
            item = self.source()
            norms = [item]
            for sequence in range(1, 20):
                c = {**item, "chunk_id": str(uuid4())}
                self.query("INSERT INTO agent_backend.regulation_chunk(id,version_id,sequence,text,locator,index_state) VALUES(%s,%s,%s,%s,%s,'ready') RETURNING id",
                           (c["chunk_id"], c["version_id"], sequence, c["text"], Jsonb(c["locator"])))
                norms.append(c)
            files = [{**ref, **{k:v for k,v in test_attachments.make_chunk(ref["version_id"], page=i).items() if k != "text"}} for i in range(20)]
            def file_record(chunks):
                self.work("record_attachment_context", (run["run_id"], self.worker, "read", Jsonb(chunks), Jsonb({})))
            def norm_record(chunks):
                self.work("record_regulation_context", (run["run_id"], self.worker, "read", Jsonb([self.evidence(c) for c in chunks])))
            (norm_record if norms_first else file_record)(norms if norms_first else files)
            with pytest.raises(psycopg.Error) as error:
                (file_record if norms_first else norm_record)(files[:1] if norms_first else norms[:1])
            assert error.value.sqlstate == "22023"
            self.work("finish_agent_run", (run["run_id"], self.worker, "Готово", None))

    def test_direct_finalization_strips_protocol_relative_and_gfm_links(self):
        run = self.start()
        self.work("claim_agent_run", (self.worker,))
        result = self.work("finish_agent_run", (run["run_id"], self.worker, "[Норма](//evil.example/law) www.evil.example/law", None))
        assert "evil.example" not in result["answer"]

    def test_only_acknowledged_chunks_render_and_unknown_stays_uncited(self):
        item = self.source()
        run = self.start()
        self.work("claim_agent_run", (self.worker,))
        self.record(run, item, "read")
        with pytest.raises(psycopg.Error) as error:
            self.record(run, item, "acknowledged")
        assert error.value.sqlstate == "22023"
        result = self.work("finish_agent_run", (run["run_id"], self.worker, "[[regulation:"+item["chunk_id"]+"]]", None))
        assert result["answer"] == "Источник не подтверждён"
        second = self.start(session=run["session_id"])
        self.work("claim_agent_run", (self.worker,))
        self.record(second, item, "read", "submitted", "acknowledged")
        result = self.work("finish_agent_run", (second["run_id"], self.worker,
            "Проверено [[regulation:"+item["chunk_id"]+"]] [[regulation:guessed]] https://evil.example/fake", None))
        assert "[Тестовое положение — Учебный источник; версия v1; стр. 2](https://example.edu/norm)" in result["answer"]
        assert result["answer"].count("Источник не подтверждён") == 2
        saved = self.query("SELECT regulation_context FROM agent_backend.agent_run WHERE id=%s", (second["run_id"],))[0]["regulation_context"]
        assert saved["cited_chunk_ids"] == [item["chunk_id"]] and '"text"' not in encode(saved)

    def test_withdrawal_revokes_history_replay_inflight_and_deleted_chat_copies(self):
        item = self.source()
        run = self.start()
        self.work("claim_agent_run", (self.worker,))
        self.record(run, item, "read", "submitted", "acknowledged")
        self.work("append_agent_event", (run["run_id"], self.worker, "tool_result", Jsonb({"output": item["text"]})))
        self.work("finish_agent_run", (run["run_id"], self.worker, item["text"]+" [[regulation:"+item["chunk_id"]+"]]", None))
        pending = self.start(session=run["session_id"])
        self.work("claim_agent_run", (self.worker,))
        assert self.work("agent_run_read_context", (pending["run_id"], self.worker))["history"]
        self.query("UPDATE agent_backend.regulation_version SET metadata=metadata||jsonb_build_object('withdrawn_at',clock_timestamp()) WHERE id=%s RETURNING id", (item["version_id"],))
        with pytest.raises(psycopg.Error) as error:
            with self.db.transaction():
                chats.events(self.db, UUID(run["run_id"]), self.token, 0)
        assert error.value.sqlstate == "P8008"
        result = self.work("finish_agent_run", (pending["run_id"], self.worker, item["text"], None))
        assert item["text"] not in result["answer"]
        history = chats.messages(self.db, UUID(run["session_id"]), self.token, 20, 0)
        assert item["text"] not in encode(history)
        with self.db.transaction():
            chats.delete(self.db, UUID(run["session_id"]), self.token)
        copies = self.query("SELECT events,result FROM agent_backend.agent_run WHERE id=%s", (run["run_id"],))
        assert item["text"] not in encode(copies)


@pytest.mark.skipif(os.environ.get("P11_CALIBRATE") != "1", reason="Explicit synthetic local Qwen calibration only")
def test_calibrate_exact_final_tools_and_system():
    from langchain_openai import ChatOpenAI
    from backend.agent_config import AgentSettings
    from backend.agent_runtime import create_agent_graph
    from backend.agent_tools import build_tools
    from backend.agent_attachments import verify_provider_context, static_payload
    settings = AgentSettings()
    verify_provider_context(settings)
    captured = []
    def capture(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "synthetic", "object": "chat.completion", "created": 0, "model": settings.model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]})
    with httpx.Client(transport=httpx.MockTransport(capture)) as client:
        model = ChatOpenAI(model=settings.model, base_url=settings.base_url, api_key=settings.api_key.get_secret_value(),
                           temperature=0, use_responses_api=False, max_retries=0, max_tokens=1, http_client=client, http_socket_options=())
        graph = create_agent_graph(model, build_tools(None, uuid4(), uuid4(), None, None))
        graph.invoke({"messages": [{"role": "user", "content": "Калибровка."}]})
    assert len(captured) == 1 and len(captured[0]["tools"]) == 13
    with httpx.Client(timeout=180, trust_env=False) as client:
        response = client.post(settings.base_url.rstrip("/")+"/chat/completions", json=captured[0],
            headers={"Authorization": "Bearer "+settings.api_key.get_secret_value()})
        response.raise_for_status()
        usage = response.json()["usage"]
    result = {"model": settings.model, "provider": settings.base_url, "loaded_context_length": settings.context_window,
              "tool_count": 13, "prompt_fingerprint": static_fingerprint(captured[0], settings.context_window, settings.base_url),
              "usage": usage, "configured_static_tokens": usage["prompt_tokens"]+256, "static_margin": 256,
              "static_utf8_bytes": len(encode(static_payload(captured[0], settings.context_window, settings.base_url)).encode()),
              "output_limits": {k: v for k, v in captured[0].items() if k in {"max_tokens", "max_completion_tokens"}},
              "dynamic_framing_reserve": 512, "per_message_margin": 32}
    Path(".local/p11-prompt-calibration.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))
