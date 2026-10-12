"""Affected live HTTP/read-scope check and offline real-graph static fingerprint."""
import json
from hashlib import sha256
from pathlib import Path
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
import httpx
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from langsmith import tracing_context
import psycopg
from psycopg.rows import dict_row

from backend import resources
from backend.agent_attachments import static_fingerprint
from backend.agent_config import AgentSettings
from backend.agent_runtime import create_agent_graph
from backend.agent_tools import build_tools

PRIVATE = ROOT / ".local"
SNAPSHOT = PRIVATE / "p12-ui-static-before.json"


def static_identity():
    settings = AgentSettings(_env_file=None)
    captured = []

    def reply(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "offline-static-check", "object": "chat.completion", "created": 1, "model": settings.model, "choices": [{"index": 0, "message": {"role": "assistant", "content": "Проверка."}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})

    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        model = ChatOpenAI(model=settings.model, api_key="offline", base_url=settings.base_url, temperature=0, use_responses_api=False, max_retries=0, timeout=settings.provider_timeout, max_tokens=settings.max_tokens, http_client=client, http_socket_options=())
        tools = build_tools(None, uuid4(), uuid4(), None, None)
        graph = create_agent_graph(model, tools)
        with tracing_context(enabled=False):
            graph.invoke({"messages": [HumanMessage(content="Проверка статической схемы.")]}, config={"recursion_limit":30,"max_concurrency":1})
    assert len(captured) == 1 and len(captured[0]["tools"]) == 13
    fingerprint = static_fingerprint(captured[0], settings.context_window, settings.base_url)
    assert fingerprint == settings.prompt_fingerprint
    registry = sha256(json.dumps(resources.AGENT_RESOURCES, sort_keys=True).encode()).hexdigest()
    return {"agent_registry_sha256": registry, "fingerprint": fingerprint, "tool_count": 13, "provider_calls": 0}


def live():
    before = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    after = static_identity()
    assert before == after, "Agent static schema/registry changed."
    original = (ROOT / "backend/db/migrations/sql/007_scoped_reads.sql").read_text(encoding="utf-8").split("CREATE OR REPLACE FUNCTION backend_api.visible_rows",1)[1].split("    RETURN QUERY",1)[0]
    repaired = (ROOT / "backend/db/migrations/sql/030_discipline_lookup.sql").read_text(encoding="utf-8").split("CREATE OR REPLACE FUNCTION backend_api.visible_rows",1)[1].split("    IF p_resource",1)[0]
    assert original == repaired, "Existing token/session/current-account gate changed."
    fixture = json.loads((PRIVATE / "p12-browser-credentials.json").read_text(encoding="utf-8"))
    parameters = json.loads((PRIVATE / "p12-ui-api.json").read_text(encoding="utf-8"))
    assert parameters["dbname"] == fixture["database"] and parameters["dbname"].startswith("deanery_p12_ui_")
    evidence = {"database": fixture["database"], "static": after, "auth_gate_verbatim": True, "roles": []}
    for account in fixture["accounts"]:
        with httpx.Client(base_url="http://127.0.0.1:8881", headers={"Origin": "http://127.0.0.1:5174"}, trust_env=False) as client:
            assert client.get("/api/v1/resources/discipline").status_code == 401
            response = client.post("/api/v1/auth/login", json={"login": account["login"], "password": account["password"]})
            assert response.status_code == 200
            client.headers["Authorization"] = "Bearer " + response.json()["access_token"]
            client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
            try:
                response = client.get("/api/v1/schema")
                assert response.status_code == 200, f"{account['role']} schema: {response.status_code} {response.json().get('error',{}).get('code','')}"
                schema = response.json()["resources"]["discipline"]
                assert schema["operations"] == ["read"] and schema["write_fields"] == []
                response = client.get("/api/v1/resources/discipline", params={"limit": 500})
                assert response.status_code == 200, f"{account['role']} discipline read: {response.status_code} {response.json().get('error',{}).get('code','')}"
                page = response.json()
                assert not page["has_more"] and page["items"]
                with psycopg.connect(**parameters, row_factory=dict_row) as db:
                    db.execute("SET LOCAL ROLE backend_api")
                    assert db.execute("SELECT count(*) FROM backend_api.visible_rows('discipline','invalid')").fetchone()["count"] == 0
                    expected = [json.loads(row["visible_rows"]) for row in db.execute("SELECT visible_rows FROM backend_api.visible_rows(%s,%s)", ("discipline", client.headers["Authorization"][7:]))]
                assert {row["discipline_id"] for row in page["items"]} == {row["discipline_id"] for row in expected}
                denied = client.post("/api/v1/resources/discipline", json={"name": "must-not-create"})
                assert denied.status_code == 403
                denial_code = denied.json()["error"]["code"]
                assert denial_code == "forbidden"
                evidence["roles"].append({"role": account["role"], "rows": len(page["items"]), "read": 200, "write_denied": 403, "denial_code": denial_code, "authenticated_origin_csrf": True, "scope_equal": True})
            finally:
                assert client.post("/api/v1/auth/logout").status_code == 204
                revoked = client.get("/api/v1/resources/discipline")
                assert revoked.status_code == 401, f"{account['role']} revoked read: {revoked.status_code} {revoked.json().get('error',{}).get('code','')}"
    destination = ROOT / ".nelson/missions/2026-10-11_065347_b2445e93/task8-discipline-evidence.json"
    destination.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print(json.dumps(evidence))


if __name__ == "__main__":
    if sys.argv[1:] == ["snapshot"]:
        identity = static_identity()
        SNAPSHOT.write_text(json.dumps(identity), encoding="utf-8")
        print(json.dumps(identity))
    else:
        assert sys.argv[1:] == ["live"]
        live()
