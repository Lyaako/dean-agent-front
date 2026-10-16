"""Transactional workflow and delayed-order checks on real PostgreSQL."""

from datetime import timedelta
from urllib.parse import quote
from uuid import uuid4

import psycopg

from backend.tests.test_auth import DatabaseHttpCase


class WorkflowTests(DatabaseHttpCase):
    def setUp(self):
        super().setUp()
        self.db.execute("RESET ROLE")
        self.db.execute("SET LOCAL search_path TO pg_catalog,deanery")
        self.db.execute("SET LOCAL TIME ZONE 'Europe/Moscow'")
        self.today = self.db.execute("SELECT CURRENT_DATE AS day").fetchone()["day"]
        self.group = self.db.execute("""SELECT g.group_id,g.name,i.institute_id,i.director_id
            FROM deanery.study_group g JOIN deanery.institute i ON i.institute_id=fn_group_institute(g.group_id)
            WHERE NOT g.is_archived ORDER BY g.group_id LIMIT 1""").fetchone()
        self.other = self.db.execute("""SELECT g.group_id,g.name FROM deanery.study_group g
            WHERE NOT g.is_archived AND fn_group_institute(g.group_id)=%s AND g.group_id<>%s
            ORDER BY g.group_id LIMIT 1""",(self.group["institute_id"],self.group["group_id"])).fetchone()
        self.funding = self.db.execute("SELECT name FROM deanery.funding_type LIMIT 1").fetchone()["name"]
        self.reason = self.db.execute("SELECT name FROM deanery.leave_reason LIMIT 1").fetchone()["name"]
        self.db.execute("SET LOCAL ROLE backend_api")
        self.headers = self.login("vasilyeva")

    def login(self, login):
        response = self.client.post("/api/v1/auth/login",headers=self.origin,
                                    json={"login":login,"password":"only-for-isolated-test"})
        self.assertEqual(response.status_code,200,response.text)
        return {**self.origin,"Authorization":"Bearer " + response.json()["access_token"]}

    def order_fields(self):
        return {"order_number":"WF-"+uuid4().hex[:12],"signed_by":self.group["director_id"]}

    def enroll_body(self):
        return {**self.order_fields(),"last_name":"Тестовый","first_name":"Студент","gender":"M",
                "birth_date":"2005-01-01","group_name":self.group["name"],"funding":self.funding,
                "record_book":"WF"+uuid4().hex[:12]}

    def call(self,name,body,key=None,headers=None,status=200):
        response = self.client.post("/api/v1/workflows/"+name,json=body,
            headers={**(headers or self.headers),"Idempotency-Key":key or str(uuid4())})
        self.assertEqual(response.status_code,status,response.text)
        return response.json()

    def state(self,student_id):
        self.db.execute("RESET ROLE")
        result = self.db.execute("""SELECT s.group_id,st.name AS status FROM deanery.student s
            JOIN deanery.student_status st ON st.status_id=s.status_id WHERE s.student_id=%s""",(student_id,)).fetchone()
        self.db.execute("SET LOCAL ROLE backend_api")
        return result

    def test_six_current_workflows_apply_source_rules_and_audit(self):
        enrolled = self.call("enroll_student",self.enroll_body())
        student = enrolled["student_id"]
        self.assertEqual(enrolled["status"],"applied")
        self.assertEqual(self.state(student)["status"],"Обучается")
        self.call("transfer_student",{**self.order_fields(),"student_id":student,"group_name":self.other["name"]})
        self.assertEqual(self.state(student)["group_id"],self.other["group_id"])
        self.call("grant_academic_leave",{**self.order_fields(),"student_id":student,"reason":self.reason,
            "start":self.today.isoformat(),"end":(self.today+timedelta(days=90)).isoformat()})
        self.assertEqual(self.state(student)["status"],"Академический отпуск")
        # A leave started today cannot end today; return from an existing historical leave.
        self.call('return_from_leave',{**self.order_fields(),'student_id':student},status=409)
        self.db.execute('RESET ROLE')
        returning=self.db.execute("""SELECT s.student_id FROM deanery.student s JOIN deanery.student_status st USING(status_id)
            JOIN deanery.academic_leave l USING(student_id) WHERE st.name='Академический отпуск'
                AND l.return_order_id IS NULL AND l.start_date<CURRENT_DATE
                AND deanery.fn_group_institute(s.group_id)=%s
                AND NOT EXISTS(SELECT FROM deanery.order_student os WHERE os.student_id=s.student_id AND applied_at IS NULL)
            ORDER BY s.student_id LIMIT 1""",(self.group['institute_id'],)).fetchone()
        self.db.execute('SET LOCAL ROLE backend_api')
        self.assertIsNotNone(returning)
        student=returning['student_id']
        self.call("return_from_leave",{**self.order_fields(),"student_id":student})
        self.assertEqual(self.state(student)["status"],"Обучается")
        self.call("expel_student",{**self.order_fields(),"student_id":student,"reason":"Личное заявление тестового студента"})
        self.assertEqual(self.state(student)["status"],"Отчислен")
        self.call("reinstate_student",{**self.order_fields(),"student_id":student,"group_name":self.group["name"]})
        self.assertEqual(self.state(student),{"group_id":self.group["group_id"],"status":"Обучается"})
        self.db.execute("RESET ROLE")
        logs = self.db.execute("SELECT app_user_id FROM deanery.audit_log WHERE table_name='student' AND record_key=%s",
                               (f"student_id={student}",)).fetchall()
        self.assertTrue(logs)
        self.assertTrue(all(r["app_user_id"]==self.user_id for r in logs))

    def test_future_order_replay_body_conflict_and_state(self):
        body = self.enroll_body()
        body["effective_date"]=(self.today+timedelta(days=10)).isoformat()
        key = str(uuid4())
        result = self.call("enroll_student",body,key)
        self.assertEqual(result["status"],"pending")
        self.assertEqual(self.state(result["student_id"])["status"],"Зачислен")
        self.assertEqual(self.call("enroll_student",body,key),result)
        self.call("enroll_student",{**body,"first_name":"Другой"},key,status=409)
        self.db.execute("RESET ROLE")
        job = self.db.execute("SELECT status,owner_user_id,payload FROM agent_backend.job WHERE id=%s",(result["job_id"],)).fetchone()
        self.assertEqual(job["status"],"queued")
        self.assertEqual(job["owner_user_id"],self.user_id)
        self.assertEqual(job["payload"],{"student_id":result["student_id"],"order_id":result["order_id"]})

    def test_empty_date_defaults_today_and_cancel_future_order_through_http(self):
        enrolled=self.call('enroll_student',self.enroll_body()|{'effective_date':''})
        self.assertEqual(enrolled['status'],'applied')
        fields=self.order_fields()
        future=self.call('transfer_student',fields|{'student_id':enrolled['student_id'],'group_name':self.other['name'],
            'effective_date':(self.today+timedelta(days=10)).isoformat()})
        key=str(uuid4())
        path=f"/api/v1/orders/{fields['order_number']}/students/{enrolled['student_id']}/cancel"
        pending=self.client.get('/api/v1/resources/v_pending_orders?student_id='+str(enrolled['student_id']),headers=self.headers)
        self.assertEqual(len(pending.json()['items']),1)
        cancelled=self.client.post(path,headers=self.headers|{'Idempotency-Key':key})
        self.assertEqual(cancelled.status_code,200,cancelled.text)
        self.assertEqual(self.client.post(path,headers=self.headers|{'Idempotency-Key':key}).json(),cancelled.json())
        self.assertEqual(self.client.get('/api/v1/resources/v_pending_orders?student_id='+str(enrolled['student_id']),headers=self.headers).json()['items'],[])
        self.db.execute('RESET ROLE')
        self.assertEqual(self.db.execute('SELECT status FROM agent_backend.job WHERE id=%s',(future['job_id'],)).fetchone()['status'],'cancelled')
        self.db.execute('SET LOCAL ROLE backend_api')

    def test_cancel_accepts_a_real_order_number_with_slash(self):
        enrolled=self.call('enroll_student',self.enroll_body()|{'effective_date':''})
        number=f"WF-{uuid4().hex[:6]}-с/26"
        future=self.call('transfer_student',self.order_fields()|{'order_number':number,'student_id':enrolled['student_id'],
            'group_name':self.other['name'],'effective_date':(self.today+timedelta(days=10)).isoformat()})
        path=f"/api/v1/orders/{quote(number,safe='')}/students/{enrolled['student_id']}/cancel"
        query='?student_id='+str(enrolled['student_id'])
        self.assertEqual([r['order_number'] for r in self.client.get('/api/v1/resources/v_pending_orders'+query,
            headers=self.headers).json()['items']],[number])
        key=str(uuid4())
        cancelled=self.client.post(path,headers=self.headers|{'Idempotency-Key':key})
        self.assertEqual(cancelled.status_code,200,cancelled.text)
        self.assertEqual(cancelled.json()['order_number'],number)
        self.assertEqual(self.client.post(path,headers=self.headers|{'Idempotency-Key':key}).json(),cancelled.json())
        for view in ('v_pending_orders','v_student_orders'):
            rows=self.client.get(f'/api/v1/resources/{view}'+query,headers=self.headers).json()['items']
            self.assertNotIn(number,[r['order_number'] for r in rows])
        self.db.execute('RESET ROLE')
        self.assertEqual(self.db.execute('SELECT status FROM agent_backend.job WHERE id=%s',(future['job_id'],)).fetchone()['status'],'cancelled')
        self.db.execute('SET LOCAL ROLE backend_api')
        enroll_number=f"WF-{uuid4().hex[:6]}-с/26"
        planned=self.call('enroll_student',self.enroll_body()|{'order_number':enroll_number,
            'effective_date':(self.today+timedelta(days=10)).isoformat()})
        refused=self.client.post(f"/api/v1/orders/{quote(enroll_number,safe='')}/students/{planned['student_id']}/cancel",
            headers=self.headers|{'Idempotency-Key':str(uuid4())})
        self.assertEqual(refused.status_code,409,refused.text)
        self.assertEqual(refused.json()['error']['code'],'order_cancel_enrollment')

    def test_role_scope_and_strict_fields(self):
        body = self.enroll_body()
        self.call("enroll_student",body,headers=self.login("ivanov.ks"),status=403)
        self.call("enroll_student",body,headers=self.login("novikov"),status=403)
        self.call("enroll_student",{**body,"signed_by":str(body["signed_by"])},status=422)
        self.call("enroll_student",{**body,"is_admin":True},status=422)
        self.call("enroll_student",{**body,"effective_date":"2020-01-01"},status=422)
        self.call("enroll_student",{**body,"first_name":"x"*100},status=422)
        self.call("unknown_workflow",body,status=404)
        response = self.client.post("/api/v1/workflows/enroll_student",json=body,headers=self.headers)
        self.assertEqual(response.status_code,422)
        self.db.execute("RESET ROLE")
        self.assertEqual(self.db.execute("SELECT count(*) AS n FROM deanery.student WHERE record_book_number=%s",(body["record_book"],)).fetchone()["n"],0)

    def test_enrollment_can_share_only_compatible_order(self):
        body = self.enroll_body()
        first = self.call("enroll_student",body)
        second = self.call("enroll_student",{**self.enroll_body(),"order_number":body["order_number"]})
        self.assertEqual(first["order_id"],second["order_id"])
        self.assertNotEqual(first["student_id"],second["student_id"])
        self.call("enroll_student",{**self.enroll_body(),"order_number":body["order_number"],
                                   "effective_date":(self.today+timedelta(days=1)).isoformat()},status=409)

    def test_job_status_is_scoped_and_omits_internal_state(self):
        result = self.call("enroll_student",{**self.enroll_body(),
            "effective_date":(self.today+timedelta(days=3)).isoformat()})
        path = "/api/v1/jobs/"+result["job_id"]
        response = self.client.get(path,headers=self.headers)
        self.assertEqual(response.status_code,200,response.text)
        job = response.json()
        self.assertEqual(job["status"],"queued")
        self.assertEqual(job["result"],{"order_id":result["order_id"],"student_id":result["student_id"],
                                       "effective_date":result["effective_date"],"applied_at":None,
                                       "cancellation_proposal_id":None,"cancelled_by":None})
        self.assertNotIn("payload",job)
        self.assertNotIn("lease_owner",job)
        self.assertNotIn("audit_ids",job["result"])
        self.assertEqual(self.client.get(path,headers=self.login("ivanov.ks")).status_code,404)
        self.assertEqual(self.client.get(path,headers=self.login("novikov")).status_code,404)
        self.assertEqual(self.client.get("/api/v1/jobs/"+str(uuid4()),headers=self.headers).status_code,404)
        self.assertEqual(self.client.get(path).status_code,401)
        self.db.execute("RESET ROLE")
        self.db.execute("UPDATE deanery.app_user SET is_active=FALSE WHERE user_id=%s",(self.user_id,))
        self.db.execute("SET LOCAL ROLE backend_api")
        self.assertEqual(self.client.get(path,headers=self.headers).status_code,401)

    def due_transfer(self,student):
        self.db.execute("RESET ROLE")
        order = self.db.execute("""SELECT deanery.fn_student_order(%s,'transfer',%s,'Тестовый перевод',
            %s,'Заявление',%s) AS id""",(student,self.order_fields()["order_number"],
                                       self.group["director_id"],self.other["group_id"])).fetchone()["id"]
        self.db.execute("SET LOCAL ROLE backend_api")
        return order

    def test_all_six_future_operations_keep_state_until_due_date(self):
        future = (self.today+timedelta(days=5)).isoformat()
        enrolled = self.call("enroll_student",{**self.enroll_body(),"effective_date":future})
        self.assertEqual(enrolled["status"],"pending")
        for name in ("transfer_student","grant_academic_leave","return_from_leave","expel_student","reinstate_student"):
            with self.subTest(name=name):
                student = self.call("enroll_student",self.enroll_body())["student_id"]
                if name=="return_from_leave":
                    self.call("grant_academic_leave",{**self.order_fields(),"student_id":student,"reason":self.reason,
                        "start":self.today.isoformat(),"end":(self.today+timedelta(days=90)).isoformat()})
                if name=="reinstate_student":
                    self.call("expel_student",{**self.order_fields(),"student_id":student,"reason":"Заявление"})
                before = self.state(student)
                body = {**self.order_fields(),"student_id":student,"effective_date":future}
                if name in ("transfer_student","reinstate_student"):
                    body["group_name"]=self.other["name"]
                if name=="expel_student":
                    body["reason"]="Заявление"
                if name=="grant_academic_leave":
                    body.pop("effective_date")
                    body.update(reason=self.reason,start=future,end=(self.today+timedelta(days=90)).isoformat())
                result = self.call(name,body)
                self.assertEqual(result["status"],"pending")
                self.assertEqual(result["effective_date"],future)
                self.assertEqual(self.state(student),before)

    def test_worker_recovers_lease_and_never_applies_same_order_twice(self):
        student = self.call("enroll_student",self.enroll_body())["student_id"]
        order = self.due_transfer(student)
        worker, replacement = uuid4(),uuid4()
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            with self.db.transaction():
                self.db.execute("SELECT backend_api.claim_order_job(%s)",(worker,))
        self.db.execute("SET LOCAL ROLE backend_worker")
        job = self.db.execute("SELECT backend_api.claim_order_job(%s) AS id",(worker,)).fetchone()["id"]
        self.assertIsNotNone(job)
        self.db.execute("RESET ROLE")
        target = self.db.execute("SELECT payload FROM agent_backend.job WHERE id=%s",(job,)).fetchone()["payload"]
        self.assertEqual(target,{"order_id":order,"student_id":student})
        self.db.execute("UPDATE agent_backend.job SET lease_until=now()-INTERVAL '1 second' WHERE id=%s",(job,))
        self.db.execute("SET LOCAL ROLE backend_worker")
        self.assertEqual(self.db.execute("SELECT backend_api.claim_order_job(%s) AS id",(replacement,)).fetchone()["id"],job)
        self.db.execute('SET LOCAL ROLE deanery_agent')
        with self.assertRaises(psycopg.errors.SerializationFailure):
            with self.db.transaction():
                self.db.execute("SELECT backend_api.perform_order_job(%s,%s)",(job,worker))
        result = self.db.execute("SELECT backend_api.perform_order_job(%s,%s) AS r",(job,replacement)).fetchone()["r"]
        self.assertEqual(result["status"],"succeeded")
        self.assertEqual(self.state(student)["group_id"],self.other["group_id"])
        self.db.execute("RESET ROLE")
        tracked = self.db.execute("SELECT attempts,result FROM agent_backend.job WHERE id=%s",(job,)).fetchone()
        self.assertEqual(tracked["attempts"],2)
        audit_ids = tracked["result"]["audit_ids"]
        self.assertEqual(len(audit_ids),2)
        self.assertTrue(all(row["app_user_id"] is None for row in self.db.execute(
            "SELECT app_user_id FROM deanery.audit_log WHERE audit_id=ANY(%s)",(audit_ids,))))
        audit_count = self.db.execute("SELECT count(*) AS n FROM deanery.audit_log").fetchone()["n"]
        self.db.execute("SET LOCAL ROLE deanery_agent")
        self.db.execute("SELECT backend_api.perform_order_job(%s,%s)",(job,replacement))
        self.db.execute("RESET ROLE")
        self.assertEqual(self.db.execute("SELECT count(*) AS n FROM deanery.audit_log").fetchone()["n"],audit_count)

    def test_new_command_applies_due_order_with_separate_system_audit(self):
        student = self.call("enroll_student",self.enroll_body())["student_id"]
        old_order = self.due_transfer(student)
        self.call("expel_student",{**self.order_fields(),"student_id":student,"reason":"Заявление после перевода"})
        self.assertEqual(self.state(student),{"group_id":self.other["group_id"],"status":"Отчислен"})
        self.db.execute("RESET ROLE")
        job = self.db.execute("SELECT result FROM agent_backend.job WHERE payload->>'order_id'=%s",(str(old_order),)).fetchone()
        logs = self.db.execute("SELECT app_user_id FROM deanery.audit_log WHERE audit_id=ANY(%s)",
                               (job["result"]["audit_ids"],)).fetchall()
        self.assertTrue(logs)
        self.assertTrue(all(row["app_user_id"] is None for row in logs))
        latest = self.db.execute("SELECT app_user_id FROM deanery.audit_log WHERE table_name='student' AND record_key=%s ORDER BY audit_id DESC LIMIT 1",
                                 (f"student_id={student}",)).fetchone()
        self.assertEqual(latest["app_user_id"],self.user_id)

    def test_worker_domain_failure_is_visible_and_external_apply_is_reconciled(self):
        student = self.call("enroll_student",self.enroll_body())["student_id"]
        order = self.due_transfer(student)
        worker = uuid4()
        self.db.execute("SET LOCAL ROLE backend_worker")
        job = self.db.execute("SELECT backend_api.claim_order_job(%s) AS id",(worker,)).fetchone()["id"]
        self.db.execute("RESET ROLE")
        # Inject a constraint failure only inside this rolled-back test transaction.
        self.db.execute("""CREATE FUNCTION backend_api.test_order_failure() RETURNS TRIGGER LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'test constraint' USING ERRCODE='23514'; END $$""")
        self.db.execute("""CREATE TRIGGER test_order_failure BEFORE UPDATE ON deanery.student
                           FOR EACH ROW EXECUTE FUNCTION backend_api.test_order_failure()""")
        self.db.execute("SET LOCAL ROLE deanery_agent")
        result = self.db.execute("SELECT backend_api.perform_order_job(%s,%s) AS r",(job,worker)).fetchone()["r"]
        self.assertEqual(result["status"],"failed")
        self.assertEqual(result["error_code"],"23514")
        self.assertEqual(self.state(student)["group_id"],self.group["group_id"])
        self.db.execute("RESET ROLE")
        self.db.execute("DROP TRIGGER test_order_failure ON deanery.student")
        self.db.execute("SELECT deanery.fn_apply_order(%s,%s)",(order,student))
        self.db.execute("SET LOCAL ROLE backend_worker")
        self.db.execute("SELECT backend_api.claim_order_job(%s)",(worker,))
        self.db.execute("RESET ROLE")
        self.assertEqual(self.db.execute("SELECT status FROM agent_backend.job WHERE id=%s",(job,)).fetchone()["status"],"succeeded")
