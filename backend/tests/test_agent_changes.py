"""P09 exact source language, shared command rights and actual tool preparations."""

import ast as python_ast
from hashlib import sha256
import json
import os
from pathlib import Path
from uuid import uuid4

from pglast import parse_sql
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

from backend.agent_query import QueryRejected
from backend.agent_sql_changes import ALLOWED, parse_change


def test_exact_original_ten_table_fieldsets_and_sql_policy_match():
    source = python_ast.parse(Path("references/agent-source/dean_agent/sql_changes.py").read_text(encoding="utf-8"))
    original = next(python_ast.literal_eval(node.value) for node in source.body
                    if isinstance(node, python_ast.Assign) and any(getattr(n, "id", None) == "ALLOWED" for n in node.targets))
    assert ALLOWED == original and len(ALLOWED) == 10
    sql = Path("backend/db/migrations/sql/019_agent_commands.sql").read_text(encoding="utf-8")
    encoded = sql.split("SELECT '", 1)[1].split("'::JSONB", 1)[0]
    assert json.loads(encoded) == {table: {key: sorted(value) if isinstance(value, set) else value
                                         for key, value in spec.items()} for table, spec in ALLOWED.items()}


@pytest.mark.parametrize("table", sorted(ALLOWED))
def test_every_original_field_survives_as_command_data(table):
    policy = ALLOWED[table]
    for sql_action, operation in (("insert", "create"), ("update", "update")):
        fields = sorted(policy[sql_action])
        sql = (f"INSERT INTO deanery.{table} ({','.join(fields)}) VALUES ({','.join('NULL' for _ in fields)})"
               if sql_action == "insert" else f"UPDATE {table} SET " + ",".join(f"{name}=NULL" for name in fields) + f" WHERE {policy['pk']}=1")
        command = parse_change(sql)
        assert command == {"version": 1, "kind": "sql_change", "resource": table, "operation": operation,
                           "key": {} if operation == "create" else {policy["pk"]: 1}, "fields": dict.fromkeys(fields)}
        assert "sql" not in command


@pytest.mark.parametrize("sql", [
    "DELETE FROM grade WHERE grade_id=1", "CREATE TABLE x(a int)", "SELECT 1", "",
    "UPDATE grade SET points=30", "UPDATE grade SET points=30 WHERE grade_id=1 OR true",
    "UPDATE grade SET points=30 WHERE grade_id IN (1)", "UPDATE grade SET points=30 WHERE grade_id=-1",
    "UPDATE grade SET points=30 WHERE grade_id='1'", "UPDATE grade SET points=30 WHERE grade_id=2147483648",
    "UPDATE grade g SET points=30 WHERE grade_id=1", "UPDATE grade SET points=30 FROM student WHERE grade_id=1",
    "UPDATE grade SET points=points+1 WHERE grade_id=1", "UPDATE grade SET points=abs(30) WHERE grade_id=1",
    "UPDATE grade SET points=30::integer WHERE grade_id=1", "UPDATE grade SET points=(SELECT 30) WHERE grade_id=1",
    "UPDATE grade SET sheet_id=1 WHERE grade_id=1", "UPDATE grade SET points=30,points=31 WHERE grade_id=1",
    "UPDATE grade SET points[1]=30 WHERE grade_id=1", "UPDATE other.grade SET points=30 WHERE grade_id=1",
    "UPDATE grade SET points=30 WHERE grade_id OPERATOR(evil.=) 1",
    "UPDATE grade SET points=30 WHERE grade_id=1 RETURNING points",
    "UPDATE grade SET points=30 WHERE grade_id=1; UPDATE grade SET points=31 WHERE grade_id=2",
    "WITH x AS (SELECT 1) UPDATE grade SET points=30 WHERE grade_id=1",
    "INSERT INTO grade DEFAULT VALUES", "INSERT INTO grade(points) SELECT 30",
    "INSERT INTO grade(points) VALUES(30),(31)", "INSERT INTO grade(points) VALUES(DEFAULT)",
    "INSERT INTO grade(points) VALUES(now())", "INSERT INTO grade(points) VALUES(30) ON CONFLICT DO NOTHING",
    "INSERT INTO grade(points) OVERRIDING SYSTEM VALUE VALUES(30)",
    "INSERT INTO grade(points) VALUES(30) LIMIT 1", "INSERT INTO grade(points) VALUES(30) UNION SELECT 30",
    "INSERT INTO grade(points[1]) VALUES(30)", "INSERT INTO student(status_id) VALUES(1)",
    "INSERT INTO grade(grade_id,points) VALUES(1,30)", " " * 4001,
])
def test_unsafe_root_ast_rejected(sql):
    with pytest.raises(QueryRejected):
        parse_change(sql)


def test_literal_values_remain_exact_and_sql_text_is_data():
    command = parse_change("INSERT INTO document_request(student_id,copies,purpose) VALUES(1,1.23456789123456789,'x''); DELETE FROM student; --')")
    assert command["fields"]["copies"] == "1.23456789123456789"
    assert command["fields"]["purpose"] == "x'); DELETE FROM student; --"
    assert parse_change("UPDATE grade SET points=NULL,is_absent=true WHERE grade_id=1")["fields"] == {"points": None, "is_absent": True}


