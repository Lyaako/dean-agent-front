"""Exact transport evidence and current authorization on real PostgreSQL."""

from hashlib import sha256
from contextlib import contextmanager
import json
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import psycopg
from psycopg.types.json import Jsonb
import pytest

from backend import chats
from backend.agent_attachments import AttachmentContext, AttachmentTransport, sanitize_answer_links, static_fingerprint
from backend.agent_tools import AgentAbort, build_tools, encode
from backend.contracts import ChatRequest
from backend.tests.test_auth import DatabaseHttpCase
from backend.tests import test_chats


@pytest.fixture(autouse=True)
def local_provider_metadata_is_separate_from_fake_completion_transport(monkeypatch):
    monkeypatch.setattr("backend.agent_attachments.verify_provider_context", lambda settings: None)


def make_chunk(version=None, text="Текст страницы 25", page=25):
    version = str(version or uuid4())
    digest = sha256(text.encode()).hexdigest()
    return {"chunk_id": f"{version}:p{page}:0:{digest[:16]}", "text": text, "text_hash": digest,
            "page": page, "block": None, "start": 0, "end": len(text), "source": "ocr", "quality": "normal"}


def transport_fixture(text="Текст страницы 25", window=16384):
    context = AttachmentContext(None, uuid4(), uuid4())
    descriptor = {"file_id": str(uuid4()), "version_id": str(uuid4())}
    chunk = context.register(descriptor, [make_chunk(descriptor["version_id"], text)])[0]
    records, bodies = [], []
    context.record = lambda action, chunks, db=None: records.append((action, [c["chunk_id"] for c in chunks]))
    payload = {"model": "test", "messages": [{"role": "system", "content": "Static system"},
               {"role": "user", "content": "Вопрос"}], "tools": [], "temperature": 0, "max_completion_tokens": 128}
    settings = SimpleNamespace(context_window=window, max_tokens=128, prompt_tokens=1000,
                               base_url="http://127.0.0.1:1234/v1", prompt_fingerprint=static_fingerprint(payload, window))
    def send(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "answer"}}]})
    transport = AttachmentTransport(httpx.MockTransport(send), context, lambda: None, settings)
    return context, chunk, records, bodies, payload, transport


def test_calibration_ignores_json_object_order_but_preserves_values_and_tool_order():
    payload = {"model": "test", "temperature": 0.6, "reasoning_effort": "none",
               "messages": [{"role": "system", "content": "System"}], "tools": [{"name": "one"}, {"name": "two"}]}
    expected = static_fingerprint(payload, 20480)
    reordered = dict(reversed(list(payload.items())))
    reordered["messages"] = [{"content": "System", "role": "system"}]
    assert static_fingerprint(reordered, 20480) == expected
    assert static_fingerprint({**payload, "temperature": 0.7}, 20480) != expected
    assert static_fingerprint({**payload, "tools": list(reversed(payload["tools"]))}, 20480) != expected


def test_exact_wire_body_is_the_only_provided_evidence_and_no_image_payload():
    context, chunk, records, bodies, payload, transport = transport_fixture()
    payload["messages"][-1]["content"] += encode(chunk)
    with httpx.Client(transport=transport) as client:
        client.post("http://provider/chat/completions", json=payload)
    assert encode(chunk) in bodies[0]["messages"][-1]["content"]
    assert records[-2:] == [("submitted", [chunk["chunk_id"]]), ("acknowledged", [chunk["chunk_id"]])]
    assert "image_url" not in encode(bodies)


def test_selected_and_assistant_guessed_ids_are_not_outbound_evidence():
    context, chunk, records, bodies, payload, transport = transport_fixture()
    payload["messages"].append({"role": "assistant", "content": encode(chunk)})
    with httpx.Client(transport=transport) as client:
        client.post("http://provider/chat/completions", json=payload)
    assert records[-2:] == [("submitted", []), ("acknowledged", [])]


