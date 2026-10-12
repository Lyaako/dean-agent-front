"""Explicit setup jobs for the new private Compose database; never run by workers."""
import argparse
import json
from pathlib import Path
import secrets
import subprocess
import sys

from alembic.config import Config
from alembic.script import ScriptDirectory
import psycopg
from psycopg import sql

from backend.auth import hasher


def provision(module, *arguments):
    result = subprocess.run([sys.executable, '-m', module, *arguments], capture_output=True)
    if result.returncode:
        raise SystemExit('Private setup failed in ' + module + '; credentials were not printed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('step', choices=('bootstrap', 'runtime', 'synthetic-seed'))
    args = parser.parse_args()
    admin_file = '/run/secrets/admin.json'
    parameters = json.loads(Path(admin_file).read_text(encoding='utf-8'))
    if parameters.get('host') != 'db' or parameters.get('dbname') != 'deanery_p13':
        raise SystemExit('Setup accepts only the new Compose db/deanery_p13 target')
    local = Path('.local')
    if not local.is_dir():
        raise SystemExit('Mount the private setup output directory at /app/.local')
    with psycopg.connect(**parameters, autocommit=True) as db:
        if args.step == 'bootstrap':
            target = local / 'migration.json'
            if target.exists() or db.execute("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'").fetchone()[0]:
                raise SystemExit('Bootstrap requires a fresh empty database and new migration credentials')
            db.execute(Path('backend/db/bootstrap.sql').read_text(encoding='utf-8'), prepare=False)
            provision('backend.db.provision_local_deployment', 'migration', admin_file, str(target), '--host', 'db')
        else:
            head = ScriptDirectory.from_config(Config('alembic.ini')).get_current_head()
            if db.execute('SELECT version_num FROM public.alembic_version').fetchone() != (head,):
                raise SystemExit('Run the migration job to the current source head first')
            if db.execute("SELECT count(*) FROM pg_tables WHERE schemaname IN ('deanery','agent_backend')").fetchone()[0] != 71:
                raise SystemExit('Unexpected application table count')
            if args.step == 'runtime':
                targets = ('api', 'agent', 'files', 'operator', 'knowledge', 'order')
                if any((local / (name + '.json')).exists() for name in targets):
                    raise SystemExit('Runtime setup requires new credential files; use individual provisioners after a partial failure')
                for name in targets:
                    module = 'backend.db.provision_local_' + {'operator': 'knowledge', 'knowledge': 'knowledge', 'order': 'deployment'}.get(name, name)
                    kind = {'operator': ['operator'], 'knowledge': ['worker'], 'order': ['order']}.get(name, [])
                    provision(module, *kind, admin_file, str(local / (name + '.json')), '--host', 'db')
            else:
                target = local / 'acceptance-logins.json'
                if target.exists():
                    raise SystemExit('Synthetic seed requires empty application data and a new private login file')
                tables = db.execute("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('deanery','agent_backend')").fetchall()
                for schema, table in tables:
                    if db.execute(sql.SQL('SELECT EXISTS(SELECT FROM {}.{})').format(sql.Identifier(schema), sql.Identifier(table))).fetchone()[0]:
                        raise SystemExit('Synthetic seed refuses existing application data')
                cursor = db.execute(Path('references/database/03_seed.sql').read_text(encoding='utf-8'), prepare=False)
                while cursor.nextset():
                    pass
                with db.transaction():
                    accounts = db.execute("SELECT DISTINCT ON (r.code) u.user_id,u.login,r.code FROM deanery.app_user u JOIN deanery.app_role r USING(role_id) WHERE u.is_active AND r.code IN ('admin','director','dean_staff','teacher','student') ORDER BY r.code,u.user_id").fetchall()
                    if len(accounts) != 5:
                        raise SystemExit('Synthetic acceptance accounts are incomplete')
                    logins = []
                    for user_id, login, role in accounts:
                        password = secrets.token_urlsafe(24)
                        db.execute('UPDATE deanery.app_user SET password_hash=%s WHERE user_id=%s', (hasher.hash(password), user_id))
                        logins.append({'login': login, 'password': password, 'role': role})
                    with target.open('x', encoding='utf-8') as stream:
                        json.dump(logins, stream, indent=2)
    print('Private ' + args.step + ' setup completed; no credentials printed')


if __name__ == '__main__':
    try:
        main()
    except psycopg.Error as exc:
        raise SystemExit('Database setup failed: ' + (exc.sqlstate or 'database_unavailable')) from None
