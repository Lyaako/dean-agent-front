"""Метрики экрана OLAP: итоги сессии, раннее предупреждение и пересдачи на синтетических данных olap_dataset."""
import pytest
from fastapi import HTTPException

from backend.olap import analysis_from_data

MARKS = {5: 46, 4: 40, 3: 30}


def dataset():
    return {name: [] for name in ('students', 'results', 'attempts', 'modules', 'attendance', 'debts', 'orders')}


def student(data, sid, group=1, course=2, current=3, active=True, name=None):
    data['students'].append({'student_id': sid, 'student': name or f'Студент {sid:02d}', 'group_id': group,
        'group_name': f'ИДБ-{group:02d}', 'status_id': 1 if active else 2, 'is_active': active,
        'course': course, 'current_semester': current})


def result(data, sid, discipline, semester, attempts, graded=True, group=1):
    """attempts — список (вид ведомости, баллы) по порядку сдачи; последняя попытка — итоговый результат."""
    for index, (kind, points) in enumerate(attempts, 1):
        data['attempts'].append({'student_id': sid, 'discipline_id': discipline, 'semester': semester,
            'points': points, 'is_absent': False, 'sheet_kind': kind, 'sheet_id': 1000 * sid + 10 * discipline + index,
            'exam_date': f'2026-0{index}-15', 'group_id': group, 'discipline': f'Дисциплина {discipline}'})
    kind, points = attempts[-1]
    mark = None if points is None else 5 if points >= 46 else 4 if points >= 40 else 3
    data['results'].append({'student_id': sid, 'discipline_id': discipline, 'semester': semester, 'stage': 'final',
        'points': points, 'is_absent': False, 'mark': mark, 'is_graded': graded, 'sheet_kind': kind,
        'discipline': f'Дисциплина {discipline}', 'group_id': group, 'group_name': f'ИДБ-{group:02d}',
        'control_type': 'Экзамен' if graded else 'Зачёт', 'result': 'Отлично' if mark == 5 else '—'})


def session(data, **params):
    return analysis_from_data(data, 'session', **params)


def three_students():
    data = dataset()
    for sid in (1, 2, 3):
        student(data, sid)
    result(data, 1, 1, 2, [('main', MARKS[5])]); result(data, 1, 2, 2, [('main', MARKS[5])])
    result(data, 2, 1, 2, [('main', MARKS[3])]); result(data, 2, 2, 2, [('main', MARKS[5])])
    result(data, 3, 1, 2, [('main', None), ('retake', MARKS[5])]); result(data, 3, 2, 2, [('main', MARKS[5])])
    return data


def test_session_shares_are_counted_by_students():
    total = session(three_students())['total']
    assert total == {'students': 3, 'abs_pct': 67, 'qual_pct': 33, 'debts': 1, 'excellent': 1}
    response = session(three_students(), level='result', group_id=1, discipline_id=1)
    assert response['level'] == 'result'
    assert {r['student_id']: r['attempt'] for r in response['rows']} == {1: 'main', 2: 'main', 3: 'retake'}
    assert set(response['rows'][0]) == {'student_id', 'student', 'control_type', 'is_graded', 'points',
                                        'is_absent', 'mark', 'result', 'attempt'}
    rows = session(three_students(), level='discipline', group_id=1)['rows']
    assert [(r['discipline_id'], r['students'], r['debts'], r['abs_pct']) for r in rows] == [(1, 3, 1, 67), (2, 3, 0, 100)]


def test_individual_sheet_is_a_first_time_pass():
    data = dataset(); student(data, 1)
    result(data, 1, 1, 2, [('individual', MARKS[5])])
    assert session(data)['total'] == {'students': 1, 'abs_pct': 100, 'qual_pct': 100, 'debts': 0, 'excellent': 1}
    assert session(data, level='result', group_id=1, discipline_id=1)['rows'][0]['attempt'] == 'individual'


def test_session_is_the_previous_semester_of_each_group():
    data = dataset()
    student(data, 1, group=1, course=2, current=3); student(data, 2, group=2, course=3, current=5)
    student(data, 3, group=3, course=1, current=1)
    result(data, 1, 1, 2, [('main', MARKS[5])], group=1); result(data, 1, 2, 1, [('main', None)], group=1)
    result(data, 2, 3, 4, [('main', MARKS[4])], group=2); result(data, 2, 4, 2, [('main', MARKS[5])], group=2)
    result(data, 3, 5, 1, [('main', MARKS[5])], group=3)
    response = session(data)
    assert [(r['course'], r['name'], r['students']) for r in response['rows']] == [(2, '2 курс', 1), (3, '3 курс', 1)]
    assert response['total']['debts'] == 0
    fixed = session(data, semester=2)
    assert [(r['course'], r['students']) for r in fixed['rows']] == [(2, 1), (3, 1)]
    assert session(data, semester=1)['total']['debts'] == 1
    groups = session(data, level='group', course=2)['rows']
    assert [(r['group_id'], r['name']) for r in groups] == [(1, 'ИДБ-01')]


