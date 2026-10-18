"""Eight OLAP views over scoped final results and the original debt rules."""

from collections import defaultdict
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import json
import os
import re

from fastapi import HTTPException
import psycopg
from psycopg import Connection

from backend.olap_gate import OlapGate


MODES = {
    "rollup-group", "rollup-discipline", "rollup-semester", "slice-group",
    "slice-discipline", "dice", "drilldown-group", "cross-group-semester",
}
ANALYSES = {'session','heat','risk','retake','moves'}
# Один на процесс: ограничение одновременных расчётов и кэш наборов фактов (см. olap_gate).
GATE = OlapGate()


def _checked(mode, params, codes):
    """Проверка параметров до слота и до запроса к базе; codes() — коды order_type, читаются только для moves."""
    p=params
    # Параметры «Итогов сессии» проверяет _session_rows: ошибка называет поле (validation_error).
    if (mode not in ANALYSES or (mode!='session' and any(p[k] is not None and p[k]<1 for k in
            ('group_id','discipline_id','semester','status_id','course'))) or not 25<=p['mod_min']<=54 or not 0<=p['att_min']<=100
            or (mode!='session' and p['level'] not in (None,'course','group','discipline','student'))
            or p['period'] not in ('month','semester','year') or (p['pick'] is not None and len(p['pick'])>40)
            or (mode=='retake' and p['level'] not in (None,'course','group'))):
        raise HTTPException(422,'invalid_filter')
    if mode=='session':
        _session_rows({'results':[]},{},{},p['level'],p['course'],p['group_id'],p['discipline_id'],p['semester'])
    order_types=None
    if mode=='moves':
        _moves_filters(p['moves'],None)
        # Коды видов приказов — из справочника order_type (чтение, база не меняется).
        order_types=codes()
        _moves_filters(p['moves'],order_types)
    return order_types


def analyze(db, token, mode, *, group_id=None, discipline_id=None, semester=None,
            status_id=None, course=None, level=None, mod_min=30, att_min=70, period='month', pick=None, moves=None,
            user_id=None):
    params=dict(group_id=group_id,discipline_id=discipline_id,semester=semester,status_id=status_id,course=course,
                level=level,mod_min=mod_min,att_min=att_min,period=period,pick=pick,moves=moves)
    order_types=_checked(mode,params,lambda:{r['code'] for r in _visible(db,'order_type',token)})
    if engine()=='sql':
        # Готовый ответ режима считает база; кэшируется ответ по ключу «пользователь + режим + все параметры».
        def compute():
            return _sql_body(db,'backend_api.olap_',(token,),mode,params,order_types)
        key=('analysis',user_id,mode,*(json.dumps(v,sort_keys=True) if isinstance(v,dict) else v for v in params.values()))
        if user_id is not None:
            body=GATE.fetch(key,compute)
        else:
            with GATE.slot():
                body=compute()
        return envelope(mode,body,params,order_types)
    def load():
        return db.execute('SELECT backend_api.olap_dataset(%s) AS data',(token,)).fetchone()['data']
    dataset=GATE.fetch(('dataset',user_id),load) if user_id is not None else None
    with GATE.slot():
        return analysis_from_data(dataset if dataset is not None else load(),mode,group_id=group_id,discipline_id=discipline_id,
            semester=semester,status_id=status_id,course=course,level=level,mod_min=mod_min,att_min=att_min,period=period,pick=pick,
            moves=moves,order_types=order_types)


def engine():
    """OLAP_ENGINE=sql (по умолчанию) — расчёт в базе; python — прежний набор фактов olap_dataset (на время перехода)."""
    return 'python' if os.environ.get('OLAP_ENGINE','sql').strip().lower()=='python' else 'sql'


