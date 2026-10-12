"""I152: actual private-CA HTTPS, durable SSE and an owned API restart, no model."""

from datetime import datetime, timezone
import json
from pathlib import Path
import secrets
import ssl
import subprocess
import sys
from time import monotonic, sleep
import traceback
from uuid import UUID, uuid4

import httpx


ROOT = Path(__file__).resolve().parents[3]
LOCAL = ROOT / ".local"
ORIGIN = "https://localhost:8443"
COMPOSE = ["docker", "compose", "-p", "deanery-p13", "--env-file", str(LOCAL / "p13-deploy-compose.env"),
           "-f", "compose.files.yaml", "-f", "compose.knowledge.yaml", "-f", "compose.yaml"]


def command(arguments):
    completed = subprocess.run(arguments, cwd=ROOT, capture_output=True, timeout=90)
    assert completed.returncode == 0, "Owned Docker operation failed; no credentials or command output printed"
    return completed.stdout.decode("utf-8").strip()


def container(service):
    value = command([*COMPOSE, "ps", "-q", service])
    assert len(value) == 64 and all(c in "0123456789abcdef" for c in value)
    labels = json.loads(command(["docker", "inspect", "--format", "{{json .Config.Labels}}", value]))
    assert labels["com.docker.compose.project"] == "deanery-p13"
    assert labels["com.docker.compose.service"] == service
    return value


def state(db_id, run_id):
    run = str(UUID(run_id))
    query = f"""SELECT json_build_object(
        'status',r.status,'events',jsonb_array_length(r.events),'session_cleared',r.session_id IS NULL,
        'result_cleared',r.result IS NULL,'request_cleared',q.request_text='Переписка удалена' AND q.response_text IS NULL,
        'idempotency_cleared',NOT EXISTS(SELECT 1 FROM agent_backend.idempotency_record i
            WHERE i.run_id=r.id AND i.response_body IS NOT NULL),
        'request_count',(SELECT count(*) FROM deanery.agent_request WHERE agent_request_id=r.agent_request_id))
        FROM agent_backend.agent_run r JOIN deanery.agent_request q USING(agent_request_id) WHERE r.id='{run}'::uuid"""
    return json.loads(command(["docker", "exec", db_id, "psql", "-X", "-U", "postgres", "-d", "deanery_p13",
                               "-v", "ON_ERROR_STOP=1", "-At", "-c", query]))


def request(client, method, path, body=None, status=200, key=None, headers=None):
    extra = {"Idempotency-Key": str(key)} if key is not None else {}
    response = client.request(method, "/api/v1/" + path, json=body, headers={**extra, **(headers or {})})
    assert response.status_code == status, f"Unexpected HTTP status {response.status_code}, expected {status}"
    assert UUID(response.headers["x-request-id"])
    return response.json() if response.content else None


def frames(response):
    current = {}
    for line in response.iter_lines():
        if not line:
            if current:
                yield current
                current = {}
        elif line.startswith(":"):
            yield {"heartbeat": True}
        elif line.startswith("id: "):
            current["id"] = int(line[4:])
        elif line.startswith("event: "):
            current["event"] = line[7:]
        elif line.startswith("data: "):
            current["data"] = json.loads(line[6:])


