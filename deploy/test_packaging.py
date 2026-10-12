"""Offline checks for deployment guards; no PostgreSQL, Docker, or model calls."""
import importlib
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, mock_open, patch
from uuid import uuid4

from deploy import run_service, setup_database


ROOT = Path(__file__).resolve().parents[1]


class ProvisionerTests(unittest.TestCase):
    def test_hosts_preserve_admin_connection_and_narrow_grants(self):
        cases = (('api', [], 'backend_api'), ('agent', [], 'backend_executor'),
                 ('files', [], 'claim_file_job'), ('knowledge', ['worker'], 'claim_knowledge_job'),
                 ('deployment', ['migration'], 'backend_migration'), ('deployment', ['order'], 'backend_worker'))
        for name, kind, grant in cases:
            with self.subTest(name=name, kind=kind):
                admin = {'host': 'admin-host', 'port': 5432, 'dbname': 'isolated', 'user': 'admin', 'password': 'CANARY-admin-secret'}
                source, target = ROOT / 'admin.json', ROOT / '.local/p13-deploy-mock-runtime.json'
                module = importlib.import_module('backend.db.provision_local_' + name)
                connection = MagicMock()
                output_file = mock_open()
                with patch.object(Path, 'exists', return_value=False), patch.object(Path, 'read_text', return_value=json.dumps(admin)), patch.object(Path, 'open', output_file), patch.object(module.psycopg, 'connect', return_value=connection) as connect, patch('sys.argv', ['provision', *kind, str(source), str(target), '--host', 'db']), patch('builtins.print') as output:
                    module.main()
                connect.assert_called_once_with(**admin)
                output_file.assert_called_once_with('x', encoding='utf-8')
                runtime = json.loads(''.join(call.args[0] for call in output_file().write.call_args_list))
                self.assertEqual(runtime['host'], 'db')
                self.assertNotEqual(runtime['password'], admin['password'])
                statements = '\n'.join(call.args[0].as_string() for call in connection.__enter__.return_value.execute.call_args_list)
                self.assertIn(grant, statements)
                self.assertIn('NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', statements)
                if name in ('files', 'knowledge'):
                    self.assertNotIn('GRANT backend_worker', statements)
                    self.assertNotIn('GRANT backend_executor', statements)
                self.assertNotIn(admin['password'], str(output.call_args_list))
                with patch.object(Path, 'exists', return_value=True), patch.object(Path, 'open') as write, patch.object(module.psycopg, 'connect') as connect, patch('sys.argv', ['provision', *kind, str(source), str(target), '--host', 'db']):
                    with self.assertRaises(SystemExit):
                        module.main()
                connect.assert_not_called()
                write.assert_not_called()

    def test_target_outside_private_directory_is_rejected_before_connect(self):
        module = importlib.import_module('backend.db.provision_local_deployment')
        with patch.object(module.psycopg, 'connect') as connect, patch('sys.argv', ['provision', 'order', 'missing-admin.json', str(ROOT / 'p13-deploy-forbidden.json')]):
            with self.assertRaises(SystemExit):
                module.main()
        connect.assert_not_called()