def test_tool_read_is_distinct_until_exact_result_reaches_provider_and_failure_is_unknown():
    context, chunk, records, bodies, payload, transport = transport_fixture()
    context.record("read", [chunk])
    assert records == [("read", [chunk["chunk_id"]])]
    payload["messages"].append({"role": "tool", "tool_call_id": "1", "content": encode({"chunks": [chunk]})})
    def fail(request):
        bodies.append(json.loads(request.content))
        raise httpx.ReadTimeout("synthetic network loss")
    transport.inner = httpx.MockTransport(fail)
    with httpx.Client(transport=transport) as client, pytest.raises(httpx.ReadTimeout):
        client.post("http://provider/chat/completions", json=payload)
    assert records[-2:] == [("submitted", [chunk["chunk_id"]]), ("unknown", [chunk["chunk_id"]])]
    assert encode(chunk) in bodies[0]["messages"][-1]["content"]


def test_budget_trims_actual_sent_history_and_chunks_and_rejects_changed_static_prompt():
    context, chunk, records, bodies, payload, transport = transport_fixture(text="x" * 2000, window=2048)
    block = "\n<attachment_chunk>\n" + encode(chunk) + "\n</attachment_chunk>"
    context.initial_blocks = [block]
    payload["messages"].insert(1, {"role": "user", "content": "old" * 1000})
    payload["messages"][-1]["content"] += block
    with httpx.Client(transport=transport) as client:
        client.post("http://provider/chat/completions", json=payload)
        payload["tools"] = [{"function": {"name": "changed"}}]
        with pytest.raises(AgentAbort, match="uncalibrated"):
            client.post("http://provider/chat/completions", json=payload)
    assert len(bodies) == 1 and len(bodies[0]["messages"]) == 2
    assert encode(chunk) not in encode(bodies)
    assert context.warnings == {"history_truncated", "context_truncated"}
    assert records[-2:] == [("submitted", []), ("acknowledged", [])]


def test_stop_guard_prevents_any_transport_or_manifest_write():
    context, chunk, records, bodies, payload, transport = transport_fixture()
    def stop():
        raise AgentAbort("agent_cancelled")
    transport.check = stop
    with httpx.Client(transport=transport) as client, pytest.raises(AgentAbort):
        client.post("http://provider/chat/completions", json=payload)
    assert records == bodies == []


def test_tool_call_commentary_does_not_exhaust_context_or_remove_calls_results_and_final_answer():
    context, chunk, records, bodies, payload, transport = transport_fixture(window=3000)
    call = {"id": "one", "type": "function", "function": {"name": "read_attachment_text", "arguments": "{}"}}
    payload["messages"] += [
        {"role": "assistant", "content": "Intermediate commentary " * 1000, "tool_calls": [call]},
        {"role": "tool", "tool_call_id": "one", "content": encode({"chunks": [chunk]})},
        {"role": "assistant", "content": "Final answer [[attachment:" + chunk["chunk_id"] + "]]"},
    ]
    with httpx.Client(transport=transport) as client:
        client.post("http://provider/chat/completions", json=payload)
    sent = bodies[0]["messages"]
    assert sent[2] == {"role": "assistant", "content": None, "tool_calls": [call]}
    assert sent[3:] == payload["messages"][3:]
    assert records[-2:] == [("submitted", [chunk["chunk_id"]]), ("acknowledged", [chunk["chunk_id"]])]


def test_invalid_attachment_cursor_returns_safe_tool_error_without_aborting_run(monkeypatch,fake_tool_context):
    from backend.file_parser import AttachmentError
    descriptor = {"file_id": str(uuid4()), "version_id": str(uuid4())}
    events, writes = [], []
    class DB:
        def execute(self, query, args=()):
            writes.append(query)
            result = descriptor if "run_attachment_descriptor" in query else {"actor": {"role_code": "student"}}
            return SimpleNamespace(fetchone=lambda: {"result": result})
    @contextmanager
    def connect(read_only=False):
        assert not read_only
        yield DB()
    def invalid(*args, **kwargs):
        raise AttachmentError("invalid_attachment_selector")
    monkeypatch.setattr("backend.files.read_chunks", invalid)
    run, worker = uuid4(), uuid4()
    context = AttachmentContext(connect, run, worker)
    tools = {t.name: t for t in build_tools(connect, run, worker, lambda *args: events.append(args), lambda: None, context)}
    result = json.loads(tools["read_attachment_text"].invoke({"version_id": descriptor["version_id"], "cursor": "invalid"}))
    assert result == {"error": "invalid_attachment_selector"}
    assert [e[0] for e in events] == ["tool_call", "tool_result"]
    assert not any("record_attachment_context" in query for query in writes)


