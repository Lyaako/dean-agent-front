"""Private command previews use the same domain rules without committing effects."""

from datetime import timedelta
import os
import unittest
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


@unittest.skipUnless(os.environ.get("TEST_DATABASE_DSN"), "isolated PostgreSQL required")
class CommandTests(unittest.TestCase):
    def setUp(self):
        self.db = psycopg.connect(os.environ["TEST_DATABASE_DSN"], row_factory=dict_row)
        self.addCleanup(self.db.close)
        self.db.execute("SET LOCAL search_path=pg_catalog,deanery")
        self.db.execute("SET LOCAL TIME ZONE 'Europe/Moscow'")
        self.users = {r["login"]:r["user_id"] for r in self.db.execute("SELECT login,user_id FROM app_user")}
        self.admin = self.users["vasilyeva"]
        self.staff = self.users["kuznetsova"]
        self.teacher = self.users["novikov"]
        self.student = self.users["ivanov.ks"]
        self.request = self.agent_request(self.admin)

    def agent_request(self, user):
        return self.db.execute("INSERT INTO agent_request(user_id,request_text) VALUES(%s,'isolated command test') RETURNING agent_request_id",(user,)).fetchone()["agent_request_id"]

    def preview(self, command, author=None, request=None):
        return self.db.execute("SELECT backend_api.command_preview(%s,%s,%s) AS r",
            (Jsonb(command),author or self.admin,request or self.request)).fetchone()["r"]

    def execute(self, command, author=None, actor=None, request=None):
        return self.db.execute("SELECT backend_api.command_execute(%s,%s,%s,%s,%s) AS r",
            (Jsonb(command),author or self.admin,actor or self.admin,request or self.request,uuid4())).fetchone()["r"]

    def command(self, resource, fields, key=None, operation="update"):
        return {"version":1,"kind":"record_change","resource":resource,"operation":operation,"key":key or {},"fields":fields}

    def counts(self):
        return self.db.execute("SELECT (SELECT count(*) FROM audit_log) AS audit,(SELECT count(*) FROM student) AS student,(SELECT count(*) FROM agent_backend.job) AS jobs,(SELECT count(*) FROM agent_backend.idempotency_record) AS idem").fetchone()

    def enrollment(self, future=False):
        group = self.db.execute("SELECT g.name,i.director_id FROM study_group g JOIN institute i ON i.institute_id=fn_group_institute(g.group_id) WHERE NOT g.is_archived ORDER BY g.group_id LIMIT 1").fetchone()
        fields = {"last_name":"Preview","first_name":"Student","gender":"M","birth_date":"2005-01-01",
            "group_name":group["name"],"signed_by":group["director_id"],"funding":self.db.execute("SELECT name FROM funding_type LIMIT 1").fetchone()["name"],
            "order_number":"PR-"+uuid4().hex[:12],"record_book":"PR"+uuid4().hex[:12]}
        if future:
            fields["effective_date"]=(self.db.execute("SELECT CURRENT_DATE AS day").fetchone()["day"]+timedelta(days=5)).isoformat()
        return {"version":1,"kind":"workflow","name":"enroll_student","fields":fields}

    def test_workflow_preview_rolls_back_all_effects_and_normalizes_generated_ids(self):
        command = self.enrollment(future=True)
        before = self.counts()
        result = self.preview(command)
        self.assertEqual(self.counts(),before)
        preview = result["preview"]
        self.assertIsNone(preview["after"]["student_id"])
        self.assertIsNone(preview["after"]["person_id"])
        active = self.db.execute("SELECT status_id FROM student_status WHERE name='Обучается'").fetchone()["status_id"]
        self.assertEqual(preview["after"]["status_id"],active)
        self.assertTrue(preview["effects"])
        self.assertIn("ожидаемое",preview["note"])
        for effect in preview["effects"]:
            for name,change in effect["changes"].items():
                if name in ("student_id","person_id","order_id"):
                    self.assertIsNone(change["after"])
        saved = self.execute(result["command"])
        self.assertEqual(saved["status"],"pending")
        status = self.db.execute("SELECT st.name FROM student s JOIN student_status st ON st.status_id=s.status_id WHERE student_id=%s",(saved["student_id"],)).fetchone()["name"]
        self.assertEqual(status,"Зачислен")

    def test_teacher_topic_only_and_audit_records_decider_and_request(self):
        work = self.db.execute("SELECT w.* FROM academic_work w JOIN employee e ON e.employee_id=w.supervisor_id JOIN app_user u ON u.person_id=e.person_id WHERE u.user_id=%s LIMIT 1",(self.teacher,)).fetchone()
        self.assertIsNotNone(work)
        req = self.agent_request(self.teacher)
        command = self.command("academic_work",{"topic":"Новая тема через агента"},{"work_id":work["work_id"]})
        result = self.preview(command,self.teacher,req)
        self.assertEqual(self.db.execute("SELECT topic FROM academic_work WHERE work_id=%s",(work["work_id"],)).fetchone()["topic"],work["topic"])
        self.execute(result["command"],self.teacher,self.admin,req)
        audit = self.db.execute("SELECT app_user_id,agent_request_id FROM audit_log WHERE table_name='academic_work' AND record_key=%s ORDER BY audit_id DESC LIMIT 1",(f"work_id={work['work_id']}",)).fetchone()
        self.assertEqual(audit,{"app_user_id":self.admin,"agent_request_id":req})
        with self.assertRaises(psycopg.errors.InsufficientPrivilege), self.db.transaction():
            self.preview({**command,"fields":{"reviewer_id":work["reviewer_id"]}},self.teacher,req)
        with self.assertRaises(psycopg.errors.InsufficientPrivilege), self.db.transaction():
            self.execute(command,self.teacher,self.teacher,req)
        with self.assertRaises(psycopg.errors.InsufficientPrivilege), self.db.transaction():
            self.preview(command,self.teacher,self.request)

    def test_student_request_normalized_and_delete_not_agent_authorized(self):
        req = self.agent_request(self.student)
        document_type = self.db.execute("SELECT document_type_id FROM document_type LIMIT 1").fetchone()["document_type_id"]
        command = self.command("document_request",{"document_type_id":document_type,"copies":1,"purpose":"По месту требования"},operation="create")
        result = self.preview(command,self.student,req)
        own = self.db.execute("SELECT student_id FROM backend_api.account_snapshot(%s)",(self.student,)).fetchone()["student_id"]
        self.assertEqual(result["command"]["fields"]["student_id"],own)
        row = self.execute(result["command"],self.student,self.admin,req)
        delete = self.command("document_request",{},{"request_id":row["request_id"]},"delete")
        with self.assertRaises(psycopg.errors.InsufficientPrivilege), self.db.transaction():
            self.preview(delete,self.student,req)

    def test_snapshot_changes_for_dependency_and_has_no_raw_person_data(self):
        row = self.db.execute("SELECT w.* FROM academic_work w LIMIT 1").fetchone()
        command = self.command("academic_work",{"topic":"Snapshot test"},{"work_id":row["work_id"]})
        result = self.preview(command)
        snapshot = result["snapshot"]
        self.assertTrue(any(k.startswith("student:") for k in snapshot))
        self.assertTrue(all(isinstance(v,str) and len(v)==64 for v in snapshot.values()))
        self.db.execute("UPDATE academic_work SET topic=topic || ' changed' WHERE work_id=%s",(row["work_id"],))
        changed = self.db.execute("SELECT backend_api.command_snapshot(%s,%s) AS r",(Jsonb(command),self.admin)).fetchone()["r"]
        self.assertNotEqual(changed,snapshot)

    def test_staff_create_group_deferred_constraint_and_private_grants(self):
        curriculum = self.db.execute("SELECT g.curriculum_id FROM study_group g JOIN backend_api.allowed_groups(%s) a USING(group_id) LIMIT 1",(self.staff,)).fetchone()["curriculum_id"]
        prefix = self.db.execute("SELECT fn_group_prefix(%s) AS prefix",(curriculum,)).fetchone()["prefix"]
        existing = {r["name"] for r in self.db.execute("SELECT name FROM study_group")}
        name = next(prefix+str(n) for n in range(99,49,-1) if prefix+str(n) not in existing)
        command = self.command("study_group",{"name":name,"curriculum_id":curriculum},operation="create")
        req = self.agent_request(self.staff)
        result = self.preview(command,self.staff,req)
        self.assertIsNone(result["preview"]["after"]["group_id"])
        self.db.execute("CREATE FUNCTION backend_api.test_preview_constraint() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deferred failure' USING ERRCODE='23514'; END $$")
        self.db.execute("CREATE CONSTRAINT TRIGGER test_preview_constraint AFTER INSERT ON deanery.study_group DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION backend_api.test_preview_constraint()")
        with self.assertRaises(psycopg.errors.CheckViolation), self.db.transaction():
            self.preview(command,self.staff,req)
        self.db.execute("DROP TRIGGER test_preview_constraint ON deanery.study_group")
        self.db.execute("SET LOCAL ROLE backend_api")
        with self.assertRaises(psycopg.errors.InsufficientPrivilege), self.db.transaction():
            self.preview(command,self.staff,req)

    def test_future_transfer_preview_intended_group_and_current_state_unchanged(self):
        enrolled = self.execute(self.preview(self.enrollment())["command"])
        student = enrolled["student_id"]
        group = self.db.execute("SELECT g.*,i.director_id FROM study_group g JOIN institute i ON i.institute_id=fn_group_institute(g.group_id) JOIN student s ON fn_group_institute(s.group_id)=i.institute_id WHERE s.student_id=%s AND g.group_id<>s.group_id AND NOT g.is_archived LIMIT 1",(student,)).fetchone()
        fields = {"student_id":student,"group_name":group["name"],"signed_by":group["director_id"],"order_number":"PR-"+uuid4().hex[:12],
            "effective_date":(self.db.execute("SELECT CURRENT_DATE AS day").fetchone()["day"]+timedelta(days=5)).isoformat()}
        command = {"version":1,"kind":"workflow","name":"transfer_student","fields":fields}
        before = self.db.execute("SELECT group_id FROM student WHERE student_id=%s",(student,)).fetchone()["group_id"]
        self.db.execute("UPDATE study_group SET headman_id=%s WHERE group_id=%s",(student,before))
        result = self.preview(command)
        self.assertEqual(result["preview"]["after"]["group_id"],group["group_id"])
        self.assertEqual(result["preview"]["before"]["group_id"],before)
        self.assertEqual(self.db.execute("SELECT group_id FROM student WHERE student_id=%s",(student,)).fetchone()["group_id"],before)
        self.assertTrue(any(e["table"]=="study_group" and e.get("phase")=="future" and e["changes"]["headman_id"]["after"] is None for e in result["preview"]["effects"]))
