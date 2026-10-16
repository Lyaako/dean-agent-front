"""Преподаватель видит дисциплину и группу своих ведомостей; состав ведомости считает сервер."""
from datetime import date
from uuid import uuid4

from backend.tests.test_auth import DatabaseHttpCase
from backend.tests.test_proposals import ProposalHelpers


class TeacherSheetTests(ProposalHelpers,DatabaseHttpCase):
    def setUp(self):
        super().setUp()
        self.teacher=self.login('novikov')
        self.tid=self.client.get('/api/v1/auth/me',headers=self.teacher).json()['teacher_id']
        self.allowed={r['group_id'] for r in self.query('SELECT group_id FROM backend_api.allowed_groups(%s)',(self.user('novikov'),))}

    def rows(self,resource,headers,key):
        response=self.client.get(f'/api/v1/resources/{resource}?limit=500',headers=headers)
        self.assertEqual(response.status_code,200,response.text)
        self.assertFalse(response.json()['has_more'])
        return {r[key] for r in response.json()['items']}

    def roster(self,sheet,headers=None,status=200):
        response=self.client.get(f'/api/v1/resources/grade_sheet/{sheet}/roster',headers=headers or self.teacher)
        self.assertEqual(response.status_code,status,response.text)
        return response.json()

    def owner(self,statement,params=()):
        self.db.execute('RESET ROLE')
        try:
            cursor=self.db.execute(statement,params)
            return cursor.fetchall() if cursor.description else None
        finally:
            self.db.execute('SET LOCAL ROLE backend_api')

    def sheet_like(self,source,kind,**changes):
        return self.owner("""INSERT INTO deanery.grade_sheet(sheet_number,item_id,group_id,examiner_id,stage,sheet_kind,issue_date)
            SELECT %s,item_id,COALESCE(%s,group_id),examiner_id,stage,%s,CURRENT_DATE FROM deanery.grade_sheet WHERE sheet_id=%s
            RETURNING sheet_id""",('QA-'+uuid4().hex[:12],changes.get('group_id'),kind,source))[0]['sheet_id']

    def past_sheet(self):
        # Закрытая основная ведомость novikov по группе, которую он сейчас не ведёт, с не аттестованными студентами
        # и без открытых ведомостей этого этапа дисциплины.
        return self.query("""SELECT gs.sheet_id,gs.item_id,gs.group_id,gs.stage,ci.discipline_id,ci.semester
            FROM deanery.grade_sheet gs JOIN deanery.curriculum_item ci USING(item_id)
            WHERE gs.examiner_id=%s AND gs.status='closed' AND gs.sheet_kind='main' AND NOT gs.group_id=ANY(%s)
              AND NOT EXISTS(SELECT FROM deanery.grade_sheet o JOIN deanery.curriculum_item oc USING(item_id)
                  WHERE o.status='open' AND o.stage=gs.stage AND oc.discipline_id=ci.discipline_id AND oc.semester=ci.semester)
              AND (SELECT count(*) FROM deanery.grade gr JOIN deanery.student s USING(student_id)
                  JOIN deanery.student_status st USING(status_id) WHERE gr.sheet_id=gs.sheet_id AND st.is_active
                  AND NOT EXISTS(SELECT FROM deanery.grade g2 JOIN deanery.grade_sheet s2 USING(sheet_id)
                      JOIN deanery.curriculum_item c2 USING(item_id) WHERE g2.student_id=gr.student_id AND s2.status<>'cancelled'
                      AND s2.stage=gs.stage AND c2.discipline_id=ci.discipline_id AND c2.semester=ci.semester
                      AND g2.points IS NOT NULL))>=3
            ORDER BY gs.sheet_id LIMIT 1""",(self.tid,list(self.allowed)))[0]

    def not_attested(self,past):
        return [r['student_id'] for r in self.query("""SELECT gr.student_id FROM deanery.grade gr
            JOIN deanery.student s USING(student_id) JOIN deanery.student_status st USING(status_id)
            WHERE gr.sheet_id=%s AND st.is_active AND NOT EXISTS(SELECT FROM deanery.grade g2
                JOIN deanery.grade_sheet s2 USING(sheet_id) JOIN deanery.curriculum_item c2 USING(item_id)
                WHERE g2.student_id=gr.student_id AND s2.status<>'cancelled' AND s2.stage=%s
                AND c2.discipline_id=%s AND c2.semester=%s AND g2.points IS NOT NULL)
            ORDER BY gr.student_id""",(past['sheet_id'],past['stage'],past['discipline_id'],past['semester']))]

    def test_names_of_own_past_sheets_are_visible_without_widening_groups(self):
        sheets=self.query('SELECT item_id,group_id FROM deanery.grade_sheet WHERE examiner_id=%s',(self.tid,))
        items=self.rows('v_curriculum',self.teacher,'item_id'); groups=self.rows('v_groups',self.teacher,'group_id')
        self.assertLessEqual({s['item_id'] for s in sheets},items)
        self.assertLessEqual({s['group_id'] for s in sheets},groups)
        self.assertLessEqual({s['item_id'] for s in sheets},self.rows('curriculum_item',self.teacher,'item_id'))
        self.assertLessEqual({s['group_id'] for s in sheets},self.rows('study_group',self.teacher,'group_id'))
        foreign=self.query("""SELECT ci.item_id,g.group_id FROM deanery.curriculum_item ci
            JOIN deanery.study_group g ON g.curriculum_id=ci.curriculum_id
            WHERE NOT EXISTS(SELECT FROM deanery.teaching_assignment ta WHERE (ta.item_id=ci.item_id OR ta.group_id=g.group_id) AND ta.teacher_id=%s)
              AND NOT EXISTS(SELECT FROM deanery.grade_sheet gs WHERE (gs.item_id=ci.item_id OR gs.group_id=g.group_id) AND gs.examiner_id=%s)
            LIMIT 1""",(self.tid,self.tid))[0]
        self.assertNotIn(foreign['item_id'],items)
        self.assertNotIn(foreign['group_id'],groups)
        # Студенты, расписание и OLAP идут по прежним группам поручений.
        sheet_only={s['group_id'] for s in sheets}-self.allowed
        self.assertTrue(sheet_only)
        self.assertEqual({r['group_id'] for r in self.query('SELECT group_id FROM backend_api.allowed_groups(%s)',
            (self.user('novikov'),))},self.allowed)
        self.assertFalse(self.rows('student',self.teacher,'group_id')&sheet_only)
        slots=self.rows('schedule_slot',self.teacher,'assignment_id')
        if slots:
            self.assertFalse({r['group_id'] for r in self.query('SELECT group_id FROM deanery.teaching_assignment WHERE assignment_id=ANY(%s)',
                (list(slots),))}&sheet_only)
        olap=self.query('SELECT backend_api.olap_dataset(%s) AS data',(self.teacher['Authorization'][7:],))[0]['data']
        self.assertLessEqual({s['group_id'] for s in olap['students']},self.allowed)

    def test_open_main_sheet_lists_active_group_students(self):
        admin=self.login('vasilyeva')
        # Новая основная ведомость по текущему поручению novikov, для которой основной ещё нет.
        sheet=group=None
        for c in self.query("""SELECT ta.item_id,ta.group_id,st.stage FROM deanery.teaching_assignment ta
                CROSS JOIN (VALUES ('final'),('module_1'),('module_2')) st(stage)
                WHERE ta.teacher_id=%s AND NOT EXISTS(SELECT FROM deanery.grade_sheet gs WHERE gs.item_id=ta.item_id
                    AND gs.group_id=ta.group_id AND gs.stage=st.stage AND gs.sheet_kind='main' AND gs.status<>'cancelled')
                ORDER BY ta.assignment_id,st.stage""",(self.tid,)):
            self.db.execute('RESET ROLE')
            try:
                with self.db.transaction():
                    sheet=self.db.execute("""INSERT INTO deanery.grade_sheet(sheet_number,item_id,group_id,examiner_id,stage,sheet_kind,issue_date)
                        VALUES(%s,%s,%s,%s,%s,'main',CURRENT_DATE) RETURNING sheet_id""",
                        ('QA-'+uuid4().hex[:12],c['item_id'],c['group_id'],self.tid,c['stage'])).fetchone()['sheet_id']
                    group=c['group_id']
            except Exception:
                pass
            finally:
                self.db.execute('SET LOCAL ROLE backend_api')
            if sheet: break
        self.assertIsNotNone(sheet)
        expected=self.query("""SELECT s.student_id FROM deanery.student s JOIN deanery.student_status st USING(status_id)
            WHERE s.group_id=%s AND st.is_active""",(group,))
        items=self.roster(sheet,admin)['items']
        self.assertEqual({i['student_id'] for i in items},{r['student_id'] for r in expected})
        self.assertTrue(all(i['grade_id'] is None and i['points'] is None and i['is_absent'] is False and i['active'] for i in items))
        self.assertEqual([i['student_id'] for i in items],[r['student_id'] for r in self.query("""SELECT s.student_id
            FROM deanery.student s JOIN deanery.person p USING(person_id) WHERE s.student_id=ANY(%s)
            ORDER BY p.last_name,p.first_name,p.middle_name NULLS FIRST,s.student_id""",([i['student_id'] for i in items],))])
        self.assertEqual(set(items[0]),{'student_id','student','active','grade_id','points','is_absent'})
        graded=self.client.post('/api/v1/resources/grade',headers=self.teacher,json={'sheet_id':sheet,
            'student_id':items[0]['student_id'],'points':40,'is_absent':False})
        self.assertEqual(graded.status_code,200,graded.text)
        row=next(i for i in self.roster(sheet)['items'] if i['student_id']==items[0]['student_id'])
        self.assertEqual((row['grade_id'],row['points']),(graded.json()['grade_id'],40))

    def test_retake_lists_only_not_attested_students_outside_other_open_sheets(self):
        past=self.past_sheet(); waiting=self.not_attested(past)
        moved,elsewhere=waiting[0],waiting[1]
        target=self.query('SELECT group_id FROM deanery.study_group WHERE group_id<>%s AND NOT is_archived ORDER BY group_id LIMIT 1',
            (past['group_id'],))[0]['group_id']
        self.owner('UPDATE deanery.student SET group_id=%s WHERE student_id=%s',(target,moved))  # переведён с долгом
        retake=self.sheet_like(past['sheet_id'],'retake')
        other=self.sheet_like(past['sheet_id'],'retake')
        self.owner('INSERT INTO deanery.grade(sheet_id,student_id) VALUES(%s,%s)',(other,elsewhere))
        # Ведомость по группе, которую novikov сейчас не ведёт: состав всё равно отдаётся.
        self.assertNotIn(past['group_id'],self.allowed)
        items={i['student_id']:i for i in self.roster(retake)['items']}
        self.assertEqual(set(items),set(waiting)-{elsewhere})
        self.assertIn(moved,items)
        self.assertTrue(all(i['grade_id'] is None for i in items.values()))
        graded=self.client.post('/api/v1/resources/grade',headers=self.teacher,json={'sheet_id':retake,
            'student_id':moved,'points':35,'is_absent':False})
        self.assertEqual(graded.status_code,200,graded.text)
        self.assertEqual(next(i for i in self.roster(retake)['items'] if i['student_id']==moved)['points'],35)

    def other_group(self,past):
        # Другая группа, в плане которой есть та же дисциплина того же семестра с нужным модулем,
        # и обучающийся студент этой группы без баллов и без открытых ведомостей по этапу.
        return self.query("""SELECT g.group_id,ci.item_id,
                (SELECT s.student_id FROM deanery.student s JOIN deanery.student_status st USING(status_id)
                 WHERE s.group_id=g.group_id AND st.is_active AND NOT EXISTS(SELECT FROM deanery.grade g3
                     JOIN deanery.grade_sheet s3 USING(sheet_id) JOIN deanery.curriculum_item c3 USING(item_id)
                     WHERE g3.student_id=s.student_id AND s3.status<>'cancelled' AND s3.stage=%(stage)s
                       AND c3.discipline_id=%(discipline)s AND c3.semester=%(semester)s
                       AND (g3.points IS NOT NULL OR s3.status='open' OR s3.group_id=%(group)s))
                 ORDER BY s.student_id LIMIT 1) AS student_id
            FROM deanery.study_group g JOIN deanery.curriculum_item ci ON ci.curriculum_id=g.curriculum_id
            WHERE g.group_id<>%(group)s AND NOT g.is_archived AND ci.discipline_id=%(discipline)s AND ci.semester=%(semester)s
              AND ci.module_count>=CASE %(stage)s WHEN 'module_2' THEN 2 WHEN 'module_1' THEN 1 ELSE 0 END
            ORDER BY (SELECT count(*) FROM deanery.student s WHERE s.group_id=g.group_id) DESC,g.group_id LIMIT 1""",
            {'group':past['group_id'],'stage':past['stage'],'discipline':past['discipline_id'],'semester':past['semester']})[0]

    def sheet_in(self,past,other,kind='retake'):
        return self.owner("""INSERT INTO deanery.grade_sheet(sheet_number,item_id,group_id,examiner_id,stage,sheet_kind,issue_date)
            VALUES(%s,%s,%s,%s,%s,%s,CURRENT_DATE) RETURNING sheet_id""",
            ('QA-'+uuid4().hex[:12],other['item_id'],other['group_id'],self.tid,past['stage'],kind))[0]['sheet_id']

    def close(self,sheet):
        self.owner("UPDATE deanery.grade_sheet SET status='closed',exam_date=CURRENT_DATE,closed_date=CURRENT_DATE WHERE sheet_id=%s",(sheet,))

    def test_retake_omits_failed_students_of_other_groups(self):
        past=self.past_sheet(); other=self.other_group(past)
        self.assertIsNotNone(other['student_id'])
        # Несданная попытка этого этапа в ведомости своей (другой) группы.
        there=self.sheet_in(past,other)
        self.owner('INSERT INTO deanery.grade(sheet_id,student_id) VALUES(%s,%s)',(there,other['student_id']))
        self.close(there)
        items={i['student_id'] for i in self.roster(self.sheet_like(past['sheet_id'],'retake'))['items']}
        self.assertNotIn(other['student_id'],items)
        self.assertEqual(items,set(self.not_attested(past)))

    def test_retake_omits_student_who_passed_in_another_group(self):
        past=self.past_sheet(); student=self.not_attested(past)[0]; other=self.other_group(past)
        self.owner('UPDATE deanery.student SET group_id=%s WHERE student_id=%s',(other['group_id'],student))  # переведён с долгом
        there=self.sheet_in(past,other)
        self.owner('INSERT INTO deanery.grade(sheet_id,student_id,points) VALUES(%s,%s,40)',(there,student))
        self.close(there)
        items={i['student_id'] for i in self.roster(self.sheet_like(past['sheet_id'],'retake'))['items']}
        self.assertNotIn(student,items)
        self.assertEqual(items,set(self.not_attested(past)))

    def test_student_without_result_is_in_one_group_retake_only(self):
        past=self.past_sheet(); waiting=set(self.not_attested(past))
        own={i['student_id'] for i in self.roster(self.sheet_like(past['sheet_id'],'retake'))['items']}
        other={i['student_id'] for i in self.roster(self.sheet_in(past,self.other_group(past)))['items']}
        self.assertEqual(own,waiting)
        self.assertFalse(own&other)

    def test_closed_sheet_lists_only_graded_and_access_is_limited(self):
        past=self.past_sheet()
        graded={r['student_id'] for r in self.query('SELECT student_id FROM deanery.grade WHERE sheet_id=%s',(past['sheet_id'],))}
        self.assertEqual({i['student_id'] for i in self.roster(past['sheet_id'])['items']},graded)
        foreign=self.query('SELECT sheet_id FROM deanery.grade_sheet WHERE examiner_id<>%s ORDER BY sheet_id LIMIT 1',(self.tid,))[0]['sheet_id']
        self.assertEqual(self.roster(foreign,status=404)['error']['code'],'not_found')
        self.assertEqual(self.roster(10**9,status=404)['error']['code'],'not_found')
        self.assertEqual(self.roster(past['sheet_id'],self.login('ivanov.ks'),404)['error']['code'],'not_found')
        self.assertEqual({i['student_id'] for i in self.roster(past['sheet_id'],self.login('vasilyeva'))['items']},graded)
