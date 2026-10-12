"""Private immutable originals, checked derivative reads and upload HTTP helpers."""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
from uuid import UUID, uuid4

from fastapi import HTTPException
from starlette.formparsers import MultiPartException, MultiPartParser
from starlette.datastructures import UploadFile

from backend.file_config import FileSettings
from backend.file_parser import AttachmentError, MAX_FILE_BYTES, validate_name, validate_signature


def storage_path(key, root=None):
    base = (root or FileSettings().storage_root).resolve()
    if not isinstance(key, str) or not key or '\\' in key or ':' in key:
        raise AttachmentError('invalid_storage_key')
    part = PurePosixPath(key)
    if part.is_absolute() or any(value in {'..', '.'} for value in part.parts):
        raise AttachmentError('invalid_storage_key')
    path = (base / key).resolve()
    if not path.is_relative_to(base) or path == base:
        raise AttachmentError('invalid_storage_key')
    return path


def read_json(path, digest=None, limit=64 * 1024 * 1024):
    try:
        with path.open('rb') as stream:
            data = stream.read(limit + 1)
        if len(data) > limit or digest and hashlib.sha256(data).hexdigest() != digest:
            raise AttachmentError('artifact_integrity_error')
        return json.loads(data)
    except OSError:
        raise AttachmentError('storage_unavailable') from None
    except (ValueError, TypeError):
        raise AttachmentError('artifact_integrity_error') from None


def artifact_index(descriptor, root=None):
    extraction = descriptor.get('extraction') or {}
    if not extraction.get('artifact_key'):
        return {'version_id': str(descriptor['version_id']), 'content_hash': descriptor['content_hash'], 'units': [], 'base_units': 0, 'base_chunks': 0}
    index = read_json(storage_path(extraction['artifact_key'], root), extraction.get('index_hash'), limit=1048576)
    if index.get('version_id') != str(descriptor['version_id']) or index.get('content_hash') != descriptor['content_hash']:
        raise AttachmentError('artifact_integrity_error')
    return index


def iter_units(descriptor, root=None):
    index = artifact_index(descriptor, root)
    pointers, seen = [], set()
    while index:
        if len(index['units']) > 100 or index.get('version_id') != str(descriptor['version_id']) or index.get('content_hash') != descriptor['content_hash']:
            raise AttachmentError('artifact_integrity_error')
        previous = index.get('previous')
        if previous is None:
            break
        key, digest = previous['key'], previous['hash']
        if key in seen:
            raise AttachmentError('artifact_integrity_error')
        seen.add(key)
        pointers.append((key, digest))
        index = read_json(storage_path(key, root), digest, limit=1048576)
    for key, digest in reversed(pointers):
        yield from read_json(storage_path(key, root), digest, limit=1048576)['units']
    yield from artifact_index(descriptor, root)['units']


