"""The fixed React resource registry and scoped read adapter."""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from decimal import Decimal, InvalidOperation
import json
import re

from fastapi import HTTPException
from psycopg import Connection
from psycopg import sql

from backend.contracts import Me, ResourceField, ResourcePage, ResourceSpec, SchemaResponse


ALL = ("admin", "director", "dean_staff", "teacher", "student")
STAFF = ALL[:3]
NO_TEACHER = STAFF + ("student",)
NO_STUDENT = STAFF + ("teacher",)
REFERENCE_WRITES = {"scholarship_type", "document_type", "request_status", "order_type", "leave_reason",
    "contact_relation", "specialty", "study_program", "classroom", "academic_term", "holiday"}
RESOURCES = {
    "student": ALL, "v_students": ALL, "v_student_summary": ALL,
    "study_group": ALL, "v_groups": ALL,
    "schedule_slot": ALL, "v_schedule_calendar": ALL,
    "academic_work": ALL, "v_academic_works": ALL,
    "practice_placement": ALL, "v_practice": ALL,
    "document_request": NO_TEACHER, "v_document_queue": NO_TEACHER,
    "employee": ALL, "dean_office_staff": ALL, "v_employees": NO_STUDENT, "v_teachers": NO_STUDENT,
    "person": ALL, "teaching_assignment": ALL, "v_schedule_hours": ALL,
    "curriculum": ALL, "curriculum_item": ALL, "v_curriculum": ALL, "study_program": ALL,
    "academic_order": STAFF, "organization": STAFF, "organization_contact": STAFF,
    "funding_type": ALL, "student_status": ALL, "document_type": ALL, "request_status": ALL,
    "leave_reason": ALL, "academic_term": ALL, "pair_time": ALL, "holiday": ALL,
    "study_form": ALL, "specialty": ALL, "score_band": ALL, "control_type": ALL,
    "lesson_type": ALL, "position": ALL, "education_level": ALL, "scholarship_type": ALL,
    "academic_degree": ALL, "academic_title": ALL, "contact_relation": ALL,
    "order_type": ALL, "classroom": ALL, "discipline": ALL,
    "grade": ALL, "grade_sheet": ALL, "attendance": ALL, "v_last_result": ALL, "v_debtors": ALL,
    "v_current_modules": ALL, "v_active_scholarships": NO_TEACHER, "v_student_orders": NO_TEACHER,
    "v_pending_orders": STAFF, "v_audit": STAFF, "app_user": ("admin",), "v_attendance": ALL,
}
# Additional facts belong to the agent's read schema, not the manual CRUD registry.
AGENT_RESOURCES = {**RESOURCES,
    "grade": ALL, "grade_sheet": ALL, "attendance": ALL, "v_last_result": ALL, "v_debtors": ALL,
    "scholarship": NO_TEACHER, "academic_leave": NO_TEACHER, "order_student": NO_TEACHER,
    "academic_order": NO_TEACHER, "grade_correction": ALL, "discipline": ALL,
    "institute": ALL, "department": ALL, "teacher": NO_STUDENT,
    "contact_person": NO_TEACHER, "student_contact": NO_TEACHER,
    "v_student_orders": NO_TEACHER, "v_pending_orders": NO_TEACHER, "v_academic_leaves": NO_TEACHER,
}
API_VIEWS = {"v_curriculum", "v_schedule_hours", "v_practice", "v_academic_works", "v_current_modules", "v_active_scholarships", "v_attendance"}
VIEW_KEYS = {
    "v_students": ["student_id"], "v_student_summary": ["student_id"],
    "v_groups": ["group_id"], "v_schedule_calendar": ["lesson_date", "slot_id"],
    "v_academic_works": ["work_id"], "v_practice": ["placement_id"],
    "v_document_queue": ["request_id"], "v_employees": ["employee_id"],
    "v_teachers": ["employee_id"], "v_schedule_hours": ["assignment_id"],
    "v_curriculum": ["item_id"],
    "v_last_result": ["student_id", "discipline_id", "semester", "stage"],
    "v_debtors": ["student_id", "discipline", "semester", "control_type"],
    "v_student_orders": ["student_id", "order_number"],
    "v_pending_orders": ["student_id", "order_number"],
    "v_academic_leaves": ["student_id", "order_number"],
    "v_current_modules": ["grade_id"], "v_active_scholarships": ["scholarship_id"],
    "v_audit": ["audit_id", "column_name"], "app_user": ["user_id"], "v_attendance": ["attendance_id"],
}
FORM_FIELDS = {
    "student": ["funding_type_id", "needs_dormitory", "is_foreign"],
    "study_group": ["name", "curriculum_id", "curator_id", "headman_id", "is_archived"],
    "schedule_slot": ["assignment_id", "classroom_id", "weekday", "pair_number", "week_parity", "term_id", "valid_from", "valid_to"],
    "academic_work": ["student_id", "item_id", "topic", "supervisor_id", "reviewer_id", "order_id"],
    "practice_placement": ["student_id", "item_id", "supervisor_id", "org_contact_id", "start_date", "end_date", "order_id"],
    "document_request": ["student_id", "document_type_id", "copies", "purpose", "request_status_id", "processed_by_id"],
    "person": ["last_name", "first_name", "middle_name"],
    "grade": ["sheet_id", "student_id", "points", "is_absent"],
    "grade_sheet": ["sheet_number", "item_id", "group_id", "examiner_id", "stage", "sheet_kind", "issue_date", "exam_date", "closed_date", "status"],
    "attendance": ["slot_id", "student_id", "lesson_date", "is_present", "absence_reason"],
}
WRITE = {
    "student": {"update": STAFF, "workflow": STAFF},
    "study_group": {"create": STAFF, "update": STAFF, "delete": STAFF},
    "schedule_slot": {"create": STAFF, "update": STAFF, "delete": STAFF},
    "academic_work": {"create": STAFF, "update": STAFF, "delete": STAFF},
    "practice_placement": {"create": STAFF, "update": STAFF, "delete": STAFF},
    "document_request": {"create": NO_TEACHER, "update": NO_TEACHER, "delete": STAFF},
    "person": {"update": STAFF},
    "grade": {"create": NO_STUDENT, "update": NO_STUDENT},
    "grade_sheet": {"create": STAFF, "update": STAFF},
    "attendance": {"create": NO_STUDENT, "update": NO_STUDENT},
}
WRITE.update({name: {"create": STAFF, "update": STAFF} for name in REFERENCE_WRITES})
HIDDEN = {"person": {"gender", "birth_date", "phone", "passport_series", "passport_number", "snils", "inn", "address", "created_at"}}
TEACHER_STUDENT_HIDDEN = {"funding_type_id", "needs_dormitory", "is_foreign"}
TEACHER_SUMMARY_HIDDEN = {"funding", "scholarships", "needs_dormitory", "is_foreign"}
TEACHER_LOOKUP_HIDDEN = {"gender", "birth_date", "phone", "email", "funding", "enrollment_date"}
DESCRIPTIONS = {"student_id": "Идентификатор студента", "group_id": "Идентификатор группы", "work_id": "Идентификатор работы", "placement_id": "Идентификатор практики", "assignment_id": "Идентификатор назначения", "item_id": "Идентификатор учебного плана"}
DELETE_ACTION = {"a": "NO ACTION", "r": "RESTRICT", "c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT"}


