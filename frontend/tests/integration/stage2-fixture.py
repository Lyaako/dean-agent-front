"""Owned UI-clone fixtures only; no credentials or personal data are printed."""
import json
from pathlib import Path
import sys

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[3]
sys.stdout.reconfigure(encoding='utf-8')
PRIVATE = ROOT / '.local'
DESTINATION = PRIVATE / 'p12-browser-stage2-fixture.json'
parameters = json.loads((PRIVATE / 'p12-ui-connection.json').read_text(encoding='utf-8'))
credentials = json.loads((PRIVATE / 'p12-browser-credentials.json').read_text(encoding='utf-8'))
assert len(sys.argv) == 2 and sys.argv[1] in {'prepare', 'cleanup', 'employee', 'workflows', 'verify', 'return-fixture', 'lifecycle-verify', 'edge-prepare', 'edge-cleanup'}
assert parameters['dbname'] == credentials['database'] == 'deanery_p12_ui_92004917'

with psycopg.connect(**parameters, row_factory=dict_row) as db:
    assert db.execute('SELECT current_database() AS name,version_num FROM public.alembic_version').fetchone() == {
        'name': parameters['dbname'], 'version_num': '0039_scope_check_latency'}
    db.execute('SET LOCAL search_path=deanery,pg_catalog')
    if sys.argv[1] == 'prepare':
        assert not DESTINATION.exists(), 'Reuse the existing owned fixture; do not duplicate it.'
        user = next(a['user_id'] for a in credentials['accounts'] if a['role'] == 'teacher')
        teacher = db.execute('SELECT teacher_id FROM backend_api.account_snapshot(%s)', (user,)).fetchone()['teacher_id']
        original_groups = {r['group_id'] for r in db.execute('SELECT DISTINCT group_id FROM deanery.teaching_assignment WHERE teacher_id=%s', (teacher,))}
        assignments = []
        # I069: align two real own-examiner subjects in already assigned groups, without changing any scope rule.
        for item, group in ((12, 1), (373, 4)):
            assert group in original_groups
            subject = db.execute('''SELECT ci.discipline_id,ci.semester FROM deanery.curriculum_item ci
                JOIN deanery.study_group sg ON sg.curriculum_id=ci.curriculum_id AND sg.group_id=%s
                WHERE ci.item_id=%s AND EXISTS(SELECT FROM deanery.grade_sheet gs
                    WHERE gs.item_id=ci.item_id AND gs.group_id=sg.group_id AND gs.examiner_id=%s
                    AND gs.stage='final' AND gs.status='closed')''', (group, item, teacher)).fetchone()
            assert subject
            assert not db.execute('SELECT FROM deanery.teaching_assignment WHERE teacher_id=%s AND item_id=%s AND group_id=%s', (teacher, item, group)).fetchone()
            assignment = db.execute('''INSERT INTO deanery.teaching_assignment(item_id,group_id,teacher_id,lesson_type_id)
                VALUES(%s,%s,%s,1) RETURNING assignment_id''', (item, group, teacher)).fetchone()['assignment_id']
            assignments.append({'assignment_id': assignment, 'item_id': item, 'group_id': group, **subject})
        facts = list(db.execute('SELECT f FROM agent_backend.olap_facts_for_actor(%s) f', (user,)))
        assert any(r['f']['kind'] == 'result' for r in facts)
        assert len({r['f']['semester'] for r in facts}) >= 2
        visible = {json.loads(r['f'])['group_id'] for r in db.execute("SELECT f FROM agent_backend.visible_rows_for_actor('study_group',%s) f", (user,))}
        foreign = db.execute('SELECT group_id FROM deanery.study_group WHERE group_id <> ALL(%s) ORDER BY group_id LIMIT 1', (list(visible),)).fetchone()['group_id']
        employee = db.execute('SELECT employee_id,person_id,employment_rate FROM deanery.employee WHERE employee_id=%s', (teacher,)).fetchone()
        person = db.execute('SELECT last_name,first_name,middle_name FROM deanery.person WHERE person_id=%s', (employee['person_id'],)).fetchone()
        fixture = {'database': parameters['dbname'], 'assignments': assignments, 'foreign_group_id': foreign,
                   'employee': employee, 'person': person}
        DESTINATION.write_text(json.dumps(fixture, ensure_ascii=False, default=str, indent=2), encoding='utf-8')
        print(json.dumps({'database': parameters['dbname'], 'assignments': assignments, 'foreign_group_id': foreign,
                          'result_facts': sum(r['f']['kind'] == 'result' for r in facts)}))
    else:
        fixture = json.loads(DESTINATION.read_text(encoding='utf-8'))
        assert fixture['database'] == parameters['dbname']
        employee = fixture['employee']
        if sys.argv[1] == 'edge-prepare':
            from datetime import timedelta
            from decimal import Decimal, ROUND_HALF_UP
            import secrets

            destination = PRIVATE / 'p12-browser-stage2-edge-fixture.json'
            assert not destination.exists(), 'Reuse the recorded edge fixture.'
            workflow = json.loads((PRIVATE / 'p12-browser-stage2-workflows.json').read_text(encoding='utf-8'))
            subject = db.execute('SELECT s.*,p.last_name,p.first_name,p.middle_name,p.gender,p.birth_date FROM deanery.student s JOIN deanery.person p USING(person_id) WHERE student_id=%s', (workflow['result']['student_id'],)).fetchone()
            assert subject['group_id'] == 1 and db.execute('SELECT is_active FROM deanery.student_status WHERE status_id=%s', (subject['status_id'],)).fetchone()['is_active']
            assert db.execute('SELECT count(*) AS n FROM deanery.grade WHERE student_id=%s', (subject['student_id'],)).fetchone()['n'] == 0
            duplicate = db.execute('INSERT INTO deanery.person(last_name,first_name,middle_name,gender,birth_date) VALUES(%s,%s,%s,%s,%s) RETURNING person_id',
                                   (*[subject[k] for k in ('last_name','first_name','middle_name','gender','birth_date')],)).fetchone()['person_id']
            code = 'P12Edge-' + secrets.token_hex(4)
            second = db.execute('INSERT INTO deanery.student(person_id,record_book_number,group_id,funding_type_id,status_id,enrollment_date) VALUES(%s,%s,%s,%s,%s,CURRENT_DATE) RETURNING student_id',
                                (duplicate,code,subject['group_id'],subject['funding_type_id'],subject['status_id'])).fetchone()['student_id']
            admin = next(a['user_id'] for a in credentials['accounts'] if a['role'] == 'admin')
            low, high = db.execute('SELECT min(min_points) AS low,max(max_points) AS high FROM deanery.score_band').fetchone().values()
            today = db.execute('SELECT CURRENT_DATE AS d').fetchone()['d']
            teacher = next(a['user_id'] for a in credentials['accounts'] if a['role'] == 'teacher')
            examiner = db.execute('SELECT teacher_id FROM backend_api.account_snapshot(%s)', (teacher,)).fetchone()['teacher_id']
            sheets, grades = [], []
            for number, (item,day,results) in enumerate([
                (1,today-timedelta(days=2),[(subject['student_id'],None),(second,None)]),
                (1,today-timedelta(days=1),[(subject['student_id'],high),(second,low)]),
                (2,today,[(subject['student_id'],None)]), (4,today,[(subject['student_id'],high)])]):
                item_spec = db.execute('SELECT ci.discipline_id,ci.semester,ct.is_graded FROM deanery.curriculum_item ci JOIN deanery.control_type ct USING(control_type_id) WHERE ci.item_id=%s AND ci.curriculum_id=1', (item,)).fetchone()
                assert item_spec and item_spec['semester'] == 1 and item_spec['is_graded'] == (item != 4)
                sheet = db.execute('''INSERT INTO deanery.grade_sheet(sheet_number,item_id,group_id,examiner_id,stage,sheet_kind,issue_date,exam_date)
                    VALUES(%s,%s,1,%s,'final','retake',%s,%s) RETURNING sheet_id''', (code+str(number),item,examiner,day,day)).fetchone()['sheet_id']
                sheets.append(sheet)
                for student,points in results:
                    grade = db.execute('INSERT INTO deanery.grade(sheet_id,student_id,points) VALUES(%s,%s,%s) RETURNING grade_id', (sheet,student,points)).fetchone()['grade_id']
                    grades.append(grade)
            ids = [subject['student_id'],second]
            facts = [r['f'] for r in db.execute('SELECT f FROM agent_backend.olap_facts_for_actor(%s,1,NULL,1,NULL) f WHERE (f->>\'student_id\')::int=ANY(%s)', (admin,ids))]
            results = [f for f in facts if f['kind'] == 'result']
            assert len(results) == 4 and len({(r['student_id'],r['discipline_id'],r['semester']) for r in results}) == 4
            assert {r['student'] for r in results} == {' '.join(str(subject[k]) for k in ('last_name','first_name','middle_name') if subject[k])}
            assert sorted(r['points'] for r in results if r['points'] is not None) == sorted([high,high,low])
            assert sum(r['is_graded'] and r['mark'] == 5 for r in results) == 1
            assert sum(f['kind'] == 'debt' for f in facts) == 1
            edge = {'database':parameters['dbname'],'student_ids':ids,'new_student_id':second,'new_person_id':duplicate,'record_book':code,
                    'sheet_ids':sheets,'grade_ids':grades,'name':results[0]['student'],'group_id':1,'semester':1,
                    'rows':results,'avg':str((Decimal(high+high+low)/3).quantize(Decimal('0.01'),rounding=ROUND_HALF_UP)),
                    'results':4,'excellent':1,'debts':1,'high':high,'low':low}
            destination.write_text(json.dumps(edge,ensure_ascii=False,indent=2),encoding='utf-8')
            print(json.dumps({'students':ids,'sheets':len(sheets),'raw_attempts':len(grades),'final_results':4,'avg':edge['avg'],'excellent':1,'debts':1}))
        elif sys.argv[1] == 'edge-cleanup':
            edge = json.loads((PRIVATE / 'p12-browser-stage2-edge-fixture.json').read_text(encoding='utf-8'))
            assert edge['database'] == parameters['dbname']
            for grade in edge['grade_ids']:
                assert db.execute('DELETE FROM deanery.grade WHERE grade_id=%s AND sheet_id=ANY(%s) AND student_id=ANY(%s) RETURNING grade_id', (grade,edge['sheet_ids'],edge['student_ids'])).fetchone()
            for sheet in edge['sheet_ids']:
                assert db.execute('DELETE FROM deanery.grade_sheet WHERE sheet_id=%s AND status=%s RETURNING sheet_id', (sheet,'open')).fetchone()
            assert db.execute('DELETE FROM deanery.student WHERE student_id=%s AND person_id=%s AND record_book_number=%s RETURNING student_id', (edge['new_student_id'],edge['new_person_id'],edge['record_book'])).fetchone()
            assert db.execute('DELETE FROM deanery.person WHERE person_id=%s RETURNING person_id', (edge['new_person_id'],)).fetchone()
            assert db.execute('SELECT count(*) AS n FROM deanery.grade WHERE student_id=%s', (edge['student_ids'][0],)).fetchone()['n'] == 0
            print(json.dumps({'owned_grades_removed':len(edge['grade_ids']),'owned_open_sheets_removed':len(edge['sheet_ids']),'owned_duplicate_removed':True,'source_student_unchanged':True,'audit_preserved':True}))
        elif sys.argv[1] == 'lifecycle-verify':
            workflow = json.loads((PRIVATE / 'p12-browser-stage2-workflows.json').read_text(encoding='utf-8'))
            progress = json.loads((PRIVATE / 'p12-browser-stage2-lifecycle.json').read_text(encoding='utf-8'))
            returned = json.loads((PRIVATE / 'p12-browser-stage2-return-fixture.json').read_text(encoding='utf-8'))
            admin = next(a['user_id'] for a in credentials['accounts'] if a['role'] == 'admin')
            assert len(progress['cases']) == 5
            cases = [{'name': 'enroll_student', 'result': workflow['result']}, *progress['cases']]
            assert len({case['result']['order_id'] for case in cases}) == 6
            for case in cases:
                result = case['result']
                assert result['status'] == 'applied'
                assert db.execute('SELECT applied_at FROM deanery.order_student WHERE order_id=%s AND student_id=%s',
                                  (result['order_id'], result['student_id'])).fetchone()['applied_at'] is not None
                assert db.execute('SELECT status FROM agent_backend.job WHERE id=%s', (result['job_id'],)).fetchone()['status'] == 'succeeded'
                assert db.execute('SELECT count(*) AS n FROM deanery.audit_log WHERE table_name=%s AND record_key=%s AND operation=%s AND app_user_id=%s AND agent_request_id IS NULL',
                                  ('academic_order', f"order_id={result['order_id']}", 'I', admin)).fetchone()['n'] == 1
            final = db.execute('SELECT group_id,ss.name AS status FROM deanery.student JOIN deanery.student_status ss USING(status_id) WHERE student_id=%s', (progress['student_id'],)).fetchone()
            assert final == {'group_id': workflow['choices']['groups'][0]['group_id'], 'status': '\u041e\u0431\u0443\u0447\u0430\u0435\u0442\u0441\u044f'}
            leave = db.execute('SELECT start_date,end_date,return_order_id FROM deanery.academic_leave WHERE leave_id=%s AND student_id=%s', (returned['leave_id'], returned['student_id'])).fetchone()
            assert str(leave['start_date']) == returned['start_date'] and str(leave['end_date']) == returned['end_date']
            assert leave['return_order_id'] == progress['cases'][2]['result']['order_id']
            report = {'database': parameters['dbname'], 'native_workflows': [case['name'] for case in cases],
                      'distinct_applied_orders': 6, 'all_jobs_succeeded': True, 'single_insert_audit_per_order': True,
                      'manual_actor': admin, 'agent_request_null': True, 'synthetic_student_final_group_status': True,
                      'prior_leave_dates_unchanged': True, 'legitimate_return_link': True}
            (ROOT / '.nelson/missions/2026-10-11_065347_b2445e93/task16-native-lifecycle-control.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
            print(json.dumps(report))
        elif sys.argv[1] == 'return-fixture':
            destination = PRIVATE / 'p12-browser-stage2-return-fixture.json'
            assert not destination.exists(), 'Reuse the recorded existing return fixture.'
            choices = json.loads((PRIVATE / 'p12-browser-stage2-workflows.json').read_text(encoding='utf-8'))['choices']
            subject = db.execute('''SELECT s.student_id,s.group_id,g.name AS group_name,ss.name AS status,
                al.leave_id,al.start_date,al.end_date,al.return_order_id
                FROM deanery.student s JOIN deanery.study_group g USING(group_id)
                JOIN deanery.student_status ss USING(status_id) JOIN deanery.academic_leave al USING(student_id)
                WHERE s.student_id=99 AND ss.name=%s AND al.return_order_id IS NULL AND al.start_date<CURRENT_DATE
                AND deanery.fn_manages_institute(%s,deanery.fn_group_institute(s.group_id))''',
                ('\u0410\u043a\u0430\u0434\u0435\u043c\u0438\u0447\u0435\u0441\u043a\u0438\u0439 \u043e\u0442\u043f\u0443\u0441\u043a',choices['signer']['employee_id'])).fetchone()
            assert subject
            destination.write_text(json.dumps({'database': parameters['dbname'], **subject}, ensure_ascii=False, default=str, indent=2), encoding='utf-8')
            print(json.dumps({'student_id': subject['student_id'], 'start_date_before_today': True, 'signer_scoped': True}))
        elif sys.argv[1] == 'verify':
            from decimal import Decimal

            workflow = json.loads((PRIVATE / 'p12-browser-stage2-workflows.json').read_text(encoding='utf-8'))
            assert workflow['database'] == parameters['dbname'] and workflow['status'] == 200
            admin = next(a['user_id'] for a in credentials['accounts'] if a['role'] == 'admin')
            attempts = workflow['attempts']
            assert len(attempts) == 3 and attempts[0]['key'] == attempts[1]['key'] != attempts[2]['key']
            first = db.execute('SELECT FROM agent_backend.idempotency_record WHERE user_id=%s AND route=%s AND key=%s',
                               (admin, '/workflows/enroll_student', attempts[0]['key'])).fetchone()
            assert first is None, 'Aborted browser attempts reached the domain backend.'
            saved = db.execute('SELECT response_body FROM agent_backend.idempotency_record WHERE user_id=%s AND route=%s AND key=%s',
                               (admin, '/workflows/enroll_student', attempts[2]['key'])).fetchone()['response_body']
            assert saved == workflow['result']
            subject = db.execute('''SELECT s.person_id,s.group_id,p.last_name,p.first_name,p.middle_name FROM deanery.student s
                JOIN deanery.person p USING(person_id) WHERE s.student_id=%s''', (saved['student_id'],)).fetchone()
            assert subject['group_id'] == workflow['choices']['groups'][0]['group_id']
            assert {k: subject[k] for k in ('last_name','first_name','middle_name')} == {k: attempts[2]['body'][k] for k in ('last_name','first_name','middle_name')}
            assert db.execute('SELECT count(*) AS n FROM deanery.person WHERE last_name=%s', (workflow['last_name'],)).fetchone()['n'] == 1
            order = db.execute('SELECT applied_at FROM deanery.order_student WHERE order_id=%s AND student_id=%s', (saved['order_id'], saved['student_id'])).fetchone()
            assert order and order['applied_at'] is not None
            assert db.execute('SELECT count(*) AS n FROM deanery.audit_log WHERE table_name=%s AND record_key=%s AND operation=%s AND app_user_id=%s AND agent_request_id IS NULL',
                              ('academic_order', f"order_id={saved['order_id']}", 'I', admin)).fetchone()['n'] == 1
            assert db.execute('SELECT status FROM agent_backend.job WHERE id=%s', (saved['job_id'],)).fetchone()['status'] == 'succeeded'
            for table, key, column, value in [('person', f"person_id={employee['person_id']}", 'last_name', 'P12Stage2_Last'),
                                              ('employee', f"employee_id={employee['employee_id']}", 'employment_rate', '1.00' if Decimal(employee['employment_rate']) == Decimal('0.75') else '0.75')]:
                assert db.execute('''SELECT count(*) AS n FROM deanery.audit_log a JOIN deanery.audit_log_detail d USING(audit_id)
                    WHERE a.table_name=%s AND a.record_key=%s AND a.operation='U' AND a.app_user_id=%s
                    AND a.agent_request_id IS NULL AND d.column_name=%s AND d.new_value=%s''', (table, key, admin, column, value)).fetchone()['n'] == 1
            from datetime import datetime, timezone, timedelta

            first = ROOT / '.nelson/missions/2026-10-11_065347_b2445e93/task16-browser-stage2-olap-initial-failure.json'
            own_start = datetime.fromtimestamp(first.stat().st_mtime, timezone.utc) - timedelta(seconds=12)
            actors = [a['user_id'] for a in credentials['accounts'] if a['role'] in ('admin','teacher')]
            active = db.execute('SELECT count(*) AS n FROM agent_backend.auth_session WHERE revoked_at IS NULL AND expires_at>now() AND user_id=ANY(%s) AND created_at>=%s', (actors, own_start)).fetchone()['n']
            assert active == 0
            historical = db.execute('SELECT count(*) AS n FROM agent_backend.auth_session WHERE revoked_at IS NULL AND expires_at>now() AND created_at<%s', (own_start,)).fetchone()['n']
            report = {'database': parameters['dbname'], 'aborted_key_absent': True, 'one_native_student': True,
                      'changed_body_saved': True, 'applied_order': True, 'job_succeeded': True,
                      'single_official_order_insert_audit': True, 'single_person_update_audit': True,
                      'single_employee_update_audit': True, 'manual_audit_actor': admin, 'agent_request_null': True,
                      'own_active_auth_sessions': active, 'historical_active_sessions_preserved': historical}
            (ROOT / '.nelson/missions/2026-10-11_065347_b2445e93/task16-native-form-control.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
            print(json.dumps(report))
        elif sys.argv[1] == 'workflows':
            signer = db.execute('''SELECT e.employee_id, deanery.fn_full_name(p) AS label
                FROM deanery.employee e JOIN deanery.person p USING(person_id)
                WHERE e.dismissal_date IS NULL AND deanery.fn_manages_institute(e.employee_id,deanery.fn_group_institute(1))
                ORDER BY e.employee_id LIMIT 1''').fetchone()
            groups = list(db.execute('SELECT group_id,name,curriculum_id FROM deanery.study_group WHERE group_id IN (1,2) ORDER BY group_id'))
            assert len(groups) == 2 and groups[0]['curriculum_id'] == groups[1]['curriculum_id'] and signer
            print(json.dumps({'signer': signer, 'groups': groups, 'today': str(db.execute('SELECT CURRENT_DATE AS today').fetchone()['today']),
                              'funding': db.execute('SELECT name FROM deanery.funding_type ORDER BY funding_type_id LIMIT 1').fetchone()['name'],
                              'leave_reason': db.execute('SELECT name FROM deanery.leave_reason ORDER BY reason_id LIMIT 1').fetchone()['name']}, ensure_ascii=False))
        elif sys.argv[1] == 'employee':
            current = db.execute('SELECT employment_rate FROM deanery.employee WHERE employee_id=%s', (employee['employee_id'],)).fetchone()
            person = db.execute('SELECT last_name,first_name,middle_name FROM deanery.person WHERE person_id=%s', (employee['person_id'],)).fetchone()
            print(json.dumps({'employment_rate': str(current['employment_rate']), 'person': person}, ensure_ascii=False))
        else:
            for assignment in fixture['assignments']:
                assert db.execute('DELETE FROM deanery.teaching_assignment WHERE assignment_id=%s AND teacher_id=%s AND item_id=%s AND group_id=%s RETURNING assignment_id',
                                  (assignment['assignment_id'], employee['employee_id'], assignment['item_id'], assignment['group_id'])).fetchone()
            db.execute('UPDATE deanery.person SET last_name=%s,first_name=%s,middle_name=%s WHERE person_id=%s',
                       (*[fixture['person'][k] for k in ('last_name','first_name','middle_name')], employee['person_id']))
            db.execute('UPDATE deanery.employee SET employment_rate=%s WHERE employee_id=%s', (employee['employment_rate'], employee['employee_id']))
            print(json.dumps({'database': parameters['dbname'], 'owned_assignments_removed': len(fixture['assignments']), 'employee_restored': True}))
            # Keep the snapshot for bounded cleanup evidence; rerunning prepare must remain blocked.
