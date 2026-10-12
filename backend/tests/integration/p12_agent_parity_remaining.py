"""I150: four bounded natural form/real-agent cases on the owned P12 clone."""

from datetime import timedelta
import json
import sys
import traceback
from unittest.mock import patch
from uuid import uuid4

import httpx

from backend.agent_attachments import static_fingerprint
from backend.agent_tools import TOOL_NAMES
from backend.tests.integration.p12_agent_parity import DATABASE, ROOT, Runtime, save


AUTHOR = "kuznetsova"
DECIDER = "smirnov"
KEYS = {"practice_placement": "placement_id", "schedule_slot": "slot_id", "person": "person_id", "student": "student_id"}


def row(runtime, resource, identifier):
    key = KEYS[resource]
    with runtime.admin() as db:
        return db.execute(f"SELECT * FROM deanery.{resource} WHERE {key}=%s", (identifier,)).fetchone()


def evidence(runtime, case, suffix, value):
    save(runtime.prefix.with_name(runtime.prefix.name + "-" + case + "-" + suffix + ".json"), value)


def actual_model(runtime, case, message):
    submitted = []
    original = httpx.Client.send

    def capture(client, request, **kwargs):
        if request.method == "POST" and request.url.path == "/api/v1/agent/chat/stream":
            submitted.append(json.loads(request.content))
        return original(client, request, **kwargs)

    prior_runs = len(runtime.runs)
    try:
        with patch.object(httpx.Client, "send", capture):
            return runtime.model(case, AUTHOR, message)
    finally:
        frames = runtime.prefix.with_name(runtime.prefix.name + "-" + case + "-provider.jsonl")
        requests = [frame["request"] for line in frames.read_text(encoding="utf-8").splitlines()
                    if "request" in (frame := json.loads(line))] if frames.exists() else []
        stored = chat = None
        if len(runtime.runs) > prior_runs:
            run_id = runtime.runs[-1][1]
            with runtime.admin() as db:
                stored = db.execute("SELECT request_text FROM deanery.agent_request q JOIN agent_backend.agent_run r "
                    "USING(agent_request_id) WHERE r.id=%s", (run_id,)).fetchone()["request_text"]
                chat = db.execute("SELECT text FROM agent_backend.chat_message WHERE role='user' "
                    "AND metadata->>'run_id'=%s", (str(run_id),)).fetchone()["text"]
        proof = {"actual_API_bodies": submitted, "official_request_text": stored, "official_chat_text": chat,
                 "provider_calls": len(requests), "provider_user_matches": all(any(m["role"] == "user" and m["content"] == message
                    for m in p["messages"]) for p in requests),
                 "exact_13_tools": all({t["function"]["name"] for t in p["tools"]} == TOOL_NAMES for p in requests),
                 "fingerprints": [static_fingerprint(p, runtime.settings.context_window, runtime.settings.base_url) for p in requests]}
        evidence(runtime, case, "natural-input", proof)
        assert len(submitted) == 1 and submitted[0]["message"] == stored == chat == message
        assert 0 < len(requests) <= 8 and proof["provider_user_matches"] and proof["exact_13_tools"]
        assert all(f == runtime.settings.prompt_fingerprint for f in proof["fingerprints"])


def confirm(runtime, proposal):
    p = runtime.call(AUTHOR, "GET", "agent/proposals/" + str(proposal["id"]))
    assert p["actions"]["can_assign"]
    runtime.call(AUTHOR, "POST", "agent/proposals/" + p["id"] + "/assignment",
                 {"assignee_user_id": runtime.me(DECIDER)["user_id"], "expected_version": p["version"],
                  "reason": "Отдельная проверка другим сотрудником для синтетического сценария P12"})
    p = runtime.call(DECIDER, "GET", "agent/proposals/" + p["id"])
    assert p["actions"]["can_approve"]
    approved = runtime.call(DECIDER, "POST", "agent/proposals/" + p["id"] + "/decision",
                           {"approve": True, "expected_version": p["version"],
                            "reason": "Проверено отдельно по исходной форме в синтетическом сценарии P12"})
    assert (approved["status"], approved["execution"]["status"]) == ("approved", "succeeded")
    return approved


