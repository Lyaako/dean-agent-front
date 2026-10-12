"""Provision one narrow local operator or knowledge worker, without runtime roles."""
import argparse
import json
from pathlib import Path
import secrets

import psycopg
from psycopg import sql


FUNCTIONS = {
    'operator': ('reserve_regulation(JSONB,UUID,TEXT)', 'get_regulation_version(UUID,TEXT)',
                 'queue_regulation(UUID,UUID,TEXT)', 'withdraw_regulation(UUID,TEXT,TEXT)'),
    'worker': ('claim_knowledge_job(UUID)', 'renew_knowledge_job(UUID,UUID)',
               'checkpoint_knowledge_job(UUID,UUID,JSONB,TEXT,TEXT)', 'save_knowledge_chunks(UUID,UUID,JSONB)',
               'knowledge_chunks(UUID,UUID,INT)', 'seal_knowledge_chunks(UUID,UUID)',
               'publish_knowledge_job(UUID,UUID,JSONB)', 'fail_knowledge_job(UUID,UUID,TEXT,BOOLEAN)'),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=FUNCTIONS)
    parser.add_argument('admin_file', type=Path)
    parser.add_argument('target', type=Path)
    parser.add_argument('--host', help='Explicit connection host, e.g. host.docker.internal for worker')
    args = parser.parse_args()
    target = args.target.resolve()
    if target.exists() or target.parent != (Path.cwd() / '.local').resolve():
        raise SystemExit('Target must be a new private JSON file in workspace .local')
    parameters = json.loads(args.admin_file.read_text(encoding='utf-8'))
    role, password = 'backend_knowledge_' + args.kind + '_' + secrets.token_hex(4), secrets.token_urlsafe(32)
    with psycopg.connect(**parameters) as db:
        db.execute(sql.SQL('CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}').format(sql.Identifier(role), sql.Literal(password)))
        db.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(parameters['dbname']), sql.Identifier(role)))
        db.execute(sql.SQL('GRANT USAGE ON SCHEMA backend_api TO {}').format(sql.Identifier(role)))
        db.execute(sql.SQL('GRANT EXECUTE ON FUNCTION ' + ','.join('backend_api.' + fn for fn in FUNCTIONS[args.kind]) + ' TO {}').format(sql.Identifier(role)))
        with target.open('x', encoding='utf-8') as stream:
            json.dump({**parameters, 'host': args.host or parameters['host'], 'user': role, 'password': password}, stream, indent=2)
    print('Restricted knowledge ' + args.kind + ' login saved privately; no runtime-role membership')


if __name__ == '__main__':
    main()
