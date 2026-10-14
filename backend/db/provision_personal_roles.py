"""Owner-only, repeatable provisioning of application users' NOLOGIN roles."""
import argparse
from hashlib import sha256
import json
from pathlib import Path

import psycopg
from psycopg import sql


def provision(db):
    db.execute(sql.SQL("ALTER DATABASE {} SET search_path=deanery,public").format(
        sql.Identifier(db.info.dbname)))
    db.execute("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC")
    if db.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname='deanery_agent'").fetchone()[0]:
        raise ValueError("The shared agent permission group must be NOLOGIN before private backend membership is added")
    db.execute("GRANT backend_read,backend_api,backend_executor TO deanery_agent")
    services = [r[0] for r in db.execute("""SELECT rolname FROM pg_roles WHERE rolcanlogin
        AND NOT rolsuper AND rolname LIKE 'backend_%' AND
        (pg_has_role(oid,'backend_api','MEMBER') OR pg_has_role(oid,'backend_executor','MEMBER')
            OR pg_has_role(oid,'backend_worker','MEMBER'))""")]
    users = db.execute("""SELECT u.user_id,u.login,u.db_login,r.code FROM deanery.app_user u
        JOIN deanery.app_role r USING(role_id) WHERE u.is_active
          AND r.code IN ('admin','director','dean_staff','teacher') ORDER BY u.user_id""").fetchall()
    for user_id, login, bound, role in users:
        name = bound or f"deanery_user_{user_id}_{sha256(login.encode()).hexdigest()[:8]}"
        existing = db.execute("""SELECT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
            OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=%s""", (name,)).fetchone()
        if existing and existing[0]:
            raise ValueError("Existing personal role has login or privileged attributes; operator review required")
        if not existing:
            db.execute(sql.SQL("CREATE ROLE {} NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS").format(sql.Identifier(name)))
        group = "deanery_teacher" if role == "teacher" else "deanery_staff"
        other = "deanery_staff" if role == "teacher" else "deanery_teacher"
        db.execute(sql.SQL("REVOKE {} FROM {}").format(sql.Identifier(other),sql.Identifier(name)))
        db.execute(sql.SQL("GRANT {},backend_api,backend_executor TO {}").format(sql.Identifier(group),sql.Identifier(name)))
        db.execute("UPDATE deanery.app_user SET db_login=%s WHERE user_id=%s AND db_login IS DISTINCT FROM %s", (name,user_id,name))
        for service in services:
            db.execute(sql.SQL("GRANT {} TO {}").format(sql.Identifier(name),sql.Identifier(service)))
    for service in services:
        db.execute(sql.SQL("GRANT deanery_agent,deanery_read TO {}").format(sql.Identifier(service)))
    return len(users)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("admin_file", type=Path)
    args = parser.parse_args()
    with psycopg.connect(**json.loads(args.admin_file.read_text(encoding="utf-8"))) as db:
        count = provision(db)
    print(f"Personal roles provisioned for {count} active staff accounts; no credentials printed")


if __name__ == "__main__":
    main()
