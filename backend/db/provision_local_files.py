"""Provision a local file worker without permission to execute order or agent jobs."""
import argparse
import json
from pathlib import Path
import secrets

import psycopg
from psycopg import sql


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('admin_file', type=Path)
    parser.add_argument('target', type=Path)
    parser.add_argument('--host', default='host.docker.internal', help='Host used by the runtime login')
    args = parser.parse_args()
    target = args.target.resolve()
    if target.exists() or target.parent != (Path.cwd() / '.local').resolve():
        raise SystemExit('Target must be a new private JSON file in workspace .local')
    parameters = json.loads(args.admin_file.read_text(encoding='utf-8'))
    role, password = 'backend_files_' + secrets.token_hex(4), secrets.token_urlsafe(32)
    with psycopg.connect(**parameters) as db:
        db.execute(sql.SQL('CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}').format(sql.Identifier(role), sql.Literal(password)))
        db.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(parameters['dbname']), sql.Identifier(role)))
        db.execute(sql.SQL('GRANT USAGE ON SCHEMA backend_api TO {}').format(sql.Identifier(role)))
        db.execute(sql.SQL('GRANT EXECUTE ON FUNCTION backend_api.claim_file_job(UUID),backend_api.renew_file_job(UUID,UUID),backend_api.checkpoint_file_job(UUID,UUID,JSONB,TEXT,TEXT),backend_api.retry_file_job(UUID,UUID,TEXT) TO {}').format(sql.Identifier(role)))
        with target.open('x', encoding='utf-8') as stream:
            json.dump({**parameters, 'host': args.host, 'user': role, 'password': password}, stream, indent=2)
    print('Restricted file-worker login saved privately; no order/agent role membership')


if __name__ == '__main__':
    main()
