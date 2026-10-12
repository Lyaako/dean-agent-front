"""The model's SQL must never name an unscoped relation or executable function."""

from types import SimpleNamespace
from uuid import uuid4

from pglast import parse_sql
import pytest

from backend.agent_query import QueryRejected, rewrite_query


def spec(**columns):
    return SimpleNamespace(read_fields=list(columns), fields={name: SimpleNamespace(type=kind) for name, kind in columns.items()})


SPECS = {"student": spec(student_id="integer", group_id="integer", record_book_number="character varying(20)"),
         "study_group": spec(group_id="integer", name="character varying(50)")}


def rewrite(query):
    return rewrite_query(query, SPECS, uuid4(), uuid4())


def test_scoped_sources_precede_join_and_aggregate():
    sql = rewrite("SELECT g.name, count(*) AS n FROM student s JOIN study_group g ON g.group_id=s.group_id GROUP BY g.name ORDER BY n DESC LIMIT 10")
    assert sql.count("backend_api.agent_visible_rows(") == 2
    assert "FROM student" not in sql and "JOIN study_group" not in sql
    assert "pg_catalog.count(*)" in sql and "jsonb_to_record" in sql
    assert parse_sql(sql)


@pytest.mark.parametrize("query", [
    "SELECT * FROM student LIMIT 5", "SELECT s.* FROM student s LIMIT 5",
    "SELECT student_id FROM student", "SELECT student_id FROM student LIMIT 61",
    "SELECT student_id FROM student LIMIT 1; DELETE FROM student",
    "SELECT student_id FROM student LIMIT $1", "SELECT student_id FROM student LIMIT 1 OFFSET -1",
    "SELECT student_id FROM student ORDER BY student_id FETCH FIRST 5 ROWS WITH TIES",
    "SELECT student_id FROM student LIMIT 1 FOR UPDATE", "SELECT student_id INTO tmp FROM student LIMIT 1",
    "WITH changed AS (DELETE FROM student RETURNING student_id) SELECT student_id FROM changed LIMIT 1",
    "SELECT oid FROM pg_catalog.pg_class LIMIT 1", "SELECT table_name FROM information_schema.tables LIMIT 1",
    "SELECT password_hash FROM app_user LIMIT 1", "SELECT funding_type_id FROM student LIMIT 1",
    "SELECT count(s) FROM student s LIMIT 1", "SELECT s.ctid FROM student s LIMIT 1",
    "SELECT pg_sleep(1) FROM student LIMIT 1", "SELECT set_config('app.user_id','1',true) FROM student LIMIT 1",
    "SELECT evil.count(*) FROM student LIMIT 1", "SELECT student_id::regclass FROM student LIMIT 1",
    "SELECT current_user FROM student LIMIT 1", "SELECT student_id FROM other.student LIMIT 1",
    "SELECT student_id FROM student s(a,b,c) LIMIT 1", "SELECT student_id FROM student TABLESAMPLE SYSTEM(1) LIMIT 1",
    "SELECT student_id FROM student ORDER BY student_id USING OPERATOR(evil.<) LIMIT 1",
    "SELECT student_id FROM student WHERE student_id OPERATOR(evil.=) 1 LIMIT 1",
    "SELECT (SELECT password_hash FROM app_user) FROM student LIMIT 1",
    "SELECT group_id FROM student JOIN study_group ON true LIMIT 1",
    "SELECT student_id FROM student UNION SELECT student_id FROM student LIMIT 1",
    "SELECT student_id FROM student, generate_series(1,100) LIMIT 1",
])
def test_unsafe_or_unscoped_sql_is_rejected(query):
    with pytest.raises(QueryRejected):
        rewrite(query)


def test_supported_expressions_and_schema_alias_keep_precision():
    sql = rewrite("SELECT student_id, CASE WHEN student_id>0 THEN 1.23456789123456789 ELSE 0 END AS n FROM deanery.student WHERE record_book_number ILIKE 'abc%' AND student_id IN (1,2) ORDER BY n LIMIT 60 OFFSET 5")
    assert "1.23456789123456789" in sql
    assert "FROM deanery.student" not in sql


def test_bad_type_metadata_and_length_fail_closed():
    with pytest.raises(QueryRejected):
        rewrite_query("SELECT student_id FROM student LIMIT 1", {"student": spec(student_id="evil_type")}, uuid4(), uuid4())
    with pytest.raises(QueryRejected):
        rewrite(" " * 6001)
