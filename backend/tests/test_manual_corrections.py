"""A form correction is routed to a real institute manager and executed personally."""
from uuid import uuid4

from backend.tests.test_auth import DatabaseHttpCase
from backend.tests.test_manual_resources import ManualResourceHelpers


class ManualCorrectionTests(ManualResourceHelpers,DatabaseHttpCase):
    def post(self, path, body, headers, key=None):
        return self.client.post('/api/v1/'+path,json=body,
            headers=headers|{'Idempotency-Key':str(key or uuid4())})

    def test_form_correction_manager_decision_and_native_audit(self):
        teacher=self.login('novikov'); director=self.login('smirnov'); admin=self.login('vasilyeva')
        teacher_me=self.client.get('/api/v1/auth/me',headers=teacher).json()
        director_id=self.client.get('/api/v1/auth/me',headers=director).json()['user_id']
        with self.owner():
            target=self.db.execute("""SELECT gr.grade_id,gr.student_id,gr.points,gs.sheet_id
                FROM deanery.v_last_result lr JOIN deanery.grade_sheet gs USING(sheet_id)
                JOIN deanery.grade gr ON gr.sheet_id=gs.sheet_id AND gr.student_id=lr.student_id
                WHERE gs.status='closed' AND gs.examiner_id=%s AND deanery.fn_group_institute(gs.group_id)=1
                AND NOT EXISTS(SELECT FROM deanery.grade_correction gc WHERE gc.grade_id=gr.grade_id AND gc.status='pending')
                ORDER BY gs.sheet_id DESC LIMIT 1""",(teacher_me['teacher_id'],)).fetchone()
            foreign=self.db.execute("SELECT gs.sheet_id,gr.student_id FROM deanery.grade gr JOIN deanery.grade_sheet gs USING(sheet_id) WHERE gs.status='closed' AND gs.examiner_id<>%s LIMIT 1",(teacher_me['teacher_id'],)).fetchone()
        self.assertIsNotNone(target)
        body={'sheet_id':target['sheet_id'],'student_id':target['student_id'],
            'new_points':30 if target['points']!=30 else 31,'new_is_absent':False,'reason':'Основание '+('я'*1990)}
        self.assertEqual(len(body['reason']),2000)
        self.assertEqual(self.post('grade-corrections',body|{'reason':body['reason']+'я'},teacher).status_code,422)
        denied=self.post('grade-corrections',body|foreign,teacher)
        self.assertEqual(denied.status_code,403,denied.text)
        key=uuid4(); response=self.post('grade-corrections',body,teacher,key)
        self.assertEqual(response.status_code,200,response.text)
        proposal=response.json()
        self.assertEqual(proposal['kind'],'grade_correction')
        self.assertEqual(proposal['submission_status'],'submitted')
        self.assertFalse(proposal['actions']['can_approve'])
        self.assertEqual(self.post('grade-corrections',body,teacher,key).json()['id'],proposal['id'])
        path='agent/proposals/'+proposal['id']
        claim=self.post(path+'/assignment',{'assignee_user_id':director_id,'reason':'Принимаю на рассмотрение','expected_version':proposal['version']},director)
        self.assertEqual(claim.status_code,200,claim.text)
        self.assertTrue(claim.json()['actions']['can_approve'])
        decision=self.post(path+'/decision',{'approve':True,'reason':'Проверено руководителем института','expected_version':claim.json()['version']},director)
        self.assertEqual(decision.status_code,200,decision.text)
        with self.owner():
            row=self.db.execute('SELECT points FROM deanery.grade WHERE grade_id=%s',(target['grade_id'],)).fetchone()
            audit=self.db.execute("SELECT app_user_id FROM deanery.audit_log WHERE table_name='grade' AND record_key=%s ORDER BY audit_id DESC LIMIT 1",('grade_id='+str(target['grade_id']),)).fetchone()
        self.assertEqual(row['points'],body['new_points'])
        self.assertEqual(audit['app_user_id'],director_id)
        self.assertEqual(decision.json()['execution']['status'],'succeeded')
