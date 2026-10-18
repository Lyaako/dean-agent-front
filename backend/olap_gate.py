"""Ограничение одновременных расчётов OLAP и короткий кэш наборов фактов в пределах процесса.

Набор фактов OLAP собирается в базе одним JSONB: при шести одновременных расчётах контейнер базы
(512 МБ) упирался в память и PostgreSQL перезапускался, обрывая все соединения. Поэтому:
- не больше OLAP_MAX_CONCURRENT расчётов сразу, остальные ждут до OLAP_QUEUE_TIMEOUT и получают 429 olap_busy;
- набор фактов кэшируется на OLAP_CACHE_TTL секунд по ключу «пользователь + параметры», не больше
  OLAP_CACHE_MAX записей; одинаковые одновременные запросы ждут один расчёт (single-flight).
Лимит действует на процесс: при нескольких процессах uvicorn он умножится.
"""
from collections import OrderedDict
from contextlib import contextmanager
import os
import threading
import time

from fastapi import HTTPException


def _number(name, default, cast):
    try:
        return cast(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def busy():
    return HTTPException(429, {'code': 'olap_busy', 'message': 'Аналитика сейчас занята, повторите через несколько секунд'},
                         headers={'Retry-After': '5'})


class _Flight:
    def __init__(self):
        self.done = threading.Event()
        self.value = None
        self.error = None


class OlapGate:
    def __init__(self, limit=None, queue_timeout=None, ttl=None, max_entries=None):
        self.limit = max(1, limit if limit is not None else _number('OLAP_MAX_CONCURRENT', 2, int))
        self.queue_timeout = queue_timeout if queue_timeout is not None else _number('OLAP_QUEUE_TIMEOUT', 20.0, float)
        self.ttl = ttl if ttl is not None else _number('OLAP_CACHE_TTL', 15.0, float)
        self.max_entries = max(0, max_entries if max_entries is not None else _number('OLAP_CACHE_MAX', 4, int))
        self._slots = threading.BoundedSemaphore(self.limit)
        self._lock = threading.Lock()
        self._cache = OrderedDict()
        self._flights = {}

    @contextmanager
    def slot(self):
        """Слот расчёта: берётся до запроса к базе, отпускается всегда, в том числе при ошибке."""
        if not self._slots.acquire(timeout=self.queue_timeout):
            raise busy()
        try:
            yield
        finally:
            self._slots.release()

    def cache_size(self):
        with self._lock:
            return len(self._cache)

    def fetch(self, key, load):
        """Набор фактов из кэша или один расчёт на ключ: остальные ждут его, не занимая слот."""
        deadline = time.monotonic() + self.queue_timeout
        with self._lock:
            now = time.monotonic()
            for stale in [k for k, (expires, _) in self._cache.items() if expires <= now]:
                del self._cache[stale]
            if key in self._cache:
                return self._cache[key][1]
            flight = self._flights.get(key)
            leader = flight is None
            if leader:
                flight = self._flights[key] = _Flight()
        if not leader:
            if not flight.done.wait(max(0.0, deadline - time.monotonic())):
                raise busy()
            if flight.error is not None:
                raise flight.error
            return flight.value
        try:
            with self.slot():
                flight.value = load()
            if self.max_entries:
                with self._lock:
                    self._cache[key] = (time.monotonic() + self.ttl, flight.value)
                    self._cache.move_to_end(key)
                    while len(self._cache) > self.max_entries:
                        self._cache.popitem(last=False)
            return flight.value
        except BaseException as error:
            flight.error = error
            raise
        finally:
            with self._lock:
                self._flights.pop(key, None)
            flight.done.set()
