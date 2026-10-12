"""Focused source-parser, artifact and real local OCR checks."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
from time import monotonic
from uuid import uuid4
import zipfile

import pytest

from backend.file_config import FileSettings
from backend.file_parser import AttachmentError, chunks_for, docx_paragraphs, extract_text_document, extract_unit, inspect_document, prepare_upload, validate_name, validate_signature
from backend.file_worker import isolated_extract, process_document
from backend.files import read_chunks, read_page_status, storage_path


def descriptor(root, data, mime='text/plain'):
    file_id, version_id = str(uuid4()), str(uuid4())
    key = f'originals/{file_id}/{version_id}'
    path = storage_path(key, root)
    path.parent.mkdir(parents=True)
    path.write_bytes(data)
    return {'file_id': file_id, 'version_id': version_id, 'storage_key': key, 'content_hash': hashlib.sha256(data).hexdigest(),
            'mime': mime, 'byte_size': len(data), 'extraction': {}}


def test_types_signature_and_unsafe_names():
    for name in ('../one.txt', 'x\\one.txt', 'one\n.txt'):
        with pytest.raises(AttachmentError):
            validate_name(name, 'text/plain')
    with pytest.raises(AttachmentError):
        validate_name('one.csv', 'text/csv')
    for data, mime in ((b'x', 'application/pdf'), (b'PKbad', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), (b'a\x00', 'text/plain'), (b'', 'text/plain')):
        with pytest.raises(AttachmentError):
            validate_signature(data, mime)
    assert prepare_upload('data.csv', b'name,value\nexample,3', 'text/csv')['text'].startswith('name')
    from PIL import Image
    output = io.BytesIO()
    Image.new('RGB', (30, 30), 'white').save(output, 'PNG')
    assert prepare_upload('image.png', output.getvalue(), 'image/png')['blocks'][0]['type'] == 'image_url'


def test_docx_unsafe_utf16_entities_and_expansion():
    def packed(data):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('word/document.xml', data)
        return output.getvalue()
    with pytest.raises(AttachmentError, match='unsafe_document'):
        docx_paragraphs(packed('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "text">]><x>&a;</x>'.encode('utf-16')))
    with pytest.raises(AttachmentError, match='document_budget_exceeded'):
        docx_paragraphs(packed(b' ' * 20_000_001))
    with pytest.raises(AttachmentError, match='invalid_document'):
        docx_paragraphs(b'PK\x03\x04broken')


def test_private_paths_and_chunk_integrity_and_resume(tmp_path):
    for key in ('../escape', '/absolute', 'C:/secret', 'a\\b'):
        with pytest.raises(AttachmentError):
            storage_path(key, tmp_path)
    ref = descriptor(tmp_path, b'original', 'application/pdf')
    settings = FileSettings(storage_root=tmp_path)
    def extract(operation, number=1):
        if operation == 'inspect':
            return {'total_pages': 3, 'total_units': 3, 'warnings': []}
        if number == 2:
            raise AttachmentError('page_timeout')
        return {'page': number, 'block': None, 'state': 'text', 'quality': 'unverified', 'warnings': [],
                'chunks': chunks_for('page ' + str(number), ref['version_id'], f'p{number}', page=number)}
    checkpoints = []
    def checkpoint(summary, state, error):
        checkpoints.append((summary.copy(), state, error))
        ref['extraction'] = summary
        return state
    assert process_document(settings, ref, checkpoint, extractor=extract) == 'partial'
    assert [value[0]['completed_units'] for value in checkpoints[:3]] == [1, 2, 3]
    assert checkpoints[-1][0]['coverage']['failed_pages'] == 1
    result = read_chunks(ref, max_chars=6, root=tmp_path)
    assert result['chunks'][0]['text'] == 'page 1' and result['has_more']
    followup = read_chunks(ref, cursor=result['next_cursor'], root=tmp_path)
    assert followup['chunks'][0]['page'] == 3
    assert read_page_status(ref, offset=1, limit=1, root=tmp_path)['pages'][0]['state'] == 'failed'
    assert process_document(settings, ref, checkpoint, extractor=lambda operation, number=1: extract(operation) if operation == 'inspect' else pytest.fail('completed page rerun')) == 'partial'
    key = ref['extraction']['artifact_key']
    storage_path(key, tmp_path).write_text('{}', encoding='utf-8')
    with pytest.raises(AttachmentError, match='artifact_integrity_error'):
        read_chunks(ref, root=tmp_path)


def test_many_short_lines_use_one_extraction_and_bounded_batches(tmp_path):
    ref = descriptor(tmp_path, b'x\n' * 100000)
    settings = FileSettings(storage_root=tmp_path)
    calls = []
    def extract(operation, number=1):
        calls.append(operation)
        assert operation == 'text'
        return extract_text_document(storage_path(ref['storage_key'], tmp_path), ref['mime'], ref['version_id'])
    def checkpoint(summary, state, error):
        ref['extraction'] = summary
        return state
    assert process_document(settings, ref, checkpoint, extractor=extract) == 'ready'
    assert calls == ['text'] and ref['extraction']['total_units'] == 1
    assert ref['extraction']['total_chunks'] == 200
    assert ref['extraction']['coverage']['total_blocks'] == 100000
    artifacts = list((tmp_path / 'derived').rglob('*.json'))
    assert len(artifacts) == 2 and sum(path.stat().st_size for path in artifacts) < 400000
    first = read_chunks(ref, root=tmp_path)['chunks'][0]
    assert first['block'] == 1 and first['block_end'] == 500


def test_transient_artifact_access_preserves_completed_page(tmp_path, monkeypatch):
    from backend.files import read_json
    ref = descriptor(tmp_path, b'original', 'application/pdf')
    def extract(operation, number=1):
        if operation == 'inspect':
            return {'total_pages': 2, 'total_units': 2, 'warnings': []}
        if number == 2:
            raise AttachmentError('storage_unavailable')
        return {'page': number, 'block': None, 'state': 'text', 'quality': 'unverified', 'warnings': [],
                'chunks': chunks_for('preserved', ref['version_id'], 'p1', page=1)}
    def checkpoint(summary, state, error):
        ref['extraction'] = summary
    with pytest.raises(AttachmentError, match='storage_unavailable'):
        process_document(FileSettings(storage_root=tmp_path), ref, checkpoint, extractor=extract)
    assert ref['extraction']['completed_units'] == 1
    assert read_chunks(ref, root=tmp_path)['chunks'][0]['text'] == 'preserved'
    with monkeypatch.context() as changed:
        changed.setattr(Path, 'open', lambda *args, **kwargs: (_ for _ in ()).throw(PermissionError('temporary')))
        with pytest.raises(AttachmentError, match='storage_unavailable'):
            read_json(tmp_path / 'artifact')


def test_segmented_indexes_are_bounded_and_page_locations_survive(tmp_path):
    ref = descriptor(tmp_path, b'original', 'application/pdf')
    def extract(operation, number=1):
        if operation == 'inspect':
            return {'total_pages': 205, 'total_units': 205, 'warnings': []}
        return {'page': number, 'block': None, 'state': 'text', 'quality': 'unverified', 'warnings': [],
                'chunks': chunks_for(str(number), ref['version_id'], f'p{number}', page=number)}
    def checkpoint(summary, state, error):
        ref['extraction'] = summary
        return state
    assert process_document(FileSettings(storage_root=tmp_path), ref, checkpoint, extractor=extract) == 'ready'
    indexes = list((tmp_path / 'derived').rglob('index-*.json'))
    assert len(indexes) == 205
    assert all(len(json.loads(path.read_text())['units']) <= 100 and path.stat().st_size < 1048576 for path in indexes)
    assert read_chunks(ref, page=201, root=tmp_path)['chunks'][0]['text'] == '201'
    assert read_page_status(ref, offset=200, limit=5, root=tmp_path)['pages'][-1]['page'] == 205


@pytest.mark.parametrize('digital_failure', [True, False])
def test_pdf_ocr_fallback_preserves_usable_digital_text(monkeypatch, digital_failure):
    from types import SimpleNamespace
    class Page:
        rect = SimpleNamespace(width=595, height=842)
        def get_text(self):
            if digital_failure:
                raise RuntimeError('broken text map')
            return 'known digital text'
        def get_image_info(self):
            return [1]
    class Document:
        def __enter__(self): return [Page()]
        def __exit__(self, *args): pass
    called = []
    def ocr(*args):
        called.append(True)
        return ('recovered OCR', 90, []) if digital_failure else ('', None, ['ocr_no_text'])
    monkeypatch.setattr('backend.file_parser.open_pdf', lambda path: Document())
    monkeypatch.setattr('backend.file_parser.ocr_page', ocr)
    result = extract_unit('irrelevant', 'application/pdf', 1, str(uuid4()))
    assert called == [True]
    assert result['chunks'][0]['text'] == ('recovered OCR' if digital_failure else 'known digital text')
    assert result['warnings']


def test_pdf_above_500_pages_and_docx_locations(tmp_path):
    import pymupdf
    document = pymupdf.open()
    for _ in range(501):
        document.new_page()
    path = tmp_path / 'many.pdf'
    document.save(path)
    document.close()
    assert inspect_document(path, 'application/pdf')['total_pages'] == 501
    chunk = chunks_for('paragraph', str(uuid4()), 'b3', block=3)[0]
    assert chunk['page'] is None and chunk['block'] == 3


def test_normative_pdf_digital_only_never_ocr_and_marks_raster_partial(tmp_path, monkeypatch):
    import pymupdf
    from PIL import Image
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((40, 40), 'Complete digital normative text')
    page = document.new_page()
    page.insert_text((40, 40), 'Digital header is not the whole page')
    bitmap = io.BytesIO()
    Image.new('RGB', (20, 20), 'white').save(bitmap, 'PNG')
    page.insert_image(pymupdf.Rect(40, 80, 200, 240), stream=bitmap.getvalue())
    document.new_page()
    path = tmp_path / 'normative.pdf'
    document.save(path)
    document.close()
    monkeypatch.setattr('backend.file_parser.ocr_page', lambda *args: pytest.fail('operator OCR is outside scope'))
    version = str(uuid4())
    digital = extract_unit(path, 'application/pdf', 1, version, digital_only=True)
    mixed = extract_unit(path, 'application/pdf', 2, version, digital_only=True)
    blank = extract_unit(path, 'application/pdf', 3, version, digital_only=True)
    assert digital['warnings'] == [] and digital['chunks'][0]['page'] == 1
    assert mixed['warnings'] == ['digital_source_incomplete'] and mixed['quality'] == 'low'
    assert mixed['chunks'][0]['text'].startswith('Digital header')
    assert blank['warnings'] == ['digital_source_incomplete'] and not blank['chunks']


@pytest.mark.skipif(os.name != 'posix', reason='isolated parser uses the Linux worker')
def test_normative_digital_text_preserves_large_text_output_budget(tmp_path):
    ref = descriptor(tmp_path, b'Normative text. ' * 600000)
    result = isolated_extract(FileSettings(storage_root=tmp_path), ref, 'digital-text')
    chunks = [chunk for unit in result['units'] for chunk in unit['chunks']]
    assert sum(len(chunk['text']) for chunk in chunks) == ref['byte_size']
    assert len(json.dumps(result).encode()) > 8 * 1024 * 1024
    assert not result['warnings']


@pytest.mark.skipif(os.name != 'posix' or not shutil.which('tesseract'), reason='real OCR uses isolated Linux worker')
def test_real_rus_eng_mixed_pdf_page25_and_partial_failure(tmp_path):
    import pymupdf
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new('RGB', (1240, 1754), 'white')
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 48)
    draw.text((80, 220), 'Подтверждение заявления 2026', font=font, fill='black')
    draw.text((80, 320), 'Application evidence page 25', font=font, fill='black')
    bitmap = io.BytesIO()
    image.save(bitmap, 'PNG')
    document = pymupdf.open()
    for number in range(1, 26):
        page = document.new_page()
        page.insert_text((50, 50), f'Digital header page {number}')
        if number in (11, 25):
            page.insert_image(pymupdf.Rect(0, 90, 595, 840), stream=bitmap.getvalue())
        else:
            page.insert_text((50, 100), 'Regular digital document text.')
    data = document.tobytes()
    document.close()
    ref = descriptor(tmp_path, data, 'application/pdf')
    settings = FileSettings(storage_root=tmp_path)
    measured = []
    def checkpoint(summary, state, error):
        ref['extraction'] = summary
        measured.append({'processed': summary['completed_units'], 'state': state})
        return state
    started = monotonic()
    # One controlled page timeout exercises continuation; other pages use actual isolated executables.
    def extract(operation, number=1):
        if operation == 'extract' and number == 12:
            raise AttachmentError('page_timeout')
        return isolated_extract(settings, ref, operation, number)
    assert process_document(settings, ref, checkpoint, extractor=extract) == 'partial'
    result = read_chunks(ref, page=25, root=tmp_path)
    text = ' '.join(chunk['text'] for chunk in result['chunks'])
    assert 'Подтверждение' in text and 'Application' in text
    coverage = ref['extraction']['coverage']
    assert coverage['attempted_pages'] == 25 and coverage['ocr_pages'] == 2 and coverage['failed_pages'] == 1
    assert coverage['unprocessed_pages'] == 0 and not coverage['complete']
    print(json.dumps({'real_ocr': True, 'controlled_failure_page': 12, 'elapsed_s': round(monotonic() - started, 2),
                      'coverage': coverage, 'page25_text': text, 'progress': measured}, ensure_ascii=False))
