"""New analyses checked against native final results and teacher group scope."""
from backend.olap import analysis_from_data
from backend.tests.test_auth import DatabaseHttpCase
from backend.tests.test_manual_resources import ManualResourceHelpers


class AnalyticsHttpTests(ManualResourceHelpers,DatabaseHttpCase):
    def test_analyses_and_native_session_totals(self):
        admin=self.login('vasilyeva'); teacher=self.login('novikov'); student=self.login('ivanov.ks')
        response=self.client.get('/api/v1/olap?mode=session',headers=admin)
        self.assertEqual(response.status_code,200,response.text)
        with self.owner():
            expected=self.db.execute("SELECT count(*) AS n FROM deanery.v_last_result WHERE stage='final'").fetchone()['n']
            tid=self.db.execute("SELECT e.employee_id FROM deanery.app_user u JOIN deanery.employee e USING(person_id) WHERE u.login='novikov'").fetchone()['employee_id']
            groups={r['group_id'] for r in self.db.execute('SELECT DISTINCT group_id FROM deanery.teaching_assignment WHERE teacher_id=%s',(tid,))}
        self.assertEqual(response.json()['total']['results'],expected)
        self.assertEqual(sum(r['results'] for r in response.json()['rows']),expected)
        for mode in ('session','heat','risk','retake','moves'):
            with self.subTest(mode=mode):
                response=self.client.get('/api/v1/olap?mode='+mode,headers=admin)
                self.assertEqual(response.status_code,200,response.text)
                self.assertEqual(response.json()['mode'],mode)
                self.assertEqual(self.client.get('/api/v1/olap?mode='+mode,headers=student).status_code,403)
        response=self.client.get('/api/v1/olap?mode=session&level=group',headers=teacher)
        self.assertEqual(response.status_code,200,response.text)
        self.assertTrue(all(r['group_id'] in groups for r in response.json()['rows']))
        for query in ('mod_min=20','att_min=101','period=day','level=unknown','course=0'):
            response=self.client.get('/api/v1/olap?mode=risk&'+query,headers=admin)
            self.assertEqual(response.status_code,422,response.text)


def test_risk_null_is_always_risk_and_missing_attendance_is_not_fabricated():
    student={'student_id':1,'group_id':1,'group_name':'Группа','course':1,'status_id':1,'student':'Студент'}
    data={name:[] for name in ('students','results','attempts','modules','attendance','debts','orders')}
    data['students']=[student]
    data['modules']=[{'student_id':1,'discipline_id':1,'semester':1,'points':None,'is_absent':False}]
    response=analysis_from_data(data,'risk')
    assert response['rows'][0]['reasons']==['not_attested']
    assert response['rows'][0]['attendance_pct'] is None


def test_risk_includes_either_low_indicator_and_excludes_both_normal():
    data={name:[] for name in ('students','results','attempts','modules','attendance','debts','orders')}
    for sid,points,present in ((1,29,True),(2,54,False),(3,54,True)):
        data['students'].append({'student_id':sid,'group_id':1,'group_name':'Группа','course':1,'status_id':1,'student':str(sid)})
        data['modules'].append({'student_id':sid,'discipline_id':1,'semester':1,'points':points,'is_absent':False})
        data['attendance'].append({'student_id':sid,'discipline_id':1,'semester':1,'is_present':present})
    result=analysis_from_data(data,'risk')
    assert [(r['student_id'],r['reasons']) for r in result['rows']]==[
        (1,['module_below_threshold']),(2,['attendance_below_threshold'])]
