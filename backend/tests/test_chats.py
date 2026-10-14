"""Owned persistence, worker identity and replay on real PostgreSQL."""

from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb

from backend import chats, proposals
from backend.database_actor import user_context
from backend.contracts import ChatRequest
from backend.tests.test_auth import DatabaseHttpCase


class ChatTests(DatabaseHttpCase):
    def setUp(self):
        super().setUp()
        self.db.execute("SET LOCAL search_path TO pg_catalog,deanery")
        self.worker = uuid4()
        self.headers = self.login('vasilyeva')
        self.token = self.headers['Authorization'][7:]

    def login(self, name):
        response = self.client.post('/api/v1/auth/login', headers=self.origin,
            json={'login': name, 'password': 'only-for-isolated-test'})
        self.assertEqual(response.status_code, 200, response.text)
        return {**self.origin, 'Authorization': 'Bearer ' + response.json()['access_token']}

    def query(self, statement, params=()):
        self.db.execute('RESET ROLE')
        result = self.db.execute(statement, params).fetchall()
        self.db.execute('SET LOCAL ROLE backend_api')
        return result

    def work(self, name, params=()):
        self.db.execute('SET LOCAL ROLE backend_executor')
        try:
            with self.db.transaction():
                placeholders = ','.join(['%s'] * len(params))
                if name=='prepare_run_proposal':
                    context=self.db.execute('SELECT backend_api.agent_run_context(%s,%s) AS context',params[:2]).fetchone()['context']
                    with user_context(self.db,context['actor']['user_id'],prepare=True):
                        return self.db.execute(f'SELECT backend_api.{name}({placeholders}) AS value',params).fetchone()['value']
                return self.db.execute(f'SELECT backend_api.{name}({placeholders}) AS value', params).fetchone()['value']
        finally:
            self.db.execute('SET LOCAL ROLE backend_api')

    def create(self, title='Рабочий чат', key=None):
        response = self.client.post('/api/v1/agent/sessions', headers={**self.headers, 'Idempotency-Key': str(key or uuid4())}, json={'title': title})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def start(self, session=None, message='Проверочный запрос', key=None, token=None):
        with self.db.transaction():
            return chats.start(self.db, ChatRequest(message=message, session_id=session), key or uuid4(), token or self.token)

    def test_scope_signature_jit_setting_is_function_local(self):
        config = self.query("SELECT proconfig FROM pg_proc WHERE oid='agent_backend.scope_signature(integer)'::regprocedure")[0]['proconfig']
        self.assertIn('jit=off', config)
        before = self.query('SHOW jit')[0]['jit']
        signature = self.query('SELECT agent_backend.scope_signature(%s) AS signature', (self.user_id,))[0]['signature']
        self.assertEqual(len(signature), 64)
        self.assertEqual(self.query('SHOW jit')[0]['jit'], before)

    def test_session_crud_idempotency_and_owner_pagination(self):
        key = uuid4()
        first = self.create(' Первый ', key)
        self.assertEqual(first['id'], self.create('Первый', key)['id'])
        second = self.create('Второй')
        page = self.client.get('/api/v1/agent/sessions?limit=1', headers=self.headers).json()
        self.assertTrue(page['has_more'])
        next_page = self.client.get('/api/v1/agent/sessions?limit=1&offset=1', headers=self.headers).json()
        self.assertEqual({page['items'][0]['id'], next_page['items'][0]['id']}, {first['id'], second['id']})
        path = '/api/v1/agent/sessions/' + first['id']
        other = self.login('ivanov.ks')
        self.assertEqual(self.client.get(path, headers=other).status_code, 404)
        self.assertEqual(self.client.patch(path, headers=other, json={'title': 'Чужой'}).status_code, 404)
        for title in ('Первое изменение', 'Последнее изменение'):
            self.assertEqual(self.client.patch(path, headers=self.headers, json={'title': title}).json()['title'], title)
        self.assertEqual(self.client.delete(path, headers=self.headers).status_code, 204)
        self.assertEqual(self.client.get(path, headers=self.headers).status_code, 404)
        duplicate = self.client.post('/api/v1/agent/sessions', headers={**self.headers, 'Idempotency-Key': str(key)}, json={'title': 'Первый'})
        self.assertEqual(duplicate.status_code, 404)

    def test_atomic_start_same_key_busy_and_terminal_replay(self):
        session = self.create()['id']
        key = uuid4()
        run = self.start(session, key=key)
        self.assertEqual(self.start(session, key=key), run)
        with self.assertRaises(psycopg.Error) as duplicate:
            self.start(session, message='Другое тело', key=key)
        self.assertEqual(duplicate.exception.sqlstate, 'P6001')
        with self.assertRaises(psycopg.Error) as busy:
            self.start(session)
        self.assertEqual(busy.exception.sqlstate, 'P8002')
        claimed = self.work('claim_agent_run', (self.worker,))
        self.assertEqual(claimed, run)
        run_id = UUID(run['run_id'])
        context = self.work('agent_run_context', (run_id, self.worker))
        self.assertEqual(context['message'], 'Проверочный запрос')
        self.assertEqual(context['history'], [])
        sequence = self.work('append_agent_event', (run_id, self.worker, 'tool_call', Jsonb({'name': 'query_deanery', 'input': {'query': 'safe fixture'}})))
        self.assertEqual(sequence, 2)
        final = self.work('finish_agent_run', (run_id, self.worker, 'Ответ по сохранённым данным', None))
        self.assertEqual(final['tools_used'], ['query_deanery'])
        self.assertEqual(self.work('finish_agent_run', (run_id, self.worker, 'Повтор', None)), final)
        replay = chats.events(self.db, run_id, self.token, 1)
        self.assertEqual([event['sequence'] for event in replay['events']], [2, 3])
        self.assertTrue(replay['finished'])
        self.assertEqual(self.start(session, key=key), run)
        self.assertIsNone(self.work('claim_agent_run', (uuid4(),)))
        messages = self.client.get(f'/api/v1/agent/sessions/{session}/messages', headers=self.headers).json()['items']
        self.assertEqual([x['role'] for x in messages], ['user', 'agent'])
        self.assertEqual(messages[1]['text'], final['answer'])
        self.assertEqual(self.query('SELECT count(*) AS n FROM agent_backend.agent_run WHERE session_id=%s', (session,))[0]['n'], 1)

    def test_stop_prevents_tools_and_delete_clears_copies_preserves_proposals(self):
        run = self.start(message='Удаляемый приватный вопрос')
        run_id = UUID(run['run_id'])
        self.work('claim_agent_run', (self.worker,))
        row = self.query('SELECT s.student_id,s.needs_dormitory FROM deanery.student s ORDER BY student_id LIMIT 1')[0]
        command = {'version': 1, 'kind': 'record_change', 'resource': 'student', 'operation': 'update',
            'key': {'student_id': row['student_id']}, 'fields': {'needs_dormitory': not row['needs_dormitory']}}
        self.db.execute('SET LOCAL ROLE backend_executor')
        proposal = proposals.prepare_for_run(self.db, run_id, self.worker, command, 'Изменение общежития', 'Заявление студента', uuid4())
        self.db.execute('SET LOCAL ROLE backend_api')
        path = '/api/v1/agent/sessions/' + run['session_id']
        self.assertEqual(self.client.delete(path, headers=self.headers).status_code, 409)
        stopped = self.client.post(f'/api/v1/agent/runs/{run_id}/cancel', headers=self.headers, json={})
        self.assertEqual(stopped.status_code, 202)
        with self.assertRaises(psycopg.Error) as denied:
            self.work('append_agent_event', (run_id, self.worker, 'status', Jsonb({'phase': 'late'})))
        self.assertEqual(denied.exception.sqlstate, 'P8007')
        self.work('finish_agent_run', (run_id, self.worker, 'Не должен стать успешным ответом', None))
        self.assertEqual(chats.events(self.db, run_id, self.token, 0)['events'][-1]['data']['type'], 'agent_cancelled')
        self.assertEqual(self.client.delete(path, headers=self.headers).status_code, 204)
        cleared = self.query('''SELECT r.events,r.result,r.session_id,q.request_text,q.response_text
            FROM agent_backend.agent_run r JOIN deanery.agent_request q USING(agent_request_id) WHERE r.id=%s''', (run_id,))[0]
        self.assertEqual(cleared, {'events': [], 'result': None, 'session_id': None, 'request_text': 'Переписка удалена', 'response_text': None})
        self.assertTrue(all(x['response_body'] is None for x in self.query('SELECT response_body FROM agent_backend.idempotency_record WHERE run_id=%s', (run_id,))))
        self.assertEqual(self.client.get('/api/v1/agent/proposals/' + proposal['id'], headers=self.headers).status_code, 200)

    def test_expired_lease_never_regenerates_and_queued_cancel_finishes(self):
        run = self.start()
        run_id = UUID(run['run_id'])
        self.work('claim_agent_run', (self.worker,))
        self.query("UPDATE agent_backend.agent_run SET lease_until=clock_timestamp()-interval '1 second' WHERE id=%s RETURNING id", (run_id,))
        self.assertIsNone(self.work('claim_agent_run', (uuid4(),)))
        replay = chats.events(self.db, run_id, self.token, 0)
        self.assertTrue(replay['finished'])
        self.assertEqual(replay['events'][-1]['data']['type'], 'agent_outcome_unknown')
        self.assertIsNone(self.work('claim_agent_run', (uuid4(),)))
        next_run = self.start(run['session_id'])
        stopped = self.client.post('/api/v1/agent/runs/' + next_run['run_id'] + '/cancel', headers=self.headers, json={})
        self.assertEqual(stopped.status_code, 202)
        self.assertTrue(chats.events(self.db, UUID(next_run['run_id']), self.token, 0)['finished'])
        self.assertEqual(self.client.post('/api/v1/agent/runs/' + next_run['run_id'] + '/cancel', headers=self.headers, json={}).status_code, 200)

    def test_scope_change_redacts_history_and_stops_context_without_global_data_false_positive(self):
        teacher = self.login('novikov')
        token = teacher['Authorization'][7:]
        run = self.start(token=token)
        run_id = UUID(run['run_id'])
        self.work('claim_agent_run', (self.worker,))
        self.work('append_agent_event', (run_id, self.worker, 'tool_result', Jsonb({'output': 'Прежние учебные данные'})))
        self.query("UPDATE deanery.student SET needs_dormitory=NOT needs_dormitory WHERE student_id=(SELECT min(student_id) FROM deanery.student) RETURNING student_id")
        self.assertTrue(self.work('renew_agent_run', (run_id, self.worker)))
        self.query('''UPDATE deanery.curriculum_item ci SET semester=choice.semester
            FROM (SELECT ci.item_id,n AS semester FROM deanery.curriculum_item ci
                JOIN deanery.curriculum c USING(curriculum_id) CROSS JOIN generate_series(1,12) n
                WHERE n<=ceil(c.duration_years*2) AND n<>ci.semester
                AND EXISTS(SELECT 1 FROM deanery.teaching_assignment ta JOIN deanery.employee e ON e.employee_id=ta.teacher_id
                    JOIN deanery.app_user u ON u.person_id=e.person_id WHERE u.login='novikov' AND ta.item_id=ci.item_id)
                AND NOT EXISTS(SELECT 1 FROM deanery.curriculum_item existing WHERE existing.curriculum_id=ci.curriculum_id
                    AND existing.discipline_id=ci.discipline_id AND existing.semester=n)
                ORDER BY ci.item_id,n LIMIT 1) choice WHERE ci.item_id=choice.item_id RETURNING ci.item_id''')
        with self.assertRaises(psycopg.Error) as changed:
            self.work('agent_run_context', (run_id, self.worker))
        self.assertEqual(changed.exception.sqlstate, 'P8008')
        with self.assertRaises(psycopg.Error) as forbidden, self.db.transaction():
            chats.events(self.db, run_id, token, 0)
        self.assertEqual(forbidden.exception.sqlstate, 'P8008')
        self.work('finish_agent_run', (run_id, self.worker, 'Старый ответ', None))
        items = self.client.get('/api/v1/agent/sessions/' + run['session_id'] + '/messages', headers=teacher).json()['items']
        self.assertTrue(all('Сообщение скрыто' in item['text'] for item in items))

    def test_auth_family_revocation_and_worker_capability_cannot_be_forged(self):
        run = self.start()
        run_id = UUID(run['run_id'])
        self.work('claim_agent_run', (self.worker,))
        with self.assertRaises(psycopg.Error) as forged:
            self.work('agent_run_context', (run_id, uuid4()))
        self.assertEqual(forged.exception.sqlstate, 'P8009')
        with self.assertRaises(psycopg.errors.InsufficientPrivilege), self.db.transaction():
            self.db.execute('SELECT backend_api.claim_agent_run(%s)', (uuid4(),))
        self.assertEqual(self.client.post('/api/v1/auth/logout', headers=self.headers).status_code, 204)
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.work('agent_run_context', (run_id, self.worker))
        self.work('finish_agent_run', (run_id, self.worker, 'Старый ответ', None))
        final = self.query('SELECT error_code,status FROM agent_backend.agent_run WHERE id=%s', (run_id,))[0]
        self.assertEqual(final, {'error_code': 'forbidden', 'status': 'failed'})
