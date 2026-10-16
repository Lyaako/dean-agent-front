"""Р2: each pinned database error reaches the client with its own code, HTTP status and field.

Every case provokes the real violation, so a reworded message in a new database revision fails here.
"""
import os
import unittest
from datetime import date, timedelta
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row

from backend.database_errors import domain_error


@unittest.skipUnless(os.environ.get("TEST_DATABASE_DSN"), "TEST_DATABASE_DSN is required for PostgreSQL integration")
class DatabaseErrorCodeTests(unittest.TestCase):
    def setUp(self):
        self.db = psycopg.connect(os.environ["TEST_DATABASE_DSN"], row_factory=dict_row)
        self.addCleanup(self.db.close)
        self.db.execute("SET LOCAL search_path=pg_catalog,deanery")
        self.users = {r["login"]: r for r in self.db.execute("""SELECT u.user_id,u.login,e.employee_id FROM app_user u
            LEFT JOIN employee e ON e.person_id=u.person_id AND e.dismissal_date IS NULL""")}
        # The last attempt in a closed sheet of institute 1, examined by someone other than novikov.
        self.grade = self.db.execute("""SELECT gr.grade_id,gr.points,gr.is_absent,gs.sheet_id
            FROM v_last_result lr JOIN grade_sheet gs USING(sheet_id)
            JOIN grade gr ON gr.sheet_id=gs.sheet_id AND gr.student_id=lr.student_id
            WHERE gs.status='closed' AND fn_group_institute(gs.group_id)=1 AND gs.examiner_id<>%s
              AND NOT EXISTS(SELECT FROM grade_correction c WHERE c.grade_id=gr.grade_id AND c.status IN ('pending','approved'))
            ORDER BY gs.sheet_id DESC LIMIT 1""", (self.users["novikov"]["employee_id"],)).fetchone()

    def expect(self, code, status, field, *statements):
        with self.assertRaises(psycopg.Error) as raised:
            with self.db.transaction():
                for statement, params in statements:
                    self.db.execute(statement, params)
        mapped = domain_error(raised.exception)
        self.assertIsNotNone(mapped, raised.exception.diag.message_primary)
        self.assertEqual((mapped[1], mapped[0], mapped[3].get("field")), (code, status, field),
                         raised.exception.diag.message_primary)
        self.assertNotRegex(mapped[2], r"\bCALL\b|fn_\w+\s*\(")

    def request(self, login, grade=None):
        g = grade or self.grade
        return ("""INSERT INTO grade_correction(grade_id,old_points,old_is_absent,new_points,new_is_absent,reason,requested_by_id)
            VALUES(%s,%s,%s,%s,FALSE,'Проверка кода ошибки',%s)""",
            (g["grade_id"], g["points"], g["is_absent"], 30 if g["points"] != 30 else 31, self.users[login]["user_id"]))

    def decide(self, status, login, comment=None):
        return ("""UPDATE grade_correction SET status=%s,decided_by_id=%s,decided_at=now(),decision_comment=%s
            WHERE grade_id=%s AND status IN ('pending','rejected','approved')""",
            (status, self.users[login]["user_id"], comment, self.grade["grade_id"]))

    def test_correction_rules(self):
        self.assertIsNotNone(self.grade)
        self.expect("correction_pending_exists", 409, "sheet_id", self.request("kuznetsova"), self.request("smirnov"))
        self.expect("correction_not_allowed", 403, None, self.request("ivanov.ks"))
        self.expect("correction_not_own_sheet", 403, "sheet_id", self.request("novikov"))
        self.expect("correction_self_decision", 403, None, self.request("smirnov"), self.decide("approved", "smirnov"))
        self.expect("correction_not_manager", 403, None, self.request("kuznetsova"), self.decide("approved", "novikov"))
        self.expect("correction_decided", 409, None, self.request("kuznetsova"),
                    self.decide("rejected", "smirnov", "Основание не подтверждено"), self.decide("approved", "smirnov"))
        self.expect("correction_decided", 409, None, self.request("kuznetsova"),
                    self.decide("rejected", "smirnov", "Основание не подтверждено"),
                    self.decide("rejected", "smirnov", "Другой комментарий к решению"))

    def test_open_and_cancelled_sheets_are_told_apart(self):
        sheet = self.db.execute("""INSERT INTO grade_sheet(sheet_number,item_id,group_id,examiner_id,stage,sheet_kind,issue_date)
            SELECT %s,item_id,group_id,examiner_id,stage,'retake',CURRENT_DATE FROM grade_sheet WHERE sheet_id=%s
            RETURNING sheet_id""", ("QA-" + uuid4().hex[:12], self.grade["sheet_id"])).fetchone()["sheet_id"]
        grade = self.db.execute("""INSERT INTO grade(sheet_id,student_id,points)
            SELECT %s,student_id,30 FROM grade WHERE grade_id=%s RETURNING grade_id,points,is_absent""",
            (sheet, self.grade["grade_id"])).fetchone()
        self.expect("sheet_open", 409, "sheet_id", self.request("kuznetsova", grade))
        self.db.execute("UPDATE grade_sheet SET status='cancelled' WHERE sheet_id=%s", (sheet,))
        self.expect("sheet_cancelled", 409, "sheet_id", self.request("kuznetsova", grade))
        self.expect("sheet_closed", 409, "sheet_id", ("UPDATE grade SET points=31 WHERE grade_id=%s", (grade["grade_id"],)))

    def test_order_cancel_rules(self):
        self.expect("order_not_pending", 409, None, ("CALL sp_cancel_scheduled_order('QA-NONE', 1)", None))
        group = self.db.execute("""SELECT g.name,i.director_id FROM study_group g
            JOIN institute i ON i.institute_id=fn_group_institute(g.group_id)
            WHERE NOT g.is_archived ORDER BY g.group_id LIMIT 1""").fetchone()
        number = "QA-" + uuid4().hex[:10]
        student = self.db.execute("""SELECT fn_enroll_student('Проверкин','Иван',NULL,'M','2008-05-05',NULL,NULL,%s,
            'Бюджет',%s,%s,CURRENT_DATE,%s,%s) AS id""",
            (group["name"], number, number, group["director_id"], date.today() + timedelta(days=20))).fetchone()["id"]
        self.expect("order_cancel_enrollment", 409, None, ("CALL sp_cancel_scheduled_order(%s, %s)", (number, student)))
