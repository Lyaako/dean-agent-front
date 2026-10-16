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
            status_id=None, course=None, level=None, mod_min=30, att_min=70, period='month', pick=None):
    # Параметры «Итогов сессии» проверяет analysis_from_data: ошибка называет поле (validation_error).
    if (mode not in ANALYSES or (mode!='session' and any(v is not None and v<1 for v in
            (group_id,discipline_id,semester,status_id,course))) or not 25<=mod_min<=54 or not 0<=att_min<=100
            or (mode!='session' and level not in (None,'course','group','discipline','student'))
            or period not in ('month','semester','year') or (pick is not None and len(pick)>40)
            or (mode=='retake' and level not in (None,'course','group'))):
        raise HTTPException(422,'invalid_filter')
    dataset=db.execute('SELECT backend_api.olap_dataset(%s) AS data',(token,)).fetchone()['data']
    return analysis_from_data(dataset,mode,group_id=group_id,discipline_id=discipline_id,
        semester=semester,status_id=status_id,course=course,level=level,mod_min=mod_min,att_min=att_min,period=period,pick=pick)


def _invalid(field):
    return HTTPException(422,{'code':'validation_error','message':'Некорректный параметр: '+field,'details':{'field':field}})


def _pct(part, whole):
    # Целый процент, половина вверх (как ROUND в PostgreSQL); null при пустом знаменателе.
    return None if not whole else int((Decimal(100*part)/whole).quantize(Decimal('1'),rounding=ROUND_HALF_UP))


def _one_digit(values):
    return float((Decimal(sum(values))/len(values)).quantize(Decimal('0.1'),rounding=ROUND_HALF_UP)) if values else None


def _passed_attempts(attempts):
    """Вид ведомости самой ранней попытки с баллами по ключу (студент, дисциплина, семестр)."""
    earliest={}
    for r in attempts:
        if r['points'] is None:
            continue
        key=(r['student_id'],r['discipline_id'],r['semester'])
        order=(r['exam_date'] is None,r['exam_date'] or '',r['sheet_id'])
        if key not in earliest or order<earliest[key][0]:
            earliest[key]=(order,r['sheet_kind'])
    return {key:value[1] for key,value in earliest.items()}


FIRST_TIME=('main','individual')


def _key(r):
    return (r['student_id'],r['discipline_id'],r['semester'])




def _session_summary(rows, passed):
    """Студенты сессии и их доли по результатам rows (все результаты строки, сгруппированные по студенту)."""
    by_student=defaultdict(list)
    for r in rows:
        by_student[r['student_id']].append(r)
    first=lambda r: passed.get(_key(r)) in FIRST_TIME
    clean=[v for v in by_student.values() if all(first(r) for r in v)]
    graded=lambda v: [r for r in v if r['is_graded']]
    quality=sum(all((r['mark'] or 0)>=4 for r in graded(v)) for v in clean)
    excellent=sum(bool(graded(v)) and all(r['mark']==5 for r in graded(v)) for v in clean)
    count=len(by_student)
    return {'students':count,'abs_pct':_pct(len(clean),count),'qual_pct':_pct(quality,count),
        'debts':sum(not first(r) for r in rows),'excellent':excellent}


def _session_rows(data, students, passed, level, course, group_id, discipline_id, semester):
    level=level or 'course'
    if level=='student':
        level='result'
    if level not in ('course','group','discipline','result'):
        raise _invalid('level')
    for field,value in (('course',course),('group_id',group_id),('discipline_id',discipline_id)):
        if value is not None and value<1:
            raise _invalid(field)
    if semester is not None and not 1<=semester<=12:
        raise _invalid('semester')
    if level=='group' and course is None:
        raise _invalid('course')
    if level in ('discipline','result') and group_id is None:
        raise _invalid('group_id')
    if level=='result' and discipline_id is None:
        raise _invalid('discipline_id')
    # Сессия студента: заданный семестр или предыдущий семестр его группы.
    session={sid:(semester if semester is not None else s['current_semester']-1) for sid,s in students.items()}
    results=[r for r in data['results'] if r['student_id'] in students and r['semester']==session[r['student_id']]
        and r['semester']>=1 and (discipline_id is None or r['discipline_id']==discipline_id)]
    total=_session_summary(results,passed)
    rows=[]
    if level=='result':
        for r in results:
            rows.append({'student_id':r['student_id'],'student':students[r['student_id']]['student'],
                'control_type':r['control_type'],'is_graded':r['is_graded'],'points':r['points'],
                'is_absent':r['is_absent'],'mark':r['mark'],'result':r['result'],'attempt':passed.get(_key(r))})
        rows.sort(key=lambda r:(r['student'],r['student_id']))
        return level,rows,total
    field={'course':'course','group':'group_id','discipline':'discipline_id'}[level]
    buckets=defaultdict(list)
    names={}
    for r in results:
        value=students[r['student_id']]['course'] if field=='course' else r[field]
        buckets[value].append(r)
        names[value]=(f'{value} курс' if field=='course' else
            r['group_name'] if field=='group_id' else r['discipline'])
    for value,members in buckets.items():
        summary=_session_summary(members,passed)
        if summary['students']:
            rows.append({field:value,'name':names[value],**summary})
    rows.sort(key=lambda r:(r[field] if field=='course' else r['name'],r[field]))
    return level,rows,total


