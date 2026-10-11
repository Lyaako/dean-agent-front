/* ═════════ РОЛИ ═════════
   Пять ролей из app_role. От роли зависят: кто вошёл (ME), набор вкладок, что видно и что можно править, что умеет агент в чате.
   Куратор и староста — не роли, а надстройки (study_group.curator_id / headman_id). Загружается после chat.js. */

const ROLES = {
  dean_staff: { name: "Сотрудник деканата", login: "kuznetsova.ep", tabs: ["students", "groups", "schedule", "sheets", "works", "requests", "practice", "employees", "olap"] },
  director: { name: "Директор института", login: "smirnov.av", tabs: ["olap", "students", "groups", "schedule", "sheets", "works", "practice", "employees"] },
  teacher: { name: "Преподаватель", login: "", tabs: ["schedule", "sheets", "attendance", "mystudents", "myworks"] },
  student: { name: "Студент", login: "", tabs: ["schedule", "grades", "myattendance", "myrequests", "mystudy"] },
  admin: { name: "Администратор", login: "admin", tabs: ["users", "refs", "audit", "employees"] },
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
  if (!u || password !== MOCK_PASSWORD) { auth.error = "Неверный логин или пароль"; return render(); }
  if (!u.active) { auth.error = "Доступ отключён. Обратитесь в деканат или к администратору"; return render(); }
  u.last = TODAY;
  auth.on = true;
  applyRole(u.role, personOf(u), u.login);
  try { sessionStorage.setItem("deanery.mock.session", JSON.stringify({ login })); } catch { /* нет доступа */ }
  render();
};

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
const addSheet = (o) => sheets.push({ sheet_id: sheets.length + 1, sheet_number: `В-${String(1000 + sheets.length)}`, ...o });
GROUPS.forEach((g) => {
  const roster = students.filter((s) => s.group_name === g.name && s.status !== "Отчислен");
  // Последняя сессия: основная ведомость закрыта; несдавшие — в ведомости пересдачи
  const sem = doneSemesters(g.year);
  if (sem) CURRICULUM.filter(([, s]) => s === sem).forEach(([discipline, , control_type]) => {
    const rs = results.filter((r) => r.group_name === g.name && r.discipline === discipline && r.semester === sem);
    if (!rs.length) return;
    const examiner = examinerOf(g.name, discipline, sem);
    addSheet({ group_name: g.name, discipline, semester: sem, control_type, stage: "final", kind: "Основная", examiner, exam_date: "2026-06-" + String(15 + Math.floor(h01(discipline) * 12)).padStart(2, "0"), status: "Закрыта",
      rows: rs.map((r) => ({ student_id: r.student_id, student: r.student, points: failedFirst(r) ? null : r.points, absent: failedFirst(r) && h01(`abs|${r.student_id}|${discipline}`) < 0.3 })) });
    const failed = rs.filter(failedFirst);
    if (failed.length) addSheet({ group_name: g.name, discipline, semester: sem, control_type, stage: "final", kind: "Пересдача", examiner, exam_date: failed.every((r) => r.points != null) ? "2026-09-18" : null,
      status: failed.every((r) => r.points != null) ? "Закрыта" : "Открыта", rows: failed.map((r) => ({ student_id: r.student_id, student: r.student, points: r.points, absent: false })) });
  });
  // Текущий семестр: модуль 1 сдан и закрыт, модуль 2 — открыт, баллы выставляет преподаватель
  if (!roster.some((s) => s.status === ACTIVE)) return;
  const cur = course(g.year) * 2 - 1;
  curDisc(g).forEach((discipline) => {
    const control_type = CURRICULUM.find(([d, s]) => d === discipline && s === cur)?.[2] ?? "Экзамен";
    const examiner = examinerOf(g.name, discipline, cur);
    const active = roster.filter((s) => s.status === ACTIVE);
    addSheet({ group_name: g.name, discipline, semester: cur, control_type, stage: "module_1", kind: "Основная", examiner, exam_date: "2026-10-0" + (1 + Math.floor(h01(discipline + g.name) * 8)), status: "Закрыта",
      rows: active.map((s) => ({ student_id: s.student_id, student: s.student, points: modules.find((m) => m.student_id === s.student_id && m.discipline === discipline)?.points ?? null, absent: false })) });
    addSheet({ group_name: g.name, discipline, semester: cur, control_type, stage: "module_2", kind: "Основная", examiner, exam_date: null, status: "Открыта",
      rows: active.map((s) => ({ student_id: s.student_id, student: s.student, points: null, absent: false })) });
  });
});
const canEditSheet = (sh) => sh.status === "Открыта" && (ROLE === "teacher" ? sh.examiner === ME.full_name : ["dean_staff", "director"].includes(ROLE));
const resultText = (sh, p, absent) => {
  if (absent) return ["Неявка", "bad"];
  if (p == null || p === "") return ["—", ""];
  if (sh.stage !== "final") return +p >= 25 ? ["Аттестован", "ok"] : ["Не аттестован", "bad"];
  if (!isGraded(sh.control_type)) return +p >= 25 ? ["Зачтено", "ok"] : ["Не зачтено", "bad"];
  return [["Неудовлетворительно", "Неудовлетворительно", "Неудовлетворительно", "Удовлетворительно", "Хорошо", "Отлично"][mark(+p) ?? 0], mark(+p) === 5 ? "ok" : mark(+p) ? "info" : "bad"];
};
const filled = (sh) => sh.rows.filter((r) => r.points != null || r.absent).length;
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
function openSheet(sh) {
  const edit = canEditSheet(sh);
  const m = { label: `Ведомость ${sh.sheet_number}`, draft: sh.rows.map((r) => ({ ...r })), err: null, busy: false };
  const dirty = () => m.draft.some((r, i) => r.points !== sh.rows[i].points || r.absent !== sh.rows[i].absent);
  m.html = () => `<div class="dialog form-dialog sheet-dialog">
    <div class="form-head"><div><h3>${esc(sh.discipline)}</h3><p>${sh.group_name} · ${sh.semester} семестр · ${STAGE_NAME[sh.stage]} · ${sh.kind.toLowerCase()} ведомость ${sh.sheet_number}</p></div>
      <button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body">
      <div class="sheet-meta">${badge(sh.status, sh.status === "Открыта" ? "warn" : "muted")}<span>${icon("users")}${esc(sh.examiner)}</span><span>${icon("calendar")}${sh.exam_date ? fmtDate(sh.exam_date) : "дата не назначена"}</span><span>${esc(sh.control_type)}</span></div>
      ${!edit && sh.status === "Открыта" && ROLE === "teacher" ? `<div class="form-note">Ведомость ведёт ${esc(sh.examiner)} — вы можете только посмотреть.</div>` : ""}
      <table class="sheet-table"><thead><tr><th>Студент</th><th>Баллы</th><th>Неявка</th><th>Результат</th></tr></thead><tbody>
      ${m.draft.map((r, i) => { const [t, k] = resultText(sh, r.points, r.absent);
        return `<tr data-k="${r.student_id}"><td>${esc(r.student)}</td>
          <td>${edit ? `<input class="text-input pts" type="number" min="0" max="54" inputmode="numeric" data-pts="${i}" value="${r.points ?? ""}" ${r.absent || m.busy ? "disabled" : ""} aria-label="Баллы: ${esc(r.student)}">` : r.points ?? "—"}</td>
          <td>${edit ? `<input type="checkbox" data-abs="${i}" ${r.absent ? "checked" : ""} ${m.busy ? "disabled" : ""} aria-label="Неявка: ${esc(r.student)}">` : r.absent ? "да" : "—"}</td>
          <td>${k ? badge(t, k) : t}</td></tr>`; }).join("")}</tbody></table>
      ${m.err ? `<p class="form-error" role="alert">${esc(m.err)}</p>` : ""}
      <p class="hint">${sh.stage === "final" ? "Шкала: 25–34 — удовлетворительно, 35–44 — хорошо, 45–54 — отлично." : "Меньше 25 баллов — «не аттестован»."}</p>
    </div>
    <div class="actions">${["dean_staff", "director"].includes(ROLE) && sh.status === "Закрыта" ? `<button type="button" class="btn sm ghost" data-a="reopen">${icon("refresh")}Открыть заново</button>` : ""}
      <span class="spacer"></span><button type="button" class="btn" data-a="close">${edit ? "Отменить" : "Закрыть"}</button>
      ${edit && ["dean_staff", "director"].includes(ROLE) ? `<button type="button" class="btn" data-a="close-sheet" ${m.busy ? "disabled" : ""}>Закрыть ведомость</button>` : ""}
      ${edit ? `<button type="button" class="btn primary" data-a="save" ${m.busy || !dirty() ? "disabled" : ""}>${m.busy ? "Сохраняем…" : "Сохранить"}</button>` : ""}</div></div>`;
  const save = async (closeIt) => {
    if (m.draft.some((r) => r.points != null && (r.points < 0 || r.points > 54))) { m.err = "Баллы — от 0 до 54"; return render(); }
    if (closeIt && m.draft.some((r) => r.points == null && !r.absent)) { m.err = "Чтобы закрыть ведомость, выставьте баллы или неявку всем студентам"; return render(); }
    m.busy = true; m.err = null; render();
    await wait(450);
    const n = m.draft.filter((r, i) => r.points !== sh.rows[i].points || r.absent !== sh.rows[i].absent).length;
    sh.rows = m.draft.map((r) => ({ ...r }));
    if (closeIt) Object.assign(sh, { status: "Закрыта", exam_date: sh.exam_date ?? TODAY });
    logAudit("Ведомость", "UPDATE", `${STAGE_NAME[sh.stage]} · ${sh.discipline} · ${sh.group_name}`, closeIt ? "Ведомость закрыта" : `Баллы: ${n} ${plural(n, "студент", "студента", "студентов")}`);
    closeModal(m); toast(closeIt ? "Ведомость закрыта" : "Баллы сохранены");
  };
  m.close = () => closeModal(m);
  m.click = (el) => {
    const a = el.dataset.a;
    if (a === "close") m.close();
    else if (a === "save") save(false);
    else if (a === "close-sheet") save(true);
    else if (a === "reopen") { sh.status = "Открыта"; logAudit("Ведомость", "UPDATE", `${STAGE_NAME[sh.stage]} · ${sh.discipline} · ${sh.group_name}`, "Ведомость открыта заново"); closeModal(m); openSheet(sh); }
  };
  m.input = (el) => {
    if (el.dataset.pts == null) return;
    const v = el.value.trim();
    m.draft[+el.dataset.pts].points = v === "" ? null : Math.round(Number(v));
    m.err = null; render();
  };
  m.change = (el) => { if (el.dataset.abs != null) { const r = m.draft[+el.dataset.abs]; r.absent = el.checked; if (el.checked) r.points = null; render(); } };
  return openModal(m);
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
    return `<button type="button" class="lesson ${l.lesson_type === "Лекция" ? "lec" : "prac"}${future ? " future" : ""}" ${future ? "disabled" : `data-a="att-open" data-k="${esc(lessonKey(l))}"`}>
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
const markName = (r) => (r.points == null ? "Долг" : !isGraded(r.control_type) ? "Зачтено" : ["", "", "", "Удовлетворительно", "Хорошо", "Отлично"][mark(r.points)]);
const myGrades = { sem: "cur" };
PAGES.grades = () => {
  const s = ME, done = doneSemesters(groupOf(s.group_name).year), cur = s.course * 2 - 1;
  const mySheets = sheets.filter((sh) => sh.group_name === s.group_name && sh.semester === cur);
  const curDiscs = [...new Set(mySheets.map((sh) => sh.discipline))];
  const ptsOf = (d, stage) => mySheets.find((sh) => sh.discipline === d && sh.stage === stage)?.rows.find((r) => r.student_id === s.student_id);
  const cell = (r) => (!r ? "—" : r.absent ? badge("Неявка", "bad") : r.points == null ? `<span class="muted">ещё нет</span>` : r.points < 25 ? `<span class="neg">${r.points}</span>` : String(r.points));
  const sems = Array.from({ length: done }, (_, i) => done - i);
  const pick = myGrades.sem === "cur" || !sems.includes(+myGrades.sem) ? "cur" : +myGrades.sem;
  const past = pick === "cur" ? [] : results.filter((r) => r.student_id === s.student_id && r.semester === pick);
  const myDebts = debtors.filter((d) => d.student_id === s.student_id);
  const table = pick === "cur"
    ? `<table class="sheet-table grades"><thead><tr><th>Дисциплина</th><th>Модуль 1</th><th>Модуль 2</th><th>Итог</th></tr></thead><tbody>${curDiscs.map((d) =>
        `<tr><td>${esc(d)}</td><td>${cell(ptsOf(d, "module_1"))}</td><td>${cell(ptsOf(d, "module_2"))}</td><td><span class="muted">в сессию</span></td></tr>`).join("")}</tbody></table>`
    : `<table class="sheet-table grades"><thead><tr><th>Дисциплина</th><th>Контроль</th><th>Баллы</th><th>Оценка</th><th>Сдано</th></tr></thead><tbody>${past.map((r) =>
        `<tr><td>${esc(r.discipline)}</td><td>${esc(r.control_type)}</td><td>${r.points ?? "—"}</td><td>${badge(markName(r), r.points == null ? "bad" : mark(r.points) === 5 ? "ok" : mark(r.points) === 3 ? "warn" : "info")}</td>
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
    all.length ? dataTable("myrequests", MYREQ_COLS, rows, all, { rowKey: (r) => r.request_id })
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
      <div class="field form-field"><label for="od-copies">Экземпляров</label><select id="od-copies" class="select" data-od="copies">${[1, 2, 3, 4, 5].map((n) => `<option ${String(n) === m.v.copies ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      <div class="field form-field"><label for="od-purpose">Куда</label><select id="od-purpose" class="select" data-od="purpose">${PURPOSES.map((p) => `<option ${p === m.v.purpose ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></div>
    </div></div>
    <div class="actions"><span class="spacer"></span><button type="button" class="btn" data-a="close">Отменить</button><button class="btn primary" ${m.busy ? "disabled" : ""}>${m.busy ? "Отправляем…" : "Заказать"}</button></div></form>`;
  m.close = () => closeModal(m);
  m.click = (el) => { if (el.dataset.a === "close") m.close(); };
  m.change = (el) => { if (el.dataset.od) { m.v[el.dataset.od] = el.value; render(); } };
  m.submit = async () => {
    m.busy = true; render(); await wait(450);
    const id = Math.max(...requests.map((r) => r.request_id)) + 1;
    requests.push({ request_id: id, student_id: ME.student_id, student: ME.student, group_name: ME.group_name, document: m.v.document, copies: +m.v.copies, purpose: m.v.purpose,
      status: "Новая", created_at: `${TODAY} ${new Date().toTimeString().slice(0, 5)}`, due_date: addDays(TODAY, days()), processed_by: null });
    logAudit("Заявка на справку", "INSERT", `Заявка № ${id}`, `${m.v.document}, ${m.v.copies} экз.`);
    closeModal(m); toast(`Заявка № ${id} отправлена в деканат`);
  };
  return openModal(m);
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
    kvCard("Стипендия", [["Сейчас", s.scholarships ? esc(s.scholarships) : "Не назначена"], ["Основа обучения", s.funding], ["Почему", s.scholarships ? "сессия сдана на «хорошо» и «отлично»" : s.funding === "Договор" ? "академическая стипендия — только на бюджете" : "нужно сдать сессию без троек и долгов"]]),
    `<section class="card"><div class="table-head"><h2>Приказы обо мне</h2></div>${mv.length ? `<div class="miss-list">${mv.map((x) =>
      `<div class="miss-row"><b>${fmtDate(x.order_date)}</b><span>${esc(x.order_number)}</span><span>${esc(x.order_type)}</span></div>`).join("")}</div>` : `<p class="olap-foot">Приказов о вас за последний год не было.</p>`}</section>`]);
};

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
function openUser(u) {
  const m = { label: u.login, v: { role: u.role, active: u.active }, busy: false };
  m.html = () => `<form class="dialog form-dialog" data-user novalidate>
    <div class="form-head"><div><h3>${esc(u.login)}</h3><p>${esc(u.person)}</p></div><button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body"><div class="form-grid">
      <div class="field form-field"><label for="u-role">Роль</label><select id="u-role" class="select" data-u="role" ${u.role === "student" ? "disabled" : ""}>${ROLE_ORDER.filter((r) => r !== "student" || u.role === "student").map((r) => `<option value="${r}" ${r === m.v.role ? "selected" : ""}>${ROLES[r].name}</option>`).join("")}</select>
        ${u.role === "student" ? `<small class="hint">Роль студента задаётся записью студента</small>` : ""}</div>
      <label class="check form-check"><input type="checkbox" data-u="active" ${m.v.active ? "checked" : ""}><span>Доступ разрешён</span></label>
    </div><div><button type="button" class="btn sm ghost" data-a="reset-pw">${icon("refresh")}Сбросить пароль</button></div></div>
    <div class="actions"><span class="spacer"></span><button type="button" class="btn" data-a="close">Отменить</button><button class="btn primary" ${m.busy ? "disabled" : ""}>${m.busy ? "Сохраняем…" : "Сохранить"}</button></div></form>`;
  m.close = () => closeModal(m);
  m.click = (el) => {
    if (el.dataset.a === "close") m.close();
    if (el.dataset.a === "reset-pw") { logAudit("Пользователь", "UPDATE", u.login, "Пароль сброшен"); toast("Временный пароль отправлен на почту пользователя"); }
  };
  m.change = (el) => { if (el.dataset.u) m.v[el.dataset.u] = el.type === "checkbox" ? el.checked : el.value; };
  m.submit = async () => {
    const ch = [m.v.role !== u.role && `Роль: ${ROLES[u.role].name} → ${ROLES[m.v.role].name}`, m.v.active !== u.active && `Доступ: ${u.active ? "разрешён" : "запрещён"} → ${m.v.active ? "разрешён" : "запрещён"}`].filter(Boolean);
    if (!ch.length) return closeModal(m);
    m.busy = true; render(); await wait(400);
    Object.assign(u, m.v); logAudit("Пользователь", "UPDATE", u.login, ch.join("; "));
    closeModal(m); toast("Пользователь сохранён");
  };
  return openModal(m);
}
// Справочники: название, значения и (где есть) пояснение
const REFS = [
  ["Виды справок", "document_type", () => DOC_TYPES.map(([d, n]) => [d, `${n} ${plural(n, "день", "дня", "дней")} на подготовку`])],
  ["Статусы заявок", "request_status", () => REQUEST_STATUSES.map((s) => [s, FINAL_STATUS.includes(s) ? "завершающий" : ""])],
  ["Основы обучения", "funding_type", () => FUNDING.map((f) => [f, ""])],
  ["Причины академического отпуска", "leave_reason", () => LEAVE_REASONS.map((r) => [r, ""])],
  ["Виды приказов", "order_type", () => MOVE_TYPES.map(([, n]) => [n, ""])],
  ["Виды стипендий", "scholarship_type", () => [["Государственная академическая", "оценки «хорошо» и «отлично»"], ["Повышенная государственная академическая", "только «отлично»"], ["Социальная", "по документам"]]],
  ["Шкала баллов", "score_band", () => [["0–24", "неудовлетворительно / не аттестован"], ["25–34", "удовлетворительно"], ["35–44", "хорошо"], ["45–54", "отлично"]]],
  ["Время пар", "pair_time", () => PAIRS.slice(1).map(([a, b], i) => [`${i + 1} пара`, `${a}–${b}`])],
  ["Аудитории", "classroom", () => CLASSROOMS.map(([n, c, k]) => [n, `${c} мест · ${{ lecture: "лекционная", computer: "компьютерный класс", lab: "лаборатория", practice: "для практик" }[k]}`])],
  ["Праздничные дни", "holiday", () => HOLIDAYS.map((d) => [fmtDate(d), "занятий нет"])],
  ["Должности", "position", () => POSITIONS.filter(Boolean).map(([n, c]) => [n, CATEGORY_NAME[c]])],
];
PAGES.refs = () => pageView("refs", "Справочники", [`<div class="ref-grid">${REFS.map(([name, table, vals], i) => { const v = vals();
  return `<button type="button" class="card ref-card" data-a="ref-open" data-i="${i}" style="--i:${i}"><div><b>${name}</b><small>${table}</small></div>
    <span class="ref-n">${v.length}</span><p>${v.slice(0, 3).map(([x]) => esc(x)).join(" · ")}${v.length > 3 ? " …" : ""}</p></button>`; }).join("")}</div>`]);
function openRef(i) {
  const [name, table, vals] = REFS[i];
  const m = { label: name, add: "" };
  m.html = () => `<div class="dialog form-dialog ref-dialog">
    <div class="form-head"><div><h3>${name}</h3><p>Таблица ${table} · ${vals().length} ${plural(vals().length, "значение", "значения", "значений")}</p></div><button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body"><div class="ref-list">${vals().map(([v, n]) => `<div class="ref-row"><b>${esc(v)}</b>${n ? `<small>${esc(n)}</small>` : ""}</div>`).join("")}</div></div></div>`;
  m.close = () => closeModal(m);
  m.click = (el) => { if (el.dataset.a === "close") m.close(); };
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
  "att-open": (el) => openAttendance(schedule.find((x) => lessonKey(x) === el.dataset.k)),
  "order-doc": () => orderDoc(),
  "ref-open": (el) => openRef(+el.dataset.i),
});
// Выпадающие списки на страницах ролей
document.addEventListener("change", (e) => {
  const d = e.target.dataset;
  if (d.gradesSem != null) { myGrades.sem = e.target.value; render(); }
});

{ const u = users.find((x) => x.login === auth.login);
  if (auth.on && u?.active) applyRole(u.role, personOf(u), u.login); else if (auth.on) { auth.on = false; try { sessionStorage.removeItem("deanery.mock.session"); } catch { /* нет доступа */ } } }
render();
