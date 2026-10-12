"""I172: guarded restored HTTPS and native index recovery; no model invocation."""

from hashlib import sha256
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

from backend.files import iter_units, read_json, storage_path
from backend.tests.integration.p13_https import LOCAL, ROOT, command, frames, request, state
from backend.tests.integration.p13_recovery import PROJECT, file_manifest, save, sql


DESTINATION = LOCAL / "p13-restore"
ORIGIN = "https://localhost:8444"
VERSION = "9551954d-c91c-425b-85d2-67be2bb45038"
RETIRED = "c3840cfb-92e4-40de-9311-7a2be70c9972"
COMPOSE = ["docker", "compose", "-p", PROJECT, "--env-file", str(DESTINATION / "compose.env"),
           "-f", "compose.files.yaml", "-f", "compose.knowledge.yaml", "-f", "compose.yaml",
           "-f", str(DESTINATION / "runtime.yaml")]


def verified_proof(proof, backup_name):
    assert proof["project"] == PROJECT and proof["backup"] == backup_name
    assert type(proof["tables"]) is int and proof["tables"] == 72
    for name in ("exact_content_owners_grants_sequences", "bootstrap_secret_detached", "files_verified"):
        assert proof[name] is True, name


def verified_inventory(before, after):
    assert before == after, "Restored contents, owners, effective grants, grantors and sequences must match"
    assert before["bootstrap_role"] == "postgres" and len(before["tables"]) == 72
    assert before["memberships"] and all(len(row) == 6 and isinstance(row[5], str) for row in before["memberships"])


def provenance(backup_name):
    source = LOCAL / backup_name
    assert source.parent.resolve() == LOCAL.resolve() and source.name.startswith("p13-backup-")
    assert not source.is_symlink() and not source.is_junction()
    complete = json.loads((source / "complete.json").read_text(encoding="utf-8"))
    assert complete["complete"] is True and complete["project"] == "deanery-p13"
    assert len(complete["database"]) == 64 and all(c in "0123456789abcdef" for c in complete["database"])
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    actual = file_manifest(source)
    assert {k: v for k, v in actual.items() if k not in ("manifest.json", "complete.json")} == manifest
    assert DESTINATION.parent.resolve() == LOCAL.resolve()
    assert not DESTINATION.is_symlink() and not DESTINATION.is_junction()
    proof = json.loads((DESTINATION / "database-restore-proof.json").read_text(encoding="utf-8"))
    verified_proof(proof, source.name)
    snapshot = "database-after-effective.json" if proof.get("owner_default_ACL_equivalence") is True else "database-after.json"
    verified_inventory(json.loads((source / "database-before.json").read_text(encoding="utf-8")),
                       json.loads((DESTINATION / snapshot).read_text(encoding="utf-8")))
    expected_files = {k[6:]: v for k, v in manifest.items() if k.startswith("files/")}
    assert file_manifest(DESTINATION / "files") == expected_files
    assert sha256((DESTINATION / "tls/cert.pem").read_bytes()).hexdigest() == manifest["tls/cert.pem"]["sha256"]
    for kind in ("api", "operator", "knowledge"):
        info = json.loads((DESTINATION / ("secrets/" + kind + ".json")).read_text(encoding="utf-8"))
        assert info["host"] == "db" and info["dbname"] == "deanery_p13", "Refuse an external database target"
    fixture = json.loads((LOCAL / "p13-deploy-fixture-progress.json").read_text(encoding="utf-8"))
    assert fixture["readable_knowledge"]["import"]["version_id"] == VERSION
    return source, fixture


def owned(service):
    value = command([*COMPOSE, "ps", "-q", service])
    assert len(value) == 64 and all(c in "0123456789abcdef" for c in value)
    labels = json.loads(command(["docker", "inspect", "--format", "{{json .Config.Labels}}", value]))
    assert labels["com.docker.compose.project"] == PROJECT
    assert labels["com.docker.compose.service"] == service
    return value


