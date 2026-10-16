"""Inventory follows the current head and still accepts explicit historical backups."""
import json

import pytest

from backend.tests.integration import p13_recovery as recovery


@pytest.mark.parametrize('count,head,explicit',[(73,'0060_olap_metrics',False),(72,'0039_scope_check_latency',True)])
def test_inventory_includes_all_tables_and_preserves_backup_revision(monkeypatch,count,head,explicit):
    tables=[['public','alembic_version']]+[['agent_backend','fixture_'+str(i)] for i in range(count-1)]
    responses=iter([json.dumps(tables),'\n'.join(json.dumps([i,'hash'+str(i)]) for i in range(count)),json.dumps({'head':head})])
    monkeypatch.setattr(recovery,'sql',lambda *args:next(responses))
    result=recovery.inventory('isolated',head) if explicit else recovery.inventory('isolated')
    assert len(result['tables'])==count
    assert result['head']==head
    assert result['tables']['public.alembic_version']==[count-1,'hash'+str(count-1)]


def test_inventory_refuses_a_database_at_an_unexpected_revision(monkeypatch):
    tables=[['public','alembic_version']]+[['agent_backend','fixture_'+str(i)] for i in range(72)]
    responses=iter([json.dumps(tables),'\n'.join(json.dumps([1,'hash']) for _ in tables),json.dumps({'head':'0039_scope_check_latency'})])
    monkeypatch.setattr(recovery,'sql',lambda *args:next(responses))
    with pytest.raises(AssertionError):
        recovery.inventory('isolated')


def test_current_inventory_refuses_missing_application_tables(monkeypatch):
    tables=[['public','alembic_version']]+[['agent_backend','fixture_'+str(i)] for i in range(71)]
    monkeypatch.setattr(recovery,'sql',lambda *args:json.dumps(tables))
    with pytest.raises(AssertionError):
        recovery.inventory('isolated')
