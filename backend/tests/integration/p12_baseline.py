"""Guarded P12 setup/baseline. Run from the repository root with its existing venv."""

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import traceback
import xml.etree.ElementTree as ET

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row


ROOT = Path(__file__).resolve().parents[3]
LOCAL = ROOT / ".local"
# shortcut: archived setup is pinned to the0036 baseline; use final-head deployment checks for P13.
HEAD = "0036_proposal_filters"
SHARED = ("backend_migration", "backend_api", "backend_executor", "backend_read",
          "backend_worker", "deanery_read", "deanery_teacher", "deanery_staff", "deanery_agent")


def read(name):
    return json.loads((LOCAL / name).read_text(encoding="utf-8"))


def write(name, value):
    with (LOCAL / name).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, default=str)


def shared_state(db):
    return (db.execute("SELECT * FROM pg_authid WHERE rolname=ANY(%s) ORDER BY rolname", (list(SHARED),)).fetchall(),
            db.execute("SELECT m.* FROM pg_auth_members m JOIN pg_roles c ON c.oid=m.member "
                       "WHERE c.rolname=ANY(%s) ORDER BY roleid,member,grantor", (list(SHARED),)).fetchall(),
            db.execute("SELECT rolname,rolconfig FROM pg_roles WHERE rolname=ANY(%s) ORDER BY rolname", (list(SHARED),)).fetchall())


def run_private(arguments, log, env=None):
    with (LOCAL / log).open("x", encoding="utf-8") as stream:
        process = subprocess.run([sys.executable, *arguments], cwd=ROOT, env=env,
                                 stdout=stream, stderr=subprocess.STDOUT, text=True)
    return process.returncode


def verify_database(info):
    with psycopg.connect(**info) as db:
        assert db.execute("SELECT version_num FROM public.alembic_version").fetchone()[0] == HEAD
        counts = dict(db.execute("SELECT table_schema,count(*) FROM information_schema.tables "
                                 "WHERE table_type='BASE TABLE' AND table_schema IN ('deanery','agent_backend','public') "
                                 "GROUP BY table_schema").fetchall())
        assert counts == {"deanery": 56, "agent_backend": 15, "public": 1}, counts
    return counts


def setup():
    names = [f"p12-{lane}-{kind}.json" for lane in ("backend", "ui") for kind in ("connection", "api", "agent")]
    assert all(not (LOCAL / name).exists() for name in names), "Never overwrite existing runtime files"
    source = read("p01-repro-connection.json")
    admin = {**source, "dbname": "postgres"}
    nonce = secrets.token_hex(4)
    backend = {**source, "dbname": "deanery_p12_backend_" + nonce}
    ui = {**source, "dbname": "deanery_p12_ui_" + nonce}
    with psycopg.connect(**admin, autocommit=True, row_factory=dict_row) as cluster:
        before = shared_state(cluster)
        roles = {row["rolname"]: row for row in before[0]}
        assert set(roles) == set(SHARED), "Existing bootstrap role mismatch"
        config = next(row["rolconfig"] for row in before[2] if row["rolname"] == "deanery_agent")
        assert sorted(config or []) == ["search_path=deanery, public", "statement_timeout=15s"]
        for child in ("deanery_teacher", "deanery_staff", "deanery_agent"):
            assert cluster.execute("SELECT pg_has_role(%s,'deanery_read','MEMBER')", (child,)).fetchone()["pg_has_role"]
        cluster.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(backend["dbname"])))
        write("p12-backend-connection.json", backend)
        with psycopg.connect(**backend, autocommit=True) as db:
            db.execute((ROOT / "backend/db/bootstrap.sql").read_text(encoding="utf-8"), prepare=False)
        assert run_private(["-m", "backend.db.upgrade_local", ".local/p12-backend-connection.json"], "p12-backend-migration.log") == 0, "See private migration log"
        with psycopg.connect(**backend, autocommit=True) as db:
            cursor = db.execute((ROOT / "references/database/03_seed.sql").read_text(encoding="utf-8"), prepare=False)
            while cursor.nextset():
                pass
        counts = verify_database(backend)
        assert shared_state(cluster) == before, "Shared role mutation detected"
        assert cluster.execute("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=%s", (backend["dbname"],)).fetchone()["n"] == 0
        cluster.execute(sql.SQL("CREATE DATABASE {} TEMPLATE {}").format(sql.Identifier(ui["dbname"]), sql.Identifier(backend["dbname"])))
        write("p12-ui-connection.json", ui)
        verify_database(ui)
        for lane in ("backend", "ui"):
            for kind in ("api", "agent"):
                assert run_private(["-m", f"backend.db.provision_local_{kind}", f".local/p12-{lane}-connection.json",
                                    f".local/p12-{lane}-{kind}.json"], f"p12-{lane}-{kind}-provision.log") == 0
                runtime = read(f"p12-{lane}-{kind}.json")
                assert runtime["dbname"] == (backend if lane == "backend" else ui)["dbname"]
                with psycopg.connect(**runtime) as db:
                    state = db.execute("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user").fetchone()
                    assert state == (False, False, False, False)
        assert shared_state(cluster) == before, "Shared role mutation detected"
    result = {"time": datetime.now(timezone.utc).isoformat(), "head": HEAD, "tables": counts,
              "backend_database": backend["dbname"], "ui_database": ui["dbname"], "clean_clone_before_tests": True,
              "shared_roles_preserved": True,
              "seed_sha256": hashlib.sha256((ROOT / "references/database/03_seed.sql").read_bytes()).hexdigest()}
    write("p12-backend-setup-evidence.json", result)
    print(json.dumps(result))


