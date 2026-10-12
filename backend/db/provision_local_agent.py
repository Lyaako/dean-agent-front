"""Create an isolated worker login with only backend_executor membership."""

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
        raise SystemExit("Target must be a new private JSON file in this workspace's .local directory")
    parameters = json.loads(args.admin_file.read_text(encoding="utf-8"))
    role, password = "backend_agent_" + secrets.token_hex(4), secrets.token_urlsafe(32)
    with psycopg.connect(**parameters) as db:
        db.execute(sql.SQL("CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}").format(sql.Identifier(role), sql.Literal(password)))
        db.execute(sql.SQL("GRANT backend_executor TO {}").format(sql.Identifier(role)))
        db.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(parameters["dbname"]), sql.Identifier(role)))
        with target.open("x", encoding="utf-8") as stream:
            json.dump({**parameters, "host": args.host or parameters["host"], "user": role, "password": password}, stream, indent=2)
    print("Restricted agent login created; credentials saved privately")


if __name__ == "__main__":
    main()
