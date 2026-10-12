"""Eight OLAP views over scoped final results and the original debt rules."""

from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
import json

from fastapi import HTTPException
from psycopg import Connection


MODES = {
    "rollup-group", "rollup-discipline", "rollup-semester", "slice-group",
    "slice-discipline", "dice", "drilldown-group", "cross-group-semester",
}


def _visible(db: Connection, name: str, token: str):
    return [json.loads(row["visible_rows"]) for row in db.execute(
        "SELECT visible_rows FROM backend_api.visible_rows(%s,%s)", (name, token),
    )]


def _metrics(facts):
    results = [f for f in facts if f["kind"] == "result"]
    points = [Decimal(f["points"]) for f in results if f["points"] is not None]
    return {
        "avg": str((sum(points) / len(points)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)) if points else None,
        "results": len(results),
        "excellent": sum(bool(f["is_graded"] and f["mark"] == 5) for f in results),
        "debts": sum(f["kind"] == "debt" for f in facts),
    }


def report(db: Connection, token: str, mode: str, group_id: int | None,
           discipline_id: int | None, semester: int | None, status_id: int | None):
    source = (row["olap_facts"] for row in db.execute(
        "SELECT olap_facts FROM backend_api.olap_facts(%s,%s,%s,%s,%s)",
        (token, group_id, discipline_id, semester, status_id),
    ))
    return report_from_facts(source, lambda name: _visible(db,name,token), mode,
                             group_id,discipline_id,semester,status_id)


def report_from_facts(source, visible, mode, group_id=None, discipline_id=None, semester=None, status_id=None):
    if mode not in MODES:
        raise HTTPException(status_code=422, detail="invalid_mode")
    if any(value is not None and value < 1 for value in (group_id, discipline_id, semester, status_id)):
        raise HTTPException(status_code=422, detail="invalid_filter")
    if mode in ("slice-group", "drilldown-group") and group_id is None:
        raise HTTPException(status_code=422, detail="group_required")
    if mode == "slice-discipline" and discipline_id is None:
        raise HTTPException(status_code=422, detail="discipline_required")
    # shortcut: cap facts in memory; move aggregation into SQL for datasets beyond 100,000 facts.
    facts = []
    for fact in source:
        facts.append(fact)
        if len(facts) > 100_000:
            raise HTTPException(status_code=413, detail="olap_too_large")
    total = _metrics(facts)
    result_facts = [f for f in facts if f["kind"] == "result"]
    rows = []
    if mode == "dice":
        debt_keys = {(f["student_id"], f["discipline_id"], f["semester"]) for f in facts if f["kind"] == "debt"}
        rows = [{**f, "has_debt": (f["student_id"], f["discipline_id"], f["semester"]) in debt_keys}
                for f in result_facts]
        rows.sort(key=lambda r: (r["group_name"], r["student"], r["semester"], r["discipline"], r["student_id"]))
    elif mode == "drilldown-group":
        groups = {g["group_id"]:g["name"] for g in visible("study_group")}
        if group_id not in groups:
            raise HTTPException(status_code=404, detail="not_found")
        students = {s["student_id"]:s for s in visible("student")}
        summaries = visible("v_student_summary")
        by_student = defaultdict(list)
        for fact in facts:
            by_student[fact["student_id"]].append(fact)
        for summary in summaries:
            subject = students.get(summary["student_id"])
            if not subject or subject["group_id"] != group_id or (status_id is not None and subject["status_id"] != status_id):
                continue
            rows.append({"student_id":summary["student_id"],"student":summary["student"],
                         "group_id":group_id,"category":summary["category"],
                         **_metrics(by_student[summary["student_id"]])})
        rows.sort(key=lambda r: (r["student"], r["student_id"]))
    elif mode == "cross-group-semester":
        groups = {g["group_id"]:g["name"] for g in visible("study_group")}
        if group_id is not None:
            groups = {k:v for k,v in groups.items() if k == group_id}
        semesters = sorted({f["semester"] for f in facts})
        by_cell = defaultdict(list)
        for fact in facts:
            by_cell[fact["group_id"], fact["semester"]].append(fact)
        rows = [{"group_id":gid,"name":name,"semesters":{
            str(sem):_metrics(by_cell[gid,sem])["avg"] for sem in semesters}}
            for gid,name in groups.items()]
        rows.sort(key=lambda r: (r["name"],r["group_id"]))
    else:
        dimension = "group_id" if mode in ("rollup-group", "slice-discipline") else (
            "discipline_id" if mode in ("rollup-discipline", "slice-group") else "semester")
        buckets = defaultdict(list)
        labels = {}
        for fact in facts:
            key = fact[dimension]
            buckets[key].append(fact)
            labels[key] = fact["group_name"] if dimension == "group_id" else (
                fact["discipline"] if dimension == "discipline_id" else f"{key} семестр")
        rows = [{dimension:key,"name":labels[key],**_metrics(value)} for key,value in buckets.items()]
        rows.sort(key=lambda r: (r[dimension] if dimension == "semester" else r["name"], r[dimension]))
    return {
        "mode":mode,"filters":{"group_id":group_id,"discipline_id":discipline_id,
                          "semester":semester,"status_id":status_id},
        "rows":rows,"total":total,"semesters":sorted({f["semester"] for f in facts}),
        "scale":sorted(visible("score_band"),key=lambda b:b["min_points"]),
    }
