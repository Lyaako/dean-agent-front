/* ═════════ РОЛИ ═════════
   Пять ролей из app_role. От роли зависят: кто вошёл (ME), набор вкладок, что видно и что можно править, что умеет агент в чате.
   Куратор и староста — не роли, а надстройки (study_group.curator_id / headman_id). Загружается после chat.js. */

const ROLES = {
  dean_staff: { name: "Сотрудник деканата", login: "kuznetsova.ep", tabs: ["students", "groups", "schedule", "sheets", "works", "requests", "practice", "employees", "olap", "audit", "approvals"] },
  director: { name: "Директор института", login: "smirnov.av", tabs: ["olap", "students", "groups", "schedule", "sheets", "works", "requests", "practice", "employees", "audit", "approvals"] },
  teacher: { name: "Преподаватель", login: "", tabs: ["schedule", "sheets", "attendance", "mystudents", "myworks", "olap", "approvals"] },
  student: { name: "Студент", login: "", tabs: ["schedule", "grades", "myattendance", "myrequests", "mystudy", "approvals"] },
  // Администратор — все вкладки, в рабочих данных права как у деканата
  admin: { name: "Администратор", login: "admin", tabs: ["students", "groups", "schedule", "sheets", "works", "requests", "practice", "employees", "olap", "users", "refs", "audit", "approvals"] },
};
const ROLE_ORDER = ["dean_staff", "director", "teacher", "student", "admin"];   // порядок в списках и плитках
const BASE_TABS = Object.fromEntries(TABS.map((t) => [t.id, t]));
const NEW_TABS = {
  sheets: { id: "sheets", title: "Ведомости", icon: "edit" },
  attendance: { id: "attendance", title: "Посещаемость", short: "Посещения", icon: "done" },
  mystudents: { id: "mystudents", title: "Мои студенты", short: "Студенты", icon: "users" },
  myworks: { id: "myworks", title: "Курсовые и ВКР", short: "КР и ВКР", icon: "cap" },
  grades: { id: "grades", title: "Успеваемость", short: "Оценки", icon: "award" },
  myattendance: { id: "myattendance", title: "Посещаемость", short: "Посещения", icon: "done" },
  myrequests: { id: "myrequests", title: "Справки", icon: "file" },
  mystudy: { id: "mystudy", title: "Моя учёба", short: "Учёба", icon: "briefcase" },
  users: { id: "users", title: "Пользователи", short: "Доступ", icon: "users" },
  refs: { id: "refs", title: "Справочники", short: "Списки", icon: "list" },
  audit: { id: "audit", title: "Журнал изменений", short: "Журнал", icon: "clock" },
  approvals: { id: "approvals", title: "Согласование", short: "Согласов.", icon: "check" },
};
const isStaff = () => ["dean_staff", "director", "admin"].includes(ROLE);
let ROLE = "dean_staff";

/* ── Кто входит под каждой ролью ── */
// Преподаватель — тот, у кого больше всего лекций (он ведёт ведомости), занятий и работ: на нём лучше видны все экраны
const teacherScore = (t) => 3 * slots.filter((s) => s.teacher === t.full_name && s.lesson_type === "Лекция").length + slots.filter((s) => s.teacher === t.full_name).length
  + 2 * works.filter((w) => w.supervisor === t.full_name || w.reviewer === t.full_name).length;
const DEMO_TEACHER = [...teachers].sort((a, b) => teacherScore(b) - teacherScore(a))[0];
// Студент — обучающийся с курсовой или ВКР, практикой и хотя бы одним долгом
const DEMO_STUDENT = students.find((s) => s.status === ACTIVE && s.debts && works.some((w) => w.student_id === s.student_id) && practices.some((p) => p.student_id === s.student_id))
  ?? students.find((s) => s.status === ACTIVE && s.debts) ?? students.find((s) => s.status === ACTIVE);
Object.assign(DEMO_STUDENT, { full_name: DEMO_STUDENT.student, email: `st${DEMO_STUDENT.record_book_number.replace("-", "")}@stud.univ.ru`, phone: "+7 900 222-03-17" });
const ADMIN_ME = { full_name: "Администратор системы", email: "admin@univ.ru", phone: "+7 900 111-00-01" };
// Кто стоит за учётной записью: сотрудник — по логину из почты, студент — по номеру зачётки, администратор — служебная запись
const studentLogin = (st) => `st${st.record_book_number.replace("-", "")}`;
function personOf(u) {
  if (u.role === "admin") return ADMIN_ME;
  if (u.role === "student") {
    const st = students.find((x) => studentLogin(x) === u.login);
    return Object.assign(st, { full_name: st.student, email: st.email ?? `${u.login}@stud.univ.ru`, phone: st.phone ?? `+7 900 222-${String(st.student_id).padStart(2, "0")}-${String(10 + st.student_id).slice(-2)}` });
  }
  return employees.find((e) => e.email.split("@")[0] === u.login);
}

/* ── Чаты у каждого пользователя свои: при входе подставляется его история, черновики и вложения ── */
const CHAT_STORE = new Map();                  // логин → { chats, activeId, texts, att }
const SEED_CHATS = chat.chats.slice();          // демо-история из макета — только у сотрудника деканата
let chatOwner = null;
function switchChats(login) {
  if (login === chatOwner) return;
  chat.timers.forEach(clearTimeout);
  if (chatOwner) CHAT_STORE.set(chatOwner, { chats: chat.chats, activeId: chat.activeId, texts: chat.texts, att: chat.att });
  const mine = CHAT_STORE.get(login) ?? { chats: login === deanStaff[0].email.split("@")[0] ? SEED_CHATS : [], activeId: null, texts: {}, att: {} };
  Object.assign(chat, mine, { open: false, busyId: null, status: null, timers: [], notice: null, queued: false, editing: null, inputH: 40, shownCount: -1 });
  chatOwner = login;
}

function applyRole(role, person, login) {
  switchChats(login);
  ROLE = ROLES[role] ? role : "dean_staff";
  ME = person;
  ROLE_NAME = ROLES[ROLE].name;
  TABS.splice(0, TABS.length, ...ROLES[ROLE].tabs.map((id) => BASE_TABS[id] ?? NEW_TABS[id]));
  // Преподаватель и студент видят только своё расписание — без выбора группы и аудитории
  if (ROLE === "teacher") Object.assign(sched, { by: "teacher", who: ME.full_name, view: "week", own: true });
  else if (ROLE === "student") Object.assign(sched, { by: "group", who: ME.group_name, view: "week", own: true });
  else Object.assign(sched, { own: false, who: sched.own ? "" : sched.who });
  if (!TABS.some((t) => t.id === currentTab())) location.hash = `#/${TABS[0].id}`;
}

/* ── Вход по логину: роль и человек определяются учётной записью (app_user), как в настоящей системе.
   В макете у всех пользователей один пароль ── */
const MOCK_PASSWORD = "demo";
doLogin = async (form) => {
  const login = form.login.value.trim().toLowerCase(), password = form.password.value;
  if (!login || !password) { auth.error = "Введите логин и пароль"; return render(); }
  auth.busy = true; auth.error = null; auth.login = login; render();
  await wait(500);
  const u = users.find((x) => x.login === login);
  auth.busy = false;
  // После сброса действует только временный пароль, после смены — пароль, заданный пользователем
  if (!u || password !== (u.mustChange ? u.tempPassword : u.password ?? MOCK_PASSWORD)) { auth.error = "Неверный логин или пароль"; return render(); }
  if (!u.active) { auth.error = "Доступ отключён. Обратитесь в деканат или к администратору"; return render(); }
  if (u.mustChange) {
    render();
    return mustChangeDialog(u, password, (next) => { Object.assign(u, { mustChange: false, tempPassword: null, password: next }); finishLogin(u); });
  }
  finishLogin(u);
};
function finishLogin(u) {
  u.last = TODAY;
  auth.on = true;
  applyRole(u.role, personOf(u), u.login);
  try { sessionStorage.setItem("deanery.mock.session", JSON.stringify({ login: u.login })); } catch { /* нет доступа */ }
  render();
}

/* ═════════ ЖУРНАЛ ИЗМЕНЕНИЙ (audit_log) ═════════ */
const AUDIT = [];
const ACTION_NAME = { INSERT: "Добавление", UPDATE: "Изменение", DELETE: "Удаление" };
function logAudit(table, action, record, changes, source = "Интерфейс") {
  AUDIT.unshift({ id: AUDIT.length + 1, at: `${TODAY} ${new Date().toTimeString().slice(0, 5)}`, user: ME.full_name, role: ROLE_NAME, table, action, record, changes, source });
}
// Записи за прошлые дни — от сотрудников деканата, преподавателей и агента
[["Ведомость", "UPDATE", "Модуль 1 · Машинное обучение · ИДБ-23-11", "Баллы: 8 студентов", 1, "Интерфейс", DEMO_TEACHER.full_name, "Преподаватель"],
  ["Заявка на справку", "UPDATE", "Заявка № 233", "Статус: Новая → В работе", 1, "Чат-агент", deanStaff[0].full_name, "Сотрудник деканата"],
  ["Студент", "UPDATE", students[3].student, "Нуждается в общежитии: нет → да", 2, "Интерфейс", deanStaff[1].full_name, "Сотрудник деканата"],
  ["Приказ", "INSERT", "Приказ 171-с/26", "Академический отпуск", 3, "Интерфейс", deanStaff[0].full_name, "Сотрудник деканата"],
  ["Курсовая работа / ВКР", "UPDATE", works[2]?.student ?? "", "Тема изменена", 3, "Чат-агент", deanStaff[0].full_name, "Сотрудник деканата"],
  ["Пользователь", "UPDATE", "novikov.ip", "Пароль сброшен", 4, "Интерфейс", "Администратор системы", "Администратор"],
  ["Занятие", "UPDATE", "ИДБ-24-11 · Пн, 2 пара", "Аудитория: Б-302 → Б-304", 5, "Интерфейс", deanStaff[2].full_name, "Сотрудник деканата"],
  ["Ведомость", "UPDATE", "Пересдача · Базы данных · ИДБ-24-12", "Ведомость закрыта", 6, "Интерфейс", deanStaff[0].full_name, "Сотрудник деканата"],
].forEach(([table, action, record, changes, ago, source, user, role], i) =>
  AUDIT.push({ id: i + 1, at: `${addDays(TODAY, -ago)} ${String(9 + i).padStart(2, "0")}:${String(10 + i * 7).padStart(2, "0")}`, user, role, table, action, record, changes, source }));
// Изменения, применённые из чата, тоже попадают в журнал
window.onProposalApplied = (p) => logAudit(p.table, p.operation, p.explanation, p.rows.map((r) => `${r.label}: ${r.before ?? "—"} → ${r.after}`).join("; "), "Чат-агент");

/* ═════════ ВЕДОМОСТИ (grade_sheet + grade) ═════════ */
const STAGE_NAME = { module_1: "Модуль 1", module_2: "Модуль 2", final: "Итог" };
const examinerOf = (group, discipline, sem) => slots.find((s) => s.group_name === group && s.discipline === discipline && s.lesson_type === "Лекция")?.teacher
  ?? slots.find((s) => s.group_name === group && s.discipline === discipline)?.teacher
  ?? teachers[Math.floor(h01(`ex|${group}|${discipline}|${sem}`) * teachers.length)].full_name;
