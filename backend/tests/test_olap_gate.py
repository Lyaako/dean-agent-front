"""Ограничение одновременных расчётов OLAP, кэш и single-flight — на подставной базе с задержкой."""
from concurrent.futures import ThreadPoolExecutor
import json
import threading
import time

import pytest
from fastapi import HTTPException

from backend import olap
from backend.olap_gate import OlapGate
from backend.tests.test_olap_metrics import movement, ORDER_TYPES

MODES = ('session', 'heat', 'risk', 'retake', 'moves', 'moves')


class Rows(list):
    def fetchone(self):
        return self[0]


class FakeDb:
    """Отвечает на olap_dataset с задержкой и считает вызовы; на visible_rows — справочник видов приказов."""
    def __init__(self, delay=0.0, fail=False):
        self.delay, self.fail, self.calls, self.lock = delay, fail, 0, threading.Lock()

    def execute(self, sql, params=()):
        if 'olap_dataset' in sql:
            with self.lock:
                self.calls += 1
            time.sleep(self.delay)
            if self.fail:
                raise RuntimeError('расчёт упал')
            return Rows([{'data': movement()}])
        assert 'visible_rows' in sql
        return Rows([{'visible_rows': json.dumps({'code': code})} for code in ORDER_TYPES])


@pytest.fixture
def gate(monkeypatch):
    def install(**settings):
        value = OlapGate(**({'limit': 2, 'queue_timeout': 5, 'ttl': 15, 'max_entries': 4} | settings))
        monkeypatch.setattr(olap, 'GATE', value)
        return value
    return install


def run(db, mode, user_id, **params):
    return olap.analyze(db, 'token', mode, user_id=user_id, **params)


def test_six_concurrent_requests_of_one_user_share_one_calculation(gate):
    gate()
    db = FakeDb(delay=0.3)
    started = time.monotonic()
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(lambda mode: run(db, mode, 1), MODES))
    took = time.monotonic() - started
    assert [r['mode'] for r in results] == list(MODES)
    assert db.calls == 1
    assert took < 6 * 0.3


def test_busy_slot_gives_429_with_retry_after_and_error_releases_the_slot(gate):
    gate(limit=1, queue_timeout=0.1)
    slow = FakeDb(delay=0.5)
    holder = threading.Thread(target=run, args=(slow, 'session', 1))
    holder.start(); time.sleep(0.05)
    with pytest.raises(HTTPException) as raised:
        run(FakeDb(), 'session', 2)
    holder.join()
    assert raised.value.status_code == 429
    assert raised.value.detail['code'] == 'olap_busy'
    assert raised.value.headers == {'Retry-After': '5'}
    with pytest.raises(RuntimeError):
        run(FakeDb(fail=True), 'session', 3)
    assert run(FakeDb(), 'session', 4)['mode'] == 'session'


def test_cache_is_per_user_bounded_and_expires(gate):
    current = gate(ttl=0.2, max_entries=2)
    db = FakeDb()
    run(db, 'session', 1); run(db, 'heat', 1)
    assert db.calls == 1
    run(db, 'session', 2)
    assert db.calls == 2
    run(db, 'session', 3)
    assert db.calls == 3 and current.cache_size() == 2
    time.sleep(0.25)
    run(db, 'session', 3)
    assert db.calls == 4


def test_two_concurrent_requests_of_one_user_make_one_call(gate):
    gate(limit=2)
    db = FakeDb(delay=0.3)
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(lambda mode: run(db, mode, 7), ('risk', 'retake')))
    assert db.calls == 1


def test_parameter_errors_do_not_wait_for_a_slot(gate):
    gate(limit=1, queue_timeout=2)
    holder = threading.Thread(target=run, args=(FakeDb(delay=0.5), 'session', 1))
    holder.start(); time.sleep(0.05)
    started = time.monotonic()
    for mode, params, field in (('session', {'level': 'result', 'group_id': 1}, 'discipline_id'),
                                ('moves', {'moves': {'types': 'expel,foo'}}, 'types')):
        with pytest.raises(HTTPException) as raised:
            run(FakeDb(), mode, 2, **params)
        assert raised.value.status_code == 422 and raised.value.detail['details'] == {'field': field}
    with pytest.raises(HTTPException) as raised:
        olap.report(FakeDb(), 'token', 'slice-group', None, None, None, None, user_id=2)
    assert (raised.value.status_code, raised.value.detail) == (422, 'group_required')
    assert time.monotonic() - started < 0.3
    holder.join()
