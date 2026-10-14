"""Narrow file HTTP and durable job checks against the isolated database."""
from pathlib import Path
from types import SimpleNamespace
import tempfile
from unittest.mock import patch
from uuid import uuid4

from backend.files import storage_path
from backend.tests.test_auth import DatabaseHttpCase
from psycopg.types.json import Jsonb


def test_attachment_capability_support_survives_provider_unavailability():
    import asyncio
    import httpx
    import json
    from backend.app import agent_capabilities
    from backend.agent_config import AgentSettings
    settings = AgentSettings(_env_file=None, base_url='http://127.0.0.1:1234/v1', OPENAI_API_KEY='fixture-key')
    from backend.service_status import calibration_fingerprint
    settings.prompt_fingerprint=calibration_fingerprint(settings.model,settings.base_url,settings.context_window)
    expected = {'protocol': 'deanery.attachments.v1', 'backend_supported': True, 'agent_supported': True,
                'agent_status': 'ready', 'max_attachments': 5, 'max_total_bytes': 20000000, 'max_text_chunks': 20}
    for outcome in ('ready', 'unreachable', 'wrong_context'):
        def handler(request):
            if request.url.path != '/api/v0/models':
                assert 'authorization' not in request.headers
                return httpx.Response(503, stream=httpx.ByteStream(b'{}'))
            assert str(request.url) == 'http://127.0.0.1:1234/api/v0/models'
            assert request.method == 'GET' and request.headers['authorization'] == 'Bearer fixture-key'
            if outcome == 'unreachable':
                raise httpx.ConnectError('provider unavailable', request=request)
            data = {'data': [{'id': settings.model, 'state': 'loaded',
                'loaded_context_length': 16384 if outcome == 'ready' else 4096}]}
            return httpx.Response(200, stream=httpx.ByteStream(json.dumps(data).encode()))
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch('backend.app.AgentSettings', return_value=settings), patch('backend.service_status.httpx.AsyncClient', return_value=client) as factory, patch('backend.service_status.worker_status', return_value='ready'):
            response = asyncio.run(agent_capabilities((SimpleNamespace(roles=['student']), None)))
            assert 'services' not in response
            actual = response['attachment_context']
        factory.assert_called_once_with(timeout=1.5, trust_env=False, follow_redirects=False)
        assert actual == expected | {'agent_status': 'ready' if outcome == 'ready' else 'unavailable'}