def audit_parity(runtime, direct, agent, proposal):
    assert direct["app_user_id"] == agent["app_user_id"] == runtime.me(DECIDER)["user_id"]
    assert direct["agent_request_id"] is None and agent["agent_request_id"] == proposal["agent_request_id"]
    assert proposal["initiator_user_id"] == runtime.me(AUTHOR)["user_id"] != agent["app_user_id"]


def record_case(runtime, resource, identifier, fields, message, invalid):
    key = KEYS[resource]
    path = f"resources/{resource}?{key}={identifier}"
    baseline = row(runtime, resource, identifier)
    assert baseline is not None
    restore = {name: baseline[name] for name in fields}
    restore = json.loads(json.dumps(restore, default=str))
    evidence(runtime, resource, "baseline", baseline)
    try:
        runtime.call("novikov", "PATCH", path, fields, status=403)
        runtime.call(DECIDER, "PATCH", path, invalid, status=422)
        assert row(runtime, resource, identifier) == baseline
        runtime.call(DECIDER, "PATCH", path, fields)
        form_row = row(runtime, resource, identifier)
        form_audit = runtime.audit(resource, key, identifier)
        evidence(runtime, resource, "form", {"row": form_row, "audit": form_audit, "fields": fields, "negative_status": 422})
        runtime.call(DECIDER, "PATCH", path, restore)
        assert row(runtime, resource, identifier) == baseline
        trace = actual_model(runtime, resource, message)
        assert row(runtime, resource, identifier) == baseline
        proposal = trace["proposals"][0]
        assert proposal["command"]["kind"] in ("record_change", "sql_change")
        assert proposal["command"] == {"version": 1, "kind": proposal["command"]["kind"], "resource": resource,
                                        "operation": "update", "key": {key: identifier}, "fields": fields}
        approved = confirm(runtime, proposal)
        assert row(runtime, resource, identifier) == form_row
        agent_audit = runtime.audit(resource, key, identifier)
        audit_parity(runtime, form_audit, agent_audit, proposal)
        return {"case": resource, "passed": True, "provider_calls": trace["provider_calls"], "prepare_no_effect": True,
                "exact_domain_row": True, "separate_decider": True, "form_audit": form_audit, "agent_audit": agent_audit,
                "proposal_id": str(proposal["id"]), "execution": approved["execution"]["status"]}
    finally:
        runtime.call(DECIDER, "PATCH", path, restore)
        restored = row(runtime, resource, identifier) == baseline
        evidence(runtime, resource, "restore", {"complete_baseline_restored": restored})
        assert restored


def practice(runtime):
    item = runtime.call(AUTHOR, "GET", "resources/practice_placement?sort=placement_id&limit=1")["items"][0]
    baseline = row(runtime, "practice_placement", item["placement_id"])
    fields = {"end_date": (baseline["end_date"] + timedelta(days=1)).isoformat()}
    message = (f"Существующее направление на практику имеет системный ID {item['placement_id']}. "
               f"Измени только дату окончания на {fields['end_date']}. Студент и остальные реквизиты остаются прежними. "
               "Причина: согласованное продление учебной практики на один день для синтетической проверки P12. "
               "Подготовь предложение для отдельного рассмотрения другим сотрудником.")
    return record_case(runtime, "practice_placement", item["placement_id"], fields, message, {"student_id": baseline["student_id"]})


def schedule(runtime):
    items = runtime.call(AUTHOR, "GET", "resources/schedule_slot?sort=slot_id&limit=500")["items"]
    item = next(x for x in items if x["valid_to"] is not None and (x["valid_from"] is None or x["valid_from"] < x["valid_to"]))
    baseline = row(runtime, "schedule_slot", item["slot_id"])
    fields = {"valid_to": (baseline["valid_to"] - timedelta(days=1)).isoformat()}
    message = (f"Для существующего занятия расписания №{item['slot_id']} измени только последний день действия "
               f"на {fields['valid_to']}, включительно. Аудиторию, учебное поручение, день недели и пару оставь прежними. "
               "Причина: согласованное сокращение периода занятия на один день для синтетической проверки P12. "
               "Подготовь предложение для отдельного рассмотрения другим сотрудником.")
    return record_case(runtime, "schedule_slot", item["slot_id"], fields, message, {"weekday": 7})