@pytest.mark.parametrize('params,field', [
    ({'level': 'result', 'group_id': 1}, 'discipline_id'),
    ({'level': 'group'}, 'course'),
    ({'level': 'discipline'}, 'group_id'),
    ({'semester': 13}, 'semester'),
    ({'level': 'semester'}, 'level'),
])
def test_session_parameters_name_the_field(params, field):
    with pytest.raises(HTTPException) as raised:
        session(three_students(), **params)
    assert raised.value.status_code == 422
    assert raised.value.detail['code'] == 'validation_error'
    assert raised.value.detail['details'] == {'field': field}


def presence(data, sid, present, absent):
    data['attendance'] += [{'student_id': sid, 'discipline_id': 1, 'semester': 3, 'is_present': True}] * present
    data['attendance'] += [{'student_id': sid, 'discipline_id': 1, 'semester': 3, 'is_present': False}] * absent


def test_risk_factors_score_and_points():
    data = dataset()
    for sid in (1, 2, 3, 4):
        student(data, sid)
    student(data, 5, active=False)
    # 1: слабый модуль и долг; 2: только посещаемость 60 %; 3: модуля нет, отметок нет; 4: модуль в норме, 90 %.
    data['modules'] += [{'student_id': 1, 'discipline_id': 7, 'discipline': 'Физика', 'semester': 3, 'points': 27, 'is_absent': False},
                        {'student_id': 4, 'discipline_id': 7, 'discipline': 'Физика', 'semester': 3, 'points': 50, 'is_absent': False},
                        {'student_id': 5, 'discipline_id': 7, 'discipline': 'Физика', 'semester': 3, 'points': None, 'is_absent': True}]
    data['debts'].append({'student_id': 1, 'discipline': 'Химия', 'semester': 2, 'attempts': 1})
    presence(data, 1, 9, 1); presence(data, 2, 3, 2); presence(data, 4, 9, 1)
    result(data, 3, 1, 2, [('main', 44)]); result(data, 3, 2, 2, [('main', 41)])
    response = analysis_from_data(data, 'risk')
    assert response['filters']['att_min'] == 70 and response['filters']['mod_min'] == 30
    assert [(r['student_id'], r['score'], r['risk']) for r in response['rows']] == [(1, 2, 'high'), (2, 1, 'medium')]
    first = response['rows'][0]
    assert first['low_modules'] == [{'discipline_id': 7, 'discipline': 'Физика', 'points': 27, 'is_absent': False}]
    assert (first['attendance_pct'], first['attendance_count'], first['attendance_low'], first['debts']) == (90.0, 10, False, 1)
    assert response['rows'][1]['attendance_pct'] == 60.0 and response['rows'][1]['attendance_low']
    assert response['total'] == {'pool': 4, 'at_risk': 2, 'high': 1, 'low_module': 1, 'low_attendance': 1, 'with_debts': 1}
    assert response['points'] == [{'student_id': 3, 'student': 'Студент 03', 'group_name': 'ИДБ-01',
                                   'attendance_pct': None, 'avg_points': 42.5, 'debts': 0}]


def test_absent_or_not_attested_module_is_weak_and_threshold_is_configurable():
    data = dataset(); student(data, 1); student(data, 2)
    data['modules'] += [{'student_id': 1, 'discipline_id': 7, 'discipline': 'Физика', 'semester': 3, 'points': None, 'is_absent': False},
                        {'student_id': 2, 'discipline_id': 7, 'discipline': 'Физика', 'semester': 3, 'points': None, 'is_absent': True}]
    presence(data, 2, 7, 3)
    assert [r['student_id'] for r in analysis_from_data(data, 'risk')['rows']] == [1, 2]
    assert analysis_from_data(data, 'risk', att_min=75)['rows'][0]['student_id'] == 2


def test_retake_funnel_counts_debts_and_expulsion_candidates():
    data = dataset()
    student(data, 1); student(data, 2); student(data, 3, active=False)
    result(data, 1, 1, 1, [('main', None), ('retake', 40)])
    result(data, 1, 2, 2, [('main', None), ('retake', None), ('commission', 35)])
    result(data, 1, 3, 2, [('main', None)])
    result(data, 1, 4, 2, [('main', 46)])
    result(data, 1, 5, 3, [('main', None)])  # текущий семестр — ещё не завершён
    result(data, 3, 1, 1, [('main', None)])  # не обучается
    data['debts'] += [{'student_id': 1, 'discipline': 'Дисциплина 3', 'semester': 2, 'attempts': 1},
                      {'student_id': 2, 'discipline': 'Дисциплина 9', 'semester': 2, 'attempts': 3}]
    response = analysis_from_data(data, 'retake')
    assert response['level'] == 'group'
    assert response['rows'] == [{'group_id': 1, 'name': 'ИДБ-01', 'failed': 3, 'closed_retake': 1,
                                 'closed_commission': 1, 'open': 1, 'closed_pct': 67}]
    assert response['total'] == {'failed': 3, 'closed_retake': 1, 'closed_commission': 1, 'open': 1,
                                 'closed_pct': 67, 'expulsion_candidates': 1}
    assert analysis_from_data(data, 'retake', level='course')['rows'][0]['name'] == '2 курс'
