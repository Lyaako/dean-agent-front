"""Lease-guarded local extraction; every completed page survives a worker restart."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from threading import Event, Thread
from time import monotonic, sleep
from uuid import uuid4

from psycopg.types.json import Jsonb

from backend.file_config import FileSettings
from backend.file_parser import AttachmentError
from backend.files import artifact_index, read_json, storage_path
from backend.service_status import log_event, mark_alive, mark_unavailable


def write_artifact(key, value, root):
    path = storage_path(key, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    return hashlib.sha256(data).hexdigest()


def isolated_extract(settings, descriptor, operation, number=1):
    if os.name != 'posix':
        raise AttachmentError('worker_requires_linux')
    output = storage_path(f'temporary/{uuid4()}.json', settings.storage_root)
    output.parent.mkdir(parents=True, exist_ok=True)
    args = [sys.executable, '-m', 'backend.file_parser', operation,
            str(storage_path(descriptor['storage_key'], settings.storage_root)), descriptor['mime'], str(output),
            '--unit', str(number), '--version', descriptor['version_id']]
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               start_new_session=True, env={**os.environ, 'OMP_THREAD_LIMIT': '1'})
    try:
        try:
            code = process.wait(timeout=settings.inspect_timeout if operation == 'inspect' else settings.page_timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise AttachmentError('page_timeout') from None
        if code != 0:
            raise AttachmentError('parser_resource_limit')
        result = read_json(output, limit=(64 if operation in ('text', 'digital-text') else 8) * 1024 * 1024)
        if result.get('error'):
            raise AttachmentError(result['error'])
        return result
    finally:
        # This exact per-invocation temporary output is neither original nor retained evidence.
        output.unlink(missing_ok=True)


def extraction_summary(index, details, key, digest):
    units = index['units']
    previous = index.get('base_counts', {})
    completed = index.get('base_units', 0) + len(units)
    warnings = sorted(set(index.get('base_warnings', []) + details.get('warnings', []) + [warning for unit in units for warning in unit['warnings']]))
    total = details['total_units']
    counts = {'text_pages': previous.get('text_pages', 0) + sum(u['state'] == 'text' for u in units),
              'ocr_pages': previous.get('ocr_pages', 0) + sum(u['state'] == 'ocr' for u in units),
              'failed_pages': previous.get('failed_pages', 0) + sum(u['state'] == 'failed' for u in units),
              'low_quality_pages': previous.get('low_quality_pages', 0) + sum(u['quality'] == 'low' for u in units),
              'truncated_pages': previous.get('truncated_pages', 0) + sum('page_text_truncated' in u['warnings'] for u in units)}
    index['counts'] = counts
    chunk_count = index.get('base_chunks', 0) + sum(u['chunk_count'] for u in units)
    coverage = {'total_pages': details['total_pages'], 'attempted_pages': completed if details['total_pages'] is not None else None,
                **counts, 'unprocessed_pages': total - completed, 'complete': completed == total and not warnings}
    if details['total_pages'] is None:
        coverage = {'total_pages': None, 'total_chunks': chunk_count,
                    'processed_batches': completed, 'total_batches': total, 'total_blocks': details.get('total_blocks'),
                    'complete': completed == total and not warnings,
                    'truncated': 'page_text_truncated' in warnings}
    return {'revision': 1, 'artifact_key': key, 'index_hash': digest, 'total_pages': details['total_pages'],
            'total_units': total, 'completed_units': completed, 'total_chunks': chunk_count,
            'coverage': coverage, 'warnings': warnings,
            'budgets': {'page_text_bytes': 2097152, 'dpi': 300, 'max_side_pixels': 5000, 'ocr_languages': 'rus+eng'}}


def process_document(settings, descriptor, checkpoint, check=lambda: None, extractor=None):
    """The worker and focused real-OCR tests share this exact page/checkpoint pipeline."""
    extractor = extractor or (lambda operation, number=1: isolated_extract(settings, descriptor, operation, number))
    original = storage_path(descriptor['storage_key'], settings.storage_root)
    with original.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != descriptor['content_hash']:
            raise AttachmentError('original_integrity_error')
    text_result = extractor('text') if descriptor['mime'] != 'application/pdf' else None
    details = text_result or extractor('inspect')
    if details['total_units'] < 1:
        raise AttachmentError('empty_document')
    index = artifact_index(descriptor, settings.storage_root)
    index['revision'] = 1
    attempt = str(uuid4())
    summary = descriptor.get('extraction') or {}
    for number in range(index.get('base_units', 0) + len(index['units']) + 1, details['total_units'] + 1):
        check()
        try:
            result = text_result['units'][number - 1] if text_result else extractor('extract', number)
        except AttachmentError as exc:
            if str(exc) in {'storage_unavailable', 'ocr_unavailable'}:
                raise
            result = {'page': number if details['total_pages'] is not None else None,
                      'block': number if details['total_pages'] is None else None, 'state': 'failed',
                      'quality': 'low', 'warnings': [str(exc)], 'chunks': []}
        check()
        if len(index['units']) == 100:
            index = {key_: index[key_] for key_ in ('version_id', 'content_hash', 'revision')} | {
                'previous': {'key': summary['artifact_key'], 'hash': summary['index_hash']}, 'units': [],
                'base_units': summary['completed_units'], 'base_chunks': summary['total_chunks'],
                'base_counts': index['counts'], 'base_warnings': summary['warnings']}
        key = f'derived/{descriptor["version_id"]}/{attempt}/unit-{number}.json'
        digest = write_artifact(key, result, settings.storage_root)
        index['units'].append({key_: result[key_] for key_ in ('page', 'block', 'state', 'quality', 'warnings')} |
                              {'key': key, 'hash': digest, 'chunk_count': len(result['chunks'])})
        index_key = f'derived/{descriptor["version_id"]}/{attempt}/index-{number}.json'
        summary = extraction_summary(index, details, index_key, '')
        index_hash = write_artifact(index_key, index, settings.storage_root)
        summary['index_hash'] = index_hash
        checkpoint(summary, 'processing', None)
    check()
    # Reclaimed jobs with all pages checkpointed finalize without rerunning OCR.
    if not summary or 'coverage' not in summary:
        raise AttachmentError('artifact_integrity_error')
    state = 'ready' if summary['coverage']['complete'] else 'partial'
    if not summary['total_chunks']:
        state = 'failed'
        summary['warnings'] = sorted(set(summary['warnings'] + ['no_readable_text']))
    return checkpoint(summary, state, 'no_readable_text' if state == 'failed' else None)


def run_once(settings, worker):
    with settings.connect() as db:
        claim = db.execute('SELECT backend_api.claim_file_job(%s) AS result', (worker,)).fetchone()['result']
    mark_alive('file')
    if claim is None:
        return None
    log_event('file', 'job_started', job_id=claim['job_id'], attempts=claim['attempts'])
    stopped, lost = Event(), Event()
    latest = dict(claim['file'].get('extraction') or {})

    def check():
        if lost.is_set():
            raise AttachmentError('lease_lost')

    def heartbeat():
        while not stopped.wait(15):
            try:
                with settings.connect() as db:
                    alive = db.execute('SELECT backend_api.renew_file_job(%s,%s) AS alive', (claim['job_id'], worker)).fetchone()['alive']
                if not alive:
                    lost.set()
                    mark_unavailable('file')
                    return
                mark_alive('file')
            except Exception:
                lost.set()
                mark_unavailable('file')
                return

    def checkpoint(summary, state, error):
        check()
        with settings.connect() as db:
            result = db.execute('SELECT backend_api.checkpoint_file_job(%s,%s,%s,%s,%s) AS result',
                (claim['job_id'], worker, Jsonb(summary), state, error)).fetchone()['result']
        latest.clear()
        latest.update(summary)
        return result

    thread = Thread(target=heartbeat, daemon=True, name='file-lease')
    thread.start()
    try:
        return process_document(settings, claim['file'], checkpoint, check)
    except (AttachmentError, OSError) as exc:
        code = str(exc) if isinstance(exc, AttachmentError) else 'storage_unavailable'
        if code == 'lease_lost':
            return None
        if code in {'storage_unavailable', 'parser_resource_limit', 'ocr_unavailable'}:
            with settings.connect() as db:
                return db.execute('SELECT backend_api.retry_file_job(%s,%s,%s) AS result',
                    (claim['job_id'], worker, code)).fetchone()['result']
        latest['warnings'] = sorted(set(latest.get('warnings', []) + [code]))
        if latest.get('coverage'):
            latest['coverage']['complete'] = False
        return checkpoint(latest, 'partial' if latest.get('total_chunks', 0) else 'failed', code)
    finally:
        stopped.set()
        thread.join(timeout=6)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    settings, worker = FileSettings(), uuid4()
    if os.name != 'posix':
        raise SystemExit('Use the isolated Linux file-worker container')
    while True:
        started = monotonic()
        try:
            result = run_once(settings, worker)
            if result:
                log_event('file', 'job_finished', job_id=result['id'], status=result['status'],
                          error_code=result['error_code'], duration_ms=int((monotonic() - started) * 1000))
        except Exception:
            mark_unavailable('file')
            log_event('file', 'worker_error', error_code='file_worker_error')
            if args.once:
                raise SystemExit(1) from None
            result = None
        if args.once:
            return
        if result is None:
            sleep(2)


if __name__ == '__main__':
    main()