class EntrypointTests(unittest.TestCase):
    def test_private_connection_is_environment_only_and_exec_preserves_worker(self):
        parameters = {'host': 'db', 'port': 5432, 'dbname': 'deanery_p13', 'user': 'narrow', 'password': 'CANARY-runtime-secret'}
        for service, variable, expected in (('api', 'DATABASE_URL', 'backend.app:app'), ('order', 'WORKER_DATABASE_URL', 'backend.order_worker')):
            with self.subTest(service=service), patch.object(Path, 'read_text', return_value=json.dumps(parameters)), patch('sys.argv', ['run_service', service]), patch.dict(os.environ, {}, clear=True), patch.object(run_service.os, 'execv') as execute:
                run_service.main()
                self.assertIn(parameters['password'], os.environ[variable])
                self.assertIn(expected, execute.call_args.args[1])
                self.assertNotIn(parameters['password'], str(execute.call_args))

    def test_invalid_private_configuration_fails_without_secret_output(self):
        for data in ('CANARY-invalid-secret', json.dumps({'password': 'CANARY-invalid-secret'}), json.dumps({'host': 'db', 'port': 0, 'dbname': 'x', 'user': 'x', 'password': 'CANARY-invalid-secret'})):
            with self.subTest(data=data), patch.object(Path, 'read_text', return_value=data), patch('sys.argv', ['run_service', 'api']), patch.object(run_service.os, 'execv') as execute:
                with self.assertRaises(SystemExit) as error:
                    run_service.main()
                self.assertNotIn('CANARY', str(error.exception))
                execute.assert_not_called()

    def test_setup_rejects_wrong_target_and_nonempty_bootstrap(self):
        with patch.object(Path, 'read_text', return_value=json.dumps({'host': 'shared', 'dbname': 'live'})), patch('sys.argv', ['setup', 'bootstrap']), patch.object(setup_database.psycopg, 'connect') as connect:
            with self.assertRaises(SystemExit):
                setup_database.main()
            connect.assert_not_called()
        connection = MagicMock()
        connection.__enter__.return_value.execute.return_value.fetchone.return_value = (1,)
        with patch.object(Path, 'read_text', return_value=json.dumps({'host': 'db', 'dbname': 'deanery_p13'})), patch.object(Path, 'is_dir', return_value=True), patch.object(Path, 'exists', return_value=False), patch('sys.argv', ['setup', 'bootstrap']), patch.object(setup_database.psycopg, 'connect', return_value=connection), patch.object(setup_database, 'provision') as provision:
            with self.assertRaises(SystemExit):
                setup_database.main()
            provision.assert_not_called()
            self.assertEqual(connection.__enter__.return_value.execute.call_count, 1)

    def test_runtime_setup_dispatches_existing_narrow_provisioners_only(self):
        connection = MagicMock()
        db = connection.__enter__.return_value
        db.execute.return_value.fetchone.side_effect = [('current-head',), (71,)]
        with patch.object(Path, 'read_text', return_value=json.dumps({'host': 'db', 'dbname': 'deanery_p13'})), patch.object(Path, 'is_dir', return_value=True), patch.object(Path, 'exists', return_value=False), patch('sys.argv', ['setup', 'runtime']), patch.object(setup_database.psycopg, 'connect', return_value=connection), patch.object(setup_database.ScriptDirectory, 'from_config') as source, patch.object(setup_database, 'provision') as provision:
            source.return_value.get_current_head.return_value = 'current-head'
            setup_database.main()
        self.assertEqual(provision.call_count, 6)
        self.assertEqual([call.args[0] for call in provision.call_args_list], ['backend.db.provision_local_api', 'backend.db.provision_local_agent', 'backend.db.provision_local_files', 'backend.db.provision_local_knowledge', 'backend.db.provision_local_knowledge', 'backend.db.provision_local_deployment'])
        self.assertTrue(all(call.args[-2:] == ('--host', 'db') for call in provision.call_args_list))

    def test_seed_refuses_existing_data_in_any_application_table(self):
        connection = MagicMock()
        db = connection.__enter__.return_value
        db.execute.return_value.fetchone.side_effect = [('current-head',), (71,), (True,)]
        db.execute.return_value.fetchall.return_value = [('agent_backend', 'regulation_version')]
        with patch.object(Path, 'read_text', return_value=json.dumps({'host': 'db', 'dbname': 'deanery_p13'})), patch.object(Path, 'is_dir', return_value=True), patch.object(Path, 'exists', return_value=False), patch.object(Path, 'open') as write, patch('sys.argv', ['setup', 'synthetic-seed']), patch.object(setup_database.psycopg, 'connect', return_value=connection), patch.object(setup_database.ScriptDirectory, 'from_config') as source, patch.object(setup_database, 'hasher') as hasher:
            source.return_value.get_current_head.return_value = 'current-head'
            with self.assertRaises(SystemExit):
                setup_database.main()
        hasher.hash.assert_not_called()
        write.assert_not_called()
        self.assertEqual(db.execute.call_count, 4)

    def test_subprocess_setup_failure_does_not_print_private_output(self):
        with patch.object(setup_database.subprocess, 'run', return_value=MagicMock(returncode=1, stdout=b'CANARY-secret', stderr=b'CANARY-secret')):
            with self.assertRaises(SystemExit) as error:
                setup_database.provision('backend.db.provision_local_api', 'private.json')
        self.assertNotIn('CANARY', str(error.exception))


