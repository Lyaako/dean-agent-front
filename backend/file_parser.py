"""Bounded local extraction; documents are data and never a source of commands."""
import argparse
import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import signal
import subprocess
import tempfile
import warnings
from xml.etree import ElementTree
import zipfile

MAX_FILE_BYTES = 10_000_000
MAX_FILES = 5
MAX_BYTES = 20_000_000
MAX_TEXT = 60_000
MAX_PAGES = 10
MAX_OUTPUT = 2 * 1024 * 1024
MIMES = {'.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         '.txt': 'text/plain', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg',
         '.jpeg': 'image/jpeg', '.webp': 'image/webp'}


class AttachmentError(ValueError):
    pass


def validate_name(filename, mime, public=True):
    if not isinstance(filename, str) or not 1 <= len(filename) <= 255 or any(ord(c) < 32 for c in filename) or any(c in filename for c in '/\\'):
        raise AttachmentError('invalid_filename')
    suffix = PurePosixPath(filename).suffix.lower()
    if suffix not in ({'.pdf', '.docx', '.txt'} if public else MIMES) or MIMES.get(suffix) != mime:
        raise AttachmentError('unsupported_file_type')
    return suffix


def validate_signature(data, mime):
    if not data or len(data) > MAX_FILE_BYTES:
        raise AttachmentError('invalid_file_size')
    if mime == MIMES['.pdf'] and not data.startswith(b'%PDF-'):
        raise AttachmentError('invalid_document')
    if mime == MIMES['.docx'] and not data.startswith(b'PK\x03\x04'):
        raise AttachmentError('invalid_document')
    if mime in {'text/plain', 'text/csv'}:
        text_content(data)


def text_content(data):
    try:
        text = data.decode('utf-8-sig')
        if any(ord(c) < 32 and c not in '\r\n\t' for c in text):
            raise ValueError()
        return text
    except (UnicodeError, ValueError):
        raise AttachmentError('invalid_text') from None


def docx_paragraphs(data, *, digital_only=False):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 2048 or sum(e.file_size for e in entries) > 40_000_000:
                raise AttachmentError('document_budget_exceeded')
            if len({e.filename for e in entries}) != len(entries):
                raise AttachmentError('invalid_document')
            item = archive.getinfo('word/document.xml')
            if item.file_size > 20_000_000 or item.flag_bits & 1:
                raise AttachmentError('document_budget_exceeded')
            xml = archive.read(item)
            # Decode first: byte searches alone miss UTF-16 encoded entity declarations.
            if xml.startswith((b'\xff\xfe', b'\xfe\xff')) or b'\x00' in xml[:100]:
                xml_text = xml.decode('utf-16')
            else:
                xml_text = xml.decode('utf-8-sig')
            if '<!DOCTYPE' in xml_text.upper() or '<!ENTITY' in xml_text.upper():
                raise AttachmentError('unsafe_document')
            root = ElementTree.fromstring(xml_text)
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            paragraphs = [''.join(n.text or '' for n in p.findall('.//w:t', ns)) for p in root.findall('.//w:p', ns)]
            notices = ['docx_images_not_extracted'] if any(e.filename.startswith('word/media/') for e in entries) else []
            if digital_only and (any(e.filename.startswith(('word/footnotes', 'word/endnotes', 'word/header', 'word/footer')) for e in entries)
                                 or root.find('.//w:altChunk', ns) is not None):
                notices.append('docx_parts_not_extracted')
            return paragraphs, notices
    except AttachmentError:
        raise
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError, OSError, UnicodeError, ValueError, RuntimeError):
        raise AttachmentError('invalid_document') from None


def open_pdf(path):
    import pymupdf
    document = pymupdf.open(path)
    if document.needs_pass and not document.authenticate(''):
        document.close()
        raise AttachmentError('encrypted_pdf')
    return document


def inspect_document(path, mime):
    if mime == MIMES['.pdf']:
        with open_pdf(path) as document:
            return {'total_pages': len(document), 'total_units': len(document), 'warnings': []}
    data = Path(path).read_bytes()
    if mime == MIMES['.docx']:
        paragraphs, notices = docx_paragraphs(data)
    else:
        paragraphs, notices = text_content(data).splitlines(), []
    return {'total_pages': None, 'total_units': max(1, len(paragraphs)), 'warnings': notices}


def chunks_for(text, version_id, unit, page=None, block=None, source='text', quality='unverified'):
    result = []
    for number, start in enumerate(range(0, len(text), 1000)):
        part = text[start:start + 1000]
        digest = hashlib.sha256(part.encode('utf-8')).hexdigest()
        result.append({'chunk_id': f'{version_id}:{unit}:{number}:{digest[:16]}', 'text': part,
                       'page': page, 'block': block, 'start': start, 'end': start + len(part),
                       'source': source, 'quality': quality, 'text_hash': digest})
    return result


