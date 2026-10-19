"""Observe the actual API's ASGI response boundary against an independent DB connection."""
import asyncio
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import sys

import psycopg
from psycopg.conninfo import make_conninfo

ROOT = Path(__file__).resolve().parents[3]
PRIVATE = ROOT / '.local'
parameters = json.loads((PRIVATE / 'p12-ui-api.json').read_text(encoding='utf-8'))
control = json.loads((PRIVATE / 'p12-ui-connection.json').read_text(encoding='utf-8'))
fixture = json.loads((PRIVATE / 'p12-browser-credentials.json').read_text(encoding='utf-8'))
assert parameters['dbname'] == control['dbname'] == fixture['database']
assert fixture['database'].startswith('deanery_p12_ui_')
os.environ.update({'DATABASE_URL':make_conninfo(**parameters),'DEANERY_ORIGIN':'http://127.0.0.1:5174','DEANERY_DEV_INSECURE_COOKIE':'1','AGENT_DATABASE_FILE':str(PRIVATE/'p12-ui-agent.json'),'FILES_STORAGE_ROOT':str(PRIVATE/'p12-ui-files')})
sys.path.insert(0,str(ROOT))
from backend import auth
from backend.app import app

evidence = {'database':fixture['database'],'transport':'actual ASGI app, original dependency, independent real DB; no timing injection','checks':[]}

def active(token):
    with psycopg.connect(**control) as db:
        assert db.execute('SELECT current_database(),version_num FROM public.alembic_version').fetchone() == (fixture['database'],'0039_scope_check_latency')
        return bool(db.execute('SELECT count(*) FROM agent_backend.auth_token t JOIN agent_backend.auth_session s ON s.id=t.session_id WHERE t.token_hash=%s AND t.revoked_at IS NULL AND s.revoked_at IS NULL',(auth.digest(token),)).fetchone()[0])

async def request(path,payload,headers,observe):
    body=json.dumps(payload).encode()
    messages=[]
    received=False
    async def receive():
        nonlocal received
        if not received:
            received=True
            return {'type':'http.request','body':body,'more_body':False}
        await asyncio.Future()
    async def send(message):
        messages.append(message)
        if message['type'] == 'http.response.body' and not message.get('more_body',False):
            raw=b''.join(item.get('body',b'') for item in messages if item['type']=='http.response.body')
            observe(json.loads(raw) if raw else {})
    scope={'type':'http','asgi':{'version':'3.0','spec_version':'2.4'},'http_version':'1.1','method':'POST','scheme':'http','path':path,'raw_path':path.encode(),'query_string':b'','headers':[(b'content-type',b'application/json'),(b'origin',b'http://127.0.0.1:5174'),*headers],'client':('127.0.0.1',61012),'server':('127.0.0.1',8881)}
    await app(scope,receive,send)
    start=next(item for item in messages if item['type']=='http.response.start')
    raw=b''.join(item.get('body',b'') for item in messages if item['type']=='http.response.body')
    return start['status'],start['headers'],json.loads(raw) if raw else {}

async def main():
    account=next(item for item in fixture['accounts'] if item['role']=='dean_staff')
    login_check={'action':'login'}
    status,headers,tokens=await request('/api/v1/auth/login',{'login':account['login'],'password':account['password']},[],lambda body:login_check.update(state_visible_when_response_sent=active(body['access_token'])))
    assert status==200
    login_check.update(status=status,state_visible_after_request=active(tokens['access_token']))
    evidence['checks'].append(login_check)
    cookie=SimpleCookie()
    for key,value in headers:
        if key==b'set-cookie':cookie.load(value.decode())
    cookie_header='; '.join(f'{key}={morsel.value}' for key,morsel in cookie.items()).encode()
    refresh_check={'action':'refresh'}
    status,_,refreshed=await request('/api/v1/auth/refresh',{},[(b'cookie',cookie_header),(b'x-csrf-token',tokens['csrf_token'].encode())],lambda body:refresh_check.update(state_visible_when_response_sent=active(body['access_token'])))
    assert status==200
    refresh_check.update(status=status,state_visible_after_request=active(refreshed['access_token']))
    evidence['checks'].append(refresh_check)
    logout_check={'action':'logout'}
    status,_,_=await request('/api/v1/auth/logout',{},[(b'authorization',('Bearer '+refreshed['access_token']).encode()),(b'x-csrf-token',tokens['csrf_token'].encode())],lambda body:logout_check.update(state_visible_when_response_sent=not active(refreshed['access_token'])))
    assert status==204
    logout_check.update(status=status,state_visible_after_request=not active(refreshed['access_token']))
    evidence['checks'].append(logout_check)
    evidence['passed']=all(item['state_visible_when_response_sent'] and item['state_visible_after_request'] for item in evidence['checks'])

try:
    asyncio.run(main())
finally:
    (ROOT/'.nelson/missions/2026-10-11_065347_b2445e93/task12-transaction-timing.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
    print(json.dumps(evidence))
assert evidence['passed'], 'API acknowledged auth state before the real database transaction committed'
