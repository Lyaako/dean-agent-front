"""Пять режимов OLAP в SQL: те же ответы, что у прежнего расчёта в Python, та же область по ролям, тот же расчёт у агента."""
import json
import os
from unittest.mock import patch
from uuid import uuid4

import pytest

from backend.tests.test_auth import DatabaseHttpCase
from backend.tests.test_manual_resources import ManualResourceHelpers
from backend.tests.test_agent_runtime import bound_tools, live_runs  # noqa: F401  (фикстура pytest)

QUERIES = ('mode=session', 'mode=session&semester=2', 'mode=session&level=group&course=3', 'mode=session&level=discipline&group_id=1',
           'mode=session&level=result&group_id=1&discipline_id=1&semester=1', 'mode=session&status_id=1',
           'mode=heat', 'mode=heat&semester=2', 'mode=heat&discipline_id=1', 'mode=risk', 'mode=risk&mod_min=54&att_min=100',
           'mode=risk&mod_min=25&att_min=0', 'mode=risk&course=2', 'mode=retake', 'mode=retake&level=course', 'mode=retake&group_id=1',
           'mode=moves', 'mode=moves&period=semester&list=true', 'mode=moves&period=year&types=expel,leave&from=2025-09&to=2026-08&list=true',
           'mode=moves&period=year&pick=2025/26', 'mode=moves&course=2&semester=2')


def same(body):
    """Порядок строк moves с pick и ключей by_type прежний расчёт брал из физического порядка строк — сравниваем без него."""
    body = json.loads(json.dumps(body))
    body.pop('request_id', None)
    if body.get('mode') == 'moves' and body['filters'].get('pick') is not None:
        for row in body['rows']:
            row['students'].sort(key=lambda s: s['student_id'])
        body['rows'].sort(key=lambda r: r['order_id'])
    return body


