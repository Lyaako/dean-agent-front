"""Digital normative extraction and generation-safe indexing with short DB calls."""
import argparse
import hashlib
import os
from threading import Event, Thread
from time import monotonic, sleep
from uuid import UUID, uuid4, uuid5

import psycopg
from psycopg.types.json import Jsonb

from backend.file_parser import AttachmentError
from backend.file_worker import isolated_extract, process_document
from backend.files import iter_units, read_json, storage_path
from backend.knowledge_config import KnowledgeSettings
from backend.vector_search import KnowledgeError, index_generation
from backend.service_status import log_event, mark_alive, mark_unavailable


def extracted_chunks(descriptor, root):
    sequence = 0
    for unit in iter_units(descriptor, root):
        result = read_json(storage_path(unit['key'], root), unit['hash'], limit=8 * 1024 * 1024)
        for chunk in result['chunks']:
            text = chunk['text']
            digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
            if not text.strip() or len(text) > 1000 or digest != chunk['text_hash'] or not chunk['chunk_id'].startswith(descriptor['version_id'] + ':'):
                raise AttachmentError('artifact_integrity_error')
            yield {'chunk_id': str(uuid5(UUID(descriptor['version_id']), f'{sequence}:{digest}')),
                   'sequence': sequence, 'text': text, 'text_hash': digest,
                   'locator': {name: chunk.get(name) for name in ('page', 'block', 'block_end', 'start', 'end', 'source', 'quality')}}
            sequence += 1


def process_version(settings, claim, call, check=lambda: None, extractor=None, indexer=None):
    descriptor = claim['version']
    original = storage_path(descriptor['storage_key'], settings.storage_root)
    with original.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != descriptor['content_hash']:
            raise AttachmentError('original_integrity_error')
    if not descriptor['metadata'].get('chunk_manifest'):
        def checkpoint(summary, state, error):
            check()
            result = call('checkpoint_knowledge_job', Jsonb(summary), state, error)
            descriptor['extraction'] = summary
            return result
        extractor = extractor or (lambda operation, number=1: isolated_extract(
            settings, descriptor, {'extract': 'digital', 'text': 'digital-text'}.get(operation, operation), number))
        result = process_document(settings, descriptor, checkpoint, check, extractor)
        if result['status'] != 'running':
            return result
        batch = []
        for chunk in extracted_chunks(descriptor, settings.storage_root):
            batch.append(chunk)
            if len(batch) == 200:
                check()
                call('save_knowledge_chunks', Jsonb(batch))
                batch = []
        if batch:
            call('save_knowledge_chunks', Jsonb(batch))
    expected = call('seal_knowledge_chunks')
    chunks = []
    while True:
        check()
        batch = call('knowledge_chunks', len(chunks))
        chunks.extend(batch)
        if len(batch) < 200:
            break
    receipt = (indexer or index_generation)(descriptor, chunks, claim['generation_id'], settings=settings, check=check)
    if receipt.get('chunk_count') != expected['chunk_count'] or receipt.get('manifest_hash') != expected['manifest_hash']:
        raise KnowledgeError('knowledge_index_verification_failed')
    check()
    return call('publish_knowledge_job', Jsonb(receipt))


def run_once(settings, worker):
    with settings.connect() as db:
        claim = db.execute('SELECT backend_api.claim_knowledge_job(%s) AS result', (worker,)).fetchone()['result']
    mark_alive('knowledge')
    if claim is None:
        return None
    log_event('knowledge', 'job_started', job_id=claim['job_id'])
    stopped, lost = Event(), Event()

    def check():
        if lost.is_set():
            raise AttachmentError('lease_lost')

    def call(name, *args):
        check()
        with settings.connect() as db:
            # Names are fixed internal call sites; source documents cannot choose SQL or arguments.
            return db.execute('SELECT backend_api.' + name + '(' + ','.join(['%s'] * (len(args) + 2)) + ') AS result',
                              (claim['job_id'], worker, *args)).fetchone()['result']

    def heartbeat():
        while not stopped.wait(15):
            try:
                with settings.connect() as db:
                    alive = db.execute('SELECT backend_api.renew_knowledge_job(%s,%s) AS result', (claim['job_id'], worker)).fetchone()['result']
                if not alive:
                    lost.set()
                    mark_unavailable('knowledge')
                    return
                mark_alive('knowledge')
            except Exception:
                lost.set()
                mark_unavailable('knowledge')
                return

    thread = Thread(target=heartbeat, daemon=True, name='knowledge-lease')
    thread.start()
    try:
        return process_version(settings, claim, call, check)
    except (AttachmentError, KnowledgeError, OSError) as exc:
        code = str(exc) if isinstance(exc, (AttachmentError, KnowledgeError)) else 'storage_unavailable'
        if code == 'lease_lost':
            return None
        retry = code in {'storage_unavailable', 'parser_resource_limit', 'knowledge_unavailable', 'knowledge_index_unavailable',
                         'knowledge_embedding_unavailable', 'knowledge_index_verification_failed'}
        return call('fail_knowledge_job', code, retry)
    except psycopg.Error as exc:
        if exc.sqlstate in {'P8103', '42501'}:
            return None
        raise
    finally:
        stopped.set()
        thread.join(timeout=6)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    if os.name != 'posix':
        raise SystemExit('Use the isolated Linux file-worker image with backend.knowledge_worker')
    settings, worker = KnowledgeSettings(), uuid4()
    while True:
        started = monotonic()
        try:
            result = run_once(settings, worker)
            if result:
                log_event('knowledge', 'job_finished', job_id=result.get('id'), status=result.get('status'),
                          error_code=result.get('error_code'), duration_ms=int((monotonic() - started) * 1000))
        except Exception:
            mark_unavailable('knowledge')
            log_event('knowledge', 'worker_error', error_code='knowledge_worker_error')
            if args.once:
                raise SystemExit(1) from None
            result = None
        if args.once:
            return
        if result is None:
            sleep(2)


if __name__ == '__main__':
    main()
