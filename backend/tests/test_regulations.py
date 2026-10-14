"""Focused private operator, digital extraction, lease and generation checks."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest

from backend.file_parser import AttachmentError, extract_text_document
from backend.files import storage_path
from backend.knowledge_worker import process_version
from backend.regulations import import_regulation
from backend.tests.test_auth import DatabaseHttpCase


class RegulationTests(DatabaseHttpCase):
    def setUp(self):
        super().setUp()
        temporary = tempfile.TemporaryDirectory(prefix='p11-regulations-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'source.txt'
        self.source.write_text('Подтверждённый нормативный источник.\nСрок указан в точном тексте.', encoding='utf-8')
        self.token = self.access('vasilyeva')
        self.db.execute('RESET ROLE')
        @contextmanager
        def connect():
            with self.db.transaction():
                yield self.db
        self.settings = SimpleNamespace(storage_root=self.root / 'private', connect=connect,
            embedding_revision='5617a9f61b028005a4858fdac845db406aefb181')
        self.metadata = {'title': 'Положение: тест', 'source': 'Официальный проверочный источник', 'version_label': 'test-v1',
                         'source_url': 'https://example.edu/regulation', 'published_date': None, 'effective_date': None,
                         'scope': {'global': True, 'institute_ids': []}}

    def access(self, name):
        response = self.client.post('/api/v1/auth/login', json={'login': name, 'password': 'only-for-isolated-test'}, headers=self.origin)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['access_token']

    def sql(self, name, *args):
        return self.db.execute('SELECT backend_api.' + name + '(' + ','.join(['%s'] * len(args)) + ') AS result', args).fetchone()['result']

    def importing(self, key=None, metadata=None):
        return import_regulation(self.settings, self.source, metadata or self.metadata, key or uuid4(), self.token)

    def work(self, uploaded, indexer=None):
        worker = uuid4()
        claim = self.sql('claim_knowledge_job', worker)
        self.assertEqual(claim['version']['version_id'], uploaded['version_id'])
        def call(name, *args):
            return self.sql(name, claim['job_id'], worker, *args)
        def extractor(operation, number=1):
            from backend.file_parser import extract_unit, inspect_document
            d = claim['version']
            path = storage_path(d['storage_key'], self.settings.storage_root)
            if operation == 'inspect':
                return inspect_document(path, d['mime'])
            if operation == 'text':
                return extract_text_document(path, d['mime'], d['version_id'], digital_only=True)
            return extract_unit(path, d['mime'], number, d['version_id'], digital_only=True)
        def verified(descriptor, chunks, generation, **kwargs):
            kwargs['check']()
            return {'generation_id': generation, 'chunk_count': len(chunks),
                    'manifest_hash': hashlib.sha256('\n'.join(c['chunk_id'] + ':' + c['text_hash'] for c in chunks).encode()).hexdigest(),
                    'model_revision': self.settings.embedding_revision}
        result = process_version(self.settings, claim, call, extractor=extractor, indexer=indexer or verified)
        return result, claim, worker

    def test_import_idempotency_storage_metadata_and_authority(self):
        key = uuid4()
        uploaded = self.importing(key)
        original_count = len(list(self.settings.storage_root.rglob('original')))
        self.assertEqual(self.importing(key), uploaded)
        self.assertEqual(len(list(self.settings.storage_root.rglob('original'))), original_count)
        descriptor = self.sql('get_regulation_version', uploaded['version_id'], self.token)
        self.assertIsNone(descriptor['metadata']['published_date'])
        self.assertIsNone(descriptor['published_at'])
        with self.assertRaises(psycopg.Error), self.db.transaction():
            self.importing(key, self.metadata | {'version_label': 'changed'})
        with self.assertRaises(psycopg.errors.InsufficientPrivilege), self.db.transaction():
            self.sql('get_regulation_version', uploaded['version_id'], 'forged-admin-token')
        staff = self.access('kuznetsova')
        with self.assertRaises(psycopg.errors.InsufficientPrivilege), self.db.transaction():
            self.sql('queue_regulation', uploaded['version_id'], uuid4(), staff)
        self.db.execute('SET LOCAL ROLE backend_api')
        with self.assertRaises(psycopg.errors.InsufficientPrivilege), self.db.transaction():
            self.sql('get_regulation_version', uploaded['version_id'], self.token)
        self.db.execute('RESET ROLE')
        for role in ('backend_api', 'backend_worker', 'backend_executor', 'backend_read'):
            self.assertFalse(self.db.execute("SELECT has_function_privilege(%s,'backend_api.publish_knowledge_job(uuid,uuid,jsonb)','EXECUTE') AS allowed", (role,)).fetchone()['allowed'])
        self.assertEqual(self.db.execute("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema IN ('deanery','agent_backend') AND table_type='BASE TABLE'").fetchone()['n'], 72)

    def test_complete_digital_publish_failed_reindex_preserves_generation_and_withdraws(self):
        uploaded = self.importing()
        result, claim, worker = self.work(uploaded)
        self.assertEqual(result['status'], 'succeeded')
        version = self.sql('get_regulation_version', uploaded['version_id'], self.token)
        self.assertEqual(version['published_by'], self.user_id)
        self.assertEqual(version['metadata']['active_index_generation'], claim['generation_id'])
        chunk = self.db.execute('SELECT id,text FROM agent_backend.regulation_chunk WHERE version_id=%s ORDER BY sequence LIMIT 1', (uploaded['version_id'],)).fetchone()
        self.assertEqual(self.db.execute('SELECT agent_backend.regulation_chunk_evidence(%s,%s,%s) AS result', (chunk['id'], self.user_id, claim['generation_id'])).fetchone()['result']['text'], chunk['text'])
        reindex = self.sql('queue_regulation', uploaded['version_id'], uuid4(), self.token)
        other_worker = uuid4()
        other = self.sql('claim_knowledge_job', other_worker)
        self.assertNotEqual(other['generation_id'], claim['generation_id'])
        failed = self.sql('fail_knowledge_job', reindex['id'], other_worker, 'knowledge_index_unavailable', False)
        self.assertEqual(failed['status'], 'failed')
        current = self.sql('get_regulation_version', uploaded['version_id'], self.token)
        self.assertEqual(current['metadata']['active_index_generation'], claim['generation_id'])
        self.assertEqual(current['published_at'], version['published_at'])
        self.assertEqual(current['scope'], self.metadata['scope'])
        self.assertTrue(self.db.execute('SELECT agent_backend.regulation_version_visible(%s,%s) AS visible', (uploaded['version_id'], self.user_id)).fetchone()['visible'])
        for statement in ("UPDATE agent_backend.regulation_chunk SET text='changed' WHERE version_id=%s",
                          "UPDATE agent_backend.regulation_version SET source='changed' WHERE id=%s",
                          "UPDATE agent_backend.regulation_version SET metadata=jsonb_set(metadata,'{scope}', '{\"global\":false,\"institute_ids\":[1]}') WHERE id=%s"):
            with self.assertRaises(psycopg.errors.CheckViolation), self.db.transaction():
                self.db.execute(statement, (uploaded['version_id'],))
        self.sql('withdraw_regulation', uploaded['version_id'], 'Источник отозван', self.token)
        self.assertIsNone(self.db.execute('SELECT agent_backend.regulation_chunk_evidence(%s,%s,%s) AS result', (chunk['id'], self.user_id, claim['generation_id'])).fetchone()['result'])
        with self.assertRaises(psycopg.Error), self.db.transaction():
            self.sql('queue_regulation', uploaded['version_id'], uuid4(), self.token)

    def test_lease_recovery_same_generation_stale_publish_and_receipt_rejected(self):
        uploaded = self.importing()
        first, second = uuid4(), uuid4()
        claim = self.sql('claim_knowledge_job', first)
        self.db.execute("UPDATE agent_backend.job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=%s", (claim['job_id'],))
        reclaimed = self.sql('claim_knowledge_job', second)
        self.assertEqual(claim['generation_id'], reclaimed['generation_id'])
        with self.assertRaises(psycopg.Error), self.db.transaction():
            self.sql('publish_knowledge_job', claim['job_id'], first, Jsonb({}))
        with self.assertRaises(psycopg.Error), self.db.transaction():
            self.sql('publish_knowledge_job', claim['job_id'], second, Jsonb({'generation_id': claim['generation_id']}))
        self.sql('fail_knowledge_job', claim['job_id'], second, 'knowledge_index_unavailable', True)
        current = self.sql('get_regulation_version', uploaded['version_id'], self.token)
        self.assertEqual(current['job']['status'], 'queued')
        self.assertIsNone(current['published_at'])
        self.assertTrue(storage_path(current['storage_key'], self.settings.storage_root).is_file())

    def test_partial_digital_source_never_indexes_and_original_integrity_is_checked(self):
        uploaded = self.importing()
        worker = uuid4()
        claim = self.sql('claim_knowledge_job', worker)
        def call(name, *args): return self.sql(name, claim['job_id'], worker, *args)
        def partial(operation, number=1):
            d = claim['version']
            value = extract_text_document(storage_path(d['storage_key'], self.settings.storage_root), d['mime'], d['version_id'])
            value['warnings'] = ['docx_images_not_extracted']
            return value
        result = process_version(self.settings, claim, call, extractor=partial, indexer=lambda *a, **k: self.fail('partial indexed'))
        self.assertEqual(result['status'], 'failed')
        self.assertIsNone(self.sql('get_regulation_version', uploaded['version_id'], self.token)['published_at'])
        self.sql('queue_regulation', uploaded['version_id'], uuid4(), self.token)
        claim = self.sql('claim_knowledge_job', worker)
        storage_path(claim['version']['storage_key'], self.settings.storage_root).write_bytes(b'tampered')
        with self.assertRaisesRegex(AttachmentError, 'original_integrity_error'):
            process_version(self.settings, claim, call, indexer=lambda *a, **k: self.fail('tampered indexed'))

    def test_mixed_pdf_digital_heading_and_scan_remain_unpublished(self):
        import io
        import pymupdf
        from PIL import Image, ImageDraw
        from backend.file_parser import extract_unit, inspect_document
        bitmap = io.BytesIO()
        scanned = Image.new('RGB', (500, 200), 'white')
        ImageDraw.Draw(scanned).text((15, 40), 'Scanned normative conditions only in raster', fill='black')
        scanned.save(bitmap, 'PNG')
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((40, 40), 'Short digital heading')
        page.insert_image(pymupdf.Rect(40, 80, 540, 280), stream=bitmap.getvalue())
        self.source = self.root / 'mixed.pdf'
        document.save(self.source)
        document.close()
        uploaded = self.importing()
        worker = uuid4()
        claim = self.sql('claim_knowledge_job', worker)
        def call(name, *args): return self.sql(name, claim['job_id'], worker, *args)
        def extractor(operation, number=1):
            d = claim['version']
            path = storage_path(d['storage_key'], self.settings.storage_root)
            return inspect_document(path, d['mime']) if operation == 'inspect' else extract_unit(path, d['mime'], number, d['version_id'], digital_only=True)
        with patch('backend.file_parser.ocr_page', side_effect=AssertionError('operator OCR outside scope')):
            result = process_version(self.settings, claim, call, extractor=extractor, indexer=lambda *a, **k: self.fail('mixed scan indexed'))
        self.assertEqual(result['status'], 'failed')
        version = self.sql('get_regulation_version', uploaded['version_id'], self.token)
        self.assertIsNone(version['published_at'])
        self.assertFalse(version['extraction']['coverage']['complete'])
        self.assertIn('digital_source_incomplete', version['extraction']['warnings'])

    def test_candidate_crash_recovery_and_successful_reindex_reuse_sealed_chunks(self):
        from backend.vector_search import KnowledgeError
        uploaded = self.importing()
        written = []
        def crash(descriptor, chunks, generation, **kwargs):
            written.append((generation, [c['chunk_id'] for c in chunks]))
            raise KnowledgeError('knowledge_index_unavailable')
        with self.assertRaises(KnowledgeError):
            self.work(uploaded, crash)
        before = self.sql('get_regulation_version', uploaded['version_id'], self.token)
        self.assertIsNone(before['published_at'])
        self.assertTrue(before['metadata']['chunk_manifest'])
        self.db.execute("UPDATE agent_backend.job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=%s", (uploaded['job']['id'],))
        result, recovered, _ = self.work(uploaded)
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(recovered['generation_id'], written[0][0])
        ids = [str(row['id']) for row in self.db.execute('SELECT id FROM agent_backend.regulation_chunk WHERE version_id=%s ORDER BY sequence', (uploaded['version_id'],))]
        self.assertEqual(ids, written[0][1])
        self.sql('queue_regulation', uploaded['version_id'], uuid4(), self.token)
        _, reindexed, _ = self.work(uploaded)
        after = self.sql('get_regulation_version', uploaded['version_id'], self.token)
        self.assertNotEqual(reindexed['generation_id'], written[0][0])
        self.assertEqual(after['metadata']['active_index_generation'], reindexed['generation_id'])
        self.assertEqual(after['metadata']['chunk_manifest'], before['metadata']['chunk_manifest'])

    def test_exhausted_reindex_lease_reports_failed_and_retains_active_generation(self):
        uploaded = self.importing()
        _, published, _ = self.work(uploaded)
        queued = self.sql('queue_regulation', uploaded['version_id'], uuid4(), self.token)
        self.sql('claim_knowledge_job', uuid4())
        self.db.execute("UPDATE agent_backend.job SET attempts=max_attempts,lease_until=clock_timestamp()-interval '1 second' WHERE id=%s", (queued['id'],))
        self.assertIsNone(self.sql('claim_knowledge_job', uuid4()))
        current = self.sql('get_regulation_version', uploaded['version_id'], self.token)
        self.assertEqual(current['processing_state'], 'failed')
        self.assertEqual(self.sql('get_regulation_version', uploaded['version_id'], self.token)['metadata']['active_index_generation'], published['generation_id'])
        failed = self.db.execute('SELECT status,error_code FROM agent_backend.job WHERE id=%s', (queued['id'],)).fetchone()
        self.assertEqual(failed, {'status': 'failed', 'error_code': 'lease_exhausted'})
        self.assertTrue(self.db.execute('SELECT agent_backend.regulation_version_visible(%s,%s) AS visible', (uploaded['version_id'], self.user_id)).fetchone()['visible'])

    def test_inline_raster_pdf_is_partial_and_attachment_still_selects_ocr(self):
        import pymupdf
        import zlib
        from PIL import Image, ImageDraw
        from backend.file_parser import extract_unit
        scanned = Image.new('RGB', (500, 200), 'white')
        ImageDraw.Draw(scanned).text((15, 40), 'Substantive scanned condition', fill='black')
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((40, 40), 'Short heading')
        xref = page.get_contents()[0]
        inline = b'\nq 500 0 0 200 40 100 cm BI /W 500 /H 200 /BPC 8 /CS /RGB /F /Fl ID ' + zlib.compress(scanned.tobytes()) + b' EI Q\n'
        document.update_stream(xref, document.xref_stream(xref) + inline)
        self.source = self.root / 'inline.pdf'
        document.save(self.source)
        document.close()
        with pymupdf.open(self.source) as checked:
            self.assertFalse(checked[0].get_images(full=True))
            self.assertTrue(checked[0].get_image_info())
        uploaded = self.importing()
        with patch('backend.file_parser.ocr_page', side_effect=AssertionError('operator OCR outside scope')):
            result, _, _ = self.work(uploaded, lambda *a, **k: self.fail('inline source indexed'))
        self.assertEqual(result['status'], 'failed')
        current = self.sql('get_regulation_version', uploaded['version_id'], self.token)
        self.assertIsNone(current['published_at'])
        self.assertIn('digital_source_incomplete', current['extraction']['warnings'])
        with patch('backend.file_parser.ocr_page', return_value=('Recovered full condition', 95, [])) as ocr:
            attachment = extract_unit(self.source, 'application/pdf', 1, uploaded['version_id'])
        ocr.assert_called_once()
        self.assertEqual(attachment['state'], 'ocr')

    def test_docx_substantive_footnote_remains_partial_and_unpublished(self):
        import zipfile
        self.source = self.root / 'footnotes.docx'
        with zipfile.ZipFile(self.source, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Permitted subject to condition</w:t><w:footnoteReference w:id="1"/></w:r></w:p></w:body></w:document>')
            archive.writestr('word/footnotes.xml', '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>Only after written approval</w:t></w:r></w:p></w:footnote></w:footnotes>')
        uploaded = self.importing()
        result, _, _ = self.work(uploaded, lambda *a, **k: self.fail('omitted footnote indexed'))
        self.assertEqual(result['status'], 'failed')
        current = self.sql('get_regulation_version', uploaded['version_id'], self.token)
        self.assertIsNone(current['published_at'])
        self.assertIn('docx_parts_not_extracted', current['extraction']['warnings'])

    def test_scope_rechecks_current_institute_account_and_generation(self):
        staff_id = self.db.execute("SELECT user_id FROM deanery.app_user WHERE login='kuznetsova'").fetchone()['user_id']
        institutes = self.db.execute('SELECT institute_ids FROM backend_api.account_snapshot(%s)', (staff_id,)).fetchone()['institute_ids']
        foreign = self.db.execute('SELECT institute_id FROM deanery.institute WHERE NOT (institute_id=ANY(%s)) LIMIT 1', (institutes,)).fetchone()['institute_id']
        uploaded = self.importing(metadata=self.metadata | {'scope': {'global': False, 'institute_ids': [foreign]}})
        _, claim, _ = self.work(uploaded)
        chunk_id = self.db.execute('SELECT id FROM agent_backend.regulation_chunk WHERE version_id=%s LIMIT 1', (uploaded['version_id'],)).fetchone()['id']
        self.assertIsNone(self.db.execute('SELECT agent_backend.regulation_chunk_evidence(%s,%s,%s) AS result', (chunk_id, staff_id, claim['generation_id'])).fetchone()['result'])
        self.assertIsNone(self.db.execute('SELECT agent_backend.regulation_chunk_evidence(%s,%s,%s) AS result', (chunk_id, self.user_id, uuid4())).fetchone()['result'])
        self.db.execute('UPDATE deanery.app_user SET is_active=false WHERE user_id=%s', (self.user_id,))
        self.assertFalse(self.db.execute('SELECT agent_backend.regulation_version_visible(%s,%s) AS visible', (uploaded['version_id'], self.user_id)).fetchone()['visible'])


def test_operator_import_rejects_url_before_reservation(tmp_path):
    source = tmp_path / 'source.txt'
    source.write_text('normative source', encoding='utf-8')
    settings = SimpleNamespace(connect=lambda: pytest.fail('invalid URL reached database'))
    for url in ('file:///private', 'https://name:secret@example.org/source', 'https://good.org\\@evil.org', 'https://good.org/\nsource'):
        with pytest.raises(AttachmentError, match='invalid_source_url'):
            import_regulation(settings, source, {'source_url': url}, uuid4(), 'unused')
