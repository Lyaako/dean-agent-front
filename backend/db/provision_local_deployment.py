"""Create only the separate migration or order-worker deployment login."""
import argparse
import json
from pathlib import Path
import secrets

import psycopg
from psycopg import sql


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=('migration', 'order'))
    parser.add_argument('admin_file', type=Path)
    parser.add_argument('target', type=Path)
    parser.add_argument('--host', help='Host used by this login')
    args = parser.parse_args()
    target = args.target.resolve()
    if target.exists() or target.parent != (Path.cwd() / '.local').resolve():
        raise SystemExit('Target must be a new private JSON file in workspace .local')
    parameters = json.loads(args.admin_file.read_text(encoding='utf-8'))
    role = 'backend_' + args.kind + '_' + secrets.token_hex(4)
    password = secrets.token_urlsafe(32)
    membership = 'backend_migration' if args.kind == 'migration' else 'backend_worker'
    with psycopg.connect(**parameters) as db:
        db.execute(sql.SQL('CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}').format(sql.Identifier(role), sql.Literal(password)))
        db.execute(sql.SQL('GRANT {} TO {}').format(sql.Identifier(membership), sql.Identifier(role)))
        db.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(parameters['dbname']), sql.Identifier(role)))
        with target.open('x', encoding='utf-8') as stream:
            json.dump({**parameters, 'host': args.host or parameters['host'], 'user': role, 'password': password}, stream, indent=2)
    print('Restricted ' + args.kind + ' login created; credentials saved privately')


if __name__ == '__main__':
    main()
