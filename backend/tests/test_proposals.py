"""New proposal and queue behavior against the isolated PostgreSQL."""

from datetime import timedelta
from uuid import UUID, uuid4

import psycopg
from backend import proposals
from backend.database_actor import user_context
from backend.tests.test_auth import DatabaseHttpCase


class ProposalHelpers:
    def setUp(self):
        super().setUp()
        self.db.execute("SET LOCAL search_path TO pg_catalog,deanery")
        self.db.execute("SET LOCAL TIME ZONE 'Europe/Moscow'")

    def login(self, name):
        response = self.client.post('/api/v1/auth/login', headers=self.origin,
            json={'login': name, 'password': 'only-for-isolated-test'})
        self.assertEqual(response.status_code, 200, response.text)
        return {**self.origin, 'Authorization': 'Bearer ' + response.json()['access_token']}

    def query(self, query, params=()):
        self.db.execute('RESET ROLE')
        result = self.db.execute(query, params).fetchall()
        self.db.execute('SET LOCAL ROLE backend_api')
        return result

    def user(self, login):
        return self.query('SELECT user_id FROM deanery.app_user WHERE login=%s', (login,))[0]['user_id']

    def create_run(self, headers):
        actor = self.client.get('/api/v1/auth/me', headers=headers).json()['user_id']
        session = self.query("INSERT INTO agent_backend.chat_session(user_id,title) VALUES(%s,'Test') RETURNING id", (actor,))[0]['id']
        request = self.query('INSERT INTO deanery.agent_request(user_id,request_text) VALUES(%s,%s) RETURNING agent_request_id',
            (actor, 'Проверка предложения'))[0]['agent_request_id']
        run = self.query("INSERT INTO agent_backend.agent_run(session_id,initiator_user_id,agent_request_id,status) VALUES(%s,%s,%s,'running') RETURNING id",
            (session, actor, request))[0]['id']
        return run, session, request

    def prepare(self, command, headers, run_id=None, key=None, supersedes=None):
        if run_id is None:
            run_id = self.create_run(headers)[0]
        author=self.user_from_headers(headers)
        self.db.execute('SET LOCAL ROLE backend_executor')
        try:
            with self.db.transaction():
                with user_context(self.db,author,prepare=True):
                    return proposals.prepare(self.db, run_id, command, 'Проверяемое изменение', 'Основание пользователя',
                        key or uuid4(), headers['Authorization'][7:], supersedes)
        finally:
            self.db.execute('SET LOCAL ROLE backend_api')

    def user_from_headers(self,headers):
        return self.client.get('/api/v1/auth/me',headers=headers).json()['user_id']

    def record(self, resource, operation, key, fields):
        return {'version': 1, 'kind': 'record_change', 'resource': resource, 'operation': operation, 'key': key, 'fields': fields}

    def group_command(self):
        group = self.query('SELECT group_id,curriculum_id FROM deanery.study_group ORDER BY group_id LIMIT 1')[0]
        return self.record('study_group', 'update', {'group_id': group['group_id']}, {'name': self.free_group_name(group['curriculum_id'])})

    def free_group_name(self, curriculum):
        prefix = self.query('SELECT deanery.fn_group_prefix(%s) AS prefix', (curriculum,))[0]['prefix']
        names = {r['name'] for r in self.query('SELECT name FROM deanery.study_group')}
        return next(prefix + str(i) for i in range(99,49,-1) if prefix + str(i) not in names)

    def post(self, proposal, action, body, headers, key=None, status=200):
        response = self.client.post('/api/v1/agent/proposals/' + proposal['id'] + '/' + action,
            json=body, headers={**headers, 'Idempotency-Key': str(key or uuid4())})
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def decision(self, p, headers, approve=True, key=None, status=200, version=True):
        data = {'approve': approve, 'reason': 'Проверено сотрудником деканата'}
        if version:
            data['expected_version'] = p['version']
        return self.post(p, 'decision', data, headers, key, status)

    def get(self, p, headers, status=200):
        response = self.client.get('/api/v1/agent/proposals/' + p['id'], headers=headers)
        self.assertEqual(response.status_code, status, response.text)
        return response.json()