def test_all_changed_sql_files_parse():
    for name in ("008_manual_mutations", "013_command_engine", "017_agent_reads", "019_agent_commands", "031_confirmed_write_policy"):
        assert parse_sql(Path(f"backend/db/migrations/sql/{name}.sql").read_text(encoding="utf-8"))


@pytest.fixture
def database():
    if not os.environ.get("TEST_DATABASE_DSN"):
        pytest.skip("Isolated PostgreSQL required")
    with psycopg.connect(os.environ["TEST_DATABASE_DSN"], row_factory=dict_row) as db:
        db.execute("SET LOCAL search_path=pg_catalog,deanery")
        db.execute("SET LOCAL TIME ZONE 'Europe/Moscow'")
        yield db
        db.rollback()


def actor(db, login="vasilyeva"):
    user = db.execute("SELECT user_id FROM app_user WHERE login=%s", (login,)).fetchone()["user_id"]
    request = db.execute("INSERT INTO agent_request(user_id,request_text) VALUES(%s,'P09 focused verification') RETURNING agent_request_id", (user,)).fetchone()["agent_request_id"]
    return user, request


def preview(db, sql, user, request):
    return db.execute("SELECT backend_api.command_preview(%s,%s,%s) AS result", (Jsonb(parse_change(sql)), user, request)).fetchone()["result"]


def apply(db, command, user, request, decider=None):
    return db.execute("SELECT backend_api.command_execute(%s,%s,%s,%s,%s) AS result", (Jsonb(command), user, decider or user, request, uuid4())).fetchone()["result"]


def test_root_document_fields_preview_and_manual_field_policy(database):
    db = database
    user, request = actor(db)
    row = db.execute("SELECT dr.* FROM document_request dr JOIN request_status rs USING(request_status_id) WHERE NOT rs.is_final ORDER BY request_id LIMIT 1").fetchone()
    sql = f"UPDATE document_request SET completed_at='2026-10-10 12:30:00+03' WHERE request_id={row['request_id']}"
    before = db.execute("SELECT count(*) AS n FROM audit_log").fetchone()["n"]
    result = preview(db, sql, user, request)
    assert result["command"]["kind"] == "sql_change" and "sql" not in result["command"]
    assert db.execute("SELECT count(*) AS n FROM audit_log").fetchone()["n"] == before
    assert db.execute("SELECT completed_at FROM document_request WHERE request_id=%s", (row["request_id"],)).fetchone()["completed_at"] == row["completed_at"]
    with pytest.raises(psycopg.Error), db.transaction():
        db.execute("SELECT backend_api.mutate_record_as('document_request','update',%s,%s,%s,%s,NULL,FALSE)",
                   (Jsonb({"request_id": row["request_id"]}), Jsonb({"completed_at": "2026-10-10"}), user, user))