def test_environment():
    admin, api, agent = [read(f"p12-backend-{kind}.json") for kind in ("connection", "api", "agent")]
    assert admin["dbname"].startswith("deanery_p12_backend_")
    assert api["dbname"] == agent["dbname"] == admin["dbname"]
    env = os.environ.copy()
    for name in ("TEST_AGENT_LIVE_MODEL", "P11_CALIBRATE", "P11_LIVE_RACE"):
        env.pop(name, None)
    storage = LOCAL / "p12-backend-files"
    temporary = LOCAL / "p12-backend-temp"
    for path in (storage, temporary):
        path.mkdir(exist_ok=True)
    env.update(TEST_DATABASE_DSN=make_conninfo(**admin), DATABASE_URL=make_conninfo(**api),
               WORKER_DATABASE_URL=make_conninfo(**agent), AGENT_DATABASE_FILE=str(LOCAL / "p12-backend-agent.json"),
               FILES_DATABASE_FILE=str(LOCAL / "p12-backend-api.json"), KNOWLEDGE_DATABASE_FILE=str(LOCAL / "p12-backend-api.json"),
               KNOWLEDGE_TOKEN_FILE=str(LOCAL / "p12-backend-unprovisioned-operator-token.txt"),
               FILES_STORAGE_ROOT=str(storage), KNOWLEDGE_STORAGE_ROOT=str(storage),
               TMP=str(temporary), TEMP=str(temporary), TMPDIR=str(temporary), PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
    return env


def tests():
    env = test_environment()
    stamp = secrets.token_hex(4)
    result = run_private(["-m", "pytest", "backend/tests", "-q", "-ra",
                          "--basetemp=" + str(LOCAL / ("p12-backend-pytest-" + stamp)),
                          "-o", "cache_dir=" + str(LOCAL / "p12-backend-pytest-cache"),
                          "--junitxml=" + str(LOCAL / "p12-backend-pytest.xml")], "p12-backend-pytest.log", env)
    suites = ET.parse(LOCAL / "p12-backend-pytest.xml").getroot()
    cases = list(suites.iter("testcase"))
    skipped = [{"name": c.get("name"), "reason": c.find("skipped").get("message")} for c in cases if c.find("skipped") is not None]
    failures = [c.get("name") for c in cases if c.find("failure") is not None or c.find("error") is not None]
    summary = {"collected": len({(c.get('classname'), c.get('name')) for c in cases}),
               "passed": sum(c.find('failure') is None and c.find('error') is None and c.find('skipped') is None for c in cases),
               "skipped": len(skipped), "failure_outcomes": sum(c.find('failure') is not None for c in cases),
               "error_outcomes": sum(c.find('error') is not None for c in cases),
               "exit_code": result, "skip_cases": skipped, "failures": failures}
    write("p12-backend-pytest-summary.json", summary)
    print(json.dumps(summary))
    return result


def focused():
    nodes = set()
    for case in ET.parse(LOCAL / "p12-backend-pytest.xml").getroot().iter("testcase"):
        if case.find("failure") is None and case.find("error") is None:
            continue
        parts = case.get("classname").split(".")
        index = next(i for i, part in enumerate(parts) if part.startswith("test_"))
        assert all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", part) for part in parts[index:])
        nodes.add("backend/tests/" + parts[index] + ".py::" + "::".join([*parts[index + 1:], case.get("name")]))
    assert len(nodes) == 21, "Investigate a changed baseline instead of broadening this focused rerun"
    env = test_environment()
    write("p12-backend-focused-nodes.json", sorted(nodes))
    stamp = secrets.token_hex(4)
    result = run_private(["-m", "pytest", *sorted(nodes), "-q", "-ra",
                          "--basetemp=" + str(LOCAL / ("p12-backend-focused-" + stamp)),
                          "-o", "cache_dir=" + str(LOCAL / "p12-backend-pytest-cache"),
                          "--junitxml=" + str(LOCAL / "p12-backend-focused.xml")], "p12-backend-focused.log", env)
    cases = list(ET.parse(LOCAL / "p12-backend-focused.xml").getroot().iter("testcase"))
    summary = {"selected": len(nodes), "passed": sum(c.find('failure') is None and c.find('error') is None and c.find('skipped') is None for c in cases),
               "failure_outcomes": sum(c.find('failure') is not None for c in cases),
               "error_outcomes": sum(c.find('error') is not None for c in cases), "exit_code": result}
    write("p12-backend-focused-summary.json", summary)
    print(json.dumps(summary))
    return result


def table_counts(db):
    tables = db.execute("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('deanery','agent_backend','public') ORDER BY 1,2").fetchall()
    return {(schema, table): db.execute(sql.SQL("SELECT count(*) FROM {}.{}").format(sql.Identifier(schema), sql.Identifier(table))).fetchone()[0]
            for schema, table in tables}


def original_sql():
    info = read("p12-backend-connection.json")
    assert info["dbname"].startswith("deanery_p12_backend_")
    original = (ROOT / "references/database/06_tests.sql").read_text(encoding="utf-8")
    assert not re.search(r"(?m)^\\(?!echo )", original), "Unsupported psql directive"
    script = re.sub(r"(?m)^\\echo .*?$", "", original)
    notices = []
    with psycopg.connect(**info, autocommit=True) as db:
        before = table_counts(db)
        db.add_notice_handler(lambda notice: notices.append(notice.message_primary))
        cursor = db.execute(script, prepare=False)
        while cursor.nextset():
            pass
        assert table_counts(db) == before, "Original SQL test rows did not roll back"
    (LOCAL / "p12-backend-original-sql.log").write_text("\n".join(notices), encoding="utf-8")
    passed = sum(message.startswith("✓") for message in notices)
    assert passed == 184, passed
    result = {"passed": passed, "rollback_verified_all_72_table_counts": True,
              "source_sha256": hashlib.sha256((ROOT / "references/database/06_tests.sql").read_bytes()).hexdigest()}
    write("p12-backend-original-sql-summary.json", result)
    print(json.dumps(result))


if __name__ == "__main__":
    assert Path.cwd().resolve() == ROOT
    assert len(sys.argv) == 2 and sys.argv[1] in ("setup", "tests", "focused", "sql")
    try:
        status = {"setup": setup, "tests": tests, "focused": focused, "sql": original_sql}[sys.argv[1]]()
    except Exception:
        diagnostic = LOCAL / f"p12-backend-{sys.argv[1]}-error-{secrets.token_hex(4)}.log"
        diagnostic.write_text(traceback.format_exc(), encoding="utf-8")
        print(f"Guarded {sys.argv[1]} failed; diagnostic saved privately at {diagnostic.name}")
        status = 1
    sys.exit(status)