def _risk_rows(data, students, mod_min, att_min):
    pool={sid:s for sid,s in students.items() if s['is_active']}
    weak=defaultdict(list)
    for r in data['modules']:
        if r['student_id'] in pool and (r['points'] is None or r['points']<mod_min):
            weak[r['student_id']].append({'discipline_id':r['discipline_id'],'discipline':r.get('discipline'),
                'points':r['points'],'is_absent':r['is_absent']})
    presence=defaultdict(list)
    for r in data['attendance']:
        presence[r['student_id']].append(int(r['is_present']))
    debts=defaultdict(int)
    for r in data['debts']:
        debts[r['student_id']]+=1
    points=defaultdict(list)
    for r in data['results']:
        if r['points'] is not None:
            points[r['student_id']].append(r['points'])


    rows=[]
    scatter=[]
    for sid,s in pool.items():
        attendance=_one_digit([100*v for v in presence[sid]])
        low_attendance=attendance is not None and attendance<att_min
        low_modules=sorted(weak[sid],key=lambda m:(m['discipline'] or '',m['discipline_id']))
        score=bool(low_modules)+low_attendance+(debts[sid]>0)
        average=_one_digit(points[sid])
        if average is not None:
            scatter.append({'student_id':sid,'student':s['student'],'group_name':s['group_name'],
                'attendance_pct':attendance,'avg_points':average,'debts':debts[sid]})
        if score:
            rows.append({'student_id':sid,'student':s['student'],'group_id':s['group_id'],
                'group_name':s['group_name'],'course':s['course'],'low_modules':low_modules,
                'attendance_pct':attendance,'attendance_count':len(presence[sid]),'attendance_low':low_attendance,
                'debts':debts[sid],'score':score,'risk':'high' if score>=2 else 'medium'})
    rows.sort(key=lambda r:(-r['score'],-len(r['low_modules']),r['student'],r['student_id']))
    scatter.sort(key=lambda r:(r['student'],r['student_id']))
    total={'pool':len(pool),'at_risk':len(rows),'high':sum(r['risk']=='high' for r in rows),
        'low_module':sum(bool(r['low_modules']) for r in rows),
        'low_attendance':sum(r['attendance_low'] for r in rows),'with_debts':sum(r['debts']>0 for r in rows)}
    return rows,total,scatter


def _retake_rows(data, students, passed, level):
    level=level or 'group'
    field='course' if level=='course' else 'group_id'
    pool={sid:s for sid,s in students.items() if s['is_active']}
    buckets=defaultdict(lambda:{'failed':0,'closed_retake':0,'closed_commission':0,'open':0})
    names={}
    totals={'failed':0,'closed_retake':0,'closed_commission':0,'open':0}
    for r in data['results']:
        s=pool.get(r['student_id'])
        if s is None or r['semester']>=s['current_semester']:
            continue
        kind=passed.get(_key(r))
        if kind in FIRST_TIME:
            continue
        # Долг сессии закрыт пересдачей, комиссией или ещё открыт (такой ключ есть в v_debtors).
        column='closed_retake' if kind=='retake' else 'closed_commission' if kind=='commission' else 'open'
        value=s[field]
        names[value]=f'{value} курс' if field=='course' else s['group_name']
        for target in (buckets[value],totals):
            target['failed']+=1
            target[column]+=1
    def closed(counts):
        return {**counts,'closed_pct':_pct(counts['closed_retake']+counts['closed_commission'],counts['failed'])}
    rows=[{field:value,'name':names[value],**closed(counts)} for value,counts in buckets.items()]
    rows.sort(key=lambda r:(r[field] if field=='course' else r['name'],r[field]))
    per_student=defaultdict(list)
    for r in data['debts']:
        if r['student_id'] in pool:
            per_student[r['student_id']].append(r['attempts'])
    # Правило v_expulsion_risk: MAX(attempts) >= 3 или COUNT(*) >= 3 по строкам v_debtors.
    candidates=sum(max(values)>=3 or len(values)>=3 for values in per_student.values())
    return level,rows,{**closed(totals),'expulsion_candidates':candidates}



def analysis_from_data(data, mode, *, group_id=None, discipline_id=None, semester=None,
                       status_id=None, course=None, level=None, mod_min=30, att_min=70, period='month', pick=None):
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
    if mode in ('session','risk','retake'):
        # Новые метрики экрана OLAP: доли по студентам, риск по студенту, воронка по долгам.
        passed=_passed_attempts([r for r in data['attempts'] if r['student_id'] in students])
        if mode=='session':
            level,rows,total=_session_rows(data,students,passed,level,course,group_id,discipline_id,semester)
        elif mode=='risk':
            rows,total,scatter=_risk_rows(data,students,mod_min,att_min)
        else:
            level,rows,total=_retake_rows(data,students,passed,level)
    elif mode=='heat':
        cells=defaultdict(list)
        for r in results: cells[r['discipline_id'],r['group_id']].append(r)
        for (did,gid),values in sorted(cells.items()):
            passed=sum((r['student_id'],did,r['semester']) in first_pass for r in values)
            rows.append({'discipline_id':did,'discipline':values[0]['discipline'],'group_id':gid,
                'group_name':values[0]['group_name'],'results':len(values),'first_pass':passed,
                'not_first_pass_pct':round(100*(len(values)-passed)/len(values),2)})
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
    return {'mode':mode,'level':level,'rows':rows,'total':total,**({'points':scatter} if mode=='risk' else {}),
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
