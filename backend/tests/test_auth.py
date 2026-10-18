"""Exercise the real auth endpoints against the isolated seeded PostgreSQL."""

import os
import json
import re
from pathlib import Path
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import psycopg
from psycopg.rows import dict_row

from backend.app import app, db_connection, COOKIE
from backend.auth import hasher


@unittest.skipUnless(os.environ.get("TEST_DATABASE_DSN"), "TEST_DATABASE_DSN is required for auth integration")
class DatabaseHttpCase(unittest.TestCase):
    def setUp(self):
        self.db = psycopg.connect(os.environ["TEST_DATABASE_DSN"], row_factory=dict_row)
        self.addCleanup(self.db.close)
        self.user_id = self.db.execute("SELECT user_id FROM deanery.app_user WHERE login='vasilyeva'").fetchone()["user_id"]
        self.db.execute("UPDATE deanery.app_user SET password_hash=%s WHERE user_id=%s", (hasher.hash("only-for-isolated-test"), self.user_id))
        self.db.execute("UPDATE deanery.app_user SET password_hash=%s WHERE login IN ('smirnov','kuznetsova','novikov','ivanov.ks')", (hasher.hash("only-for-isolated-test"),))
        self.db.execute("SET LOCAL ROLE backend_api")
        def test_db():
            with self.db.transaction():
                yield self.db
        app.dependency_overrides[db_connection] = test_db
        self.addCleanup(app.dependency_overrides.clear)
        env = patch.dict(os.environ, {"DEANERY_ORIGIN": "http://testserver", "DEANERY_DEV_INSECURE_COOKIE": "1"})
        env.start()
        self.addCleanup(env.stop)
        self.client = TestClient(app, base_url="http://testserver")
        self.addCleanup(self.client.close)
        self.origin = {"Origin": "http://testserver"}


