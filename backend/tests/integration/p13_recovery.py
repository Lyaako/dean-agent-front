"""I151: private, stopped-writer backup and restore into a new acceptance project."""

from hashlib import sha256
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
from alembic.config import Config
from alembic.script import ScriptDirectory

from backend.tests.integration.p13_https import COMPOSE, LOCAL, ROOT, command, container


PROJECT = "deanery-p13-restore"
WRITERS = {"api", "agent-worker", "file-worker", "knowledge-worker", "order-worker"}


def save(path, value):
    with path.open("x", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, indent=2)


def sql(db_id, statement, database="deanery_p13", user="postgres"):
    result = subprocess.run(["docker", "exec", "-i", db_id, "psql", "-X", "-qAt", "-U", user,
                             "-d", database, "-v", "ON_ERROR_STOP=1"], cwd=ROOT,
                            input=statement.encode("utf-8"), capture_output=True, timeout=90)
    assert result.returncode == 0, "Private recovery SQL failed; do not print credentials or rows"
    return result.stdout.decode("utf-8").strip()


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def inventory(db_id, expected_head=None):
    if expected_head is None:
        expected_head = ScriptDirectory.from_config(Config(str(ROOT / "alembic.ini"))).get_current_head()
    tables = json.loads(sql(db_id, """SELECT json_agg(json_build_array(n.nspname,c.relname) ORDER BY 1)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r'
        AND (n.nspname IN ('deanery','agent_backend') OR (n.nspname='public' AND c.relname='alembic_version'))"""))
    # Revision0041 adds account_security; both historical and current backups stay strict.
    assert len(tables) == 72 + (int(expected_head[:4]) >= 41)
    assert ["public", "alembic_version"] in tables and len(tables) == len({tuple(t) for t in tables})
    statements = []
    for schema, table in sorted(tables):
        name = identifier(schema) + "." + identifier(table)
        statements.append(f"SELECT json_build_array(count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' "
                          f"ORDER BY to_jsonb(t)::text),''))) FROM {name} t;")
    hashes = [json.loads(line) for line in sql(db_id, "\n".join(statements)).splitlines()]
    assert len(hashes) == len(tables)
    metadata = json.loads(sql(db_id, """SELECT json_build_object(
        'head',(SELECT version_num FROM public.alembic_version),
        'bootstrap_role',(SELECT rolname FROM pg_roles WHERE oid=10),
        'sequences',(SELECT json_agg(to_jsonb(s) ORDER BY schemaname,sequencename) FROM pg_sequences s
            WHERE schemaname IN ('deanery','agent_backend')),
        'functions',(SELECT json_agg(json_build_array(n.nspname,p.proname,
            pg_get_function_identity_arguments(p.oid),r.rolname,p.prosecdef,p.proacl::text)
            ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
            WHERE n.nspname IN ('deanery','agent_backend','backend_api')),
        'objects',(SELECT json_agg(json_build_array(n.nspname,c.relname,c.relkind,r.rolname,
            CASE WHEN c.relkind IN ('r','v','m','p','f') THEN coalesce(c.relacl,acldefault('r',c.relowner))::text
                 WHEN c.relkind='S' THEN coalesce(c.relacl,acldefault('s',c.relowner))::text
                 ELSE c.relacl::text END)
            ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname IN ('deanery','agent_backend','backend_api')),
        'roles',(SELECT json_agg(json_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,
            rolcanlogin,rolreplication,rolbypassrls) ORDER BY rolname) FROM pg_roles
            WHERE rolname !~ '^pg_' AND rolname !~ '^p13_restore_'),
        'memberships',(SELECT json_agg(json_build_array(r.rolname,m.rolname,a.admin_option,
            a.inherit_option,a.set_option,g.rolname) ORDER BY r.rolname,m.rolname)
            FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member
            JOIN pg_roles g ON g.oid=a.grantor))"""))
    assert metadata["head"] == expected_head
    return {"tables": {".".join(t): h for t, h in zip(sorted(tables), hashes)}, **metadata}


def file_manifest(directory):
    assert not directory.is_symlink() and not directory.is_junction(), "Refuse a linked backup root"
    root = directory.resolve(strict=True)
    result = {}
    for path in sorted(directory.rglob("*")):
        assert not path.is_symlink() and not path.is_junction(), "Refuse linked backup entries"
        assert path.resolve(strict=True).is_relative_to(root)
        if path.is_file():
            with path.open("rb") as stream:
                digest = sha256()
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            result[path.relative_to(directory).as_posix()] = {"bytes": path.stat().st_size,
                                                              "sha256": digest.hexdigest()}
    return result