@pytest.mark.parametrize("target", [
    "/api/v1/%66iles/one/versions/two/%64ownload",
    "https://example.test/api/v1/files/one/versions/two/download?x=1#page=25",
    "/api/v1/files/one/versions/two/../two/download",
    "/api/v1/%2566iles/one/versions/two/%2564ownload",
])
def test_model_download_targets_are_canonicalized_before_verified_tokens_render(target):
    answer = "[source](" + target + ") [[attachment:valid-token]]"
    assert sanitize_answer_links(answer) == "[source]([[attachment:unverified]]) [[attachment:valid-token]]"


@pytest.mark.parametrize("target", ["//evil.example/law", "www.evil.example/law", "%2f%2fevil.example/law", "&#47;&#47;evil.example/law", r"https:\/\/evil.example/law", r"\/\/evil.example/law"])
def test_unverified_protocol_relative_and_gfm_links_are_removed(target):
    assert "evil.example" not in sanitize_answer_links("[source](" + target + ") " + target)


@pytest.mark.parametrize("target", ["https://evil.example/law", "https:evil.example/law", "//evil.example/law", "www.evil.example/law",
    "https&colon;&sol;&sol;evil.example/law", r"https:\/\/evil.example/law", r"https:\\evil.example/law",
    r"https:/\evil.example/law", "ht&#9;tps://evil.example/law", "h%74tps%3a%2f%2fevil.example/law"])
@pytest.mark.parametrize("wrapper", ["[n]({})", "<{}>", "[n][r]\n\n[r]:{}", "[n][]\n\n[n]:{}", "[n]\n\n[n]:{}", "{}"])
def test_renderer_destination_matrix_blocks_unverified_external_links(target, wrapper):
    assert "evil.example" not in sanitize_answer_links(wrapper.format(target))


def test_link_cleanup_preserves_prose_and_verified_citation_placeholders():
    answer = "Срок — семь дней. [[regulation:123]] [[attachment:456]]"
    assert sanitize_answer_links(answer) == answer


def test_initial_chunk_exhaustion_keeps_second_file_metadata_without_zero_budget_call(monkeypatch):
    descriptors = [{"file_id": str(uuid4()), "version_id": str(uuid4()), "filename": f"file{i}.txt", "title": f"file{i}.txt",
                    "mime": "text/plain", "byte_size": 100} for i in range(2)]
    calls = []
    def read(descriptor, **kwargs):
        calls.append(kwargs)
        assert kwargs["max_chunks"] > 0
        return {"chunks": [make_chunk(descriptor["version_id"], str(i)) for i in range(kwargs["max_chunks"])]}
    monkeypatch.setattr("backend.files.read_chunks", read)
    context = AttachmentContext(None, uuid4(), uuid4())
    context.record = lambda *args, **kwargs: None
    content = context.initial(descriptors)
    assert len(calls) == 1 and len(context.chunks) == 19
    assert descriptors[1]["version_id"] in content
    assert not any(c["version_id"] == descriptors[1]["version_id"] for c in context.chunks.values())


def test_many_short_initial_pages_leave_room_for_explicit_last_page(monkeypatch):
    descriptor = {"file_id": str(uuid4()), "version_id": str(uuid4()), "filename": "pages.pdf",
                  "title": "pages.pdf", "mime": "application/pdf", "byte_size": 100}
    def read(descriptor, **kwargs):
        if kwargs.get("page") == 25:
            return {"chunks": [make_chunk(descriptor["version_id"], "Код страницы 25", page=25)],
                    "next_cursor": None, "has_more": False}
        return {"chunks": [make_chunk(descriptor["version_id"], str(i), page=i)
                           for i in range(1, kwargs["max_chunks"] + 1)]}
    monkeypatch.setattr("backend.files.read_chunks", read)
    context = AttachmentContext(None, uuid4(), uuid4())
    context.record = lambda *args, **kwargs: None
    context.initial([descriptor])
    db = SimpleNamespace(execute=lambda *args: SimpleNamespace(fetchone=lambda: {"result": descriptor}))
    result = context.read(db, descriptor["version_id"], page=25)
    assert result["chunks"][0]["page"] == 25 and result["chunks"][0]["text"] == "Код страницы 25"
    assert len(context.chunks) == 20 and context.remaining() > 0


