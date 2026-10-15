"""I168: read-only controls for exact, actual-HTTP UI fixtures; no model calls."""

import json
import os
from pathlib import Path
import sys
from uuid import UUID, uuid4

ROOT = Path(__file__).resolve().parents[3]
DATABASE = "deanery_p12_ui_92004917"


def queue_fixture(db, action, payload, manifest, manifest_path, credentials):
    accounts = {account["role"]: account["user_id"] for account in credentials["accounts"]}
    if action == "queue-resume":
        assert manifest_path.name == "p12-browser-stage3-queue-50be4471-2116-4568-9c0b-635a415ff24a.json"
        correction_tail = os.environ.get("P12_STAGE3_QUEUE_CORRECTION_TAIL") == "1"
        assert manifest["queue_plan"]["accounts"] == accounts
        assert set(manifest["proposals"]) == ({"document", "correction"} if correction_tail else {"document"})
        saved = manifest["proposals"]["document"]
        assert saved["id"] == "36f75a75-b9bd-490f-9bbb-1a8f865dd839"
        p = db.execute("SELECT p.*,agent_backend.proposal_validity(p) AS live_validity FROM agent_backend.proposal p WHERE p.id=%s", (saved["id"],)).fetchone()
        assert p["initiator_user_id"] == accounts["student"] and p["command"] == saved["command"]
        transferred = os.environ.get("P12_STAGE3_QUEUE_TAIL") == "1"
        assert p["status"] == ("approved" if correction_tail else "pending") and p["live_validity"] == "current"
        assert p["version"] == (4 if correction_tail else 3 if transferred else 1)
        assert p["assignee_user_id"] == (accounts["director"] if transferred else None)
        if transferred and not correction_tail:
            events = db.execute("SELECT event_type,actor_user_id,data FROM agent_backend.proposal_event WHERE proposal_id=%s ORDER BY id", (p["id"],)).fetchall()
            assert [event["event_type"] for event in events] == ["created", "attachment_context", "claimed", "assigned"]
            assert events[1]["data"]["chunks"] == []
            assert all(event["actor_user_id"] == accounts["dean_staff"] for event in events[2:])
            assert events[-1]["data"]["to_user_id"] == accounts["director"]
        assert p["explanation"] == saved["explanation"]
        assert p["execution"]["status"] == ("succeeded" if correction_tail else "not_started")
        assert db.execute("SELECT role_code FROM backend_api.account_snapshot(%s) WHERE is_active", (p["initiator_user_id"],)).fetchone()["role_code"] == "student"
        run = db.execute("SELECT status,finished_at,tools_used FROM agent_backend.agent_run WHERE id=%s", (saved["run_id"],)).fetchone()
        assert run["status"] == "succeeded" and run["finished_at"] and run["tools_used"] == []
        assert db.execute("SELECT count(*) AS n FROM agent_backend.agent_run WHERE finished_at IS NULL").fetchone()["n"] == 0
        assert db.execute("SELECT count(*) AS n FROM deanery.document_request WHERE purpose=%s", (manifest["queue_plan"]["reason"],)).fetchone()["n"] == int(correction_tail)
        assert db.execute("SELECT count(*) AS n FROM deanery.audit_log WHERE agent_request_id=%s", (p["agent_request_id"],)).fetchone()["n"] == int(correction_tail)
        assert db.execute("SELECT count(*) AS n FROM agent_backend.auth_session WHERE revoked_at IS NULL AND NOT(id=ANY(%s::uuid[]))", (manifest["historical_sessions"],)).fetchone()["n"] == 0
        correction = None
        if correction_tail:
            assert transferred
            queue_fixture(db, "queue-check", {"case": "document"}, manifest, manifest_path, credentials)
            queue_fixture(db, "queue-check", {"case": "correction", "expect": "correction-submitted"}, manifest, manifest_path, credentials)
            cs = manifest["proposals"]["correction"]
            cp = db.execute("SELECT p.*,agent_backend.proposal_validity(p) AS live_validity FROM agent_backend.proposal p WHERE id=%s", (cs["id"],)).fetchone()
            assert cp["id"] == UUID('e5e8d174-ea86-4788-b711-f4bbebe4118f') and cp["version"] == 2 and cp["assignee_user_id"] is None
            assert cp["initiator_user_id"] == accounts["teacher"] and cp["command"] == cs["command"] and cp["live_validity"] == "current"
            correction = {"id": cs["id"], "version": cp["version"], "explanation": cp["explanation"]}
            staff = db.execute("SELECT e.employee_id FROM deanery.employee e JOIN deanery.app_user u USING(person_id) WHERE u.user_id=%s", (accounts["dean_staff"],)).fetchone()
            assert db.execute("SELECT deanery.fn_manages_institute(%s,%s) AS manages", (staff["employee_id"], cp["institute_id"])).fetchone()["manages"]
        return {"inventory": {"database": DATABASE, "head": "0039_scope_check_latency", "historical_sessions": 5, "nonterminal_runs": 0},
                "reason": manifest["queue_plan"]["reason"], "director": accounts["director"], "transferred": transferred,
                "submitted_correction": correction,
                "document": {"id": saved["id"], "version": p["version"], "explanation": p["explanation"], "resumed": True}}
    if action == "queue-plan":
        assert "queue_plan" not in manifest, "Do not prepare this packet twice"
        document_type = db.execute("SELECT document_type_id FROM deanery.document_type ORDER BY document_type_id LIMIT 1").fetchone()["document_type_id"]
        teacher = db.execute("SELECT teacher_id FROM backend_api.account_snapshot(%s)", (accounts["teacher"],)).fetchone()["teacher_id"]
        director = db.execute("SELECT employee_id FROM deanery.employee e JOIN deanery.app_user u USING(person_id) WHERE u.user_id=%s AND dismissal_date IS NULL", (accounts["director"],)).fetchone()["employee_id"]
        grade = db.execute("""SELECT g.grade_id,g.points,g.is_absent,gs.sheet_number,s.record_book_number,
            (SELECT max(max_points) FROM deanery.score_band) AS max_points
            FROM deanery.grade g JOIN deanery.grade_sheet gs USING(sheet_id) JOIN deanery.student s USING(student_id)
            WHERE gs.status='closed' AND gs.examiner_id=%s AND gs.exam_date IS NOT NULL
              AND deanery.fn_manages_institute(%s,deanery.fn_group_institute(gs.group_id))
              AND NOT EXISTS(SELECT FROM deanery.grade_correction gc WHERE gc.grade_id=g.grade_id AND gc.status IN ('pending','approved'))
              AND NOT EXISTS(SELECT FROM deanery.grade g2 JOIN deanery.grade_sheet gs2 USING(sheet_id)
                WHERE g2.student_id=g.student_id AND gs2.item_id=gs.item_id AND gs2.stage=gs.stage AND gs2.status<>'cancelled'
                  AND (COALESCE(gs2.exam_date,DATE 'infinity'),gs2.sheet_id)>(gs.exam_date,gs.sheet_id))
            ORDER BY g.grade_id LIMIT 1""", (teacher, director)).fetchone()
        assert grade, "No legitimate own closed grade fixture; ask root rather than creating or bypassing one"
        reason = "Синтетическая проверка очереди P12 " + str(payload["packet"])
        points = grade["max_points"] if grade["points"] != grade["max_points"] else grade["max_points"] - 1
        manifest["queue_plan"] = {"reason": reason, "accounts": accounts, "grade": grade,
            "commands": {"document": {"version": 1, "kind": "record_change", "resource": "document_request", "operation": "create", "key": {},
                "fields": {"document_type_id": document_type, "copies": 1, "purpose": reason}},
                "correction": {"version": 1, "kind": "grade_correction", "fields": {"sheet_number": grade["sheet_number"],
                    "record_book": grade["record_book_number"], "new_points": points, "new_is_absent": False, "reason": reason}}}}
        manifest["proposals"] = {}
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        # This output is consumed in process memory by the browser harness, never copied to public evidence.
        return {"document_actor": accounts["student"], "correction_actor": accounts["teacher"], "director": accounts["director"], "reason": reason}

    assert "queue_plan" in manifest
    case = payload["case"]
    assert case in {"document", "correction"}
    if action == "queue-prepare":
        assert case not in manifest["proposals"], "Do not replay a committed fixture"
        from psycopg.rows import dict_row
        from psycopg.types.json import Jsonb
        import psycopg

        run_id = UUID(payload["run_id"])
        assert str(run_id) in manifest["runs"]
        author = accounts["student" if case == "document" else "teacher"]
        rows = db.execute("SELECT id,initiator_user_id FROM agent_backend.agent_run WHERE finished_at IS NULL").fetchall()
        assert rows == [{"id": run_id, "initiator_user_id": author}], "Claim only this exact run in an otherwise idle owned clone"
        agent_parameters = json.loads((ROOT / ".local/p12-ui-agent.json").read_text(encoding="utf-8"))
        assert agent_parameters["dbname"] == DATABASE
        worker = uuid4()
        with psycopg.connect(**agent_parameters, row_factory=dict_row, connect_timeout=5) as executor:
            executor.execute("SET LOCAL ROLE backend_executor")
            executor.execute("SET LOCAL search_path=pg_catalog")
            executor.execute("SET LOCAL statement_timeout='5s'")
            executor.execute("SET LOCAL lock_timeout='5s'")
            executor.execute("SET LOCAL TIME ZONE 'Europe/Moscow'")
            claimed = executor.execute("SELECT backend_api.claim_agent_run(%s) AS result", (worker,)).fetchone()["result"]
            assert claimed and UUID(claimed["run_id"]) == run_id
            command, reason = manifest["queue_plan"]["commands"][case], manifest["queue_plan"]["reason"]
            explanation = reason + ": " + case + " (controlled RPC fixture, no model)"
            proposal = executor.execute("SELECT backend_api.prepare_run_proposal(%s,%s,%s,%s,%s,%s,NULL) AS result",
                (run_id, worker, Jsonb(command), explanation, reason, uuid4())).fetchone()["result"]
            executor.execute("SELECT backend_api.finish_agent_run(%s,%s,%s,NULL)",
                             (run_id, worker, "Контролируемая проверка интерфейса: предложение подготовлено через защищённый RPC; модель не вызывалась."))
        saved = db.execute("SELECT id,command FROM agent_backend.proposal WHERE id=%s", (proposal["id"],)).fetchone()
        manifest["proposals"][case] = {"id": str(saved["id"]), "run_id": str(run_id), "command": saved["command"], "explanation": explanation}
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        assert proposal["status"] == "pending" and not proposal["context_files"] and proposal["routing"]["assignee_user_id"] is None
        return {"id": proposal["id"], "version": proposal["version"], "explanation": explanation, "context_files": 0, "provider_calls": 0}

    saved = manifest["proposals"][case]
    proposal = db.execute("SELECT * FROM agent_backend.proposal WHERE id=%s", (saved["id"],)).fetchone()
    run = db.execute("SELECT * FROM agent_backend.agent_run WHERE id=%s", (saved["run_id"],)).fetchone()
    assert run["finished_at"] and run["tools_used"] == [] and proposal["command"] == saved["command"]
    events = db.execute("SELECT event_type,data FROM agent_backend.proposal_event WHERE proposal_id=%s ORDER BY id", (saved["id"],)).fetchall()
    assert sum(row["event_type"] == "created" for row in events) == 1
    context, = [row for row in events if row["event_type"] == "attachment_context"]
    assert context["data"] == {"chunks": []}
    if payload.get("expect") in {"document-pending", "correction-draft", "correction-submitted"}:
        assert proposal["status"] == "pending"
        if case == "document":
            assert payload["expect"] == "document-pending"
            assert db.execute("SELECT count(*) AS n FROM deanery.document_request WHERE purpose=%s", (manifest["queue_plan"]["reason"],)).fetchone()["n"] == 0
            assert db.execute("SELECT count(*) AS n FROM deanery.audit_log WHERE table_name='document_request' AND agent_request_id=%s", (proposal["agent_request_id"],)).fetchone()["n"] == 0
            return {"proposal_id": saved["id"], "status": "pending", "domain_inserts": 0, "official_audits": 0}
        grade = manifest["queue_plan"]["grade"]
        assert db.execute("SELECT points,is_absent FROM deanery.grade WHERE grade_id=%s", (grade["grade_id"],)).fetchone() == {"points": grade["points"], "is_absent": grade["is_absent"]}
        if payload["expect"] == "correction-draft":
            assert proposal["submission_status"] == "draft" and proposal["correction_id"] is None
            return {"proposal_id": saved["id"], "submission": "draft", "grade_unchanged": True, "correction_created": False}
        assert proposal["submission_status"] == "submitted" and proposal["correction_id"]
        assert db.execute("SELECT status FROM deanery.grade_correction WHERE correction_id=%s", (proposal["correction_id"],)).fetchone()["status"] == "pending"
        return {"proposal_id": saved["id"], "submission": "submitted", "grade_unchanged": True, "correction_created": True}
    if case == "document":
        assert proposal["status"] == "approved" and proposal["execution"]["status"] == "succeeded"
        assert proposal["assignee_user_id"] == proposal["decided_by"] == accounts["director"]
        requests = db.execute("SELECT request_id FROM deanery.document_request WHERE purpose=%s", (manifest["queue_plan"]["reason"],)).fetchall()
        assert len(requests) == 1 and proposal["execution"]["applied"]["request_id"] == requests[0]["request_id"]
        audits = db.execute("SELECT operation,app_user_id FROM deanery.audit_log WHERE table_name='document_request' AND agent_request_id=%s", (proposal["agent_request_id"],)).fetchall()
        assert audits == [{"operation": "I", "app_user_id": accounts["director"]}]
        assert sum(row["event_type"] == "approved" for row in events) == 1
        return {"proposal_id": saved["id"], "status": "approved", "execution": "succeeded", "domain_inserts": 1, "official_audits": 1, "provider_calls": 0}
    grade = manifest["queue_plan"]["grade"]
    actual_grade = db.execute("SELECT points,is_absent FROM deanery.grade WHERE grade_id=%s", (grade["grade_id"],)).fetchone()
    assert actual_grade == {"points": grade["points"], "is_absent": grade["is_absent"]}
    assert proposal["status"] == "rejected" and proposal["submission_status"] == "submitted" and proposal["correction_id"]
    correction = db.execute("SELECT status,requested_by_id,decided_by_id FROM deanery.grade_correction WHERE correction_id=%s", (proposal["correction_id"],)).fetchone()
    assert correction == {"status": "rejected", "requested_by_id": accounts["teacher"], "decided_by_id": accounts["director"]}
    assert sum(row["event_type"] == "submitted" for row in events) == sum(row["event_type"] == "rejected" for row in events) == 1
    assert db.execute("SELECT count(*) AS n FROM deanery.audit_log WHERE table_name='grade' AND agent_request_id=%s", (proposal["agent_request_id"],)).fetchone()["n"] == 0
    return {"proposal_id": saved["id"], "correction_id": proposal["correction_id"], "submission": "submitted", "status": "rejected", "grade_unchanged": True, "provider_calls": 0}