def _source(name: str) -> tuple[str, str]:
    if name == "app_user":
        return "backend_api", "v_accounts"
    return ("backend_api" if name in API_VIEWS else "deanery", name)


def _columns(db: Connection, name: str):
    schema, relation = _source(name)
    rows = db.execute(
        """SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
                  NOT a.attnotnull AS nullable,
                  CASE WHEN a.attidentity<>'' THEN 'identity' ELSE pg_get_expr(def.adbin,def.adrelid) END AS default,
                  col_description(c.oid,a.attnum) AS description,c.relkind AS kind
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
           LEFT JOIN pg_attrdef def ON def.adrelid=c.oid AND def.adnum=a.attnum
           WHERE n.nspname=%s AND c.relname=%s ORDER BY a.attnum""", (schema, relation),
    ).fetchall()
    if not rows:
        raise HTTPException(status_code=500, detail="schema_unavailable")
    return rows


def _keys(db: Connection, name: str) -> list[str]:
    if name in VIEW_KEYS:
        return VIEW_KEYS[name]
    schema, relation = _source(name)
    return [row["attname"] for row in db.execute(
        """SELECT a.attname FROM pg_constraint c
           JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace
           JOIN LATERAL generate_subscripts(c.conkey,1) k(i) ON true
           JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[k.i]
           WHERE n.nspname=%s AND cl.relname=%s AND c.contype='p' ORDER BY k.i""", (schema,relation),
    ).fetchall()]


