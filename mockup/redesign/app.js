/* ═════════ МАКЕТ ПРИЛОЖЕНИЯ ═════════
   Повторяет React-фронт (frontend/src): вход, шапка с чатом и меню пользователя, вкладки внизу,
   таблицы с окнами записей, приказы по студентам, расписание, чаты с агентом и окно «применить изменения».
   Данные выдуманы (data.js), агент — заглушка: отвечает по ключевым словам. Пользователь — сотрудник деканата. */

let ROLE_NAME = "Сотрудник деканата";   // меняется с ролью (roles.js)
const CATEGORY_KIND = { "Отличник": "ok", "Хорошист": "ok", "Есть тройки": "info", "Есть задолженности": "warn", "Кандидат на отчисление": "bad",
  "Академический отпуск": "muted", "Отчислен": "muted", "Выпускник": "muted", "Ещё не сдавал сессию": "info" };
const LESSON_KIND = { "Лекция": "info plain", "Практика": "violet plain", "Лабораторная": "warn plain" };
const STATUS_KIND = { "Новая": "info", "В работе": "warn", "Готова к выдаче": "ok", "Выдана": "muted", "Отклонена": "bad" };
const EMPLOYEE_CATEGORY = CATEGORY_NAME;

/* ═════════ ВХОД ═════════ */
const auth = { on: false, login: "", busy: false, error: null };
try { const s = JSON.parse(sessionStorage.getItem("deanery.mock.session") || "null"); if (s) Object.assign(auth, { on: true, login: s.login }); } catch { /* нет доступа */ }
let loginHtml = () => `<div class="login"><form class="card login-card" data-login>
  <div class="brand"><span class="orb logo-orb" aria-hidden="true"></span><b>Деканат</b></div>
  <h1>Вход</h1>
  <label class="field"><span>Логин</span><input class="text-input" name="login" autocomplete="username" value="${esc(auth.login)}" required></label>
  <label class="field"><span>Пароль</span><input class="text-input" type="password" name="password" autocomplete="current-password" required></label>
  ${auth.error ? `<p class="form-error" role="alert">${esc(auth.error)}</p>` : ""}
  <button class="btn primary" ${auth.busy ? "disabled" : ""}>${auth.busy ? "Входим…" : "Войти"}</button>
</form></div>`;
async function doLogin(form) {
  const login = form.login.value.trim(), password = form.password.value;
  if (!login || !password) { auth.error = "Введите логин и пароль"; return render(); }
  auth.busy = true; auth.error = null; auth.login = login; render();
  await wait(500);
  Object.assign(auth, { on: true, busy: false });
  try { sessionStorage.setItem("deanery.mock.session", JSON.stringify({ login })); } catch { /* нет доступа */ }
  render();
}
function logout() {
  Object.assign(auth, { on: false, error: null });
  meOpen = false;
  try { sessionStorage.removeItem("deanery.mock.session"); } catch { /* нет доступа */ }
  modals.length = 0;
  render();
}