class OlapSqlTests(ManualResourceHelpers, DatabaseHttpCase):
    def answers(self, headers, engine, queries=QUERIES):
        with patch.dict(os.environ, {'OLAP_ENGINE': engine}):
            return {q: (r.status_code, same(r.json())) for q in queries
                    for r in [self.client.get('/api/v1/olap?' + q, headers=headers)]}

    def test_sql_answers_match_the_python_calculation(self):
        for login in ('vasilyeva', 'smirnov', 'kuznetsova', 'novikov'):
            with self.subTest(login=login):
                headers = self.login(login)
                python, sql = self.answers(headers, 'python'), self.answers(headers, 'sql')
                for query in QUERIES:
                    self.assertEqual(sql[query][0], 200, (query, sql[query]))
                    self.assertEqual(sql[query], python[query], query)

    def test_keys_and_numbers_keep_the_python_form(self):
        headers = self.login('vasilyeva')
        with patch.dict(os.environ, {'OLAP_ENGINE': 'sql'}):
            raw = self.client.get('/api/v1/olap?mode=heat&semester=2', headers=headers).text
            risk = self.client.get('/api/v1/olap?mode=risk', headers=headers).json()
        with patch.dict(os.environ, {'OLAP_ENGINE': 'python'}):
            expected = self.client.get('/api/v1/olap?mode=heat&semester=2', headers=headers).text
        self.assertEqual(raw.split('"request_id"')[0], expected.split('"request_id"')[0])
        self.assertTrue(all(isinstance(p['avg_points'], float) for p in risk['points']))
        with self.owner():
            # round(x,2) в Python: ровно посередине — к чётной (3.125 → 3.12, 9.375 → 9.38), иначе как обычно.
            got = self.db.execute("""SELECT agent_backend.olap_pct2(1,32)::float8 AS a,agent_backend.olap_pct2(3,32)::float8 AS b,
                agent_backend.olap_pct2(1,3)::float8 AS c,agent_backend.olap_pct(1,8)::int AS d,agent_backend.olap_pct(0,0) AS e""").fetchone()
        self.assertEqual(got, {'a': round(100 * 1 / 32, 2), 'b': round(100 * 3 / 32, 2), 'c': round(100 / 3, 2), 'd': 13, 'e': None})

    def test_other_institute_is_outside_dean_and_director_scope(self):
        before = {login: self.answers(self.login(login), 'sql', ('mode=session', 'mode=risk')) for login in ('kuznetsova', 'vasilyeva')}
        with self.owner():
            institute = self.db.execute("INSERT INTO deanery.institute(name,short_name) VALUES(%s,%s) RETURNING institute_id",
                                        ('Другой ' + uuid4().hex, 'D' + uuid4().hex[:8])).fetchone()['institute_id']
            department = self.db.execute("""INSERT INTO deanery.department(institute_id,name,short_name) VALUES(%s,%s,%s)
                RETURNING department_id""", (institute, 'Кафедра ' + uuid4().hex, 'K' + uuid4().hex[:8])).fetchone()['department_id']
            program = self.db.execute("""UPDATE deanery.study_program p SET department_id=%s FROM deanery.curriculum c, deanery.study_group g
                WHERE c.program_id=p.program_id AND g.curriculum_id=c.curriculum_id AND g.group_id=1 RETURNING p.program_id""",
                (department,)).fetchone()['program_id']
            moved = {r['name'] for r in self.db.execute("""SELECT g.name FROM deanery.study_group g JOIN deanery.curriculum c USING(curriculum_id)
                WHERE c.program_id=%s""", (program,))}
            moved_students = {r['student_id'] for r in self.db.execute("""SELECT s.student_id FROM deanery.student s
                JOIN deanery.study_group g USING(group_id) JOIN deanery.curriculum c USING(curriculum_id) WHERE c.program_id=%s""", (program,))}
        self.assertTrue(moved)
        for login in ('kuznetsova', 'smirnov'):
            with self.subTest(login=login):
                headers = self.login(login)
                sql = self.answers(headers, 'sql')
                self.assertEqual(sql, self.answers(headers, 'python'))
                for query in ('mode=session&level=discipline&group_id=1', 'mode=retake&group_id=1'):
                    self.assertEqual(sql[query][1]['rows'], [], query)
                self.assertFalse({r['name'] for r in sql['mode=retake'][1]['rows']} & moved)
                self.assertFalse({p['student_id'] for p in sql['mode=risk'][1]['points']} & moved_students)
                self.assertFalse({o['group_name'] for o in sql['mode=moves&period=semester&list=true'][1]['orders']} & moved)
        kuznetsova = self.answers(self.login('kuznetsova'), 'sql', ('mode=session', 'mode=risk'))
        self.assertLess(kuznetsova['mode=risk'][1]['total']['pool'], before['kuznetsova']['mode=risk'][1]['total']['pool'])
        # Администратор видит все группы, в том числе другого института.
        self.assertEqual(self.answers(self.login('vasilyeva'), 'sql', ('mode=session', 'mode=risk')), before['vasilyeva'])

    def test_teacher_scope_is_the_groups_of_assignments(self):
        headers = self.login('novikov')
        with self.owner():
            teacher = self.db.execute("""SELECT e.employee_id FROM deanery.app_user u JOIN deanery.employee e USING(person_id)
                WHERE u.login='novikov'""").fetchone()['employee_id']
            user = self.db.execute("SELECT user_id FROM deanery.app_user WHERE login='novikov'").fetchone()['user_id']
            groups = {r['name'] for r in self.db.execute("""SELECT DISTINCT g.name FROM deanery.teaching_assignment ta
                JOIN deanery.study_group g USING(group_id) WHERE ta.teacher_id=%s""", (teacher,))}
            in_groups = {r['student_id'] for r in self.db.execute("""SELECT s.student_id FROM deanery.student s
                WHERE s.group_id IN (SELECT group_id FROM deanery.teaching_assignment WHERE teacher_id=%s)""", (teacher,))}
            # allowed_students у преподавателя шире (курсовые/ВКР в чужих группах) — в OLAP их быть не должно.
            wider = {r['student_id'] for r in self.db.execute('SELECT student_id FROM backend_api.allowed_students(%s)', (user,))} - in_groups
        sql = self.answers(headers, 'sql')
        self.assertTrue({r['group_name'] for r in sql['mode=heat'][1]['rows']} <= groups)
        self.assertTrue({p['student_id'] for p in sql['mode=risk'][1]['points']} <= in_groups)
        self.assertFalse({p['student_id'] for p in sql['mode=risk'][1]['points']} & wider)
        self.assertTrue({r['name'] for r in sql['mode=retake'][1]['rows']} <= groups)
        # Прежние восемь режимов — та же область: все дисциплины групп поручений.
        old = self.client.get('/api/v1/olap?mode=rollup-group', headers=headers).json()
        self.assertTrue({r['name'] for r in old['rows']} <= groups)
        heat = sql['mode=heat'][1]['total']
        self.assertEqual((old['total']['results'], old['total']['debts']), (heat['results'], heat['debts']))
        dice = self.client.get('/api/v1/olap?mode=dice', headers=headers).json()
        self.assertTrue({r['student_id'] for r in dice['rows']} <= in_groups)

    def test_teacher_without_assignments_gets_empty_answers(self):
        with self.owner():
            teacher = self.db.execute("""SELECT e.employee_id FROM deanery.app_user u JOIN deanery.employee e USING(person_id)
                WHERE u.login='novikov'""").fetchone()['employee_id']
            other = self.db.execute("""SELECT e.employee_id FROM deanery.employee e JOIN deanery.teacher t USING(employee_id)
                WHERE e.employee_id<>%s ORDER BY 1 LIMIT 1""", (teacher,)).fetchone()['employee_id']
            self.db.execute('ALTER TABLE deanery.teaching_assignment DISABLE TRIGGER USER')
            self.db.execute('UPDATE deanery.teaching_assignment SET teacher_id=%s WHERE teacher_id=%s', (other, teacher))
            self.db.execute('ALTER TABLE deanery.teaching_assignment ENABLE TRIGGER USER')
        headers = self.login('novikov')
        sql = self.answers(headers, 'sql')
        self.assertEqual(sql, self.answers(headers, 'python'))
        for query, (status, body) in sql.items():
            self.assertEqual(status, 200, query)
            self.assertEqual(body['rows'], [], query)
        self.assertEqual(sql['mode=session'][1]['total'], {'students': 0, 'abs_pct': None, 'qual_pct': None, 'debts': 0, 'excellent': 0})
        self.assertEqual(sql['mode=risk'][1]['total']['pool'], 0)
        self.assertEqual(sql['mode=retake'][1]['total']['expulsion_candidates'], 0)

    def test_student_and_inactive_account_are_refused(self):
        student = self.login('ivanov.ks')
        teacher = self.login('novikov')
        with self.owner():
            self.db.execute("UPDATE deanery.app_user SET is_active=FALSE WHERE login='novikov'")
        for mode in ('session', 'heat', 'risk', 'retake', 'moves'):
            with self.subTest(mode=mode):
                self.assertEqual(self.client.get('/api/v1/olap?mode=' + mode, headers=student).status_code, 403)
                self.assertIn(self.client.get('/api/v1/olap?mode=' + mode, headers=teacher).status_code, (401, 403))

    def test_too_many_facts_is_413_before_the_calculation(self):
        headers = self.login('vasilyeva')
        with self.owner():
            # Лимит 100 000 фактов проверяет olap_check_size; здесь он срабатывает всегда (откатывается с транзакцией).
            self.db.execute("""CREATE OR REPLACE FUNCTION agent_backend.olap_check_size(p_user_id INT) RETURNS VOID
                LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
                BEGIN RAISE EXCEPTION 'olap_too_large' USING ERRCODE='P6413'; END $$""")
        for mode in ('session', 'heat', 'risk', 'retake', 'moves'):
            with self.subTest(mode=mode):
                response = self.client.get('/api/v1/olap?mode=' + mode, headers=headers)
                self.assertEqual((response.status_code, response.json()['error']['code']), (413, 'olap_too_large'))


