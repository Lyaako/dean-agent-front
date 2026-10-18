"""New analyses checked against native final results and teacher group scope."""
from backend.tests.test_auth import DatabaseHttpCase
from backend.tests.test_manual_resources import ManualResourceHelpers


class AnalyticsHttpTests(ManualResourceHelpers,DatabaseHttpCase):
    def test_analyses_and_native_session_totals(self):
        admin=self.login('vasilyeva'); teacher=self.login('novikov'); student=self.login('ivanov.ks')
        response=self.client.get('/api/v1/olap?mode=session',headers=admin)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(set(response.json()['total']),{'students','abs_pct','qual_pct','debts','excellent'})
        self.assertEqual(sum(r['students'] for r in response.json()['rows']),response.json()['total']['students'])
        with self.owner():
            tid=self.db.execute("SELECT e.employee_id FROM deanery.app_user u JOIN deanery.employee e USING(person_id) WHERE u.login='novikov'").fetchone()['employee_id']
            groups={r['group_id'] for r in self.db.execute('SELECT DISTINCT group_id FROM deanery.teaching_assignment WHERE teacher_id=%s',(tid,))}
            expulsion=self.db.execute('SELECT count(*) AS n FROM deanery.v_expulsion_risk').fetchone()['n']
            # Открытые долги прошлых семестров обучающихся студентов — строки v_debtors.
            open_debts=self.db.execute("""SELECT count(*) AS n FROM deanery.v_debtors d JOIN deanery.student s USING(student_id)
                JOIN deanery.study_group g ON g.group_id=s.group_id JOIN deanery.curriculum c ON c.curriculum_id=g.curriculum_id
                WHERE d.semester<deanery.fn_semester(c.start_year,CURRENT_DATE)""").fetchone()['n']
        retake=self.client.get('/api/v1/olap?mode=retake',headers=admin).json()['total']
        self.assertEqual(retake['expulsion_candidates'],expulsion)
        self.assertEqual(retake['open'],open_debts)
        for mode in ('session','heat','risk','retake','moves'):
            with self.subTest(mode=mode):
                response=self.client.get('/api/v1/olap?mode='+mode,headers=admin)
                self.assertEqual(response.status_code,200,response.text)
                self.assertEqual(response.json()['mode'],mode)
                self.assertEqual(self.client.get('/api/v1/olap?mode='+mode,headers=student).status_code,403)
        for query,key in (('mode=risk','rows'),('mode=risk','points'),('mode=retake&level=group','rows')):
            response=self.client.get('/api/v1/olap?'+query,headers=teacher)
            self.assertEqual(response.status_code,200,response.text)
            names={r['group_name'] if 'group_name' in r else r['name'] for r in response.json()[key]}
            with self.owner():
                allowed={r['name'] for r in self.db.execute('SELECT name FROM deanery.study_group WHERE group_id=ANY(%s)',(list(groups),))}
            self.assertLessEqual(names,allowed)
        for course in {r['course'] for r in self.client.get('/api/v1/olap?mode=session',headers=teacher).json()['rows']}:
            response=self.client.get(f'/api/v1/olap?mode=session&level=group&course={course}',headers=teacher)
            self.assertEqual(response.status_code,200,response.text)
            self.assertTrue(all(r['group_id'] in groups for r in response.json()['rows']))
        # Движение контингента одним запросом: столбцы и вся таблица приказов окна.
        query='/api/v1/olap?mode=moves&period=month&types=expel,leave,leave_return,reinstate,transfer&from=2000-01&to=2100-12&list=true'
        for headers in (admin,teacher):
            response=self.client.get(query,headers=headers)
            self.assertEqual(response.status_code,200,response.text)
            body=response.json()
            self.assertEqual(sum(sum(r['students_by_type'].values()) for r in body['rows']),len(body['orders']))
            self.assertTrue({o['order_type_code'] for o in body['orders']}<={'expel','leave','leave_return','reinstate','transfer'})
        with self.owner():
            allowed={r['name'] for r in self.db.execute('SELECT name FROM deanery.study_group WHERE group_id=ANY(%s)',(list(groups),))}
            pairs=self.db.execute("""SELECT count(*) AS n FROM deanery.order_student os JOIN deanery.academic_order o USING(order_id)
                JOIN deanery.order_type t USING(order_type_id) WHERE t.code IN ('expel','leave','leave_return','reinstate','transfer')""").fetchone()['n']
        self.assertTrue({o['group_name'] for o in body['orders']}<=allowed)
        self.assertEqual(len(self.client.get(query,headers=admin).json()['orders']),pairs)
        response=self.client.get('/api/v1/olap?mode=moves&types=expel,foo',headers=admin)
        self.assertEqual((response.status_code,response.json()['error']['details']),(422,{'field':'types'}))
        self.assertEqual(self.client.get(query,headers=student).status_code,403)
        response=self.client.get('/api/v1/olap?mode=session&level=result&group_id=1',headers=admin)
        self.assertEqual((response.status_code,response.json()['error']['details']),(422,{'field':'discipline_id'}))
        for query in ('mod_min=20','att_min=101','period=day','level=unknown','course=0'):
            response=self.client.get('/api/v1/olap?mode=risk&'+query,headers=admin)
            self.assertEqual(response.status_code,422,response.text)