const sheets = [];
// issue_date — дата выдачи: дата экзамена не раньше неё и не позже чем через 366 дней
const addSheet = (o) => sheets.push({ sheet_id: sheets.length + 1, sheet_number: `В-${String(1000 + sheets.length)}`, ...o });
GROUPS.forEach((g) => {
  const roster = students.filter((s) => s.group_name === g.name && s.status !== "Отчислен");
  // Последняя сессия: основная ведомость закрыта; несдавшие — в ведомости пересдачи
  const sem = doneSemesters(g.year);
  if (sem) CURRICULUM.filter(([, s]) => s === sem).forEach(([discipline, , control_type]) => {
    const rs = results.filter((r) => r.group_name === g.name && r.discipline === discipline && r.semester === sem);
    if (!rs.length) return;
    const examiner = examinerOf(g.name, discipline, sem);
    addSheet({ group_name: g.name, discipline, semester: sem, control_type, stage: "final", kind: "Основная", examiner, issue_date: "2026-06-01", exam_date: "2026-06-" + String(15 + Math.floor(h01(discipline) * 12)).padStart(2, "0"), status: "Закрыта",
      rows: rs.map((r) => ({ student_id: r.student_id, student: r.student, points: failedFirst(r) ? null : r.points, absent: failedFirst(r) && h01(`abs|${r.student_id}|${discipline}`) < 0.3 })) });
    const failed = rs.filter(failedFirst);
    if (failed.length) addSheet({ group_name: g.name, discipline, semester: sem, control_type, stage: "final", kind: "Пересдача", examiner, issue_date: "2026-09-01", exam_date: failed.every((r) => r.points != null) ? "2026-09-18" : null,
      status: failed.every((r) => r.points != null) ? "Закрыта" : "Открыта", rows: failed.map((r) => ({ student_id: r.student_id, student: r.student, points: r.points, absent: false })) });
  });
  // Текущий семестр: модуль 1 сдан и закрыт, модуль 2 — открыт, баллы выставляет преподаватель
  if (!roster.some((s) => s.status === ACTIVE)) return;
  const cur = course(g.year) * 2 - 1;
  curDisc(g).forEach((discipline) => {
    const control_type = CURRICULUM.find(([d, s]) => d === discipline && s === cur)?.[2] ?? "Экзамен";
    const examiner = examinerOf(g.name, discipline, cur);
    const active = roster.filter((s) => s.status === ACTIVE);
    addSheet({ group_name: g.name, discipline, semester: cur, control_type, stage: "module_1", kind: "Основная", examiner, issue_date: "2026-09-01", exam_date: "2026-10-0" + (1 + Math.floor(h01(discipline + g.name) * 8)), status: "Закрыта",
      rows: active.map((s) => ({ student_id: s.student_id, student: s.student, points: modules.find((m) => m.student_id === s.student_id && m.discipline === discipline)?.points ?? null, absent: false })) });
    addSheet({ group_name: g.name, discipline, semester: cur, control_type, stage: "module_2", kind: "Основная", examiner, issue_date: "2026-09-01", exam_date: null, status: "Открыта",
      rows: active.map((s) => ({ student_id: s.student_id, student: s.student, points: null, absent: false })) });
  });
});
const canEditSheet = (sh) => sh.status === "Открыта" && (ROLE === "teacher" ? sh.examiner === ME.full_name : ["dean_staff", "director", "admin"].includes(ROLE));
const resultText = (sh, p, absent, na = false) => {
  if (absent) return ["Неявка", "bad"];
  // Пустые баллы без неявки — «не аттестован», если он выставлен или ведомость закрыта (fn_result_name: в итоговой — «Неудовлетворительно» / «Не зачтено»)
  if (p == null || p === "") return sh.status !== "Закрыта" && !na ? ["—", ""] : sh.stage !== "final" ? ["Не аттестован", "bad"] : [isGraded(sh.control_type) ? "Неудовлетворительно" : "Не зачтено", "bad"];
  if (sh.stage !== "final") return +p >= 25 ? ["Аттестован", "ok"] : ["Не аттестован", "bad"];
  if (!isGraded(sh.control_type)) return +p >= 25 ? ["Зачтено", "ok"] : ["Не зачтено", "bad"];
  return [["Неудовлетворительно", "Неудовлетворительно", "Неудовлетворительно", "Удовлетворительно", "Хорошо", "Отлично"][mark(+p) ?? 0], mark(+p) === 5 ? "ok" : mark(+p) ? "info" : "bad"];
};
const filled = (sh) => sh.rows.filter((r) => r.points != null || r.absent || r.na).length;
const SHEET_COLS = [
  { label: "Номер", field: "sheet_number", filter: "text" },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Дисциплина", field: "discipline", filter: "text", bold: true },
  { label: "Сем.", field: "semester", filter: "enum", className: "num" },
  { label: "Этап", field: (r) => STAGE_NAME[r.stage], filter: "enum" },
  { label: "Вид", field: "kind", filter: "enum" },
  { label: "Экзаменатор", field: "examiner", filter: "enum" },
  { label: "Заполнено", field: (r) => `${filled(r)} из ${r.rows.length}`, filter: null, className: "num" },
  { label: "Статус", field: "status", filter: "enum", badge: true, render: (r) => badge(r.status, r.status === "Открыта" ? "warn" : "muted") },
];
PAGES.sheets = () => {
  const mine = ROLE === "teacher";
  const all = sheets.filter((s) => !mine || s.examiner === ME.full_name)
    .sort((a, b) => (a.status === b.status ? b.semester - a.semester || a.group_name.localeCompare(b.group_name) : a.status === "Открыта" ? -1 : 1));
  const cols = mine ? SHEET_COLS.filter((c) => c.label !== "Экзаменатор") : SHEET_COLS;
  const rows = applyTable("sheets", cols, all);
  const open = all.filter((s) => s.status === "Открыта");
  return pageView("sheets", mine ? "Мои ведомости" : "Ведомости", [
    tiles([["Открытых ведомостей", open.length, mine ? "ждут ваших баллов" : "ещё не закрыты", open.length ? "" : "ok"],
      ["Заполнено в открытых", `${open.reduce((t, s) => t + filled(s), 0)} из ${open.reduce((t, s) => t + s.rows.length, 0)}`, "студентов с баллами"],
      ["Пересдачи", all.filter((s) => s.kind === "Пересдача" && s.status === "Открыта").length, "открытых ведомостей пересдачи"]]),
    tableTools("sheets", cols, all, rows.length),
    dataTable("sheets", cols, rows, all, { rowKey: (r) => r.sheet_id, onRow: openSheet })]);
};
// Вид результата в строке ведомости: баллы 25–54, «не аттестован» (баллов нет, не неявка) или неявка.
// В открытой ведомости строка без баллов и без отметки — результат ещё не выставлен (в базе строки grade нет)
const RES_MODES = [["points", "Баллы"], ["na", "Не аттестован"], ["absent", "Неявка"]];
const modeOf = (sh, r) => (r.absent ? "absent" : r.points != null ? "points" : r.na || sh.status === "Закрыта" ? "na" : "points");
const hasResult = (sh, r) => r.points != null || r.absent || !!r.na || sh.status === "Закрыта";
const setMode = (r, mode) => Object.assign(r, { absent: mode === "absent", na: mode === "na", points: mode === "points" ? r.points : null });
const ptsError = (p) => (p != null && (!Number.isInteger(p) || p < 25 || p > 54) ? "Баллы — от 25 до 54" : undefined);
const resLabel = (sh, r) => { const [t] = resultText(sh, r.points, r.absent, r.na || sh.status === "Закрыта"); return r.points != null ? `${r.points} · ${t}` : t; };
const sheetStaff = () => ["dean_staff", "director", "admin"].includes(ROLE);
const sameStage = (a, b) => a.group_name === b.group_name && a.discipline === b.discipline && a.semester === b.semester && a.stage === b.stage;
// Исправлять можно только последнюю попытку: если студент есть в более поздней ведомости этого этапа — исправляют там
const laterSheet = (sh, id) => sheets.find((x) => x.sheet_id > sh.sheet_id && sameStage(x, sh) && x.status !== "Отменена" && x.rows.some((r) => r.student_id === id));
// В пересдачу — обучающиеся без аттестации по этому этапу, ещё не внесённые в открытую ведомость
const retakeCandidates = (sh) => sh.rows.filter((r) => r.points == null && isActive(r.student_id)
  && !sheets.some((x) => x !== sh && sameStage(x, sh) && x.rows.some((y) => y.student_id === r.student_id && (y.points != null || x.status === "Открыта"))));
// Поле баллов — в строке ведомости и в заявке на исправление. err: текст или ошибка с кодом; true — только подсветка
const ptsInput = (r, attrs, err, busy) => `${err ? `<div class="form-field invalid">` : ""}<input class="text-input pts" type="number" min="25" max="54" step="1" inputmode="numeric" ${attrs}
  value="${r.points ?? ""}" ${r.absent || r.na || busy ? "disabled" : ""}>${err ? `${err === true ? "" : `<small class="field-error" role="alert">${errHtml(err)}</small>`}</div>` : ""}`;

function openSheet(sh) {
  const edit = canEditSheet(sh), closed = sh.status === "Закрыта";
  const canFix = closed && (sh.examiner === ME.full_name || sheetStaff()), retake = closed && sh.kind === "Основная" && sheetStaff() ? retakeCandidates(sh) : [];
  // errs — ошибки у полей баллов по строкам; fe — ошибка базы с кодом (FORM_SIM), показывается у первой строки
  const m = { label: `Ведомость ${sh.sheet_number}`, draft: sh.rows.map((r) => ({ ...r, na: !!r.na })), errs: {}, fe: null, busy: false };
  const dirty = () => m.draft.some((r, i) => r.points !== sh.rows[i].points || r.absent !== sh.rows[i].absent || r.na !== !!sh.rows[i].na);
  const validate = () => { m.errs = {}; m.draft.forEach((r, i) => { const e = ptsError(r.points); if (e) m.errs[i] = e; }); return !Object.keys(m.errs).length; };
  // Пока баллы вне шкалы, оценки нет
  const row = (r, i) => { const [t, k] = ptsError(r.points) ? ["—", ""] : resultText(sh, r.points, r.absent, r.na);
    if (edit) return `<tr data-k="${r.student_id}"><td>${esc(r.student)}</td>
      <td>${seg("res-mode", RES_MODES, modeOf(sh, r), `data-i="${i}" ${m.busy ? "disabled" : ""}`)}</td>
      <td>${ptsInput(r, `data-pts="${i}" aria-label="Баллы: ${esc(r.student)}"`, m.errs[i] ?? (m.fe?.rows.includes(i) ? (m.fe.rows[0] === i ? m.fe.e : true) : null), m.busy)}</td>
      <td>${k ? badge(t, k) : t}</td></tr>`;
    const later = canFix && laterSheet(sh, r.student_id);
    return `<tr data-k="${r.student_id}"><td>${esc(r.student)}</td><td>${r.points ?? "—"}</td><td>${r.absent ? "да" : "—"}</td><td>${k ? badge(t, k) : t}</td>
      ${canFix ? `<td><button type="button" class="btn sm ghost" data-a="fix" data-i="${i}" ${later ? `disabled title="Исправлять нужно последнюю попытку — ведомость ${later.sheet_number}"` : `title="Запросить исправление"`} aria-label="Запросить исправление: ${esc(r.student)}">${icon("edit")}</button></td>` : ""}</tr>`; };
  m.html = () => `<div class="dialog form-dialog sheet-dialog${edit ? " sheet-edit" : ""}">
    <div class="form-head"><div><h3>${esc(sh.discipline)}</h3><p>${sh.group_name} · ${sh.semester} семестр · ${STAGE_NAME[sh.stage]} · ${sh.kind.toLowerCase()} ведомость ${sh.sheet_number}</p></div>
      <button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body">
      <div class="sheet-meta">${badge(sh.status, sh.status === "Открыта" ? "warn" : "muted")}<span>${icon("users")}${esc(sh.examiner)}</span><span>${icon("calendar")}${sh.exam_date ? fmtDate(sh.exam_date) : "дата не назначена"}</span><span>${esc(sh.control_type)}</span></div>
      ${!edit && sh.status === "Открыта" && ROLE === "teacher" ? `<div class="form-note">Ведомость ведёт ${esc(sh.examiner)} — вы можете только посмотреть.</div>` : ""}
      <div class="sheet-wrap"><table class="sheet-table"><thead><tr><th>Студент</th>${edit ? "<th>Результат</th><th>Баллы</th><th>Оценка</th>" : `<th>Баллы</th><th>Неявка</th><th>Результат</th>${canFix ? "<th></th>" : ""}`}</tr></thead>
      <tbody>${m.draft.map(row).join("")}</tbody></table></div>
      <p class="hint">25–34 — удовлетворительно, 35–44 — хорошо, 45–54 — отлично; ниже 25 баллов ставится «не аттестован».</p>
    </div>
    <div class="actions">${retake.length ? `<button type="button" class="btn sm ghost" data-a="retake">${icon("plus")}Создать ведомость пересдачи</button>` : ""}
      <span class="spacer"></span><button type="button" class="btn" data-a="close">${edit ? "Отменить" : "Закрыть"}</button>
      ${edit && sheetStaff() ? `<button type="button" class="btn" data-a="close-sheet" ${m.busy ? "disabled" : ""}>Закрыть ведомость</button>` : ""}
      ${edit ? `<button type="button" class="btn primary" data-a="save" ${m.busy || !dirty() ? "disabled" : ""}>${m.busy ? "Сохраняем…" : "Сохранить"}</button>` : ""}</div></div>`;
  const store = () => { sh.rows = m.draft.map((r) => ({ ...r })); };
  const save = async () => {
    // Ошибка базы (FORM_SIM): баллы вне шкалы — у первых выставленных баллов
    try { formSim({ "RW-12": "points" }); } catch (e) { m.fe = { e, rows: [Math.max(0, m.draft.findIndex((r) => r.points != null))] }; return render(); }
    m.fe = null;
    if (!validate()) return render();
    m.busy = true; render();
    await wait(450);
    const n = m.draft.filter((r, i) => r.points !== sh.rows[i].points || r.absent !== sh.rows[i].absent || r.na !== !!sh.rows[i].na).length;
    store();
    logAudit("Ведомость", "UPDATE", `${STAGE_NAME[sh.stage]} · ${sh.discipline} · ${sh.group_name}`, `Баллы: ${n} ${plural(n, "студент", "студента", "студентов")}`);
    closeModal(m); toast("Баллы сохранены");
  };
  m.close = () => closeModal(m);
  m.click = (el) => {
    const a = el.dataset.a;
    if (a === "close") m.close();
    else if (a === "save") save();
    else if (a === "res-mode") { const i = +el.dataset.i; setMode(m.draft[i], el.dataset.v); delete m.errs[i]; m.fe = null; render(); }
    else if (a === "close-sheet") { m.fe = null; if (!validate()) return render(); closeSheetDialog(sh, m.draft, () => { store(); closeModal(m); }); }
    else if (a === "fix") correctionDialog(sh, sh.rows[+el.dataset.i]);
    else if (a === "retake") createRetake(sh, retake, m);
  };
  m.input = (el) => {
    if (el.dataset.pts == null) return;
    const i = +el.dataset.pts, v = el.value.trim();
    m.draft[i].points = v === "" ? null : Number(v);
    delete m.errs[i]; m.fe = null; render();
  };
  // Ошибка у поля — когда ввод закончен, а не на каждой цифре
  m.change = (el) => { if (el.dataset.pts == null) return; const i = +el.dataset.pts, e = ptsError(m.draft[i].points); if (e) { m.errs[i] = e; render(); } };
  return openModal(m);
}

/* ── Закрытие ведомости: дата экзамена и список студентов без результата. Закрывают деканат, директор, админ ── */
function closeSheetDialog(sh, draft, done) {
  // Дата экзамена — не раньше выдачи и не позже чем через 366 дней; ведомость закрывается сегодня, поэтому экзамен — не позже сегодня
  const min = sh.issue_date, max = [addDays(sh.issue_date, 366), TODAY].sort()[0];
  const missing = draft.filter((r) => !hasResult(sh, r));
  const c = { label: "Закрыть ведомость", date: sh.exam_date && sh.exam_date >= min && sh.exam_date <= max ? sh.exam_date : max, err: null, listErr: null, busy: false };
  c.html = () => `<div class="dialog form-dialog">
    <div class="form-head"><div><h3>Закрыть ведомость</h3><p>${sh.sheet_number} · ${esc(sh.discipline)} · ${sh.group_name}</p></div>
      <button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body">
      <div class="field form-field${c.err ? " invalid" : ""}"><label for="cs-date">Дата экзамена</label>
        <input id="cs-date" class="text-input" type="date" min="${min}" max="${max}" value="${c.date}" data-cs-date ${c.busy ? "disabled" : ""}>
        ${c.err ? `<small class="field-error" role="alert">${errHtml(c.err)}</small>` : `<small class="hint">С ${fmtDate(min)} по ${fmtDate(max)}: не раньше выдачи ведомости и не позже сегодняшнего дня</small>`}</div>
      ${missing.length ? `<div class="form-note">Нет результата у ${missing.length} ${plural(missing.length, "студента", "студентов", "студентов")} — выставьте баллы, «не аттестован» или неявку:
        <ul class="effects">${missing.map((r) => `<li>${esc(r.student)}</li>`).join("")}</ul></div>`
        : `<div class="form-note">Результат есть у всех студентов. После закрытия результаты не меняются — только через заявку на исправление.</div>`}
      ${c.listErr ? `<small class="field-error" role="alert">${errHtml(c.listErr)}</small>` : ""}
    </div>
    <div class="actions"><span class="spacer"></span><button type="button" class="btn" data-a="close">Отменить</button>
      <button type="button" class="btn primary" data-a="cs-close" ${missing.length || !c.date || c.busy ? "disabled" : ""}>${c.busy ? "Закрываем…" : "Закрыть"}</button></div></div>`;
  c.close = () => closeModal(c);
  c.input = (el) => { if (el.dataset.csDate != null) { c.date = el.value; c.err = null; c.listErr = null; render(); } };
  c.change = c.input;
  c.click = async (el) => {
    const a = el.dataset.a;
    if (a === "close") return c.close();
    if (a !== "cs-close") return;
    c.err = null; c.listErr = null;
    // Ошибки базы (FORM_SIM): даты — под датой, нет результата — под списком
    try { formSim({ "RW-11": "exam_date", "RW-13": "rows" }); } catch (e) { if (e.code === "RW-11") c.err = e; else c.listErr = e; return render(); }
    if (c.date < min || c.date > max) { c.err = `Дата экзамена — с ${fmtDate(min)} по ${fmtDate(max)}`; return render(); }
    c.busy = true; render();
    await wait(450);
    done();
    sh.rows.forEach((r) => { r.na = r.points == null && !r.absent; });
    Object.assign(sh, { status: "Закрыта", exam_date: c.date, closed_date: TODAY });
    logAudit("Ведомость", "UPDATE", `${STAGE_NAME[sh.stage]} · ${sh.discipline} · ${sh.group_name}`, "Ведомость закрыта");
    closeModal(c); toast("Ведомость закрыта");
  };
  return openModal(c);
}