def test_teacher_own_grade_and_attendance_only_and_closed_grade_never_bypasses(database):
    db = database
    user, request = actor(db, "novikov")
    teacher = db.execute("SELECT teacher_id FROM backend_api.account_snapshot(%s)", (user,)).fetchone()["teacher_id"]
    own = db.execute("SELECT gr.*,gs.status,gs.item_id,gs.group_id,gs.stage FROM grade gr JOIN grade_sheet gs USING(sheet_id) JOIN student s USING(student_id) JOIN student_status st USING(status_id) WHERE gs.examiner_id=%s AND gs.group_id=s.group_id AND st.is_active ORDER BY gr.grade_id LIMIT 1", (teacher,)).fetchone()
    assert own
    db.execute("INSERT INTO teaching_assignment(item_id,group_id,teacher_id,lesson_type_id) SELECT %s,%s,%s,lesson_type_id FROM lesson_type ORDER BY lesson_type_id LIMIT 1", (own["item_id"],own["group_id"],teacher))
    command = parse_change(f"UPDATE grade SET points=30,is_absent=false WHERE grade_id={own['grade_id']}")
    assert db.execute("SELECT backend_api.command_authorized(%s,%s,'prepare') AS allowed", (Jsonb(command), user)).fetchone()["allowed"]
    if own["status"] != "open":
        with pytest.raises(psycopg.Error), db.transaction():
            preview(db, f"UPDATE grade SET points=30,is_absent=false WHERE grade_id={own['grade_id']}", user, request)
    other = db.execute("SELECT gr.grade_id FROM grade gr JOIN grade_sheet gs USING(sheet_id) WHERE gs.examiner_id<>%s LIMIT 1", (teacher,)).fetchone()
    with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
        preview(db, f"UPDATE grade SET points=30,is_absent=false WHERE grade_id={other['grade_id']}", user, request)
    slot = db.execute("SELECT ss.slot_id,s.student_id FROM schedule_slot ss JOIN teaching_assignment ta USING(assignment_id) JOIN student s USING(group_id) WHERE ta.teacher_id=%s LIMIT 1", (teacher,)).fetchone()
    cmd = parse_change(f"INSERT INTO attendance(slot_id,student_id,lesson_date,is_present) VALUES({slot['slot_id']},{slot['student_id']},'2026-10-01',true)")
    assert db.execute("SELECT backend_api.command_authorized(%s,%s,'prepare') AS allowed", (Jsonb(cmd), user)).fetchone()["allowed"]
    assert not db.execute("SELECT backend_api.command_authorized(%s,%s,'execute') AS allowed", (Jsonb(cmd), user)).fetchone()["allowed"]
    admin, _ = actor(db)
    fresh = db.execute("SELECT ta.item_id,ta.group_id,s.student_id FROM teaching_assignment ta JOIN student s USING(group_id) JOIN student_status st USING(status_id) WHERE ta.teacher_id=%s AND st.is_active AND NOT EXISTS(SELECT 1 FROM grade_sheet gs WHERE gs.item_id=ta.item_id AND gs.group_id=ta.group_id AND gs.stage='final' AND gs.sheet_kind='main' AND gs.status<>'cancelled') LIMIT 1", (teacher,)).fetchone()
    assert fresh
    sheet = db.execute("INSERT INTO grade_sheet(sheet_number,item_id,group_id,examiner_id,stage,sheet_kind,issue_date,exam_date) VALUES(%s,%s,%s,%s,%s,'main',CURRENT_DATE,CURRENT_DATE) RETURNING sheet_id", ("P09-"+uuid4().hex[:12],fresh["item_id"],fresh["group_id"],teacher,"final")).fetchone()["sheet_id"]
    prepared = preview(db, f"INSERT INTO grade(sheet_id,student_id,points,is_absent) VALUES({sheet},{fresh['student_id']},30,false)", user, request)
    assert db.execute("SELECT count(*) AS n FROM grade WHERE sheet_id=%s", (sheet,)).fetchone()["n"] == 0
    saved = apply(db, prepared["command"], user, request, admin)
    assert saved["points"] == 30
    updated = preview(db, f"UPDATE grade SET points=31 WHERE grade_id={saved['grade_id']}", user, request)
    assert apply(db, updated["command"], user, request, admin)["points"] == 31
    assert db.execute("SELECT app_user_id,agent_request_id FROM audit_log WHERE table_name='grade' AND record_key=%s ORDER BY audit_id DESC LIMIT 1", (f"grade_id={saved['grade_id']}",)).fetchone() == {"app_user_id": admin, "agent_request_id": request}