def topology(source):
    db, api, proxy = (owned(service) for service in ("db", "api", "proxy"))
    assert db != json.loads((source / "complete.json").read_text(encoding="utf-8"))["database"]
    mounts = json.loads(command(["docker", "inspect", "--format", "{{json .Mounts}}", db]))
    assert any(m.get("Name") == PROJECT + "_postgres_data" and m["Destination"] == "/var/lib/postgresql/data" for m in mounts)
    assert not any(m["Destination"].startswith("/run/secrets/") for m in mounts)
    environments = json.loads(command(["docker", "inspect", "--format", "{{json .Config.Env}}", api]))
    assert "DEANERY_ORIGIN=" + ORIGIN in environments
    mounts = json.loads(command(["docker", "inspect", "--format", "{{json .Mounts}}", api]))
    for target, relative, writable in (("/run/secrets/database.json", "secrets/api.json", False),
                                       ("/app/.local/agent.env", "secrets/agent.env", False),
                                       ("/data/files/originals", "files/originals", True),
                                       ("/data/files/derived", "files/derived", False)):
        source_path = (DESTINATION / relative).resolve().as_posix().casefold()
        drive, tail = source_path.split(":", 1)
        accepted = {source_path, "/run/desktop/mnt/host/" + drive + tail, "/host_mnt/" + drive + tail}
        mount = next(m for m in mounts if m["Destination"] == target)
        assert mount["Type"] == "bind" and mount["RW"] is writable
        assert mount["Source"].replace("\\", "/").casefold() in accepted, "Refuse a source-instance or external mount"
    ports = json.loads(command(["docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", proxy]))
    assert [binding for values in ports.values() if values for binding in values] == [{"HostIp": "127.0.0.1", "HostPort": "8444"}]
    assert not command([*COMPOSE, "--profile", "agent-start", "ps", "-q", "--status", "running", "agent-worker"])
    return db, api


def login(role):
    account = next(a for a in json.loads((DESTINATION / "secrets/acceptance-logins.json").read_text(encoding="utf-8")) if a["role"] == role)
    client = httpx.Client(base_url=ORIGIN, verify=ssl.create_default_context(cafile=str(DESTINATION / "tls/cert.pem")),
                         trust_env=False, timeout=20, headers={"Origin": ORIGIN})
    try:
        response = client.post("/api/v1/auth/login", json={key: account[key] for key in ("login", "password")})
        assert response.status_code == 200
        cookie = response.headers["set-cookie"].lower()
        assert "; secure" in cookie and "; httponly" in cookie and "samesite=lax" in cookie
        client.headers["Authorization"] = "Bearer " + response.json()["access_token"]
        assert request(client, "GET", "auth/me")["roles"] == [role]
        return client
    except BaseException:
        try:
            if "Authorization" in client.headers:
                logout(client)
        finally:
            client.close()
        raise


def logout(client):
    try:
        assert client.post("/api/v1/auth/logout").status_code == 204
        assert client.get("/api/v1/auth/me").status_code == 401
    finally:
        client.close()


def zero_active(db):
    result = json.loads(sql(db, """SELECT json_build_object('agent_runs',(SELECT count(*) FROM agent_backend.agent_run
        WHERE status IN ('queued','running')),'running_jobs',(SELECT count(*) FROM agent_backend.job WHERE status='running'),
        'auth_sessions',(SELECT count(*) FROM agent_backend.auth_session WHERE revoked_at IS NULL),
        'auth_tokens',(SELECT count(*) FROM agent_backend.auth_token WHERE revoked_at IS NULL))"""))
    assert all(value == 0 for value in result.values()), "Restored runtime cleanup must finish before handoff"
    return result