def _relations(db: Connection, name: str) -> dict[str, dict[str, str]]:
    schema, relation = _source(name)
    rows = db.execute(
        """SELECT a.attname AS name,target.relname AS target_table,b.attname AS target_column,c.confdeltype
           FROM pg_constraint c JOIN pg_class source ON source.oid=c.conrelid
           JOIN pg_namespace n ON n.oid=source.relnamespace
           JOIN pg_class target ON target.oid=c.confrelid
           JOIN LATERAL generate_subscripts(c.conkey,1) k(i) ON true
           JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[k.i]
           JOIN pg_attribute b ON b.attrelid=c.confrelid AND b.attnum=c.confkey[k.i]
           WHERE n.nspname=%s AND source.relname=%s AND c.contype='f'""", (schema, relation),
    ).fetchall()
    return {row["name"]: {"table":row["target_table"], "column":row["target_column"], "on_delete":DELETE_ACTION[row["confdeltype"]]} for row in rows}


def spec(db: Connection, name: str, role: str, *, agent: bool = False) -> ResourceSpec:
    registry = AGENT_RESOURCES if agent else RESOURCES
    if name not in registry or role not in registry[name]:
        raise HTTPException(status_code=404, detail="not_found")
    columns = _columns(db, name)
    hidden = set(HIDDEN.get(name, set()))
    if role == "teacher" and name == "student":
        hidden |= TEACHER_STUDENT_HIDDEN
    if role == "teacher" and name == "v_student_summary":
        hidden |= TEACHER_SUMMARY_HIDDEN
    if role == "teacher" and name == "v_students":
        hidden |= TEACHER_LOOKUP_HIDDEN
    relations = _relations(db, name)
    fields = {
        row["name"]: ResourceField(
            type=row["type"], nullable=row["nullable"], default=row["default"],
            description=row["description"] or DESCRIPTIONS.get(row["name"]),
            relation=relations.get(row["name"]),
        ) for row in columns if row["name"] not in hidden
    }
    form = FORM_FIELDS.get(name, [])
    if name in REFERENCE_WRITES:
        form = [row["name"] for row in columns if row["default"] != "identity"]
    if name == "document_request" and role == "student":
        form = ["document_type_id", "copies", "purpose"]
    if name == "grade" and role == "teacher":
        form = ["sheet_id", "student_id", "points", "is_absent"]
    if role == "teacher" and name == "student":
        form = ["record_book_number", "group_id", "status_id"]
    if not set(form) <= fields.keys():
        raise HTTPException(status_code=500, detail="schema_unavailable")
    actions = {"read":list(registry[name])}
    actions.update({operation:list(roles) for operation,roles in WRITE.get(name,{}).items()})
    write_roles = list(dict.fromkeys(role for roles in WRITE.get(name,{}).values() for role in roles))
    return ResourceSpec(
        kind="view" if columns[0]["kind"] == "v" else "table", key=_keys(db,name),
        fields=fields,read_fields=list(fields),write_fields=form,
        read_roles=list(registry[name]),write_roles=write_roles,
        operations=list(actions),operation_roles=actions,
        workflow_only=["group_id", "status_id", "record_book_number"] if name == "student" else [],
    )


