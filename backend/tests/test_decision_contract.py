"""Р1, Р3, Р4, Р6, Р8 and Р9 against the isolated PostgreSQL with native privileges."""
from uuid import uuid4
from datetime import date, timedelta

from backend.tests.test_auth import DatabaseHttpCase
from backend.tests.test_proposals import ProposalHelpers


class DecisionContractTests(ProposalHelpers,DatabaseHttpCase):
    def correction(self):
        teacher=self.login('novikov'); director=self.login('smirnov')
        tid=self.client.get('/api/v1/auth/me',headers=teacher).json()['teacher_id']
        target=self.query("""SELECT gr.student_id,gr.points,gs.sheet_id
            FROM deanery.v_last_result lr JOIN deanery.grade_sheet gs USING(sheet_id)
            JOIN deanery.grade gr ON gr.sheet_id=gs.sheet_id AND gr.student_id=lr.student_id
            WHERE gs.status='closed' AND gs.examiner_id=%s AND deanery.fn_group_institute(gs.group_id)=1
            AND NOT EXISTS(SELECT FROM deanery.grade_correction gc WHERE gc.grade_id=gr.grade_id AND gc.status IN ('pending','approved'))
            ORDER BY gs.sheet_id DESC LIMIT 1""",(tid,))[0]
        response=self.client.post('/api/v1/grade-corrections',headers=teacher|{'Idempotency-Key':str(uuid4())},json={
            'sheet_id':target['sheet_id'],'student_id':target['student_id'],'new_points':30 if target['points']!=30 else 31,
            'new_is_absent':False,'reason':'Ошибка при переносе баллов из листа'})
        self.assertEqual(response.status_code,200,response.text)
        p=response.json(); self.target=target
        claimed=self.post(p,'assignment',{'assignee_user_id':self.user('smirnov'),'reason':'Принимаю на рассмотрение',
            'expected_version':p['version']},director)
        return teacher,director,claimed

    def batch(self,headers,items):
        command={'version':1,'kind':'batch','items':[{'item_id':n,'command':c} for n,c in enumerate(items,1)]}
        return self.prepare(command,headers)

    def students(self,count):
        return self.query('SELECT student_id,needs_dormitory,is_foreign FROM deanery.student ORDER BY student_id LIMIT %s',(count,))

    def dormitory(self,s):
        return self.record('student','update',{'student_id':s['student_id']},{'needs_dormitory':not s['needs_dormitory']})

    def approve(self,p,headers,picked):
        return self.post(p,'decision',{'approve':True,'reason':'Проверено, применяем выбранные строки',
            'expected_version':p['version'],'picked_item_ids':picked},headers)

    # Р1
    def test_correction_comment_is_limited_to_the_column_size(self):
        teacher,director,p=self.correction()
        body={'approve':True,'reason':'я'*501,'expected_version':p['version']}
        error=self.post(p,'decision',body,director,status=422)['error']
        self.assertEqual((error['code'],error['details']),('validation_error',{'field':'reason','max':500}))
        self.post(p,'decision',{'approve':False,'expected_version':p['version']},director,status=422)
        decided=self.post(p,'decision',body|{'reason':'я'*500},director)
        self.assertEqual(decided['status'],'approved')
        self.assertEqual(self.query('SELECT length(decision_comment) AS n FROM deanery.grade_correction WHERE correction_id=%s',
            (decided['correction_id'],))[0]['n'],500)

    def test_other_decisions_keep_2000_characters(self):
        headers=self.login('vasilyeva'); p=self.prepare(self.group_command(),headers)
        result=self.post(p,'decision',{'approve':False,'reason':'я'*2000,'expected_version':p['version']},headers)
        self.assertEqual(result['status'],'rejected')

    # Р3
    def test_transfer_reason_is_10_to_2000_characters_after_trimming(self):
        student,staff=self.login('ivanov.ks'),self.login('kuznetsova')
        doc_type=self.query('SELECT document_type_id FROM deanery.document_type ORDER BY document_type_id LIMIT 1')[0]['document_type_id']
        p=self.prepare(self.record('document_request','create',{},{'document_type_id':doc_type,'copies':1,'purpose':'Для проверки'}),student)
        body={'assignee_user_id':self.user('kuznetsova'),'expected_version':p['version']}
        for reason in ('я'*9,'   '+'я'*9+'   ','я'*2001):
            error=self.post(p,'assignment',body|{'reason':reason},staff,status=422)['error']
            self.assertEqual((error['code'],error['details']),('validation_error',{'field':'reason'}))
        claimed=self.post(p,'assignment',body|{'reason':'я'*10},staff)
        self.post(claimed,'assignment',body|{'reason':'я'*2000,'expected_version':claimed['version']},staff)

    # Р4
    def test_request_text_and_redo_belong_to_the_author_of_an_agent_proposal(self):
        student,staff=self.login('ivanov.ks'),self.login('kuznetsova')
        doc_type=self.query('SELECT document_type_id FROM deanery.document_type ORDER BY document_type_id LIMIT 1')[0]['document_type_id']
        run,session,_=self.create_run(student)
        p=self.prepare(self.record('document_request','create',{},{'document_type_id':doc_type,'copies':1,'purpose':'Для проверки'}),student,run)
        own=self.get(p,student)
        self.assertEqual((own['request_text'],own['actions']['can_redo']),('Проверка предложения',False))
        claimed=self.post(p,'assignment',{'assignee_user_id':self.user('kuznetsova'),'reason':'Взято в работу','expected_version':1},staff)
        self.assertIsNone(self.get(p,staff)['request_text'])
        self.decision(claimed,staff,approve=False)
        self.assertTrue(self.get(p,student)['actions']['can_redo'])
        self.assertFalse(self.get(p,staff)['actions']['can_redo'])
        mine=self.client.get('/api/v1/agent/proposals?box=mine',headers=student).json()['items']
        listed=next(item for item in mine if item['id']==p['id'])
        self.assertNotIn('request_text',listed)
        self.assertTrue(listed['actions']['can_redo'])
        self.query("UPDATE agent_backend.agent_run SET status='done',finished_at=now() WHERE id=%s RETURNING id",(run,))
        self.query('DELETE FROM agent_backend.chat_session WHERE id=%s RETURNING id',(session,))
        self.assertFalse(self.get(p,student)['actions']['can_redo'])

    def test_expired_agent_proposal_can_be_redone(self):
        headers=self.login('vasilyeva'); p=self.prepare(self.group_command(),headers)
        self.db.execute('RESET ROLE')
        self.db.execute('SET LOCAL session_replication_role=replica')
        self.db.execute("UPDATE agent_backend.proposal SET expires_at=now()-INTERVAL '1 minute' WHERE id=%s",(p['id'],))
        self.db.execute('SET LOCAL session_replication_role=origin')
        self.db.execute('SET LOCAL ROLE backend_api')
        self.assertTrue(self.get(p,headers)['actions']['can_redo'])

    def reject(self,p,director):
        return self.post(p,'decision',{'approve':False,'reason':'Основание не подтверждено','expected_version':p['version']},director)

    def test_rejected_form_correction_can_be_redone_by_its_author_until_a_new_one_is_open(self):
        teacher,director,pending=self.correction()
        self.assertFalse(self.get(pending,teacher)['actions']['can_redo'])
        rejected=self.reject(pending,director)
        own=self.get(rejected,teacher)
        self.assertEqual((own['status'],own['request_text'],own['actions']['can_redo']),('rejected',None,True))
        self.assertFalse(self.get(rejected,director)['actions']['can_redo'])
        mine=self.client.get('/api/v1/agent/proposals?box=mine',headers=teacher).json()['items']
        self.assertTrue(next(i for i in mine if i['id']==rejected['id'])['actions']['can_redo'])
        # Новая заявка по той же оценке открыта: повторить старую нельзя, пока её не рассмотрят.
        again=self.client.post('/api/v1/grade-corrections',headers=teacher|{'Idempotency-Key':str(uuid4())},json={
            'sheet_id':self.target['sheet_id'],'student_id':self.target['student_id'],
            'new_points':30 if self.target['points']!=30 else 31,'new_is_absent':False,'reason':'Повторная заявка с документом'})
        self.assertEqual(again.status_code,200,again.text)
        self.assertFalse(self.get(rejected,teacher)['actions']['can_redo'])
        self.assertFalse(again.json()['actions']['can_redo'])

    def test_applied_correction_cannot_be_redone(self):
        teacher,director,pending=self.correction()
        applied=self.post(pending,'decision',{'approve':True,'reason':'Проверено руководителем',
            'expected_version':pending['version']},director)
        self.assertEqual(applied['status'],'approved')
        self.assertFalse(self.get(applied,teacher)['actions']['can_redo'])

    def test_rejected_agent_correction_can_be_redone(self):
        teacher,director,form=self.correction()
        self.reject(form,director)
        row=self.query('''SELECT gs.sheet_number,s.record_book_number FROM deanery.grade_sheet gs
            JOIN deanery.student s ON s.student_id=%s WHERE gs.sheet_id=%s''',(self.target['student_id'],self.target['sheet_id']))[0]
        command={'version':1,'kind':'grade_correction','fields':{'sheet_number':row['sheet_number'],
            'record_book':row['record_book_number'],'new_points':30 if self.target['points']!=30 else 31,
            'new_is_absent':False,'reason':'Ошибка при переносе результата'}}
        draft=self.prepare(command,teacher)
        submitted=self.post(draft,'submit',{'expected_version':draft['version']},teacher)
        claimed=self.post(submitted,'assignment',{'assignee_user_id':self.user('smirnov'),'reason':'Принимаю на рассмотрение',
            'expected_version':submitted['version']},director)
        rejected=self.reject(claimed,director)
        own=self.get(rejected,teacher)
        self.assertEqual((own['request_text'],own['actions']['can_redo']),('Проверка предложения',True))

    # Р6
    def audit(self,headers,status=200,**params):
        response=self.client.get('/api/v1/audit',headers=headers,params=params)
        self.assertEqual(response.status_code,status,response.text)
        return response.json()

    def test_journal_returns_events_with_source_and_proposal(self):
        admin=self.login('vasilyeva')
        for name in ('ivanov.ks','novikov'):
            self.assertEqual(self.audit(self.login(name),403)['error']['code'],'forbidden')
        student=self.students(1)[0]
        response=self.client.patch('/api/v1/resources/student?student_id='+str(student['student_id']),headers=admin,
            json={'needs_dormitory':not student['needs_dormitory'],'is_foreign':not student['is_foreign']})
        self.assertEqual(response.status_code,200,response.text)
        response=self.client.patch('/api/v1/resources/student?student_id='+str(student['student_id']),headers=admin,
            json={'needs_dormitory':student['needs_dormitory']})
        self.assertEqual(response.status_code,200,response.text)
        record='student_id='+str(student['student_id'])
        first=self.audit(admin,table_name='student',limit=1)
        self.assertTrue(first['has_more'])
        self.assertEqual([c['column'] for c in first['items'][0]['changes']],['needs_dormitory'])
        second=self.audit(admin,table_name='student',limit=1,offset=1)
        self.assertFalse(second['has_more'])
        event=second['items'][0]
        self.assertEqual((event['record_key'],event['operation'],event['source'],event['proposal_id']),(record,'U','ui',None))
        self.assertIsInstance(event['audit_id'],str)
        self.assertNotEqual(event['audit_id'],first['items'][0]['audit_id'])
        self.assertEqual({c['column'] for c in event['changes']},{'needs_dormitory','is_foreign'})
        p=self.prepare(self.group_command(),admin); self.decision(p,admin)
        agent=self.audit(admin,table_name='study_group',source='agent',operation='U',changed_by='vasilyeva',
            changed_at__gte=(date.today()-timedelta(days=1)).isoformat(),
            changed_at__lte=(date.today()+timedelta(days=1)).isoformat())['items'][0]
        self.assertEqual((agent['source'],agent['proposal_id'],agent['changed_by']),('agent',p['id'],'vasilyeva'))
        self.assertTrue(agent['changed_by_name'])
        teacher,director,correction=self.correction()
        self.post(correction,'decision',{'approve':True,'reason':'Проверено руководителем',
            'expected_version':correction['version']},director)
        manual=self.audit(director,table_name='grade',limit=1)['items'][0]
        self.assertEqual((manual['source'],manual['proposal_id']),('ui',correction['id']))
        self.assertEqual(self.client.get('/api/v1/audit?operation=X',headers=admin).status_code,422)

    # Р8
    def test_selected_undo_skips_an_unselected_changed_row(self):
        headers=self.login('vasilyeva'); students=self.students(2)
        applied=self.approve(self.batch(headers,[self.dormitory(s) for s in students]),headers,[1,2])
        url='/api/v1/resources/student?student_id='+str(students[1]['student_id'])
        self.assertEqual(self.client.patch(url,json={'needs_dormitory':students[1]['needs_dormitory']},headers=headers).status_code,200)
        error=self.post(applied,'undo',{'picked_item_ids':[1,2]},headers,status=409)['error']
        self.assertEqual((error['code'],error['details']),('undo_changed',{'item_id':2,'reason':'changed'}))
        for picked in ([],[1,1],[3]):
            error=self.post(applied,'undo',{'picked_item_ids':picked},headers,status=422)['error']
            self.assertEqual((error['code'],error['details']['field']),('validation_error','picked_item_ids'))
        key=uuid4(); inverse=self.post(applied,'undo',{'picked_item_ids':[1]},headers,key)
        self.assertEqual(inverse['execution']['picked_item_ids'],[1])
        self.assertEqual(self.query('SELECT needs_dormitory FROM deanery.student WHERE student_id=%s',
            (students[0]['student_id'],))[0]['needs_dormitory'],students[0]['needs_dormitory'])
        self.assertEqual(self.post(applied,'undo',{'picked_item_ids':[1]},headers,key)['id'],inverse['id'])
        self.assertEqual(self.post(applied,'undo',{'picked_item_ids':[2]},headers,key,409)['error']['code'],'idempotency_conflict')
        self.assertEqual(self.post(applied,'undo',{'picked_item_ids':[2]},headers,status=409)['error']['details']['reason'],'expired')

    def test_schedule_conflict_in_a_selected_row_rolls_back_the_whole_undo(self):
        headers=self.login('vasilyeva'); student=self.students(1)[0]
        # Lessons without a stream partner at the same time, so only the room matters.
        slot=self.query("""SELECT s.slot_id,s.classroom_id FROM deanery.schedule_slot s
            JOIN deanery.teaching_assignment a USING(assignment_id)
            WHERE NOT EXISTS(SELECT FROM deanery.schedule_slot o JOIN deanery.teaching_assignment b USING(assignment_id)
                WHERE o.slot_id<>s.slot_id AND o.weekday=s.weekday AND o.pair_number=s.pair_number
                    AND (b.teacher_id=a.teacher_id OR b.group_id=a.group_id))
            ORDER BY s.slot_id LIMIT 20""")
        rooms=[r['classroom_id'] for r in self.query('SELECT classroom_id FROM deanery.classroom ORDER BY capacity DESC,classroom_id')]
        target=None
        for candidate in slot:
            for room in rooms:
                if room==candidate['classroom_id']: continue
                self.db.execute('RESET ROLE')
                try:
                    with self.db.transaction(force_rollback=True):
                        self.db.execute('UPDATE deanery.schedule_slot SET classroom_id=%s WHERE slot_id=%s',(room,candidate['slot_id']))
                    target=(candidate,room)
                except Exception:
                    pass
                finally:
                    self.db.execute('SET LOCAL ROLE backend_api')
                if target: break
            if target: break
        self.assertIsNotNone(target)
        candidate,room=target
        applied=self.approve(self.batch(headers,[self.dormitory(student),self.record('schedule_slot','update',
            {'slot_id':candidate['slot_id']},{'classroom_id':room})]),headers,[1,2])
        # Another lesson takes the old room at the same time, bypassing the checks only for this setup.
        self.db.execute('RESET ROLE')
        self.db.execute('SET LOCAL session_replication_role=replica')
        self.db.execute("""INSERT INTO deanery.schedule_slot(assignment_id,classroom_id,weekday,pair_number,week_parity,term_id,valid_from,valid_to)
            SELECT assignment_id,%s,weekday,pair_number,week_parity,term_id,valid_from,valid_to FROM deanery.schedule_slot
            WHERE slot_id=%s""",(candidate['classroom_id'],candidate['slot_id']))
        self.db.execute('SET LOCAL session_replication_role=origin')
        self.db.execute('SET LOCAL ROLE backend_api')
        error=self.post(applied,'undo',{'picked_item_ids':[1,2]},headers,status=409)['error']
        self.assertEqual((error['code'],error['details']),('undo_unavailable',{'item_id':2,'reason':'conflict'}))
        self.assertEqual(self.query('SELECT needs_dormitory FROM deanery.student WHERE student_id=%s',
            (student['student_id'],))[0]['needs_dormitory'],not student['needs_dormitory'])
        self.post(applied,'undo',{'picked_item_ids':[1]},headers)

    # Р9
    def test_each_unavailable_undo_names_its_reason(self):
        headers=self.login('vasilyeva'); student=self.students(1)[0]
        requests=self.query("""SELECT r.request_id,
                (SELECT request_status_id FROM deanery.request_status WHERE is_final ORDER BY request_status_id LIMIT 1) AS final
            FROM deanery.document_request r JOIN deanery.request_status s USING(request_status_id)
            WHERE NOT s.is_final ORDER BY r.request_id LIMIT 2""")
        p=self.batch(headers,[self.record('document_request','update',{'request_id':requests[0]['request_id']},{'purpose':'Для проверки отмены'}),
            self.record('document_request','update',{'request_id':requests[1]['request_id']},{'request_status_id':requests[1]['final']}),
            self.dormitory(student)])
        self.assertEqual([(i['reversible'],i['undo_reason']) for i in p['items']],
            [(False,'irreversible'),(False,'request_final'),(True,None)])
        applied=self.approve(p,headers,[1,2])
        self.assertEqual([(i['reversible'],i['undo_reason']) for i in self.get(applied,headers)['items']],
            [(False,'irreversible'),(False,'request_final'),(False,None)])
        self.assertFalse(applied['actions']['can_undo'])
        error=self.post(applied,'undo',{},headers,status=409)['error']
        self.assertEqual((error['code'],error['details']['reason']),('undo_unavailable','irreversible'))
        error=self.post(applied,'undo',{'picked_item_ids':[2]},headers,status=409)['error']
        self.assertEqual(error['details'],{'item_id':2,'reason':'request_final'})
        other=self.approve(self.batch(headers,[self.dormitory(student)]),headers,[1])
        self.query("UPDATE agent_backend.proposal SET decided_at=now()-INTERVAL '16 minutes' WHERE id=%s RETURNING id",(other['id'],))
        self.assertEqual(self.get(other,headers)['items'][0]['undo_reason'],'expired')
        self.assertEqual(self.post(other,'undo',{},headers,status=409)['error']['details'],{'reason':'expired'})

    def test_closed_sheet_row_is_not_reversible(self):
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
            'stage':target['stage'],'examiner_id':tid,'sheet_kind':'retake','issue_date':date.today().isoformat()}).json()
        grade=self.client.post('/api/v1/resources/grade',headers=teacher,json={
            'sheet_id':sheet['sheet_id'],'student_id':target['student_id'],'points':30,'is_absent':False}).json()
        applied=self.approve(self.batch(teacher,[self.record('grade','update',{'grade_id':grade['grade_id']},{'points':31})]),teacher,[1])
        self.assertEqual(self.get(applied,teacher)['items'][0]['reversible'],True)
        close=self.client.patch('/api/v1/resources/grade_sheet?sheet_id='+str(sheet['sheet_id']),headers=admin,
            json={'status':'closed','exam_date':date.today().isoformat(),'closed_date':date.today().isoformat()})
        self.assertEqual(close.status_code,200,close.text)
        item=self.get(applied,teacher)['items'][0]
        self.assertEqual((item['reversible'],item['undo_reason']),(False,'sheet_closed'))
        self.assertEqual(self.post(applied,'undo',{},teacher,status=409)['error']['details'],{'reason':'sheet_closed'})