def smoke(backup_name):
    source, fixture = provenance(backup_name)
    db, _ = topology(source)
    clients, checks, cleanup = {}, {}, []
    try:
        for role in ("admin", "dean_staff", "student"):
            clients[role] = login(role)
        admin, staff, student = (clients[role] for role in ("admin", "dean_staff", "student"))
        assert admin.get("/").status_code == 200
        assert request(admin, "GET", "health/ready")["status"] == "ready"
        for item in fixture["proposals"]["runs"]:
            client = clients[item["role"]]
            assert request(client, "GET", "agent/sessions/" + item["chat_id"])["activeRunId"] is None
            messages = request(client, "GET", "agent/sessions/" + item["chat_id"] + "/messages")["items"]
            assert {m["role"] for m in messages} >= {"user", "agent"}
        staff_chat = next(r["chat_id"] for r in fixture["proposals"]["runs"] if r["role"] == "dean_staff")
        request(student, "GET", "agent/sessions/" + staff_chat, status=404)
        pending = fixture["proposals"]["pending_document"]["id"]
        future = fixture["proposals"]["future_proposal"]["id"]
        assert request(student, "GET", "agent/proposals/" + pending)["status"] == "pending"
        assert pending in {p["id"] for p in request(admin, "GET", "agent/proposals?box=incoming")["items"]}
        scheduled = request(admin, "GET", "agent/proposals/" + future)
        assert scheduled["status"] == "approved" and scheduled["execution"]["status"] == "scheduled"
        assert request(admin, "GET", "jobs/" + scheduled["execution"]["job_id"])["status"] == "queued"
        uploaded = fixture["attachment"]
        url = "files/" + uploaded["file_id"] + "/versions/" + uploaded["version_id"] + "/download"
        response = admin.get("/api/v1/" + url)
        assert response.status_code == 200 and response.headers["cache-control"] == "private, no-store"
        assert sha256(response.content).hexdigest() == fixture["content_sha256"]
        request(student, "GET", url, status=404)
        descriptor = fixture["readable_knowledge"]["descriptor"]
        for unit in iter_units(descriptor, DESTINATION / "files"):
            read_json(storage_path(unit["key"], DESTINATION / "files"), unit["hash"])
        checks = {"private_ca_https_8444": True, "three_real_roles": True, "own_chat_history_foreign_scope": True,
                  "pending_and_scheduled_queue": True, "protected_original_exact": True, "restored_derived_hashes": True,
                  "future_order_not_claimed_applied": True}
    finally:
        for role, client in clients.items():
            try:
                logout(client)
            except Exception as error:
                cleanup.append({"role": role, "error": type(error).__name__})
        assert not cleanup, "Owned restored access cleanup failed"
    save(DESTINATION / "application-smoke-proof.json", {"project": PROJECT, "backup": source.name,
         "checks": checks, "cleanup": zero_active(db), "provider_calls": 0})
    print(json.dumps({"phase": "restore_https", "checks": checks, "provider_calls": 0}), flush=True)


def qdrant(api, statement):
    script = "import httpx,json; c=httpx.Client(timeout=5,trust_env=False); " + statement
    result = subprocess.run(["docker", "exec", api, "python", "-c", script], cwd=ROOT,
                            capture_output=True, timeout=15)
    assert result.returncode == 0, "Restored Qdrant metadata verification failed"
    return json.loads(result.stdout)


def operator(arguments, name):
    completed = subprocess.run([*COMPOSE, "run", "--rm", "--no-deps", "operator", "python", "-m",
                                "backend.regulations", *arguments], cwd=ROOT, capture_output=True, timeout=30)
    (DESTINATION / (name + ".json")).write_bytes(completed.stdout)
    (DESTINATION / (name + "-stderr.log")).write_bytes(completed.stderr)
    assert completed.returncode == 0, "Official restored operator failed; inspect private checkpoint"
    return json.loads(completed.stdout)