def fio(runtime):
    employee = runtime.call(AUTHOR, "GET", "resources/employee?sort=employee_id&limit=1")["items"][0]
    person = runtime.call(AUTHOR, "GET", f"resources/person?person_id={employee['person_id']}&limit=1")["items"][0]
    fields = {"last_name": "Проверочный", "first_name": "Пётр", "middle_name": "Тестович"}
    message = (f"Исправь ФИО сотрудника №{employee['employee_id']}, карточка физического лица №{person['person_id']}: "
               "фамилия Проверочный, имя Пётр, отчество Тестович. Меняются только эти три поля. "
               "Причина: исправление учебной карточки сотрудника по синтетическому заявлению P12. "
               "Подготовь предложение для отдельного рассмотрения другим сотрудником.")
    return record_case(runtime, "person", person["person_id"], fields, message, {"last_name": "П" * 61})


def order_rows(runtime, order_id, student_id):
    with runtime.admin() as db:
        order = db.execute("SELECT * FROM deanery.academic_order WHERE order_id=%s", (order_id,)).fetchone()
        link = db.execute("SELECT * FROM deanery.order_student WHERE order_id=%s AND student_id=%s", (order_id, student_id)).fetchone()
    return {"order": order, "student_link": link}


def transfer(runtime):
    groups = runtime.call(AUTHOR, "GET", "resources/study_group?is_archived=false&sort=group_id&limit=500")["items"]
    source, target = next((a, b) for a in groups for b in groups if a["group_id"] < b["group_id"] and a["curriculum_id"] == b["curriculum_id"])
    with runtime.admin() as db:
        db.execute("SET LOCAL search_path=pg_catalog,deanery")
        signer = db.execute("SELECT i.director_id FROM deanery.institute i JOIN deanery.study_group g "
                            "ON i.institute_id=deanery.fn_group_institute(g.group_id) WHERE g.group_id=%s", (source["group_id"],)).fetchone()["director_id"]
        today = db.execute("SELECT CURRENT_DATE AS day").fetchone()["day"].isoformat()
    assert runtime.call(AUTHOR, "GET", f"resources/employee?employee_id={signer}&limit=1")["items"]
    funding = runtime.call(AUTHOR, "GET", "resources/funding_type?sort=funding_type_id&limit=1")["items"][0]["name"]
    suffix = uuid4().hex[:10]
    enrolled = runtime.call(DECIDER, "POST", "workflows/enroll_student",
        {"order_number": "P12-E-" + suffix, "signed_by": signer, "last_name": "Проверочный", "first_name": "Студент",
         "gender": "M", "birth_date": "2005-01-01", "group_name": source["name"], "funding": funding, "record_book": "P12" + suffix})
    assert enrolled["status"] == "applied"
    identifier = enrolled["student_id"]
    assert runtime.call(AUTHOR, "GET", f"resources/student?student_id={identifier}&limit=1")["items"]
    baseline = row(runtime, "student", identifier)
    common = {"student_id": identifier, "group_name": target["name"], "signed_by": signer, "effective_date": today}
    form_fields = {**common, "order_number": "P12-F-" + suffix}
    agent_fields = {**common, "order_number": "P12-A-" + suffix}
    evidence(runtime, "transfer_student", "baseline", {"student": baseline, "enrollment": enrolled, "source": source, "target": target})

    def restore():
        if row(runtime, "student", identifier)["group_id"] != source["group_id"]:
            runtime.call(DECIDER, "POST", "workflows/transfer_student", {**common, "group_name": source["name"], "order_number": "P12-R-" + uuid4().hex[:10]})
        assert row(runtime, "student", identifier) == baseline

    try:
        runtime.call("novikov", "POST", "workflows/transfer_student", form_fields, status=403)
        runtime.call(DECIDER, "PATCH", f"resources/student?student_id={identifier}", {"group_id": target["group_id"]}, status=422)
        applied_form = runtime.call(DECIDER, "POST", "workflows/transfer_student", form_fields)
        assert applied_form["status"] == "applied"
        form_row = row(runtime, "student", identifier)
        form_order = order_rows(runtime, applied_form["order_id"], identifier)
        form_audit = runtime.audit("student", "student_id", identifier)
        evidence(runtime, "transfer_student", "form", {"student": form_row, "order": form_order, "audit": form_audit})
        restore()
        message = (f"Подготовь перевод только синтетического студента №{identifier}, зачётная книжка P12{suffix}, "
                   f"из группы {source['name']} в группу {target['name']} с {today}. "
                   f"Номер нового приказа {agent_fields['order_number']}, подписывает директор — сотрудник №{signer}. "
                   "Причина: личное заявление синтетического студента о смене учебной группы для проверки P12. "
                   "Подготовь одно предложение для отдельного рассмотрения другим сотрудником; остальные данные студента прежние.")
        trace = actual_model(runtime, "transfer_student", message)
        assert row(runtime, "student", identifier) == baseline
        with runtime.admin() as db:
            assert db.execute("SELECT count(*) AS n FROM deanery.academic_order WHERE order_number=%s", (agent_fields["order_number"],)).fetchone()["n"] == 0
        proposal = trace["proposals"][0]
        assert proposal["command"] == {"version": 1, "kind": "workflow", "name": "transfer_student", "fields": agent_fields}
        approved = confirm(runtime, proposal)
        assert row(runtime, "student", identifier) == form_row
        agent_order = order_rows(runtime, approved["execution"]["order_id"], identifier)
        exclusions = {"order": {"order_id", "order_number"}, "student_link": {"order_id", "applied_at"}}
        assert all({k:v for k,v in form_order[name].items() if k not in exclusions[name]} ==
                   {k:v for k,v in agent_order[name].items() if k not in exclusions[name]} for name in exclusions)
        assert form_order["student_link"]["applied_at"] and agent_order["student_link"]["applied_at"]
        agent_audit = runtime.audit("student", "student_id", identifier)
        audit_parity(runtime, form_audit, agent_audit, proposal)
        return {"case": "transfer_student", "passed": True, "provider_calls": trace["provider_calls"], "prepare_no_effect": True,
                "exact_student_domain_row": True, "order_domain_parity": True, "form_audit": form_audit, "agent_audit": agent_audit,
                "proposal_id": str(proposal["id"]), "retained_synthetic_student_id": identifier}
    finally:
        restore()
        evidence(runtime, "transfer_student", "restore", {"complete_student_baseline_restored": True,
                 "synthetic_student_retained": identifier, "official_orders_retained": True})


