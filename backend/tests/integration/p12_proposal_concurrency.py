"""I147: real HTTP/independent-transaction races, with zero model calls."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import sys
from time import monotonic, sleep
import traceback
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from backend import proposals
from backend.tests.integration.p12_agent_parity import DATABASE, ROOT, Runtime, save


REASON = "Синтетическая конкурентная проверка P12"


def prepare(runtime, case):
    """Use the actual queue/lease/prepare boundary; no simulated model response."""
    login = "ivanov.ks"
    chat = runtime.call(login, "POST", "agent/sessions", {"title": "P12 concurrency " + case}, status=201)
    runtime.chats.append((login, chat["id"]))
    with runtime.clients[login].stream("POST", "/api/v1/agent/chat/stream",
            json={"session_id": chat["id"], "message": REASON + ": " + case, "attachments": []},
            headers={"Idempotency-Key": str(uuid4())}) as response:
        assert response.status_code == 200
        event = next(json.loads(line[5:]) for line in response.iter_lines() if line.startswith("data:"))
    run_id, worker = UUID(event["run_id"]), uuid4()
    runtime.runs.append((login, run_id, worker))
    with runtime.admin() as db:
        document_type = db.execute("SELECT document_type_id FROM deanery.document_type ORDER BY document_type_id LIMIT 1").fetchone()["document_type_id"]
    purpose = f"P12 concurrency {runtime.prefix.name} {case}"
    command = {"version": 1, "kind": "record_change", "resource": "document_request", "operation": "create",
               "key": {}, "fields": {"document_type_id": document_type, "copies": 1, "purpose": purpose}}
    with runtime.settings.connect() as db:
        claimed = db.execute("SELECT backend_api.claim_agent_run(%s) AS result", (worker,)).fetchone()["result"]
        assert UUID(claimed["run_id"]) == run_id
    with runtime.settings.connect() as db:
        proposal = proposals.prepare_for_run(db, run_id, worker, command, REASON, REASON, uuid4())
        db.execute("SELECT backend_api.finish_agent_run(%s,%s,%s,NULL)", (run_id, worker, REASON))
    assert proposal["routing"]["assignee_user_id"] is None and proposal["status"] == "pending"
    assert domain(runtime, purpose) == []
    return proposal, purpose


def domain(runtime, purpose):
    with runtime.admin() as db:
        return db.execute("SELECT request_id FROM deanery.document_request WHERE purpose=%s", (purpose,)).fetchall()


def post(runtime, login, proposal, action, body, key):
    response = runtime.clients[login].post(f"/api/v1/agent/proposals/{proposal['id']}/{action}",
        json=body, headers={"Idempotency-Key": str(key)}, timeout=20)
    return {"login": login, "action": action, "status": response.status_code, "body": response.json()}


def race(runtime, case, proposal, operations):
    """Hold the proposal row until both real API transactions demonstrably wait."""
    waiting, results = [], []
    with ThreadPoolExecutor(max_workers=2) as pool:
        with runtime.admin() as blocker:
            blocker.execute("SELECT id FROM agent_backend.proposal WHERE id=%s FOR UPDATE", (proposal["id"],)).fetchone()
            futures = [pool.submit(post, runtime, login, proposal, action, body, key)
                       for login, action, body, key in operations]
            deadline = monotonic() + 3
            with psycopg.connect(**runtime.info[0], autocommit=True, row_factory=dict_row) as observer:
                while monotonic() < deadline:
                    waiting = observer.execute("""SELECT pid,wait_event FROM pg_stat_activity
                        WHERE datname=%s AND usename=%s AND state='active' AND wait_event_type='Lock'
                          AND (query LIKE 'SELECT backend_api.assign_proposal(%%'
                               OR query LIKE 'SELECT backend_api.decide_proposal(%%')""",
                        (DATABASE, runtime.info[1]["user"])).fetchall()
                    if len(waiting) == 2:
                        break
                    sleep(0.025)
        # Commit the blocker before joining threads, including on failed overlap detection.
        results = [future.result(timeout=20) for future in futures]
    evidence = {"case": case, "waiting_transactions": waiting, "responses": results, "proposal_id": proposal["id"]}
    save(runtime.prefix.with_name(runtime.prefix.name + "-" + case + "-race.json"), evidence)
    assert len(waiting) == 2, "Did not prove two simultaneous database transactions; evidence retained"
    return results


def get(runtime, proposal):
    return runtime.call("vasilyeva", "GET", "agent/proposals/" + proposal["id"])


def assignment(runtime, login, proposal, target=None):
    return {"assignee_user_id": runtime.me(target or login)["user_id"], "reason": REASON,
            "expected_version": proposal["version"]}


def decision(proposal, approve=True):
    return {"approve": approve, "reason": REASON, "expected_version": proposal["version"]}


def check_effect(runtime, proposal, purpose, expected):
    current = get(runtime, proposal)
    rows = domain(runtime, purpose)
    with runtime.admin() as db:
        events = db.execute("SELECT event_type,actor_user_id,data FROM agent_backend.proposal_event WHERE proposal_id=%s ORDER BY id",
                            (proposal["id"],)).fetchall()
        logs = db.execute("""SELECT a.operation,a.app_user_id,a.agent_request_id FROM deanery.audit_log a
            JOIN agent_backend.proposal p ON p.agent_request_id=a.agent_request_id
            WHERE p.id=%s AND a.table_name='document_request'""", (proposal["id"],)).fetchall()
    assert len(rows) == len(logs) == expected
    if expected:
        assert current["status"] == "approved" and current["execution"]["status"] == "succeeded"
        assert current["execution"]["applied"]["request_id"] == rows[0]["request_id"]
        assert logs[0]["operation"] == "I" and logs[0]["app_user_id"] == current["routing"]["assignee_user_id"]
        assert logs[0]["agent_request_id"] is not None
    return {"proposal": current, "domain_rows": rows, "audit": logs, "events": events}


def cases(runtime):
    evidence = []
    p, purpose = prepare(runtime, "claim")
    results = race(runtime, "claim", p, [(login, "assignment", assignment(runtime, login, p), uuid4())
                                        for login in ("kuznetsova", "smirnov")])
    winner, = [r for r in results if r["status"] == 200]
    loser, = [r for r in results if r["status"] != 200]
    assert loser["status"] == (404 if loser["login"] == "kuznetsova" else 409)
    state = check_effect(runtime, p, purpose, 0)
    assert state["proposal"]["version"] == 2
    assert state["proposal"]["routing"]["assignee_user_id"] == runtime.me(winner["login"])["user_id"]
    assert [e["event_type"] for e in state["events"]] == ["created", "attachment_context", "claimed"]
    assert state["events"][1]["data"] == {"chunks": []}
    runtime.call(winner["login"], "POST", f"agent/proposals/{p['id']}/decision", decision(state["proposal"], False))
    evidence.append({"case": "claim", **state})

    p, purpose = prepare(runtime, "transfer_decide")
    p = runtime.call("kuznetsova", "POST", f"agent/proposals/{p['id']}/assignment", assignment(runtime, "kuznetsova", p))
    results = race(runtime, "transfer_decide", p, [
        ("kuznetsova", "assignment", assignment(runtime, "kuznetsova", p, "smirnov"), uuid4()),
        ("kuznetsova", "decision", decision(p), uuid4())])
    winner, = [r for r in results if r["status"] == 200]
    loser, = [r for r in results if r["status"] != 200]
    assert loser["status"] == (404 if winner["action"] == "assignment" else 409)
    state = check_effect(runtime, p, purpose, int(winner["action"] == "decision"))
    assert state["proposal"]["version"] == 3
    if winner["action"] == "assignment":
        runtime.call("kuznetsova", "POST", f"agent/proposals/{p['id']}/decision", decision(p), status=404)
        runtime.call("smirnov", "POST", f"agent/proposals/{p['id']}/decision", decision(state["proposal"]))
        check_effect(runtime, p, purpose, 1)
    evidence.append({"case": "transfer_decide", **state})

    for case in ("same_key", "same_intent", "opposite_decisions"):
        p, purpose = prepare(runtime, case)
        p = runtime.call("kuznetsova", "POST", f"agent/proposals/{p['id']}/assignment", assignment(runtime, "kuznetsova", p))
        key = uuid4()
        results = race(runtime, case, p, [
            ("kuznetsova", "decision", decision(p), key),
            ("kuznetsova", "decision", decision(p, case != "opposite_decisions"), key if case == "same_key" else uuid4())])
        if case == "opposite_decisions":
            assert sorted(r["status"] for r in results) == [200, 409]
            current = get(runtime, p)
            expected = int(current["status"] == "approved")
        else:
            assert [r["status"] for r in results] == [200, 200]
            assert results[0]["body"] == results[1]["body"]
            expected = 1
        state = check_effect(runtime, p, purpose, expected)
        assert state["proposal"]["version"] == 3
        assert sum(e["event_type"] in ("approved", "rejected") for e in state["events"]) == 1
        if case == "same_key":
            changed = post(runtime, "kuznetsova", p, "decision", {**decision(p), "reason": REASON + " изменено"}, key)
            assert changed["status"] == 409
            check_effect(runtime, p, purpose, 1)
        evidence.append({"case": case, **state})
    return evidence


def main():
    runtime, evidence, error = Runtime(), [], None
    try:
        runtime.start()
        evidence = cases(runtime)
        save(runtime.prefix.with_name(runtime.prefix.name + "-concurrency-cases.json"), evidence)
    except BaseException as exc:
        error = type(exc).__name__
        runtime.prefix.with_name(runtime.prefix.name + "-error.log").write_text(traceback.format_exc(), encoding="utf-8")
    finally:
        cleanup = runtime.close()
    summary = {"time": datetime.now(timezone.utc).isoformat(), "decision": "I147", "database": DATABASE,
               "phase": "proposal_concurrency", "passed_cases": len(evidence), "provider_calls": 0,
               "error_type": error, "cleanup": cleanup, "evidence_prefix": runtime.prefix.name}
    save(runtime.prefix.with_name(runtime.prefix.name + "-concurrency-summary.json"), summary)
    print(json.dumps(summary), flush=True)
    return 0 if error is None and len(evidence) == 5 and not cleanup["errors"] and cleanup["passwords_restored"] and \
        cleanup["owned_api_stopped"] and cleanup["active_auth_sessions"] == cleanup["active_auth_tokens"] == cleanup["queued_or_running_runs"] == 0 else 1


if __name__ == "__main__":
    assert ROOT == ROOT.cwd().resolve() and sys.argv[1:] == ["run"]
    sys.exit(main())