def reindex(backup_name):
    source, fixture = provenance(backup_name)
    proof = json.loads((DESTINATION / "application-smoke-proof.json").read_text(encoding="utf-8"))
    assert proof["project"] == PROJECT and proof["backup"] == source.name and all(proof["checks"].values())
    db, api = topology(source)
    owned("qdrant")
    assert qdrant(api, "r=c.get('http://qdrant:6333/collections');r.raise_for_status();print(json.dumps(r.json()['result']['collections']))") == []
    assert not command([*COMPOSE, "ps", "-q", "--status", "running", "knowledge-worker"])
    client, started, progress = None, False, {"project": PROJECT, "backup": source.name, "key": str(uuid4()), "provider_calls": 0}
    cleanup_errors = []
    try:
        client = login("admin")
        (DESTINATION / "secrets/operator-token.txt").write_text(client.headers["Authorization"][7:], encoding="utf-8")
        before = operator(["get-version", VERSION], "reindex-before")
        retired = operator(["get-version", RETIRED], "retired-before")
        assert retired["metadata"]["withdrawn_at"] and retired["processing_state"] == "withdrawn"
        started = True
        command([*COMPOSE, "up", "-d", "--wait", "--wait-timeout", "45", "--no-build", "--no-deps", "knowledge-worker"])
        progress["job"] = operator(["reindex", VERSION, "--key", progress["key"]], "reindex-queued")
        (DESTINATION / "reindex-progress.json").write_text(json.dumps(progress, indent=2), encoding="utf-8")
        deadline = monotonic() + 90
        while True:
            after = operator(["get-version", VERSION], "reindex-after")
            if after["job"]["status"] in ("succeeded", "failed", "cancelled"):
                break
            assert monotonic() < deadline, "Bounded restored reindex deadline"
            sleep(1)
        assert after["job"]["status"] == "succeeded" and after["processing_state"] == "ready"
        assert after["published_at"] == before["published_at"] and after["published_by"] == before["published_by"]
        assert after["content_hash"] == before["content_hash"] and after["extraction"] == before["extraction"]
        generation = str(UUID(after["metadata"]["active_index_generation"]))
        assert generation != before["metadata"]["active_index_generation"]
        receipt = after["metadata"]["index_manifest"]
        assert receipt["generation_id"] == generation and receipt["manifest_hash"] == after["metadata"]["chunk_manifest"]["manifest_hash"]
        points = qdrant(api, "r=c.post('http://qdrant:6333/collections/deanery_regulations_v1/points/scroll',json={'limit':60,'with_payload':True,'with_vector':True});r.raise_for_status();print(json.dumps(r.json()['result']))")
        assert points["next_page_offset"] is None and len(points["points"]) == receipt["chunk_count"]
        for point in points["points"]:
            assert point["payload"]["version_id"] == VERSION and point["payload"]["generation_id"] == generation
            assert len(point["vector"]["dense"]) == 1024 and point["vector"]["sparse"]["indices"]
        old, new = (str(UUID(v)) for v in (RETIRED, VERSION))
        admin_id = request(client, "GET", "auth/me")["user_id"]
        assert type(admin_id) is int
        visible = json.loads(sql(db, f"SELECT json_build_array(agent_backend.regulation_version_visible('{old}'::uuid,{admin_id}),agent_backend.regulation_version_visible('{new}'::uuid,{admin_id}))"))
        assert visible == [False, True]
        progress.update({"job": after["job"], "generation_id": generation, "checks": {"fresh_empty_qdrant": True,
            "official_native_reindex": True, "generation_and_receipt": True, "actual_dense_sparse_points": True,
            "withdrawn_version_excluded": True, "original_extraction_publication_preserved": True}})
    finally:
        if started:
            try:
                command([*COMPOSE, "stop", "-t", "15", "knowledge-worker"])
            except Exception as error:
                cleanup_errors.append({"phase": "stop_owned_worker", "error": type(error).__name__})
        if client is not None:
            try:
                logout(client)
            except Exception as error:
                cleanup_errors.append({"phase": "logout", "error": type(error).__name__})
        progress["cleanup_errors"] = cleanup_errors
        (DESTINATION / "reindex-progress.json").write_text(json.dumps(progress, indent=2), encoding="utf-8")
    assert not cleanup_errors, "Owned restored cleanup failed; inspect private progress"
    save(DESTINATION / "reindex-runtime-proof.json", {**progress, "cleanup": zero_active(db)})
    print(json.dumps({"phase": "restore_reindex", "checks": progress["checks"], "provider_calls": 0}), flush=True)


def verified_read_manifest(manifest, chunk_id):
    assert manifest["read_chunk_ids"] == [chunk_id]
    assert all(manifest[key] == [] for key in ("provided_chunk_ids", "acknowledged_chunk_ids", "cited_chunk_ids"))
    assert manifest["delivery_state"] == "pending"


def regulation_history(db):
    return json.loads(sql(db, """SELECT json_agg(row_to_json(history)) FROM (
        SELECT 'regulation' AS table_name,count(*) AS records,md5(coalesce(string_agg(to_jsonb(r)::text,E'\\n' ORDER BY r.id),'')) AS hash FROM agent_backend.regulation r
        UNION ALL SELECT 'regulation_version',count(*),md5(coalesce(string_agg(to_jsonb(r)::text,E'\\n' ORDER BY r.id),'')) FROM agent_backend.regulation_version r
        UNION ALL SELECT 'regulation_chunk',count(*),md5(coalesce(string_agg(to_jsonb(r)::text,E'\\n' ORDER BY r.id),'')) FROM agent_backend.regulation_chunk r
        ) history"""))