def _sql_body(db, prefix, auth, mode, params, order_types):
    """Вызов функции режима: prefix 'backend_api.olap_' (токен API) или 'backend_api.agent_olap_' (запуск агента)."""
    p=params
    if mode=='session':
        level=p['level'] or 'course'
        args=('result' if level=='student' else level,p['course'],p['group_id'],p['discipline_id'],p['semester'],p['status_id'])
        cast='%s,%s,%s,%s,%s,%s'
    elif mode=='heat':
        args=(p['course'],p['group_id'],p['discipline_id'],p['semester'],p['status_id'])
        cast='%s,%s,%s,%s,%s'
    elif mode=='risk':
        args=(p['course'],p['group_id'],p['status_id'],p['mod_min'],float(p['att_min']))
        cast='%s,%s,%s,%s,%s'
    elif mode=='retake':
        args=(p['level'] or 'group',p['course'],p['group_id'],p['status_id'])
        cast='%s,%s,%s,%s'
    else:
        types,month_from,month_to,listed=_moves_filters(p['moves'],order_types)
        args=(p['period'],p['pick'],types,month_from,month_to,listed,p['course'],p['group_id'],p['discipline_id'],p['semester'],p['status_id'])
        cast='%s,%s,%s::text[],%s,%s,%s,%s,%s,%s,%s,%s'
    marks=','.join(['%s']*len(auth))
    try:
        return db.execute(f'SELECT {prefix}{mode}({marks},{cast}) AS body',(*auth,*args)).fetchone()['body']
    except psycopg.Error as error:
        if error.sqlstate=='P6413':
            raise HTTPException(413,'olap_too_large') from None
        raise


AGENT_ORDERS=200


def agent_analysis(db, run_id, worker_id, mode, params):
    """Пять режимов экрана для агента: та же функция базы от имени автора запуска, без points у risk;
    список приказов moves — только с окном from/to и не больше AGENT_ORDERS строк."""
    def codes():
        return {json.loads(r['data'])['code'] for r in db.execute(
            "SELECT backend_api.agent_visible_rows(%s,%s,'order_type') AS data",(run_id,worker_id))}
    order_types=_checked(mode,params,codes)
    moves=params['moves'] or {}
    if mode=='moves' and moves.get('list')=='true' and not (moves.get('from') and moves.get('to')):
        raise _invalid('list')
    with GATE.slot():
        body=_sql_body(db,'backend_api.agent_olap_',(run_id,worker_id),mode,params,order_types)
    result=envelope(mode,body,params,order_types)
    result.pop('points',None)
    if len(result.get('orders') or [])>AGENT_ORDERS:
        result['orders']=result['orders'][:AGENT_ORDERS]
        result['orders_truncated']=True
    return result


def envelope(mode, body, params, order_types):
    """Конверт ответа, как у analysis_from_data: {mode, level, rows, total, points?, orders?, filters}."""
    p=params
    level=body['level'] if mode in ('session','retake') else p['level']
    extra={'points':body['points']} if mode=='risk' else {}
    extra_filters={}
    if mode=='moves':
        types,month_from,month_to,listed=_moves_filters(p['moves'],order_types)
        if listed:
            extra['orders']=body['orders']
        extra_filters={'types':types,'from':month_from,'to':month_to,'list':listed}
    return {'mode':mode,'level':level,'rows':body['rows'],'total':body['total'],**extra,
        'filters':{'course':p['course'],'group_id':p['group_id'],'discipline_id':p['discipline_id'],'semester':p['semester'],
            'status_id':p['status_id'],'mod_min':p['mod_min'],'att_min':p['att_min'],'period':p['period'],'pick':p['pick'],**extra_filters}}


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



def _moves_filters(raw, order_types):
    """Параметры «Движения контингента»: types, from, to (YYYY-MM включительно), list."""
    raw=raw or {}
    month=re.compile(r'^\d{4}-(0[1-9]|1[0-2])$')
    for field in ('from','to'):
        if raw.get(field) is not None and not month.match(raw[field]):
            raise _invalid(field)
    if raw.get('from') and raw.get('to') and raw['from']>raw['to']:
        raise _invalid('from')
    types=None
    if raw.get('types') is not None:
        types=raw['types'].split(',')
        if any(not code for code in types) or (order_types is not None and not set(types)<=set(order_types)):
            raise _invalid('types')
    listed=raw.get('list')
    if listed is not None and listed not in ('true','false'):
        raise _invalid('list')
    return types,raw.get('from'),raw.get('to'),listed=='true'