def run(selected=(practice, schedule, fio, transfer)):
    runtime = Runtime()
    results = []
    try:
        runtime.start()
        assert set(runtime.me(AUTHOR)["institute_ids"]) & set(runtime.me(DECIDER)["institute_ids"])
        for case in selected:
            try:
                result = case(runtime)
            except BaseException as exc:
                result = {"case": case.__name__, "passed": False, "error_type": type(exc).__name__}
                runtime.prefix.with_name(runtime.prefix.name + "-" + case.__name__ + "-error.log").write_text(traceback.format_exc(), encoding="utf-8")
            results.append(result)
            evidence(runtime, case.__name__, "outcome", result)
            print(json.dumps({k:v for k,v in result.items() if k in ("case", "passed", "error_type", "provider_calls")}), flush=True)
    finally:
        cleanup = runtime.close()
    count = sum(json.loads(path.read_text(encoding="utf-8"))["provider_calls"] for path in runtime.prefix.parent.glob(runtime.prefix.name + "-*-run.json"))
    assert count <= 8 * len(selected)
    summary = {"decision": "I150", "database": DATABASE, "cases": results, "actual_runs": len(runtime.runs),
               "actual_provider_requests": count, "cleanup": cleanup, "evidence_prefix": runtime.prefix.name}
    evidence(runtime, "remaining", "summary", summary)
    print(json.dumps({"cases_attempted": len(results), "passed": sum(x["passed"] for x in results),
                      "actual_runs": len(runtime.runs), "provider_requests": count, "cleanup": cleanup,
                      "evidence_prefix": runtime.prefix.name}), flush=True)
    return 0 if len(results) == len(selected) and all(x["passed"] for x in results) and not cleanup["errors"] and \
        cleanup["active_auth_sessions"] == cleanup["active_auth_tokens"] == cleanup["queued_or_running_runs"] == 0 else 1


if __name__ == "__main__":
    assert ROOT == ROOT.cwd().resolve()
    assert len(sys.argv) == 2 and sys.argv[1] in ("remaining_four", "transfer_only", "self_check")
    if sys.argv[1] == "self_check":
        assert len(KEYS) == 4 and AUTHOR != DECIDER
        assert "student" in KEYS and "person" in KEYS
        print("Remaining parity self-check passed; provider requests=0")
    else:
        sys.exit(run((transfer,)) if sys.argv[1] == "transfer_only" else run())