class AttachmentSqlTests(DatabaseHttpCase):
    login = test_chats.ChatTests.login
    query = test_chats.ChatTests.query
    work = test_chats.ChatTests.work

    def setUp(self):
        super().setUp()
        self.worker = uuid4()
        self.headers = self.login("vasilyeva")
        self.token = self.headers["Authorization"][7:]

    def file(self, owner="vasilyeva", size=10, state="ready"):
        file = self.query("INSERT INTO agent_backend.file(owner_user_id,name) SELECT user_id,'fixture.pdf' FROM deanery.app_user WHERE login=%s RETURNING id", (owner,))[0]["id"]
        version = self.query("""INSERT INTO agent_backend.file_version(file_id,original_name,mime_type,byte_size,storage_key,content_hash,extraction_state,extraction)
            VALUES(%s,'fixture.pdf','application/pdf',%s,%s,%s,%s,%s) RETURNING id""",
            (file, size, str(uuid4()), sha256(b"fixture").digest(), state, Jsonb({"total_pages": 25, "total_chunks": 2,
              "coverage": {"total_pages": 25, "complete": True}, "warnings": []})))[0]["id"]
        return {"file_id": str(file), "version_id": str(version)}

    def start(self, refs=(), token=None, session=None, key=None):
        with self.db.transaction():
            return chats.start(self.db, ChatRequest(message="Проверка вложения", session_id=session, attachments=list(refs)),
                               key or uuid4(), token or self.token)

    def record(self, run, ref, action, chunk=None):
        chunk = chunk or make_chunk(ref["version_id"])
        evidence = {**{k: v for k, v in chunk.items() if k != "text"}, **ref}
        self.work("record_attachment_context", (run["run_id"], self.worker, action, Jsonb([evidence]), Jsonb({"max_text_chunks": 20})))
        return chunk

    def test_atomic_exact_refs_ready_bytes_duplicates_and_no_foreign_disclosure(self):
        first, second = self.file(), self.file()
        invalid = [([first, first], "22023"), ([{**first, "version_id": second["version_id"]}], "P0002"),
                   ([self.file(state="processing")], "P8101"), ([self.file(owner="ivanov.ks")], "P0002"),
                   ([self.file(size=10000000), self.file(size=10000000), first], "P8102")]
        for refs, expected in invalid:
            with self.assertRaises(psycopg.Error) as error:
                self.start(refs)
            self.assertEqual(error.exception.sqlstate, expected)
        self.assertEqual(self.query("SELECT count(*) AS n FROM agent_backend.run_attachment")[0]["n"], 0)
        key = uuid4()
        run = self.start([first], key=key)
        self.assertEqual(self.start([first], key=key), run)
        manifest = chats.attachment_context(self.db, UUID(run["run_id"]), self.token)
        self.assertEqual(manifest["files"][0]["context_state"], "pending")
        self.assertNotIn("storage_key", encode(manifest))

    def test_acknowledged_citations_only_reload_original_links_and_stopped_uncertainty(self):
        ref = self.file()
        run = self.start([ref])
        self.work("claim_agent_run", (self.worker,))
        chunk = self.record(run, ref, "selected")
        self.record(run, ref, "read", chunk)
        self.record(run, ref, "submitted", chunk)
        self.record(run, ref, "acknowledged", chunk)
        answer = "Верный [[attachment:" + chunk["chunk_id"] + "]] неверный [[attachment:invented]] /api/v1/files/fake/versions/fake/download"
        result = self.work("finish_agent_run", (run["run_id"], self.worker, answer, None))
        self.assertIn("/download#page=25", result["answer"])
        self.assertEqual(result["answer"].count("Источник не подтверждён"), 2)
        item = result["attachment_context"]["files"][0]
        self.assertEqual(item["context_state"], "used")
        self.assertEqual(item["cited_chunk_ids"], [chunk["chunk_id"]])
        reloaded = chats.messages(self.db, UUID(run["session_id"]), self.token, 20, 0)["items"]
        self.assertEqual(reloaded[0]["attachments"][0]["size"], 10)
        self.assertEqual(reloaded[-1]["attachment_context"], result["attachment_context"])
        second = self.start([ref], session=run["session_id"])
        self.work("claim_agent_run", (self.worker,))
        self.record(second, ref, "selected", chunk)
        self.record(second, ref, "submitted", chunk)
        chats.cancel(self.db, UUID(second["run_id"]), self.token)
        stopped = self.work("finish_agent_run", (second["run_id"], self.worker, answer, None))
        item = stopped["attachment_context"]["files"][0]
        self.assertEqual((item["delivery_state"], item["context_state"], item["cited_chunk_ids"]), ("unknown", "provided", []))

    def test_read_not_submitted_cannot_be_cited_or_associated_and_prepare_retry_is_exact(self):
        ref = self.file(owner="ivanov.ks")
        student = self.login("ivanov.ks")["Authorization"][7:]
        run = self.start([ref], token=student)
        self.work("claim_agent_run", (self.worker,))
        chunk = self.record(run, ref, "read")
        document = self.query("SELECT document_type_id FROM deanery.document_type ORDER BY document_type_id LIMIT 1")[0]["document_type_id"]
        command = {"version": 1, "kind": "record_change", "resource": "document_request", "operation": "create", "key": {},
                   "fields": {"document_type_id": document, "copies": 1, "purpose": "Проверка вложения"}}
        key = uuid4()
        args = (run["run_id"], self.worker, Jsonb(command), "Проверка доказательства", "Пользователь просит подготовить справку", key, None)
        with self.assertRaises(psycopg.Error) as error:
            self.work("prepare_run_proposal", (*args, Jsonb([chunk["chunk_id"]])))
        self.assertEqual(error.exception.sqlstate, "22023")
        self.record(run, ref, "submitted", chunk)
        self.record(run, ref, "acknowledged", chunk)
        proposal = self.work("prepare_run_proposal", (*args, Jsonb([chunk["chunk_id"]])))
        self.assertEqual(self.work("prepare_run_proposal", (*args, Jsonb([chunk["chunk_id"]])))["id"], proposal["id"])
        with self.assertRaises(psycopg.Error) as error:
            self.work("prepare_run_proposal", (*args, Jsonb([])))
        self.assertEqual(error.exception.sqlstate, "P6001")
        self.assertEqual(len(proposal["context_files"]), 1)
        event = self.query("SELECT data FROM agent_backend.proposal_event WHERE proposal_id=%s AND event_type='attachment_context'", (proposal["id"],))[0]["data"]
        self.assertNotIn('"text":', encode(event))
        self.assertEqual(event["chunks"][0]["text_hash"], chunk["text_hash"])

    def test_reassignment_revokes_original_history_and_inflight_publication_with_same_domain_scope(self):
        student = self.login("ivanov.ks")["Authorization"][7:]
        staff_headers = self.login("kuznetsova")
        staff = staff_headers["Authorization"][7:]
        ref, unrelated = self.file(owner="ivanov.ks"), self.file(owner="ivanov.ks")
        source = self.start([ref, unrelated], token=student)
        self.work("claim_agent_run", (self.worker,))
        chunk = self.record(source, ref, "selected")
        self.record(source, ref, "submitted", chunk)
        self.record(source, ref, "acknowledged", chunk)
        doc = self.query("SELECT document_type_id FROM deanery.document_type ORDER BY document_type_id LIMIT 1")[0]["document_type_id"]
        command = {"version": 1, "kind": "record_change", "resource": "document_request", "operation": "create", "key": {},
                   "fields": {"document_type_id": doc, "copies": 1, "purpose": "Проверка передачи источника"}}
        proposal = self.work("prepare_run_proposal", (source["run_id"], self.worker, Jsonb(command), "Справка с основанием",
                             "Явная просьба пользователя о выдаче справки", uuid4(), None, Jsonb([chunk["chunk_id"]])))
        self.work("finish_agent_run", (source["run_id"], self.worker, "Подготовлено", None))
        staff_id = self.query("SELECT user_id FROM deanery.app_user WHERE login='kuznetsova'")[0]["user_id"]
        director_id = self.query("SELECT user_id FROM deanery.app_user WHERE login='smirnov'")[0]["user_id"]
        def assign(to, version, proposal_id=None):
            return self.db.execute("SELECT backend_api.assign_proposal(%s,%s,%s,%s,%s,%s) AS p",
                (proposal_id or proposal["id"], to, "Передача для проверки документа", version, uuid4(), staff)).fetchone()["p"]
        assigned = assign(staff_id, proposal["version"])
        self.assertEqual(len(assigned["context_files"]), 1)
        with self.assertRaises(psycopg.Error), self.db.transaction():
            self.db.execute("SELECT backend_api.download_file(%s,%s,%s)", (unrelated["file_id"], unrelated["version_id"], staff))
        previous = self.start([ref], token=staff)
        self.work("claim_agent_run", (self.worker,))
        borrowed = self.record(previous, ref, "selected")
        self.record(previous, ref, "submitted", borrowed)
        self.record(previous, ref, "acknowledged", borrowed)
        student_id = self.query("SELECT s.student_id FROM deanery.student s JOIN deanery.app_user u ON u.person_id=s.person_id WHERE u.login='ivanov.ks'")[0]["student_id"]
        request_status_id = self.query("SELECT request_status_id FROM deanery.request_status ORDER BY request_status_id LIMIT 1")[0]["request_status_id"]
        copied_command = {**command, "fields": {**command["fields"], "student_id": student_id, "request_status_id": request_status_id,
                                               "purpose": "Повторное предложение по источнику"}}
        borrower_proposal = self.work("prepare_run_proposal", (previous["run_id"], self.worker, Jsonb(copied_command), "Связанная новая справка",
            "Явная просьба пользователя о повторной справке", uuid4(), None, Jsonb([borrowed["chunk_id"]])))
        assign(director_id, borrower_proposal["version"], borrower_proposal["id"])
        self.work("finish_agent_run", (previous["run_id"], self.worker, "Содержимое прежнего источника", None))
        followup = self.start(token=staff, session=previous["session_id"])
        self.work("claim_agent_run", (self.worker,))
        before = self.work("agent_run_context", (followup["run_id"], self.worker))
        self.assertTrue(any("Содержимое прежнего источника" in m["text"] for m in before["history"]))
        self.file(owner="kuznetsova")
        self.assertTrue(self.work("renew_agent_run", (followup["run_id"], self.worker)))
        scope = self.query("SELECT agent_backend.scope_signature(%s) AS s", (staff_id,))[0]["s"]
        assign(director_id, assigned["version"])
        still_visible_proposal = self.db.execute("SELECT backend_api.get_proposal(%s,%s) AS p", (borrower_proposal["id"], staff)).fetchone()["p"]
        self.assertEqual(still_visible_proposal["context_files"], [])
        self.assertEqual(scope, self.query("SELECT agent_backend.scope_signature(%s) AS s", (staff_id,))[0]["s"])
        with self.assertRaises(psycopg.Error) as denied, self.db.transaction():
            self.db.execute("SELECT backend_api.download_file(%s,%s,%s)", (ref["file_id"], ref["version_id"], staff))
        self.assertEqual(denied.exception.sqlstate, "P0002")
        with self.assertRaises(psycopg.Error) as denied:
            self.work("agent_run_context", (followup["run_id"], self.worker))
        self.assertEqual(denied.exception.sqlstate, "P8008")
        for run in (previous, followup):
            with self.assertRaises(psycopg.Error), self.db.transaction():
                chats.events(self.db, UUID(run["run_id"]), staff, 0)
        final = self.work("finish_agent_run", (followup["run_id"], self.worker, "Старые данные не публиковать", None))
        self.assertNotIn("Старые данные", final["answer"])
        messages = chats.messages(self.db, UUID(previous["session_id"]), staff, 20, 0)["items"]
        self.assertTrue(all("Сообщение скрыто" in m["text"] for m in messages))
        new = self.start(token=staff, session=previous["session_id"])
        self.work("claim_agent_run", (self.worker,))
        self.assertEqual(self.work("agent_run_context", (new["run_id"], self.worker))["history"], [])
