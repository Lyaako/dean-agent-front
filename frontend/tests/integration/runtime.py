"""Private seeded UI fixture and loopback API launcher; never prints credentials."""
import json
import os
from pathlib import Path
import secrets
import sys

import psycopg
from psycopg.conninfo import make_conninfo

ROOT = Path(__file__).resolve().parents[3]
PRIVATE = ROOT / ".local"
ACCOUNTS = {"admin": "vasilyeva", "director": "smirnov", "dean_staff": "kuznetsova", "teacher": "novikov", "student": "ivanov.ks"}


def fixture():
    from backend.auth import hasher

    parameters = json.loads((PRIVATE / "p12-ui-connection.json").read_text(encoding="utf-8"))
    destination = PRIVATE / "p12-browser-credentials.json"
    assert not destination.exists(), "Browser credentials already exist; reuse them instead of resetting passwords."
    with psycopg.connect(**parameters) as db:
        identity = db.execute("SELECT current_database(), (SELECT version_num FROM public.alembic_version)").fetchone()
        assert identity[0].startswith("deanery_p12_ui_") and identity[1] == "0039_scope_check_latency", "Wrong UI database/head."
        counts = dict(db.execute("SELECT table_schema, count(*) FROM information_schema.tables WHERE table_schema IN ('deanery','agent_backend') AND table_type='BASE TABLE' GROUP BY table_schema").fetchall())
        assert counts == {"deanery": 56, "agent_backend": 15}, "Application schema changed."
        accounts = []
        for role, login in ACCOUNTS.items():
            row = db.execute("SELECT u.user_id, r.code FROM deanery.app_user u JOIN deanery.app_role r USING(role_id) WHERE u.login=%s AND u.is_active", (login,)).fetchone()
            assert row and row[1] == role, "Seed account/role mismatch."
            password = secrets.token_urlsafe(30)
            db.execute("UPDATE deanery.app_user SET password_hash=%s WHERE user_id=%s", (hasher.hash(password), row[0]))
            accounts.append({"role": role, "login": login, "password": password, "user_id": row[0]})
    destination.write_text(json.dumps({"database": identity[0], "head": identity[1], "accounts": accounts}, indent=2), encoding="utf-8")
    print(json.dumps({"database": identity[0], "head": identity[1], "roles": list(ACCOUNTS), "credentials": "private", "application_tables": 71}))


def api():
    parameters = json.loads((PRIVATE / "p12-ui-api.json").read_text(encoding="utf-8"))
    assert parameters["dbname"].startswith("deanery_p12_ui_"), "Wrong API database."
    os.environ.update({"DATABASE_URL": make_conninfo(**parameters), "DEANERY_ORIGIN": "http://127.0.0.1:5174", "DEANERY_DEV_INSECURE_COOKIE": "1", "AGENT_DATABASE_FILE": str(PRIVATE / "p12-ui-agent.json"), "FILES_STORAGE_ROOT": str(PRIVATE / "p12-ui-files")})
    import uvicorn

    uvicorn.run("backend.app:app", host="127.0.0.1", port=8881, access_log=False)


if __name__ == "__main__":
    assert len(sys.argv) == 2 and sys.argv[1] in {"fixture", "api"}, "Use fixture or api."
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))
    fixture() if sys.argv[1] == "fixture" else api()