/* ── Заявка на исправление оценки в закрытой ведомости: решает директор (или заместитель) в «Согласовании» ── */
function correctionDialog(sh, r) {
  const f = { label: "Запросить исправление", v: { points: null, absent: false, na: false }, reason: "", errs: {}, busy: false };
  setMode(f.v, modeOf(sh, r) === "points" ? "na" : "points");
  const cur = resLabel(sh, r);
  f.html = () => `<div class="dialog form-dialog">
    <div class="form-head"><div><h3>Запросить исправление</h3><p>${esc(r.student)} · ${esc(sh.discipline)} · ведомость ${sh.sheet_number}</p></div>
      <button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body">
      <div class="field"><span>Текущий результат</span><b class="cur-res">${esc(cur)}</b></div>
      <div class="field form-field${f.errs.res ? " invalid" : ""}"><span>Новый результат</span>
        <div class="fix-res">${seg("fix-mode", RES_MODES, modeOf(sh, f.v), f.busy ? "disabled" : "")}${ptsInput(f.v, `data-fix-pts aria-label="Новые баллы"`, f.errs.pts, f.busy)}</div>
        ${f.errs.res ? `<small class="field-error" role="alert">${esc(f.errs.res)}</small>` : ""}</div>
      <div class="field form-field${f.errs.reason ? " invalid" : ""}"><label for="fix-reason">Основание</label>
        <textarea id="fix-reason" class="text-input textarea" rows="3" maxlength="2000" data-fix-reason ${f.busy ? "disabled" : ""} placeholder="Например: ошибка при переносе баллов из протокола экзамена">${esc(f.reason)}</textarea>
        ${f.errs.reason ? `<small class="field-error" role="alert">${esc(f.errs.reason)}</small>` : `<small class="hint">От ${REASON_MIN} до 2000 символов. Заявку рассмотрит директор или заместитель директора</small>`}</div>
    </div>
    <div class="actions"><span class="spacer"></span><button type="button" class="btn" data-a="close">Отменить</button>
      <button type="button" class="btn primary" data-a="fix-send" ${f.busy ? "disabled" : ""}>${f.busy ? "Отправляем…" : "Отправить директору"}</button></div></div>`;
  f.close = () => closeModal(f);
  f.input = (el) => {
    if (el.dataset.fixPts != null) { const v = el.value.trim(); f.v.points = v === "" ? null : Number(v); delete f.errs.pts; delete f.errs.res; render(); }
    else if (el.dataset.fixReason != null) { f.reason = el.value; delete f.errs.reason; render(); }
  };
  f.click = async (el) => {
    const a = el.dataset.a;
    if (a === "close") return f.close();
    if (a === "fix-mode") { setMode(f.v, el.dataset.v); f.errs = {}; return render(); }
    if (a !== "fix-send") return;
    const reason = clip(f.reason), mode = modeOf(sh, f.v);
    f.errs = {};
    if (mode === "points" && f.v.points == null) f.errs.pts = "Введите баллы";
    else if (ptsError(f.v.points)) f.errs.pts = ptsError(f.v.points);
    else if (mode === modeOf(sh, r) && f.v.points === r.points) f.errs.res = "Новый результат совпадает с текущим";
    if (reason.length < REASON_MIN) f.errs.reason = `Не короче ${REASON_MIN} символов`;
    if (Object.keys(f.errs).length) return render();
    f.busy = true; render();
    await wait(450);
    const next = { points: f.v.points, absent: f.v.absent }, after = resLabel(sh, { ...next, na: mode === "na" });
    const before = { points: r.points, absent: r.absent };
    const pid = uid();
    PROPOSALS[pid] = { pid, status: "pending", kind: "Исправление оценки", decision_status: "Ждёт решения директора", execution_status: null, decision_reason: null,
      explanation: `Исправление оценки: ${r.student} · ${sh.discipline}`, table: `Ведомость ${sh.sheet_number} · ${sh.group_name}`, operation: "UPDATE",
      rows: [{ label: "Результат", before: cur, after }], reason, author: ME.full_name, author_role: ROLE, created_at: nowStamp(), assignee: null,
      history: [{ at: nowStamp(), who: ME.full_name, text: `Подал заявку: «${reason}»` }],
      sheet_id: sh.sheet_id, student_id: r.student_id,
      // Как в базе: при одобрении оценка должна быть той же, что при подаче заявки
      apply() {
        if (r.points !== before.points || r.absent !== before.absent) throw new Error("Оценка изменилась после подачи заявки — подайте заявку заново");
        Object.assign(r, next, { na: next.points == null && !next.absent });
      } };
    logAudit("Заявка на исправление оценки", "INSERT", `${sh.sheet_number} · ${r.student}`, `${cur} → ${after}`);
    closeModal(f); toast("Заявка отправлена директору");
  };
  return openModal(f);
}

/* ── Ведомость пересдачи: открытая, только со студентами без аттестации по этому этапу ── */
function createRetake(sh, rows, m) {
  addSheet({ group_name: sh.group_name, discipline: sh.discipline, semester: sh.semester, control_type: sh.control_type, stage: sh.stage, kind: "Пересдача",
    examiner: sh.examiner, issue_date: TODAY, exam_date: null, status: "Открыта",
    rows: rows.map((r) => ({ student_id: r.student_id, student: r.student, points: null, absent: false, na: false })) });
  const ns = sheets[sheets.length - 1];
  logAudit("Ведомость", "INSERT", `${STAGE_NAME[sh.stage]} · ${sh.discipline} · ${sh.group_name}`, `Пересдача ${ns.sheet_number}: ${rows.length} ${plural(rows.length, "студент", "студента", "студентов")}`);
  closeModal(m); toast(`Создана ведомость пересдачи ${ns.sheet_number}`);
  openSheet(ns);
}

/* ═════════ ПОСЕЩАЕМОСТЬ (attendance) ═════════ */
const lessonKey = (l) => `${l.lesson_date}|${l.slot_id}`;
const rosterOf = (group) => students.filter((s) => s.group_name === group && s.status === ACTIVE);
// Отметки прошлых занятий выводятся из процента посещаемости студента; занятия последних трёх дней преподаватель ещё не отметил
const ATTEND = new Map();
const attOf = (l) => {
  const k = lessonKey(l);
  if (!ATTEND.has(k)) ATTEND.set(k, l.lesson_date >= addDays(TODAY, -3) ? {} : Object.fromEntries(rosterOf(l.group_name).map((s) => [s.student_id, h01(`att|${k}|${s.student_id}`) * 100 < (s.attendance_pct ?? 90)])));
  return ATTEND.get(k);
};
// Неделя как в расписании: на каждом занятии — отметки; нажатие открывает список группы
const att = { date: TODAY };
const attStatus = (l) => {
  if (l.lesson_date > TODAY) return ["", ""];
  const marks = attOf(l), roster = rosterOf(l.group_name), done = roster.filter((s) => marks[s.student_id] != null).length;
  if (done < roster.length) return [`Не отмечено${done ? ` · ${done} из ${roster.length}` : ""}`, "warn"];
  const here = roster.filter((s) => marks[s.student_id]).length;
  return [`Были ${here} из ${roster.length}`, here === roster.length ? "ok" : "info"];
};
PAGES.attendance = () => {
  const mon = mondayOf(att.date), prev = addDays(mon, -7), next = addDays(mon, 7);
  const days = Array.from({ length: 6 }, (_, i) => addDays(mon, i));
  const week = schedule.filter((l) => l.teacher === ME.full_name && l.lesson_date >= mon && l.lesson_date <= days[5]);
  const pairs = Array.from({ length: Math.max(4, ...week.map((l) => l.pair_number)) }, (_, i) => i + 1);
  const todo = schedule.filter((l) => l.teacher === ME.full_name && l.lesson_date <= TODAY && attStatus(l)[1] === "warn").length;
  const bar = `<div class="week-bar"><div class="week-nav">
      <button class="icon-btn soft" data-a="att-week" data-v="${prev}" ${prev < mondayOf(TERM_FIRST) ? "disabled" : ""} aria-label="Предыдущая неделя">${icon("left")}</button>
      <div class="week-label"><b>${human(mon)} — ${human(addDays(mon, 5))}</b></div>
      <button class="icon-btn soft" data-a="att-week" data-v="${next}" ${next > TERM_LAST ? "disabled" : ""} aria-label="Следующая неделя">${icon("right")}</button>
    </div>${todo ? `<span class="att-todo">${badge(`Не отмечено занятий: ${todo}`, "warn")}</span>` : ""}</div>`;
  const lesson = (l) => { const [t, k] = attStatus(l), future = l.lesson_date > TODAY;
    return `<button type="button" class="lesson ${l.lesson_type === "Лекция" ? "lec" : "prac"}${future ? " future" : ""}" ${future ? "disabled" : `data-a="att-lesson" data-k="${esc(lessonKey(l))}"`}>
      <div class="l-top">${badge(l.lesson_type, LESSON_KIND[l.lesson_type])}<span class="l-room">${icon("pin")}${esc(l.classroom)}</span></div>
      <b>${esc(l.discipline)}</b><small>${esc(l.group_name)}</small>${t ? `<span class="l-att ${k}">${k === "warn" ? icon("alert") : icon("check")}${t}</span>` : ""}</button>`; };
  const grid = `<section class="card week-card"><div class="week-grid"><div class="wg-h"></div>
    ${days.map((d) => `<div class="wg-h${d === TODAY ? " today" : ""}"><b>${WD_SHORT[D(d).getUTCDay()]}, ${human(d)}</b>${HOLIDAYS.includes(d) ? "<small>праздник</small>" : ""}</div>`).join("")}
    ${pairs.map((p) => `<div class="wg-time"><b>${PAIRS[p][0]}</b><small>${p} пара · до ${PAIRS[p][1]}</small></div>${days.map((d) =>
      `<div class="wg-cell${d === TODAY ? " today" : ""}">${week.filter((l) => l.lesson_date === d && l.pair_number === p).map(lesson).join("")}</div>`).join("")}`).join("")}
  </div></section>`;
  return pageView("attendance", "Посещаемость", [bar, `<div class="enter" data-k="${mon}">${grid}</div>`]);
};
function openAttendance(l) {
  const marks = attOf(l), roster = rosterOf(l.group_name), before = JSON.stringify(marks);
  const m = { label: `Посещаемость: ${l.discipline}` };
  m.html = () => { const done = roster.filter((s) => marks[s.student_id] != null).length, here = roster.filter((s) => marks[s.student_id]).length;
    return `<div class="dialog form-dialog att-dialog">
    <div class="form-head"><div><h3>${esc(l.discipline)}</h3><p>${l.group_name} · ${l.lesson_type} · ${WD_SHORT[D(l.lesson_date).getUTCDay()]}, ${human(l.lesson_date)}, ${l.pair_number} пара · ${esc(l.classroom)}</p></div>
      <button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body">
      <div class="att-head"><span>${done < roster.length ? badge(`Отмечено ${done} из ${roster.length}`, "warn") : `Были <b>${here}</b> из ${roster.length}`}</span>
        <button type="button" class="btn sm ghost" data-a="att-all">${icon("check")}Все были</button></div>
      <div class="att-list">${roster.map((s) => { const v = marks[s.student_id];
        return `<div class="att-row"><span class="avatar t${tone(s.student)}">${initials(s.student)}</span><b>${esc(s.student)}</b>
          <div class="seg att-seg" role="group" style="--n:2;--i:${v === false ? 1 : 0}" data-unset="${v == null}">
            <button type="button" data-a="att-mark" data-s="${s.student_id}" data-v="1" aria-pressed="${v === true}">Был</button>
            <button type="button" data-a="att-mark" data-s="${s.student_id}" data-v="0" aria-pressed="${v === false}">Не был</button></div></div>`; }).join("")}</div>
    </div></div>`; };
  // Отметки сохраняются сразу; в журнал изменений — одной записью при закрытии окна
  m.close = () => {
    if (JSON.stringify(marks) !== before) logAudit("Посещаемость", "UPDATE", `${l.discipline} · ${l.group_name} · ${fmtDate(l.lesson_date)}`, `Были ${roster.filter((s) => marks[s.student_id]).length} из ${roster.length}`);
    closeModal(m);
  };
  m.click = (el) => {
    const a = el.dataset.a;
    if (a === "close") m.close();
    else if (a === "att-mark") { marks[el.dataset.s] = el.dataset.v === "1"; render(); }
    else if (a === "att-all") { roster.forEach((s) => { marks[s.student_id] = true; }); render(); }
  };
  return openModal(m);
}

