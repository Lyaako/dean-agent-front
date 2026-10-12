"""Build the read-only mock catalogue from the supplied SQL, not a live database."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sql = (ROOT / 'references/database/01_schema.sql').read_text(encoding='utf-8-sig')
views_sql = (ROOT / 'references/database/02_views_functions.sql').read_text(encoding='utf-8-sig')
GROUPS = {
    'Справочники': 'position academic_degree academic_title education_level study_form funding_type student_status control_type lesson_type score_band academic_term holiday pair_time order_type leave_reason contact_relation scholarship_type document_type request_status app_role',
    'Люди и структура': 'person employee institute department teacher dean_office_staff classroom',
    'Образовательные программы': 'specialty study_program curriculum discipline curriculum_item',
    'Контингент': 'study_group student contact_person student_contact',
    'Учебный процесс': 'teaching_assignment schedule_slot attendance grade_sheet grade grade_correction',
    'Приказы и документы': 'academic_order order_student scholarship academic_leave document_request',
    'Практики и работы': 'organization organization_contact practice_placement academic_work',
    'Пользователи и аудит': 'app_user agent_intent agent_request audit_log audit_log_detail',
}
LABELS = dict(zip(
    'position academic_degree academic_title education_level study_form funding_type student_status control_type lesson_type score_band academic_term holiday pair_time order_type leave_reason contact_relation scholarship_type document_type request_status app_role person employee institute department teacher dean_office_staff classroom specialty study_program curriculum discipline curriculum_item study_group student contact_person student_contact teaching_assignment schedule_slot attendance grade_sheet grade grade_correction academic_order order_student scholarship academic_leave document_request organization organization_contact practice_placement academic_work app_user agent_intent agent_request audit_log audit_log_detail'.split(),
    'Должности|Учёные степени|Учёные звания|Уровни образования|Формы обучения|Финансирование|Статусы студентов|Виды контроля|Виды занятий|Шкала баллов|Учебные периоды|Праздники|Время пар|Типы приказов|Причины отпуска|Родство|Виды стипендий|Виды документов|Статусы заявок|Роли|Персоны|Сотрудники|Институты|Кафедры|Преподаватели|Сотрудники деканата|Аудитории|Специальности|Программы|Учебные планы|Дисциплины|Позиции плана|Группы|Студенты|Контактные лица|Контакты студентов|Учебные поручения|Расписание|Посещаемость|Ведомости|Оценки|Коррекции оценок|Приказы|Студенты приказа|Стипендии|Академические отпуска|Заявки на документы|Организации|Контакты организаций|Места практики|Учебные работы|Учётные записи|Намерения агента|Запросы агента|Аудит|Поля аудита'.split('|')))
WORKFLOWS = {
    'student': 'enroll_student, transfer_student, expel_student, reinstate_student; профиль отдельной командой',
    'academic_order': 'подготовка приказа, применение в срок, отмена только будущего приказа',
    'order_student': 'состав приказа через ту же команду; полный ключ order_id + student_id',
    'academic_leave': 'grant_academic_leave, return_from_leave',
    'scholarship': 'назначение и завершение с основанием и согласованным приказом',
    'grade_sheet': 'создать, назначить экзаменатора, закрыть, отменить по правилам',
    'grade': 'внести оценку в открытую ведомость; закрытая — только grade_correction',
    'grade_correction': 'запрос коррекции; решение другого уполномоченного пользователя',
    'employee': 'приём, изменение должности, увольнение с проверкой зависимостей',
    'teacher': 'назначить/изменить подтип сотрудника с проверкой должности',
    'dean_office_staff': 'назначить сотрудника деканата с проверкой института и должности',
    'app_user': 'создать, сменить роль/область, сбросить пароль, деактивировать; пароль не читается',
    'agent_intent': 'управляемый реестр команд; изменения администратора не расширяют права модели',
    'agent_request': 'создаёт оркестратор; пользователь читает только доступный журнал',
    'audit_log': 'только чтение уполномоченным; записи создаёт триггер',
    'audit_log_detail': 'только чтение уполномоченным; полный ключ audit_id + column_name',
}
FRONT_WRITES = {'student', 'study_group', 'schedule_slot', 'academic_work', 'document_request', 'practice_placement', 'employee', 'person'}
AGENT_WRITES = {'document_request', 'academic_work', 'grade', 'attendance', 'grade_sheet', 'practice_placement', 'teaching_assignment', 'schedule_slot', 'organization_contact', 'contact_person'}
POLICIES = {
    'student': 'форма: funding_type_id, needs_dormitory, is_foreign; группа/статус — 6 workflows',
    'study_group': 'форма группы: создать/изменить; удалить только без зависимостей',
    'employee': 'форма сотрудника: person при создании, должность, ставка, даты; person_id после создания неизменяем; ФИО через person PATCH',
    'person': 'чтение ФИО/разрешённых контактов и lookup; ограниченный PATCH ФИО сотрудника; создание только как часть зачисления',
    'academic_order': 'lookup и чтение агентом; создаётся/применяется через workflow',
    'order_student': 'состав/применение приказа через workflow; полный ключ order_id + student_id',
    'academic_leave': 'grant_academic_leave / return_from_leave; чтение агентом',
    'scholarship': 'чтение агентом; отдельный CRUD/UI не нужен текущему фронтенду',
    'grade_correction': 'чтение; прямой UPDATE закрытой оценки запрещён, workflow решения не подключается как новый экран',
    'teacher': 'lookup и чтение; самостоятельной формы подтипов в текущем фронтенде нет',
    'dean_office_staff': 'lookup и определение исполнителя/области; самостоятельной формы нет',
    'app_user': 'используется аутентификацией; пароль/хэш не выдаются; нового админского CRUD нет',
    'agent_intent': 'реестр намерений связывается с кодовыми командами; модель не меняет права',
    'agent_request': 'заполняет оркестратор; доступное чтение журнала',
    'audit_log': 'создаёт триггер; только доступное чтение',
    'audit_log_detail': 'создаёт триггер; только доступное чтение; ключ audit_id + column_name',
}
tables = []
# shortcut: parse only this supplied SQL layout; use PostgreSQL catalog introspection for the real backend.
for match in re.finditer(r'CREATE TABLE (\w+)\s*\((.*?)^\);', sql, re.M | re.S):
    name, block = match.groups()
    clean = re.sub(r'--[^\n]*', '', block)
    fields = []
    for line in clean.splitlines():
        field = re.match(r'^\s+(\w+)\s+(INT|BIGINT|SMALLINT|VARCHAR\(\d+\)|CHAR\(\d+\)|DATE|TIME|TIMESTAMPTZ|BOOLEAN|TEXT|NUMERIC\([^)]*\))(?=\s|,|$)', line, re.I)
        if field:
            column, kind = field.groups()
            relation = re.search(r'REFERENCES\s+(\w+)(?:\s*\((\w+)\))?', line)
            fields.append({'name': column, 'type': kind, 'nullable': 'NOT NULL' not in line and 'PRIMARY KEY' not in line,
                           'identity': 'GENERATED' in line, 'primary': 'PRIMARY KEY' in line,
                           'reference': {'table': relation[1], 'column': relation[2]} if relation else None})
    key = [f['name'] for f in fields if f['primary']]
    composite = re.search(r'PRIMARY KEY\s*\(([^)]+)\)', clean)
    if composite:
        key = [k.strip() for k in composite[1].split(',')]
    for f in fields:
        if f['name'] in key:
            f['nullable'] = False
    group = next(g for g, names in GROUPS.items() if name in names.split())
    mode = 'system' if name in {'app_user', 'agent_intent', 'agent_request', 'audit_log', 'audit_log_detail'} else 'workflow' if name in {'student', 'academic_order', 'order_student', 'academic_leave'} else 'form' if name in FRONT_WRITES else 'agent_proposal' if name in AGENT_WRITES else 'read'
    policy = POLICIES.get(name, 'CRUD существующей формы и INSERT/UPDATE предложения агента' if name in FRONT_WRITES and name in AGENT_WRITES else 'INSERT/UPDATE через предложение агента; отдельной формы нет' if name in AGENT_WRITES else 'чтение по правам; справочник/связи БД, без нового CRUD-экрана')
    tables.append({'name': name, 'label': LABELS[name], 'group': group, 'key': key, 'fields': fields, 'mode': mode, 'policy': policy})
assert len(tables) == 56, len(tables)
assert sum(len(t['fields']) for t in tables) == 312, sum(len(t['fields']) for t in tables)
by_name = {t['name']: t for t in tables}
for table, column, target, target_column in re.findall(r'ALTER TABLE (\w+)\s+ADD CONSTRAINT \w+ FOREIGN KEY\s*\((\w+)\)\s+REFERENCES (\w+)(?:\s*\((\w+)\))?', sql):
    next(f for f in by_name[table]['fields'] if f['name'] == column)['reference'] = {'table': target, 'column': target_column or None}
for t in tables:
    assert t['key'] and set(t['key']) <= {f['name'] for f in t['fields']}, t['name']
    for f in t['fields']:
        if f['reference'] and not f['reference']['column']:
            f['reference']['column'] = by_name[f['reference']['table']]['key'][0]
assert sum(bool(f['reference']) for t in tables for f in t['fields']) == 83
views = re.findall(r'CREATE OR REPLACE VIEW (\w+)', views_sql)
assert len(views) == 27
catalog = {'source': 'references/database/01_schema.sql', 'tables': tables, 'views': views,
           'notice': 'Структура извлечена из SQL. Политика изменений — проектное решение; каталог не является готовой реализацией прав.'}
serialized = json.dumps(catalog, ensure_ascii=False, indent=2)
(ROOT / 'docs/resource-catalog.json').write_text(serialized + '\n', encoding='utf-8')
rows = ['# Полный каталог 56 таблиц', '', 'Структура извлечена из приложенного SQL. Каждая таблица входит в backend; доступ и способы записи определяет сервер. Системные журналы не получают свободный CRUD. Пароли и закрытые поля не передаются агенту.', '', '| Таблица | Раздел | Первичный ключ | Полей | Изменения |', '|---|---|---|---:|---|']
for t in tables:
    rows.append(f"| `{t['name']}` — {t['label']} | {t['group']} | `{', '.join(t['key'])}` | {len(t['fields'])} | {t['policy']} |")
rows += ['', 'Все 27 представлений используются для удобного чтения, но наружу выдаются только через ограниченные проекции с проверенной областью пользователя:', '', ', '.join('`' + v + '`' for v in views), '', 'Полный перечень полей и связей: [resource-catalog.json](resource-catalog.json). CHECK, UNIQUE, триггеры и дополнительные ALTER-связи проверяются миграциями и тестами PostgreSQL; этот каталог их не заменяет.']
(ROOT / 'docs/DATABASE_CATALOG.md').write_text('\n'.join(rows) + '\n', encoding='utf-8')
print(f'{len(tables)} таблиц, {sum(len(t["fields"]) for t in tables)} полей, {len(views)} представлений')
