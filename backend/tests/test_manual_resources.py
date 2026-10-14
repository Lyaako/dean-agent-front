"""Revised resource rights, own academic data and native validation over HTTP."""
from contextlib import contextmanager
from uuid import uuid4
from datetime import timedelta

from backend.resources import REFERENCE_WRITES
from fastapi.encoders import jsonable_encoder

from backend.tests.test_auth import DatabaseHttpCase


class ManualResourceHelpers:
    def login(self, login):
        response = self.client.post('/api/v1/auth/login',headers=self.origin,
            json={'login':login,'password':'only-for-isolated-test'})
        self.assertEqual(response.status_code,200,response.text)
        return self.origin | {'Authorization':'Bearer '+response.json()['access_token']}

    @contextmanager
    def owner(self):
        self.db.execute('SET LOCAL ROLE NONE')
        self.db.execute('SET LOCAL search_path=pg_catalog,deanery')
        try:
            yield
        finally:
            self.db.execute('SET LOCAL ROLE backend_api')


class ManualResourceTests(ManualResourceHelpers,DatabaseHttpCase):

    def test_schema_employee_read_only_and_own_student_data(self):
        for login in ('vasilyeva','smirnov','kuznetsova','novikov','ivanov.ks'):
            with self.subTest(login=login):
                headers=self.login(login)
                schema=self.client.get('/api/v1/schema',headers=headers).json()['resources']
                self.assertEqual(schema['employee']['operations'],['read'])
                for method in (self.client.post,self.client.patch,self.client.delete):
                    response=method('/api/v1/resources/employee',headers=headers)
                    # An object body is required for post/patch; delete checks permission directly.
                    if method==self.client.delete:
                        self.assertEqual(response.status_code,403,response.text)
                self.assertEqual(self.client.post('/api/v1/resources/employee',json={},headers=headers).status_code,403)
                if login=='ivanov.ks':
                    me=self.client.get('/api/v1/auth/me',headers=headers).json()
                    for resource in ('v_last_result','v_debtors','grade','attendance','v_attendance','v_current_modules','v_active_scholarships','v_student_orders'):
                        response=self.client.get('/api/v1/resources/'+resource,headers=headers)
                        self.assertEqual(response.status_code,200,response.text)
                        self.assertTrue(all(row['student_id']==me['student_id'] for row in response.json()['items']))
                        response=self.client.get('/api/v1/resources/'+resource+'?student_id=999999',headers=headers)
                        self.assertEqual(response.status_code,200,response.text)
                        self.assertEqual(response.json()['items'],[])
                elif login=='vasilyeva':
                    accounts=self.client.get('/api/v1/resources/app_user',headers=headers)
                    self.assertEqual(accounts.status_code,200,accounts.text)
                    self.assertTrue(all(set(row)=={'user_id','login','person','role','is_active','last_login_at'} for row in accounts.json()['items']))

    def test_person_names_and_reference_date_key_under_native_role(self):
        headers=self.login('vasilyeva')
        me=self.client.get('/api/v1/auth/me',headers=headers).json()
        response=self.client.patch('/api/v1/resources/person?person_id='+str(me['person_id']),
            json={'middle_name':'Проверка'},headers=headers)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(set(response.json()),{'person_id','last_name','first_name','middle_name'})
        with self.owner():
            row=self.db.execute('SELECT * FROM deanery.holiday ORDER BY holiday_date LIMIT 1').fetchone()
        self.assertIsNotNone(row)
        response=self.client.patch('/api/v1/resources/holiday?holiday_date='+str(row['holiday_date']),
            json={'name':'Проверка праздника'},headers=headers)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['name'],'Проверка праздника')

    def test_teacher_grades_points_missing_and_closed_sheet(self):
        teacher=self.login('novikov'); admin=self.login('vasilyeva')
        teacher_id=self.client.get('/api/v1/auth/me',headers=teacher).json()['teacher_id']
        with self.owner():
            target=self.db.execute("""SELECT gs.*,s.student_id FROM deanery.grade_sheet gs
                JOIN deanery.grade gr USING(sheet_id) JOIN deanery.student s USING(student_id)
                JOIN deanery.student_status st USING(status_id)
                WHERE gs.status='closed' AND gs.examiner_id=%s AND st.is_active AND gs.group_id=s.group_id
                AND gr.points IS NULL AND NOT EXISTS(SELECT FROM deanery.grade g2
                    JOIN deanery.grade_sheet gs2 USING(sheet_id) WHERE g2.student_id=s.student_id
                        AND gs2.item_id=gs.item_id AND gs2.stage=gs.stage AND gs2.status<>'cancelled' AND g2.points IS NOT NULL)
                ORDER BY gs.sheet_id LIMIT 1""",(teacher_id,)).fetchone()
            foreign=self.db.execute("SELECT gr.grade_id FROM deanery.grade gr JOIN deanery.grade_sheet gs USING(sheet_id) WHERE gs.examiner_id<>%s LIMIT 1",(teacher_id,)).fetchone()
            closed=self.db.execute("SELECT gr.grade_id FROM deanery.grade gr JOIN deanery.grade_sheet gs USING(sheet_id) WHERE gs.examiner_id=%s AND gs.status='closed' LIMIT 1",(teacher_id,)).fetchone()
        self.assertIsNotNone(target)
        sheet=self.client.post('/api/v1/resources/grade_sheet',headers=admin,json={
            'sheet_number':'QA-'+uuid4().hex[:12],'item_id':target['item_id'],'group_id':target['group_id'],
            'examiner_id':teacher_id,'stage':target['stage'],'sheet_kind':'retake',
            'issue_date':__import__('datetime').date.today().isoformat()})
        self.assertEqual(sheet.status_code,200,sheet.text)
        target['sheet_id']=sheet.json()['sheet_id']
        self.assertEqual(self.client.patch('/api/v1/resources/grade?grade_id='+str(foreign['grade_id']),json={'points':30},headers=teacher).status_code,403)
        body={'sheet_id':target['sheet_id'],'student_id':target['student_id'],'points':20,'is_absent':False}
        invalid=self.client.post('/api/v1/resources/grade',json=body,headers=teacher)
        self.assertEqual(invalid.status_code,422,invalid.text)
        self.assertEqual(invalid.json()['error']['code'],'points_out_of_scale')
        created=self.client.post('/api/v1/resources/grade',json=body|{'points':None},headers=teacher)
        self.assertEqual(created.status_code,200,created.text)
        self.assertIsNone(created.json()['points'])
        missing=self.client.get(f"/api/v1/resources/grade_sheet/{target['sheet_id']}/missing",headers=admin)
        self.assertEqual(missing.status_code,200,missing.text)
        self.assertNotIn(target['student_id'],{r['student_id'] for r in missing.json()['items']})
        denied=self.client.patch('/api/v1/resources/grade?grade_id='+str(closed['grade_id']),json={'points':30},headers=teacher)
        self.assertEqual(denied.status_code,409,denied.text)
        self.assertEqual(denied.json()['error']['code'],'sheet_closed')

    def test_signers_scope_and_journal(self):
        admin=self.login('vasilyeva'); student=self.login('ivanov.ks'); staff=self.login('kuznetsova')
        institute=self.client.get('/api/v1/auth/me',headers=staff).json()['institute_ids'][0]
        response=self.client.get(f'/api/v1/orders/signers?institute_id={institute}',headers=staff)
        self.assertEqual(response.status_code,200,response.text)
        self.assertTrue(response.json()['items'][0]['is_director'])
        self.assertEqual(self.client.get(f'/api/v1/orders/signers?institute_id={institute}',headers=student).status_code,403)
        for headers in (admin,staff):
            response=self.client.get('/api/v1/resources/v_audit?limit=10',headers=headers)
            self.assertEqual(response.status_code,200,response.text)
            self.assertTrue(all(row['column_name'] not in ('password_hash','passport_number','birth_date') for row in response.json()['items']))

    def test_all_eleven_reference_forms_and_native_column_permissions(self):
        for login in ('vasilyeva','smirnov','kuznetsova'):
            headers=self.login(login)
            schema=self.client.get('/api/v1/schema',headers=headers).json()['resources']
            me=self.client.get('/api/v1/auth/me',headers=headers).json()
            with self.owner():
                role=self.db.execute('SELECT db_login FROM deanery.app_user WHERE user_id=%s',(me['user_id'],)).fetchone()['db_login']
            for name in sorted(REFERENCE_WRITES):
                with self.subTest(login=login,reference=name):
                    spec=schema[name]
                    with self.owner():
                        # Identifiers come from the fixed resource registry, never user input.
                        from psycopg import sql
                        row=self.db.execute(sql.SQL('SELECT * FROM deanery.{} LIMIT 1').format(sql.Identifier(name))).fetchone()
                        for field in spec['write_fields']:
                            permitted=self.db.execute('SELECT has_column_privilege(%s,%s,%s,%s) AS ok',
                                (role,'deanery.'+name,field,'INSERT')).fetchone()['ok']
                            self.assertTrue(permitted,(login,name,field))
                        if name=='academic_term':
                            end=self.db.execute('SELECT max(session_end) AS d FROM deanery.academic_term').fetchone()['d']
                        if name=='specialty':
                            code=self.db.execute("SELECT '99.99.'||lpad(n::TEXT,2,'0') AS code FROM generate_series(0,99) n WHERE NOT EXISTS(SELECT FROM deanery.specialty WHERE code='99.99.'||lpad(n::TEXT,2,'0')) LIMIT 1").fetchone()['code']
                        if name=='study_program':
                            row=self.db.execute('SELECT sp.* FROM deanery.study_program sp JOIN deanery.department d USING(department_id) WHERE d.institute_id=ANY(%s) LIMIT 1',(me['institute_ids'],)).fetchone()
                    body=jsonable_encoder({k:v for k,v in row.items() if k in spec['write_fields']})
                    marker='QA-'+uuid4().hex[:8]
                    if name=='academic_term':
                        body.update(name=marker,start_date=(end+timedelta(days=1)).isoformat(),end_date=(end+timedelta(days=10)).isoformat(),session_start=(end+timedelta(days=11)).isoformat(),session_end=(end+timedelta(days=12)).isoformat())
                    elif name=='holiday':
                        body.update(holiday_date='2199-12-'+str(10+('vasilyeva','smirnov','kuznetsova').index(login)),name=marker)
                    elif name=='classroom':
                        body.update(building=marker,room_number='QA')
                    elif name=='specialty':
                        body.update(code=code,name=marker)
                    elif name=='study_program':
                        body.update(profile=marker)
                    else:
                        body['name']=marker
                        if name=='order_type': body['code']=marker
                    response=self.client.post('/api/v1/resources/'+name,json=body,headers=headers)
                    self.assertEqual(response.status_code,200,response.text)
                    created=response.json()
                    key=spec['key'][0]
                    field='profile' if name=='study_program' else 'building' if name=='classroom' else 'name'
                    response=self.client.patch(f'/api/v1/resources/{name}?{key}={created[key]}',json={field:marker+'M'},headers=headers)
                    self.assertEqual(response.status_code,200,response.text)
                    self.assertEqual(response.json()[field],marker+'M')
                    if name=='academic_term':
                        conflict=self.client.post('/api/v1/resources/'+name,json=body|{'name':marker+'overlap'},headers=headers)
                        self.assertEqual(conflict.status_code,409,conflict.text)

    def test_large_result_view_is_paged_in_database(self):
        headers=self.login('vasilyeva')
        response=self.client.get('/api/v1/resources/v_last_result?limit=2',headers=headers)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(len(response.json()['items']),2)
        self.assertTrue(response.json()['has_more'])
        second=self.client.get('/api/v1/resources/v_last_result?limit=2&offset=2',headers=headers)
        self.assertEqual(second.status_code,200,second.text)
        self.assertNotEqual(response.json()['items'],second.json()['items'])