/* ═════════ ПРЕПОДАВАТЕЛЬ: мои студенты, курсовые и ВКР ═════════ */
const myGroups = () => [...new Set(slots.filter((s) => s.teacher === ME.full_name).map((s) => s.group_name))].sort();
const MYSTUDENT_COLS = [
  { label: "ФИО", field: "student", filter: "text", bold: true },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Курс", field: "course", filter: "enum", className: "num" },
  { label: "Мои дисциплины", field: (r) => [...new Set(slots.filter((s) => s.teacher === ME.full_name && s.group_name === r.group_name).map((s) => s.discipline))].join(", "), filter: "text", className: "wrap-sm" },
  { label: "Посещ., %", field: "attendance_pct", filter: "num", className: "num", text: (r) => String(r.attendance_pct ?? "—").replace(".", ",") },
  { label: "Ср. балл", field: "avg_points", filter: "num", className: "num", text: (r) => String(r.avg_points ?? "—").replace(".", ",") },
  { label: "Долги", field: "debts", filter: "num", className: "num", text: (r) => (r.debts ? String(r.debts) : "—") },
];
PAGES.mystudents = () => {
  const gs = myGroups(), all = students.filter((s) => gs.includes(s.group_name) && s.status === ACTIVE);
  const rows = applyTable("mystudents", MYSTUDENT_COLS, all);
  const cur = GROUPS.find((g) => g.curator === ME.full_name);
  return pageView("mystudents", "Мои студенты", [
    // Коротко одной строкой: большие плитки с одной цифрой давали много пустого места
    `<p class="stat-line"><span>${gs.length === 1 ? "Группа" : "Группы"} <b>${gs.join(", ")}</b></span><span>Студентов <b>${all.length}</b></span>
      <span>С долгами <b class="${all.some((s) => s.debts) ? "neg" : ""}">${all.filter((s) => s.debts).length}</b></span>${cur ? `<span>Вы куратор <b>${cur.name}</b></span>` : ""}</p>`,
    tableTools("mystudents", MYSTUDENT_COLS, all, rows.length),
    dataTable("mystudents", MYSTUDENT_COLS, rows, all, { rowKey: (r) => r.student_id })]);
};
const MYWORK_COLS = [
  { label: "Студент", field: "student", filter: "text", bold: true },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Вид", field: "work_kind", filter: "enum" },
  { label: "Тема", field: "topic", filter: "text", className: "wrap" },
  { label: "Моя роль", field: (r) => (r.supervisor === ME.full_name ? "Руководитель" : "Рецензент"), filter: "enum", badge: true,
    render: (r) => badge(r.supervisor === ME.full_name ? "Руководитель" : "Рецензент", r.supervisor === ME.full_name ? "info" : "muted") },
  { label: "Приказ", field: "order_number", filter: "enum", text: (r) => r.order_number ?? "—" },
];
PAGES.myworks = () => {
  const all = works.filter((w) => w.supervisor === ME.full_name || w.reviewer === ME.full_name);
  const rows = applyTable("myworks", MYWORK_COLS, all);
  return pageView("myworks", "Курсовые и ВКР", all.length ? [tableTools("myworks", MYWORK_COLS, all, rows.length), dataTable("myworks", MYWORK_COLS, rows, all, { rowKey: (r) => r.work_id })]
    : [`<div class="card empty-day">${icon("cap")}<b>Нет работ</b>Вы не руководитель и не рецензент ни одной курсовой или ВКР</div>`]);
};

/* ═════════ СТУДЕНТ ═════════ */
const kvCard = (title, items, extra = "") => `<section class="card me-card"><div class="table-head"><h2>${title}</h2>${extra}</div>
  <div class="kv-grid me-kv">${items.map(([l, v]) => `<div><small>${l}</small><b>${v}</b></div>`).join("")}</div></section>`;
// Итог без баллов — как fn_result_name(…, final = TRUE) в v_performance и v_debtors: неявка, иначе «Неудовлетворительно» или «Не зачтено»
const missResult = (r) => (debtors.find((d) => d.student_id === r.student_id && d.discipline === r.discipline && d.semester === r.semester)?.last_result === "Неявка" ? "Неявка"
  : isGraded(r.control_type) ? "Неудовлетворительно" : "Не зачтено");