def main():
    # Source/syntax checks never connect. Runtime requires the root resource handoff.
    assert os.environ.get("P12_STAGE3_RESOURCE_GO") == "1", "Stage3 runtime waits for root resource GO"
    assert len(sys.argv) == 2 and sys.argv[1] in {"encoding-check", "inventory", "chat", "terminal", "deleted", "cleanup", "continuation", "queue-plan", "queue-prepare", "queue-check", "queue-resume"}
    # One explicit boundary for every stage3 Node subprocess on Windows.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1] == "encoding-check":
        payload = json.load(sys.stdin)
        assert payload["probe"] == "Яё — проверка обмена Ω"
        print(json.dumps({"probe": payload["probe"], "database_access": False}, ensure_ascii=False))
        return
    import psycopg
    from psycopg.rows import dict_row

    payload = json.load(sys.stdin)
    manifest_path = Path(payload["manifest"]).resolve()
    assert manifest_path.parent == ROOT / ".local" and manifest_path.name.startswith("p12-browser-stage3-")
    parameters = json.loads((ROOT / ".local/p12-ui-connection.json").read_text(encoding="utf-8"))
    credentials = json.loads((ROOT / ".local/p12-browser-credentials.json").read_text(encoding="utf-8"))
    assert parameters["dbname"] == credentials["database"] == DATABASE
    with psycopg.connect(**parameters, row_factory=dict_row, connect_timeout=5) as db:
        db.execute("SET TRANSACTION READ ONLY")
        db.execute("SET LOCAL statement_timeout='5s'")
        db.execute("SET LOCAL lock_timeout='5s'")
        db.execute("SET LOCAL search_path=pg_catalog,deanery")
        db.execute("SET LOCAL TIME ZONE 'Europe/Moscow'")
        actual = db.execute("SELECT current_database() AS name,version_num FROM public.alembic_version").fetchone()
        assert actual == {"name": DATABASE, "version_num": "0039_scope_check_latency"}
        if sys.argv[1] == "inventory":
            assert not manifest_path.exists(), "Do not reuse or overwrite a previous fixture"
            assert db.execute("SELECT count(*) AS n FROM agent_backend.agent_run WHERE finished_at IS NULL").fetchone()["n"] == 0
            sessions = db.execute("SELECT id,revoked_at FROM agent_backend.auth_session WHERE revoked_at IS NULL ORDER BY id").fetchall()
            assert len(sessions) == 5, "Historical-session inventory changed: inspect before proceeding"
            manifest = {"database": DATABASE, "historical_sessions": [str(row["id"]) for row in sessions],
                        "chats": [], "runs": [], "provider_calls": 0}
            manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            print(json.dumps({"database": DATABASE, "head": actual["version_num"], "historical_sessions": 5, "nonterminal_runs": 0}))
            return

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert manifest["database"] == DATABASE and manifest["provider_calls"] == 0
        historical = db.execute("SELECT id,revoked_at FROM agent_backend.auth_session WHERE id=ANY(%s) ORDER BY id",
                                ([UUID(item) for item in manifest["historical_sessions"]],)).fetchall()
        assert len(historical) == 5 and all(row["revoked_at"] is None for row in historical)
        if sys.argv[1].startswith("queue-"):
            print(json.dumps(queue_fixture(db, sys.argv[1], payload, manifest, manifest_path, credentials), ensure_ascii=False, default=str))
            return
        actor = next(account["user_id"] for account in credentials["accounts"] if account["role"] == "admin")
        if sys.argv[1] == "continuation":
            assert len(manifest["chats"]) == len(manifest["runs"]) == 1
            assert db.execute("SELECT count(*) AS n FROM agent_backend.agent_run WHERE finished_at IS NULL").fetchone()["n"] == 0
            chat = db.execute("SELECT id,title,user_id FROM agent_backend.chat_session WHERE id=%s", (manifest["chats"][0],)).fetchone()
            run = db.execute("SELECT id,session_id,status,agent_request_id FROM agent_backend.agent_run WHERE id=%s", (manifest["runs"][0],)).fetchone()
            assert chat["user_id"] == actor and run["session_id"] == chat["id"] and run["status"] == "cancelled"
            request = db.execute("SELECT request_text FROM deanery.agent_request WHERE agent_request_id=%s", (run["agent_request_id"],)).fetchone()["request_text"]
            create, = db.execute("SELECT key FROM agent_backend.idempotency_record WHERE user_id=%s AND route='/agent/sessions' AND session_id=%s", (actor, chat["id"])).fetchall()
            send, = db.execute("SELECT key FROM agent_backend.idempotency_record WHERE user_id=%s AND route='/agent/chat/stream' AND run_id=%s", (actor, run["id"])).fetchall()
            print(json.dumps({"chat_id": str(chat["id"]), "title": chat["title"], "run_id": str(run["id"]), "message": request,
                              "create_key": str(create["key"]), "key": str(send["key"])}))
            return
        if sys.argv[1] == "cleanup":
            own_chats = [UUID(item) for item in manifest["chats"]]
            own_runs = [UUID(item) for item in manifest["runs"]]
            assert db.execute("SELECT count(*) AS n FROM agent_backend.chat_session WHERE id=ANY(%s)", (own_chats,)).fetchone()["n"] == 0
            assert db.execute("SELECT count(*) AS n FROM agent_backend.agent_run WHERE id=ANY(%s) AND finished_at IS NULL", (own_runs,)).fetchone()["n"] == 0
            assert db.execute("SELECT count(*) AS n FROM agent_backend.agent_run WHERE finished_at IS NULL").fetchone()["n"] == 0
            extra = db.execute("SELECT count(*) AS n FROM agent_backend.auth_session WHERE revoked_at IS NULL AND NOT(id=ANY(%s))",
                               ([UUID(item) for item in manifest["historical_sessions"]],)).fetchone()["n"]
            assert extra == 0, "Only this packet's sessions may be logged out; retain historical sessions"
            print(json.dumps({"own_chats": 0, "own_nonterminal_runs": 0, "own_unrevoked_sessions": 0, "historical_sessions_preserved": 5}))
            return

        chat_id, run_id, key = UUID(payload["chat_id"]), UUID(payload["run_id"]), UUID(payload["key"])
        assert str(chat_id) in manifest["chats"] and str(run_id) in manifest["runs"]
        run = db.execute("SELECT * FROM agent_backend.agent_run WHERE id=%s", (run_id,)).fetchone()
        assert run and run["initiator_user_id"] == actor and run["tools_used"] == []
        request = db.execute("SELECT request_text,response_text FROM deanery.agent_request WHERE agent_request_id=%s", (run["agent_request_id"],)).fetchone()
        replay = db.execute("SELECT * FROM agent_backend.idempotency_record WHERE user_id=%s AND route='/agent/chat/stream' AND key=%s", (actor, key)).fetchone()
        assert replay and replay["run_id"] == run_id
        assert db.execute("SELECT count(*) AS n FROM deanery.audit_log WHERE agent_request_id=%s", (run["agent_request_id"],)).fetchone()["n"] == 0
        assert db.execute("SELECT count(*) AS n FROM agent_backend.proposal WHERE run_id=%s", (run_id,)).fetchone()["n"] == 0
        if sys.argv[1] == "terminal":
            assert run["session_id"] == chat_id and run["status"] == "cancelled" and run["finished_at"]
            assert len(run["events"]) == 2 and run["events"][-1]["event"] == "error" and run["result"]
            assert request["request_text"] == payload["message"]
            messages = db.execute("SELECT role,text FROM agent_backend.chat_message WHERE session_id=%s AND metadata->>'run_id'=%s ORDER BY sequence",
                                  (chat_id, str(run_id))).fetchall()
            assert len(messages) == 2 and messages[0] == {"role": "user", "text": payload["message"]} and messages[1]["role"] == "error"
            print(json.dumps({"run_id": str(run_id), "status": "cancelled", "events": 2, "canonical_messages": 2, "proposals": 0, "official_audits": 0}))
        elif sys.argv[1] == "chat":
            assert run["session_id"] == chat_id and run["status"] == "queued" and run["finished_at"] is None
            assert request["request_text"] == payload["message"] and request["response_text"] is None
            messages = db.execute("SELECT role,text FROM agent_backend.chat_message WHERE session_id=%s ORDER BY sequence", (chat_id,)).fetchall()
            assert messages == [{"role": "user", "text": payload["message"]}]
            assert len(run["events"]) == 1 and run["events"][0]["event"] == "session"
            print(json.dumps({"chat_id": str(chat_id), "run_id": str(run_id), "user_messages": 1, "runs": 1, "events": 1,
                              "state": "queued", "domain_effects": 0, "provider_calls": 0}))
        else:
            assert db.execute("SELECT count(*) AS n FROM agent_backend.chat_session WHERE id=%s", (chat_id,)).fetchone()["n"] == 0
            assert db.execute("SELECT count(*) AS n FROM agent_backend.chat_message WHERE session_id=%s", (chat_id,)).fetchone()["n"] == 0
            assert run["session_id"] is None and run["finished_at"] and run["status"] == "cancelled"
            assert run["events"] == [] and run["result"] is None and run["conversation_deleted_at"]
            assert request == {"request_text": "Переписка удалена", "response_text": None}
            records = db.execute("SELECT response_body,response_removed_at FROM agent_backend.idempotency_record WHERE run_id=%s", (run_id,)).fetchall()
            assert records and all(row["response_body"] is None and row["response_removed_at"] for row in records)
            assert replay["session_id"] is None
            created = db.execute("SELECT session_id,response_body,response_removed_at FROM agent_backend.idempotency_record WHERE user_id=%s AND route='/agent/sessions' AND key=%s",
                                 (actor, UUID(payload["create_key"]))).fetchone()
            assert created and created["session_id"] is None and created["response_body"] is None and created["response_removed_at"]
            print(json.dumps({"chat_id": str(chat_id), "run_id": str(run_id), "messages": 0, "events": 0, "response_copies": 0,
                              "retained_run": True, "request_redacted": True, "provider_calls": 0}))


if __name__ == "__main__":
    main()
