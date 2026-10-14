"""Atomic selected batches and guarded reversal use actual native privileges."""
from uuid import uuid4
from datetime import date
import psycopg
from backend.tests.test_auth import DatabaseHttpCase
from backend.tests.test_proposals import ProposalHelpers


class BatchTests(ProposalHelpers,DatabaseHttpCase):
    def batch(self,headers,count):
        students=self.query('SELECT student_id,needs_dormitory FROM deanery.student ORDER BY student_id LIMIT %s',(count,))
        command={'version':1,'kind':'batch','items':[{'item_id':index,'command':self.record('student','update',
            {'student_id':s['student_id']},{'needs_dormitory':not s['needs_dormitory']})} for index,s in enumerate(students,1)]}
        return self.prepare(command,headers),students

    def approve(self,p,headers,picked,key=None,status=200):
        return self.post(p,'decision',{'approve':True,'reason':'Проверено, применяем выбранные строки',
            'expected_version':p['version'],'picked_item_ids':picked},headers,key,status)

    def test_150_rows_atomic_application_and_inverse_one_time(self):
        headers=self.login('vasilyeva')
        p,students=self.batch(headers,150)
        self.assertEqual(p['kind'],'batch')
        self.assertEqual(len(p['items']),150)
        self.assertTrue(all(r['state']=='ok' for r in p['items']))
        key=uuid4(); applied=self.approve(p,headers,list(range(1,151)),key)
        self.assertEqual(applied['execution']['status'],'succeeded')
        self.assertTrue(applied['actions']['can_undo'])
        self.assertTrue(all(r['state']=='already_done' for r in applied['items']))
        self.assertEqual(self.approve(p,headers,list(range(1,151)),key)['version'],applied['version'])
        actual=self.query('SELECT student_id,needs_dormitory FROM deanery.student ORDER BY student_id LIMIT 150')
        self.assertEqual(actual,[s|{'needs_dormitory':not s['needs_dormitory']} for s in students])
        undo_key=uuid4(); inverse=self.post(applied,'undo',{},headers,undo_key)
        self.assertEqual(inverse['execution']['undo_of'],p['id'])
        self.assertEqual(self.query('SELECT student_id,needs_dormitory FROM deanery.student ORDER BY student_id LIMIT 150'),students)
        self.assertEqual(self.post(applied,'undo',{},headers,undo_key)['id'],inverse['id'])
        self.post(applied,'undo',{},headers,status=409)

    def test_stale_selected_row_rolls_back_all_then_can_exclude_it(self):
        headers=self.login('vasilyeva'); p,students=self.batch(headers,2)
        student=students[1]
        response=self.client.patch('/api/v1/resources/student?student_id='+str(student['student_id']),
            json={'is_foreign':True},headers=headers)
        self.assertEqual(response.status_code,200,response.text)
        viewed=self.get(p,headers)
        self.assertEqual(viewed['items'][1]['state'],'conflict')
        response=self.approve(p,headers,[1,2],status=409)
        self.assertEqual(response['error']['code'],'stale_item')
        self.assertEqual(response['error']['details']['item_id'],2)
        self.assertEqual(self.query('SELECT needs_dormitory FROM deanery.student WHERE student_id=%s',(students[0]['student_id'],))[0]['needs_dormitory'],students[0]['needs_dormitory'])
        applied=self.approve(p,headers,[1])
        self.assertEqual(applied['execution']['picked_item_ids'],[1])

    def test_undo_refuses_any_later_change_including_change_back(self):
        headers=self.login('vasilyeva'); p,students=self.batch(headers,1)
        applied=self.approve(p,headers,[1]); student=students[0]
        url='/api/v1/resources/student?student_id='+str(student['student_id'])
        self.assertEqual(self.client.patch(url,json={'needs_dormitory':student['needs_dormitory']},headers=headers).status_code,200)
        self.assertEqual(self.client.patch(url,json={'needs_dormitory':not student['needs_dormitory']},headers=headers).status_code,200)
        response=self.post(applied,'undo',{},headers,status=409)
        self.assertEqual(response['error']['code'],'undo_changed')

    def test_batch_limit_and_forbidden_command_types(self):
        headers=self.login('vasilyeva'); run=self.create_run(headers)[0]
        command={'version':1,'kind':'batch','items':[{'item_id':n,'command':self.record('student','update',{'student_id':1},{'needs_dormitory':True})} for n in range(1,202)]}
        with self.assertRaises(psycopg.Error) as raised:
            self.prepare(command,headers,run)
        self.assertEqual(raised.exception.sqlstate,'P6201')
        for kind in ('workflow','grade_correction'):
            with self.assertRaises(psycopg.Error):
                self.prepare({'version':1,'kind':'batch','items':[{'item_id':1,'command':{'version':1,'kind':kind,'fields':{}}}]},headers,run)

    def test_teacher_confirms_own_grade_and_closing_sheet_disables_undo(self):
        teacher=self.login('novikov'); admin=self.login('vasilyeva')
        tid=self.client.get('/api/v1/auth/me',headers=teacher).json()['teacher_id']
        target=self.query("""SELECT gs.item_id,gs.group_id,gs.stage,gr.student_id FROM deanery.grade_sheet gs
            JOIN deanery.grade gr USING(sheet_id) JOIN deanery.student s USING(student_id)
            JOIN deanery.student_status st USING(status_id) WHERE gs.examiner_id=%s AND gs.status='closed'
                AND st.is_active AND s.group_id=gs.group_id AND gr.points IS NULL
                AND NOT EXISTS(SELECT FROM deanery.grade g2 JOIN deanery.grade_sheet gs2 USING(sheet_id)
                    WHERE g2.student_id=s.student_id AND gs2.item_id=gs.item_id AND gs2.stage=gs.stage
                        AND gs2.status<>'cancelled' AND g2.points IS NOT NULL) LIMIT 1""",(tid,))[0]
        sheet=self.client.post('/api/v1/resources/grade_sheet',headers=admin,json={
            'sheet_number':'QA-'+uuid4().hex[:12],'item_id':target['item_id'],'group_id':target['group_id'],
            'stage':target['stage'],'examiner_id':tid,'sheet_kind':'retake','issue_date':date.today().isoformat()})
        self.assertEqual(sheet.status_code,200,sheet.text)
        sid=sheet.json()['sheet_id']
        grade=self.client.post('/api/v1/resources/grade',headers=teacher,json={
            'sheet_id':sid,'student_id':target['student_id'],'points':30,'is_absent':False})
        self.assertEqual(grade.status_code,200,grade.text)
        p=self.prepare(self.record('grade','update',{'grade_id':grade.json()['grade_id']},{'points':31}),teacher)
        self.assertEqual(p['routing']['assignee_user_id'],self.user('novikov'))
        self.assertTrue(p['actions']['can_approve'])
        decision_key=uuid4()
        applied=self.decision(p,teacher,key=decision_key)
        self.assertTrue(applied['actions']['can_undo'])
        close=self.client.patch('/api/v1/resources/grade_sheet?sheet_id='+str(sid),headers=admin,
            json={'status':'closed','exam_date':date.today().isoformat(),'closed_date':date.today().isoformat()})
        self.assertEqual(close.status_code,200,close.text)
        self.assertFalse(self.get(applied,teacher)['actions']['can_undo'])
        self.assertEqual(self.decision(p,teacher,key=decision_key)['id'],applied['id'])
        response=self.post(applied,'undo',{},teacher,status=409)
        self.assertEqual(response['error']['code'],'undo_unavailable')

    def test_staff_undo_of_teacher_topic_creates_own_inverse_request(self):
        teacher=self.login('novikov'); admin=self.login('vasilyeva')
        target=self.query("""SELECT w.work_id,w.topic FROM deanery.academic_work w JOIN deanery.teacher t ON t.employee_id=w.supervisor_id
            JOIN deanery.app_user u ON u.person_id=(SELECT person_id FROM deanery.employee WHERE employee_id=t.employee_id)
            WHERE u.login='novikov' LIMIT 1""")[0]
        p=self.prepare(self.record('academic_work','update',{'work_id':target['work_id']},{'topic':target['topic']+' QA'}),teacher)
        claimed=self.post(p,'assignment',{'assignee_user_id':self.user_id,'reason':'Принимаю предложение в работу','expected_version':p['version']},admin)
        applied=self.decision(claimed,admin)
        self.post(applied,'undo',{},admin)
        self.assertEqual(self.query('SELECT topic FROM deanery.academic_work WHERE work_id=%s',(target['work_id'],))[0]['topic'],target['topic'])

    def test_undo_expiration_and_another_decider_are_denied(self):
        admin=self.login('vasilyeva'); director=self.login('smirnov')
        p,students=self.batch(admin,1)
        applied=self.approve(p,admin,[1])
        self.post(applied,'undo',{},director,status=403)
        self.query("UPDATE agent_backend.proposal SET decided_at=now()-INTERVAL '16 minutes' WHERE id=%s RETURNING id",(p['id'],))
        self.assertFalse(self.get(applied,admin)['actions']['can_undo'])
        response=self.post(applied,'undo',{},admin,status=409)
        self.assertEqual(response['error']['code'],'undo_unavailable')