def schema(db: Connection, actor: Me) -> SchemaResponse:
    role = actor.roles[0]
    return SchemaResponse(version=1, resources={name: spec(db,name,role) for name in RESOURCES if role in RESOURCES[name]})


def _value(raw: str | int | float | Decimal | bool, sql_type: str):
    if raw is None:
        return None
    if sql_type in ("integer", "smallint", "bigint"):
        if not re.fullmatch(r"-?\d+", str(raw)):
            raise ValueError
        return int(raw)
    if sql_type.startswith("numeric"):
        return Decimal(str(raw))
    if sql_type == "boolean":
        if isinstance(raw,bool):
            return raw
        if str(raw).lower() not in ("true", "false"):
            raise ValueError
        return str(raw).lower() == "true"
    if sql_type == "date":
        return date.fromisoformat(str(raw))
    if sql_type.startswith("timestamp"):
        value = datetime.fromisoformat(str(raw))
        return value if value.tzinfo else value.replace(tzinfo=ZoneInfo("Europe/Moscow"))
    return str(raw)


def _json_safe(value):
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {key:_json_safe(item) for key,item in value.items()}
    return value


def list_rows(db: Connection, name: str, role: str, token: str, params: dict[str, str]) -> ResourcePage:
    info = spec(db, name, role)
    try:
        limit = int(params.get("limit", "100"))
        offset = int(params.get("offset", "0"))
    except ValueError:
        raise HTTPException(status_code=422, detail="invalid_value") from None
    if not 1 <= limit <= 500 or offset < 0:
        raise HTTPException(status_code=422, detail="invalid_value")
    filters = {}
    for key,value in params.items():
        if key in ("limit","offset","sort"):
            continue
        if key.endswith(("__gte","__lte")) and name in ("v_schedule_calendar", "v_audit"):
            field, comparator = key.rsplit("__",1)
        else:
            field, comparator = key, "eq"
        if field not in info.read_fields or comparator not in ("eq","gte","lte"):
            raise HTTPException(status_code=422, detail="invalid_filter")
        try:
            parsed = _value(value,info.fields[field].type)
            if isinstance(parsed, datetime) and comparator == "lte" and len(value) == 10:
                parsed += timedelta(days=1)-timedelta(microseconds=1)
            filters[key] = (field, comparator, parsed)
        except (ValueError,InvalidOperation):
            raise HTTPException(status_code=422, detail="invalid_value") from None
    ordering = params.get("sort", "")
    sort = ordering.split(",") if ordering else info.key
    if not sort or any(field not in info.read_fields for field in sort):
        raise HTTPException(status_code=422, detail="invalid_filter")
    def expression(field):
        # Names are validated against the registry; types come only from pg_catalog.
        return sql.SQL('(row->>{})::{}').format(sql.Literal(field),sql.SQL(info.fields[field].type))
    conditions=[]
    arguments=[name,token]
    for field,comparator,requested in filters.values():
        operator={'eq':'=','gte':'>=','lte':'<='}[comparator]
        conditions.append(sql.SQL('{} {} %s').format(expression(field),sql.SQL(operator)))
        arguments.append(requested)
    statement=sql.SQL('SELECT row::TEXT AS visible_rows FROM (SELECT visible_rows::JSONB AS row FROM backend_api.visible_rows(%s,%s)) scoped {} ORDER BY {} LIMIT %s OFFSET %s').format(
        sql.SQL('WHERE ')+sql.SQL(' AND ').join(conditions) if conditions else sql.SQL(''),
        sql.SQL(',').join(expression(field)+sql.SQL(' NULLS LAST') for field in dict.fromkeys(sort+info.key)))
    arguments.extend((limit+1,offset))
    rows=[json.loads(raw['visible_rows'],parse_float=Decimal) for raw in db.execute(statement,arguments)]
    return ResourcePage(items=[_json_safe(row) for row in rows[:limit]],limit=limit,offset=offset,has_more=len(rows)>limit)