class AuthHttpTests(DatabaseHttpCase):
    def test_login_refresh_replay_revokes_family_and_other_access_remains_until_replay(self):
        login = self.client.post("/api/v1/auth/login", json={"login":"vasilyeva","password":"only-for-isolated-test"}, headers=self.origin)
        self.assertEqual(login.status_code, 200, login.text)
        first_access = login.json()["access_token"]
        csrf = login.json()["csrf_token"]
        first_refresh = login.cookies[COOKIE]
        me = self.client.get("/api/v1/auth/me", headers={"Authorization":f"Bearer {first_access}"})
        self.assertEqual(me.status_code, 200, me.text)
        self.assertEqual(me.json()["roles"], ["admin"])
        self.assertTrue(me.json()["institute_ids"])
        refreshed = self.client.post("/api/v1/auth/refresh", json={}, headers={**self.origin,"X-CSRF-Token":csrf})
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        second_access = refreshed.json()["access_token"]
        self.assertEqual(self.client.get("/api/v1/auth/me", headers={"Authorization":f"Bearer {first_access}"}).status_code, 200)
        self.assertEqual(self.client.get("/api/v1/auth/me", headers={"Authorization":f"Bearer {second_access}"}).status_code, 200)
        replay = self.client.post("/api/v1/auth/refresh", json={}, headers={**self.origin,"X-CSRF-Token":csrf}, cookies={COOKIE:first_refresh})
        self.assertEqual(replay.status_code, 401, replay.text)
        self.assertEqual(self.client.get("/api/v1/auth/me", headers={"Authorization":f"Bearer {second_access}"}).status_code, 401)

    def test_origin_csrf_logout_and_invalid_credentials(self):
        self.assertEqual(self.client.post("/api/v1/auth/login", json={"login":"vasilyeva","password":"wrong"}, headers=self.origin).status_code, 401)
        self.assertEqual(self.client.post("/api/v1/auth/login", json={"login":"vasilyeva","password":"only-for-isolated-test"}, headers={"Origin":"https://other.example"}).status_code, 403)
        login = self.client.post("/api/v1/auth/login", json={"login":"vasilyeva","password":"only-for-isolated-test"}, headers=self.origin)
        self.assertEqual(login.status_code, 200, login.text)
        access = login.json()["access_token"]
        self.assertEqual(self.client.post("/api/v1/auth/refresh", json={}, headers={**self.origin,"X-CSRF-Token":"wrong"}).status_code, 403)
        self.assertEqual(self.client.post("/api/v1/auth/logout", headers={**self.origin,"Authorization":f"Bearer {access}"}).status_code, 204)
        self.assertEqual(self.client.get("/api/v1/auth/me", headers={"Authorization":f"Bearer {access}"}).status_code, 401)

    def test_scoped_sql_reads_require_live_token_and_limit_each_role(self):
        def access(name):
            response = self.client.post("/api/v1/auth/login", json={"login":name,"password":"only-for-isolated-test"}, headers=self.origin)
            self.assertEqual(response.status_code, 200, response.text)
            return response.json()["access_token"]

        def rows(resource, token):
            return [json.loads(row["visible_rows"]) for row in self.db.execute(
                "SELECT visible_rows FROM backend_api.visible_rows(%s,%s)", (resource,token),
            ).fetchall()]

        admin, director, staff, teacher, student = map(access, ("vasilyeva","smirnov","kuznetsova","novikov","ivanov.ks"))
        self.assertGreater(len(rows("student", admin)), 1)
        own = rows("student", student)
        self.assertEqual(len(own), 1)
        self.assertEqual(rows("document_request", student)[0]["student_id"], own[0]["student_id"])
        self.assertEqual(rows("employee", student), [])
        self.assertEqual(rows("organization_contact", student), [])
        self.assertGreater(len(rows("organization_contact", staff)), 0)
        self.assertGreater(len(rows("organization_contact", director)), 0)
        self.assertEqual(rows("organization_contact", teacher), [])
        with self.assertRaises(psycopg.errors.InsufficientPrivilege),self.db.transaction():
            rows('student','forged-access-token')
        self.assertLess(len(rows("student", teacher)), len(rows("student", admin)))
        self.assertLessEqual(len(rows("student", staff)), len(rows("student", admin)))
        self.assertTrue(all("funding_type_id" not in row for row in rows("student", teacher)))
        self.assertTrue(all(not {"birth_date", "phone", "email", "gender", "funding"}.intersection(row)
                            for row in rows("v_students", teacher)))
        self.assertTrue(all("passport_number" not in row for row in rows("person", admin)))
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            with self.db.transaction():
                self.db.execute("SELECT * FROM deanery.v_students")

    def test_http_schema_and_resources_match_pinned_frontend_without_secret_fields(self):
        login = self.client.post("/api/v1/auth/login", json={"login":"vasilyeva","password":"only-for-isolated-test"}, headers=self.origin)
        self.assertEqual(login.status_code, 200, login.text)
        headers = {"Authorization":"Bearer " + login.json()["access_token"]}
        response = self.client.get("/api/v1/schema", headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        schema = response.json()["resources"]
        for name,key in (("v_academic_works","work_id"),("v_practice","placement_id"),
                         ("v_schedule_hours","assignment_id"),("v_curriculum","item_id")):
            self.assertIn(key,schema[name]["read_fields"])
        self.assertNotIn("passport_number",schema["person"]["fields"])
        self.assertEqual(schema["student"]["fields"]["funding_type_id"]["relation"]["table"],"funding_type")
        page = self.client.get("/api/v1/resources/v_student_summary?limit=2&offset=0",headers=headers)
        self.assertEqual(page.status_code,200,page.text)
        self.assertEqual(len(page.json()["items"]),2)
        self.assertTrue(page.json()["has_more"])
        self.assertEqual(self.client.get("/api/v1/resources/v_student_summary?bad_column=x",headers=headers).status_code,422)
        self.assertEqual(self.client.get("/api/v1/resources/app_user",headers=headers).status_code,200)
        student_login = self.client.post("/api/v1/auth/login", json={"login":"ivanov.ks","password":"only-for-isolated-test"}, headers=self.origin)
        student_headers = {"Authorization":"Bearer " + student_login.json()["access_token"]}
        self.assertEqual(len(self.client.get("/api/v1/resources/v_student_summary",headers=student_headers).json()["items"]),1)
        self.assertEqual(self.client.get("/api/v1/resources/academic_order",headers=student_headers).status_code,404)
        teacher_login = self.client.post("/api/v1/auth/login", json={"login":"novikov","password":"only-for-isolated-test"}, headers=self.origin)
        teacher_headers = {"Authorization":"Bearer " + teacher_login.json()["access_token"]}
        teacher_schema = self.client.get("/api/v1/schema", headers=teacher_headers).json()["resources"]
        self.assertNotIn("phone", teacher_schema["v_students"]["read_fields"])
        self.assertNotIn("email", teacher_schema["v_students"]["read_fields"])

    def test_every_pinned_data_tab_and_explicit_lookup_loads_through_http(self):
        fixture = json.loads((Path(__file__).parent / "fixtures/frontend_contract.json").read_text(encoding="utf-8"))
        login = self.client.post("/api/v1/auth/login",json={"login":"vasilyeva","password":"only-for-isolated-test"},headers=self.origin)
        self.assertEqual(login.status_code,200,login.text)
        headers = {"Authorization":"Bearer " + login.json()["access_token"]}
        schema = self.client.get("/api/v1/schema",headers=headers).json()["resources"]
        for screen in fixture["screens"]:
            with self.subTest(screen=screen["id"]):
                self.assertTrue(set(screen["required_view_fields"]) <= set(schema[screen["view"]]["read_fields"]))
                response = self.client.get(f"/api/v1/resources/{screen['view']}?limit=2",headers=headers)
                self.assertEqual(response.status_code,200,response.text)
                self.assertLessEqual(len(response.json()["items"]),2)
        for resource in fixture["lookup_fields"]:
            with self.subTest(lookup=resource):
                response = self.client.get(f"/api/v1/resources/{resource}?limit=2",headers=headers)
                self.assertEqual(response.status_code,200,response.text)
        for resource in fixture["supporting_reads"]:
            with self.subTest(support=resource):
                response = self.client.get(f"/api/v1/resources/{resource}?limit=2",headers=headers)
                self.assertEqual(response.status_code,200,response.text)

    def test_student_request_form_is_server_owned_and_mutations_obey_scope(self):
        def login(name):
            response = self.client.post("/api/v1/auth/login",json={"login":name,"password":"only-for-isolated-test"},headers=self.origin)
            self.assertEqual(response.status_code,200,response.text)
            return {**self.origin,"Authorization":"Bearer " + response.json()["access_token"]}

        student = login("ivanov.ks")
        teacher = login("novikov")
        admin = login("vasilyeva")
        own_id = self.client.get("/api/v1/auth/me",headers=student).json()["student_id"]
        doc_type = self.client.get("/api/v1/resources/document_type?limit=1",headers=student).json()["items"][0]["document_type_id"]
        body = {"student_id":own_id,"document_type_id":doc_type,"copies":2,"purpose":"Для проверки"}
        created = self.client.post("/api/v1/resources/document_request",json=body,headers=student)
        self.assertEqual(created.status_code,200,created.text)
        row = created.json()
        self.assertEqual(row["student_id"],own_id)
        self.assertIsNone(row["processed_by_id"])
        key = f"request_id={row['request_id']}"
        self.assertEqual(self.client.patch(f"/api/v1/resources/document_request?{key}",json={"copies":3},headers=student).json()["copies"],3)
        self.assertEqual(self.client.patch(f"/api/v1/resources/document_request?{key}",json={"request_status_id":2},headers=student).status_code,422)
        self.assertEqual(self.client.post("/api/v1/resources/document_request",json={**body,"student_id":own_id+1},headers=student).status_code,403)
        self.assertEqual(self.client.post("/api/v1/resources/document_request",json=body,headers=teacher).status_code,404)
        self.assertEqual(self.client.delete(f"/api/v1/resources/document_request?{key}",headers=student).status_code,403)
        self.assertEqual(self.client.delete(f"/api/v1/resources/document_request?{key}",headers=admin).status_code,200)
        self.assertEqual(self.client.get(f"/api/v1/resources/document_request?{key}",headers=student).json()["items"],[])
        person_id = self.client.get("/api/v1/auth/me",headers=admin).json()["person_id"]
        updated = self.client.patch(f"/api/v1/resources/person?person_id={person_id}",json={"middle_name":"Проверка"},headers=admin)
        self.assertEqual(updated.status_code,200,updated.text)
        self.assertEqual(updated.json()["middle_name"],"Проверка")
        self.assertEqual(set(updated.json()),{"person_id","last_name","first_name","middle_name"})
        self.assertEqual(self.client.patch(f"/api/v1/resources/person?person_id={person_id}",json={"passport_number":"123456"},headers=admin).status_code,422)
        employee_id = self.client.get("/api/v1/resources/employee?person_id=" + str(person_id),headers=admin).json()["items"][0]["employee_id"]
        self.assertEqual(self.client.delete(f"/api/v1/resources/employee?employee_id={employee_id}",headers=admin).status_code,403)
        student_person = self.client.get("/api/v1/resources/student?student_id=" + str(own_id),headers=admin).json()["items"][0]["person_id"]
        self.assertEqual(self.client.patch(f"/api/v1/resources/person?person_id={student_person}",json={"middle_name":"Нельзя"},headers=admin).status_code,403)

    def test_group_work_practice_and_schedule_form_buttons(self):
        response = self.client.post("/api/v1/auth/login",json={"login":"vasilyeva","password":"only-for-isolated-test"},headers=self.origin)
        headers = {**self.origin,"Authorization":"Bearer " + response.json()["access_token"]}
        def first(name):
            page = self.client.get(f"/api/v1/resources/{name}?limit=1",headers=headers)
            self.assertEqual(page.status_code,200,page.text)
            return page.json()["items"][0]

        group = first("study_group")
        names = {r["name"] for r in self.client.get("/api/v1/resources/study_group?limit=500",headers=headers).json()["items"]}
        prefix = re.match(r"^(.+-)[0-9]{2}",group["name"]).group(1)
        new_name = next(prefix + str(n).zfill(2) for n in range(99,49,-1) if prefix + str(n).zfill(2) not in names)
        created = self.client.post("/api/v1/resources/study_group",json={"name":new_name,"curriculum_id":group["curriculum_id"]},headers=headers)
        self.assertEqual(created.status_code,200,created.text)
        group_id = created.json()["group_id"]
        renamed = self.client.patch(f"/api/v1/resources/study_group?group_id={group_id}",json={"is_archived":True},headers=headers)
        self.assertEqual(renamed.status_code,200,renamed.text)
        self.assertEqual(self.client.delete(f"/api/v1/resources/study_group?group_id={group_id}",headers=headers).status_code,200)

        work = first("academic_work")
        new_topic = work["topic"] + " (проверка)"
        changed = self.client.patch(f"/api/v1/resources/academic_work?work_id={work['work_id']}",json={"topic":new_topic},headers=headers)
        self.assertEqual(changed.status_code,200,changed.text)
        self.assertEqual(changed.json()["topic"],new_topic)
        self.assertEqual(self.client.patch(f"/api/v1/resources/academic_work?work_id={work['work_id']}",json={"student_id":work["student_id"]},headers=headers).status_code,422)

        placement = first("practice_placement")
        shifted = self.client.patch(f"/api/v1/resources/practice_placement?placement_id={placement['placement_id']}",json={"end_date":placement["end_date"]},headers=headers)
        self.assertEqual(shifted.status_code,200,shifted.text)
        self.assertEqual(shifted.json()["placement_id"],placement["placement_id"])

        slot = first("schedule_slot")
        duplicate = {key:value for key,value in slot.items() if key!="slot_id"}
        conflict = self.client.post("/api/v1/resources/schedule_slot",json=duplicate,headers=headers)
        self.assertEqual(conflict.status_code,409,conflict.text)
        later_pair = {**duplicate,"pair_number":6}
        scheduled = self.client.post("/api/v1/resources/schedule_slot",json=later_pair,headers=headers)
        self.assertEqual(scheduled.status_code,200,scheduled.text)
        self.assertEqual(self.client.delete(f"/api/v1/resources/schedule_slot?slot_id={scheduled.json()['slot_id']}",headers=headers).status_code,200)

    def test_staff_can_skip_intermediate_request_status_but_final_is_immutable(self):
        response = self.client.post("/api/v1/auth/login",json={"login":"vasilyeva","password":"only-for-isolated-test"},headers=self.origin)
        headers = {**self.origin,"Authorization":"Bearer " + response.json()["access_token"]}
        statuses = {r["name"]:r["request_status_id"] for r in self.client.get("/api/v1/resources/request_status",headers=headers).json()["items"]}
        student = self.client.get("/api/v1/resources/student?limit=1",headers=headers).json()["items"][0]
        document_type = self.client.get("/api/v1/resources/document_type?limit=1",headers=headers).json()["items"][0]
        created = self.client.post("/api/v1/resources/document_request",headers=headers,json={
            "student_id":student["student_id"],"document_type_id":document_type["document_type_id"],
            "request_status_id":statuses["Новая"],"copies":1,
        })
        self.assertEqual(created.status_code,200,created.text)
        path = f"/api/v1/resources/document_request?request_id={created.json()['request_id']}"
        ready = self.client.patch(path,headers=headers,json={"request_status_id":statuses["Готова к выдаче"]})
        self.assertEqual(ready.status_code,200,ready.text)
        done = self.client.patch(path,headers=headers,json={"request_status_id":statuses["Выдана"]})
        self.assertEqual(done.status_code,200,done.text)
        self.assertIsNotNone(done.json()["completed_at"])
        self.assertEqual(self.client.patch(path,headers=headers,json={"copies":2}).status_code,200)
        final=self.client.patch(path,headers=headers,json={'request_status_id':statuses['Новая']})
        self.assertEqual(final.status_code,409,final.text)
        self.assertEqual(final.json()['error']['code'],'request_final')
        self.assertEqual(self.client.delete(path,headers=headers).status_code,200)

    def test_olap_eight_modes_and_original_metric_definitions(self):
        def login(name):
            response = self.client.post("/api/v1/auth/login",json={"login":name,"password":"only-for-isolated-test"},headers=self.origin)
            self.assertEqual(response.status_code,200,response.text)
            return {"Authorization":"Bearer " + response.json()["access_token"]}
        admin, staff, teacher, student = map(login,("vasilyeva","kuznetsova","novikov","ivanov.ks"))
        base = self.client.get("/api/v1/olap?mode=rollup-group",headers=admin)
        self.assertEqual(base.status_code,200,base.text)
        summary = base.json()
        self.assertGreater(len(summary["rows"]),0)
        self.assertEqual(summary["total"]["results"],sum(r["results"] for r in summary["rows"]))
        self.assertEqual(summary["total"]["debts"],sum(r["debts"] for r in summary["rows"]))
        self.db.execute("RESET ROLE")
        self.db.execute("SET LOCAL search_path TO pg_catalog, deanery")
        result = self.db.execute(
            """SELECT count(*) AS n,round(avg(lr.points)::numeric,2)::text AS avg,
                      count(*) FILTER (WHERE ct.is_graded AND deanery.fn_mark(lr.points)=5) AS excellent
               FROM deanery.v_last_result lr JOIN deanery.curriculum_item ci ON ci.item_id=lr.item_id
               JOIN deanery.control_type ct ON ct.control_type_id=ci.control_type_id
               WHERE lr.stage='final'""",
        ).fetchone()
        debts = self.db.execute("SELECT count(*) AS n FROM deanery.v_debtors").fetchone()["n"]
        self.db.execute("SET LOCAL ROLE backend_api")
        self.assertEqual(summary["total"],{"avg":result["avg"],"results":result["n"],
                                           "excellent":result["excellent"],"debts":debts})
        group = summary["rows"][0]["group_id"]
        by_discipline = self.client.get("/api/v1/olap?mode=rollup-discipline",headers=admin)
        self.assertEqual(by_discipline.status_code,200,by_discipline.text)
        discipline = by_discipline.json()["rows"][0]["discipline_id"]
        for mode, query in (
            ("rollup-semester",""), ("slice-group",f"&group_id={group}"),
            ("slice-discipline",f"&discipline_id={discipline}"),
            ("dice",f"&group_id={group}&discipline_id={discipline}"),
            ("drilldown-group",f"&group_id={group}"),
            ("cross-group-semester",""),
        ):
            with self.subTest(mode=mode):
                response = self.client.get(f"/api/v1/olap?mode={mode}{query}",headers=admin)
                self.assertEqual(response.status_code,200,response.text)
                self.assertEqual(response.json()["mode"],mode)
                self.assertIn("rows",response.json())
        self.assertEqual(self.client.get("/api/v1/olap?mode=not-real",headers=admin).status_code,422)
        self.assertEqual(self.client.get("/api/v1/olap?mode=drilldown-group",headers=admin).status_code,422)
        for role_headers in (teacher,student):
            own = self.client.get("/api/v1/olap?mode=dice",headers=role_headers)
            self.assertEqual(own.status_code,200,own.text)
            self.assertLessEqual(own.json()["total"]["results"],summary["total"]["results"])
        student_id = self.client.get("/api/v1/auth/me",headers=student).json()["student_id"]
        own_results = self.client.get("/api/v1/olap?mode=dice",headers=student).json()["rows"]
        self.assertTrue(all(row["student_id"]==student_id for row in own_results))
        staff_groups = {row["group_id"] for row in self.client.get("/api/v1/resources/study_group",headers=staff).json()["items"]}
        staff_rollup = self.client.get("/api/v1/olap?mode=rollup-group",headers=staff).json()["rows"]
        self.assertTrue(all(row["group_id"] in staff_groups for row in staff_rollup))
        teacher_id = self.client.get("/api/v1/auth/me",headers=teacher).json()["teacher_id"]
        teacher_results = self.client.get("/api/v1/olap?mode=dice",headers=teacher).json()["rows"]
        self.db.execute("RESET ROLE")
        # Область преподавателя — группы его поручений, все дисциплины этих групп (как у пяти новых режимов, 18.10.2026).
        assignments = {row["group_id"] for row in self.db.execute(
            "SELECT ta.group_id FROM deanery.teaching_assignment ta WHERE ta.teacher_id=%s",(teacher_id,),
        )}
        self.db.execute("SET LOCAL ROLE backend_api")
        self.assertTrue(teacher_results)
        self.assertTrue(all(row["group_id"] in assignments for row in teacher_results))

    def test_create_and_delete_work_practice_and_unlinked_employee(self):
        response = self.client.post("/api/v1/auth/login",json={"login":"vasilyeva","password":"only-for-isolated-test"},headers=self.origin)
        headers = {**self.origin,"Authorization":"Bearer " + response.json()["access_token"]}
        self.db.execute("RESET ROLE")
        self.db.execute("SET LOCAL search_path TO pg_catalog,deanery")
        base = """FROM deanery.student s JOIN deanery.student_status st ON st.status_id=s.status_id AND st.is_active
                  JOIN deanery.study_group g ON g.group_id=s.group_id
                  JOIN deanery.curriculum_item ci ON ci.curriculum_id=g.curriculum_id
                  JOIN deanery.discipline dis ON dis.discipline_id=ci.discipline_id
                  JOIN deanery.curriculum c ON c.curriculum_id=g.curriculum_id
                  JOIN deanery.study_program p ON p.program_id=c.program_id
                  JOIN deanery.department d ON d.department_id=p.department_id
                  JOIN deanery.teacher t ON t.department_id IN
                      (SELECT department_id FROM deanery.department WHERE institute_id=d.institute_id)
                  JOIN deanery.employee e ON e.employee_id=t.employee_id AND e.dismissal_date IS NULL"""
        work = self.db.execute("SELECT s.student_id,ci.item_id,t.employee_id AS supervisor_id " + base +
                               " WHERE dis.kind IN ('coursework','final_attestation') AND NOT EXISTS"
                               " (SELECT 1 FROM deanery.academic_work w WHERE w.student_id=s.student_id AND w.item_id=ci.item_id) LIMIT 1").fetchone()
        placement = self.db.execute("SELECT s.student_id,ci.item_id,t.employee_id AS supervisor_id " + base +
                                    " WHERE dis.kind='practice' AND NOT EXISTS"
                                    " (SELECT 1 FROM deanery.practice_placement p WHERE p.student_id=s.student_id AND p.item_id=ci.item_id) LIMIT 1").fetchone()
        contact = self.db.execute("SELECT org_contact_id FROM deanery.organization_contact LIMIT 1").fetchone()
        person = self.db.execute("""SELECT p.person_id FROM deanery.person p
            WHERE NOT EXISTS (SELECT 1 FROM deanery.employee e WHERE e.person_id=p.person_id)
              AND NOT EXISTS (SELECT 1 FROM deanery.app_user u WHERE u.person_id=p.person_id)
              AND p.birth_date <= CURRENT_DATE - INTERVAL '16 years' LIMIT 1""").fetchone()
        position = self.db.execute("SELECT position_id FROM deanery.position LIMIT 1").fetchone()
        self.db.execute("SET LOCAL ROLE backend_api")
        self.assertIsNotNone(work)
        self.assertIsNotNone(placement)
        self.assertIsNotNone(person)

        created_work = self.client.post("/api/v1/resources/academic_work",headers=headers,json={
            **work,"topic":"Новая тестовая тема"})
        self.assertEqual(created_work.status_code,200,created_work.text)
        work_id = created_work.json()["work_id"]
        self.assertEqual(self.client.delete(f"/api/v1/resources/academic_work?work_id={work_id}",headers=headers).status_code,200)

        created_practice = self.client.post("/api/v1/resources/practice_placement",headers=headers,json={
            **placement,"org_contact_id":contact["org_contact_id"],"start_date":"2026-11-01","end_date":"2026-11-30"})
        self.assertEqual(created_practice.status_code,200,created_practice.text)
        placement_id = created_practice.json()["placement_id"]
        self.assertEqual(self.client.delete(f"/api/v1/resources/practice_placement?placement_id={placement_id}",headers=headers).status_code,200)

        created_employee = self.client.post("/api/v1/resources/employee",headers=headers,json={
            "person_id":person["person_id"],"personnel_number":f"TEST-{person['person_id']}",
            "position_id":position["position_id"],"employment_rate":"1.00","hire_date":"2026-10-10"})
        self.assertEqual(created_employee.status_code,403,created_employee.text)
        self.assertEqual(self.client.patch('/api/v1/resources/employee?employee_id=1',headers=headers,json={'employment_rate':'0.75'}).status_code,403)
        self.assertEqual(self.client.delete('/api/v1/resources/employee?employee_id=1',headers=headers).status_code,403)

    def test_manual_mutation_sets_real_audit_author_without_direct_table_grants(self):
        login = self.client.post("/api/v1/auth/login",json={"login":"vasilyeva","password":"only-for-isolated-test"},headers=self.origin)
        headers = {**self.origin,"Authorization":"Bearer " + login.json()["access_token"]}
        me = self.client.get("/api/v1/auth/me",headers=headers).json()
        changed = self.client.patch(f"/api/v1/resources/person?person_id={me['person_id']}",
                                    json={"middle_name":"Аудит"},headers=headers)
        self.assertEqual(changed.status_code,200,changed.text)
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            with self.db.transaction():
                self.db.execute("UPDATE deanery.person SET middle_name='Обход' WHERE person_id=%s",(me["person_id"],))
        self.db.execute("RESET ROLE")
        audit = self.db.execute("""SELECT app_user_id,agent_request_id FROM deanery.audit_log
                                 WHERE table_name='person' AND record_key=%s AND operation='U'
                                 ORDER BY audit_id DESC LIMIT 1""",(f"person_id={me['person_id']}",)).fetchone()
        self.db.execute("SET LOCAL ROLE backend_api")
        self.assertIsNotNone(audit)
        self.assertEqual(audit["app_user_id"],me["user_id"])
        self.assertIsNone(audit["agent_request_id"])


if __name__ == "__main__":
    unittest.main()