def main():
    prefix = LOCAL / ("p13-https-" + secrets.token_hex(4))
    clients, chats, runs, checks, cleanup_errors = [], [], [], {}, []
    error = None
    try:
        api_id, db_id = container("api"), container("db")
        assert not command([*COMPOSE, "--profile", "agent-start", "ps", "--status", "running", "-q", "agent-worker"])
        certificates = ssl.create_default_context(cafile=str(LOCAL / "p13-deploy-tls/cert.pem"))
        accounts = json.loads((LOCAL / "p13-deploy-secrets/acceptance-logins.json").read_text(encoding="utf-8"))
        assert {a["role"] for a in accounts} == {"admin", "dean_staff", "student"}

        def login(account):
            client = httpx.Client(base_url=ORIGIN, verify=certificates, timeout=25, trust_env=False,
                                  headers={"Origin": ORIGIN})
            clients.append(client)
            result = client.post("/api/v1/auth/login", json={k: account[k] for k in ("login", "password")})
            assert result.status_code == 200
            cookie = result.headers["set-cookie"].lower()
            assert "; secure" in cookie and "; httponly" in cookie and "samesite=lax" in cookie and "path=/api/v1/auth" in cookie
            data = result.json()
            client.headers["Authorization"] = "Bearer " + data["access_token"]
            assert request(client, "GET", "auth/me")["roles"] == [account["role"]]
            return client, data["csrf_token"]

        by_role = {account["role"]: login(account) for account in accounts}
        staff, csrf = by_role["dean_staff"]
        second, _ = login(next(a for a in accounts if a["role"] == "dean_staff"))
        student = by_role["student"][0]
        assert staff.get("/").status_code == 200
        assert request(staff, "GET", "health/ready")["status"] == "ready"
        request(staff, "POST", "auth/refresh", status=403)
        request(staff, "POST", "auth/refresh", status=403, headers={"X-CSRF-Token": "wrong"})
        renewed = request(staff, "POST", "auth/refresh", headers={"X-CSRF-Token": csrf})
        staff.headers["Authorization"] = "Bearer " + renewed["access_token"]
        request(staff, "POST", "agent/sessions", {"title": "Forbidden origin"}, status=403, key=uuid4(),
                headers={"Origin": "https://foreign.invalid"})
        capabilities = request(staff, "GET", "agent/capabilities")
        assert capabilities["services"]["calibration"] == "uncalibrated"
        assert capabilities["services"]["agent_worker"] == "unavailable"
        checks["https_cookies_csrf_roles"] = True
        checks["forms_ready_with_stopped_uncalibrated_agent"] = True

        chat = request(staff, "POST", "agent/sessions", {"title": "P13 HTTPS recovery"}, status=201, key=uuid4())
        chat_id = chat["id"]
        chats.append((staff, chat_id))
        path = "agent/sessions/" + chat_id
        assert request(second, "GET", path)["title"] == chat["title"]
        request(student, "GET", path, status=404)
        request(staff, "PATCH", path, {"title": "First device"})
        request(second, "PATCH", path, {"title": "Последнее сохранённое название"})
        assert request(staff, "GET", path)["title"] == "Последнее сохранённое название"
        assert chat_id in {item["id"] for item in request(second, "GET", "agent/sessions")["items"]}

        body = {"session_id": chat_id, "message": "Синтетическая проверка HTTPS и восстановления событий P13", "attachments": []}
        key, began = uuid4(), monotonic()
        with staff.stream("POST", "/api/v1/agent/chat/stream", json=body, headers={"Idempotency-Key": str(key)}) as response:
            assert response.status_code == 200 and response.headers["content-type"].startswith("text/event-stream")
            iterator = frames(response)
            first = next(iterator)
            assert first["id"] == 1 and first["event"] == "session"
            run_id = str(UUID(first["data"]["run_id"]))
            runs.append((staff, run_id))
            first_latency = monotonic() - began
            assert first_latency < 10, "SSE first frame was buffered"
            heartbeat = next(iterator)
            assert heartbeat == {"heartbeat": True}
            heartbeat_latency = monotonic() - began
            assert 10 <= heartbeat_latency < 23
        assert state(db_id, run_id)["status"] == "queued", "Disconnect must not cancel the run"
        assert len(request(second, "GET", path + "/messages")["items"]) == 1
        request(staff, "DELETE", path, status=409)
        request(staff, "POST", "agent/chat/stream", {**body, "message": "Другое тело"}, key=key, status=409)
        request(staff, "POST", "agent/chat/stream", body, key=uuid4(), status=409)
        with second.stream("POST", "/api/v1/agent/chat/stream", json=body, headers={"Idempotency-Key": str(key)}) as response:
            assert response.status_code == 200 and next(frames(response)) == first
        request(student, "GET", "agent/runs/" + run_id + "/events", status=404)

        started_before = command(["docker", "inspect", "--format", "{{.State.StartedAt}}", api_id])
        command([*COMPOSE, "restart", "api"])
        deadline = monotonic() + 30
        while monotonic() < deadline:
            try:
                if staff.get("/api/v1/health/ready").status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            sleep(0.2)
        else:
            raise AssertionError("Owned API did not become ready after restart")
        assert container("api") == api_id
        assert command(["docker", "inspect", "--format", "{{.State.StartedAt}}", api_id]) != started_before
        with staff.stream("GET", "/api/v1/agent/runs/" + run_id + "/events?after=0") as response:
            assert response.status_code == 200 and next(frames(response)) == first
        assert state(db_id, run_id)["status"] == "queued"
        assert len(request(second, "GET", path + "/messages")["items"]) == 1
        stopped = request(second, "POST", "agent/runs/" + run_id + "/cancel", {}, status=202)
        assert stopped["stop_requested"]
        terminal = staff.get("/api/v1/agent/runs/" + run_id + "/events?after=1")
        assert terminal.status_code == 200
        final = list(frames(terminal))
        assert len(final) == 1 and final[0]["id"] == 2 and final[0]["data"]["type"] == "agent_cancelled"
        request(staff, "POST", "agent/runs/" + run_id + "/cancel", {})
        request(staff, "DELETE", path, status=204)
        request(second, "GET", path, status=404)
        request(staff, "GET", "agent/runs/" + run_id + "/events", status=404)
        redacted = state(db_id, run_id)
        assert redacted["events"] == 0 and redacted["request_count"] == 1
        assert all(redacted[name] for name in ("session_cleared", "result_cleared", "request_cleared", "idempotency_cleared"))
        chats.clear()
        runs.clear()
        checks.update(server_chat_sync=True, durable_sse_restart=True, physical_delete_redacts_copies=True,
                      first_event_seconds=round(first_latency, 3), heartbeat_seconds=round(heartbeat_latency, 3))
    except BaseException as exc:
        error = type(exc).__name__
        prefix.with_suffix(".error.log").write_text(traceback.format_exc(), encoding="utf-8")
    finally:
        for client, run_id in runs:
            try:
                response = client.post("/api/v1/agent/runs/" + run_id + "/cancel", json={})
                assert response.status_code in (200, 202)
            except Exception as exc:
                cleanup_errors.append({"phase": "stop", "type": type(exc).__name__})
        for client, chat_id in chats:
            try:
                assert client.delete("/api/v1/agent/sessions/" + chat_id).status_code in (204, 404)
            except Exception as exc:
                cleanup_errors.append({"phase": "delete", "type": type(exc).__name__})
        for client in clients:
            try:
                if "Authorization" in client.headers:
                    assert client.post("/api/v1/auth/logout").status_code == 204
                    assert client.get("/api/v1/auth/me").status_code == 401
            except Exception as exc:
                cleanup_errors.append({"phase": "logout", "type": type(exc).__name__})
            client.close()
    summary = {"at": datetime.now(timezone.utc).isoformat(), "decision": "I152", "checks": checks,
               "error_type": error, "cleanup_errors": cleanup_errors, "provider_calls": 0,
               "evidence_prefix": prefix.name, "tls": "explicit private test CA; system trust unchanged"}
    with prefix.with_suffix(".json").open("x", encoding="utf-8") as output:
        json.dump(summary, output, ensure_ascii=False, indent=2)
    print(json.dumps(summary), flush=True)
    return int(error is not None or bool(cleanup_errors))


if __name__ == "__main__":
    assert ROOT == ROOT.cwd().resolve() and sys.argv[1:] == ["run"]
    sys.exit(main())