def backup():
    destination = LOCAL / ("p13-backup-" + secrets.token_hex(4))
    destination.mkdir()
    db_id = container("db")
    source_running = set(command([*COMPOSE, "ps", "--services", "--status", "running"]).splitlines())
    running = source_running & WRITERS
    assert "api" in running
    save(destination / "services.json", sorted(running))
    owned = command([*COMPOSE, "ps", "-aq"]).splitlines()
    images = {}
    writer_ids = []
    proxy_id = None
    for cid in owned:
        image, labels = json.loads(command(["docker", "inspect", "--format",
            "[{{json .Image}},{{json .Config.Labels}}]", cid]))
        assert labels["com.docker.compose.project"] == "deanery-p13"
        assert image.startswith("sha256:") and len(image) == 71
        service = labels["com.docker.compose.service"]
        assert service not in images
        images[service] = image
        if service == "proxy" and service in source_running:
            proxy_id = cid
        if service in running:
            writer_ids.append(cid)
    assert "db" in images and "api" in images
    assert len(writer_ids) == len(running)
    save(destination / "images.json", images)
    command([*COMPOSE, "stop", *sorted(running)])
    try:
        assert not (set(command([*COMPOSE, "ps", "--services", "--status", "running"]).splitlines()) & WRITERS)
        before = inventory(db_id)
        # Empty acceptance fixtures cannot prove recovery of files, proposals and order state.
        for table in ("agent_backend.proposal", "agent_backend.file", "agent_backend.regulation_version",
                      "agent_backend.job"):
            assert before["tables"][table][0] > 0, "Recovery fixtures must exist first: " + table
        assert sql(db_id, "SELECT count(*) FROM agent_backend.agent_run WHERE status IN ('queued','running')") == "0"
        save(destination / "database-before.json", before)
        for filename, arguments in (("database.dump", ["pg_dump", "-Fc", "-U", "postgres", "-d", "deanery_p13"]),
                                    ("roles.sql", ["pg_dumpall", "-U", "postgres", "--roles-only"])):
            result = subprocess.run(["docker", "exec", db_id, *arguments], cwd=ROOT,
                                    capture_output=True, timeout=90)
            assert result.returncode == 0 and result.stdout, "Private PostgreSQL backup failed"
            with (destination / filename).open("xb") as output:
                output.write(result.stdout)
        for folder in ("originals", "regulations", "derived"):
            source = LOCAL / "p13-deploy-files" / folder
            expected = file_manifest(source)
            shutil.copytree(source, destination / "files" / folder)
            assert file_manifest(destination / "files" / folder) == expected
        for folder in ("secrets", "tls"):
            source = LOCAL / ("p13-deploy-" + folder)
            expected = file_manifest(source)
            shutil.copytree(source, destination / folder)
            assert file_manifest(destination / folder) == expected
        shutil.copy2(LOCAL / "p13-deploy-compose.env", destination / "source-compose.env")
        assert inventory(db_id) == before, "A source writer changed the backup snapshot"
        save(destination / "manifest.json", file_manifest(destination))
        save(destination / "complete.json", {"complete": True, "project": "deanery-p13", "database": db_id})
    finally:
        command(["docker", "start", *writer_ids])
        if proxy_id and "api" in running:
            # Nginx resolves upstream names at reload; restarted containers can get another IP.
            command(["docker", "exec", proxy_id, "nginx", "-s", "reload"])
    print(json.dumps({"backup": destination.name, "complete": True}), flush=True)