def test_agent_gets_the_screen_numbers_of_its_author(live_runs):
    from backend import olap
    from backend.agent_tools import encode
    import psycopg
    from psycopg.rows import dict_row
    calls = [({'mode': 'session'}, 'mode=session'), ({'mode': 'session', 'level': 'group', 'course': 3}, 'level=group&course=3'),
             ({'mode': 'heat', 'semester': 2}, 'heat'), ({'mode': 'risk'}, 'risk'), ({'mode': 'retake', 'level': 'course'}, 'retake'),
             ({'mode': 'moves', 'period': 'year'}, 'moves')]
    for login in ('kuznetsova', 'novikov'):
        run = live_runs(login)
        tools, _ = bound_tools(run)
        for call, label in calls:
            arguments = dict(call)
            actual = json.loads(tools['get_olap_analysis'].invoke(arguments))
            mode = arguments.pop('mode')
            params = {'group_id': None, 'discipline_id': None, 'semester': None, 'status_id': None, 'course': None, 'level': None,
                      'mod_min': 30, 'att_min': 70, 'period': 'month', 'pick': None, 'moves': None, **arguments}
            with psycopg.connect(os.environ['TEST_DATABASE_DSN'], row_factory=dict_row) as db:
                db.execute('SET LOCAL ROLE backend_api')
                db.execute("SET LOCAL TIME ZONE 'Europe/Moscow'")
                expected = json.loads(encode(olap.analyze(db, run['token'], mode, **{k: v for k, v in params.items()})))
            expected.pop('points', None)
            assert (actual['rows'], actual['total']) == (expected['rows'], expected['total']), (login, label)
            assert 'points' not in actual
        # Список приказов агенту — только с окном и не больше 200 строк.
        refused = json.loads(tools['get_olap_analysis'].invoke({'mode': 'moves', 'list_orders': True}))
        assert 'error' in refused
        listed = json.loads(tools['get_olap_analysis'].invoke({'mode': 'moves', 'list_orders': True,
                                                              'month_from': '2000-01', 'month_to': '2100-12'}))
        assert len(listed.get('orders', [])) <= olap.AGENT_ORDERS
        assert listed.get('orders_truncated', False) == (len(listed.get('orders', [])) == olap.AGENT_ORDERS)
    student = live_runs('ivanov.ks')
    tools, _ = bound_tools(student)
    assert json.loads(tools['get_olap_analysis'].invoke({'mode': 'session'}))['error'] == 'forbidden'


@pytest.mark.parametrize('engine', ['python', 'sql'])
def test_engine_switch(engine):
    from backend import olap
    with patch.dict(os.environ, {'OLAP_ENGINE': engine}):
        assert olap.engine() == engine
