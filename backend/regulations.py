"""Private operator commands for normative originals and verified indexing jobs."""
import argparse
from datetime import date
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb

from backend.file_parser import AttachmentError, MAX_FILE_BYTES, MIMES, validate_name, validate_signature
from backend.files import storage_path
from backend.knowledge_config import KnowledgeSettings


def import_regulation(settings, path, metadata, key, token):
    path = Path(path)
    mime = MIMES.get(path.suffix.lower(), '')
    validate_name(path.name, mime)
    with path.open('rb') as stream:
        data = stream.read(MAX_FILE_BYTES + 1)
    validate_signature(data, mime)
    source_url = metadata.get('source_url')
    if source_url is not None:
        parsed = urlsplit(source_url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or any(ord(c) < 33 or c == '\\' for c in source_url):
            raise AttachmentError('invalid_source_url')
    for name in ('published_date', 'effective_date'):
        if metadata.get(name) is not None:
            date.fromisoformat(metadata[name])
    digest = hashlib.sha256(data).hexdigest()
    request = metadata | {'filename': path.name, 'mime': mime, 'byte_size': len(data), 'content_hash': digest}
    with settings.connect() as db:
        descriptor = db.execute('SELECT backend_api.reserve_regulation(%s,%s,%s) AS result', (Jsonb(request), key, token)).fetchone()['result']
    original = storage_path(descriptor['storage_key'], settings.storage_root)
    original.parent.mkdir(parents=True, exist_ok=True)
    if original.exists():
        with original.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                raise AttachmentError('original_integrity_error')
    else:
        temporary = storage_path(f'regulations/.staging/knowledge-{uuid4()}', settings.storage_root)
        temporary.parent.mkdir(parents=True, exist_ok=True)
        try:
            with temporary.open('xb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            # Atomic, non-overwriting publication also handles two retries of the same import.
            try:
                os.link(temporary, original)
            except FileExistsError:
                with original.open('rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                        raise AttachmentError('original_integrity_error') from None
        finally:
            temporary.unlink(missing_ok=True)
    with settings.connect() as db:
        job = db.execute('SELECT backend_api.queue_regulation(%s,%s,%s) AS result', (descriptor['version_id'], key, token)).fetchone()['result']
    return {'regulation_id': descriptor['regulation_id'], 'version_id': descriptor['version_id'], 'job': job}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    importing = commands.add_parser('import')
    importing.add_argument('path', type=Path)
    importing.add_argument('--title', required=True)
    importing.add_argument('--source', required=True)
    importing.add_argument('--version-label', required=True)
    importing.add_argument('--regulation-id', type=UUID)
    importing.add_argument('--source-url')
    importing.add_argument('--published-date')
    importing.add_argument('--effective-date')
    importing.add_argument('--key', type=UUID, required=True)
    scope = importing.add_mutually_exclusive_group(required=True)
    scope.add_argument('--global-scope', action='store_true')
    scope.add_argument('--institute-id', action='append', type=int)
    for command in ('get-version', 'reindex', 'withdraw'):
        sub = commands.add_parser(command)
        sub.add_argument('version_id', type=UUID)
        if command == 'reindex':
            sub.add_argument('--key', type=UUID, required=True)
        if command == 'withdraw':
            sub.add_argument('--reason', required=True)
    args = parser.parse_args()
    settings = KnowledgeSettings()
    try:
        token = settings.token_file.read_text(encoding='utf-8').strip()
        if not token or len(token) > 4096:
            raise AttachmentError('invalid_operator_token')
        if args.command == 'import':
            metadata = {name: getattr(args, name) for name in ('title', 'source', 'version_label', 'source_url', 'published_date', 'effective_date')}
            metadata['regulation_id'] = str(args.regulation_id) if args.regulation_id else None
            metadata['scope'] = {'global': args.global_scope, 'institute_ids': sorted(set(args.institute_id or []))}
            result = import_regulation(settings, args.path, metadata, args.key, token)
        else:
            with settings.connect() as db:
                if args.command == 'get-version':
                    result = db.execute('SELECT backend_api.get_regulation_version(%s,%s) AS result', (args.version_id, token)).fetchone()['result']
                elif args.command == 'reindex':
                    result = db.execute('SELECT backend_api.queue_regulation(%s,%s,%s) AS result', (args.version_id, args.key, token)).fetchone()['result']
                else:
                    result = db.execute('SELECT backend_api.withdraw_regulation(%s,%s,%s) AS result', (args.version_id, args.reason, token)).fetchone()['result']
        print(json.dumps(result, ensure_ascii=False, default=str))
    except psycopg.Error as exc:
        raise SystemExit('knowledge_operator_failed:' + (exc.sqlstate or 'database_unavailable')) from None
    except (OSError, ValueError) as exc:
        raise SystemExit(str(exc) if isinstance(exc, AttachmentError) else 'knowledge_input_or_storage_error') from None


if __name__ == '__main__':
    main()