def restore(backup_name):
    source = (LOCAL / backup_name).resolve(strict=True)
    assert source.parent == LOCAL.resolve() and source.name.startswith("p13-backup-")
    assert json.loads((source / "complete.json").read_text())["complete"]
    manifest = json.loads((source / "manifest.json").read_text())
    actual = file_manifest(source)
    assert {k: v for k, v in actual.items() if k not in {"manifest.json", "complete.json"}} == manifest
    assert not command(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=" + PROJECT])
    for volume in ("postgres_data", "knowledge_qdrant"):
        assert not command(["docker", "volume", "ls", "-q", "--filter", "name=^" + PROJECT + "_" + volume + "$"])
    destination = LOCAL / "p13-restore"
    destination.mkdir()
    for folder in ("files", "secrets", "tls"):
        shutil.copytree(source / folder, destination / folder)
        assert file_manifest(destination / folder) == file_manifest(source / folder)
    (destination / "files" / "temporary").mkdir()
    for service in ("agent", "file", "knowledge", "order"):
        (destination / "health" / service).mkdir(parents=True)
    env = {
        "P13_SECRET_DIR": destination / "secrets", "P13_FILES_ROOT": destination / "files",
        "P13_HEALTH_ROOT": destination / "health", "P13_TLS_DIR": destination / "tls",
        "FILES_WORKER_SECRET": destination / "secrets/files.json",
        "KNOWLEDGE_WORKER_SECRET": destination / "secrets/knowledge.json",
    }
    original_env = (source / "source-compose.env").read_text(encoding="utf-8")
    bge = next(line for line in original_env.splitlines() if line.startswith("KNOWLEDGE_BGE_URL="))
    assert bge == "KNOWLEDGE_BGE_URL=http://host.docker.internal:8087"
    (destination / "compose.env").write_text("\n".join(k + "=" + v.as_posix() for k, v in env.items())
                                             + "\n" + bge + "\n", encoding="utf-8")
    expected = json.loads((source / "database-before.json").read_text(encoding="utf-8"))
    assert expected["bootstrap_role"] == "postgres"
    bootstrap_user = "postgres"
    roles = (source / "roles.sql").read_text(encoding="utf-8")
    assert roles.splitlines().count("CREATE ROLE postgres;") == 1
    restored_roles = roles.replace("CREATE ROLE postgres;\n", "", 1)
    assert "CREATE ROLE postgres;" not in restored_roles
    (destination / "roles-restore.sql").write_text(restored_roles, encoding="utf-8")
    save(destination / "roles-restore-transform.json", {"omitted_statements": ["CREATE ROLE postgres;"],
        "original_sha256": sha256((source / "roles.sql").read_bytes()).hexdigest(),
        "execution_sha256": sha256((destination / "roles-restore.sql").read_bytes()).hexdigest()})
    (destination / "secrets/restore-password").write_text(secrets.token_urlsafe(40), encoding="utf-8")
    override = destination / "bootstrap.yaml"
    override.write_text("""services:
  db:
    entrypoint: !reset null
    command: !reset null
    environment:
      POSTGRES_DB: postgres
      POSTGRES_USER: """ + bootstrap_user + """
      POSTGRES_PASSWORD_FILE: /run/secrets/restore-password
    volumes:
      - type: bind
        source: ${P13_SECRET_DIR}/restore-password
        target: /run/secrets/restore-password
        read_only: true
        bind: {create_host_path: false}
    healthcheck:
      test: [CMD, pg_isready, -U, """ + bootstrap_user + """, -d, postgres]
""", encoding="utf-8")
    compose = ["docker", "compose", "-p", PROJECT, "--env-file", str(destination / "compose.env"),
               "-f", "compose.files.yaml", "-f", "compose.knowledge.yaml", "-f", "compose.yaml"]
    # A restored application must never compete for the original instance's port or origin.
    (destination / "runtime.yaml").write_text("""services:
  api:
    environment:
      DEANERY_ORIGIN: https://localhost:8444
  proxy:
    ports: !override ["127.0.0.1:8444:8443"]
""", encoding="utf-8")
    command([*compose, "-f", str(destination / "runtime.yaml"), "config", "--quiet"])
    command([*compose, "-f", str(override), "config", "--quiet"])
    command([*compose, "-f", str(override), "up", "-d", "--wait", "db"])
    db_id = command([*compose, "ps", "-q", "db"])
    labels = json.loads(command(["docker", "inspect", "--format", "{{json .Config.Labels}}", db_id]))
    assert labels["com.docker.compose.project"] == PROJECT and labels["com.docker.compose.service"] == "db"
    for filename, arguments in (("roles.sql", ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", bootstrap_user,
                                               "-d", "postgres", "-f", "-"]),
                                ("database.dump", ["pg_restore", "--exit-on-error", "--create", "-U", bootstrap_user,
                                                   "-d", "postgres"])):
        restore_file = destination / "roles-restore.sql" if filename == "roles.sql" else source / filename
        with restore_file.open("rb") as stream:
            result = subprocess.run(["docker", "exec", "-i", db_id, *arguments], cwd=ROOT,
                                    stdin=stream, capture_output=True, timeout=90)
        (destination / (filename + ".restore.stdout")).write_bytes(result.stdout)
        (destination / (filename + ".restore.stderr")).write_bytes(result.stderr)
        assert result.returncode == 0, "Private PostgreSQL restore failed; inspect without exposing secrets"
    actual = inventory(db_id, expected["head"])
    save(destination / "database-after.json", actual)
    assert actual == expected, "Restored content, sequences, function owners or grants differ"
    command([*compose, "up", "-d", "--wait", "--force-recreate", "db"])
    db_id = command([*compose, "ps", "-q", "db"])
    inspected = json.loads(command(["docker", "inspect", db_id]))[0]
    assert not any(m["Destination"] == "/run/secrets/restore-password" for m in inspected["Mounts"])
    assert not any(e.startswith("POSTGRES_PASSWORD") or e.startswith("POSTGRES_USER") for e in inspected["Config"]["Env"])
    assert inventory(db_id, expected["head"]) == expected
    save(destination / "database-restore-proof.json", {"project": PROJECT, "backup": source.name,
         "tables": len(actual["tables"]), "exact_content_owners_grants_sequences": True, "bootstrap_secret_detached": True,
         "files_verified": True, "qdrant_reindex": "not_started", "application_smoke": "not_started"})
    print(json.dumps({"restore": destination.name, "database_and_files": "passed",
                      "qdrant_and_application": "pending"}), flush=True)


if __name__ == "__main__":
    assert ROOT == ROOT.cwd().resolve()
    if sys.argv[1:] == ["backup"]:
        backup()
    elif len(sys.argv) == 3 and sys.argv[1] == "restore":
        restore(sys.argv[2])
    else:
        raise SystemExit("Use backup or restore <private-backup-directory-name>")