def retrieval(backup_name):
    source, fixture = provenance(backup_name)
    indexed = json.loads((DESTINATION / "reindex-runtime-proof.json").read_text(encoding="utf-8"))
    assert indexed["project"] == PROJECT and indexed["backup"] == source.name and all(indexed["checks"].values())
    db, _ = topology(source)
    zero_active(db)
    agent_info = json.loads((DESTINATION / "secrets/agent.json").read_text(encoding="utf-8"))
    api_info = json.loads((DESTINATION / "secrets/api.json").read_text(encoding="utf-8"))
    assert agent_info["host"] == "db" and agent_info["dbname"] == "deanery_p13" and agent_info["user"] != api_info["user"]
    descriptor = fixture["readable_knowledge"]["descriptor"]
    chunks = [chunk for unit in iter_units(descriptor, DESTINATION / "files")
              for chunk in read_json(storage_path(unit["key"], DESTINATION / "files"), unit["hash"])["chunks"]]
    assert len(chunks) == 1
    query = "Синтетический нормативный источник для проверки резервного копирования P13"
    worker, name = str(uuid4()), PROJECT + "-retrieval-" + secrets.token_hex(4)
    client, chat, run = None, None, None
    progress = {"project": PROJECT, "backup": source.name, "container_name": name, "worker_id": worker,
                "model_generation_calls": 0, "cleanup_errors": []}
    history = regulation_history(db)
    try:
        client = login("admin")
        actor_id = request(client, "GET", "auth/me")["user_id"]
        chat = request(client, "POST", "agent/sessions", {"title": "I183 restored retrieval without model"}, status=201, key=uuid4())["id"]
        progress["chat_id"] = chat
        with client.stream("POST", "/api/v1/agent/chat/stream", json={"session_id": chat, "message": query, "attachments": []},
                           headers={"Idempotency-Key": str(uuid4())}) as response:
            assert response.status_code == 200
            first = next(frames(response))
            assert first["event"] == "session"
            run = str(UUID(first["data"]["run_id"]))
            progress["run_id"] = run
        active = json.loads(sql(db, "SELECT json_agg(id::text) FROM agent_backend.agent_run WHERE status IN ('queued','running')"))
        assert active == [run], "Refuse retrieval while another run is active"
        (DESTINATION / "retrieval-progress.json").write_text(json.dumps(progress, indent=2), encoding="utf-8")
        arguments = [*COMPOSE, "--profile", "agent-start", "run", "--rm", "-T", "--no-deps", "--name", name,
                     "agent-worker", "python", "-", run, worker, VERSION, indexed["generation_id"], str(actor_id), chunks[0]["text_hash"], query]
        helper = (LOCAL / "p13-deploy-restore-retrieval-worker.py").read_bytes()
        try:
            result = subprocess.run(arguments, input=helper, cwd=ROOT, capture_output=True, timeout=110)
        except subprocess.TimeoutExpired as error:
            (DESTINATION / "retrieval-worker.json").write_bytes(error.stdout or b"")
            (DESTINATION / "retrieval-worker-stderr.log").write_bytes(error.stderr or b"")
            raise
        (DESTINATION / "retrieval-worker.json").write_bytes(result.stdout)
        (DESTINATION / "retrieval-worker-stderr.log").write_bytes(result.stderr)
        assert result.returncode == 0, "Protected restored retrieval failed; inspect private checkpoint without replay"
        progress["retrieval"] = json.loads(result.stdout)
        current = json.loads(sql(db, f"SELECT json_build_object('status',status,'error_code',error_code,'manifest',regulation_context) FROM agent_backend.agent_run WHERE id='{run}'::uuid"))
        assert current["status"] == "succeeded" and current["error_code"] is None
        manifest = current["manifest"]
        verified_read_manifest(manifest, progress["retrieval"]["chunk_id"])
        progress["read_manifest"] = manifest
        progress["checks"] = {"narrow_agent_executor": True, "actual_dense_sparse_rrf_search": True,
                              "current_scope_generation": True, "canonical_text_hash": True,
                              "withdrawn_old_excluded": True, "read_distinct_from_acknowledged_and_cited": True}
    finally:
        try:
            ids = command(["docker", "ps", "-aq", "--filter", "name=^/" + name + "$"]).splitlines()
            assert len(ids) <= 1
            if ids:
                labels = json.loads(command(["docker", "inspect", "--format", "{{json .Config.Labels}}", ids[0]]))
                assert labels["com.docker.compose.project"] == PROJECT and labels["com.docker.compose.service"] == "agent-worker"
                command(["docker", "stop", "-t", "15", ids[0]])
        except Exception as error:
            progress["cleanup_errors"].append({"phase": "stop_owned_one_shot", "error": type(error).__name__})
        if client is not None:
            try:
                if run and state(db, run)["status"] in ("queued", "running"):
                    stopped = client.post("/api/v1/agent/runs/" + run + "/cancel", json={})
                    assert stopped.status_code in (200, 202)
                if chat:
                    request(client, "DELETE", "agent/sessions/" + chat, status=204)
                    request(client, "GET", "agent/sessions/" + chat, status=404)
                if run:
                    cleared = state(db, run)
                    assert cleared["events"] == 0 and cleared["request_count"] == 1
                    assert all(cleared[k] for k in ("session_cleared", "result_cleared", "request_cleared", "idempotency_cleared"))
                    progress["physical_delete_redacted_copies"] = True
            except Exception as error:
                progress["cleanup_errors"].append({"phase": "cancel_delete_owned_chat", "error": type(error).__name__})
            try:
                logout(client)
            except Exception as error:
                progress["cleanup_errors"].append({"phase": "logout", "error": type(error).__name__})
        (DESTINATION / "retrieval-progress.json").write_text(json.dumps(progress, indent=2), encoding="utf-8")
    assert not progress["cleanup_errors"], "Owned retrieval cleanup failed; inspect private checkpoint"
    assert file_manifest(DESTINATION / "files") == file_manifest(source / "files")
    assert file_manifest(LOCAL / "p13-deploy-files") == file_manifest(source / "files")
    assert regulation_history(db) == history
    progress["official_history_and_source_files_unchanged"] = True
    save(DESTINATION / "retrieval-runtime-proof.json", {**progress, "cleanup": zero_active(db)})
    print(json.dumps({"phase": "restore_retrieval", "checks": progress["checks"], "model_generation_calls": 0}), flush=True)