class ProposalTests(ProposalHelpers,DatabaseHttpCase):
    def test_prepare_is_internal_immutable_and_approve_is_once_with_audit(self):
        headers = self.login('vasilyeva')
        command = self.group_command()
        run, _, request = self.create_run(headers)
        key = uuid4()
        p = self.prepare(command, headers, run, key)
        self.assertEqual(self.prepare(command, headers, run, key)['id'], p['id'])
        self.assertEqual(p['routing']['assignee_user_id'], self.user_id)
        group_id = command['key']['group_id']
        self.assertNotEqual(self.query('SELECT name FROM deanery.study_group WHERE group_id=%s', (group_id,))[0]['name'], command['fields']['name'])
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            with self.db.transaction():
                proposals.prepare(self.db, run, command, 'test', 'test', uuid4(), headers['Authorization'][7:])
        self.db.execute('RESET ROLE')
        with self.assertRaises(psycopg.errors.CheckViolation):
            with self.db.transaction():
                self.db.execute("UPDATE agent_backend.proposal SET command='{}' WHERE id=%s", (p['id'],))
        self.db.execute('SET LOCAL ROLE backend_api')
        key = uuid4()
        result = self.decision(p, headers, key=key)
        self.assertEqual((result['status'], result['execution']['status'], result['validity']['state']), ('approved', 'succeeded', 'current'))
        self.assertEqual(self.decision(p, headers, key=key)['version'], result['version'])
        self.assertEqual(self.decision(p, headers)['version'], result['version'])
        self.decision(p, headers, approve=False, status=409)
        logs = self.query("SELECT app_user_id FROM deanery.audit_log WHERE agent_request_id=%s AND table_name='study_group'", (request,))
        self.assertEqual(logs, [{'app_user_id': self.user_id}])

    def test_student_queue_claim_transfer_old_assignee_loses_right_and_chat_delete_keeps_proposal(self):
        student, staff, director = [self.login(name) for name in ('ivanov.ks', 'kuznetsova', 'smirnov')]
        doc_type = self.query('SELECT document_type_id FROM deanery.document_type ORDER BY document_type_id LIMIT 1')[0]['document_type_id']
        run, session, _ = self.create_run(student)
        p = self.prepare(self.record('document_request', 'create', {}, {'document_type_id': doc_type, 'copies': 1, 'purpose': 'Для проверки'}), student, run)
        self.assertIsNone(p['routing']['assignee_user_id'])
        self.assertFalse(p['actions']['can_approve'])
        self.decision(p, student, status=403)
        incoming = self.client.get('/api/v1/agent/proposals?box=incoming', headers=staff)
        self.assertEqual(incoming.status_code, 200, incoming.text)
        self.assertIn(p['id'], [item['id'] for item in incoming.json()['items']])
        self.assertEqual(self.client.get('/api/v1/agent/proposals?box=incoming', headers=student).json()['counts']['incoming'], 0)
        self.decision(p, director, status=403)
        self.post(p, 'assignment', {'assignee_user_id': self.user('smirnov'),
            'reason': 'Передача до принятия в работу', 'expected_version': 1}, staff, status=403)
        assignment_key = uuid4()
        assignment = {'assignee_user_id': self.user('kuznetsova'), 'reason': 'Взято в работу', 'expected_version': 1}
        claimed = self.post(p, 'assignment', assignment, staff, assignment_key)
        self.assertEqual(self.post(p, 'assignment', assignment, staff, assignment_key)['version'], claimed['version'])
        self.post(p, 'assignment', {'assignee_user_id': self.user('smirnov'), 'reason': 'Взято в работу', 'expected_version': 1}, director, status=409)
        assigned = self.post(claimed, 'assignment', {'assignee_user_id': self.user('smirnov'), 'reason': 'Передано директору для проверки', 'expected_version': claimed['version']}, staff)
        self.decision(assigned, staff, status=404)
        self.assertEqual(self.get(assigned, director)['actions']['can_approve'], True)
        self.query("UPDATE agent_backend.agent_run SET status='done',finished_at=now() WHERE id=%s RETURNING id", (run,))
        self.query('DELETE FROM agent_backend.chat_session WHERE id=%s RETURNING id', (session,))
        self.assertEqual(self.get(assigned, student)['id'], p['id'])
        self.assertEqual(self.decision(assigned, director)['execution']['status'], 'succeeded')

    def test_stale_expired_and_inactive_author_can_be_rejected(self):
        admin, director = self.login('vasilyeva'), self.login('smirnov')
        p = self.prepare(self.group_command(), admin)
        transferred = self.post(p, 'assignment', {'assignee_user_id': self.user('smirnov'), 'reason': 'Передано директору', 'expected_version': p['version']}, admin)
        group_id = self.group_command()['key']['group_id']
        self.query('UPDATE deanery.study_group SET name=%s WHERE group_id=%s RETURNING group_id', (self.group_command()['fields']['name'],group_id))
        self.assertEqual(self.get(transferred, director)['validity']['state'], 'stale')
        self.decision(transferred, director, status=409)
        self.query('UPDATE deanery.app_user SET is_active=FALSE WHERE user_id=%s RETURNING user_id', (self.user_id,))
        self.assertEqual(self.decision(transferred, director, approve=False)['status'], 'rejected')
        # Expiry is immutable; create an already-expired persisted fixture rather than weakening its trigger.
        p2 = self.query("""INSERT INTO agent_backend.proposal(initiator_user_id,kind,command,preview,snapshot,snapshot_hash,
            explanation,reason,expires_at,institute_id,assignee_user_id)
            SELECT %s,kind,command,preview,snapshot,snapshot_hash,explanation,reason,now()-interval '1 hour',institute_id,%s
            FROM agent_backend.proposal WHERE id=%s RETURNING id""", (self.user('smirnov'), self.user('smirnov'), p['id']))[0]
        expired = self.get({'id': str(p2['id'])}, director)
        self.assertEqual(expired['validity']['state'], 'expired')
        self.decision(expired, director, status=409)
        self.assertEqual(self.decision(expired, director, approve=False)['status'], 'rejected')

    def test_foreign_run_scope_and_api_input_guards(self):
        admin, student = self.login('vasilyeva'), self.login('ivanov.ks')
        run = self.create_run(student)[0]
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.prepare(self.group_command(), admin, run)
        p = self.prepare(self.group_command(), admin)
        self.get(p, student, status=404)
        self.assertEqual(self.client.get('/api/v1/agent/proposals?box=unknown', headers=admin).status_code, 422)
        self.assertEqual(self.client.get('/api/v1/agent/proposals?limit=101', headers=admin).status_code, 422)
        self.post(p, 'decision', {'approve': True, 'reason': 'short'}, admin, status=422)
        self.post(p, 'decision', {'approve': True, 'reason': 'Допустимая причина', 'command': {}}, admin, status=422)
        self.post(p, 'assignment', {'assignee_user_id': self.user('ivanov.ks'), 'reason': 'Передача студенту', 'expected_version': p['version']}, admin, status=403)
        assignees = self.client.get('/api/v1/agent/proposals/' + p['id'] + '/assignees', headers=admin)
        self.assertEqual(assignees.status_code, 200, assignees.text)
        self.assertTrue(all(x['role'] in ('admin', 'director', 'dean_staff') for x in assignees.json()))
        staff = self.login('kuznetsova')
        foreign = self.query('INSERT INTO deanery.institute(name,short_name) VALUES(%s,%s) RETURNING institute_id',
            ('Чужой тестовый институт ' + uuid4().hex, 'PQ' + uuid4().hex[:10]))[0]['institute_id']
        self.query('''UPDATE deanery.dean_office_staff ds SET institute_id=%s FROM deanery.employee e
            JOIN deanery.app_user u ON u.person_id=e.person_id WHERE ds.employee_id=e.employee_id AND u.login='kuznetsova'
            RETURNING ds.employee_id''', (foreign,))
        self.get(p, staff, status=404)
        self.assertEqual(self.client.get('/api/v1/agent/proposals?box=incoming', headers=staff).json()['counts']['incoming'], 0)

    def test_deleted_target_can_be_claimed_for_rejection_but_never_approved(self):
        admin, staff = self.login('vasilyeva'), self.login('kuznetsova')
        plan = self.query('SELECT curriculum_id FROM deanery.study_group ORDER BY group_id LIMIT 1')[0]
        created = self.client.post('/api/v1/resources/study_group', headers=admin,
            json={**plan, 'name': self.free_group_name(plan['curriculum_id'])})
        self.assertEqual(created.status_code, 200, created.text)
        command = self.record('study_group', 'update', {'group_id': created.json()['group_id']}, {'is_archived': True})
        p = self.prepare(command, admin)
        response = self.client.delete('/api/v1/resources/study_group', params=command['key'], headers=admin)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.get(p, admin)['validity']['state'], 'stale')
        assigned = self.post(p, 'assignment', {'assignee_user_id': self.user('kuznetsova'),
            'reason': 'Закрыть утратившее актуальность предложение', 'expected_version': p['version']}, admin)
        self.decision(assigned, staff, status=409)
        self.assertEqual(self.decision(assigned, staff, approve=False)['status'], 'rejected')

    def test_teacher_topic_uses_queue_and_execution_preserves_author_and_decider(self):
        teacher, staff = self.login('novikov'), self.login('kuznetsova')
        work = self.query("""SELECT w.work_id FROM deanery.academic_work w JOIN deanery.employee e ON e.employee_id=w.supervisor_id
            JOIN deanery.app_user u ON u.person_id=e.person_id WHERE u.login='novikov' ORDER BY work_id LIMIT 1""")[0]
        run, _, request = self.create_run(teacher)
        p = self.prepare(self.record('academic_work', 'update', work, {'topic': 'Утверждаемая тема работы'}), teacher, run)
        self.assertIsNone(p['routing']['assignee_user_id'])
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.prepare(self.record('academic_work', 'update', work, {'topic': 'Другая тема', 'reviewer_id': None}), teacher, run)
        taken = self.post(p, 'assignment', {'assignee_user_id': self.user('kuznetsova'),
            'reason': 'Взято в работу', 'expected_version': p['version']}, staff)
        done = self.decision(taken, staff)
        self.assertEqual(done['initiator']['user_id'], self.user('novikov'))
        self.assertEqual(done['decided_by'], 'kuznetsova')
        self.assertEqual(self.query("SELECT app_user_id FROM deanery.audit_log WHERE agent_request_id=%s AND table_name='academic_work'", (request,)),
            [{'app_user_id': self.user('kuznetsova')}])

    def test_supersession_version_and_event_pagination(self):
        admin = self.login('vasilyeva')
        run = self.create_run(admin)[0]
        p = self.prepare(self.group_command(), admin, run)
        replacement = self.prepare(self.group_command(), admin, run, supersedes=UUID(p['id']))
        self.assertNotEqual(p['id'], replacement['id'])
        self.assertEqual(self.get(p, admin)['validity']['state'], 'superseded')
        self.decision(p, admin, status=409)
        history = self.client.get('/api/v1/agent/proposals?box=completed', headers=admin).json()
        self.assertIn(p['id'], [x['id'] for x in history['items']])
        events = self.client.get('/api/v1/agent/proposals/' + p['id'] + '/events?limit=1', headers=admin).json()
        self.assertTrue(events['has_more'])
        event_id = events['items'][0]['id']
        next_page = self.client.get(f"/api/v1/agent/proposals/{p['id']}/events?after={event_id}", headers=admin).json()
        self.assertEqual(next_page['items'][0]['event_type'], 'superseded')

    def enrollment(self):
        group = self.query("SELECT g.name,i.director_id FROM deanery.study_group g JOIN deanery.institute i ON i.institute_id=deanery.fn_group_institute(g.group_id) WHERE NOT g.is_archived ORDER BY g.group_id LIMIT 1")[0]
        today = self.query('SELECT CURRENT_DATE AS day')[0]['day']
        return {'version': 1, 'kind': 'workflow', 'name': 'enroll_student', 'fields': {
            'order_number': 'PQ-' + uuid4().hex[:12], 'signed_by': group['director_id'], 'last_name': 'Проверочный',
            'first_name': 'Студент', 'gender': 'M', 'birth_date': '2005-01-01', 'group_name': group['name'],
            'funding': self.query('SELECT name FROM deanery.funding_type LIMIT 1')[0]['name'],
            'record_book': 'PQ' + uuid4().hex[:12], 'effective_date': (today + timedelta(days=5)).isoformat()}}

    def test_renamed_workflow_group_keeps_historical_rejection_available(self):
        admin = self.login('vasilyeva')
        command = self.enrollment()
        p = self.prepare(command, admin)
        curriculum = self.query('SELECT curriculum_id FROM deanery.study_group WHERE name=%s', (command['fields']['group_name'],))[0]['curriculum_id']
        self.query('UPDATE deanery.study_group SET name=%s WHERE name=%s RETURNING group_id',
            (self.free_group_name(curriculum), command['fields']['group_name']))
        stale = self.get(p, admin)
        self.assertEqual(stale['validity']['state'], 'stale')
        self.assertTrue(stale['actions']['can_reject'])
        self.decision(p, admin, status=409)
        self.assertEqual(self.decision(p, admin, approve=False)['status'], 'rejected')

    def test_future_workflow_reports_scheduled_and_reconciles_only_applied_order(self):
        admin = self.login('vasilyeva')
        p = self.prepare(self.enrollment(), admin)
        done = self.decision(p, admin)
        self.assertEqual(done['execution']['status'], 'scheduled')
        job = done['execution']['job_id']
        self.query("UPDATE agent_backend.job SET status='succeeded' WHERE id=%s RETURNING id", (job,))
        self.assertEqual(self.get(done, admin)['execution']['status'], 'scheduled')
        self.query("UPDATE agent_backend.job SET status='failed',error_code='test_failure',finished_at=now() WHERE id=%s RETURNING id", (job,))
        self.assertEqual(self.get(done, admin)['execution']['status'], 'failed')
        # Simulate the date arriving only in this rolled-back fixture, then restore the source guard.
        self.db.execute('RESET ROLE')
        self.db.execute('ALTER TABLE deanery.academic_order DISABLE TRIGGER order_immutable')
        self.db.execute('UPDATE deanery.academic_order SET effective_date=CURRENT_DATE WHERE order_id=%s',
            (done['execution']['order_id'],))
        self.db.execute('ALTER TABLE deanery.academic_order ENABLE TRIGGER order_immutable')
        self.db.execute('SET LOCAL ROLE backend_api')
        self.query('SELECT backend_api.apply_tracked_order(%s,%s)',
            (done['execution']['order_id'], done['execution']['student_id']))
        self.assertEqual(self.get(done, admin)['execution']['status'], 'succeeded')
        student = self.query('SELECT st.name FROM deanery.student s JOIN deanery.student_status st USING(status_id) WHERE s.student_id=%s',
            (done['execution']['student_id'],))[0]
        self.assertEqual(student['name'], 'Обучается')

    def clone_for_queue_filter(self, proposal, created_at, status='pending', execution='not_started'):
        return str(self.query("""INSERT INTO agent_backend.proposal(initiator_user_id,kind,command,preview,snapshot,snapshot_hash,
            explanation,reason,expires_at,institute_id,assignee_user_id,created_at,status,execution)
            SELECT initiator_user_id,kind,command,preview,snapshot,snapshot_hash,explanation,reason,expires_at,
                institute_id,assignee_user_id,%s,%s,jsonb_build_object('status',%s::TEXT)
            FROM agent_backend.proposal WHERE id=%s RETURNING id""", (created_at, status, execution, proposal['id']))[0]['id'])

    def filtered_queue(self, headers, **params):
        response = self.client.get('/api/v1/agent/proposals', headers=headers, params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_queue_author_moscow_boundaries_and_stable_pages(self):
        admin = self.login('vasilyeva')
        proposal = self.prepare(self.group_command(), admin)
        before = self.clone_for_queue_filter(proposal, '2024-06-04T20:59:59.999999Z')
        start = self.clone_for_queue_filter(proposal, '2024-06-04T21:00:00Z')
        end1 = self.clone_for_queue_filter(proposal, '2024-06-05T20:59:59.999999Z')
        end2 = self.clone_for_queue_filter(proposal, '2024-06-05T20:59:59.999999Z')
        after = self.clone_for_queue_filter(proposal, '2024-06-05T21:00:00Z')
        params = dict(box='mine', author='  VASILYEVA  ', created_from='2024-06-05', created_to='2024-06-05', limit=1)
        pages = [self.filtered_queue(admin, **params, offset=i) for i in range(3)]
        expected = sorted([end1, end2], reverse=True) + [start]
        self.assertEqual([page['items'][0]['id'] for page in pages], expected)
        self.assertNotIn(before, expected)
        self.assertNotIn(after, expected)
        self.assertEqual([page['has_more'] for page in pages], [True, True, False])
        self.assertTrue(all(page['counts'] == {'incoming': 3, 'mine': 3, 'completed': 0} for page in pages))
        by_name = self.filtered_queue(admin, **{**params, 'author': proposal['initiator']['full_name'].split()[0].upper(), 'limit': 100})
        self.assertEqual([p['id'] for p in by_name['items']], expected)
        for literal in ('%', '_', "' OR TRUE --"):
            empty = self.filtered_queue(admin, **{**params, 'author': literal})
            self.assertEqual(empty['counts'], {'incoming': 0, 'mine': 0, 'completed': 0})
            self.assertFalse(empty['has_more'])

    def test_queue_filters_do_not_leak_foreign_author_or_counts(self):
        admin, student, staff = [self.login(name) for name in ('vasilyeva', 'ivanov.ks', 'kuznetsova')]
        proposal = self.prepare(self.group_command(), admin)
        self.clone_for_queue_filter(proposal, '2024-06-05T12:00:00Z')
        params = dict(author='vasilyeva', created_from='2024-06-05', created_to='2024-06-05')
        foreign = self.query('INSERT INTO deanery.institute(name,short_name) VALUES(%s,%s) RETURNING institute_id',
            ('Чужой институт фильтров ' + uuid4().hex, 'PF' + uuid4().hex[:10]))[0]['institute_id']
        self.query("""UPDATE deanery.dean_office_staff ds SET institute_id=%s FROM deanery.employee e
            JOIN deanery.app_user u ON u.person_id=e.person_id WHERE ds.employee_id=e.employee_id AND u.login='kuznetsova'
            RETURNING ds.employee_id""", (foreign,))
        for headers in (student, staff):
            for box in ('incoming', 'mine', 'completed'):
                page = self.filtered_queue(headers, **params, box=box)
                self.assertEqual(page['items'], [])
                self.assertEqual(page['counts'], {'incoming': 0, 'mine': 0, 'completed': 0})
                self.assertFalse(page['has_more'])

    def test_queue_state_filters_counts_and_six_argument_compatibility(self):
        admin = self.login('vasilyeva')
        proposal = self.prepare(self.group_command(), admin)
        for execution in ('scheduled', 'failed', 'cancelled'):
            saved = self.clone_for_queue_filter(proposal, '2024-06-05T12:00:00Z', 'approved', execution)
            params = dict(author='vasilyeva', created_from='2024-06-05', created_to='2024-06-05', status='approved', execution_status=execution)
            for box in ('mine', 'completed'):
                page = self.filtered_queue(admin, **params, box=box)
                self.assertEqual([p['id'] for p in page['items']], [saved])
                self.assertEqual(page['counts'], {'incoming': 0, 'mine': 1, 'completed': 1})
            self.assertEqual(self.filtered_queue(admin, **params, box='incoming')['items'], [])
        token = admin['Authorization'][7:]
        legacy = self.db.execute('SELECT backend_api.list_proposals(%s,%s,%s,%s,%s,%s) AS result',
            (token, 'mine', 'approved', 'cancelled', 50, 0)).fetchone()['result']
        current = proposals.listing(self.db, token, 'mine', 'approved', 'cancelled', 50, 0)
        self.assertEqual(legacy, current)
        self.assertFalse(self.query("""SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
            aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=
            'backend_api.list_proposals(text,text,text,text,integer,integer,text,date,date)'::regprocedure
            AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute""")[0]['public_execute'])

    def test_queue_rejects_invalid_author_dates_and_bounds(self):
        admin = self.login('vasilyeva')
        for params in ({'author': 'x' * 201}, {'created_from': 'not-a-date'}, {'created_to': '2024-02-30'},
                       {'created_from': '2024-06-06', 'created_to': '2024-06-05'}, {'limit': 101}, {'offset': -1}):
            response = self.client.get('/api/v1/agent/proposals', headers=admin, params=params)
            self.assertEqual(response.status_code, 422, response.text)
        self.db.execute("SET LOCAL TIME ZONE 'UTC'")
        proposal = self.prepare(self.group_command(), admin)
        saved = self.clone_for_queue_filter(proposal, '2024-06-04T21:00:00Z')
        page = self.filtered_queue(admin, box='mine', author='vasilyeva', created_from='2024-06-05', created_to='2024-06-05')
        self.assertEqual([p['id'] for p in page['items']], [saved])
