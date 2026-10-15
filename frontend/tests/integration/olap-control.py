"""Independent SQL aggregates for actual browser reports; private inputs use stdin."""
import json
from pathlib import Path
import sys

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[3]
sys.stdin.reconfigure(encoding='utf-8')
fixture = json.loads((ROOT / '.local/p12-browser-credentials.json').read_text(encoding='utf-8'))
if sys.argv[1:] == ['--diagnose']:
    import httpx
    account = next(item for item in fixture['accounts'] if item['role'] == 'admin')
    with httpx.Client(base_url='http://127.0.0.1:8881',headers={'Origin':'http://127.0.0.1:5174'},trust_env=False) as client:
        response = client.post('/api/v1/auth/login',json={'login':account['login'],'password':account['password']})
        assert response.status_code == 200
        client.headers.update({'Authorization':'Bearer '+response.json()['access_token'],'X-CSRF-Token':response.json()['csrf_token']})
        try:
            response = client.get('/api/v1/olap',params={'mode':'dice'})
            assert response.status_code == 200
            payload = {'database':fixture['database'],'checks':[{'role':'admin','report':response.json()}]}
        finally:
            assert client.post('/api/v1/auth/logout').status_code == 204
else:
    assert not sys.argv[1:]
    payload = json.load(sys.stdin)
    assert payload['encoding_probe'] == '\u042f\u0451', 'Private input pipe must preserve UTF-8 exactly'
parameters = json.loads((ROOT / '.local/p12-ui-connection.json').read_text(encoding='utf-8'))
assert parameters['dbname'] == payload['database'] == fixture['database']
assert parameters['dbname'].startswith('deanery_p12_ui_')
accounts = {account['role']: account['user_id'] for account in fixture['accounts']}
aggregate = """
    jsonb_build_object('avg', round(avg((f->>'points')::numeric) FILTER (WHERE f->>'kind'='result'),2)::text,
    'results',count(*) FILTER (WHERE f->>'kind'='result'),
    'excellent',count(*) FILTER (WHERE f->>'kind'='result' AND (f->>'is_graded')::boolean AND (f->>'mark')::int=5),
    'debts',count(*) FILTER (WHERE f->>'kind'='debt'))
"""
checks = []
with psycopg.connect(**parameters, row_factory=dict_row) as db:
    assert db.execute('SELECT current_database() AS name, version_num FROM public.alembic_version').fetchone() == {'name':payload['database'],'version_num':'0039_scope_check_latency'}
    for check in payload['checks']:
        report = check['report']
        filters = report['filters']
        arguments = (accounts[check['role']], *(filters[key] for key in ('group_id','discipline_id','semester','status_id')))
        source = 'WITH facts AS (SELECT f FROM agent_backend.olap_facts_for_actor(%s,%s,%s,%s,%s) f) '
        total = db.execute(source + f'SELECT {aggregate} AS value FROM facts', arguments).fetchone()['value']
        assert total == report['total'], f"{check['role']} {report['mode']}: SQL total differs"
        mode = report['mode']
        if mode == 'dice':
            facts = [row['f'] for row in db.execute(source + "SELECT f FROM facts WHERE f->>'kind'='result'",arguments)]
            debts = {tuple(row['f'][key] for key in ('student_id','discipline_id','semester')) for row in db.execute(source + "SELECT f FROM facts WHERE f->>'kind'='debt'",arguments)}
            expected = {tuple(f[key] for key in ('student_id','discipline_id','semester')): {**f,'has_debt':tuple(f[key] for key in ('student_id','discipline_id','semester')) in debts} for f in facts}
            actual = {tuple(row[key] for key in ('student_id','discipline_id','semester')):row for row in report['rows']}
            assert len(actual) == len(report['rows']) == len(facts), 'Dice keys are not unique'
            differences = sorted({field for key,row in expected.items() for field in row if row[field] != actual[key].get(field)})
            detail = next(({'field':field,'sql_type':type(row[field]).__name__,'http_type':type(actual[key].get(field)).__name__,'sql_number':row[field] if field in ('points','mark') else None,'http_number':actual[key].get(field) if field in ('points','mark') else None} for key,row in expected.items() for field in row if row[field] != actual[key].get(field)),None)
            assert expected == actual, f"{check['role']} dice: SQL facts differ in fields {differences}; first safe detail {detail}"
        elif mode == 'cross-group-semester':
            cells = {(row['gid'],row['sem']):row['avg'] for row in db.execute(source + "SELECT (f->>'group_id')::int gid,(f->>'semester')::int sem,round(avg((f->>'points')::numeric) FILTER (WHERE f->>'kind'='result'),2)::text avg FROM facts GROUP BY 1,2",arguments)}
            visible = [json.loads(row['f']) for row in db.execute("SELECT f FROM agent_backend.visible_rows_for_actor('study_group',%s) f",(accounts[check['role']],))]
            ids = {row['group_id'] for row in visible if filters['group_id'] is None or row['group_id'] == filters['group_id']}
            assert ids == {row['group_id'] for row in report['rows']}, 'Cross-table group scope differs'
            for row in report['rows']:
                assert row['semesters'] == {str(sem):cells.get((row['group_id'],sem)) for sem in report['semesters']}, 'Cross-table SQL cells differ'
        else:
            dimension = 'student_id' if mode == 'drilldown-group' else ('group_id' if mode in ('rollup-group','slice-discipline') else ('discipline_id' if mode in ('rollup-discipline','slice-group') else 'semester'))
            expected = {row['key']:row['value'] for row in db.execute(source + f"SELECT (f->>'{dimension}')::int key,{aggregate} AS value FROM facts GROUP BY 1",arguments)}
            zero = {'avg':None,'results':0,'excellent':0,'debts':0}
            for row in report['rows']:
                assert {key:row[key] for key in zero} == expected.get(row[dimension],zero), f"{check['role']} {mode}: SQL row metrics differ"
            if mode == 'drilldown-group':
                students = [json.loads(row['f']) for row in db.execute("SELECT f FROM agent_backend.visible_rows_for_actor('student',%s) f",(accounts[check['role']],))]
                ids = {row['student_id'] for row in students if row['group_id'] == filters['group_id'] and (filters['status_id'] is None or row['status_id'] == filters['status_id'])}
                assert ids == {row['student_id'] for row in report['rows']}, 'Drilldown SQL student scope differs'
            else:
                assert set(expected) == {row[dimension] for row in report['rows']}, 'Aggregate row IDs differ'
        checks.append({'role':check['role'],'mode':mode,'filters':filters,'rows':len(report['rows']),'sql_equal':True})
print(json.dumps({'database':payload['database'],'checks':checks}))
