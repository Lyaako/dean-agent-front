"""Eight OLAP views over scoped final results and the original debt rules."""

from collections import defaultdict
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import json

from fastapi import HTTPException
from psycopg import Connection


MODES = {
    "rollup-group", "rollup-discipline", "rollup-semester", "slice-group",
    "slice-discipline", "dice", "drilldown-group", "cross-group-semester",
}
ANALYSES = {'session','heat','risk','retake','moves'}


def analyze(db, token, mode, *, group_id=None, discipline_id=None, semester=None,
            status_id=None, course=None, level=None, mod_min=30, att_min=75, period='month', pick=None):
    if (mode not in ANALYSES or any(v is not None and v<1 for v in
            (group_id,discipline_id,semester,status_id,course)) or not 25<=mod_min<=54 or not 0<=att_min<=100
            or level not in (None,'course','group','discipline','student')
            or period not in ('month','semester','year') or (pick is not None and len(pick)>40)
            or (mode=='retake' and level not in (None,'course','group'))):
        raise HTTPException(422,'invalid_filter')
    dataset=db.execute('SELECT backend_api.olap_dataset(%s) AS data',(token,)).fetchone()['data']
    return analysis_from_data(dataset,mode,group_id=group_id,discipline_id=discipline_id,
        semester=semester,status_id=status_id,course=course,level=level,mod_min=mod_min,att_min=att_min,period=period,pick=pick)


def analysis_from_data(data, mode, *, group_id=None, discipline_id=None, semester=None,
                       status_id=None, course=None, level=None, mod_min=30, att_min=75, period='month', pick=None):
    if sum(len(v) for v in data.values())>100_000:
        raise HTTPException(413,'olap_too_large')
    students={s['student_id']:s for s in data['students'] if
        (group_id is None or s['group_id']==group_id) and (course is None or s['course']==course)
        and (status_id is None or s['status_id']==status_id)}
    def scoped(rows):
        return [r for r in rows if r['student_id'] in students
            and (semester is None or r.get('semester')==semester)
            and (discipline_id is None or r.get('discipline_id')==discipline_id)]
    results=scoped(data['results']); attempts=scoped(data['attempts'])
    # Debt facts use the database's aggregate rules and discipline names.
    discipline_names={r['discipline'] for r in results+attempts if r.get('discipline_id')==discipline_id}
    debts=[r for r in data['debts'] if r['student_id'] in students
        and (semester is None or r['semester']==semester)
        and (discipline_id is None or r['discipline'] in discipline_names)]
    first_pass={(r['student_id'],r['discipline_id'],r['semester']) for r in attempts
        if r['sheet_kind'] in ('main','individual') and r['points'] is not None}
    def metrics(rows, members):
        by_student=defaultdict(list)
        for r in rows: by_student[r['student_id']].append(r)
        return {'students':len(members),'results':len(rows),
            'first_pass':sum((r['student_id'],r['discipline_id'],r['semester']) in first_pass for r in rows),
            'debts':sum(r['student_id'] in members for r in debts),
            'excellent':sum(any(r['is_graded'] for r in values)
                and all(r['points'] is not None and (not r['is_graded'] or r['mark']==5) for r in values)
                for values in by_student.values())}
    total=metrics(results,set(students)); rows=[]
    if mode=='session':
        level=level or 'course'
        keyfield={'course':'course','group':'group_id','discipline':'discipline_id','student':'student_id'}[level]
        buckets=defaultdict(list); names={}; members=defaultdict(set)
        if level in ('course','group','student'):
            for s in students.values():
                key=s[keyfield]; members[key].add(s['student_id'])
                names[key]=s['group_name'] if level=='group' else s['student'] if level=='student' else str(key)
        for r in results:
            key=r[keyfield]; buckets[key].append(r); members[key].add(r['student_id'])
            if level=='discipline': names[key]=r['discipline']
        for key in sorted(members):
            value=metrics(buckets[key],members[key])
            if level=='discipline':
                value['debts']=sum(d['discipline']==names[key] for d in debts)
            rows.append({keyfield:key,'name':names[key],**value})
    elif mode=='heat':
        cells=defaultdict(list)
        for r in results: cells[r['discipline_id'],r['group_id']].append(r)
        for (did,gid),values in sorted(cells.items()):
            passed=sum((r['student_id'],did,r['semester']) in first_pass for r in values)
            rows.append({'discipline_id':did,'discipline':values[0]['discipline'],'group_id':gid,
                'group_name':values[0]['group_name'],'results':len(values),'first_pass':passed,
                'not_first_pass_pct':round(100*(len(values)-passed)/len(values),2)})
    elif mode=='retake':
        level=level or 'course'; field='course' if level=='course' else 'group_id'
        buckets=defaultdict(list)
        for r in attempts: buckets[r[field]].append(r)
        for key,values in sorted(buckets.items()):
            counts={kind:{'attempts':sum(r['sheet_kind']==kind for r in values),
                'students':len({r['student_id'] for r in values if r['sheet_kind']==kind}),
                'passed':sum(r['sheet_kind']==kind and r['points'] is not None for r in values)}
                for kind in ('main','retake','commission','individual')}
            rows.append({field:key,'name':str(key) if field=='course' else values[0]['group_name'],'attempts':counts})
    elif mode=='risk':
        presence=defaultdict(list)
        for r in data['attendance']:
            presence[r['student_id'],r['discipline_id']].append(r['is_present'])
        for r in scoped(data['modules']):
            s=students[r['student_id']]; values=presence[r['student_id'],r['discipline_id']]
            attendance=round(100*sum(values)/len(values),2) if values else None
            reasons=[]
            if r['points'] is None: reasons.append('not_attested')
            elif r['points']<mod_min: reasons.append('module_below_threshold')
            if attendance is not None and attendance<att_min: reasons.append('attendance_below_threshold')
            if reasons:
                rows.append({**s,**r,'attendance_pct':attendance,'attendance_count':len(values),'reasons':reasons})
        rows.sort(key=lambda r:(r['group_id'],r['student_id'],r['discipline_id']))
    elif mode=='moves':
        def period_key(raw):
            value=date.fromisoformat(raw)
            if period=='year': return str(value.year)
            if period=='month': return value.strftime('%Y-%m')
            year=value.year if value.month>=9 else value.year-1
            return f'{year}/{str(year+1)[-2:]}-{1 if value.month>=9 or value.month==1 else 2}'
        buckets=defaultdict(list)
        for r in data['orders']:
            if r['student_id'] in students:
                buckets[period_key(r['order_date'])].append(r)
        if pick is not None:
            by_order={}
            for r in buckets.get(pick,[]):
                current=by_order.setdefault(r['order_id'],{k:v for k,v in r.items() if k not in
                    ('student_id','student','group_id','group_name','course','applied_at')})
                current.setdefault('students',[]).append({k:r[k] for k in ('student_id','student','group_id','group_name','applied_at')})
            rows=list(by_order.values())
        else:
            for key,values in sorted(buckets.items()):
                kinds=defaultdict(set)
                for r in values: kinds[r['order_type_code']].add(r['order_id'])
                rows.append({'period':key,'orders':len({r['order_id'] for r in values}),
                    'students':len({r['student_id'] for r in values}),'by_type':{k:len(v) for k,v in kinds.items()}})
    return {'mode':mode,'level':level,'rows':rows,'total':total,
        'filters':{'course':course,'group_id':group_id,'discipline_id':discipline_id,'semester':semester,
            'status_id':status_id,'mod_min':mod_min,'att_min':att_min,'period':period,'pick':pick}}


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
