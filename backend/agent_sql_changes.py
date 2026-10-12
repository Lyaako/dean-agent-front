"""Turn the original ten-table literal SQL language into data, never SQL authority."""

from pglast import ast, parse_sql

from backend.agent_query import QueryRejected


ALLOWED = {
    "document_request": {
        "pk": "request_id",
        "insert": {"student_id", "document_type_id", "request_status_id", "copies", "purpose"},
        "update": {"request_status_id", "copies", "purpose", "processed_by_id", "completed_at"},
    },
    "academic_work": {
        "pk": "work_id",
        "insert": {"student_id", "item_id", "topic", "supervisor_id", "reviewer_id", "order_id"},
        "update": {"topic", "supervisor_id", "reviewer_id", "order_id"},
    },
    "grade": {
        "pk": "grade_id",
        "insert": {"sheet_id", "student_id", "points", "is_absent"},
        "update": {"points", "is_absent"},
    },
    "attendance": {
        "pk": "attendance_id",
        "insert": {"slot_id", "student_id", "lesson_date", "is_present", "absence_reason"},
        "update": {"is_present", "absence_reason"},
    },
    "grade_sheet": {
        "pk": "sheet_id",
        "insert": {"sheet_number", "item_id", "group_id", "examiner_id", "stage",
                   "sheet_kind", "issue_date", "exam_date", "closed_date", "status"},
        "update": {"examiner_id", "exam_date", "closed_date", "status"},
    },
    "practice_placement": {
        "pk": "placement_id",
        "insert": {"student_id", "item_id", "supervisor_id", "org_contact_id",
                   "start_date", "end_date", "order_id"},
        "update": {"supervisor_id", "org_contact_id", "start_date", "end_date", "order_id"},
    },
    "teaching_assignment": {
        "pk": "assignment_id",
        "insert": {"item_id", "group_id", "teacher_id", "lesson_type_id", "subgroup"},
        "update": {"teacher_id", "lesson_type_id", "subgroup"},
    },
    "schedule_slot": {
        "pk": "slot_id",
        "insert": {"assignment_id", "classroom_id", "weekday", "pair_number",
                   "week_parity", "term_id", "valid_from", "valid_to"},
        "update": {"classroom_id", "weekday", "pair_number", "week_parity",
                   "valid_from", "valid_to"},
    },
    "organization_contact": {
        "pk": "org_contact_id",
        "insert": {"organization_id", "last_name", "first_name", "middle_name",
                   "job_title", "phone", "email"},
        "update": {"organization_id", "last_name", "first_name", "middle_name",
                   "job_title", "phone", "email"},
    },
    "contact_person": {
        "pk": "contact_person_id",
        "insert": {"last_name", "first_name", "middle_name", "phone", "email"},
        "update": {"last_name", "first_name", "middle_name", "phone", "email"},
    },
}


def _literal(node):
    if not isinstance(node, ast.A_Const):
        raise QueryRejected("simple_literal_required")
    if node.isnull:
        return None
    value = node.val
    if isinstance(value, ast.Integer):
        return value.ival
    if isinstance(value, ast.Float):
        # Keep decimal spelling exact; PostgreSQL's typed row conversion validates it.
        return value.fval
    if isinstance(value, ast.String):
        return value.sval
    if isinstance(value, ast.Boolean):
        return value.boolval
    raise QueryRejected("simple_literal_required")


def parse_change(sql: str) -> dict:
    if not isinstance(sql, str) or not 1 <= len(sql) <= 4000:
        raise QueryRejected("query_length")
    try:
        statements = parse_sql(sql)
    except Exception:
        raise QueryRejected("invalid_sql") from None
    if len(statements) != 1 or not isinstance(statements[0].stmt, (ast.InsertStmt, ast.UpdateStmt)):
        raise QueryRejected("insert_or_update_required")
    node = statements[0].stmt
    relation = node.relation
    if (relation.catalogname or relation.schemaname not in (None, "deanery") or
            relation.alias or relation.relname not in ALLOWED):
        raise QueryRejected("resource_forbidden")
    if node.withClause or node.returningClause:
        raise QueryRejected("unsupported_statement")
    policy = ALLOWED[relation.relname]
    if isinstance(node, ast.InsertStmt):
        source = node.selectStmt
        if (node.onConflictClause or node.override.value or not isinstance(source, ast.SelectStmt) or
                len(source.valuesLists or ()) != 1 or any(getattr(source, name) for name in source
                    if name not in {"valuesLists", "limitOption", "op"})):
            raise QueryRejected("single_values_row_required")
        if source.op.value or source.limitOption.value:
            raise QueryRejected("single_values_row_required")
        targets = node.cols or ()
        columns = [item.name for item in targets]
        if any(item.indirection or item.val for item in targets):
            raise QueryRejected("column_forbidden")
        values = source.valuesLists[0]
        operation, key, permitted = "create", {}, policy["insert"]
    else:
        if node.fromClause:
            raise QueryRejected("update_from_forbidden")
        targets = node.targetList or ()
        columns = [item.name for item in targets]
        if any(item.indirection for item in targets):
            raise QueryRejected("column_forbidden")
        values = [item.val for item in targets]
        where = node.whereClause
        if (not isinstance(where, ast.A_Expr) or where.kind.value or
                len(where.name or ()) != 1 or where.name[0].sval != "=" or
                not isinstance(where.lexpr, ast.ColumnRef) or len(where.lexpr.fields) != 1 or
                not isinstance(where.lexpr.fields[0], ast.String) or where.lexpr.fields[0].sval != policy["pk"] or
                not isinstance(where.rexpr, ast.A_Const) or not isinstance(where.rexpr.val, ast.Integer) or
                not 1 <= where.rexpr.val.ival <= 2147483647):
            raise QueryRejected("exact_primary_key_required")
        operation, key, permitted = "update", {policy["pk"]: where.rexpr.val.ival}, policy["update"]
    if not columns or len(columns) != len(set(columns)) or not set(columns) <= permitted or len(columns) != len(values):
        raise QueryRejected("column_forbidden")
    return {"version": 1, "kind": "sql_change", "resource": relation.relname,
            "operation": operation, "key": key, "fields": dict(zip(columns, map(_literal, values)))}