def self_check():
    valid = {"project": PROJECT, "backup": "p13-backup-self-check", "tables": 72,
             "exact_content_owners_grants_sequences": True, "bootstrap_secret_detached": True, "files_verified": True}
    verified_proof(valid, valid["backup"])
    for name, value in (("project", "deanery-p13"), ("backup", "other"), ("tables", 71),
                        ("exact_content_owners_grants_sequences", False), ("bootstrap_secret_detached", False), ("files_verified", False)):
        try:
            verified_proof({**valid, name: value}, valid["backup"])
        except AssertionError:
            continue
        raise AssertionError("Invalid restoration proof accepted: " + name)
    before = {"bootstrap_role": "postgres", "tables": {str(n): [0, "hash"] for n in range(72)},
              "memberships": [["role", "login", False, False, True, "postgres"]]}
    verified_inventory(before, before)
    for name, value in (("bootstrap_role", "other"), ("tables", {}),
                        ("memberships", [["role", "login", False, False, True]])):
        bad = {**before, name: value}
        for source, destination in ((before, bad), (bad, bad)):
            try:
                verified_inventory(source, destination)
            except AssertionError:
                continue
            raise AssertionError("Invalid restoration inventory accepted: " + name)
    print("I172 offline provenance proof guards PASS; runtime not executed")


if __name__ == "__main__":
    assert ROOT == Path.cwd().resolve()
    if sys.argv[1:] == ["self-check"]:
        self_check()
    elif len(sys.argv) == 3 and sys.argv[1] in ("smoke", "reindex", "retrieval"):
        try:
            {"smoke": smoke, "reindex": reindex, "retrieval": retrieval}[sys.argv[1]](sys.argv[2])
        except BaseException:
            (LOCAL / ("p13-restore-runtime-error-" + secrets.token_hex(4) + ".log")).write_text(traceback.format_exc(), encoding="utf-8")
            raise SystemExit("Restored runtime check failed; inspect private checkpoint, do not replay mutations blindly") from None
    else:
        raise SystemExit("Use self-check or root-approved smoke/reindex/retrieval <complete-private-backup-name>")
