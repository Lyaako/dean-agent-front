"""Forwarding-only tool mocks; actual role checks live in PostgreSQL integration tests."""
from contextlib import nullcontext
import pytest


@pytest.fixture
def fake_tool_context(monkeypatch):
    from backend import agent_tools
    original=agent_tools.run_context
    def context(*args,**kwargs):
        result=original(*args,**kwargs)
        result['actor'].setdefault('user_id',1)
        return result
    monkeypatch.setattr(agent_tools,'run_context',context)
    monkeypatch.setattr(agent_tools,'user_context',lambda *args,**kwargs:nullcontext())


@pytest.fixture(autouse=True)
def isolated_olap_gate(monkeypatch):
    # Кэш OLAP живёт в процессе 15 с: тесты меняют данные в транзакциях, поэтому каждому — свой шлюз без кэша.
    from backend import olap
    from backend.olap_gate import OlapGate
    monkeypatch.setattr(olap, 'GATE', OlapGate(max_entries=0))