def test_student_root_request_limits_and_manual_registry_unchanged(database):
    from backend import resources
    db = database
    user, request = actor(db, "ivanov.ks")
    doc = db.execute("SELECT document_type_id FROM document_type LIMIT 1").fetchone()["document_type_id"]
    result = preview(db, f"INSERT INTO document_request(document_type_id,copies,purpose) VALUES({doc},1,'P09 own request')", user, request)
    admin, _ = actor(db)
    row = apply(db, result["command"], user, request, admin)
    assert row["student_id"] == db.execute("SELECT student_id FROM backend_api.account_snapshot(%s)", (user,)).fetchone()["student_id"]
    for field in ("request_status_id=1", "completed_at=NULL", "processed_by_id=NULL"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
            preview(db, f"UPDATE document_request SET {field} WHERE request_id={row['request_id']}", user, request)
    for name in ("grade", "grade_sheet", "attendance", "contact_person"):
        assert name not in resources.RESOURCES and name not in resources.FORM_FIELDS


def test_new_agent_facts_are_scoped_before_aggregation_and_private(database):
    from backend import resources
    db = database
    user, _ = actor(db, "ivanov.ks")
    own = db.execute("SELECT student_id FROM backend_api.account_snapshot(%s)", (user,)).fetchone()["student_id"]
    for name in ("grade", "attendance", "v_last_result", "v_debtors", "scholarship", "order_student"):
        rows = [json.loads(r["data"]) for r in db.execute("SELECT agent_backend.agent_rows_for_actor(%s,%s) AS data", (name, user))]
        assert all(row["student_id"] == own for row in rows)
        assert resources.spec(db, name, "student", agent=True).read_fields
    teacher, _ = actor(db, "novikov")
    allowed = db.execute("SELECT count(*) AS n FROM agent_backend.allowed_grades(%s)", (teacher,)).fetchone()["n"]
    assert allowed < db.execute("SELECT count(*) AS n FROM grade").fetchone()["n"]
    db.execute("SET LOCAL ROLE backend_executor")
    for query in ("SELECT agent_backend.agent_rows_for_actor('grade',1)", "SELECT backend_api.root_change_policy('grade')", "SELECT * FROM deanery.grade"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
            db.execute(query)


def synthetic_run(db, login):
    user, _ = actor(db, login)
    token, worker = str(uuid4()), uuid4()
    auth = db.execute("INSERT INTO agent_backend.auth_session(user_id,csrf_hash,expires_at) VALUES(%s,%s,now()+interval '1 hour') RETURNING id", (user, sha256(b"p09-synthetic").digest())).fetchone()["id"]
    db.execute("INSERT INTO agent_backend.auth_token(token_hash,session_id,kind,generation,expires_at) VALUES(%s,%s,'access',0,now()+interval '1 hour')", (sha256(token.encode()).digest(),auth))
    run = db.execute("SELECT backend_api.start_agent_run(NULL,'P09 previous scoped context','[]',%s,%s) AS r", (uuid4(), token)).fetchone()["r"]
    db.execute("UPDATE agent_backend.agent_run SET status='running',lease_owner=%s,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=%s", (worker,run["run_id"]))
    return user,token,worker,run


@pytest.mark.parametrize("relation", ["examiner", "slot_assignment", "contact_link"])
def test_new_access_edges_revoke_running_context_and_hide_saved_history(database, relation):
    db = database
    login = "ivanov.ks" if relation == "contact_link" else "novikov"
    if relation == "slot_assignment":
        teacher = db.execute("SELECT a.teacher_id FROM app_user u CROSS JOIN LATERAL backend_api.account_snapshot(u.user_id) a WHERE u.login=%s", (login,)).fetchone()["teacher_id"]
        source = db.execute("SELECT ss.* FROM schedule_slot ss JOIN teaching_assignment ta USING(assignment_id) WHERE ta.teacher_id=%s LIMIT 1", (teacher,)).fetchone()
        alternative = db.execute("SELECT assignment_id FROM teaching_assignment WHERE teacher_id<>%s AND group_id<>(SELECT group_id FROM teaching_assignment WHERE assignment_id=%s) LIMIT 1", (teacher,source["assignment_id"])).fetchone()["assignment_id"]
        # A past single-day slot has no attendance and cannot clash with current schedules.
        term = db.execute("SELECT term_id,start_date FROM academic_term WHERE end_date<CURRENT_DATE ORDER BY start_date LIMIT 1").fetchone()
        slot = db.execute("INSERT INTO schedule_slot(assignment_id,classroom_id,weekday,pair_number,term_id,valid_from,valid_to) VALUES(%s,%s,6,(SELECT max(pair_number) FROM pair_time),%s,%s,%s) RETURNING slot_id", (source["assignment_id"],source["classroom_id"],term["term_id"],term["start_date"],term["start_date"])).fetchone()["slot_id"]
    elif relation == "contact_link":
        student = db.execute("SELECT a.student_id FROM app_user u CROSS JOIN LATERAL backend_api.account_snapshot(u.user_id) a WHERE u.login=%s", (login,)).fetchone()["student_id"]
        contact = db.execute("INSERT INTO contact_person(last_name,first_name,email) VALUES('P09','Synthetic',%s) RETURNING contact_person_id", (uuid4().hex+"@example.test",)).fetchone()["contact_person_id"]
        db.execute("INSERT INTO student_contact(student_id,contact_person_id,relation_id) SELECT %s,%s,relation_id FROM contact_relation LIMIT 1", (student,contact))
    user,token,worker,run = synthetic_run(db,login)
    assert db.execute("SELECT backend_api.agent_run_read_context(%s,%s) AS r", (run["run_id"],worker)).fetchone()["r"]
    before = db.execute("SELECT agent_backend.scope_signature(%s) AS s", (user,)).fetchone()["s"]
    if relation == "examiner":
        target = db.execute("SELECT gs.sheet_id,t.employee_id FROM grade_sheet gs JOIN teacher own ON own.employee_id=gs.examiner_id JOIN teacher t ON t.department_id=own.department_id AND t.employee_id<>own.employee_id JOIN employee e ON e.employee_id=t.employee_id WHERE gs.examiner_id=(SELECT teacher_id FROM backend_api.account_snapshot(%s)) AND e.dismissal_date IS NULL LIMIT 1", (user,)).fetchone()
        db.execute("UPDATE grade_sheet SET examiner_id=%s WHERE sheet_id=%s", (target["employee_id"],target["sheet_id"]))
    elif relation == "slot_assignment":
        db.execute("UPDATE schedule_slot SET assignment_id=%s WHERE slot_id=%s", (alternative,slot))
    else:
        link = db.execute("SELECT sc.* FROM student_contact sc JOIN backend_api.allowed_students(%s) a USING(student_id) LIMIT 1", (user,)).fetchone()
        assert link
        db.execute("DELETE FROM student_contact WHERE student_id=%s AND contact_person_id=%s", (link["student_id"],link["contact_person_id"]))
    assert db.execute("SELECT agent_backend.scope_signature(%s) AS s", (user,)).fetchone()["s"] != before
    with pytest.raises(psycopg.Error) as rejected, db.transaction():
        db.execute("SELECT backend_api.agent_run_read_context(%s,%s)", (run["run_id"],worker))
    assert rejected.value.sqlstate == "P8008"
    messages = db.execute("SELECT backend_api.chat_messages(%s,%s,100,0) AS r", (run["session_id"],token)).fetchone()["r"]
    assert all("previous scoped context" not in item["text"] for item in messages["items"])
    assert all(item["tools"] == [] and item["proposals"] == [] for item in messages["items"])


def test_new_scope_hash_ignores_grade_values_and_display_names(database):
    db = database
    user, _ = actor(db, "novikov")
    teacher = db.execute("SELECT teacher_id FROM backend_api.account_snapshot(%s)", (user,)).fetchone()["teacher_id"]
    fresh = db.execute("SELECT ta.item_id,ta.group_id,s.student_id,s.person_id FROM teaching_assignment ta JOIN student s USING(group_id) JOIN student_status st USING(status_id) WHERE ta.teacher_id=%s AND st.is_active AND NOT EXISTS(SELECT 1 FROM grade_sheet gs WHERE gs.item_id=ta.item_id AND gs.group_id=ta.group_id AND gs.stage='final' AND gs.sheet_kind='main' AND gs.status<>'cancelled') LIMIT 1", (teacher,)).fetchone()
    sheet = db.execute("INSERT INTO grade_sheet(sheet_number,item_id,group_id,examiner_id,stage,issue_date,exam_date) VALUES(%s,%s,%s,%s,'final',CURRENT_DATE,CURRENT_DATE) RETURNING sheet_id", ("P09-"+uuid4().hex[:12],fresh["item_id"],fresh["group_id"],teacher)).fetchone()["sheet_id"]
    grade = db.execute("INSERT INTO grade(sheet_id,student_id,points) VALUES(%s,%s,30) RETURNING grade_id", (sheet,fresh["student_id"])).fetchone()["grade_id"]
    before = db.execute("SELECT agent_backend.scope_signature(%s) AS s", (user,)).fetchone()["s"]
    db.execute("UPDATE grade SET points=31 WHERE grade_id=%s", (grade,))
    db.execute("UPDATE person SET first_name=first_name||'P09' WHERE person_id=%s", (fresh["person_id"],))
    assert db.execute("SELECT agent_backend.scope_signature(%s) AS s", (user,)).fetchone()["s"] == before


def execute_previewed(db, sql, user, request, decider=None):
    command = parse_change(sql)
    table, pk = command["resource"], ALLOWED[command["resource"]]["pk"]
    before = db.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"]
    audit_before = db.execute("SELECT count(*) AS n FROM audit_log").fetchone()["n"]
    original = db.execute("SELECT backend_api.command_row(%s) AS r", (Jsonb(command),)).fetchone()["r"]
    prepared = preview(db, sql, user, request)
    assert db.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == before
    assert db.execute("SELECT count(*) AS n FROM audit_log").fetchone()["n"] == audit_before
    assert db.execute("SELECT backend_api.command_row(%s) AS r", (Jsonb(command),)).fetchone()["r"] == original
    saved = apply(db, prepared["command"], user, request, decider)
    assert db.execute(f"SELECT to_jsonb(t) AS r FROM {table} t WHERE {pk}=%s", (saved[pk],)).fetchone()["r"] == saved
    assert db.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == before + (command["operation"] == "create")
    assert db.execute("SELECT app_user_id,agent_request_id,operation FROM audit_log WHERE table_name=%s AND record_key=%s ORDER BY audit_id DESC LIMIT 1",
                      (table, f"{pk}={saved[pk]}")).fetchone() == {
        "app_user_id": decider or user, "agent_request_id": request,
        "operation": "I" if command["operation"] == "create" else "U"}
    return saved


@pytest.mark.parametrize("table", ["contact_person", "organization_contact"])
def test_root_contact_writes_require_admin_even_when_target_disappears(database, table):
    db = database
    admin, request = actor(db)
    organization = db.execute('SELECT organization_id FROM organization LIMIT 1').fetchone()['organization_id']
    extra = f",organization_id,job_title) VALUES('Policy','Contact','{uuid4().hex}@example.test',{organization},'Mentor')" if table == 'organization_contact' else f") VALUES('Policy','Contact','{uuid4().hex}@example.test')"
    sql = f'INSERT INTO {table}(last_name,first_name,email' + extra
    saved = execute_previewed(db, sql, admin, request)
    update = f"UPDATE {table} SET first_name='Changed' WHERE {ALLOWED[table]['pk']}={saved[ALLOWED[table]['pk']]}"
    for login in ('smirnov', 'kuznetsova', 'novikov', 'ivanov.ks'):
        user, own_request = actor(db, login)
        for text in (sql, update):
            with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
                preview(db, text, user, own_request)
        missing = parse_change(f"UPDATE {table} SET first_name='Changed' WHERE {ALLOWED[table]['pk']}=2147483647")
        assert not db.execute("SELECT backend_api.root_change_authorized(%s,%s,'execute',%s) AS allowed",
                              (Jsonb(missing), user, db.execute('SELECT institute_id FROM backend_api.account_snapshot(%s) a CROSS JOIN LATERAL unnest(a.institute_ids) institute_id LIMIT 1', (admin,)).fetchone()['institute_id'])).fetchone()['allowed']


@pytest.mark.parametrize("table", ["contact_person", "organization_contact"])
def test_root_admin_contact_insert_update_and_source_guards(database, table):
    db = database
    user, request = actor(db)
    email = uuid4().hex + "@example.test"
    organization = db.execute("SELECT organization_id FROM organization LIMIT 1").fetchone()["organization_id"]
    extra = f",organization_id,job_title) VALUES('P09','Contact','{email}',{organization},'Mentor')" if table == "organization_contact" else f") VALUES('P09','Contact','{email}')"
    links_before = db.execute("SELECT count(*) AS n FROM student_contact").fetchone()["n"]
    saved = execute_previewed(db, f"INSERT INTO {table}(last_name,first_name,email" + extra, user, request)
    pk = ALLOWED[table]["pk"]
    updated = execute_previewed(db, f"UPDATE {table} SET middle_name='Updated',phone='+79991234567' WHERE {pk}={saved[pk]}", user, request)
    assert updated["middle_name"] == "Updated" and updated["phone"] == "+79991234567"
    assert db.execute("SELECT count(*) AS n FROM student_contact").fetchone()["n"] == links_before
    bad = "organization_id=2147483647" if table == "organization_contact" else "email=NULL,phone=NULL"
    expected = psycopg.errors.ForeignKeyViolation if table == "organization_contact" else psycopg.errors.CheckViolation
    with pytest.raises(expected), db.transaction():
        preview(db, f"UPDATE {table} SET {bad} WHERE {pk}={saved[pk]}", user, request)


def test_root_academic_work_writes_and_teacher_topic_boundary(database):
    db = database
    admin, request = actor(db)
    teacher_user, teacher_request = actor(db, "novikov")
    teacher = db.execute("SELECT teacher_id FROM backend_api.account_snapshot(%s)", (teacher_user,)).fetchone()["teacher_id"]
    source = db.execute("""SELECT s.student_id,ci.item_id FROM student s JOIN study_group g USING(group_id)
        JOIN curriculum_item ci USING(curriculum_id) JOIN discipline d USING(discipline_id)
        WHERE d.kind IN ('coursework','final_attestation') AND fn_group_institute(g.group_id)=
        (SELECT dep.institute_id FROM teacher t JOIN department dep USING(department_id) WHERE t.employee_id=%s)
        AND NOT EXISTS(SELECT 1 FROM academic_work w WHERE w.student_id=s.student_id AND w.item_id=ci.item_id)
        ORDER BY s.student_id,ci.item_id LIMIT 1""", (teacher,)).fetchone()
    saved = execute_previewed(db, f"INSERT INTO academic_work(student_id,item_id,topic,supervisor_id) VALUES({source['student_id']},{source['item_id']},'P09 topic',{teacher})", admin, request)
    updated = execute_previewed(db, f"UPDATE academic_work SET topic='P09 revised topic' WHERE work_id={saved['work_id']}", teacher_user, teacher_request, admin)
    assert updated["topic"] == "P09 revised topic"
    with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
        preview(db, f"UPDATE academic_work SET reviewer_id=NULL WHERE work_id={saved['work_id']}", teacher_user, teacher_request)
    foreign = db.execute("SELECT t.employee_id FROM teacher t JOIN department d USING(department_id) JOIN employee e USING(employee_id) WHERE d.institute_id<>fn_group_institute((SELECT group_id FROM student WHERE student_id=%s)) AND e.dismissal_date IS NULL LIMIT 1", (source["student_id"],)).fetchone()["employee_id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
        preview(db, f"UPDATE academic_work SET supervisor_id={foreign} WHERE work_id={saved['work_id']}", admin, request)
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        preview(db, f"UPDATE academic_work SET reviewer_id={teacher} WHERE work_id={saved['work_id']}", admin, request)
    wrong_item = db.execute("SELECT ci.item_id FROM student s JOIN study_group g USING(group_id) JOIN curriculum_item ci USING(curriculum_id) JOIN discipline d USING(discipline_id) WHERE s.student_id=%s AND d.kind='practice' LIMIT 1", (source["student_id"],)).fetchone()["item_id"]
    with pytest.raises(psycopg.errors.RaiseException, match="курсовой"), db.transaction():
        preview(db, f"INSERT INTO academic_work(student_id,item_id,topic,supervisor_id) VALUES({source['student_id']},{wrong_item},'Invalid kind',{teacher})", admin, request)


def test_root_practice_insert_update_and_reference_guards(database):
    db = database
    user, request = actor(db)
    source = db.execute("""SELECT s.student_id,ci.item_id,t.employee_id AS supervisor_id
        FROM student s JOIN study_group g USING(group_id) JOIN curriculum_item ci USING(curriculum_id)
        JOIN discipline d USING(discipline_id) JOIN department dep ON dep.institute_id=fn_group_institute(g.group_id)
        JOIN teacher t ON t.department_id=dep.department_id JOIN employee e USING(employee_id)
        WHERE d.kind='practice' AND e.dismissal_date IS NULL
        AND NOT EXISTS(SELECT 1 FROM practice_placement p WHERE p.student_id=s.student_id AND p.item_id=ci.item_id)
        ORDER BY s.student_id,ci.item_id,t.employee_id LIMIT 1""").fetchone()
    contact = db.execute("SELECT org_contact_id FROM organization_contact LIMIT 1").fetchone()["org_contact_id"]
    saved = execute_previewed(db, f"INSERT INTO practice_placement(student_id,item_id,supervisor_id,org_contact_id,start_date,end_date) VALUES({source['student_id']},{source['item_id']},{source['supervisor_id']},{contact},'2026-09-01','2026-09-15')", user, request)
    updated = execute_previewed(db, f"UPDATE practice_placement SET end_date='2026-09-20' WHERE placement_id={saved['placement_id']}", user, request)
    assert updated["end_date"] == "2026-09-20"
    for fields, expected in (("end_date='2026-08-01'", psycopg.errors.CheckViolation), ("org_contact_id=2147483647", psycopg.errors.ForeignKeyViolation)):
        with pytest.raises(expected), db.transaction():
            preview(db, f"UPDATE practice_placement SET {fields} WHERE placement_id={saved['placement_id']}", user, request)
    wrong_order = db.execute("SELECT order_id FROM academic_order o JOIN order_type ot USING(order_type_id) WHERE ot.code<>'practice' LIMIT 1").fetchone()["order_id"]
    with pytest.raises(psycopg.errors.RaiseException, match="нужного типа"), db.transaction():
        preview(db, f"UPDATE practice_placement SET order_id={wrong_order} WHERE placement_id={saved['placement_id']}", user, request)


def test_root_sheet_insert_update_and_lifecycle_guards(database):
    db = database
    user, request = actor(db)
    source = db.execute("""SELECT ta.item_id,ta.group_id,ta.teacher_id,CURRENT_DATE AS today
        FROM teaching_assignment ta JOIN teacher t ON t.employee_id=ta.teacher_id
        JOIN department d USING(department_id) JOIN employee e USING(employee_id)
        WHERE d.institute_id=fn_group_institute(ta.group_id) AND e.dismissal_date IS NULL LIMIT 1""").fetchone()
    saved = execute_previewed(db, f"INSERT INTO grade_sheet(sheet_number,item_id,group_id,examiner_id,stage,sheet_kind,issue_date,exam_date) VALUES('P09-{uuid4().hex[:12]}',{source['item_id']},{source['group_id']},{source['teacher_id']},'final','individual','{source['today']}','{source['today']}')", user, request)
    with pytest.raises(psycopg.errors.RaiseException, match="пустую ведомость"), db.transaction():
        preview(db, f"UPDATE grade_sheet SET status='closed',closed_date='{source['today']}' WHERE sheet_id={saved['sheet_id']}", user, request)
    with pytest.raises(psycopg.errors.ForeignKeyViolation), db.transaction():
        preview(db, f"UPDATE grade_sheet SET examiner_id=2147483647 WHERE sheet_id={saved['sheet_id']}", user, request)
    updated = execute_previewed(db, f"UPDATE grade_sheet SET status='cancelled' WHERE sheet_id={saved['sheet_id']}", user, request)
    assert updated["status"] == "cancelled"
    with pytest.raises(psycopg.errors.RaiseException, match="изменить её статус нельзя"), db.transaction():
        preview(db, f"UPDATE grade_sheet SET status='open' WHERE sheet_id={saved['sheet_id']}", user, request)
    student, student_request = actor(db, "ivanov.ks")
    with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
        preview(db, f"UPDATE grade_sheet SET exam_date=NULL WHERE sheet_id={saved['sheet_id']}", student, student_request)


def test_root_assignment_slot_attendance_actual_writes_and_guards(database):
    db = database
    admin, request = actor(db)
    teacher_user, teacher_request = actor(db, "novikov")
    teacher = db.execute("SELECT teacher_id FROM backend_api.account_snapshot(%s)", (teacher_user,)).fetchone()["teacher_id"]
    source = db.execute("""SELECT ta.item_id,ta.group_id,ta.teacher_id,ta.lesson_type_id,t.term_id,
        day::date AS lesson_date,pt.pair_number,cr.classroom_id,
        CASE WHEN fn_week_number(t.start_date,day::date) %% 2=1 THEN 'odd' ELSE 'even' END AS parity
        FROM teaching_assignment ta JOIN curriculum_item ci USING(item_id) JOIN curriculum c USING(curriculum_id)
        JOIN academic_term t ON ci.semester=2*(EXTRACT(YEAR FROM t.start_date)::INT-c.start_year)
            + CASE WHEN EXTRACT(MONTH FROM t.start_date)>=7 THEN 1 ELSE 0 END
        CROSS JOIN LATERAL generate_series(t.start_date,LEAST(t.end_date,CURRENT_DATE),'1 day'::interval) day
        CROSS JOIN LATERAL (SELECT max(pair_number) AS pair_number FROM pair_time) pt
        CROSS JOIN LATERAL (SELECT classroom_id FROM classroom ORDER BY capacity DESC LIMIT 1) cr
        WHERE ta.teacher_id=%s AND EXTRACT(ISODOW FROM day)=6
        AND NOT EXISTS(SELECT 1 FROM holiday h WHERE h.holiday_date=day::date)
        AND NOT EXISTS(SELECT 1 FROM schedule_slot ss WHERE ss.weekday=6 AND ss.pair_number=pt.pair_number
            AND fn_slot_period(ss) @> day::date)
        AND NOT EXISTS(SELECT 1 FROM teaching_assignment a WHERE a.item_id=ta.item_id AND a.group_id=ta.group_id
            AND a.lesson_type_id=ta.lesson_type_id AND a.subgroup=1)
        ORDER BY t.start_date DESC,day LIMIT 1""", (teacher,)).fetchone()
    assert source
    assignment = execute_previewed(db, f"INSERT INTO teaching_assignment(item_id,group_id,teacher_id,lesson_type_id) VALUES({source['item_id']},{source['group_id']},{teacher},{source['lesson_type_id']})", admin, request)
    updated = execute_previewed(db, f"UPDATE teaching_assignment SET subgroup=1 WHERE assignment_id={assignment['assignment_id']}", admin, request)
    assert updated["subgroup"] == 1
    with pytest.raises(psycopg.errors.ForeignKeyViolation), db.transaction():
        preview(db, f"UPDATE teaching_assignment SET lesson_type_id=2147483647 WHERE assignment_id={assignment['assignment_id']}", admin, request)
    slot_sql = f"INSERT INTO schedule_slot(assignment_id,classroom_id,weekday,pair_number,term_id,valid_from,valid_to) VALUES({assignment['assignment_id']},{source['classroom_id']},6,{source['pair_number']},{source['term_id']},'{source['lesson_date']}','{source['lesson_date']}')"
    slot = execute_previewed(db, slot_sql, admin, request)
    updated = execute_previewed(db, f"UPDATE schedule_slot SET week_parity='{source['parity']}' WHERE slot_id={slot['slot_id']}", admin, request)
    assert updated["week_parity"] == source["parity"]
    with pytest.raises(psycopg.errors.RaiseException, match="Конфликт расписания"), db.transaction():
        preview(db, slot_sql, admin, request)
    with pytest.raises(psycopg.errors.ForeignKeyViolation), db.transaction():
        preview(db, f"UPDATE schedule_slot SET classroom_id=2147483647 WHERE slot_id={slot['slot_id']}", admin, request)
    student = db.execute("SELECT student_id FROM student s JOIN student_status st USING(status_id) WHERE s.group_id=%s AND st.is_active LIMIT 1", (source["group_id"],)).fetchone()["student_id"]
    attendance = execute_previewed(db, f"INSERT INTO attendance(slot_id,student_id,lesson_date,is_present) VALUES({slot['slot_id']},{student},'{source['lesson_date']}',true)", teacher_user, teacher_request, admin)
    updated = execute_previewed(db, f"UPDATE attendance SET is_present=false,absence_reason='P09 excused' WHERE attendance_id={attendance['attendance_id']}", teacher_user, teacher_request, admin)
    assert updated["is_present"] is False and updated["absence_reason"] == "P09 excused"
    future = db.execute("SELECT CURRENT_DATE+1 AS day").fetchone()["day"]
    with pytest.raises(psycopg.errors.RaiseException, match="будущую дату"), db.transaction():
        preview(db, f"INSERT INTO attendance(slot_id,student_id,lesson_date,is_present) VALUES({slot['slot_id']},{student},'{future}',true)", teacher_user, teacher_request)
    foreign_slot = db.execute("SELECT ss.slot_id FROM schedule_slot ss JOIN teaching_assignment ta USING(assignment_id) WHERE ta.teacher_id<>%s LIMIT 1", (teacher,)).fetchone()["slot_id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
        preview(db, f"INSERT INTO attendance(slot_id,student_id,lesson_date,is_present) VALUES({foreign_slot},{student},'{source['lesson_date']}',true)", teacher_user, teacher_request)


def test_root_document_completed_at_is_actually_written(database):
    db = database
    user, request = actor(db)
    source = db.execute("SELECT student_id FROM student LIMIT 1").fetchone()
    doc = db.execute("SELECT document_type_id FROM document_type LIMIT 1").fetchone()["document_type_id"]
    status = db.execute("SELECT request_status_id FROM request_status WHERE name='Новая'").fetchone()["request_status_id"]
    saved = execute_previewed(db, f"INSERT INTO document_request(student_id,document_type_id,request_status_id,copies,purpose) VALUES({source['student_id']},{doc},{status},1,'P09 completed_at')", user, request)
    updated = execute_previewed(db, f"UPDATE document_request SET completed_at='{saved['created_at']}' WHERE request_id={saved['request_id']}", user, request)
    assert updated["completed_at"] == saved["created_at"]