class SourceTests(unittest.TestCase):
    def test_setup_commands_launch_the_importable_module_and_operator_runbook(self):
        compose = (ROOT / 'compose.yaml').read_text()
        for step in ('bootstrap', 'runtime', 'synthetic-seed'):
            self.assertIn(f'command: [python, -m, deploy.setup_database, {step}]', compose)
        result = subprocess.run([sys.executable, '-m', 'deploy.setup_database', '--help'], cwd=ROOT, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertIn(b'bootstrap', result.stdout)
        self.assertIn('operator python -m backend.regulations <existing CLI arguments>', (ROOT / 'deploy/README.md').read_text())

    def test_backend_context_whitelist_has_no_private_or_extra_reference_expansion(self):
        lines = (ROOT / 'backend/Dockerfile.dockerignore').read_text().splitlines()
        self.assertEqual(lines[0], '**')
        includes = [line[1:] for line in lines if line.startswith('!')]
        allowed = {path.relative_to(ROOT).as_posix() for pattern in includes for path in ROOT.glob(pattern) if path.is_file()}
        self.assertIn('references/database/03_seed.sql', allowed)
        self.assertEqual({name for name in allowed if name.startswith('references/')}, {'references/database/03_seed.sql'})
        self.assertEqual({name for name in allowed if name.startswith('deploy/')}, {'deploy/run_service.py', 'deploy/setup_database.py'})
        self.assertIn('backend/db/migrations/sql/030_discipline_lookup.sql', allowed)
        self.assertFalse(any(part in name for name in allowed for part in ('.local/', 'private.local/', 'node_modules/', '.venv/', '__pycache__/', '/tests/')))
        for ancestor in ('backend', 'backend/db', 'backend/db/migrations', 'backend/db/migrations/versions', 'backend/db/migrations/sql', 'deploy', 'references', 'references/database'):
            self.assertLess(lines.index('!' + ancestor + '/'), lines.index(ancestor + '/**'))
        self.assertNotIn('!deploy/**', lines)

    def test_proxy_keeps_api_path_secure_origin_and_stream_delivery(self):
        config = (ROOT / 'deploy/nginx.conf').read_text()
        self.assertIn('proxy_pass http://api:8000;', config)
        for setting in ('proxy_buffering off;', 'proxy_cache off;', 'proxy_read_timeout 900s;', 'proxy_send_timeout 900s;', 'listen 8443 ssl;', 'access_log off;'):
            self.assertIn(setting, config)
        compose = (ROOT / 'compose.yaml').read_text()
        self.assertIn('127.0.0.1:8443:8443', compose)
        self.assertNotIn('DEANERY_DEV_INSECURE_COOKIE', compose)
        self.assertNotIn('POSTGRES_PASSWORD:', compose)
        self.assertEqual((ROOT / 'frontend/.dockerignore').read_bytes(), (ROOT / 'frontend/Dockerfile.dockerignore').read_bytes())


class PublicationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / '.local').mkdir(exist_ok=True)

    def test_upload_stages_inside_originals_and_cleans_success_and_retry(self):
        from backend import files
        data = b'Local publication fixture'
        boundary = 'p13-publication'
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nfixture\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nattachment\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.txt"\r\n'
                f'Content-Type: text/plain\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
        async def stream():
            yield body
        request = SimpleNamespace(headers={'Content-Type': f'multipart/form-data; boundary={boundary}'}, stream=stream)
        db, result, publications = MagicMock(), {'file_id': str(uuid4()), 'version_id': str(uuid4())}, []
        db.execute.return_value.fetchone.side_effect = [{'result': None}, {'result': result}, {'result': result}]
        rename = Path.rename
        def publish(source, target):
            publications.append((source, target))
            return rename(source, target)
        with tempfile.TemporaryDirectory(dir=ROOT / '.local', prefix='p13-deploy-publication-') as directory:
            root = Path(directory)
            with patch.dict(os.environ, {'FILES_STORAGE_ROOT': directory}), patch.object(Path, 'rename', new=publish):
                self.assertEqual(asyncio.run(files.upload(request, db, 'fixture-token', uuid4())), result)
                self.assertEqual(asyncio.run(files.upload(request, db, 'fixture-token', uuid4())), result)
            self.assertEqual(len(publications), 1)
            source, target = publications[0]
            self.assertEqual(source.relative_to(root).parts[:2], ('originals', '.staging'))
            self.assertEqual(target.relative_to(root).parts[0], 'originals')
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(list((root / 'originals/.staging').iterdir()), [])
            self.assertFalse((root / 'staging').exists())

    def test_regulation_stages_inside_regulations_and_keeps_hash_guard(self):
        from backend import regulations
        from backend.file_parser import AttachmentError
        descriptor = {'regulation_id': str(uuid4()), 'version_id': str(uuid4()), 'storage_key': 'regulations/fixture/version/original'}
        db, context, publications = MagicMock(), MagicMock(), []
        context.__enter__.return_value = db
        db.execute.return_value.fetchone.side_effect = [{'result': descriptor}, {'result': {'id': 'fixture-job'}},
                                                       {'result': descriptor}, {'result': {'id': 'fixture-job'}}, {'result': descriptor}]
        link = os.link
        def publish(source, target):
            publications.append((source, target))
            link(source, target)
        with tempfile.TemporaryDirectory(dir=ROOT / '.local', prefix='p13-deploy-publication-') as directory:
            root = Path(directory)
            path = root / 'fixture.txt'
            path.write_bytes(b'Local regulation fixture')
            settings = SimpleNamespace(storage_root=root, connect=lambda: context)
            key = uuid4()
            with patch.object(regulations.os, 'link', new=publish):
                result = regulations.import_regulation(settings, path, {}, key, 'fixture-token')
                self.assertEqual(regulations.import_regulation(settings, path, {}, key, 'fixture-token'), result)
            self.assertEqual(len(publications), 1)
            source, target = publications[0]
            self.assertEqual(source.relative_to(root).parts[:2], ('regulations', '.staging'))
            self.assertEqual(target.relative_to(root).parts[0], 'regulations')
            self.assertEqual(target.read_bytes(), path.read_bytes())
            self.assertEqual(list((root / 'regulations/.staging').iterdir()), [])
            self.assertFalse((root / 'staging').exists())
            target.write_bytes(b'Tampered fixture')
            with self.assertRaisesRegex(AttachmentError, 'original_integrity_error'):
                regulations.import_regulation(settings, path, {}, key, 'fixture-token')
            self.assertEqual(target.read_bytes(), b'Tampered fixture')


if __name__ == '__main__':
    unittest.main()