def read_chunks(descriptor, *, page=None, cursor=None, max_chars=6000, max_chunks=20, root=None):
    if page is not None and (type(page) is not int or page < 1) or page is not None and cursor is not None:
        raise AttachmentError('invalid_attachment_selector')
    if not 0 <= max_chars <= 60000 or not 1 <= max_chunks <= 60:
        raise AttachmentError('invalid_attachment_budget')
    start = 0
    if cursor is not None:
        try:
            if not isinstance(cursor, str) or len(cursor) > 200:
                raise ValueError()
            ref, start = json.loads(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
            if ref != str(descriptor['version_id']) or type(start) is not int or start < 0:
                raise ValueError()
        except (ValueError, TypeError):
            raise AttachmentError('invalid_attachment_selector') from None
    index = artifact_index(descriptor, root)
    if page is not None and (descriptor.get('mime') != 'application/pdf' or page > (descriptor['extraction'].get('total_pages') or 0)):
        raise AttachmentError('invalid_attachment_selector')
    output, total, used, next_offset, has_more = [], 0, 0, start, False
    notices = list(descriptor.get('extraction', {}).get('warnings', []))
    for item in iter_units(descriptor, root):
        count = item['chunk_count']
        if page is not None and item.get('page') != page:
            total += count
            continue
        if total + count <= start:
            total += count
            continue
        unit = read_json(storage_path(item['key'], root), item['hash'], limit=8 * 1024 * 1024)
        for chunk in unit['chunks']:
            offset = total
            total += 1
            if offset < start:
                continue
            text = chunk.get('text')
            if not isinstance(text, str) or len(text) > 1000 or hashlib.sha256(text.encode('utf-8')).hexdigest() != chunk['text_hash'] or not chunk['chunk_id'].startswith(str(descriptor['version_id']) + ':'):
                raise AttachmentError('artifact_integrity_error')
            if len(output) >= max_chunks or used + len(text) > max_chars:
                next_offset, has_more = offset, True
                break
            output.append(chunk)
            used += len(text)
            next_offset = offset + 1
        if has_more:
            break
    if has_more:
        notices.append('context_truncated')
    next_cursor = base64.urlsafe_b64encode(json.dumps([str(descriptor['version_id']), next_offset]).encode()).decode().rstrip('=') if has_more else None
    return {'file_id': str(descriptor['file_id']), 'version_id': str(descriptor['version_id']), 'chunks': output,
            'next_cursor': next_cursor, 'has_more': has_more, 'warnings': sorted(set(notices))}


def read_page_status(descriptor, *, offset=0, limit=100, root=None):
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
        raise AttachmentError('invalid_attachment_selector')
    index = artifact_index(descriptor, root)
    from itertools import islice
    pages = [{key: value for key, value in unit.items() if key in {'page', 'block', 'state', 'quality', 'warnings', 'chunk_count'}}
             for unit in islice(iter_units(descriptor, root), offset, offset + limit)]
    return {'pages': pages, 'page_offset': offset, 'page_limit': limit,
            'has_more_pages': index.get('base_units', 0) + len(index['units']) > offset + limit}


def file_metadata(descriptor):
    return {key: descriptor[key] for key in ('file_id', 'version_id', 'title', 'filename', 'mime')} | {'size': descriptor['byte_size']}


def download_descriptor(db, file_id, version_id, token):
    return db.execute('SELECT backend_api.download_file(%s,%s,%s) AS result', (file_id, version_id, token)).fetchone()['result']


def get_job(db, job_id, token, offset=0, limit=100):
    job = db.execute('SELECT backend_api.job_status(%s,%s) AS result', (job_id, token)).fetchone()['result']
    if job['kind'] == 'attachment':
        result = job['result']
        descriptor = download_descriptor(db, result['file_id'], result['version_id'], token)
        result.update(read_page_status(descriptor, offset=offset, limit=limit))
    return job


async def upload(request, db, token, key):
    consumed = 0
    async def bounded_body():
        nonlocal consumed
        async for chunk in request.stream():
            consumed += len(chunk)
            if consumed > MAX_FILE_BYTES + 65536:
                raise MultiPartException('body_too_large')
            yield chunk
    form = None
    temporary = None
    try:
        form = await MultiPartParser(request.headers, bounded_body(), max_files=1, max_fields=2, max_part_size=1024).parse()
        if len(form.multi_items()) != 3 or set(form) != {'file', 'title', 'purpose'}:
            raise AttachmentError('invalid_upload')
        upload_file, title, purpose = form['file'], form['title'], form['purpose']
        if not isinstance(upload_file, UploadFile) or not isinstance(title, str) or not 1 <= len(title.strip()) <= 255 or purpose != 'attachment':
            raise AttachmentError('invalid_upload')
        filename, mime = upload_file.filename, upload_file.content_type
        validate_name(filename, mime)
        file_id, version_id = uuid4(), uuid4()
        temporary = storage_path(f'originals/.staging/{uuid4()}')
        temporary.parent.mkdir(parents=True, exist_ok=True)
        size, digest, content = 0, hashlib.sha256(), bytearray()
        with temporary.open('xb') as stream:
            while chunk := await upload_file.read(65536):
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise HTTPException(413, 'body_too_large')
                digest.update(chunk)
                content.extend(chunk)
                stream.write(chunk)
            stream.flush()
            os.fsync(stream.fileno())
        validate_signature(bytes(content), mime)
        existing = db.execute('SELECT backend_api.reserve_file_upload(%s,%s,%s,%s,%s,%s,%s) AS result',
            (filename, title.strip(), mime, size, digest.digest(), key, token)).fetchone()['result']
        if existing is not None:
            return existing
        original = storage_path(f'originals/{file_id}/{version_id}')
        original.parent.mkdir(parents=True, exist_ok=True)
        # UUID directory and exclusive staging creation make publication non-overwriting.
        if original.exists():
            raise AttachmentError('storage_unavailable')
        temporary.rename(original)
        temporary = None
        return db.execute('SELECT backend_api.register_file(%s,%s,%s,%s,%s,%s,%s,%s,%s) AS result',
            (file_id, version_id, filename, title.strip(), mime, size, digest.digest(), key, token)).fetchone()['result']
    except MultiPartException as exc:
        raise HTTPException(413 if str(exc) == 'body_too_large' else 422, 'body_too_large' if str(exc) == 'body_too_large' else 'invalid_upload') from None
    except AttachmentError as exc:
        raise HTTPException(422, str(exc)) from None
    except OSError:
        raise HTTPException(503, 'storage_unavailable') from None
    finally:
        if form is not None:
            await form.close()
        if temporary is not None:
            temporary.unlink(missing_ok=True)
