"""New special-command lifecycles against the isolated PostgreSQL; each test rolls back."""
from datetime import timedelta
from uuid import uuid4
import psycopg
from psycopg.types.json import Jsonb
from backend.tests.test_auth import DatabaseHttpCase
from backend.tests.test_proposals import ProposalHelpers
from backend.tests import test_proposals as proposal_cases


class SpecialCommandTests(ProposalHelpers,DatabaseHttpCase):

    def setUp(self):
        super().setUp()
        self.db.execute("SET LOCAL search_path TO pg_catalog,deanery")
        self.db.execute("SET LOCAL TIME ZONE 'Europe/Moscow'")
        self.today = self.query('SELECT CURRENT_DATE AS day')[0]['day']
        self.admin = self.login('vasilyeva')

    def special(self, name, **fields):
        return {'version': 1, 'kind': 'special_command', 'name': name, 'fields': fields}

    def student(self):
        return self.query('''SELECT s.student_id,s.group_id,s.record_book_number,i.institute_id,i.director_id
            FROM deanery.student s JOIN deanery.student_status st USING(status_id)
            JOIN deanery.institute i ON i.institute_id=deanery.fn_group_institute(s.group_id)
            WHERE st.is_active AND NOT EXISTS(SELECT 1 FROM deanery.order_student os
                JOIN deanery.academic_order ao USING(order_id) JOIN deanery.order_type ot USING(order_type_id)
                WHERE os.student_id=s.student_id AND os.applied_at IS NULL AND ot.code IN ('enroll','transfer','expel','leave','leave_return','reinstate'))
            ORDER BY s.student_id LIMIT 1''')[0]

    def scholarship_command(self, days=3):
        student = self.student()
        kind = self.query('INSERT INTO deanery.scholarship_type(name,amount,budget_only) VALUES(%s,1000,FALSE) RETURNING scholarship_type_id',
            ('P09 ' + uuid4().hex,))[0]['scholarship_type_id']
        return self.special('scholarship_assign',student_id=student['student_id'],scholarship_type_id=kind,
            start_date=(self.today+timedelta(days=days)).isoformat(),end_date=(self.today+timedelta(days=days+30)).isoformat(),
            order_number='SC-'+uuid4().hex[:15],order_date=self.today.isoformat(),signed_by=student['director_id'],reason='Основание пользователя')

    def direct_scholarship(self, start_days=-5, end_days=30):
        c=self.scholarship_command(max(start_days,0));f=c['fields'];student=self.student()
        order=self.query('''INSERT INTO deanery.academic_order(order_number,order_date,order_type_id,institute_id,signed_by_id,title,effective_date)
            VALUES(%s,%s,(SELECT order_type_id FROM deanery.order_type WHERE code='scholarship'),%s,%s,'Fixture',%s) RETURNING order_id''',
            (f['order_number'],self.today+timedelta(days=min(start_days,0)),student['institute_id'],f['signed_by'],self.today+timedelta(days=start_days)))[0]['order_id']
        self.query('INSERT INTO deanery.order_student(order_id,student_id,reason) VALUES(%s,%s,%s) RETURNING order_id',
            (order,f['student_id'],f['reason']))
        row=self.query('''INSERT INTO deanery.scholarship(student_id,scholarship_type_id,order_id,start_date,end_date)
            VALUES(%s,%s,%s,%s,%s) RETURNING *''',(f['student_id'],f['scholarship_type_id'],order,
                self.today+timedelta(days=start_days),self.today+timedelta(days=end_days)))[0]
        return row

    def correction_command(self, author='novikov', ungraded=False):
        row=self.query('''SELECT g.*,gs.sheet_number,s.record_book_number FROM deanery.grade g
            JOIN deanery.grade_sheet gs USING(sheet_id) JOIN deanery.student s USING(student_id)
            JOIN deanery.employee e ON e.employee_id=gs.examiner_id JOIN deanery.app_user u ON u.person_id=e.person_id
            WHERE u.login=%s AND gs.status='closed' AND (%s=FALSE OR g.points IS NULL) AND NOT EXISTS(
                SELECT 1 FROM deanery.grade g2 JOIN deanery.grade_sheet gs2 USING(sheet_id)
                WHERE g2.student_id=g.student_id AND gs2.item_id=gs.item_id AND gs2.stage=gs.stage AND gs2.status<>'cancelled'
                  AND (COALESCE(gs2.exam_date,DATE 'infinity'),gs2.sheet_id)>(gs.exam_date,gs.sheet_id))
            ORDER BY g.grade_id LIMIT 1''',(author,ungraded))[0]
        points=self.query('SELECT max(max_points) AS points FROM deanery.score_band')[0]['points']
        if row['points']==points: points-=1
        return {'version':1,'kind':'grade_correction','fields':{'sheet_number':row['sheet_number'],
            'record_book':row['record_book_number'],'new_points':points,'new_is_absent':False,'reason':'Ошибка при переносе результата'}},row

    def claim(self,p,headers,name='smirnov'):
        return self.post(p,'assignment',{'assignee_user_id':self.user(name),'expected_version':p['version'],'reason':'Взято для решения руководителем'},headers)

    def submit(self,p,headers,key=None,status=200):
        return self.post(p,'submit',{'expected_version':p['version']},headers,key,status)

    def test_assignment_new_order_and_existing_order_commit_once_with_preview_audit(self):
        c=self.scholarship_command();f=c['fields'];before=self.query('SELECT count(*) AS n FROM deanery.scholarship')[0]['n']
        p=self.prepare(c,self.admin)
        self.assertEqual(self.query('SELECT count(*) AS n FROM deanery.scholarship')[0]['n'],before)
        self.assertEqual(self.query('SELECT order_id FROM deanery.academic_order WHERE order_number=%s',(f['order_number'],)),[])
        self.assertIsNone(p['preview']['after']['scholarship_id'])
        self.assertIn('academic_order',{e['table'] for e in p['preview']['effects']})
        done=self.decision(p,self.admin);row=done['execution']['applied']
        self.assertEqual(done['execution']['status'],'succeeded')
        self.assertEqual(self.decision(p,self.admin)['version'],done['version'])
        c2=self.special('scholarship_assign',student_id=f['student_id'],scholarship_type_id=f['scholarship_type_id'],
            order_id=row['order_id'],start_date=(self.today+timedelta(days=40)).isoformat(),
            end_date=(self.today+timedelta(days=60)).isoformat(),reason='Второй непересекающийся период')
        self.decision(self.prepare(c2,self.admin),self.admin)
        self.assertEqual(self.query('SELECT count(*) AS n FROM deanery.scholarship')[0]['n'],before+2)
        run=self.query('SELECT agent_request_id FROM agent_backend.proposal WHERE id=%s',(p['id'],))[0]['agent_request_id']
        audit=self.query("SELECT app_user_id,table_name FROM deanery.audit_log WHERE agent_request_id=%s",(run,))
        self.assertTrue(audit);self.assertTrue(all(r['app_user_id']==self.user_id for r in audit))
        with self.assertRaises(psycopg.errors.ExclusionViolation): self.prepare(c2,self.admin)

    def test_scholarship_termination_is_inclusive_retains_order_and_rejects_invalid_dates(self):
        r=self.direct_scholarship();before=self.query('SELECT count(*) AS n FROM deanery.academic_order')[0]['n']
        c=self.special('scholarship_terminate',scholarship_id=r['scholarship_id'],end_date=self.today.isoformat(),reason='Досрочное прекращение по заявлению')
        p=self.prepare(c,self.admin);self.assertEqual(p['preview']['after']['end_date'],self.today.isoformat())
        self.decision(p,self.admin)
        current=self.query('SELECT * FROM deanery.scholarship WHERE scholarship_id=%s',(r['scholarship_id'],))[0]
        self.assertEqual(current['end_date'],self.today);self.assertEqual(current['order_id'],r['order_id'])
        self.assertEqual(self.query('SELECT count(*) AS n FROM deanery.academic_order')[0]['n'],before)
        self.assertTrue(self.query('SELECT 1 FROM deanery.v_active_scholarships WHERE order_number=(SELECT order_number FROM deanery.academic_order WHERE order_id=%s)',(r['order_id'],)))
        c['fields']['end_date']=(self.today-timedelta(days=1)).isoformat()
        with self.assertRaises(psycopg.errors.InvalidParameterValue): self.prepare(c,self.admin)

    def test_future_cancellation_preserves_order_other_assignments_and_stale_protection(self):
        r=self.direct_scholarship(5,30);other=self.direct_scholarship(8,40)
        p=self.prepare(self.special('scholarship_cancel',scholarship_id=r['scholarship_id'],reason='Будущее назначение отменяется'),self.admin)
        self.assertEqual(p['preview']['operation'],'DELETE');self.decision(p,self.admin)
        self.assertEqual(self.query('SELECT 1 FROM deanery.scholarship WHERE scholarship_id=%s',(r['scholarship_id'],)),[])
        self.assertTrue(self.query('SELECT 1 FROM deanery.academic_order WHERE order_id=%s',(r['order_id'],)))
        self.assertTrue(self.query('SELECT 1 FROM deanery.scholarship WHERE scholarship_id=%s',(other['scholarship_id'],)))
        active=self.direct_scholarship(-5,35)
        with self.assertRaises(psycopg.errors.InvalidParameterValue):
            self.prepare(self.special('scholarship_cancel',scholarship_id=active['scholarship_id'],reason='Отмена уже действующего'),self.admin)
        p=self.prepare(self.special('scholarship_cancel',scholarship_id=other['scholarship_id'],reason='Отмена будущего'),self.admin)
        self.query('UPDATE deanery.scholarship SET end_date=end_date+1 WHERE scholarship_id=%s RETURNING scholarship_id',(other['scholarship_id'],))
        self.decision(p,self.admin,status=409)

    def test_scholarship_role_scope_and_input_guards(self):
        c=self.scholarship_command()
        for login in ('novikov','ivanov.ks'):
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): self.prepare(c,self.login(login))
        for field,value in [('student_id',True),('start_date','tomorrow'),('extra',1)]:
            invalid={**c,'fields':{**c['fields'],field:value}}
            with self.assertRaises(psycopg.Error): self.prepare(invalid,self.admin)
        staff=self.login('kuznetsova');inst=self.query("INSERT INTO deanery.institute(name,short_name) VALUES(%s,%s) RETURNING institute_id",('Foreign '+uuid4().hex,'F'+uuid4().hex[:8]))[0]['institute_id']
        self.query('''UPDATE deanery.dean_office_staff ds SET institute_id=%s FROM deanery.employee e JOIN deanery.app_user u USING(person_id)
            WHERE ds.employee_id=e.employee_id AND u.login='kuznetsova' RETURNING ds.employee_id''',(inst,))
        with self.assertRaises(psycopg.errors.InsufficientPrivilege): self.prepare(c,staff)

    def test_assignment_rejects_past_start_and_accepts_today(self):
        c = self.scholarship_command(-1)
        c['fields']['order_date'] = (self.today-timedelta(days=2)).isoformat()
        before = self.query('SELECT count(*) AS n FROM deanery.scholarship')[0]['n']
        with self.assertRaises(psycopg.errors.InvalidParameterValue):
            self.prepare(c, self.admin)
        self.assertEqual(self.query('SELECT order_id FROM deanery.academic_order WHERE order_number=%s',
                                   (c['fields']['order_number'],)), [])
        old = self.direct_scholarship(-30, -2)
        existing = self.special('scholarship_assign', student_id=c['fields']['student_id'],
            scholarship_type_id=c['fields']['scholarship_type_id'], order_id=old['order_id'],
            start_date=c['fields']['start_date'], end_date=c['fields']['end_date'], reason='Новое назначение')
        with self.assertRaises(psycopg.errors.InvalidParameterValue):
            self.prepare(existing, self.admin)
        _, _, request = self.create_run(self.admin)
        with self.assertRaises(psycopg.errors.InvalidParameterValue), self.db.transaction():
            self.query('SELECT backend_api.special_execute(%s,%s,%s,%s,%s)',
                       (Jsonb(existing), self.user_id, self.user_id, request, uuid4()))
        self.assertEqual(self.query('SELECT count(*) AS n FROM deanery.scholarship')[0]['n'], before+1)
        today = self.scholarship_command(0)
        result = self.decision(self.prepare(today, self.admin), self.admin)
        self.assertEqual(result['execution']['status'], 'succeeded')
        self.assertEqual(result['execution']['applied']['start_date'], self.today.isoformat())

    def test_correction_draft_submit_and_different_manager_decision_once(self):
        teacher=self.login('novikov');manager=self.login('smirnov');c,row=self.correction_command()
        count=self.query('SELECT count(*) AS n FROM deanery.grade_correction')[0]['n']
        p=self.prepare(c,teacher);self.assertEqual(p['submission_status'],'draft');self.assertTrue(p['actions']['can_submit'])
        self.assertEqual(self.query('SELECT count(*) AS n FROM deanery.grade_correction')[0]['n'],count)
        self.get(p,manager,status=404);self.submit(p,manager,status=404)
        self.assertNotIn(p['id'],[x['id'] for x in self.client.get('/api/v1/agent/proposals',headers=manager).json()['items']])
        key=uuid4();submitted=self.submit(p,teacher,key);self.assertEqual(self.submit(p,teacher,key)['correction_id'],submitted['correction_id'])
        self.assertEqual(self.query('SELECT points FROM deanery.grade WHERE grade_id=%s',(row['grade_id'],))[0]['points'],row['points'])
        self.assertEqual(self.query('SELECT count(*) AS n FROM deanery.grade_correction')[0]['n'],count+1)
        claimed=self.claim(submitted,manager);done=self.decision(claimed,manager)
        self.assertEqual(done['status'],'approved');self.assertEqual(done['execution']['status'],'succeeded')
        self.assertEqual(self.query('SELECT points FROM deanery.grade WHERE grade_id=%s',(row['grade_id'],))[0]['points'],c['fields']['new_points'])
        self.assertEqual(self.decision(claimed,manager)['version'],done['version'])
        source=self.query('SELECT requested_by_id,decided_by_id,status FROM deanery.grade_correction WHERE correction_id=%s',(submitted['correction_id'],))[0]
        self.assertEqual(source,{'requested_by_id':self.user('novikov'),'decided_by_id':self.user('smirnov'),'status':'applied'})

    def test_correction_admin_alone_and_ordinary_staff_cannot_decide(self):
        teacher=self.login('novikov');manager=self.login('smirnov');staff=self.login('kuznetsova');c,_=self.correction_command()
        p=self.submit(self.prepare(c,teacher),teacher)
        self.query("UPDATE deanery.employee SET position_id=(SELECT position_id FROM deanery.position WHERE category='support' LIMIT 1) WHERE person_id=(SELECT person_id FROM deanery.app_user WHERE login='kuznetsova') RETURNING employee_id")
        for headers in (self.admin,staff,teacher):
            self.assertFalse(self.get(p,headers,status=200 if headers==teacher else 404).get('actions',{}).get('can_approve',False))
        claimed=self.claim(p,manager);self.assertEqual(self.decision(claimed,manager,approve=False)['status'],'rejected')
        source=self.query('SELECT status FROM deanery.grade_correction WHERE correction_id=%s',(p['correction_id'],))[0]['status']
        self.assertEqual(source,'rejected')

    def test_correction_stale_draft_and_expired_draft_cannot_submit(self):
        teacher=self.login('novikov');c,row=self.correction_command();p=self.prepare(c,teacher)
        # A changed prerequisite is enough to invalidate the immutable draft without touching the protected grade.
        self.query("UPDATE deanery.person SET middle_name=COALESCE(middle_name,'') || 'X' WHERE person_id=(SELECT person_id FROM deanery.student WHERE student_id=%s) RETURNING person_id",(row['student_id'],))
        self.submit(p,teacher,status=409)
        expired=self.query('''INSERT INTO agent_backend.proposal(initiator_user_id,kind,command,preview,snapshot,snapshot_hash,
            explanation,reason,expires_at,institute_id,submission_status)
            SELECT initiator_user_id,kind,command,preview,snapshot,snapshot_hash,explanation,reason,now()-interval '1 day',institute_id,'draft'
            FROM agent_backend.proposal WHERE id=%s RETURNING id''',(p['id'],))[0]
        self.submit(self.get({'id':str(expired['id'])},teacher),teacher,status=409)

    def test_submitted_correction_does_not_expire_and_manager_cannot_self_decide(self):
        teacher=self.login('novikov');manager=self.login('smirnov');c,_=self.correction_command();draft=self.prepare(c,teacher)
        run=self.query('SELECT agent_request_id FROM agent_backend.proposal WHERE id=%s',(draft['id'],))[0]['agent_request_id']
        corr=self.query('SELECT backend_api.request_correction_as(%s,%s,%s) AS id',(Jsonb(c),self.user('novikov'),run))[0]['id']
        fixture=self.query('''INSERT INTO agent_backend.proposal(initiator_user_id,kind,command,preview,snapshot,snapshot_hash,
            explanation,reason,expires_at,institute_id,submission_status,correction_id,agent_request_id)
            SELECT initiator_user_id,kind,command,preview,snapshot,snapshot_hash,explanation,reason,now()-interval '2 days',institute_id,'submitted',%s,agent_request_id
            FROM agent_backend.proposal WHERE id=%s RETURNING id''',(corr,draft['id']))[0]
        p=self.get({'id':str(fixture['id'])},manager);self.assertEqual(p['validity']['state'],'current')
        self.assertEqual(self.decision(self.claim(p,manager),manager)['status'],'approved')
        c,_=self.correction_command()
        own=self.submit(self.prepare(c,manager),manager)
        self.assertFalse(own['actions']['can_claim']);self.assertFalse(own['actions']['can_approve'])
        self.decision(own,manager,status=403)

    def test_cancel_scheduled_order_has_one_attributed_parent_event_and_retained_job_history(self):
        student=self.student();number='CX-'+uuid4().hex[:16];due=(self.today+timedelta(days=7)).isoformat()
        workflow={'version':1,'kind':'workflow','name':'expel_student','fields':{'student_id':student['student_id'],
            'order_number':number,'signed_by':student['director_id'],'reason':'Проверочная причина отчисления','effective_date':due}}
        parent=self.decision(self.prepare(workflow,self.admin),self.admin);self.assertEqual(parent['execution']['status'],'scheduled')
        c=self.special('scheduled_order_cancel',student_id=student['student_id'],order_number=number,reason='Отмена будущего отчисления')
        p=self.prepare(c,self.admin);effects={e['table'] for e in p['preview']['effects']}
        self.assertTrue({'order_student','academic_order','job','proposal'}<=effects)
        self.assertEqual(self.get(parent,self.admin)['execution']['status'],'scheduled')
        self.decision(p,self.admin);result=self.get(parent,self.admin)
        self.assertEqual(result['execution']['status'],'cancelled');self.assertEqual(result['execution']['cancellation_proposal_id'],p['id'])
        events=self.query("SELECT actor_user_id,reason,data FROM agent_backend.proposal_event WHERE proposal_id=%s AND data->>'status'='cancelled'",(parent['id'],))
        self.assertEqual(len(events),1);self.assertEqual(events[0]['actor_user_id'],self.user_id)
        self.assertEqual(events[0]['reason'],c['fields']['reason']);self.assertEqual(events[0]['data']['cancellation_proposal_id'],p['id'])
        status=self.client.get('/api/v1/jobs/'+parent['execution']['job_id'],headers=self.admin)
        self.assertEqual(status.status_code,200,status.text);self.assertEqual(status.json()['status'],'cancelled')
        self.assertEqual(status.json()['result']['effective_date'],due)
        worker=self.query('SELECT backend_api.perform_order_job(%s,%s) AS result',(parent['execution']['job_id'],uuid4()))[0]['result']
        self.assertEqual(worker['status'],'cancelled')
        self.assertEqual(self.query('SELECT 1 FROM deanery.order_student WHERE order_id=%s',(parent['execution']['order_id'],)),[])

    def test_cancel_leave_discloses_related_deletion_and_enrollment_is_forbidden(self):
        student=self.student();reason=self.query('SELECT name FROM deanery.leave_reason LIMIT 1')[0]['name'];number='LV-'+uuid4().hex[:16]
        workflow={'version':1,'kind':'workflow','name':'grant_academic_leave','fields':{'student_id':student['student_id'],
            'order_number':number,'signed_by':student['director_id'],'reason':reason,'start':(self.today+timedelta(days=10)).isoformat(),
            'end':(self.today+timedelta(days=100)).isoformat()}}
        parent=self.decision(self.prepare(workflow,self.admin),self.admin)
        p=self.prepare(self.special('scheduled_order_cancel',student_id=student['student_id'],order_number=number,reason='Отмена будущего отпуска'),self.admin)
        self.assertTrue(any(e['table']=='academic_leave' and e['operation']=='DELETE' for e in p['preview']['effects']))
        self.decision(p,self.admin)
        self.assertEqual(self.query('SELECT 1 FROM deanery.academic_leave WHERE order_id=%s',(parent['execution']['order_id'],)),[])
        enrollment=proposal_cases.ProposalTests.enrollment(self)
        enrolled=self.decision(self.prepare(enrollment,self.admin),self.admin)
        with self.assertRaises(psycopg.errors.InvalidParameterValue):
            self.prepare(self.special('scheduled_order_cancel',student_id=enrolled['execution']['student_id'],
                order_number=enrollment['fields']['order_number'],reason='Недопустимая отмена зачисления'),self.admin)

    def test_submitted_correction_later_attempt_stays_queued_for_rejection(self):
        teacher=self.login('novikov');manager=self.login('smirnov');c,row=self.correction_command(ungraded=True)
        p=self.submit(self.prepare(c,teacher),teacher)
        # The source permits only one pending correction per grade; a new attempt makes that request stale.
        with self.assertRaises(psycopg.errors.UniqueViolation): self.prepare(c,teacher)
        later=self.query("""INSERT INTO deanery.grade_sheet(sheet_number,item_id,group_id,examiner_id,stage,sheet_kind,issue_date,exam_date,status)
            SELECT %s,item_id,group_id,examiner_id,stage,'retake',issue_date,exam_date+1,'open'
            FROM deanery.grade_sheet WHERE sheet_id=%s RETURNING sheet_id""",('P09-'+uuid4().hex[:12],row['sheet_id']))[0]['sheet_id']
        self.query('INSERT INTO deanery.grade(sheet_id,student_id,points,is_absent) VALUES(%s,%s,NULL,FALSE) RETURNING grade_id',(later,row['student_id']))
        claimed=self.claim(p,manager);self.assertEqual(claimed['validity']['state'],'stale')
        incoming=self.client.get('/api/v1/agent/proposals?box=incoming',headers=manager).json()['items']
        completed=self.client.get('/api/v1/agent/proposals?box=completed',headers=manager).json()['items']
        self.assertIn(p['id'],[item['id'] for item in incoming]);self.assertNotIn(p['id'],[item['id'] for item in completed])
        self.assertFalse(claimed['actions']['can_approve']);self.assertTrue(claimed['actions']['can_reject'])
        self.decision(claimed,manager,status=409)
        self.assertEqual(self.query('SELECT points FROM deanery.grade WHERE grade_id=%s',(row['grade_id'],))[0]['points'],row['points'])
        self.assertEqual(self.decision(claimed,manager,approve=False)['status'],'rejected')

    def test_actual_dean_staff_deputy_can_decide_correction(self):
        teacher=self.login('novikov');deputy=self.login('kuznetsova');c,_=self.correction_command()
        p=self.submit(self.prepare(c,teacher),teacher)
        claimed=self.claim(p,deputy,'kuznetsova');self.assertTrue(claimed['actions']['can_approve'])
        self.assertEqual(self.decision(claimed,deputy)['status'],'approved')

    def test_source_order_cancel_preserves_other_student_and_due_but_unapplied_is_allowed(self):
        student=self.student();other=self.query('''SELECT s.student_id FROM deanery.student s JOIN deanery.student_status st USING(status_id)
            WHERE st.is_active AND s.student_id<>%s AND deanery.fn_group_institute(s.group_id)=%s
              AND NOT EXISTS(SELECT 1 FROM deanery.order_student os JOIN deanery.academic_order ao USING(order_id)
                  JOIN deanery.order_type ot USING(order_type_id) WHERE os.student_id=s.student_id AND os.applied_at IS NULL
                  AND ot.code IN ('enroll','transfer','expel','leave','leave_return','reinstate')) ORDER BY s.student_id LIMIT 1''',
            (student['student_id'],student['institute_id']))[0]['student_id']
        number='SRC-'+uuid4().hex[:15]
        order=self.query('''INSERT INTO deanery.academic_order(order_number,order_date,order_type_id,institute_id,signed_by_id,title,effective_date)
            VALUES(%s,CURRENT_DATE,(SELECT order_type_id FROM deanery.order_type WHERE code='expel'),%s,%s,'Source fixture',CURRENT_DATE) RETURNING order_id''',
            (number,student['institute_id'],student['director_id']))[0]['order_id']
        for who in (student['student_id'],other):
            self.query("INSERT INTO deanery.order_student(order_id,student_id,reason) VALUES(%s,%s,'Source reason') RETURNING student_id",(order,who))
        p=self.prepare(self.special('scheduled_order_cancel',student_id=student['student_id'],order_number=number,reason='Отмена выбранного студента'),self.admin)
        self.assertFalse(any(e['table']=='academic_order' and e['operation']=='DELETE' for e in p['preview']['effects']))
        self.decision(p,self.admin)
        self.assertEqual(self.query('SELECT student_id FROM deanery.order_student WHERE order_id=%s',(order,)),[{'student_id':other}])
        job=self.query("SELECT id FROM agent_backend.job WHERE kind='apply_order' AND payload->>'order_id'=%s AND payload->>'student_id'=%s",(str(order),str(student['student_id'])))[0]['id']
        response=self.client.get('/api/v1/jobs/'+str(job),headers=self.admin)
        self.assertEqual(response.status_code,200,response.text);self.assertEqual(response.json()['result']['effective_date'],self.today.isoformat())

    def test_cancelling_scheduled_return_keeps_leave_and_restores_return_reference(self):
        student=self.student();reason=self.query('SELECT name FROM deanery.leave_reason LIMIT 1')[0]['name']
        leave={'version':1,'kind':'workflow','name':'grant_academic_leave','fields':{'student_id':student['student_id'],
            'order_number':'AL-'+uuid4().hex[:15],'signed_by':student['director_id'],'reason':reason,
            'start':self.today.isoformat(),'end':(self.today+timedelta(days=90)).isoformat()}}
        granted=self.decision(self.prepare(leave,self.admin),self.admin)
        number='RT-'+uuid4().hex[:15]
        returning={'version':1,'kind':'workflow','name':'return_from_leave','fields':{'student_id':student['student_id'],
            'order_number':number,'signed_by':student['director_id'],'effective_date':(self.today+timedelta(days=7)).isoformat()}}
        parent=self.decision(self.prepare(returning,self.admin),self.admin)
        p=self.prepare(self.special('scheduled_order_cancel',student_id=student['student_id'],order_number=number,reason='Выход из отпуска отменяется'),self.admin)
        self.assertTrue(any(e['table']=='academic_leave' and e['changes'].get('return_order_id',{}).get('after') is None for e in p['preview']['effects']))
        self.decision(p,self.admin)
        row=self.query('SELECT return_order_id,end_date FROM deanery.academic_leave WHERE order_id=%s',(granted['execution']['order_id'],))[0]
        self.assertIsNone(row['return_order_id']);self.assertEqual(row['end_date'],self.today+timedelta(days=90))
        self.assertEqual(self.get(parent,self.admin)['execution']['status'],'cancelled')