const markName = (r) => (r.points == null ? missResult(r) : !isGraded(r.control_type) ? "Зачтено" : ["", "", "", "Удовлетворительно", "Хорошо", "Отлично"][mark(r.points)]);
const myGrades = { sem: "cur" };
PAGES.grades = () => {
  const s = ME, done = doneSemesters(groupOf(s.group_name).year), cur = s.course * 2 - 1;
  const mySheets = sheets.filter((sh) => sh.group_name === s.group_name && sh.semester === cur);
  const curDiscs = [...new Set(mySheets.map((sh) => sh.discipline))];
  const ptsOf = (d, stage) => { const sh = mySheets.find((x) => x.discipline === d && x.stage === stage); return sh && { sh, r: sh.rows.find((r) => r.student_id === s.student_id) }; };
  // Ячейки баллов — как fn_result_cell в v_performance: баллы, «н/а» (не аттестован) или «неявка»
  const cell = (c) => (!c?.r ? "—" : c.r.absent ? `<span class="neg">неявка</span>` : c.r.points == null ? (c.sh.status === "Закрыта" || c.r.na ? `<span class="neg">н/а</span>` : `<span class="muted">ещё нет</span>`) : c.r.points < 25 ? `<span class="neg">${c.r.points}</span>` : String(c.r.points));
  const sems = Array.from({ length: done }, (_, i) => done - i);
  const pick = myGrades.sem === "cur" || !sems.includes(+myGrades.sem) ? "cur" : +myGrades.sem;
  const past = pick === "cur" ? [] : results.filter((r) => r.student_id === s.student_id && r.semester === pick);
  const myDebts = debtors.filter((d) => d.student_id === s.student_id);
  const table = pick === "cur"
    ? `<table class="sheet-table grades"><thead><tr><th>Дисциплина</th><th>Модуль 1</th><th>Модуль 2</th><th>Итог</th></tr></thead><tbody>${curDiscs.map((d) =>
        `<tr><td>${esc(d)}</td><td>${cell(ptsOf(d, "module_1"))}</td><td>${cell(ptsOf(d, "module_2"))}</td><td><span class="muted">в сессию</span></td></tr>`).join("")}</tbody></table>`
    : `<table class="sheet-table grades"><thead><tr><th>Дисциплина</th><th>Контроль</th><th>Баллы</th><th>Оценка</th><th>Сдано</th></tr></thead><tbody>${past.map((r) =>
        `<tr><td>${esc(r.discipline)}</td><td>${esc(r.control_type)}</td><td>${r.points ?? `<span class="neg">${missResult(r) === "Неявка" ? "неявка" : "н/а"}</span>`}</td><td>${badge(markName(r), r.points == null ? "bad" : mark(r.points) === 5 ? "ok" : mark(r.points) === 3 ? "warn" : "info")}</td>
          <td>${r.points == null ? "—" : ["", "В сессию", "На пересдаче", "Комиссии"][attemptOf(r)]}</td></tr>`).join("")}</tbody></table>`;
  return pageView("grades", "Успеваемость", [
    tiles([["Средний балл", String(s.avg_points ?? "—").replace(".", ","), "по всем сданным"], ["Долги", s.debts, s.debts ? "нужно пересдать" : "долгов нет", s.debts ? "bad" : "ok"],
      ["Категория", s.category], ["Стипендия", s.scholarships ? "Назначена" : "Нет", s.scholarships ?? (s.funding === "Договор" ? "обучение по договору" : "нужны оценки «хорошо» и «отлично»"), s.scholarships ? "ok" : ""]]),
    ...(myDebts.length ? [`<section class="card debts-card"><div class="table-head"><h2>Долги</h2></div><div class="debt-list">${myDebts.map((d) =>
      `<div class="debt-row">${icon("alert")}<div><b>${esc(d.discipline)}</b><small>${d.semester} семестр · ${esc(d.control_type)} · ${esc(d.last_result)} · попыток: ${d.attempts}</small></div></div>`).join("")}</div></section>`] : []),
    `<section class="card"><div class="table-head"><h2>${pick === "cur" ? `${cur} семестр — текущий` : `${pick} семестр`}</h2>
      <select class="pill-select" data-grades-sem aria-label="Семестр"><option value="cur" ${pick === "cur" ? "selected" : ""}>Текущий семестр</option>${sems.map((n) => `<option value="${n}" ${pick === n ? "selected" : ""}>${n} семестр</option>`).join("")}</select></div>
      <div class="sheet-wrap">${table}</div></section>`]);
};
PAGES.myattendance = () => {
  const s = ME, ls = schedule.filter((l) => l.group_name === s.group_name && l.lesson_date < TODAY);
  const rows = ls.map((l) => ({ ...l, here: attOf(l)[s.student_id] }));
  const by = [...new Set(rows.map((r) => r.discipline))].map((d) => { const x = rows.filter((r) => r.discipline === d), miss = x.filter((r) => r.here === false).length;
    return { d, n: x.length, miss, pct: x.length ? Math.round((x.length - miss) / x.length * 100) : null }; }).sort((a, b) => a.pct - b.pct);
  const miss = rows.filter((r) => r.here === false), pct = rows.length ? Math.round((rows.length - miss.length) / rows.length * 100) : null;
  return pageView("myattendance", "Посещаемость", [
    tiles([["Посещаемость", `${pct ?? "—"}%`, `за ${TERM_NAME} семестр`, pct >= 70 ? "ok" : "bad"], ["Пропущено занятий", miss.length, `из ${rows.length}`, miss.length ? "" : "ok"],
      ["Хуже всего посещаю", by[0] ? `${by[0].pct}%` : "—", by[0] ? esc(by[0].d) : "", by[0]?.pct < 70 ? "bad" : ""]]),
    `<section class="card"><div class="table-head"><h2>По дисциплинам</h2></div><div class="sheet-wrap"><table class="sheet-table"><thead><tr><th>Дисциплина</th><th>Занятий</th><th>Пропусков</th><th>Посещаемость</th></tr></thead><tbody>
      ${by.map((r) => `<tr><td>${esc(r.d)}</td><td>${r.n}</td><td>${r.miss || "—"}</td><td>${pctCell(r.pct)}</td></tr>`).join("")}</tbody></table></div></section>`,
    ...(miss.length ? [`<section class="card"><div class="table-head"><h2>Пропуски</h2></div><div class="miss-list">${miss.reverse().map((r) =>
      `<div class="miss-row"><b>${fmtDate(r.lesson_date)}</b><span>${r.pair_number} пара</span><span>${esc(r.discipline)}</span>${badge(r.lesson_type, LESSON_KIND[r.lesson_type])}</div>`).join("")}</div></section>`] : [])]);
};
const MYREQ_COLS = [
  { label: "№", field: "request_id", filter: "text", className: "num" },
  { label: "Документ", field: "document", filter: "enum", bold: true },
  { label: "Экз.", field: "copies", filter: "num", className: "num" },
  { label: "Куда", field: "purpose", filter: "enum" },
  { label: "Подана", field: "created_at", filter: "date", text: (r) => fmtDate(r.created_at) },
  { label: "Готова к", field: "due_date", filter: "date" },
  { label: "Статус", field: "status", filter: "enum", badge: true, render: (r) => badge(r.status, STATUS_KIND[r.status]) },
];
PAGES.myrequests = () => {
  const all = requests.filter((r) => r.student_id === ME.student_id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rows = applyTable("myrequests", MYREQ_COLS, all);
  return pageView("myrequests", "Справки", [
    tableTools("myrequests", MYREQ_COLS, all, rows.length, `<span class="spacer"></span><button class="btn sm primary" data-a="order-doc">${icon("plus")}Заказать справку</button>`),
    all.length ? dataTable("myrequests", MYREQ_COLS, rows, all, { rowKey: (r) => r.request_id, onRow: myRequestDialog })
      : `<div class="card empty-day">${icon("file")}<b>Заявок пока нет</b>Нажмите «Заказать справку» — деканат подготовит её в срок</div>`]);
};
function orderDoc() {
  const m = { label: "Заказать справку", v: { document: DOC_TYPES[0][0], copies: "1", purpose: PURPOSES[2] }, busy: false };
  const days = () => DOC_TYPES.find(([d]) => d === m.v.document)[1];
  m.html = () => `<form class="dialog form-dialog order-dialog" data-order novalidate>
    <div class="form-head"><div><h3>Заказать справку</h3><p>Деканат подготовит её в нормативный срок</p></div><button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body"><div class="form-grid">
      <div class="field form-field wide"><label for="od-doc">Документ</label><select id="od-doc" class="select" data-od="document">${DOC_TYPES.map(([d, n]) => `<option ${d === m.v.document ? "selected" : ""}>${esc(d)}</option>`).join("")}</select>
        <small class="hint">Срок подготовки — ${days()} ${plural(days(), "день", "дня", "дней")}, будет готова к ${fmtDate(addDays(TODAY, days()))}</small></div>
      <div class="field form-field"><label for="od-copies">Экземпляров</label><select id="od-copies" class="select" data-od="copies">${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => `<option ${String(n) === m.v.copies ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      <div class="field form-field"><label for="od-purpose">Куда</label><select id="od-purpose" class="select" data-od="purpose">${PURPOSES.map((p) => `<option ${p === m.v.purpose ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></div>
    </div></div>
    <div class="actions"><span class="spacer"></span><button type="button" class="btn" data-a="close">Отменить</button><button class="btn primary" ${m.busy ? "disabled" : ""}>${m.busy ? "Отправляем…" : "Заказать"}</button></div></form>`;
  m.close = () => closeModal(m);
  m.click = (el) => { if (el.dataset.a === "close") m.close(); };
  m.change = (el) => { if (el.dataset.od) { m.v[el.dataset.od] = el.value; render(); } };
  m.submit = async () => {
    m.v = { ...m.v, document: clip(m.v.document), purpose: clip(m.v.purpose) };
    m.busy = true; render(); await wait(450);
    const id = Math.max(...requests.map((r) => r.request_id)) + 1;
    requests.push({ request_id: id, student_id: ME.student_id, student: ME.student, group_name: ME.group_name, document: m.v.document, copies: +m.v.copies, purpose: m.v.purpose,
      status: "Новая", created_at: `${TODAY} ${new Date().toTimeString().slice(0, 5)}`, due_date: addDays(TODAY, days()), processed_by: null });
    logAudit("Заявка на справку", "INSERT", `Заявка № ${id}`, `${m.v.document}, ${m.v.copies} экз.`);
    closeModal(m); toast(`Заявка № ${id} отправлена в деканат`);
  };
  return openModal(m);
}
// Своя заявка: «Новую» студент может изменить (экземпляры и «куда»), остальные — только посмотреть. Отменить и удалить нельзя
function myRequestDialog(r) {
  const edit = r.status === "Новая";
  const m = { label: edit ? "Изменить заявку" : `Заявка № ${r.request_id}`, v: { copies: String(r.copies), purpose: r.purpose }, busy: false, err: null };
  const dirty = () => +m.v.copies !== r.copies || m.v.purpose !== r.purpose;
  const copies = Array.from({ length: 10 }, (_, i) => i + 1);   // как в базе: 1–10
  m.html = () => `<form class="dialog form-dialog order-dialog" data-order novalidate>
    <div class="form-head"><div><h3>${edit ? "Изменить заявку" : `Заявка № ${r.request_id}`}</h3><p>${edit ? `Заявка № ${r.request_id} · пока деканат не взял её в работу` : `${esc(r.document)} · подана ${fmtDate(r.created_at)}`}</p></div>
      <button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body">${edit ? `<div class="form-grid">
      <div class="field form-field wide"><label>Документ</label><b class="cur-res">${esc(r.document)}</b><small class="hint">Готова к ${fmtDate(r.due_date)}</small></div>
      <div class="field form-field"><label for="mr-copies">Экземпляров</label><select id="mr-copies" class="select" data-mr="copies" ${m.busy ? "disabled" : ""}>${copies.map((n) => `<option ${String(n) === m.v.copies ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      <div class="field form-field"><label for="mr-purpose">Куда</label><select id="mr-purpose" class="select" data-mr="purpose" ${m.busy ? "disabled" : ""}>${[...new Set([...PURPOSES, r.purpose])].map((x) => `<option ${x === m.v.purpose ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></div>
    </div>` : `<div class="kv-grid">${[["Документ", esc(r.document)], ["Экземпляров", r.copies], ["Куда", esc(r.purpose)], ["Статус", badge(r.status, STATUS_KIND[r.status])],
      ["Готова к", fmtDate(r.due_date)], ["Обрабатывает", esc(r.processed_by ?? "—")]].map(([l, v]) => `<div><small>${l}</small><b>${v}</b></div>`).join("")}</div>
      <div class="form-note">Деканат уже ${r.status === "В работе" ? "готовит" : "обработал"} заявку — изменить её нельзя. Если нужна другая справка, закажите новую.</div>`}
      ${m.err ? `<p class="form-error" role="alert">${esc(m.err)}</p>` : ""}</div>
    <div class="actions"><span class="spacer"></span><button type="button" class="btn" data-a="close">Закрыть</button>
      ${edit ? `<button class="btn primary" ${m.busy || !dirty() ? "disabled" : ""}>${m.busy ? "Сохраняем…" : "Сохранить"}</button>` : ""}</div></form>`;
  m.close = () => closeModal(m);
  m.click = (el) => { if (el.dataset.a === "close") m.close(); };
  m.change = (el) => { if (el.dataset.mr) { m.v[el.dataset.mr] = el.value; m.err = null; render(); } };
  m.submit = async () => {
    if (!edit || !dirty()) return;
    m.busy = true; render(); await wait(450);
    // Пока окно было открыто, деканат мог взять заявку в работу
    if (r.status !== "Новая") { m.busy = false; m.err = "Деканат уже взял заявку в работу — изменить её нельзя."; return render(); }
    const changes = [+m.v.copies !== r.copies && `Экземпляров: ${r.copies} → ${m.v.copies}`, m.v.purpose !== r.purpose && `Куда: ${r.purpose} → ${m.v.purpose}`].filter(Boolean).join("; ");
    Object.assign(r, { copies: +m.v.copies, purpose: clip(m.v.purpose) });
    logAudit("Заявка на справку", "UPDATE", `Заявка № ${r.request_id}`, changes);
    closeModal(m); toast(`Заявка № ${r.request_id} изменена`);
  };
  return openModal(m);
}
/* ── Заказ справки через чат: агент уточняет документ, экземпляры и «куда», затем готовит предложение.
   Применяет его деканат («Согласование»), сам студент только смотрит ── */
const DOC_DRAFTS = new Map();   // чат → { document, copies, purpose, ask }
// Слова в просьбе → название из справочников DOC_TYPES и PURPOSES
const DOC_WORDS = [[/об\s+обучени|обучени/, "Справка об обучении"], [/академическ/, "Академическая справка"], [/для\s+воен/, "Справка для военного комиссариата"],
  [/стипенди/, "Справка о размере стипендии"], [/выписк/, "Выписка из приказа"]];
const PURPOSE_WORDS = [[/(^|\s)в\s+воен/, "В военный комиссариат"], [/банк/, "В банк"], [/требовани/, "По месту требования"], [/налогов/, "В налоговую инспекцию"],
  [/родител/, "По месту работы родителей"], [/общежит/, "Для оформления общежития"], [/поликлиник/, "В поликлинику"], [/перевод/, "Для перевода в другой вуз"],
  [/соц(иальн|защит)/, "В органы социальной защиты"]];
const NUM_WORDS = { один: 1, одну: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10 };
function docParse(s, d) {
  const out = {}, num = s.match(/\b(\d{1,2})\b/)?.[1], word = Object.keys(NUM_WORDS).find((w) => new RegExp(`(^|\\s)${w}(\\s|$)`).test(s));
  // Короткий ответ на вопрос агента: номер из списка или число экземпляров
  if (d?.ask === "document" && num && DOC_TYPES[+num - 1]) out.document = DOC_TYPES[+num - 1][0];
  else if (d?.ask === "purpose" && num && PURPOSES[+num - 1]) out.purpose = PURPOSES[+num - 1];
  else if (d?.ask === "copies" && (num || word)) out.copies = num ? +num : NUM_WORDS[word];
  else if (/(экз|копи|шт)/.test(s) && (num || word)) out.copies = num ? +num : NUM_WORDS[word];
  if (!out.document) { const hit = DOC_WORDS.find(([re]) => re.test(s)); if (hit) out.document = hit[1]; }
  // На вопрос «куда» короткий ответ «военкомат» — это место, а не вид справки
  if (!out.purpose) { const hit = PURPOSE_WORDS.find(([re]) => re.test(s)) ?? (d?.ask === "purpose" && /воен/.test(s) ? [null, "В военный комиссариат"] : null); if (hit) out.purpose = hit[1]; }
  return out;
}
function docOrderReply(raw, s) {
  const key = chat.activeId, d = DOC_DRAFTS.get(key) ?? { document: null, copies: null, purpose: null, ask: null, first: clip(raw) };
  if (/(отмен|не надо|передума|не нужн)/.test(s)) { DOC_DRAFTS.delete(key); return { html: P("Хорошо, заявку на справку не оформляю.") }; }
  const got = docParse(s, d);
  Object.assign(d, got);
  const bad = d.copies != null && !(d.copies >= 1 && d.copies <= 10);
  if (bad) d.copies = null;
  const have = [d.document && `<b>${esc(d.document)}</b>`, d.copies && `${d.copies} экз.`, d.purpose && `«${esc(d.purpose)}»`].filter(Boolean).join(", ");
  const pre = have ? P(`Оформляю заявку: ${have}${have.endsWith(".") ? "" : "."}`) : "";
  const list = (items) => `<ol>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`;
  if (!d.document) { d.ask = "document"; DOC_DRAFTS.set(key, d); return { html: pre + P("Какую справку заказать? Напишите название или номер:") + list(DOC_TYPES.map(([x]) => x)) }; }
  if (!d.copies) { d.ask = "copies"; DOC_DRAFTS.set(key, d); return { html: pre + P(bad ? "Экземпляров можно заказать от 1 до 10. Сколько нужно?" : "Сколько экземпляров нужно? От 1 до 10.") }; }
  if (!d.purpose) { d.ask = "purpose"; DOC_DRAFTS.set(key, d); return { html: pre + P("Куда нужна справка? Напишите или выберите номер:") + list(PURPOSES) }; }
  DOC_DRAFTS.delete(key);
  const days = DOC_TYPES.find(([x]) => x === d.document)[1], st = ME;
  return { tool: "propose_sql_change", html: P(`Подготовил заявку: <b>${esc(d.document)}</b>, ${d.copies} экз., «${esc(d.purpose)}». Её подтвердит деканат — после этого справка будет готова за ${days} ${plural(days, "день", "дня", "дней")}.`),
    proposal: { kind: "Заявка студента", decision_status: "Ждёт подтверждения деканата", explanation: `Заявка на справку: ${d.document}, ${d.copies} экз.`, table: "Заявка на справку", operation: "INSERT",
      rows: [{ label: "Документ", before: null, after: d.document }, { label: "Экземпляров", before: null, after: d.copies }, { label: "Куда", before: null, after: d.purpose }],
      reason: `Запрос студента: «${d.first}»`, author: st.full_name, author_role: ROLE, created_at: `${TODAY} ${new Date().toTimeString().slice(0, 5)}`,
      // Применяет деканат: заявка появляется у студента во вкладке «Справки» со статусом «Новая»
      apply() {
        const id = Math.max(...requests.map((r) => r.request_id)) + 1;
        requests.push({ request_id: id, student_id: st.student_id, student: st.student, group_name: st.group_name, document: d.document, copies: d.copies, purpose: d.purpose,
          status: "Новая", created_at: `${TODAY} ${new Date().toTimeString().slice(0, 5)}`, due_date: addDays(TODAY, days), processed_by: null });
      } } };
}
PAGES.mystudy = () => {
  const s = ME, w = works.find((x) => x.student_id === s.student_id), p = practices.find((x) => x.student_id === s.student_id);
  const mv = moves.filter((x) => x.student_id === s.student_id);
  const empty = (ic, t, d) => `<section class="card empty-day">${icon(ic)}<b>${t}</b>${d}</section>`;
  return pageView("mystudy", "Моя учёба", [
    w ? kvCard(w.work_kind === "ВКР" ? "Выпускная квалификационная работа" : "Курсовая работа", [["Тема", esc(w.topic)], ["Руководитель", esc(w.supervisor)],
      ["Рецензент", esc(w.reviewer ?? "не назначается")], ["Приказ об утверждении темы", esc(w.order_number ?? "не требуется")]], badge(`${w.semester} семестр`, "info")) : empty("cap", "Курсовой или ВКР в этом году нет", "Тема появится, когда её утвердит кафедра"),
    p ? kvCard(p.practice, [["Организация", esc(p.organization)], ["Сроки", `${fmtDate(p.start_date)} — ${fmtDate(p.end_date)}`], ["Руководитель от вуза", esc(p.supervisor)],
      ["Руководитель от организации", esc(p.org_supervisor)], ["Приказ", esc(p.order_number)]], badge(p.end_date < TODAY ? "Пройдена" : "Предстоит", p.end_date < TODAY ? "ok" : "info")) : empty("briefcase", "Практики пока нет", "Направление на практику оформит деканат"),
    kvCard("Стипендия", [["Сейчас", s.scholarships ? esc(s.scholarships) : "Не назначена"], ...(s.scholarships ? [["Размер", `${fmtNum(s.scholarship_amount)} ₽ в месяц`]] : []), ["Основа обучения", s.funding], ["Почему", s.scholarships ? "сессия сдана на «хорошо» и «отлично»" : s.funding === "Договор" ? "академическая стипендия — только на бюджете" : "нужно сдать сессию без троек и долгов"]]),
    `<section class="card"><div class="table-head"><h2>Приказы обо мне</h2></div>${mv.length ? `<div class="miss-list">${mv.map((x) =>
      `<div class="miss-row"><b>${fmtDate(x.order_date)}</b><span>${esc(x.order_number)}</span><span>${esc(x.order_type)}</span></div>`).join("")}</div>` : `<p class="olap-foot">Приказов о вас за последний год не было.</p>`}</section>`]);
};

/* ═════════ СОГЛАСОВАНИЕ ═════════
   Одно хранилище PROPOSALS: изменения из чата (в том числе пакеты), заявки студентов и заявки на исправление оценки.
   Входящие — то, что я могу решить; Мои — отправленные мной; История — решённые, отменённые и истёкшие.
   Окно решения — то же, что в чате (proposalDialog / batchDialog). */
const nowStamp = () => `${TODAY} ${new Date().toTimeString().slice(0, 5)}`;
const EXPIRE_HOURS = 24;
const isCorrection = (p) => p.kind === "Исправление оценки";
// Предложение агента действует сутки. Заявка на исправление оценки — запись базы (grade_correction), срока у неё нет
const apprExpired = (p) => p.status === "pending" && !isCorrection(p) && !!p.created_at
  && Date.now() - new Date(p.created_at.replace(" ", "T")).getTime() > EXPIRE_HOURS * 36e5;
const apprOpen = (p) => ["pending", "failed", "unknown"].includes(p.status) && !apprExpired(p);
// Как fn_manages_institute: директор института или заместитель директора (сотрудник деканата на административной должности)
const managesInstitute = () => [DIRECTOR, DEPUTY].some((e) => e && e === ME && !e.dismissal_date);
// Кто вправе решать: исправление оценки — руководитель института, но не автор заявки; преподаватель — только своё; студент — ничего
function canDecide(p) {
  if (ROLE === "student") return false;
  if (isCorrection(p)) return managesInstitute() && p.author !== ME.full_name;
  if (ROLE === "teacher") return p.author === ME.full_name;
  return true;
}
// Видимость: деканат, директор и админ — всё по институту (в макете он один), преподаватель и студент — только своё
const apprVisible = (p) => (["student", "teacher"].includes(ROLE) ? p.author === ME.full_name : true);
// Входящие: у деканата без исправлений оценок (кроме заместителя директора — он их решает), у преподавателя — свои изменения
const apprInbox = (p) => apprOpen(p) && apprVisible(p) && (!isCorrection(p) || ["director", "admin"].includes(ROLE) || (ROLE === "dean_staff" && managesInstitute()));
// Подготовить заново может автор: изменение из чата — той же просьбой агенту, исправление оценки — новой заявкой
const canRedo = (p) => p.author === ME.full_name && (isCorrection(p) ? ROLE !== "student" : !!p.prompt);
const canWork = (p) => apprOpen(p) && !isCorrection(p) && ["dean_staff", "director", "admin"].includes(ROLE);

const DECISION = { approved: "Одобрено", rejected: "Отклонено", undone: "Одобрено", unknown: "Одобрено" };
const EXECUTION = { approved: "Выполнено", failed: "Ошибка", unknown: "Неизвестно", undone: "Отменено" };
const DECISION_KIND = { "Одобрено": "ok", "Отклонено": "bad", "Истекло": "muted" };
const EXECUTION_KIND = { "Выполнено": "ok", "Ошибка": "bad", "Неизвестно": "warn", "Отменено": "muted" };
// Событие в истории предложения; после решения обновляются статусы решения и исполнения
function proposalEvent(p, text) {
  (p.history ??= []).push({ at: nowStamp(), who: ME.full_name, text });
  if (p.status !== "pending") Object.assign(p, { decision_status: DECISION[p.status] ?? p.decision_status, execution_status: EXECUTION[p.status] ?? null });
}
const apprDecision = (p) => (apprExpired(p) ? "Истекло" : ["pending", "failed"].includes(p.status) ? p.decision_status ?? "Ждёт решения" : p.decision_status ?? DECISION[p.status]);
const personShort = (n) => (String(n).split(" ").length === 3 ? shortName(n) : n);

/* ── Блоки окна решения: исполнитель (взять в работу, передать) и история ── */
function apprWorkHtml(p) {
  if (!apprOpen(p)) return "";
  return `<div class="appr-work"><span>Исполнитель: <b>${p.assignee ? esc(p.assignee) : "не назначен"}</b></span>${canWork(p) ? `<span class="spacer"></span>
    ${p.assignee !== ME.full_name ? `<button type="button" class="btn sm soft" data-a="appr-take">${icon("check")}Взять в работу</button>` : ""}
    <button type="button" class="btn sm ghost" data-a="appr-pass">${icon("users")}Передать сотруднику</button>` : ""}</div>`;
}
const apprHistHtml = (p) => (p.history?.length ? `<div class="appr-hist"><h4>История</h4><div class="miss-list">${p.history.map((h) =>
  `<div class="miss-row"><b>${fmtDateTime(h.at)}</b><span>${esc(personShort(h.who))}</span><span>${esc(h.text)}</span></div>`).join("")}</div></div>` : "");
function apprClick(a, p, m) {
  if (a === "appr-take") { p.assignee = ME.full_name; proposalEvent(p, "Взял в работу"); toast("Вы взяли предложение в работу"); render(); return true; }
  if (a === "appr-pass") { passDialog(p); return true; }
  if (a === "appr-redo") { closeModal(m); redoProposal(p); return true; }
  return false;
}
function redoProposal(p) {
  if (isCorrection(p)) {
    const sh = sheets.find((x) => x.sheet_id === p.sheet_id), r = sh?.rows.find((x) => x.student_id === p.student_id);
    if (sh && r) correctionDialog(sh, r);
    return;
  }
  chat.open = true; chat.texts[draftKey()] = p.prompt; render(); submitChat();
}
// Передать сотруднику деканата института: кому и почему (10–2000 символов) — пишется в историю
function passDialog(p) {
  const staff = deanStaff.filter((e) => !e.dismissal_date && e.full_name !== p.assignee && e.full_name !== ME.full_name);
  formDialog({ title: "Передать сотруднику", subtitle: p.explanation, submitLabel: "Передать", busyLabel: "Передаём…",
    fields: [{ name: "to", label: "Сотрудник деканата", kind: "relation", required: true, options: () => staff.map((e) => ({ value: e.full_name, label: e.full_name, sub: e.position })) },
      { name: "reason", label: "Причина", kind: "textarea", required: true, hint: `От ${REASON_MIN} до 2000 символов` }],
    checks: (v) => ({ reason: v.reason && (v.reason.length < REASON_MIN ? `Не короче ${REASON_MIN} символов` : v.reason.length > 2000 ? "Не длиннее 2000 символов" : undefined) }),
    onSubmit: (v) => { p.assignee = v.to; proposalEvent(p, `Передал: ${personShort(v.to)} — «${v.reason}»`); return { toast: `Передано: ${personShort(v.to)}` }; } });
}

/* ── Демо-предложения за последние дни — по правилам базы: баллы модуля 25–54, исправление решает директор (не автор),
   переходы статусов заявок допустимые ── */
{
  const at = (days, hm) => `${addDays(TODAY, -days)} ${hm}`;
  const ev = (when, who, text) => ({ at: when, who, text });
  const add = (o) => { const pid = uid(); PROPOSALS[pid] = { pid, decision_reason: null, assignee: null, decision_status: null, execution_status: null, effects: [], ...o }; };
  const [d0, d1] = deanStaff, newReqs = requests.filter((r) => r.status === "Новая"), workReqs = requests.filter((r) => r.status === "В работе" && r.processed_by);
  const reqChange = (r, to) => ({ table: "Заявка на справку", operation: "UPDATE", rows: [{ label: "Статус", before: r.status, after: to }],
    apply: () => { if (r.status !== reqChange.from.get(r)) throw new Error(`Заявка № ${r.request_id} уже в статусе «${r.status}» — изменение не применено`); r.status = to; r.processed_by ||= ME.full_name; } });
  reqChange.from = new Map(requests.map((r) => [r, r.status]));
  // Деканат: новое изменение, ещё никто не взял
  if (newReqs[0]) add({ status: "pending", kind: "Обычное", explanation: `Сменить статус заявки № ${newReqs[0].request_id} на «В работе»`, reason: `Запрос сотрудника: «переведи заявку ${newReqs[0].request_id} в работу»`,
    prompt: `переведи заявку ${newReqs[0].request_id} в работу`, author: d1.full_name, author_role: "dean_staff", created_at: at(0, "08:05"), ...reqChange(newReqs[0], "В работе"),
    history: [ev(at(0, "08:05"), d1.full_name, "Подготовлено агентом по запросу")] });
  // Студент: заявка на справку, её взял в работу сотрудник деканата
  { const st = DEMO_STUDENT, [doc, days] = DOC_TYPES[0];
    add({ status: "pending", kind: "Заявка студента", decision_status: "Ждёт подтверждения деканата", explanation: `Заявка на справку: ${doc}, 2 экз.`, table: "Заявка на справку", operation: "INSERT",
      rows: [{ label: "Документ", before: null, after: doc }, { label: "Экземпляров", before: null, after: 2 }, { label: "Куда", before: null, after: PURPOSES[0] }],
      reason: "Запрос студента: «закажи справку с места учёбы»", prompt: "закажи справку с места учёбы", author: st.full_name, author_role: "student", created_at: at(0, "07:40"), assignee: d0.full_name,
      history: [ev(at(0, "07:40"), st.full_name, "Подготовлено агентом по запросу"), ev(at(0, "07:55"), d0.full_name, "Взял в работу")],
      apply() {
        const id = Math.max(...requests.map((r) => r.request_id)) + 1;
        requests.push({ request_id: id, student_id: st.student_id, student: st.student, group_name: st.group_name, document: doc, copies: 2, purpose: PURPOSES[0],
          status: "Новая", created_at: nowStamp(), due_date: addDays(TODAY, days), processed_by: null });
      } }); }
  // Заявки на исправление оценки в закрытой ведомости модуля 1: одна ждёт решения, другую уже одобрил директор
  const closedM1 = sheets.filter((sh) => sh.stage === "module_1" && sh.status === "Закрыта");
  const mine = closedM1.find((sh) => sh.examiner === DEMO_TEACHER.full_name && sh.rows.some((r) => r.points >= 25 && r.points <= 50));
  if (mine) { const r = mine.rows.find((x) => x.points >= 25 && x.points <= 50), next = r.points + 4, before = r.points;
    add({ status: "pending", kind: "Исправление оценки", decision_status: "Ждёт решения директора", explanation: `Исправление оценки: ${r.student} · ${mine.discipline}`,
      table: `Ведомость ${mine.sheet_number} · ${mine.group_name}`, operation: "UPDATE", rows: [{ label: "Результат", before: resLabel(mine, r), after: resLabel(mine, { points: next, absent: false }) }],
      reason: "При подсчёте не учтено третье задание контрольной работы", author: DEMO_TEACHER.full_name, author_role: "teacher", created_at: at(2, "14:10"), sheet_id: mine.sheet_id, student_id: r.student_id,
      history: [ev(at(2, "14:10"), DEMO_TEACHER.full_name, "Подал заявку: «При подсчёте не учтено третье задание контрольной работы»")],
      apply() { if (r.points !== before || r.absent) throw new Error("Оценка изменилась после подачи заявки — подайте заявку заново"); Object.assign(r, { points: next, absent: false, na: false }); } }); }
  const other = closedM1.find((sh) => sh !== mine && sh.rows.some((r) => r.points >= 27));
  if (other && DIRECTOR) { const r = other.rows.find((x) => x.points >= 27);
    add({ status: "approved", kind: "Исправление оценки", decision_status: "Одобрено", execution_status: "Выполнено", explanation: `Исправление оценки: ${r.student} · ${other.discipline}`,
      table: `Ведомость ${other.sheet_number} · ${other.group_name}`, operation: "UPDATE", rows: [{ label: "Результат", before: resLabel(other, { points: r.points - 2, absent: false }), after: resLabel(other, r) }],
      reason: "Ошибка переноса баллов из журнала преподавателя", decision_reason: "Подтверждено по журналу преподавателя", author: d0.full_name, author_role: "dean_staff", created_at: at(4, "10:20"),
      sheet_id: other.sheet_id, student_id: r.student_id, apply() {},
      history: [ev(at(4, "10:20"), d0.full_name, "Подал заявку: «Ошибка переноса баллов из журнала преподавателя»"), ev(at(3, "12:05"), DIRECTOR.full_name, "Применил: «Подтверждено по журналу преподавателя»")] }); }
  // Преподаватель: баллы в своей открытой ведомости модуля 2 — подтверждает сам
  const open2 = sheets.find((sh) => sh.examiner === DEMO_TEACHER.full_name && sh.stage === "module_2" && sh.status === "Открыта" && sh.rows.some((r) => r.points == null && !r.absent));
  if (open2) { const r = open2.rows.find((x) => x.points == null && !x.absent);
    add({ status: "pending", kind: "Обычное", explanation: `${shortName(r.student)}: 41 ${plural(41, "балл", "балла", "баллов")} · ${open2.discipline}`, table: "Ведомость", operation: "UPDATE", rows: [{ label: "Баллы", before: null, after: 41 }],
      reason: `Запрос преподавателя: «исправь баллы: ${r.student.split(" ")[0]}, 41»`, prompt: `исправь баллы: ${r.student.split(" ")[0]}, 41`, author: DEMO_TEACHER.full_name, author_role: "teacher", created_at: at(0, "07:30"),
      history: [ev(at(0, "07:30"), DEMO_TEACHER.full_name, "Подготовлено агентом по запросу")],
      apply() { if (open2.status !== "Открыта") throw new Error("Ведомость закрыта — баллы меняются только через заявку на исправление"); Object.assign(r, { points: 41, absent: false, na: false }); } }); }
  // Сотрудник деканата: истёкшее (не решили за сутки), отклонённое директором и применённое коллегой
  if (workReqs[0]) add({ status: "pending", kind: "Обычное", explanation: `Сменить статус заявки № ${workReqs[0].request_id} на «Готова к выдаче»`,
    reason: `Запрос сотрудника: «заявка ${workReqs[0].request_id} готова»`, prompt: `заявка ${workReqs[0].request_id} готова`, author: d0.full_name, author_role: "dean_staff", created_at: at(3, "11:30"),
    ...reqChange(workReqs[0], "Готова к выдаче"), history: [ev(at(3, "11:30"), d0.full_name, "Подготовлено агентом по запросу")] });
  if (newReqs[1] && DIRECTOR) add({ status: "rejected", kind: "Обычное", decision_status: "Отклонено", explanation: `Сменить статус заявки № ${newReqs[1].request_id} на «Отклонена»`,
    reason: `Запрос сотрудника: «отклони заявку ${newReqs[1].request_id}»`, prompt: `отклони заявку ${newReqs[1].request_id}`, author: d0.full_name, author_role: "dean_staff", created_at: at(1, "15:00"),
    decision_reason: "Студенту справка нужна — подготовьте её в обычном порядке", ...reqChange(newReqs[1], "Отклонена"),
    history: [ev(at(1, "15:00"), d0.full_name, "Подготовлено агентом по запросу"), ev(at(1, "16:40"), DIRECTOR.full_name, "Отклонил: «Студенту справка нужна — подготовьте её в обычном порядке»")] });
  if (workReqs[1]) { const r = workReqs[1];
    add({ status: "approved", kind: "Обычное", decision_status: "Одобрено", execution_status: "Выполнено", explanation: `Сменить статус заявки № ${r.request_id} на «В работе»`,
      reason: `Запрос сотрудника: «возьми заявку ${r.request_id} в работу»`, prompt: `возьми заявку ${r.request_id} в работу`, author: d1.full_name, author_role: "dean_staff", created_at: at(1, "10:15"),
      table: "Заявка на справку", operation: "UPDATE", rows: [{ label: "Статус", before: "Новая", after: "В работе" }], decision_reason: "Документы студента проверены", apply() {},
      history: [ev(at(1, "10:15"), d1.full_name, "Подготовлено агентом по запросу"), ev(at(1, "10:32"), r.processed_by, "Применил: «Документы студента проверены»")] }); }
}

/* ── Вкладка: Входящие / Мои / История, таблица с фильтрами; строка открывает окно решения ── */
let apprView = null, apprFor = null;   // вид выбирается заново у каждого вошедшего
const APPR_COLS = [
  { label: "Что", field: "explanation", filter: "text", className: "wrap" },
  { label: "Автор", field: "author", filter: "enum" },
  { label: "Когда", field: "created_at", filter: "date", text: (r) => fmtDateTime(r.created_at) },
  { label: "Исполнитель", field: (r) => r.assignee ?? "—", filter: "enum" },
  { label: "Решение", field: apprDecision, filter: "enum", badge: true, render: (r) => { const d = apprDecision(r); return badge(d, DECISION_KIND[d] ?? "info"); } },
  { label: "Исполнение", field: (r) => r.execution_status ?? "—", filter: "enum", badge: true,
    render: (r) => (r.execution_status ? badge(r.execution_status, EXECUTION_KIND[r.execution_status] ?? "info") : "—") },
];
PAGES.approvals = () => {
  const all = Object.entries(PROPOSALS).map(([k, p]) => { p.pid ??= k; return p; }).filter((p) => p.created_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  // У студента — только «Мои»
  const views = ROLE === "student" ? [["my", "Мои", all.filter((p) => p.author === ME.full_name)]]
    : [["in", "Входящие", all.filter(apprInbox)], ["my", "Мои", all.filter((p) => p.author === ME.full_name)], ["hist", "История", all.filter((p) => apprVisible(p) && !apprOpen(p))]];
  if (apprFor !== ME || !views.some(([v]) => v === apprView)) { apprView = views[0][0]; apprFor = ME; }
  const base = views.find(([v]) => v === apprView)[2], id = `appr-${apprView}`;
  const rows = applyTable(id, APPR_COLS, base);
  return pageView("approvals", "Согласование", [
    tableTools(id, APPR_COLS, base, rows.length, views.length > 1 ? `<span class="spacer"></span>${seg("appr-view", views.map(([v, l, xs]) => [v, `${l} ${xs.length}`]), apprView)}` : ""),
    dataTable(id, APPR_COLS, rows, base, { rowKey: (r) => r.pid, onRow: (r) => proposalDialog(r.pid) })]);
};
Object.assign(ACT, { "appr-view": (el) => { apprView = el.dataset.v; render(); } });

/* ═════════ АДМИНИСТРАТОР ═════════ */
const users = [
  { login: "admin", person: "Администратор системы", role: "admin", active: true, last: TODAY },
  ...employees.map((e) => ({ login: e.email.split("@")[0], person: e.full_name, role: /Дирекция/.test(e.unit) ? "director" : e.unit === "Деканат" ? "dean_staff" : "teacher", active: true,
    last: addDays(TODAY, -Math.floor(h01(`last|${e.full_name}`) * 20)) })),
  ...students.filter((s) => s.status !== "Отчислен").map((s) => ({ login: `st${s.record_book_number.replace("-", "")}`, person: s.student, role: "student", active: s.status === ACTIVE,
    last: s.status === ACTIVE ? addDays(TODAY, -Math.floor(h01(`last|${s.student}`) * 30)) : null })),
].map((u, i) => ({ user_id: i + 1, ...u }));
const USER_COLS = [
  { label: "Логин", field: "login", filter: "text", bold: true },
  { label: "Человек", field: "person", filter: "text" },
  { label: "Роль", field: (r) => ROLES[r.role].name, filter: "enum", badge: true, render: (r) => badge(ROLES[r.role].name, { admin: "bad", director: "warn", dean_staff: "info", teacher: "ok", student: "muted" }[r.role]) },
  { label: "Доступ", field: (r) => (r.active ? "Активен" : "Отключён"), filter: "enum", badge: true, render: (r) => badge(r.active ? "Активен" : "Отключён", r.active ? "ok" : "muted") },
  { label: "Последний вход", field: "last", filter: "date" },
];
PAGES.users = () => {
  const rows = applyTable("users", USER_COLS, users);
  return pageView("users", "Пользователи", [
    tableTools("users", USER_COLS, users, rows.length),
    dataTable("users", USER_COLS, rows, users, { rowKey: (r) => r.user_id, onRow: openUser })]);
};
// Пользователь: только просмотр. Роль и доступ задаются учётной записью в базе; админ может только сбросить пароль
function openUser(u) {
  const m = { label: u.login };
  m.html = () => `<div class="dialog form-dialog">
    <div class="form-head"><div><h3>${esc(u.login)}</h3><p>${esc(u.person)}</p></div><button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body"><div class="kv-grid">
      <div><small>Роль</small><b>${badge(ROLES[u.role].name, { admin: "bad", director: "warn", dean_staff: "info", teacher: "ok", student: "muted" }[u.role])}</b></div>
      <div><small>Доступ</small><b>${badge(u.active ? "Активен" : "Отключён", u.active ? "ok" : "muted")}</b></div>
      <div><small>Последний вход</small><b>${u.last ? fmtDate(u.last) : "—"}</b></div></div>
      <div class="form-note">Роль и доступ задаются учётной записью в базе и здесь не меняются.</div></div>
    <div class="actions"><button type="button" class="btn sm ghost" data-a="reset-pw">${icon("refresh")}Сбросить пароль</button>
      <span class="spacer"></span><button type="button" class="btn" data-a="close">Закрыть</button></div></div>`;
  m.close = () => closeModal(m);
  m.click = (el) => {
    if (el.dataset.a === "close") m.close();
    if (el.dataset.a === "reset-pw") confirmDialog({ title: "Сбросить пароль?", text: `${u.login} не сможет войти со старым паролем. Новый временный пароль нужно будет передать пользователю.`,
      confirm: "Сбросить", onConfirm: () => { logAudit("Пользователь", "UPDATE", u.login, "Пароль сброшен"); tempPasswordDialog(u); } });
  };
  return openModal(m);
}
// Временный пароль: 12 символов, есть строчные, заглавные и цифры; похожие символы (0/O, 1/l/I) не используются
function tempPassword() {
  const sets = ["abcdefghijkmnpqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789"], all = sets.join(""), r = crypto.getRandomValues(new Uint32Array(12));
  const chars = [...r].map((x, i) => (i < 3 ? sets[i] : all)[x % (i < 3 ? sets[i] : all).length]);
  for (let i = chars.length - 1; i > 0; i--) { const j = r[i] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}
function tempPasswordDialog(u) {
  const pw = tempPassword(), m = { label: "Временный пароль" };
  Object.assign(u, { mustChange: true, tempPassword: pw });
  m.html = () => `<div class="dialog form-dialog">
    <div class="form-head"><div><h3>Временный пароль</h3><p>${esc(u.login)} · ${esc(u.person)}</p></div><button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body"><div class="pw-box"><code>${esc(pw)}</code><button type="button" class="btn sm soft" data-a="pw-copy">${icon("copy")}Скопировать</button></div>
      <div class="form-note">Пользователь сменит пароль при первом входе. После закрытия окна пароль больше не показывается.</div></div>
    <div class="actions"><span class="spacer"></span><button type="button" class="btn primary" data-a="close">Готово</button></div></div>`;
  m.close = () => closeModal(m);
  m.click = async (el) => {
    if (el.dataset.a === "close") m.close();
    if (el.dataset.a === "pw-copy") { try { await navigator.clipboard.writeText(pw); toast("Пароль скопирован"); } catch { toast("Не удалось скопировать — выделите пароль вручную", true); } }
  };
  return openModal(m);
}

/* ── Состояние сервисов агента (у админа — кнопка «Сервисы» в шапке) ── */
function openServices() {
  const m = { label: "Сервисы" };
  m.html = () => `<div class="dialog form-dialog ref-dialog">
    <div class="form-head"><div><h3>Сервисы</h3><p>Состояние сервисов агента</p></div><button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body"><div class="ref-list">${SERVICES.map(([id, name]) => `<div class="ref-row"><b>${name}</b>${serviceDown(id) ? badge("недоступен", "bad") : badge("работает", "ok")}</div>`).join("")}</div>
      ${serviceDown("model") ? `<div class="form-note">Пока модель недоступна, чат у всех пользователей не отправляет сообщения. Таблицы и формы работают.</div>` : ""}</div>
    <div class="actions"><span class="spacer"></span><button type="button" class="btn" data-a="close">Закрыть</button></div></div>`;
  m.close = () => closeModal(m);
  m.click = (el) => { if (el.dataset.a === "close") m.close(); };
  return openModal(m);
}

/* ── Справочники. Как в базе: деканат и админ пополняют и правят разрешённые справочники, но не удаляют —
   на значения ссылаются данные. В базе ссылки по id, в макете — строкой, поэтому при правке значение меняется и в данных ── */
const roomCheck = (n) => (!/^[А-ЯA-Z]{1,3}-\d{1,4}[а-я]?$/.test(n) ? "Корпус и номер через дефис, например В-310" : undefined);
const ROOM_KIND = { lecture: "лекционная", computer: "компьютерный класс", lab: "лаборатория", practice: "для практик" };
const swapIn = (list, field, from, to) => list.forEach((x) => { if (x[field] === from) x[field] = to; });
const replaceAt = (arr, from, to) => { const i = arr.indexOf(from); if (i >= 0) arr[i] = to; };
const REFS = [
  ["Виды справок", "document_type", () => DOC_TYPES.map(([d, n]) => [d, `${n} ${plural(n, "день", "дня", "дней")} на подготовку`]), {
    names: () => DOC_TYPES.map(([d]) => d),
    fields: [{ name: "name", label: "Название" }, { name: "days", label: "Дней на подготовку", type: "number", def: "3", min: 1 }],
    add: (v) => DOC_TYPES.push([v.name, +v.days]),
    rename: (i, to) => { const from = DOC_TYPES[i][0]; DOC_TYPES[i][0] = to; swapIn(requests, "document", from, to); } }],
  ["Статусы заявок", "request_status", () => REQUEST_STATUSES.map((s) => [s, FINAL_STATUS.includes(s) ? "завершающий" : ""]), {
    names: () => REQUEST_STATUSES,
    fields: [{ name: "name", label: "Название", hint: "Новый статус — не завершающий" }],
    add: (v) => { REQUEST_STATUSES.push(v.name); STATUS_KIND[v.name] = "info"; },
    rename: (i, to) => { const from = REQUEST_STATUSES[i]; REQUEST_STATUSES[i] = to; replaceAt(FINAL_STATUS, from, to); STATUS_KIND[to] = STATUS_KIND[from]; swapIn(requests, "status", from, to); } }],
  ["Основы обучения", "funding_type", () => FUNDING.map((f) => [f, ""])],
  ["Причины академического отпуска", "leave_reason", () => LEAVE_REASONS.map((r) => [r, ""]), {
    names: () => LEAVE_REASONS,
    fields: [{ name: "name", label: "Название" }],
    add: (v) => LEAVE_REASONS.push(v.name),
    rename: (i, to) => { const from = LEAVE_REASONS[i]; LEAVE_REASONS[i] = to; swapIn(plannedOrders, "leave_reason", from, to); } }],
  ["Виды приказов", "order_type", () => ORDER_TYPES.map(([c, n, x]) => [n, `код ${c} · суффикс ${x}`]), {
    names: () => ORDER_TYPES.map(([, n]) => n),
    fields: [{ name: "name", label: "Название" }, { name: "code", label: "Код", hint: "латиницей, например graduate" }, { name: "suffix", label: "Суффикс номера", def: "-с" }],
    check: (v) => ({ code: !/^[a-z][a-z_]{1,29}$/.test(v.code) ? "Латинские строчные буквы и «_», от 2 до 30 символов" : ORDER_TYPES.some(([c]) => c === v.code) ? "Такой код уже есть" : undefined, suffix: !/^-[а-яa-z]{1,9}$/.test(v.suffix) ? "Дефис и буквы, например -с" : undefined }),
    add: (v) => ORDER_TYPES.push([v.code, v.name, v.suffix]),
    // Код не меняется — по нему процедуры узнают вид приказа; меняется название (и в данных макета, где оно записано строкой)
    rename: (i, to) => { const [code] = ORDER_TYPES[i]; ORDER_TYPES[i][1] = to; if (MOVE_NAME[code]) { MOVE_NAME[code] = to; MOVE_TYPES.find(([c]) => c === code)[1] = to; }
      moves.forEach((x) => { if (x.type === code) x.order_type = to; }); } }],
  ["Виды стипендий", "scholarship_type", () => SCHOLARSHIP_TYPES.map((t) => [t.name, `${fmtNum(t.amount)} ₽ в месяц${t.budget_only ? " · только бюджет" : ""}`]), {
    names: () => SCHOLARSHIP_TYPES.map((t) => t.name),
    fields: [{ name: "name", label: "Название" }, { name: "amount", label: "Размер, ₽ в месяц", type: "number", min: 0 },
      { name: "budget_only", label: "Кому", type: "select", options: [["yes", "Только бюджет"], ["no", "Бюджет и договор"]], def: "yes" }],
    add: (v) => SCHOLARSHIP_TYPES.push({ name: v.name, amount: +v.amount, budget_only: v.budget_only === "yes" }),
    rename: (i, to) => { const from = SCHOLARSHIP_TYPES[i].name; SCHOLARSHIP_TYPES[i].name = to; swapIn(students, "scholarships", from, to); swapIn(students, "scholarship_type", from, to); } }],
  ["Шкала баллов", "score_band", () => [["25–34", "удовлетворительно"], ["35–44", "хорошо"], ["45–54", "отлично"]]],
  ["Время пар", "pair_time", () => PAIRS.slice(1).map(([a, b], i) => [`${i + 1} пара`, `${a}–${b}`])],
  ["Аудитории", "classroom", () => CLASSROOMS.map(([n, c, k, pr]) => [n, `${c} мест · ${ROOM_KIND[k]}${pr ? " · проектор" : ""}`]), {
    names: () => CLASSROOMS.map(([n]) => n),
    fields: [{ name: "name", label: "Аудитория", hint: "корпус-номер, например В-310" }, { name: "capacity", label: "Мест", type: "number", min: 1 },
      { name: "kind", label: "Вид", type: "select", options: Object.entries(ROOM_KIND), def: "practice" },
      { name: "projector", label: "Проектор", type: "select", options: [["no", "Нет"], ["yes", "Есть"]], def: "no" }],
    check: (v) => ({ name: roomCheck(v.name) }), checkEdit: (to) => roomCheck(to),
    add: (v) => CLASSROOMS.push([v.name, +v.capacity, v.kind, v.projector === "yes"]),
    rename: (i, to) => { const from = CLASSROOMS[i][0]; CLASSROOMS[i][0] = to; swapIn(slots, "classroom", from, to); buildSchedule(); } }],
  ["Праздничные дни", "holiday", () => HOLIDAYS.map((d) => [fmtDate(d), HOLIDAY_NAMES[d] ?? "занятий нет"]), {
    // Значение праздника — дата; в строке меняется название
    names: () => HOLIDAYS.map((d) => HOLIDAY_NAMES[d] ?? ""), unique: () => HOLIDAYS, editField: "название",
    fields: [{ name: "date", label: "Дата", type: "date" }, { name: "name", label: "Название" }],
    check: (v) => ({ date: HOLIDAYS.includes(v.date) ? "Этот день уже праздничный" : undefined }),
    add: (v) => { HOLIDAYS.push(v.date); HOLIDAYS.sort(); HOLIDAY_NAMES[v.date] = v.name; buildSchedule(); },
    rename: (i, to) => { HOLIDAY_NAMES[HOLIDAYS[i]] = to; } }],
  ["Должности", "position", () => POSITIONS.filter(Boolean).map(([n, c]) => [n, CATEGORY_NAME[c]])],
];
PAGES.refs = () => pageView("refs", "Справочники", [`<div class="ref-grid">${REFS.map(([name, table, vals], i) => { const v = vals();
  return `<button type="button" class="card ref-card" data-a="ref-open" data-i="${i}" style="--i:${i}"><div><b>${name}</b><small>${table}</small></div>
    <span class="ref-n">${v.length}</span><p>${v.slice(0, 3).map(([x]) => esc(x)).join(" · ")}${v.length > 3 ? " …" : ""}</p></button>`; }).join("")}</div>`]);
function openRef(i) {
  const [name, table, vals, ed] = REFS[i];
  const blank = () => Object.fromEntries((ed?.fields ?? []).map((f) => [f.name, f.def ?? ""]));
  const m = { label: name, edit: null, editVal: "", adding: false, addV: blank(), errs: {} };
  const taken = (v, except) => (ed.unique?.() ?? ed.names()).some((x, k) => k !== except && x.toLowerCase() === v.toLowerCase());
  const errSmall = (k) => (m.errs[k] ? `<small class="field-error" role="alert">${esc(m.errs[k])}</small>` : "");
  const row = ([v, n], k) => (m.edit === k
    ? `<form class="ref-row ref-editing" data-ref-edit><div class="ref-edit-in${m.errs.edit ? " form-field invalid" : ""}"><input class="text-input" data-re value="${esc(m.editVal)}" aria-label="${ed.editField ? "Новое название" : "Новое значение"}">${errSmall("edit")}</div>
        <span class="ref-side"><button type="submit" class="icon-btn" aria-label="Сохранить">${icon("check")}</button><button type="button" class="icon-btn" data-a="re-cancel" aria-label="Отменить">${icon("x")}</button></span></form>`
    : `<div class="ref-row"><b>${esc(v)}</b><span class="ref-side">${n ? `<small>${esc(n)}</small>` : ""}${ed ? `<button type="button" class="icon-btn" data-a="re-edit" data-k="${k}" aria-label="Изменить «${esc(v)}»" title="Изменить">${icon("edit")}</button>` : ""}</span></div>`);
  const input = (f) => f.type === "select"
    ? `<select id="ra-${f.name}" class="select" data-ra="${f.name}">${f.options.map(([v, l]) => `<option value="${v}" ${m.addV[f.name] === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`
    : `<input id="ra-${f.name}" class="text-input" type="${f.type ?? "text"}" ${f.min != null ? `min="${f.min}"` : ""} data-ra="${f.name}" value="${esc(m.addV[f.name])}">`;
  m.html = () => `<div class="dialog form-dialog ref-dialog">
    <div class="form-head"><div><h3>${name}</h3><p>Таблица ${table} · ${vals().length} ${plural(vals().length, "значение", "значения", "значений")}</p></div><button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body">${ed ? "" : `<div class="form-note">Только просмотр — значения задаёт база</div>`}
      <div class="ref-list">${vals().map(row).join("")}</div>
      ${ed && m.adding ? `<form class="ref-add" data-ref-add novalidate><div class="form-grid">${ed.fields.map((f) => `<div class="field form-field${m.errs[f.name] ? " invalid" : ""}"><label for="ra-${f.name}">${f.label}</label>${input(f)}
          ${m.errs[f.name] ? errSmall(f.name) : f.hint ? `<small class="hint">${esc(f.hint)}</small>` : ""}</div>`).join("")}</div>
        <div class="ref-add-actions"><button type="button" class="btn sm" data-a="ra-cancel">Отменить</button><button class="btn sm primary">Добавить</button></div></form>`
      : ed ? `<div><button type="button" class="btn sm ghost" data-a="ra-open">${icon("plus")}Добавить значение</button></div>` : ""}</div></div>`;
  m.close = () => closeModal(m);
  m.click = (el) => {
    const a = el.dataset.a;
    if (a === "close") m.close();
    else if (a === "re-edit") { const k = +el.dataset.k; Object.assign(m, { edit: k, editVal: ed.names()[k], errs: {} }); render(); $(`[data-k="${m.key}"] [data-re]`)?.focus(); }
    else if (a === "re-cancel") { m.edit = null; m.errs = {}; render(); }
    else if (a === "ra-open") { Object.assign(m, { adding: true, addV: blank(), errs: {} }); render(); $(`[data-k="${m.key}"] [data-ra]`)?.focus(); }
    else if (a === "ra-cancel") { m.adding = false; m.errs = {}; render(); }
  };
  m.input = (el) => {
    if (el.dataset.re != null) { m.editVal = el.value; delete m.errs.edit; render(); }
    else if (el.dataset.ra) { m.addV[el.dataset.ra] = el.value; delete m.errs[el.dataset.ra]; render(); }
  };
  m.change = m.input;
  m.submit = (e) => {
    if (e.target.dataset.refEdit != null) {
      const k = m.edit, from = ed.names()[k], to = clip(m.editVal);
      m.errs = { edit: !to ? "Заполните поле" : to.length > 150 ? "Не длиннее 150 символов" : !ed.editField && taken(to, k) ? "Такое значение уже есть" : ed.checkEdit?.(to) };
      if (m.errs.edit) return render();
      if (to !== from) { ed.rename(k, to); logAudit("Справочник", "UPDATE", `${table} · ${to}`, `${ed.editField ? "Название" : "Значение"}: ${from || "—"} → ${to}`); toast("Значение изменено"); }
      m.edit = null; m.errs = {}; return render();
    }
    if (e.target.dataset.refAdd != null) {
      const v = Object.fromEntries(Object.entries(m.addV).map(([k, x]) => [k, clip(x)]));
      const errs = {};
      ed.fields.forEach((f) => {
        if (!v[f.name]) errs[f.name] = "Заполните поле";
        else if (f.type === "number" && !(Number.isInteger(+v[f.name]) && +v[f.name] >= f.min)) errs[f.name] = f.min ? `Целое число от ${f.min}` : "Целое число, не меньше 0";
      });
      if (!errs.name && v.name && !ed.unique && taken(v.name)) errs.name = "Такое значение уже есть";
      Object.entries(ed.check?.(v) ?? {}).forEach(([k, x]) => { if (x && !errs[k]) errs[k] = x; });
      m.errs = Object.fromEntries(Object.entries(errs).filter(([, x]) => x));
      if (Object.keys(m.errs).length) return render();
      ed.add(v);
      logAudit("Справочник", "INSERT", `${table} · ${v.name}`, ed.fields.filter((f) => f.name !== "name").map((f) => `${f.label}: ${f.type === "select" ? Object.fromEntries(f.options)[v[f.name]] : v[f.name]}`).join("; ") || "Новое значение");
      m.adding = false; m.errs = {}; toast("Значение добавлено"); return render();
    }
  };
  return openModal(m);
}
const AUDIT_COLS = [
  { label: "Когда", field: "at", filter: "date", text: (r) => fmtDateTime(r.at) },
  { label: "Кто", field: "user", filter: "enum", bold: true },
  { label: "Роль", field: "role", filter: "enum" },
  { label: "Таблица", field: "table", filter: "enum" },
  { label: "Действие", field: (r) => ACTION_NAME[r.action], filter: "enum", badge: true, render: (r) => badge(ACTION_NAME[r.action], { INSERT: "ok", UPDATE: "info", DELETE: "bad" }[r.action]) },
  { label: "Запись", field: "record", filter: "text", className: "wrap-sm" },
  { label: "Что изменено", field: "changes", filter: "text", className: "wrap" },
  { label: "Источник", field: "source", filter: "enum", badge: true, render: (r) => badge(r.source, r.source === "Чат-агент" ? "warn" : "muted") },
];
PAGES.audit = () => {
  const rows = applyTable("audit", AUDIT_COLS, AUDIT);
  return pageView("audit", "Журнал изменений", [
    `<p class="stat-line"><span>Сегодня <b>${AUDIT.filter((a) => a.at.startsWith(TODAY)).length}</b></span><span>Через чат-агента <b>${AUDIT.filter((a) => a.source === "Чат-агент").length}</b></span><span>Всего <b>${AUDIT.length}</b></span></p>`,
    tableTools("audit", AUDIT_COLS, AUDIT, rows.length), dataTable("audit", AUDIT_COLS, rows, AUDIT, { rowKey: (r) => r.id })]);
};

/* ═════════ ЧАТ: агент работает в пределах роли ═════════ */
const replyBase = reply;
reply = (raw) => {
  const s = norm(raw);
  if (ROLE === "student") {
    // Заказ справки: начать («закажи справку…») или продолжить начатый разговор, если ответ похож на уточнение
    const draft = DOC_DRAFTS.get(chat.activeId);
    if (/справк/.test(s) && /(закаж|заказ|оформ|нужн|сделай|хочу|получ)/.test(s)) return docOrderReply(raw, s);
    if (draft && (/(отмен|не надо|передума|не нужн)/.test(s) || Object.keys(docParse(s, draft)).length)) return docOrderReply(raw, s);
    if (draft) DOC_DRAFTS.delete(chat.activeId);
    if (CHANGE_WORDS.test(s) && !/справк/.test(s)) return { html: P("Изменять данные через чат может только сотрудник деканата или преподаватель. Я могу подсказать ваше расписание, оценки, долги и статус справок.") + `<p class="hint">Код ${codeTag("AG-01")} — нет прав на это действие</p>` };
    if (/справк|заявк/.test(s)) { const rs = requests.filter((r) => r.student_id === ME.student_id);
      return q(rs.length ? P("Ваши заявки на справки:") + mdTable(["№", "Документ", "Статус", "Готова к"], rs.map((r) => [r.request_id, esc(r.document), r.status, fmtDate(r.due_date)])) : P("Заявок на справки у вас нет. Заказать справку можно во вкладке «Справки».")); }
    if (/долг|задолж|пересда/.test(s)) { const ds = debtors.filter((d) => d.student_id === ME.student_id);
      return q(ds.length ? P(`У вас ${ds.length} ${plural(ds.length, "долг", "долга", "долгов")}:`) + mdTable(["Дисциплина", "Семестр", "Результат", "Попыток"], ds.map((d) => [esc(d.discipline), d.semester, d.last_result, d.attempts])) : P("Долгов у вас нет.")); }
    if (/оценк|балл|успеваем|модул/.test(s)) return q(P(`Средний балл — <b>${String(ME.avg_points).replace(".", ",")}</b>, категория — «${esc(ME.category)}». Баллы по модулям текущего семестра — во вкладке «Успеваемость».`));
    if (/распис|пар[аыу]?([^а-я]|$)|занят/.test(s)) return scheduleReply(s, ME.group_name);
    return { html: P("Я отвечаю на вопросы о вашей учёбе: расписание, оценки, долги, справки. Например: «какие пары завтра?» или «какие у меня долги?»") };
  }
  // Администратор отвечает за пользователей и справочники; учебные данные меняют деканат и преподаватели
  if (ROLE === "admin" && CHANGE_WORDS.test(s)) return { html: P("Учебные данные — заявки, оценки, студентов, расписание — меняют сотрудники деканата и преподаватели. Пользователей и справочники вы можете изменить во вкладках «Доступ» и «Списки». Спросить о данных можно и здесь, например: «сколько просроченных заявок?»") + `<p class="hint">Код ${codeTag("AG-01")} — нет прав на это действие</p>` };
  if (ROLE === "teacher") {
    // Исправление баллов в своих открытых ведомостях — через окно подтверждения, как у деканата
    if (CHANGE_WORDS.test(s)) {
      const pts = raw.match(/(\d{1,2})\s*(балл|$|\s)/)?.[1];
      const open = sheets.filter((sh) => sh.examiner === ME.full_name && sh.status === "Открыта");
      const people = findPeople(students, (x) => x.student, raw).filter((st) => open.some((sh) => sh.rows.some((r) => r.student_id === st.student_id)));
      if (!people.length || pts == null) return { html: P(`Могу исправить баллы в ваших открытых ведомостях. Напишите, кому и сколько, например: «исправь баллы: ${esc((open[0]?.rows[0]?.student ?? "Иванов").split(" ")[0])}, 38». Остальные данные меняет деканат.`) };
      const st = people[0], sh = open.find((x) => x.rows.some((r) => r.student_id === st.student_id) && norm(raw).includes(norm(x.discipline).slice(0, 6))) ?? open.find((x) => x.rows.some((r) => r.student_id === st.student_id));
      const row = sh.rows.find((r) => r.student_id === st.student_id);
      if (+pts > 54) return { html: P("Баллов не может быть больше 54.") };
      return { tool: "propose_sql_change", html: P(`Подготовил исправление в ведомости ${sh.sheet_number} (${esc(sh.discipline)}, ${STAGE_NAME[sh.stage]}). Проверьте и примените.`),
        proposal: { explanation: `${shortName(st.student)}: ${pts} баллов · ${sh.discipline}`, reason: `Запрос преподавателя: «${raw.trim()}»`, table: "Ведомость", operation: "UPDATE",
          rows: [{ label: "Баллы", before: row.points, after: +pts }], effects: [], apply: () => { row.points = +pts; row.absent = false; } } };
    }
    if (/ведомост/.test(s)) { const open = sheets.filter((sh) => sh.examiner === ME.full_name && sh.status === "Открыта");
      return q(P(`Открытых ведомостей: ${open.length}.`) + mdTable(["Ведомость", "Группа", "Дисциплина", "Заполнено"], open.map((sh) => [sh.sheet_number, sh.group_name, esc(sh.discipline), `${filled(sh)} из ${sh.rows.length}`]))); }
    if (/распис|пар[аыу]?([^а-я]|$)|занят/.test(s)) { const d = dateIn(s) || TODAY, ls = schedule.filter((l) => l.teacher === ME.full_name && l.lesson_date === d);
      return q(ls.length ? P(`Ваши занятия ${fmtDate(d)}:`) + mdTable(["Пара", "Дисциплина", "Группа", "Аудитория"], ls.map((l) => [`${l.pair_number} (${l.start_time})`, esc(l.discipline), l.group_name, l.classroom])) : P(`${fmtDate(d)} занятий у вас нет.`)); }
    const g = groupIn(raw);
    if (g && !myGroups().includes(g)) return { html: P(`Вы не ведёте занятия у <b>${esc(g)}</b> — данные этой группы вам недоступны.`) + `<p class="hint">Код ${codeTag("AG-01")} — нет доступа к данным</p>` };
    return replyBase(raw);
  }
  return replyBase(raw);
};

/* ═════════ ДЕЙСТВИЯ ═════════ */
Object.assign(ACT, {
  "att-week": (el) => { att.date = el.dataset.v; render(); },
  "att-lesson": (el) => openAttendance(schedule.find((x) => lessonKey(x) === el.dataset.k)),
  "order-doc": () => orderDoc(),
  "ref-open": (el) => openRef(+el.dataset.i),
  services: () => openServices(),
});
// Выпадающие списки на страницах ролей
document.addEventListener("change", (e) => {
  const d = e.target.dataset;
  if (d.gradesSem != null) { myGrades.sem = e.target.value; render(); }
});

{ const u = users.find((x) => x.login === auth.login);
  if (auth.on && u?.active && !u.mustChange) applyRole(u.role, personOf(u), u.login); else if (auth.on) { auth.on = false; try { sessionStorage.removeItem("deanery.mock.session"); } catch { /* нет доступа */ } } }
render();
