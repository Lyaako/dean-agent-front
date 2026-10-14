"""P01 integration checks against an isolated, migrated, seeded PostgreSQL."""

import json
import os
import re
from types import SimpleNamespace
from pathlib import Path
import unittest
from uuid import uuid4

import psycopg
from psycopg import errors, sql
from psycopg.types.json import Jsonb


ROOT = Path(__file__).resolve().parents[2]
SERVICE_TABLES = {
    "account_security",
    "auth_session", "auth_token", "chat_session", "chat_message", "agent_run",
    "proposal", "proposal_event", "idempotency_record", "file", "file_version",
    "run_attachment", "job", "regulation", "regulation_version", "regulation_chunk",
}
RUNTIME_ROLES = ("backend_api", "backend_executor", "backend_read", "backend_worker")


@unittest.skipUnless(os.environ.get("TEST_DATABASE_DSN"), "TEST_DATABASE_DSN is required for PostgreSQL integration")
class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.connection = psycopg.connect(os.environ["TEST_DATABASE_DSN"])
        self.addCleanup(self.connection.close)
        self.user_id = self.connection.execute("SELECT user_id FROM deanery.app_user ORDER BY user_id LIMIT 1").fetchone()[0]

    def value(self, query, parameters=None):
        return self.connection.execute(query, parameters).fetchone()[0]

    def test_revised_native_225_checks(self):
        notices=[]
        self.connection.add_notice_handler(lambda notice:notices.append(notice.message_primary))
        script=(ROOT/'references/database-revision-20261011/06_tests.sql').read_text(encoding='utf-8-sig')
        self.assertIsNone(re.search(r'(?m)^\\(?!echo )',script))
        script=re.sub(r'(?m)^\\echo .*?$','',script)
        # The source assumes no extra view schemas; keep its privacy check schema-qualified.
        script=script.replace("format('deanery.%I', u.view_name)","format('%I.%I', u.view_schema, u.view_name)")
        script=script.replace('DECLARE q TEXT;','DECLARE q TEXT; v_constraint TEXT; v_table TEXT; v_column TEXT;')
        notice="RAISE NOTICE '✓ %  →  %', p_what, SQLERRM;"
        capture="""GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME,v_table=TABLE_NAME,v_column=COLUMN_NAME;
        RAISE NOTICE 'QA_ERROR %',jsonb_build_object('sqlstate',SQLSTATE,'message_primary',SQLERRM,
            'constraint_name',v_constraint,'table_name',v_table,'column_name',v_column);"""
        self.assertEqual(script.count(notice),2)
        script=script.replace(notice,capture+'\n        '+notice)
        cursor=self.connection.execute(script,prepare=False)
        while cursor.nextset():
            pass
        self.assertEqual(sum(line.startswith('✓') for line in notices),225)
        from backend.database_errors import domain_error
        codes=set()
        for line in notices:
            if not line.startswith('QA_ERROR '): continue
            diagnostic=json.loads(line[len('QA_ERROR '):])
            native=SimpleNamespace(sqlstate=diagnostic.pop('sqlstate'),diag=SimpleNamespace(**diagnostic))
            mapped=domain_error(native)
            if mapped is not None:
                codes.add(mapped[1])
                self.assertNotRegex(mapped[2],r'\bCALL\b|fn_\w+')
        with self.assertRaises(psycopg.Error) as stale:
            with self.connection.transaction():
                self.connection.execute("""INSERT INTO deanery.grade_correction(grade_id,old_points,old_is_absent,
                    new_points,new_is_absent,reason,requested_by_id)
                    SELECT gr.grade_id,CASE WHEN gr.points=25 THEN 26 ELSE 25 END,gr.is_absent,30,FALSE,
                        'Проверка устаревшего снимка',%s FROM deanery.grade gr JOIN deanery.grade_sheet gs USING(sheet_id)
                    WHERE gs.status='closed' ORDER BY gr.grade_id LIMIT 1""",(self.user_id,))
        mapped=domain_error(stale.exception)
        self.assertIsNotNone(mapped)
        codes.add(mapped[1])
        self.assertTrue({'order_past_date','order_signer_invalid','order_pending_exists','slot_semester_mismatch',
            'sheet_dates_invalid','points_out_of_scale','sheet_incomplete','sheet_closed','correction_later_attempt',
            'correction_stale','request_final','blank_text'}<=codes,str(codes))

    def test_frontend_display_form_lookup_and_support_fields_have_a_database_source(self):
        fixture = json.loads((ROOT / "backend/tests/fixtures/frontend_contract.json").read_text(encoding="utf-8"))
        requirements = []
        for screen in fixture["screens"]:
            requirements.extend([(screen["view"], screen["required_view_fields"]), (screen["table"], screen["form_fields"])])
        requirements.extend(fixture["lookup_fields"].items())
        requirements.extend((name, item["fields"]) for name, item in fixture["supporting_reads"].items())
        for resource, required in requirements:
            with self.subTest(resource=resource):
                columns = self.connection.execute(
                    "SELECT column_name FROM information_schema.columns WHERE table_schema='deanery' AND table_name=%s", (resource,),
                ).fetchall()
                missing = set(required) - {row[0] for row in columns}
                projection = fixture["view_key_projection"].get(resource)
                self.assertEqual(missing, {projection["key"]} if projection else set(), f"Unexpected missing frontend fields in {resource}")

    def test_frontend_key_projections_preserve_source_view_rows_and_base_identity(self):
        fixture = json.loads((ROOT / "backend/tests/fixtures/frontend_contract.json").read_text(encoding="utf-8"))
        self.connection.execute("SET LOCAL search_path TO pg_catalog, deanery")
        for view, projection in fixture["view_key_projection"].items():
            with self.subTest(view=view):
                key = sql.Identifier(projection["key"])
                query = sql.SQL("SELECT count(*), count({0}), count(DISTINCT {0}) FROM backend_api.{1}").format(key,sql.Identifier(view))
                count, present, unique = self.connection.execute(query).fetchone()
                self.assertEqual((present, unique), (count, count))
                self.assertEqual(count, self.value(sql.SQL("SELECT count(*) FROM deanery.{}").format(sql.Identifier(view))))
                fields = [row[0] for row in self.connection.execute(
                    "SELECT column_name FROM information_schema.columns WHERE table_schema='deanery' AND table_name=%s ORDER BY ordinal_position", (view,),
                )]
                selected = sql.SQL(",").join(map(sql.Identifier, fields))
                difference = sql.SQL("SELECT count(*) FROM ((SELECT {0} FROM backend_api.{1} EXCEPT ALL SELECT {0} FROM deanery.{1}) UNION ALL (SELECT {0} FROM deanery.{1} EXCEPT ALL SELECT {0} FROM backend_api.{1})) d").format(selected,sql.Identifier(view))
                self.assertEqual(self.value(difference), 0)
                joined = sql.SQL("SELECT count(*) FROM backend_api.{0} r JOIN deanery.{1} b ON b.{2}=r.{2}").format(sql.Identifier(view),sql.Identifier(projection["table"]),key)
                self.assertEqual(self.value(joined), count)

    def proposal(self, run_id=None):
        return self.value(
            """INSERT INTO agent_backend.proposal
               (initiator_user_id, run_id, kind, command, preview, explanation, reason, expires_at)
               VALUES (%s,%s,'record_change','{"action":"fixture"}','{}','Fixture','Fixture',now()+interval '1 day')
               RETURNING id""", (self.user_id, run_id),
        )

    def conversation(self):
        session_id = self.value(
            "INSERT INTO agent_backend.chat_session(user_id,title) VALUES (%s,'Fixture') RETURNING id",
            (self.user_id,),
        )
        request_id = self.value(
            "INSERT INTO deanery.agent_request(user_id,request_text,response_text) VALUES (%s,'private question','private answer') RETURNING agent_request_id",
            (self.user_id,),
        )
        run_id = self.value(
            """INSERT INTO agent_backend.agent_run(session_id,initiator_user_id,agent_request_id,status,events,result)
               VALUES (%s,%s,%s,'running',%s,%s) RETURNING id""",
            (session_id, self.user_id, request_id, Jsonb([{"data": "private answer"}]), Jsonb({"answer": "private answer"})),
        )
        self.connection.execute(
            "INSERT INTO agent_backend.chat_message(session_id,sequence,role,text) VALUES (%s,1,'user','private question')",
            (session_id,),
        )
        self.connection.execute(
            """INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash,response_body,run_id,session_id)
               VALUES (%s,'/agent/chat/stream',%s,%s,%s,%s,%s)""",
            (self.user_id, uuid4(), b"fixture", Jsonb({"answer": "private answer"}), run_id, session_id),
        )
        return session_id, run_id, request_id

    def test_live_revised_columns_primary_keys_and_references_match_the_catalog(self):
        catalog = json.loads((ROOT / "docs/resource-catalog-revision.json").read_text(encoding="utf-8"))
        for table in catalog["tables"]:
            with self.subTest(table=table["name"]):
                columns = self.connection.execute(
                    """SELECT column_name,is_nullable='YES',is_identity='YES' FROM information_schema.columns
                       WHERE table_schema='deanery' AND table_name=%s ORDER BY ordinal_position""", (table["name"],),
                ).fetchall()
                self.assertEqual(columns, [(field["name"], field["nullable"], field["identity"]) for field in table["fields"]])
                types = self.connection.execute(
                    """SELECT format_type(atttypid,atttypmod) FROM pg_attribute
                       WHERE attrelid=to_regclass(%s) AND attnum>0 AND NOT attisdropped ORDER BY attnum""",
                    ("deanery." + table["name"],),
                ).fetchall()
                aliases = {"INT": "integer", "TIME": "time without time zone", "TIMESTAMPTZ": "timestamp with time zone"}
                expected_types = [
                    aliases.get(field["type"], field["type"].lower().replace("varchar(", "character varying(").replace("char(", "character("))
                    for field in table["fields"]
                ]
                self.assertEqual([row[0] for row in types], expected_types)
                primary = self.connection.execute(
                    """SELECT a.attname FROM pg_constraint c
                       CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum,ord)
                       JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
                       WHERE c.conrelid=to_regclass(%s) AND c.contype='p' ORDER BY k.ord""",
                    ("deanery." + table["name"],),
                ).fetchall()
                self.assertEqual([row[0] for row in primary], table["key"])
        self.assertEqual(self.value("SELECT count(*) FROM pg_constraint WHERE connamespace='deanery'::regnamespace AND contype='f'"), 83)
        views = self.connection.execute("SELECT table_name FROM information_schema.views WHERE table_schema='deanery'").fetchall()
        self.assertEqual({row[0] for row in views}, set(catalog["views"]))

    def test_exact_service_table_count_and_separate_owner(self):
        tables = self.connection.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='agent_backend' AND table_type='BASE TABLE'"
        ).fetchall()
        self.assertEqual({row[0] for row in tables}, SERVICE_TABLES)
        self.assertEqual(self.value("SELECT count(*) FROM pg_class WHERE relnamespace IN ('deanery'::regnamespace,'agent_backend'::regnamespace) AND relkind='r'"), 72)
        owners = self.connection.execute(
            "SELECT DISTINCT pg_get_userbyid(relowner) FROM pg_class WHERE relnamespace IN ('deanery'::regnamespace,'agent_backend'::regnamespace) AND relkind IN ('r','v','S')"
        ).fetchall()
        self.assertEqual(owners, [("backend_migration",)])

    def test_runtime_roles_are_unprivileged_and_cannot_reach_unscoped_data(self):
        for role in RUNTIME_ROLES:
            with self.subTest(role=role):
                privileges = self.connection.execute(
                    "SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=%s", (role,),
                ).fetchone()
                self.assertEqual(privileges, (False, False, False, False, False))
                self.assertFalse(self.value("SELECT pg_has_role(%s,'backend_migration','MEMBER')", (role,)))
                for query in (
                    "SELECT password_hash FROM deanery.app_user",
                    "SELECT * FROM deanery.v_students",
                    "UPDATE deanery.audit_log SET table_name='forbidden' WHERE false",
                    "CREATE TABLE public.forbidden_fixture(id INT)",
                    "SET LOCAL ROLE backend_migration",
                ):
                    with self.subTest(query=query), self.assertRaises(errors.InsufficientPrivilege):
                        with self.connection.transaction():
                            self.connection.execute(sql.SQL("SET LOCAL SESSION AUTHORIZATION {}").format(sql.Identifier(role)))
                            self.connection.execute(query)
        self.assertFalse(self.value("SELECT rolcanlogin FROM pg_roles WHERE rolname='deanery_agent'"))

    def test_auth_account_functions_expose_scope_but_not_direct_credential_table(self):
        account = self.connection.execute("SELECT user_id, password_hash FROM deanery.app_user WHERE login='vasilyeva'").fetchone()
        self.assertIsNotNone(account)
        with self.connection.transaction():
            self.connection.execute("SET LOCAL SESSION AUTHORIZATION backend_api")
            self.assertEqual(
                self.connection.execute("SELECT user_id, password_hash, is_active FROM backend_api.login_account('vasilyeva')").fetchone(),
                (account[0], account[1], True),
            )
            snapshot = self.connection.execute("SELECT role_code, institute_ids FROM backend_api.account_snapshot(%s)", (account[0],)).fetchone()
            self.assertEqual(snapshot[0], "admin")
            self.assertTrue(snapshot[1])
            self.assertIsNone(self.connection.execute("SELECT * FROM backend_api.account_snapshot(-1)").fetchone())
            with self.assertRaises(errors.InsufficientPrivilege):
                with self.connection.transaction():
                    self.connection.execute("SELECT password_hash FROM deanery.app_user WHERE user_id=%s", (account[0],))

    def test_account_scope_is_derived_for_every_real_seed_role(self):
        expected = {
            "vasilyeva": "admin", "smirnov": "director", "kuznetsova": "dean_staff",
            "novikov": "teacher", "ivanov.ks": "student",
        }
        for login, role in expected.items():
            with self.subTest(login=login):
                row = self.connection.execute(
                    "SELECT s.role_code,s.institute_ids,s.student_id,s.teacher_id FROM deanery.app_user u CROSS JOIN LATERAL backend_api.account_snapshot(u.user_id) s WHERE u.login=%s", (login,),
                ).fetchone()
                self.assertEqual(row[0], role)
                self.assertTrue(row[1])
                self.assertEqual(row[2] is not None, role == "student")
                self.assertEqual(row[3] is not None, role == "teacher")

    def test_chat_delete_refuses_active_run_then_clears_copies_and_keeps_proposals(self):
        session_id, run_id, request_id = self.conversation()
        proposal_id = self.proposal(run_id)
        event_id = self.value(
            "INSERT INTO agent_backend.proposal_event(proposal_id,event_type) VALUES (%s,'fixture') RETURNING id", (proposal_id,),
        )
        with self.assertRaises(errors.ObjectNotInPrerequisiteState):
            with self.connection.transaction():
                self.connection.execute("DELETE FROM agent_backend.chat_session WHERE id=%s", (session_id,))
        self.assertEqual(self.value("SELECT count(*) FROM agent_backend.chat_message WHERE session_id=%s", (session_id,)), 1)
        self.connection.execute("UPDATE agent_backend.agent_run SET finished_at=now() WHERE id=%s", (run_id,))
        self.connection.execute("DELETE FROM agent_backend.chat_session WHERE id=%s", (session_id,))
        self.assertEqual(self.value("SELECT count(*) FROM agent_backend.chat_message WHERE session_id=%s", (session_id,)), 0)
        run = self.connection.execute(
            "SELECT session_id,events,result,conversation_deleted_at IS NOT NULL FROM agent_backend.agent_run WHERE id=%s", (run_id,),
        ).fetchone()
        self.assertEqual(run, (None, [], None, True))
        request = self.connection.execute("SELECT request_text,response_text FROM deanery.agent_request WHERE agent_request_id=%s", (request_id,)).fetchone()
        self.assertEqual(request, ("Переписка удалена", None))
        self.assertTrue(self.value("SELECT bool_and(response_body IS NULL AND response_removed_at IS NOT NULL) FROM agent_backend.idempotency_record WHERE run_id=%s", (run_id,)))
        self.assertEqual(self.value("SELECT run_id FROM agent_backend.proposal WHERE id=%s", (proposal_id,)), run_id)
        self.assertEqual(self.value("SELECT id FROM agent_backend.proposal_event WHERE proposal_id=%s", (proposal_id,)), event_id)
        self.assertEqual(self.value("SELECT count(*) FROM deanery.audit_log WHERE table_name='agent_request' AND record_key=%s", (f"agent_request_id={request_id}",)), 0)

    def test_only_one_active_run_and_unique_message_order_per_chat(self):
        session_id, run_id, _ = self.conversation()
        with self.assertRaises(errors.UniqueViolation):
            with self.connection.transaction():
                self.connection.execute(
                    "INSERT INTO agent_backend.agent_run(session_id,initiator_user_id,status) VALUES (%s,%s,'running')", (session_id,self.user_id),
                )
        with self.assertRaises(errors.UniqueViolation):
            with self.connection.transaction():
                self.connection.execute(
                    "INSERT INTO agent_backend.chat_message(session_id,sequence,role,text) VALUES (%s,1,'agent','duplicate')", (session_id,),
                )
        self.connection.execute("UPDATE agent_backend.agent_run SET finished_at=now() WHERE id=%s", (run_id,))
        self.connection.execute("INSERT INTO agent_backend.agent_run(session_id,initiator_user_id,status) VALUES (%s,%s,'running')", (session_id,self.user_id))

    def test_chat_delete_preserves_official_audit_and_its_authorship(self):
        session_id, run_id, request_id = self.conversation()
        self.connection.execute("SELECT set_config('app.user_id',%s,true),set_config('app.agent_request_id',%s,true)", (str(self.user_id),str(request_id)))
        self.connection.execute(
            """UPDATE deanery.person SET middle_name=CASE WHEN middle_name='Fixture' THEN 'Recorded' ELSE 'Fixture' END
               WHERE person_id=(SELECT person_id FROM deanery.app_user WHERE user_id=%s)""", (self.user_id,),
        )
        audit_id = self.value("SELECT audit_id FROM deanery.audit_log WHERE agent_request_id=%s ORDER BY audit_id DESC LIMIT 1", (request_id,))
        audit = self.value("SELECT to_jsonb(a) FROM deanery.audit_log a WHERE audit_id=%s", (audit_id,))
        details = self.connection.execute("SELECT column_name,old_value,new_value FROM deanery.audit_log_detail WHERE audit_id=%s ORDER BY column_name", (audit_id,)).fetchall()
        self.assertEqual(audit["app_user_id"], self.user_id)
        self.assertTrue(details)
        self.connection.execute("UPDATE agent_backend.agent_run SET finished_at=now() WHERE id=%s", (run_id,))
        self.connection.execute("DELETE FROM agent_backend.chat_session WHERE id=%s", (session_id,))
        self.assertEqual(self.value("SELECT to_jsonb(a) FROM deanery.audit_log a WHERE audit_id=%s", (audit_id,)), audit)
        self.assertEqual(self.connection.execute("SELECT column_name,old_value,new_value FROM deanery.audit_log_detail WHERE audit_id=%s ORDER BY column_name", (audit_id,)).fetchall(), details)

    def test_proposal_command_is_immutable_and_event_history_is_append_only(self):
        proposal_id = self.proposal()
        for field in ("command", "preview", "snapshot"):
            with self.subTest(field=field), self.assertRaises(errors.CheckViolation):
                with self.connection.transaction():
                    self.connection.execute(sql.SQL("UPDATE agent_backend.proposal SET {}='{{\"changed\":true}}' WHERE id=%s").format(sql.Identifier(field)), (proposal_id,))
        self.connection.execute("UPDATE agent_backend.proposal SET assignee_user_id=%s,version=version+1 WHERE id=%s", (self.user_id,proposal_id))
        event_id = self.value("INSERT INTO agent_backend.proposal_event(proposal_id,event_type) VALUES (%s,'assignment') RETURNING id", (proposal_id,))
        for query in ("UPDATE agent_backend.proposal_event SET event_type='forged' WHERE id=%s", "DELETE FROM agent_backend.proposal_event WHERE id=%s"):
            with self.assertRaises(errors.CheckViolation):
                with self.connection.transaction():
                    self.connection.execute(query, (event_id,))

    def test_file_processing_can_change_without_replacing_the_original(self):
        file_id = self.value("INSERT INTO agent_backend.file(owner_user_id,name) VALUES (%s,'Fixture.pdf') RETURNING id", (self.user_id,))
        version_id = self.value(
            "INSERT INTO agent_backend.file_version(file_id,original_name,mime_type,byte_size,storage_key,content_hash) VALUES (%s,'Fixture.pdf','application/pdf',10,%s,%s) RETURNING id",
            (file_id, str(uuid4()), b"fixture"),
        )
        with self.assertRaises(errors.CheckViolation):
            with self.connection.transaction():
                self.connection.execute("UPDATE agent_backend.file_version SET storage_key='replacement' WHERE id=%s", (version_id,))
        self.connection.execute("UPDATE agent_backend.file_version SET extraction_state='partial',extraction=%s WHERE id=%s", (Jsonb({"processed_pages": [1], "failed_pages": [2]}),version_id))
        self.assertEqual(self.value("SELECT extraction_state FROM agent_backend.file_version WHERE id=%s", (version_id,)), "partial")

    def test_proposal_execution_cannot_be_null_or_skip_grade_submission(self):
        proposal_id = self.proposal()
        with self.assertRaises(errors.CheckViolation):
            with self.connection.transaction():
                self.connection.execute("UPDATE agent_backend.proposal SET execution=%s WHERE id=%s", (Jsonb({"status": None}),proposal_id))
        with self.assertRaises(errors.CheckViolation):
            with self.connection.transaction():
                self.connection.execute(
                    """INSERT INTO agent_backend.proposal
                       (initiator_user_id,kind,command,preview,explanation,reason,expires_at,submission_status)
                       VALUES (%s,'grade_correction','{}','{}','Fixture','Fixture',now()+interval '1 day','submitted')""", (self.user_id,),
                )

    def test_idempotency_is_scoped_and_duplicate_key_cannot_create_another_record(self):
        key = uuid4()
        parameters = (self.user_id, "/agent/chat/stream", key, b"fixture")
        query = "INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash) VALUES (%s,%s,%s,%s)"
        self.connection.execute(query, parameters)
        with self.assertRaises(errors.UniqueViolation):
            with self.connection.transaction():
                self.connection.execute(query, parameters)
        self.connection.execute(query, (self.user_id, "/agent/sessions", key, b"fixture"))


if __name__ == "__main__":
    unittest.main()