/* ═════════ ВКЛАДКИ ═════════ */
const TABS = [
  { id: "students", title: "Студенты", icon: "users" },
  { id: "groups", title: "Группы", icon: "layers" },
  { id: "schedule", title: "Расписание", icon: "calendar" },
  { id: "works", title: "Курсовые и ВКР", short: "КР и ВКР", icon: "cap" },
  { id: "requests", title: "Заявки на справки", short: "Справки", icon: "file" },
  { id: "practice", title: "Практики", icon: "briefcase" },
  { id: "employees", title: "Сотрудники", icon: "badge" },
  { id: "olap", title: "OLAP-анализ", short: "OLAP", icon: "chart" },
];
const currentTab = () => { const id = location.hash.replace(/^#\/?/, "").split("?")[0]; return TABS.some((x) => x.id === id) ? id : TABS[0].id; };
// Переход с другой вкладки: фильтры сбрасываются и ставится фильтр по колонке (как ?group_name=… во фронте)
function goTab(tab, filters = {}) {
  const cols = TABLE_COLS[tab];
  if (cols && Object.keys(filters).length) {
    const s = ts(tab);
    Object.assign(s, { q: "", f: {}, sort: null, page: 1 });
    for (const [k, v] of Object.entries(filters)) { const i = cols.findIndex((c) => c.field === k); if (i >= 0) s.f[i] = [labelOf(v)]; }
  }
  location.hash = `#/${tab}`;
}

const shellHtml = () => `<div class="app" id="app">
  <header class="topbar">
    <div class="brand"><span class="orb logo-orb" aria-hidden="true"></span><b>Деканат</b></div>
    <div class="chat-slot" id="chatSlot"></div>
    <div class="me" id="me"></div>
  </header>
  <div class="scrim" id="scrim"></div>
  <main class="content" id="content"><div class="page" id="page"></div></main>
  <nav class="tabbar" aria-label="Разделы"><div class="tabs" role="tablist" id="tabs"></div></nav>
</div>`;

let meOpen = false;
const meHtml = () => `<div class="when"><b>${WD_FULL[D(TODAY).getUTCDay()]}, ${human(TODAY)}</b></div>
  <button class="avatar t${tone(ME.full_name)} avatar-btn" data-a="me" title="${esc(`${ME.full_name} — ${ROLE_NAME}`)}" aria-haspopup="menu" aria-expanded="${meOpen}">${initials(ME.full_name)}</button>
  ${meOpen ? `<div class="menu" role="menu"><div class="menu-head"><b>${esc(ME.full_name)}</b><small>${ROLE_NAME} · ${esc(myLogin())}</small></div>
    <button role="menuitem" class="menu-item" data-a="account">${icon("users")}<span>Личный кабинет</span></button>
    <button role="menuitem" class="menu-item" data-a="logout">${icon("logout")}<span>Выйти</span></button></div>` : ""}`;
function tabsHtml() {
  const cur = currentTab(), i = TABS.findIndex((x) => x.id === cur);
  return `<span class="tab-ind" aria-hidden="true"></span>${TABS.map((x) =>
    `<a class="tab${x.id === cur ? " active" : ""}" role="tab" href="#/${x.id}" title="${x.title}" aria-selected="${x.id === cur}"${x.id === cur ? ' aria-current="page"' : ""}>${icon(x.icon)}<span>${x.short || x.title}</span></a>`).join("")}`;
}
// Страница вкладки: заголовок и блоки, которые появляются по очереди
const pageView = (tab, title, parts) => `<div class="view" data-k="${tab}">
  <div class="rise" style="--i:0"><header class="page-head"><div class="titles"><h1>${title}</h1></div></header></div>
  ${parts.filter(Boolean).map((p, i) => `<div class="rise" style="--i:${i + 1}">${p}</div>`).join("")}</div>`;
const addBtn = (a) => `<button class="btn sm primary" data-a="${a}">${icon("plus")}Добавить</button>`;

/* ═════════ КОЛОНКИ ТАБЛИЦ (pages/columns.tsx) ═════════ */
const STUDENT_COLS = [
  { label: "ФИО", field: "student", filter: "text" },
  { label: "Зачётка", field: "record_book_number", filter: "text" },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Курс", field: "course", filter: "enum", className: "num" },
  { label: "Статус", field: "status", filter: "enum", className: "wrap-xs" },
  { label: "Основа", field: "funding", filter: "enum" },
  { label: "Ср. балл", field: "avg_points", filter: "num", className: "num" },
  { label: "Долги", field: "debts", filter: "num", className: "num", text: (r) => (r.debts ? String(r.debts) : "—"), render: (r) => (r.debts ? `<span class="late">${r.debts}</span>` : "—") },
  { label: "Посещ., %", field: "attendance_pct", filter: "num", className: "num", text: (r) => fmtNum(r.attendance_pct, 1) },
  { label: "Стипендия", field: "scholarships", filter: "enum", className: "wrap-sm" },
  { label: "Староста", field: "is_headman", filter: "bool", text: (r) => yes(r.is_headman), grow: 0.3 },
  { label: "Иностранец", field: "is_foreign", filter: "bool", text: (r) => yes(r.is_foreign), grow: 0.3 },
  { label: "Общежитие", field: "needs_dormitory", filter: "bool", text: (r) => yes(r.needs_dormitory), grow: 0.3 },
  { label: "Категория", field: "category", filter: "enum", badge: true, grow: 3, render: (r) => badge(t(r.category), CATEGORY_KIND[r.category]) },
];
const GROUP_COLS = [
  { label: "Группа", field: "group_name", filter: "enum", bold: true, render: (r) => `<b>${esc(t(r.group_name))}</b>` },
  { label: "Направление", field: "specialty", filter: "enum" },
  { label: "Профиль", field: "profile", filter: "enum", className: "wrap" },
  { label: "Форма", field: "study_form", filter: "enum" },
  { label: "Год набора", field: "admission_year", filter: "enum", className: "num" },
  { label: "Курс", field: "course", filter: "enum", className: "num" },
  { label: "Семестр", field: "current_semester", filter: "enum", className: "num" },
  { label: "Куратор", field: "curator", filter: "enum" },
  { label: "Староста", field: "headman", filter: "text" },
  { label: "Студентов", field: "active_students", filter: "num", className: "num" },
  { label: "Из них бюджет", field: "budget_students", filter: "num", className: "num" },
];
const SCHEDULE_COLS = [
  { label: "Дата", field: "lesson_date", text: (r) => fmtDate(r.lesson_date) },   // даты задаёт переключатель недель
  { label: "День", field: "weekday_name", filter: "enum", order: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] },
  { label: "Пара", field: "pair_number", filter: "enum", className: "num" },
  { label: "Начало", field: "start_time", filter: "enum" },
  { label: "Окончание", field: "end_time", filter: "enum" },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Дисциплина", field: "discipline", filter: "enum" },
  { label: "Вид", field: "lesson_type", filter: "enum", badge: true, render: (r) => badge(r.lesson_type, LESSON_KIND[r.lesson_type]) },
  { label: "Преподаватель", field: "teacher", filter: "enum" },
  { label: "Аудитория", field: "classroom", filter: "enum" },
  { label: "Подгруппа", field: "subgroup", filter: "enum", className: "num" },
  { label: "Неделя", field: "week", filter: "enum" },
];
const WORK_COLS = [
  { label: "Студент", field: "student", filter: "text" },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Вид работы", field: "work_kind", filter: "enum" },
  { label: "Дисциплина", field: "discipline", filter: "enum" },
  { label: "Семестр", field: "semester", filter: "enum", className: "num" },
  { label: "Тема", field: "topic", filter: "text", className: "wrap" },
  { label: "Руководитель", field: "supervisor", filter: "enum" },
  { label: "Рецензент", field: "reviewer", filter: "enum" },
  { label: "Приказ", field: "order_number", filter: "enum" },
];
const REQUEST_COLS = [
  { label: "№", field: "request_id", filter: "text" },
  { label: "Студент", field: "student", filter: "text" },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Документ", field: "document", filter: "enum" },
  { label: "Экз.", field: "copies", filter: "num", className: "num" },
  { label: "Цель", field: "purpose", filter: "enum" },
  { label: "Статус", field: "status", filter: "enum", badge: true, render: (r) => badge(t(r.status), STATUS_KIND[r.status]) },
  { label: "Создана", field: "created_at", filter: "date", text: (r) => fmtDateTime(r.created_at) },
  { label: "Срок", field: "due_date", filter: "date",
    render: (r) => (isOverdue(r) ? `<span class="late" title="Просрочена">${fmtDate(r.due_date)}</span>`
      : r.due_date === TODAY && !FINAL_STATUS.includes(r.status) ? `<span class="soon" title="Срок сегодня">${fmtDate(r.due_date)}</span>` : fmtDate(r.due_date)) },
  { label: "Исполнитель", field: (r) => r.processed_by || null, filter: "enum" },
];
const PRACTICE_COLS = [
  { label: "Студент", field: "student", filter: "text" },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Практика", field: "practice", filter: "enum" },
  { label: "Семестр", field: "semester", filter: "enum", className: "num" },
  { label: "Организация", field: "organization", filter: "enum" },
  { label: "Руководитель от вуза", field: "supervisor", filter: "enum" },
  { label: "Руководитель от организации", field: "org_supervisor", filter: "enum" },
  { label: "Начало", field: "start_date", filter: "date" },
  { label: "Окончание", field: "end_date", filter: "date" },
  { label: "Приказ", field: "order_number", filter: "enum" },
];
const EMPLOYEE_COLS = [
  { label: "Таб. №", field: "personnel_number", filter: "text" },
  { label: "ФИО", field: "full_name", filter: "text" },
  { label: "Должность", field: "position", filter: "enum" },
  { label: "Категория", field: (r) => EMPLOYEE_CATEGORY[r.category] ?? r.category, filter: "enum", className: "wrap-sm" },
  { label: "Подразделение", field: "unit", filter: "enum" },
  { label: "Ставка", field: "employment_rate", filter: "num", className: "num", text: (r) => fmtNum(r.employment_rate, 2) },
  { label: "Принят", field: "hire_date", filter: "date" },
  { label: "Уволен", field: "dismissal_date", filter: "date" },
];
const TABLE_COLS = { students: STUDENT_COLS, groups: GROUP_COLS, works: WORK_COLS, requests: REQUEST_COLS, practice: PRACTICE_COLS, employees: EMPLOYEE_COLS };

/* ═════════ СПИСКИ ДЛЯ ВЫПАДАЮЩИХ ПОЛЕЙ (components/form/lookups.ts) ═════════ */
const join = (...p) => p.filter((x) => x != null && x !== "").join(" · ");
const opt = {
  list: (arr) => () => arr.map((x) => ({ value: x, label: x })),
  students: () => students.map((s) => ({ value: String(s.student_id), label: s.student, sub: join(s.group_name, s.record_book_number, s.status), row: s })),
  teachers: () => teachers.filter((e) => !e.dismissal_date).map((e) => ({ value: e.full_name, label: e.full_name, sub: join(e.position, e.unit) })),
  employees: () => employees.filter((e) => !e.dismissal_date).map((e) => ({ value: e.full_name, label: e.full_name, sub: join(e.position, e.unit) })),
  staff: () => deanStaff.map((e) => ({ value: e.full_name, label: e.full_name, sub: e.position })),
  groups: () => GROUPS.map((g) => ({ value: g.name, label: g.name, sub: g.is_archived ? "в архиве" : undefined, row: g })),
  curricula: () => CURRICULA.map((c) => ({ value: String(c.curriculum_id), label: join(PROGRAM.spec, c.start_year), sub: join(PROGRAM.profile, PROGRAM.form) })),
  items: () => ITEMS.map((i) => ({ value: i.item_id, label: i.discipline, sub: join(`${i.semester} сем.`, KIND_NAME[i.kind], i.control_type, `${PROGRAM.spec}, ${i.start_year}`), row: i })),
  assignments: () => ASSIGNMENTS.map((a) => ({ value: String(a.assignment_id), label: join(a.group_name, a.discipline), sub: join(a.lesson_type, a.teacher), row: a })),
  rooms: () => CLASSROOMS.map(([n, c, k]) => ({ value: n, label: n.replace("-", " · "), sub: join(`${c} мест`, k) })),
  pairs: () => PAIRS.slice(1).map((p, i) => ({ value: String(i + 1), label: `${i + 1} пара`, sub: `${p[0]}–${p[1]}` })),
  terms: () => TERMS.map(([n, a, b]) => ({ value: n, label: n, sub: `${a} — ${b}` })),
  contacts: () => ORG_CONTACTS.map(([org, n, job]) => ({ value: n, label: n, sub: join(org, job) })),
  orders: () => ORDERS.map(([n, title, d]) => ({ value: n, label: n, sub: join(title, d) })),
  positions: () => POSITIONS.slice(1).map(([p]) => ({ value: p, label: p })),
  docTypes: () => DOC_TYPES.map(([d]) => ({ value: d, label: d })),
  people: () => PEOPLE.map((p) => ({ value: fio(p), label: fio(p), sub: p.email })),
  weekdays: () => WEEKDAYS.slice(1).map((d, i) => ({ value: String(i + 1), label: ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"][i] })),
  parity: () => [["every", "каждая"], ["odd", "нечётная"], ["even", "чётная"]].map(([value, label]) => ({ value, label })),
};
const studentById2 = (id) => students.find((s) => String(s.student_id) === String(id));
const itemById = (id) => ITEMS.find((i) => i.item_id === id);
const rel = (name, label, options, more = {}) => ({ name, label, kind: "relation", options, ...more });
const record = (o) => ({ cleanDisabled: !!o.row, submitLabel: o.row ? "Сохранить" : "Добавить", busyLabel: "Сохраняем…", ...o });
const saved = (id, key, created) => ({ toast: created ? "Запись добавлена" : "Изменение сохранено", flash: { id, key } });

/* ═════════ СТУДЕНТЫ ═════════
   Напрямую у студента меняются только основа, общежитие и гражданство; группа и статус — приказами */
function openStudent(s) {
  formDialog(record({ row: s, title: s.student, note: "Группа и статус меняются приказом — кнопка «Приказ» внизу окна.",
    fields: [rel("funding_type_id", "Основа обучения", opt.list(FUNDING), { required: true }),
      { name: "needs_dormitory", label: "Нуждается в общежитии", kind: "bool" },
      { name: "is_foreign", label: "Иностранный гражданин", kind: "bool" }],
    base: { funding_type_id: s.funding, needs_dormitory: s.needs_dormitory, is_foreign: s.is_foreign },
    onSubmit: (v) => { Object.assign(s, { funding: v.funding_type_id, funding_type_id: v.funding_type_id, needs_dormitory: v.needs_dormitory, is_foreign: v.is_foreign }); categorize(s); return saved("students", s.student_id); },
    extra: (m) => { const actions = STUDENT_ACTIONS.filter((a) => !a.when || a.when(s.status));
      return `<div class="menu-wrap"><button type="button" class="btn soft" data-a="orders" aria-haspopup="menu" aria-expanded="${!!m.menu}">${icon("file")}Приказ${icon("down")}</button>
        ${m.menu ? `<div class="menu up" role="menu">${actions.map((a) => `<button type="button" role="menuitem" class="menu-item" data-a="wf" data-wf="${a.name}"><span>${a.title}</span></button>`).join("")}</div>` : ""}</div>`; },
    extraClick: (el, m) => {
      const a = el.dataset?.a;
      if (a === "orders") { m.menu = !m.menu; render(); }
      else if (a === "wf") { m.menu = false; render(); workflowDialog(STUDENT_ACTIONS.find((x) => x.name === el.dataset.wf), s); }
      else if (m.menu) { m.menu = false; render(); }
    } }));
}

/* ── Приказы по студентам (pages/students/studentActions.ts) ── */
const ORDER = [
  rel("order_number", "Номер приказа", null, { kind: "text", required: true }),
  rel("signed_by", "Подписал", opt.employees, { required: true }),
  { name: "effective_date", label: "Вступает в силу", kind: "date", hint: "Пусто — сегодня. Будущая дата — приказ будет запланирован" },
];
const active = (st) => st === ACTIVE;
const groupField = (name, label, more = {}) => rel(name, label, opt.groups, { filter: (o) => !o.row.is_archived, ...more });
const STUDENT_ACTIONS = [
  { name: "transfer_student", title: "Перевод в другую группу", confirm: "Перевести", when: active,
    fields: [groupField("group_name", "Новая группа", { required: true }), ...ORDER],
    apply: (s, v) => moveStudent(s, v.group_name) },
  { name: "grant_academic_leave", title: "Академический отпуск", confirm: "Оформить", when: active,
    fields: [rel("reason", "Причина", opt.list(LEAVE_REASONS), { required: true }), { name: "start", label: "Начало", kind: "date", required: true },
      { name: "end", label: "Окончание", kind: "date", required: true }, ...ORDER.filter((f) => f.name !== "effective_date")],
    effective: (v) => v.start, apply: (s) => setStatus(s, "Академический отпуск") },
  { name: "return_from_leave", title: "Выход из академического отпуска", confirm: "Оформить", when: (st) => st === "Академический отпуск",
    fields: [groupField("group_name", "Группа", { hint: "Пусто — прежняя группа" }), ...ORDER],
    apply: (s, v) => { if (v.group_name) moveStudent(s, v.group_name); setStatus(s, ACTIVE); } },
  { name: "expel_student", title: "Отчисление", confirm: "Отчислить", when: (st) => st !== "Отчислен",
    fields: [{ name: "reason", label: "Основание", kind: "textarea", required: true }, ...ORDER],
    apply: (s) => setStatus(s, "Отчислен") },
  { name: "reinstate_student", title: "Восстановление", confirm: "Восстановить", when: (st) => st === "Отчислен",
    fields: [groupField("group_name", "Группа", { required: true }), ...ORDER],
    apply: (s, v) => { moveStudent(s, v.group_name); setStatus(s, ACTIVE); } },
];
const ENROLL = { name: "enroll_student", title: "Зачисление студента", confirm: "Зачислить",
  fields: [
    { name: "last_name", label: "Фамилия", kind: "text", required: true }, { name: "first_name", label: "Имя", kind: "text", required: true },
    { name: "middle_name", label: "Отчество", kind: "text" },
    { name: "gender", label: "Пол", kind: "choice", required: true, options: () => [{ value: "M", label: "Мужской" }, { value: "F", label: "Женский" }] },
    { name: "birth_date", label: "Дата рождения", kind: "date", required: true }, { name: "email", label: "Email", kind: "text" },
    { name: "phone", label: "Телефон", kind: "text" }, groupField("group_name", "Группа", { required: true }),
    rel("funding", "Основа обучения", opt.list(FUNDING), { required: true }), { name: "record_book", label: "Номер зачётной книжки", kind: "text", required: true },
    ...ORDER],
  apply: (_, v) => {
    if (students.some((s) => s.record_book_number === v.record_book.trim())) throw new Error("Зачётная книжка с таким номером уже есть");
    const g = GROUPS.find((x) => x.name === v.group_name);
    const s = { student_id: Math.max(...students.map((x) => x.student_id)) + 1, student: [v.last_name, v.first_name, v.middle_name].map((x) => x.trim()).filter(Boolean).join(" "),
      record_book_number: v.record_book.trim(), group_name: g.name, course: course(g.year), status: ACTIVE, funding: v.funding, funding_type_id: v.funding,
      attendance_pct: null, is_headman: false, is_foreign: false, needs_dormitory: false, results: 0, avg_points: null, min_mark: null };
    students.push(s);
    categorize(s);
    return s;
  } };
function moveStudent(s, to) {
  const from = s.group_name;
  s.group_name = to;
  s.course = course(GROUPS.find((g) => g.name === to).year);
  s.is_headman = false;   // староста перестаёт быть старостой при переводе
  [results, debtors, expulsion, practices, works, requests].forEach((list) => list.forEach((r) => { if (r.student_id === s.student_id && r.group_name === from) r.group_name = to; }));
}
function setStatus(s, st) {
  s.status = st;
  if (st !== ACTIVE) { s.is_headman = false; s.attendance_pct = null; }
  categorize(s);
}
// Форма приказа: одна отправка на открытие окна — повторное нажатие не создаст второй приказ
function workflowDialog(def, s = null) {
  formDialog({ title: def.title, subtitle: s ? `${s.student} · ${s.group_name}` : "", fields: def.fields,
    submitLabel: def.confirm, busyLabel: "Проводим…",
    unsaved: { title: "Провести приказ?", text: "Форма приказа заполнена, но приказ ещё не проведён.", saveLabel: def.confirm },
    checks: (v) => ({ end: v.start && v.end && v.end < v.start ? "Окончание не может быть раньше начала" : undefined }),
    onSubmit: (v) => {
      // Ошибки базы по приказу (FORM_SIM): дата — под датой вступления в силу (в академе — под началом), подписант — под «Подписал»
      formSim({ "RW-07": def.fields.some((f) => f.name === "effective_date") ? "effective_date" : "start", "RW-08": "signed_by", ...(s ? { "RW-09": null } : {}) });
      const when = def.effective?.(v) || v.effective_date;
      if (when && when > TODAY) return { toast: `Приказ запланирован на ${fmtDate(when)}` };
      const res = def.apply(s, v) || s;
      return { toast: "Приказ проведён", flash: { id: "students", key: res.student_id } };
    } });
}

/* ═════════ ГРУППЫ ═════════ */
const groupValues = (g) => ({ name: g.name, curriculum_id: String(g.year), curator_id: g.curator ?? "",
  headman_id: String(students.find((s) => s.group_name === g.name && s.is_headman)?.student_id ?? ""), is_archived: g.is_archived });
function openGroup(g) {
  formDialog(record({ row: g, title: g ? `Группа ${g.name}` : "Новая группа",
    fields: [{ name: "name", label: "Шифр группы", kind: "text", required: true, hint: "ИДБ-24-11 — институт, форма, уровень, год набора, номер группы" },
      rel("curriculum_id", "Учебный план", opt.curricula, { required: true, hint: "даёт программу, форму и год набора" }),
      rel("curator_id", "Куратор группы", opt.teachers),
      // Староста — только из студентов этой группы
      rel("headman_id", "Староста группы", opt.students, { filter: (o, v) => !v.name || o.row.group_name === v.name }),
      { name: "is_archived", label: "Группа выпущена или расформирована", kind: "bool" }],
    base: g ? groupValues(g) : undefined,
    onSubmit: (v) => {
      const name = v.name.trim();
      if (GROUPS.some((x) => x !== g && x.name === name)) throw new Error("Группа с таким шифром уже есть");
      if (!g) {
        g = { ...PROGRAM, group_id: Math.max(...GROUPS.map((x) => x.group_id)) + 1, name, year: +v.curriculum_id, curriculum_id: +v.curriculum_id, curator: v.curator_id || null, is_archived: v.is_archived };
        GROUPS.push(g); GROUP_NAMES.push(name);
        return saved("groups", g.group_id, true);
      }
      if (g.name !== name) renameGroup(g.name, name);
      Object.assign(g, { name, year: +v.curriculum_id, curriculum_id: +v.curriculum_id, curator: v.curator_id || null, is_archived: v.is_archived });
      students.filter((s) => s.group_name === name).forEach((s) => { s.is_headman = String(s.student_id) === v.headman_id; s.course = course(g.year); });
      return saved("groups", g.group_id);
    },
    onDelete: g && (() => {
      if (students.some((s) => s.group_name === g.name)) throw new Error("Нельзя удалить: в группе есть студенты. Отметьте группу как выпущенную или расформированную.");
      GROUPS.splice(GROUPS.indexOf(g), 1); GROUP_NAMES.splice(GROUP_NAMES.indexOf(g.name), 1);
    }) }));
}
function renameGroup(from, to) {
  [students, results, debtors, expulsion, practices, works, requests, slots, ASSIGNMENTS].forEach((list) => list.forEach((r) => { if (r.group_name === from) r.group_name = to; }));
  GROUP_NAMES[GROUP_NAMES.indexOf(from)] = to;
  buildSchedule();
}

/* ═════════ РАСПИСАНИЕ ═════════ */
const sched = { view: "table", date: TODAY, by: "group", who: "", own: false };   // own — своё расписание (преподаватель, студент): без выбора и правок
const SCHEDULE_BY = [["group", "Группа", "group_name"], ["teacher", "Преподаватель", "teacher"], ["classroom", "Аудитория", "classroom"]];
const byField = (by) => SCHEDULE_BY.find(([v]) => v === by)[2];
const whoOptions = () => [...new Set(schedule.map((l) => String(l[byField(sched.by)] ?? "")).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
const curWho = () => { const o = whoOptions(); return o.includes(sched.who) ? sched.who : o[0] ?? ""; };
// Как в fn_check_slot: в одну пару у группы, преподавателя и аудитории — не больше одного занятия
const overlapsP = (a, b) => a === "every" || b === "every" || a === b;
function openSlot(slot, initial = {}) {
  const who = curWho();
  formDialog(record({ row: slot, title: slot ? "Занятие в расписании" : "Новое занятие",
    note: slot ? "Изменится занятие на все даты семестра, а не только на выбранный день." : "",
    fields: [
      // Выбранная в «Неделе» группа или преподаватель сужает список поручений
      rel("assignment_id", "Занятие (группа · дисциплина)", opt.assignments, { required: true,
        filter: sched.view === "week" && sched.by !== "classroom" && who ? (o) => String(o.row[sched.by === "group" ? "group_name" : "teacher"]) === who : null }),
      rel("classroom_id", "Аудитория", opt.rooms, { required: true }),
      { name: "weekday", label: "День недели", kind: "choice", required: true, options: opt.weekdays },
      rel("pair_number", "Номер пары", opt.pairs, { required: true }),
      ...(slot ? [{ name: "week_parity", label: "Неделя", kind: "choice", options: opt.parity }] : []),   // в новом занятии — «каждая»
      rel("term_id", "Семестр", opt.terms, { required: true }),
      { name: "valid_from", label: "Действует с", kind: "date", hint: "пусто — с начала семестра" },
      { name: "valid_to", label: "Действует по", kind: "date", hint: "пусто — до конца занятий" }],
    base: slot ? { assignment_id: String(slot.assignment_id), classroom_id: slot.classroom, weekday: String(slot.weekday), pair_number: String(slot.pair_number),
      week_parity: slot.parity, term_id: slot.term_id, valid_from: slot.valid_from, valid_to: slot.valid_to } : undefined,
    values: initial,
    checks: (v) => ({ valid_to: v.valid_from && v.valid_to && v.valid_to < v.valid_from ? "«Действует по» не может быть раньше «Действует с»" : undefined }),
    onSubmit: (v) => {
      formSim({ "RW-10": "assignment_id" });
      const a = ASSIGNMENTS.find((x) => String(x.assignment_id) === v.assignment_id);
      const next = { ...(slot ?? { slot_id: Math.max(...slots.map((x) => x.slot_id)) + 1, parity: "every" }),
        assignment_id: a.assignment_id, group_name: a.group_name, discipline: a.discipline, lesson_type: a.lesson_type, teacher: a.teacher, subgroup: a.subgroup,
        classroom: v.classroom_id, weekday: +v.weekday, pair_number: +v.pair_number, parity: v.week_parity || slot?.parity || "every",
        term_id: v.term_id, valid_from: v.valid_from, valid_to: v.valid_to };
      const clash = slots.find((o) => o.slot_id !== next.slot_id && o.weekday === next.weekday && o.pair_number === next.pair_number && overlapsP(o.parity, next.parity)
        && (o.group_name === next.group_name || o.teacher === next.teacher || o.classroom === next.classroom));
      if (clash) throw new Error(`В это время уже есть занятие: ${clash.group_name}, ${clash.discipline}, ${clash.teacher}, ауд. ${clash.classroom}`);
      if (slot) Object.assign(slot, next); else slots.push(next);
      buildSchedule();
      return { toast: slot ? "Изменение сохранено" : "Запись добавлена" };
    },
    onDelete: slot && (() => { slots.splice(slots.indexOf(slot), 1); buildSchedule(); }) }));
}
const slotById = (id) => slots.find((s) => s.slot_id === +id);

/* ═════════ КУРСОВЫЕ И ВКР ═════════ */
function openWork(w) {
  formDialog(record({ row: w, title: w ? `${w.work_kind}: ${w.student}` : "Новая работа",
    fields: [rel("student_id", "Студент", opt.students, { required: true, locked: !!w }),
      // В списке — только курсовые и ВКР
      rel("item_id", "Работа из учебного плана", opt.items, { required: true, filter: (o) => o.row.kind === "coursework" || o.row.kind === "final_attestation" }),
      { name: "topic", label: "Тема работы", kind: "textarea", required: true },
      rel("supervisor_id", "Научный руководитель", opt.teachers, { required: true }), rel("reviewer_id", "Рецензент", opt.teachers),
      rel("order_id", "Приказ об утверждении темы", opt.orders)],
    base: w ? { student_id: String(w.student_id), item_id: w.item_id, topic: w.topic, supervisor_id: w.supervisor, reviewer_id: w.reviewer ?? "", order_id: w.order_number ?? "" } : undefined,
    onSubmit: (v) => {
      if (v.reviewer_id && v.reviewer_id === v.supervisor_id) throw new Error("Рецензент не может быть руководителем этой же работы");
      const s = studentById2(v.student_id), it = itemById(v.item_id);
      const row = { student_id: s.student_id, student: s.student, group_name: s.group_name, item_id: it.item_id, work_kind: it.kind === "coursework" ? "Курсовая работа" : "ВКР",
        discipline: it.discipline, semester: it.semester, topic: v.topic.trim(), supervisor: v.supervisor_id, reviewer: v.reviewer_id || null, order_number: v.order_id || null };
      if (w) { Object.assign(w, row); return saved("works", w.work_id); }
      row.work_id = Math.max(0, ...works.map((x) => x.work_id)) + 1;
      works.push(row);
      return saved("works", row.work_id, true);
    },
    onDelete: w && (() => works.splice(works.indexOf(w), 1)) }));
}

/* ═════════ ЗАЯВКИ НА СПРАВКИ ═════════ */
function openRequest(r) {
  formDialog(record({ row: r, title: r ? `Заявка № ${r.request_id}: ${r.student}` : "Новая заявка",
    fields: [rel("student_id", "Студент-заявитель", opt.students, { required: true, locked: !!r }),
      rel("document_type_id", "Вид документа", opt.docTypes, { required: true }),
      { name: "copies", label: "Количество экземпляров", kind: "int", range: [1, 10] },
      { name: "purpose", label: "Куда требуется справка", kind: "text" },
      rel("request_status_id", "Статус заявки", opt.list(REQUEST_STATUSES), { required: true }), rel("processed_by_id", "Исполнитель", opt.staff)],
    base: r ? { student_id: String(r.student_id), document_type_id: r.document, copies: String(r.copies), purpose: r.purpose ?? "", request_status_id: r.status, processed_by_id: r.processed_by ?? "" } : undefined,
    // Сотрудник взял заявку в работу — исполнителем становится он
    derive: (changed, v) => (changed === "request_status_id" && !v.processed_by_id ? { processed_by_id: ME.full_name } : {}),
    onSubmit: (v) => {
      const s = studentById2(v.student_id), doc = DOC_TYPES.find(([d]) => d === v.document_type_id);
      const row = { student_id: s.student_id, student: s.student, group_name: s.group_name, document: v.document_type_id, copies: +v.copies || 1,
        purpose: v.purpose.trim() || null, status: v.request_status_id || "Новая", processed_by: v.processed_by_id || null };
      if (r) { Object.assign(r, row); return saved("requests", r.request_id); }
      const id = Math.max(...requests.map((x) => x.request_id)) + 1;
      requests.push({ ...row, request_id: id, created_at: `${TODAY} ${new Date().toTimeString().slice(0, 5)}`, due_date: addDays(TODAY, doc[1]) });
      return saved("requests", id, true);
    } }));   // удалять заявки сотрудник деканата не может — кнопки «Удалить» во фронте нет
}

/* ═════════ ПРАКТИКИ ═════════ */
function openPractice(p) {
  formDialog(record({ row: p, title: p ? `${p.practice}: ${p.student}` : "Направление на практику",
    fields: [rel("student_id", "Студент", opt.students, { required: true, locked: !!p }),
      rel("item_id", "Практика из учебного плана", opt.items, { required: true, filter: (o) => o.row.kind === "practice" }),
      rel("supervisor_id", "Руководитель практики от вуза", opt.teachers, { required: true }),
      rel("org_contact_id", "Руководитель от организации", opt.contacts, { required: true, hint: "через него — база практики" }),
      { name: "start_date", label: "Начало практики", kind: "date", required: true }, { name: "end_date", label: "Окончание практики", kind: "date", required: true },
      rel("order_id", "Приказ о направлении на практику", opt.orders)],
    base: p ? { student_id: String(p.student_id), item_id: p.item_id, supervisor_id: p.supervisor, org_contact_id: p.org_contact_id ?? "",
      start_date: p.start_date, end_date: p.end_date, order_id: p.order_number ?? "" } : undefined,
    checks: (v) => ({ end_date: v.start_date && v.end_date && v.end_date < v.start_date ? "Окончание не может быть раньше начала" : undefined }),
    onSubmit: (v) => {
      const s = studentById2(v.student_id), it = itemById(v.item_id), c = ORG_CONTACTS.find(([, n]) => n === v.org_contact_id);
      const row = { student_id: s.student_id, student: s.student, group_name: s.group_name, item_id: it.item_id, practice: it.discipline, semester: it.semester,
        organization: c?.[0] ?? null, supervisor: v.supervisor_id, org_contact_id: v.org_contact_id || null, org_supervisor: c ? `${c[1]}, ${c[2]}` : null,
        start_date: v.start_date, end_date: v.end_date, order_number: v.order_id || null };
      if (p) { Object.assign(p, row); return saved("practice", p.placement_id); }
      row.placement_id = Math.max(0, ...practices.map((x) => x.placement_id)) + 1;
      practices.push(row);
      return saved("practice", row.placement_id, true);
    },
    onDelete: p && (() => practices.splice(practices.indexOf(p), 1)) }));
}

/* ═════════ СОТРУДНИКИ ═════════
   У созданного сотрудника человек не меняется — правится только его ФИО */
function openEmployee(e) {
  const person = e ? [{ name: "last_name", label: "Фамилия", kind: "text", required: true }, { name: "first_name", label: "Имя", kind: "text", required: true },
    { name: "middle_name", label: "Отчество", kind: "text", hint: "может отсутствовать" }] : [rel("person_id", "Человек", opt.people, { required: true })];
  formDialog(record({ row: e, title: e ? e.full_name : "Новый сотрудник",
    fields: [...person, { name: "personnel_number", label: "Табельный номер", kind: "text", required: true },
      rel("position_id", "Должность", opt.positions, { required: true }),
      { name: "employment_rate", label: "Доля ставки", kind: "decimal", range: [0.25, 1.5], hint: "0.25–1.50" },
      { name: "hire_date", label: "Дата приёма на работу", kind: "date", required: true }, { name: "dismissal_date", label: "Дата увольнения", kind: "date", hint: "пусто — работает" }],
    base: e ? { last_name: e.last_name, first_name: e.first_name, middle_name: e.middle_name ?? "", personnel_number: e.personnel_number, position_id: e.position,
      employment_rate: String(e.employment_rate), hire_date: e.hire_date, dismissal_date: e.dismissal_date ?? "" } : undefined,
    checks: (v) => ({ dismissal_date: v.dismissal_date && v.hire_date && v.dismissal_date < v.hire_date ? "Дата увольнения не может быть раньше даты приёма" : undefined }),
    onSubmit: (v) => {
      if (employees.some((x) => x !== e && x.personnel_number === v.personnel_number.trim())) throw new Error("Сотрудник с таким табельным номером уже есть");
      const pos = POSITIONS.find((x) => x && x[0] === v.position_id);
      const names = e ? [v.last_name, v.first_name, v.middle_name].map((x) => x.trim()) : v.person_id.split(" ");
      const row = { last_name: names[0], first_name: names[1], middle_name: names[2] || null, full_name: names.filter(Boolean).join(" "), personnel_number: v.personnel_number.trim(),
        position: pos[0], position_id: pos[0], category: pos[1], employment_rate: v.employment_rate === "" ? 1 : +String(v.employment_rate).replace(",", "."), hire_date: v.hire_date, dismissal_date: v.dismissal_date || null };
      if (e) { Object.assign(e, row); return saved("employees", e.employee_id); }
      const id = Math.max(...employees.map((x) => x.employee_id)) + 1;
      employees.push({ ...row, employee_id: id, unit: pos[1] === "teaching" ? "ИС" : "Деканат" });
      PEOPLE.splice(PEOPLE.findIndex((p) => fio(p) === v.person_id), 1);
      return saved("employees", id, true);
    },
    onDelete: e && (() => employees.splice(employees.indexOf(e), 1)) }));
}

/* ═════════ СТРАНИЦЫ ═════════ */
const PAGES = {};
const tablePage = (tab, title, cols, all, { key, open, add = true, actions = "" }) => {
  const rows = applyTable(tab, cols, all);
  return pageView(tab, title, [
    tableTools(tab, cols, all, rows.length, `<span class="spacer"></span>${actions}${add ? addBtn(`add-${tab}`) : ""}`),
    dataTable(tab, cols, rows, all, { rowKey: key, onRow: open })]);
};
PAGES.students = () => tablePage("students", "Студенты", STUDENT_COLS, students, { key: (r) => r.student_id, open: openStudent, add: false,
  actions: `<button class="btn sm primary" data-a="enroll">${icon("plus")}Зачислить</button>` });
PAGES.works = () => tablePage("works", "Курсовые и ВКР", WORK_COLS, works, { key: (r) => r.work_id, open: openWork });
PAGES.requests = () => tablePage("requests", "Заявки на справки", REQUEST_COLS, requests, { key: (r) => r.request_id, open: openRequest });
PAGES.practice = () => tablePage("practice", "Практики", PRACTICE_COLS, practices, { key: (r) => r.placement_id, open: openPractice });
PAGES.employees = () => tablePage("employees", "Сотрудники", EMPLOYEE_COLS, employees, { key: (r) => r.employee_id, open: openEmployee });

let groupsView = "cards";
PAGES.groups = () => {
  const all = GROUPS.map(groupRow);
  const rows = applyTable("groups", GROUP_COLS, all);
  const card = (r, i) => `<article class="card gcard clickable" data-k="${r.group_id}" style="--i:${i + 1}" data-a="group" data-id="${r.group_id}">
    <div class="gc-top"><span class="gc-name">${esc(r.group_name)}</span>${badge(`${r.course} курс`, "info plain")}</div>
    <p class="gc-spec">${esc(t(r.specialty))}</p><p class="gc-spec">${esc(t(r.profile))}</p>
    <dl class="kv"><dt>Форма</dt><dd>${esc(t(r.study_form))}</dd><dt>Год набора</dt><dd>${r.admission_year}</dd><dt>Семестр</dt><dd>${r.current_semester}</dd>
      <dt>Куратор</dt><dd title="${esc(t(r.curator))}">${esc(t(r.curator))}</dd><dt>Староста</dt><dd title="${esc(t(r.headman))}">${esc(t(r.headman))}</dd>
      <dt>Количество студентов</dt><dd>${r.active_students}</dd><dt>На бюджете</dt><dd>${r.budget_students}</dd></dl>
    <div class="gc-acts"><button class="btn sm soft go" data-a="group-students" data-v="${esc(r.group_name)}">Студенты${icon("arrow")}</button>
      <button class="btn sm ghost" data-a="group-schedule" data-v="${esc(r.group_name)}">Расписание</button></div></article>`;
  const body = groupsView === "cards"
    ? `<div class="enter" data-k="cards">${rows.length ? `<div class="cards stagger">${rows.map(card).join("")}</div>` : `<section class="card empty-day">${icon("search")}<b>Ничего не найдено</b></section>`}</div>`
    : `<div class="enter" data-k="table">${dataTable("groups", GROUP_COLS, rows, all, { rowKey: (r) => r.group_id, onRow: (r) => openGroup(GROUPS.find((g) => g.group_id === r.group_id)) })}</div>`;
  return pageView("groups", "Группы", [
    tableTools("groups", GROUP_COLS, all, rows.length, `<span class="spacer"></span>${addBtn("add-groups")}${seg("groups-view", [["cards", "Карточки", "grid"], ["table", "Таблица", "list"]], groupsView)}`),
    body]);
};

PAGES.schedule = () => {
  const mon = mondayOf(sched.date), prev = addDays(mon, -7), next = addDays(mon, 7);
  const bar = `<div class="week-bar"><div class="week-nav">
      <button class="icon-btn soft" data-a="week" data-v="${prev}" ${prev < mondayOf(TERM_FIRST) ? "disabled" : ""} aria-label="Предыдущая неделя">${icon("left")}</button>
      <div class="week-label"><b>${human(mon)} — ${human(addDays(mon, 5))}</b></div>
      <button class="icon-btn soft" data-a="week" data-v="${next}" ${next > TERM_LAST ? "disabled" : ""} aria-label="Следующая неделя">${icon("right")}</button>
    </div>${sched.own ? "" : seg("sched-view", [["table", "Таблица", "list"], ["week", "Неделя", "calendar"]], sched.view)}</div>`;
  if (sched.view === "table" && !sched.own) {
    // Таблица показывает выбранную неделю: даты задаёт переключатель недель, а не фильтр
    const weekRows = schedule.filter((r) => r.lesson_date >= mon && r.lesson_date <= addDays(mon, 6));
    const rows = applyTable("schedule", SCHEDULE_COLS, weekRows);
    // Панель и таблица — один блок страницы, как фрагмент во фронте
    return pageView("schedule", "Расписание", [bar,
      tableTools("schedule", SCHEDULE_COLS, weekRows, rows.length, `<span class="spacer"></span>${addBtn("add-schedule")}`)
      + `<div class="enter" data-k="table">${dataTable("schedule", SCHEDULE_COLS, rows, weekRows, { rowKey: (r) => `${r.lesson_date}|${r.slot_id}`,
        title: `${TERM_NAME} семестр · ${human(mon)} — ${human(addDays(mon, 5))}`, onRow: (r) => openSlot(slotById(r.slot_id)) })}</div>`]);
  }
  const f = byField(sched.by), who = curWho();
  const picker = sched.own ? "" : `<div class="toolbar">${seg("sched-by", SCHEDULE_BY.map(([v, l]) => [v, l]), sched.by)}
    <select class="pill-select who-select" data-who aria-label="${esc(SCHEDULE_BY.find(([v]) => v === sched.by)[1])}">${whoOptions().map((o) =>
      `<option value="${esc(o)}" ${o === who ? "selected" : ""}>${esc(o)}</option>`).join("")}</select><span class="spacer"></span>${addBtn("add-schedule")}</div>`;
  const days = Array.from({ length: 6 }, (_, i) => addDays(mon, i));
  const week = schedule.filter((l) => String(l[f]) === who && l.lesson_date >= mon && l.lesson_date <= days[5]);
  const pairs = Array.from({ length: Math.max(4, ...week.map((l) => l.pair_number)) }, (_, i) => i + 1);
  const lesson = (l) => `<button type="button" class="lesson ${l.lesson_type === "Лекция" ? "lec" : "prac"}" ${sched.own ? "" : `data-a="slot" data-id="${l.slot_id}"`}>
    <div class="l-top">${badge(l.lesson_type, LESSON_KIND[l.lesson_type])}<span class="l-room">${icon("pin")}${esc(l.classroom)}</span></div>
    <b>${esc(l.discipline)}</b><small>${[f !== "group_name" && l.group_name, l.subgroup && `подгруппа ${l.subgroup}`, f !== "teacher" && l.teacher].filter(Boolean).map(esc).join(" · ")}</small></button>`;
  const grid = `<section class="card week-card"><div class="week-grid"><div class="wg-h"></div>
    ${days.map((d) => `<div class="wg-h${d === TODAY ? " today" : ""}"><b>${WD_SHORT[D(d).getUTCDay()]}, ${human(d)}</b>${HOLIDAYS.includes(d) ? "<small>праздник</small>" : ""}</div>`).join("")}
    ${pairs.map((p) => `<div class="wg-time"><b>${PAIRS[p][0]}</b><small>${p} пара · до ${PAIRS[p][1]}</small></div>${days.map((d, di) => {
      const here = week.filter((l) => l.lesson_date === d && l.pair_number === p);
      const add = !here.length && !sched.own;
      return `<div class="wg-cell${d === TODAY ? " today" : ""}${add ? " can-add" : ""}" ${!add ? "" : `data-a="slot-new" data-wd="${di + 1}" data-p="${p}" title="Добавить занятие"`}>
        ${here.map(lesson).join("")}${add ? `<span class="wg-add">${icon("plus")}</span>` : ""}</div>`; }).join("")}`).join("")}
  </div></section>`;
  const title = !sched.own ? "Расписание" : sched.by === "teacher" ? "Моё расписание" : `Расписание ${who}`;
  return pageView("schedule", title, [bar, picker + `<div class="enter" data-k="${esc(`${sched.by}|${who}|${mon}`)}">${grid}</div>`]);
};

