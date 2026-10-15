import copy
import json
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.presentation import ApiJSONResponse,preview_contract
from backend.streaming import frame


def batch():
    return {'id':'test','kind':'batch','preview':{'operation':'BATCH','affected_rows':2,
        'items':[{'item_id':1,'changed_columns':['needs_dormitory'],'before':{'needs_dormitory':False},'after':{'needs_dormitory':True}},
                 {'item_id':2,'changed_columns':['needs_dormitory'],'before':{'needs_dormitory':True},'after':{'needs_dormitory':False}}]},
        'actions':{'can_approve':True},'items':[{'item_id':1,'state':'ok'},{'item_id':2,'state':'ok'}]}


def test_batch_preview_preserves_each_row_and_source():
    original=batch();saved=copy.deepcopy(original);view=preview_contract(original)
    assert view['preview']['changed_columns']==['Строка 1 · needs_dormitory','Строка 2 · needs_dormitory']
    assert list(view['preview']['before'].values())==[False,True]
    assert list(view['preview']['after'].values())==[True,False]
    assert view['preview']['items']==original['preview']['items']
    assert view['items']==original['items'] and view['actions']==original['actions']
    assert original==saved


def test_http_history_and_sse_final_use_the_same_preview_contract():
    app=FastAPI(default_response_class=ApiJSONResponse)
    @app.get('/')
    def response():
        return {'items':[{'proposals':[batch()]}]}
    with TestClient(app) as client:
        http=client.get('/').json()['items'][0]['proposals'][0]
    sse=frame({'sequence':1,'event':'final','data':{'proposals':[batch()]}})
    event=json.loads(next(line[6:] for line in sse.splitlines() if line.startswith('data: ')))
    assert http==event['proposals'][0]==preview_contract(batch())


def test_existing_single_preview_and_nonproposal_payload_are_unchanged():
    for value in ({'preview':{'operation':'UPDATE','changed_columns':['topic'],'before':{},'after':{'topic':'test'}}},
                  {'items':[{'student_id':1,'needs_dormitory':False}]},None):
        assert preview_contract(value)==value