class FileTests(DatabaseHttpCase):
    def setUp(self):
        super().setUp()
        self.directory = tempfile.TemporaryDirectory(prefix='p10-files-')
        self.addCleanup(self.directory.cleanup)
        environment = patch.dict('os.environ', {'FILES_STORAGE_ROOT': self.directory.name})
        environment.start()
        self.addCleanup(environment.stop)
        self.headers = self.login('vasilyeva')

    def login(self, name):
        response = self.client.post('/api/v1/auth/login', json={'login': name, 'password': 'only-for-isolated-test'}, headers=self.origin)
        self.assertEqual(response.status_code, 200, response.text)
        return self.origin | {'Authorization': 'Bearer ' + response.json()['access_token']}

    def upload(self, data=b'Local attachment text', key=None, filename='document.txt', mime='text/plain'):
        return self.client.post('/api/v1/files', headers=self.headers | {'Idempotency-Key': str(key or uuid4())},
            data={'title': filename, 'purpose': 'attachment'}, files={'file': (filename, data, mime)})

    def test_upload_idempotency_original_download_and_foreign_access(self):
        key = uuid4()
        response = self.upload(key=key)
        self.assertEqual(response.status_code, 201, response.text)
        uploaded = response.json()
        originals_before = list((Path(self.directory.name) / 'originals').rglob('*'))
        repeated = self.upload(key=key)
        self.assertEqual(repeated.json()['version_id'], uploaded['version_id'])
        self.assertEqual(self.upload(b'changed', key).status_code, 409)
        self.assertEqual(list((Path(self.directory.name) / 'originals').rglob('*')), originals_before)
        path = f'/api/v1/files/{uploaded["file_id"]}/versions/{uploaded["version_id"]}/download'
        original = self.client.get(path, headers=self.headers)
        self.assertEqual(original.content, b'Local attachment text')
        self.assertEqual(original.headers['cache-control'], 'private, no-store')
        stranger = self.login('ivanov.ks')
        self.assertEqual(self.client.get(path, headers=stranger).status_code, 404)
        self.assertEqual(self.client.get('/api/v1/jobs/' + uploaded['job']['id'], headers=stranger).status_code, 404)
        job = self.client.get('/api/v1/jobs/' + uploaded['job']['id'], headers=self.headers).json()
        self.assertEqual(job['status'], 'queued')
        self.assertNotIn('storage_key', str(job))
        self.assertNotIn('lease_owner', job)

    def test_auth_and_stream_limits_and_signatures(self):
        with patch('backend.files.upload', side_effect=AssertionError('unauthorized body consumed')):
            response = self.client.post('/api/v1/files', headers=self.origin | {'Idempotency-Key': str(uuid4())}, content=b'private')
            self.assertEqual(response.status_code, 401)
        self.assertEqual(self.upload(b'fake', filename='fake.pdf', mime='application/pdf').status_code, 422)
        self.assertEqual(self.upload(b'').status_code, 422)
        self.assertEqual(self.upload(b'x' * 10_000_001).status_code, 413)
        self.assertEqual(self.upload(b'a', filename='../bad.txt').status_code, 422)
        boundary = 'limited'
        def malicious():
            yield ('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="large.txt"\r\nContent-Type: text/plain\r\n\r\n').encode()
            for _ in range(160):
                yield b'x' * 65536
        response = self.client.post('/api/v1/files', content=malicious(), headers=self.headers | {
            'Idempotency-Key': str(uuid4()), 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': '1'})
        self.assertEqual(response.status_code, 413, response.text)

    def test_job_lease_reclaim_stale_publish_and_original_guard(self):
        response = self.upload()
        self.assertEqual(response.status_code, 201, response.text)
        uploaded = response.json()
        first, second = uuid4(), uuid4()
        self.db.execute('RESET ROLE')
        claim = self.db.execute('SELECT backend_api.claim_file_job(%s) AS result', (first,)).fetchone()['result']
        self.assertEqual(str(claim['job_id']), uploaded['job']['id'])
        self.db.execute("UPDATE agent_backend.job SET lease_until=now()-interval '1 second' WHERE id=%s", (uploaded['job']['id'],))
        reclaimed = self.db.execute('SELECT backend_api.claim_file_job(%s) AS result', (second,)).fetchone()['result']
        self.assertEqual(reclaimed['attempts'], 2)
        summary = {'total_units': 2, 'completed_units': 1, 'total_chunks': 1,
                   'coverage': {'total_pages': 2, 'attempted_pages': 1, 'complete': False}, 'warnings': ['page_timeout']}
        with self.assertRaises(Exception):
            with self.db.transaction():
                self.db.execute('SELECT backend_api.checkpoint_file_job(%s,%s,%s,%s)', (uploaded['job']['id'], first, Jsonb(summary), 'partial'))
        result = self.db.execute('SELECT backend_api.checkpoint_file_job(%s,%s,%s,%s) AS result', (uploaded['job']['id'], second, Jsonb(summary), 'partial')).fetchone()['result']
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['result']['extraction_state'], 'partial')
        with self.assertRaises(Exception):
            with self.db.transaction():
                self.db.execute("UPDATE agent_backend.file_version SET original_name='changed.txt' WHERE id=%s", (uploaded['version_id'],))
        self.db.execute('SET LOCAL ROLE backend_api')
        job = self.client.get('/api/v1/jobs/' + uploaded['job']['id'], headers=self.headers).json()
        self.assertEqual(job['progress'], 50)
        self.assertEqual(job['result']['coverage']['complete'], False)

    def test_transient_storage_failure_requeues_preserved_checkpoint(self):
        from contextlib import contextmanager
        from types import SimpleNamespace
        from backend.file_worker import run_once
        uploaded = self.upload().json()
        self.db.execute('RESET ROLE')
        worker = uuid4()
        @contextmanager
        def connect():
            with self.db.transaction():
                yield self.db
        settings = SimpleNamespace(connect=connect, storage_root=Path(self.directory.name))
        retained = {'total_units': 2, 'completed_units': 1, 'total_chunks': 1,
                    'coverage': {'complete': False}, 'warnings': [], 'artifact_key': 'preserved-checkpoint'}
        def first_attempt(settings, descriptor, checkpoint, check):
            checkpoint(retained, 'processing', None)
            raise OSError('temporary private disk failure')
        with patch('backend.file_worker.process_document', side_effect=first_attempt):
            result = run_once(settings, worker)
        self.assertEqual(result['status'], 'queued')
        self.assertEqual(result['attempts'], 1)
        self.db.execute("UPDATE agent_backend.job SET available_at=now()-interval '1 second' WHERE id=%s", (uploaded['job']['id'],))
        summary = {'total_units': 1, 'completed_units': 1, 'total_chunks': 1, 'coverage': {'complete': True}, 'warnings': []}
        def next_attempt(settings, descriptor, checkpoint, check):
            self.assertEqual(descriptor['extraction'], retained)
            return checkpoint(summary, 'ready', None)
        with patch('backend.file_worker.process_document', side_effect=next_attempt):
            result = run_once(settings, worker)
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['attempts'], 2)
        self.assertEqual(result['result']['extraction_state'], 'ready')