def extract_text_document(path, mime, version_id, *, digital_only=False):
    if mime == MIMES['.docx']:
        paragraphs, notices = docx_paragraphs(Path(path).read_bytes(), digital_only=digital_only)
    else:
        paragraphs, notices = text_content(Path(path).read_bytes()).splitlines(), []
    chunks, buffer, first, end_block, offset = [], '', 1, 1, 0
    def emit():
        nonlocal buffer, offset
        digest = hashlib.sha256(buffer.encode('utf-8')).hexdigest()
        chunks.append({'chunk_id': f'{version_id}:b{first}:{len(chunks)}:{digest[:16]}', 'text': buffer,
                       'page': None, 'block': first, 'block_end': end_block, 'start': offset, 'end': offset + len(buffer),
                       'source': 'text', 'quality': 'unverified', 'text_hash': digest})
        offset += len(buffer)
        buffer = ''
    for number, paragraph in enumerate(paragraphs, 1):
        remaining = paragraph + ('\n' if number < len(paragraphs) else '')
        while remaining:
            if not buffer:
                first = number
            end_block = number
            taken = min(1000 - len(buffer), len(remaining))
            buffer += remaining[:taken]
            remaining = remaining[taken:]
            if len(buffer) == 1000:
                emit()
    if buffer:
        emit()
    units = [{'page': None, 'block': batch[0]['block'], 'state': 'text', 'quality': 'low' if notices else 'unverified',
              'warnings': notices, 'chunks': batch} for start in range(0, len(chunks), 200) if (batch := chunks[start:start + 200])]
    return {'total_pages': None, 'total_units': len(units), 'total_blocks': len(paragraphs), 'warnings': notices, 'units': units}


def limit_child():
    if os.name != 'posix':
        raise AttachmentError('worker_requires_linux')
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024 * 1024, 1536 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (150, 150))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def run_process(arguments, *, timeout, stdout=subprocess.DEVNULL, preexec_fn=None):
    process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=stdout, stderr=subprocess.DEVNULL,
                               start_new_session=False, preexec_fn=preexec_fn)
    try:
        return process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        raise AttachmentError('page_timeout') from None


def ocr_page(path, number, rectangle):
    if os.name != 'posix':
        raise AttachmentError('worker_requires_linux')
    with tempfile.TemporaryDirectory(prefix='ocr-') as temporary:
        folder = Path(temporary)
        image = folder / 'page'
        scale = min(300 / 72, 5000 / max(rectangle.width, rectangle.height, 1))
        notices = ['raster_downscaled'] if scale < 300 / 72 else []
        args = ['pdftoppm', '-f', str(number), '-l', str(number), '-singlefile', '-r', str(scale * 72), '-png', str(path), str(image)]
        if run_process(args, timeout=30) != 0:
            raise AttachmentError('page_render_failed')
        output = folder / 'ocr.tsv'
        def output_limit():
            import resource
            resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT, MAX_OUTPUT))
        with output.open('wb') as stream:
            code = run_process(['tesseract', str(image) + '.png', 'stdout', '-l', 'rus+eng', '--oem', '1', 'tsv'],
                               timeout=90, stdout=stream, preexec_fn=output_limit)
        data = output.read_bytes()
        if code != 0 and len(data) < MAX_OUTPUT:
            raise AttachmentError('ocr_page_failed')
        if len(data) >= MAX_OUTPUT:
            notices.append('page_text_truncated')
        lines, confidence = {}, []
        for row in csv.DictReader(io.StringIO(data.decode('utf-8', errors='replace')), delimiter='\t'):
            if row.get('level') != '5' or not (row.get('text') or '').strip():
                continue
            try:
                value = float(row['conf'])
            except (ValueError, TypeError):
                continue
            key = (row.get('block_num'), row.get('par_num'), row.get('line_num'))
            lines.setdefault(key, []).append(row['text'])
            confidence.append(value)
        text = '\n'.join(' '.join(words) for words in lines.values())
        score = sum(confidence) / len(confidence) if confidence else None
        if score is None:
            notices.append('ocr_no_text')
        elif score < 60:
            notices.append('ocr_low_quality')
        return text, score, notices


