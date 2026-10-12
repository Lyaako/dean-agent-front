"""Create a least-privilege API login in the isolated local PostgreSQL cluster."""

import argparse
import json
from pathlib import Path
import secrets

import psycopg
from psycopg import sql


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("admin_file", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--host", help="Host used by the runtime login")
    args = parser.parse_args()
    target = args.target.resolve()
    if target.exists() or target.parent != (Path.cwd() / ".local").resolve():
        raise SystemExit("Target must be a new private JSON file in workspace .local")
    admin = json.loads(args.admin_file.read_text(encoding="utf-8"))
    role = "backend_p01_app_" + secrets.token_hex(4)
    password = secrets.token_urlsafe(32)
    with psycopg.connect(**admin) as db:
        db.execute(sql.SQL("CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}").format(sql.Identifier(role), sql.Literal(password)))
        db.execute(sql.SQL("GRANT backend_api TO {}").format(sql.Identifier(role)))
        db.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(admin["dbname"]), sql.Identifier(role)))
        with target.open("x", encoding="utf-8") as stream:
            json.dump({**admin, "host": args.host or admin["host"], "user": role, "password": password}, stream, indent=2)
    print("Restricted API login created; credentials saved privately")


if __name__ == "__main__":
    main()