def analysis_from_data(data, mode, *, group_id=None, discipline_id=None, semester=None,
                       status_id=None, course=None, level=None, mod_min=30, att_min=70, period='month', pick=None,
                       moves=None, order_types=None):
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
    total=metrics(results,set(students)); rows=[]; extra={}; extra_filters={}
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
        types,month_from,month_to,listed=_moves_filters(moves,order_types)
        def period_key(raw):
            value=date.fromisoformat(raw)
            if period=='month': return value.strftime('%Y-%m')
            # Учебный год — с сентября по август, как у семестра: 2025/26, 2025/26-1, 2025/26-2.
            year=value.year if value.month>=9 else value.year-1
            if period=='year': return f'{year}/{str(year+1)[-2:]}'
            return f'{year}/{str(year+1)[-2:]}-{1 if value.month>=9 or value.month==1 else 2}'
        # Пары «приказ × студент» в области, по видам и окну месяцев order_date.
        pairs=[r for r in data['orders'] if r['student_id'] in students
            and (types is None or r['order_type_code'] in types)
            and (month_from is None or r['order_date'][:7]>=month_from)
            and (month_to is None or r['order_date'][:7]<=month_to)]
        buckets=defaultdict(list)
        for r in pairs:
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
                kinds=defaultdict(set); people=defaultdict(int)
                for r in values:
                    kinds[r['order_type_code']].add(r['order_id']); people[r['order_type_code']]+=1
                rows.append({'period':key,'orders':len({r['order_id'] for r in values}),
                    'students':len({r['student_id'] for r in values}),'by_type':{k:len(v) for k,v in kinds.items()},
                    'students_by_type':dict(people)})
        if listed:
            fields=('order_id','order_number','order_date','effective_date','order_type','order_type_code',
                'applied_at','student_id','student','group_id','group_name','course')
            listing=sorted(({**{k:r[k] for k in fields},'period':period_key(r['order_date'])} for r in pairs),
                key=lambda r:(r['order_number'],r['student'],r['student_id']))
            listing.sort(key=lambda r:r['order_date'],reverse=True)
            extra['orders']=listing
        extra_filters={'types':types,'from':month_from,'to':month_to,'list':listed}
    return {'mode':mode,'level':level,'rows':rows,'total':total,**({'points':scatter} if mode=='risk' else {}),**extra,
        'filters':{'course':course,'group_id':group_id,'discipline_id':discipline_id,'semester':semester,
            'status_id':status_id,'mod_min':mod_min,'att_min':att_min,'period':period,'pick':pick,**extra_filters}}


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
           discipline_id: int | None, semester: int | None, status_id: int | None, user_id: int | None = None):
    _report_checks(mode, group_id, discipline_id, semester, status_id)
    def load():
        facts = []
        for row in db.execute("SELECT olap_facts FROM backend_api.olap_facts(%s,%s,%s,%s,%s)",
                              (token, group_id, discipline_id, semester, status_id)):
            facts.append(row["olap_facts"])
            if len(facts) > 100_000:
                raise HTTPException(status_code=413, detail="olap_too_large")
        return facts
    key = ('facts', user_id, group_id, discipline_id, semester, status_id)
    facts = GATE.fetch(key, load) if user_id is not None else None
    with GATE.slot():
        return report_from_facts(facts if facts is not None else load(), lambda name: _visible(db,name,token), mode,
                                 group_id,discipline_id,semester,status_id)


def _report_checks(mode, group_id, discipline_id, semester, status_id):
    if mode not in MODES:
        raise HTTPException(status_code=422, detail="invalid_mode")
    if any(value is not None and value < 1 for value in (group_id, discipline_id, semester, status_id)):
        raise HTTPException(status_code=422, detail="invalid_filter")
    if mode in ("slice-group", "drilldown-group") and group_id is None:
        raise HTTPException(status_code=422, detail="group_required")
    if mode == "slice-discipline" and discipline_id is None:
        raise HTTPException(status_code=422, detail="discipline_required")


def report_from_facts(source, visible, mode, group_id=None, discipline_id=None, semester=None, status_id=None):
    _report_checks(mode, group_id, discipline_id, semester, status_id)
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