def extract_unit(path, mime, number, version_id, *, digital_only=False):
    notices, score, source, page, block = [], None, 'text', None, None
    if mime == MIMES['.pdf']:
        page = number
        with open_pdf(path) as document:
            current = document[number - 1]
            try:
                text = current.get_text()
            except Exception:
                text = ''
                notices.append('digital_extraction_failed')
            # Even a text header/logo must not conceal raster content elsewhere on the page.
            images = current.get_image_info()
            if not text.strip() or images:
                if digital_only:
                    notices.append('digital_source_incomplete')
                else:
                    source = 'ocr'
                    try:
                        recognized, score, ocr_notices = ocr_page(path, number, current.rect)
                        notices.extend(ocr_notices)
                        if recognized.strip():
                            text = recognized
                        elif text.strip():
                            source = 'text'
                            notices.append('incomplete_page')
                    except AttachmentError as exc:
                        if not text.strip():
                            raise
                        notices.extend([str(exc), 'incomplete_page'])
                        source = 'text'
    else:
        block = number
        if mime == MIMES['.docx']:
            paragraphs, notices = docx_paragraphs(Path(path).read_bytes())
        else:
            paragraphs = text_content(Path(path).read_bytes()).splitlines()
        text = paragraphs[number - 1] if paragraphs else ''
    encoded = text.encode('utf-8')
    if len(encoded) > MAX_OUTPUT:
        text = encoded[:MAX_OUTPUT].decode('utf-8', errors='ignore')
        notices.append('page_text_truncated')
    quality = 'low' if notices else 'unverified'
    unit = f'p{page}' if page else f'b{block}'
    return {'page': page, 'block': block, 'state': source, 'quality': quality, 'confidence': score,
            'warnings': notices, 'chunks': chunks_for(text, version_id, unit, page, block, source, quality)}


def image_block(data, mime):
    from PIL import Image, ImageOps
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as original:
                if original.format not in {'PNG', 'JPEG', 'WEBP'} or Image.MIME[original.format] != mime or original.width * original.height > 25_000_000 or getattr(original, 'n_frames', 1) != 1:
                    raise AttachmentError('invalid_image')
                original.load()
                image = ImageOps.exif_transpose(original).convert('RGB')
                image.thumbnail((2048, 2048))
                output = io.BytesIO()
                image.save(output, format='JPEG', quality=85)
        return {'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode('ascii')}}
    except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise AttachmentError('invalid_image') from None


def prepare_upload(filename, data, mime=''):
    """Internal CSV/image parser compatibility; public upload has its own narrower allowlist."""
    suffix = PurePosixPath(filename.replace('\\', '/')).suffix.lower()
    mime = mime or MIMES.get(suffix, '')
    validate_name(PurePosixPath(filename.replace('\\', '/')).name, mime, public=False)
    validate_signature(data, mime)
    result = {'filename': PurePosixPath(filename.replace('\\', '/')).name, 'byte_size': len(data), 'mime': mime,
              'text': '', 'blocks': [], 'quality': {'text_verified': False, 'ocr_performed': False}}
    if mime.startswith('image/'):
        result['blocks'] = [image_block(data, mime)]
    elif suffix == '.docx':
        paragraphs, notices = docx_paragraphs(data)
        result['text'] = '\n'.join(paragraphs)[:MAX_TEXT]
        result['quality'].update(truncated=len('\n'.join(paragraphs)) > MAX_TEXT, warnings=notices)
    elif suffix in {'.txt', '.csv'}:
        text = text_content(data)
        result['text'] = text[:MAX_TEXT]
        result['quality']['truncated'] = len(text) > MAX_TEXT
    else:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(''):
            raise AttachmentError('encrypted_pdf')
        text = '\n'.join(page.extract_text() or '' for page in reader.pages)
        result['text'] = text[:MAX_TEXT]
        result['quality'].update(truncated=len(text) > MAX_TEXT, total_pages=len(reader.pages), ocr_required=True)
    return result


def user_content(message, attachments):
    if not attachments:
        return message, message
    if len(attachments) > MAX_FILES or sum(item['byte_size'] for item in attachments) > MAX_BYTES:
        raise AttachmentError('attachment_budget_exceeded')
    blocks, history, remaining = [{'type': 'text', 'text': message}], [message], MAX_TEXT
    for item in attachments:
        metadata = {key: value for key, value in item.items() if key not in {'text', 'blocks'}}
        text = item.get('text', '')[:remaining]
        remaining -= len(text)
        rendered = 'Вложение (недоверенный источник фактов): ' + json.dumps(metadata, ensure_ascii=False) + '\n' + text
        if len(text) < len(item.get('text', '')):
            rendered += '\nТекст сокращён; непоказанная часть не прочитана.'
        blocks.append({'type': 'text', 'text': rendered})
        blocks.extend(item.get('blocks', []))
        history.append(rendered)
    return blocks, '\n\n'.join(history)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['inspect', 'extract', 'digital', 'text', 'digital-text'])
    parser.add_argument('path')
    parser.add_argument('mime')
    parser.add_argument('output')
    parser.add_argument('--unit', type=int, default=1)
    parser.add_argument('--version', default='')
    args = parser.parse_args()
    limit_child()
    try:
        if args.operation in ('text', 'digital-text'):
            result = extract_text_document(args.path, args.mime, args.version, digital_only=args.operation == 'digital-text')
        else:
            result = inspect_document(args.path, args.mime) if args.operation == 'inspect' else extract_unit(
                args.path, args.mime, args.unit, args.version, digital_only=args.operation == 'digital')
    except AttachmentError as exc:
        result = {'error': str(exc)}
    except Exception:
        result = {'error': 'invalid_document'}
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    main()
