const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, REDUCED ? 0 : ms));
const EASE = "cubic-bezier(.22, 1, .36, 1)";
/* ═════════ ДАННЫЕ ═════════
   Строки выдуманы, но структура — как в БД «Деканат» (deanery_db/): поля = колонки представлений
   из 02_views_functions.sql, справочники и допустимые значения — из 03_seed.sql. */

// Детерминированный генератор, чтобы данные не менялись при перезагрузке
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const iso = (d) => d.toISOString().slice(0, 10);
const D = (s) => new Date(s + "T00:00:00Z");
const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const mondayOf = (s) => addDays(s, -((D(s).getUTCDay() + 6) % 7));
// Сегодня — как во фронте, по часам компьютера
const TODAY = (() => { const d = new Date(); return iso(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))); })();
const TERM_FIRST = "2026-09-01", TERM_LAST = "2026-12-20";
const TERM_MONDAY = mondayOf(TERM_FIRST);
const weekNo = (s) => Math.round((D(mondayOf(s)) - D(TERM_MONDAY)) / 6048e5) + 1;

/* ── Справочники (03_seed.sql) ── */
// study_group → curriculum → study_program → specialty: эти пять групп учатся по программе 1
const PROGRAM = { spec: "09.03.04 Программная инженерия", profile: "Системный анализ и проектирование программных комплексов", form: "Очная" };
const GROUPS = [
  { name: "ИДБ-23-11", year: 2023, curator: null },
  { name: "ИДБ-23-12", year: 2023, curator: null },
  { name: "ИДБ-24-11", year: 2024, curator: null },
  { name: "ИДБ-24-12", year: 2024, curator: null },
  { name: "ИДБ-25-11", year: 2025, curator: "Соколов Алексей Михайлович" },
].map((g) => ({ ...PROGRAM, ...g }));
// curriculum_item учебного плана программы 1: [дисциплина, семестр, форма контроля]
const CURRICULUM = [
  ["Математический анализ", 1, "Экзамен"], ["Линейная алгебра и аналитическая геометрия", 1, "Экзамен"], ["Основы программирования", 1, "Экзамен"],
  ["Информатика", 1, "Зачёт"], ["Иностранный язык", 1, "Зачёт"], ["Введение в профессиональную деятельность", 1, "Зачёт"],
  ["Математический анализ", 2, "Экзамен"], ["Дискретная математика", 2, "Экзамен"], ["Объектно-ориентированное программирование", 2, "Экзамен"],
  ["Иностранный язык", 2, "Зачёт"], ["Математическая логика и теория алгоритмов", 2, "Зачёт"], ["Компьютерная графика", 2, "Дифференцированный зачёт"],
  ["Учебная практика", 2, "Дифференцированный зачёт"],
  ["Теория вероятностей и математическая статистика", 3, "Экзамен"], ["Алгоритмы и структуры данных", 3, "Экзамен"], ["Иностранный язык", 3, "Зачёт"],
  ["Архитектура вычислительных систем", 3, "Экзамен"], ["Теория графов", 3, "Зачёт"], ["Технологии программирования", 3, "Дифференцированный зачёт"],
  ["Базы данных", 4, "Экзамен"], ["Операционные системы", 4, "Экзамен"], ["Компьютерные сети", 4, "Зачёт"], ["Иностранный язык", 4, "Зачёт"],
  ["Системное программирование", 4, "Дифференцированный зачёт"],
  ["Веб-технологии", 5, "Дифференцированный зачёт"], ["Информационная безопасность", 5, "Зачёт"], ["Параллельное программирование", 5, "Экзамен"],
  ["Человеко-машинное взаимодействие", 5, "Зачёт"], ["Проектирование и архитектура программных систем", 5, "Экзамен"],
  ["Курсовая работа по проектированию программных систем", 5, "Курсовая работа"],
  ["Машинное обучение", 6, "Экзамен"], ["Проектирование информационных систем", 6, "Экзамен"], ["Облачные технологии", 6, "Зачёт"],
  ["Интернет вещей", 6, "Дифференцированный зачёт"], ["Производственная практика", 6, "Дифференцированный зачёт"], ["Тестирование программного обеспечения", 6, "Экзамен"],
  ["Системы искусственного интеллекта", 7, "Экзамен"], ["Управление программными проектами", 7, "Зачёт"], ["Распределённые системы обработки данных", 7, "Экзамен"],
  ["DevOps и непрерывная интеграция", 7, "Дифференцированный зачёт"], ["Методы и средства разработки программных комплексов", 7, "Экзамен"],
  ["Преддипломная практика", 8, "Дифференцированный зачёт"], ["Выполнение и защита ВКР", 8, "Защита ВКР"],
];
const course = (year) => 2026 - year + 1;           // fn_course: текущий семестр — 2026/27, осенний
const doneSemesters = (year) => (course(year) - 1) * 2;
const isGraded = (ct) => ct !== "Зачёт";            // control_type.is_graded
const mark = (p) => p >= 45 ? 5 : p >= 35 ? 4 : p >= 25 ? 3 : null;   // score_band

const M_LAST = ["Орлов", "Ганиев", "Ковалёв", "Смирнов", "Белов", "Лаптев", "Петров", "Зайцев", "Морозов", "Волков", "Соловьёв", "Козлов", "Фёдоров", "Карпов", "Тихонов"];
const M_FIRST = ["Денис", "Тимур", "Максим", "Артём", "Кирилл", "Сергей", "Илья", "Никита", "Егор", "Иван", "Роман", "Глеб"];
const F_FIRST = ["Алина", "Ксения", "Дарья", "Анна", "Мария", "Полина", "Вера", "Софья", "Елизавета", "Ольга"];
const PATR = ["Игоре", "Руслано", "Олего", "Андрее", "Сергее", "Викторо", "Дмитрие", "Алексее", "Павло"];
const fakeName = () => {
  const f = rnd() < 0.45;
  return `${pick(M_LAST)}${f ? "а" : ""} ${pick(f ? F_FIRST : M_FIRST)} ${pick(PATR)}${f ? "вна" : "вич"}`;
};

/* ── Сотрудники (v_employees): все 28 сотрудников из 03_seed.sql ── */
const POSITIONS = [null, ["Директор института", "administration"], ["Заместитель директора института", "administration"],
  ["Специалист по учебно-методической работе", "support"], ["Методист", "support"], ["Заведующий кафедрой", "teaching"],
  ["Профессор", "teaching"], ["Доцент", "teaching"], ["Старший преподаватель", "teaching"], ["Ассистент", "teaching"]];
const CATEGORY_NAME = { administration: "Администрация", support: "Учебно-вспомогательный персонал", teaching: "Преподаватели" };
// unit: у преподавателя — кафедра, у сотрудника деканата — деканат (в БД 'Деканат ' || институт), у директора — дирекция
const employees = [
  ["Смирнов Андрей Викторович", "smirnov.av", 1, 1, "2005-09-01", "Дирекция ИИТ"],
  ["Кузнецова Елена Павловна", "kuznetsova.ep", 2, 1, "2010-02-15", "Деканат"],
  ["Попова Ольга Игоревна", "popova.oi", 3, 1, "2015-08-20", "Деканат"],
  ["Васильева Марина Сергеевна", "vasilyeva.ms", 4, 1, "2021-09-01", "Деканат"],
  ["Козлов Дмитрий Александрович", "kozlov.da", 5, 1, "2001-09-01", "ИС"],
  ["Новиков Игорь Петрович", "novikov.ip", 7, 1, "2010-09-01", "ИС"],
  ["Морозова Анна Владимировна", "morozova.av", 8, 1, "2016-09-01", "ИС"],
  ["Волков Сергей Николаевич", "volkov.sn", 5, 1, "1998-09-01", "ПМ"],
  ["Лебедева Татьяна Юрьевна", "lebedeva.ty", 7, 1, "2012-09-01", "ПМ"],
  ["Соколов Алексей Михайлович", "sokolov.am", 9, 0.5, "2023-09-01", "ПМ"],
  ["Павлова Наталья Олеговна", "pavlova.no", 7, 0.75, "2008-09-01", "ИЯ"],
  ["Фёдоров Максим Андреевич", "fedorov.ma", 7, 1, "2014-09-01", "ИТиВС"],
  ["Орлова Ирина Валерьевна", "orlova.iv", 1, 1, "2009-03-01", "Дирекция ИСТМ"],
  ["Беляев Роман Олегович", "belyaev.ro", 7, 1, "2011-09-01", "ИС"],
  ["Громова Екатерина Сергеевна", "gromova.es", 8, 1, "2017-09-01", "ИС"],
  ["Ершов Павел Андреевич", "ershov.pa", 9, 1, "2022-09-01", "ИС"],
  ["Тарасова Ирина Николаевна", "tarasova.in", 6, 1, "1996-09-01", "ПМ"],
  ["Карпов Денис Игоревич", "karpov.di", 8, 1, "2015-09-01", "ПМ"],
  ["Широков Владимир Геннадьевич", "shirokov.vg", 6, 1, "1993-09-01", "ИТиВС"],
  ["Зайцева Ольга Михайловна", "zaytseva.om", 7, 1, "2009-09-01", "ИТиВС"],
  ["Кириллов Артём Сергеевич", "kirillov.as", 7, 1, "2014-09-01", "ИТиВС"],
  ["Панова Юлия Викторовна", "panova.yv", 8, 1, "2019-09-01", "ИТиВС"],
  ["Лазарев Никита Олегович", "lazarev.no", 9, 0.5, "2024-09-01", "ИТиВС"],
  ["Прохоров Евгений Борисович", "prokhorov.eb", 5, 1, "1991-09-01", "УиИТС"],
  ["Мельникова Анна Дмитриевна", "melnikova.ad", 7, 1, "2010-09-01", "УиИТС"],
  ["Руднев Илья Павлович", "rudnev.ip", 8, 1, "2020-09-01", "УиИТС"],
  ["Сорокина Елена Анатольевна", "sorokina.ea", 8, 1, "2013-09-01", "ИЯ"],
  ["Уткина Мария Сергеевна", "utkina.ms", 9, 1, "2021-09-01", "ИЯ"],
].map(([full_name, login, pos, rate, hire_date, unit], i) => ({
  employee_id: i + 1, personnel_number: "Т-" + String(i + 1).padStart(4, "0"), full_name,
  position: POSITIONS[pos][0], category: POSITIONS[pos][1], unit, employment_rate: rate, hire_date, dismissal_date: null,
  phone: `+7 900 111-01-${String(i + 1).padStart(2, "0")}`, email: `${login}@univ.ru`,
}));
const teachers = employees.filter((e) => e.category === "teaching");
const deanStaff = employees.filter((e) => e.unit === "Деканат");
let ME = deanStaff[0];   // кто вошёл — меняется с ролью (roles.js)

/* ── Студенты, результаты, долги (v_student_summary, v_last_result, v_debtors, v_expulsion_risk) ── */
const ACTIVE = "Обучается";                      // student_status.is_active
const students = [], results = [], debtors = [];
GROUPS.forEach((g, gi) => {
  for (let i = 1; i <= 8; i++) {
    const r = rnd();
    const status = r < 0.05 ? "Академический отпуск" : r < 0.09 ? "Отчислен" : ACTIVE;
    const st = {
      student_id: students.length + 1, student: fakeName(), record_book_number: `${String(g.year).slice(2)}-${gi + 1}1${String(i).padStart(2, "0")}`,
      group_name: g.name, course: course(g.year), status, funding: rnd() < 0.75 ? "Бюджет" : "Договор",
      // посещаемость отмечается только у обучающихся
      attendance_pct: status === ACTIVE ? +(70 + rnd() * 29).toFixed(1) : null,
      is_headman: false, is_foreign: rnd() < 0.05, needs_dormitory: rnd() < 0.3,
    };
    const weak = rnd() < 0.25;
    // У слабых студентов и посещаемость ниже — на этом строится срез OLAP «Посещаемость и долги»
    if (weak && st.attendance_pct != null) st.attendance_pct = +(st.attendance_pct - 24).toFixed(1);
    const pts = [];
    let n = 0;
    CURRICULUM.filter(([, s]) => s <= doneSemesters(g.year)).forEach(([discipline, semester, control_type]) => {
      const failed = rnd() < (weak ? 0.08 : 0.006);
      const points = failed ? null : Math.min(54, int(weak ? 25 : 32, 54));
      results.push({ ...st, discipline, semester, control_type, points });
      n++;
      if (failed) {
        debtors.push({ student_id: st.student_id, student: st.student, group_name: g.name, discipline, semester, control_type,
          attempts: int(1, 3), last_result: rnd() < 0.3 ? "Неявка" : isGraded(control_type) ? "Неудовлетворительно" : "Не зачтено" });
      }
      if (points != null) pts.push({ points, graded: isGraded(control_type) });
    });
    st.results = n;
    st.avg_points = pts.length ? +(pts.reduce((s, p) => s + p.points, 0) / pts.length).toFixed(1) : null;
    const marks = pts.filter((p) => p.graded).map((p) => mark(p.points));
    st.min_mark = marks.length ? Math.min(...marks) : null;
    students.push(st);
  }
});
// Староста — study_group.headman_id; в v_student_summary это is_headman
GROUPS.forEach((g) => { const h = students.find((s) => s.group_name === g.name && s.status === ACTIVE); if (h) h.is_headman = true; });
const studentById = (id) => students.find((s) => s.student_id === id);
const isActive = (id) => studentById(id)?.status === ACTIVE;
// v_debtors и v_expulsion_risk показывают только обучающихся
const debtorsNow = () => debtors.filter((d) => isActive(d.student_id));
const expulsion = [];
// Категория и стипендия пересчитываются и после правок через чат
function categorize(s) {
  s.debts = s.status === ACTIVE ? debtors.filter((d) => d.student_id === s.student_id).length : 0;
  s.category = s.status !== ACTIVE ? s.status
    : expulsion.some((e) => e.student_id === s.student_id) ? "Кандидат на отчисление"
    : s.debts > 0 ? "Есть задолженности"
    : !s.results ? "Ещё не сдавал сессию"
    : s.min_mark === 5 ? "Отличник" : s.min_mark === 4 ? "Хорошист" : s.min_mark === 3 ? "Есть тройки" : "Только зачёты";
  s.scholarships = s.funding === "Бюджет" && ["Отличник", "Хорошист"].includes(s.category)
    ? (s.category === "Отличник" ? "Повышенная государственная академическая" : "Государственная академическая") : null;
}
students.forEach((s) => {
  const ds = debtors.filter((d) => d.student_id === s.student_id).sort((a, b) => a.discipline.localeCompare(b.discipline, "ru"));
  const max = Math.max(...ds.map((d) => d.attempts));
  if (ds.length && (ds.length >= 3 || max >= 3)) {
    expulsion.push({ student_id: s.student_id, student: s.student, group_name: s.group_name, debts: ds.length, max_attempts: max,
      disciplines: ds.map((d) => `${d.discipline} (${d.attempts} ${d.attempts === 1 ? "попытка" : "попытки"})`).join(", "),
      reason: max >= 3 ? "Не сдана комиссия" : "Три и более задолженности" });
  }
  categorize(s);
});
const expulsionNow = () => expulsion.filter((e) => isActive(e.student_id));

/* ── Группы (v_groups) ── */
const avg = (rows) => { const p = rows.filter((r) => r.points != null); return p.length ? +(p.reduce((s, r) => s + r.points, 0) / p.length).toFixed(1) : null; };
const groupRow = (g) => {
  const st = students.filter((s) => s.group_name === g.name);
  const active = st.filter((s) => s.status === ACTIVE);
  return { group_id: g.group_id, group_name: g.name, specialty: g.spec, profile: g.profile, study_form: g.form, admission_year: g.year, course: course(g.year),
    current_semester: course(g.year) * 2 - 1, curator: g.curator, headman: st.find((s) => s.is_headman)?.student ?? null,
    active_students: active.length, budget_students: active.filter((s) => s.funding === "Бюджет").length };
};
const GROUP_NAMES = GROUPS.map((g) => g.name);

/* ── Расписание на семестр по датам (v_schedule_calendar) ── */
const PAIRS = [null, ["08:30", "10:00"], ["10:10", "11:40"], ["12:10", "13:40"], ["13:50", "15:20"], ["15:30", "17:00"], ["17:10", "18:40"]];
const WEEKDAYS = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const HOLIDAYS = ["2026-11-04"];
const TERM_NAME = "2026/27, осенний";               // academic_term 7 — текущий
// Дисциплины текущего семестра по учебному плану; у практик, курсовых и ВКР занятий в сетке нет
const curDisc = (g) => CURRICULUM.filter(([d, s]) => s === course(g.year) * 2 - 1 && !/практика|Курсовая работа|ВКР/.test(d)).map(([d]) => d);
const slots = [];
// Как в fn_check_slot: в одну пару (с учётом чётности недель) у группы, преподавателя и аудитории — не больше одного занятия
const overlaps = (a, b) => a === "every" || b === "every" || a === b;
const clash = (x, y) => x.weekday === y.weekday && x.pair_number === y.pair_number && overlaps(x.parity, y.parity)
  && (x.group_name === y.group_name || x.teacher === y.teacher || x.classroom === y.classroom);
GROUPS.forEach((g) => {
  curDisc(g).forEach((discipline, di) => {
    const teacher = pick(teachers).full_name;
    const kinds = discipline === "Иностранный язык" ? [["Практика", "every"]]
      : [["Лекция", "every"], [di % 2 ? "Лабораторная" : "Практика", di === 0 ? "every" : pick(["odd", "even"])]];
    kinds.forEach(([lesson_type, parity]) => {
      const rooms = lesson_type === "Лекция" ? ["А-101", "А-102", "Б-101", "Б-102"] : lesson_type === "Лабораторная" ? ["А-201", "А-203", "А-205", "А-210"] : ["Б-302", "Б-304", "В-202"];
      const subgroup = lesson_type !== "Лекция" && rnd() < 0.3 ? 1 : null;
      let slot;
      for (let n = 0; n < 400; n++) {   // ищем свободную пару: сначала пн–пт, 1–4 пара, потом шире
        slot = { slot_id: slots.length + 1, group_name: g.name, discipline, lesson_type, teacher, parity,
          weekday: int(1, n < 200 ? 5 : 6), pair_number: int(1, n < 200 ? 4 : 6), classroom: pick(rooms), subgroup };
        if (!slots.some((o) => clash(slot, o))) break;
      }
      slots.push(slot);
    });
  });
});
// v_schedule_calendar строится из занятий сетки (schedule_slot): правка занятия меняет все его даты в семестре
const schedule = [];
function buildSchedule() {
  schedule.length = 0;
  for (let d = D(TERM_FIRST); d <= D(TERM_LAST); d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay(), day = iso(d);
    if (wd === 0 || HOLIDAYS.includes(day)) continue;
    const week_no = weekNo(day);
    slots.filter((s) => s.weekday === wd && (s.parity === "every" || (s.parity === "odd") === (week_no % 2 === 1))
      && (!s.valid_from || day >= s.valid_from) && (!s.valid_to || day <= s.valid_to)).forEach((s) => {
      schedule.push({ lesson_date: day, weekday_name: WEEKDAYS[wd], week_no, week: week_no % 2 ? "нечётная" : "чётная",
        start_time: PAIRS[s.pair_number][0], end_time: PAIRS[s.pair_number][1], term: TERM_NAME, ...s });
    });
  }
  schedule.sort((a, b) => a.lesson_date.localeCompare(b.lesson_date) || a.pair_number - b.pair_number || a.group_name.localeCompare(b.group_name));
}
buildSchedule();

/* ── Заявки на справки (v_document_queue) ── */
const DOC_TYPES = [["Справка об обучении", 3], ["Академическая справка", 10], ["Справка для военного комиссариата", 3], ["Справка о размере стипендии", 5], ["Выписка из приказа", 5]];
const PURPOSES = ["В военный комиссариат", "В банк", "По месту требования", "В налоговую инспекцию", "По месту работы родителей",
  "Для оформления общежития", "В поликлинику", "Для перевода в другой вуз", "В органы социальной защиты"];
// В очереди только незавершённые статусы (request_status.is_final = false)
const requests = Array.from({ length: 14 }, (_, i) => {
  const [document, days] = pick(DOC_TYPES);
  const created = new Date(Date.UTC(2026, 8, 18 + int(0, 13)));
  const due = new Date(created); due.setUTCDate(due.getUTCDate() + days);
  const status = pick(["Новая", "Новая", "В работе", "В работе", "Готова к выдаче"]);
  const s = pick(students);
  return { request_id: 230 + i, student_id: s.student_id, student: s.student, group_name: s.group_name, document, copies: pick([1, 1, 1, 2]),
    purpose: pick(PURPOSES), status, created_at: `${iso(created)} ${String(int(8, 20)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}`,
    due_date: iso(due), processed_by: status === "Новая" ? null : pick(deanStaff).full_name };
}).sort((a, b) => a.due_date.localeCompare(b.due_date));
const FINAL_STATUS = ["Готова к выдаче", "Выдана", "Отклонена"];
const isOverdue = (r) => !!r.due_date && r.due_date < TODAY && !FINAL_STATUS.includes(r.status);
const OVERDUE = { due_date: { to: addDays(TODAY, -1) }, status: ["Новая", "В работе"] };   // те же условия как фильтры по колонкам

/* ── Практики (v_practice) ── */
// Руководители практики от организаций — organization_contact из 03_seed.sql
const ORG_CONTACTS = [
  ["ООО «ТехноСофт-М»", "Краснов Егор Иванович", "Руководитель группы разработки"],
  ["АО «ИнфоСистемы Про»", "Ершов Никита Максимович", "Технический директор"],
  ["АО «ИнфоСистемы Про»", "Мартынов Тимур Викторович", "Аналитик данных"],
  ["ООО «ДатаЛаб»", "Исаев Глеб Денисович", "Технический директор"],
  ["ООО «СтанкоСофт»", "Степанов Степан Михайлович", "Ведущий разработчик"],
  ["АО «Цифровое производство»", "Денисова Анастасия Олеговна", "Руководитель проектов"],
  ["АО «Цифровое производство»", "Румянцев Станислав Ильич", "Аналитик данных"],
  ["ООО «Робоплан»", "Соколова Диана Алексеевна", "Технический директор"],
  ["ИП Кравцов Олег Петрович", "Лапина Екатерина Ильинична", "Технический директор"],
  ["ИП Кравцов Олег Петрович", "Баранова Марина Викторовна", "Руководитель группы разработки"],
  ["ООО «ОблакоТех»", "Исаева Анастасия Александровна", "Аналитик данных"],
  ["ООО «ОблакоТех»", "Вишневский Ярослав Владимирович", "Руководитель проектов"],
];
const practices = [];
students.filter((s) => s.course >= 2 && s.status === ACTIVE).forEach((s, i) => {
  if (i % 2) return;
  const [organization, contact, job] = pick(ORG_CONTACTS);
  // Учебная практика — 2 семестр (летом после первого курса), производственная — 6 семестр
  const prod = s.course >= 4;
  const year = prod ? 2026 : 2028 - s.course;
  practices.push({ student_id: s.student_id, student: s.student, group_name: s.group_name, practice: prod ? "Производственная практика" : "Учебная практика",
    semester: prod ? 6 : 2, organization, supervisor: pick(teachers).full_name, org_supervisor: `${contact}, ${job}`,
    start_date: `${year}-06-29`, end_date: prod ? "2026-07-26" : `${year}-07-12`, order_number: prod ? "116-с/26" : `${int(100, 130)}-с/${String(year).slice(2)}` });
});
/* ── Курсовые и ВКР (v_academic_works) ── */
// ВКР — у выпускников (набор 2023), 8 семестр
// Темы из 03_seed.sql; повторная тема получает фамилию студента в скобках, как в данных базы.
// Темы утверждены приказом «Об утверждении тем и руководителей ВКР» 145-с/26 примерно у половины выпускников.
const VKR_TOPICS = [
  "Интеллектуальный агент для автоматизации процессов деканата на основе больших языковых моделей",
  "Система мониторинга успеваемости студентов с прогнозированием академических задолженностей",
  "Веб-сервис формирования расписания занятий с учётом ограничений аудиторного фонда",
  "Анализ посещаемости занятий методами машинного обучения",
  "Мобильное приложение электронной зачётной книжки",
  "Цифровой двойник технологического участка механообработки",
  "Система распознавания дефектов поверхности деталей по изображениям",
  "Платформа учёта научных публикаций кафедры",
  "Рекомендательная система выбора элективных дисциплин",
  "Чат-бот приёмной комиссии",
  "Система контроля версий учебных планов",
  "Модуль планирования загрузки станков с ЧПУ",
  "Информационная система учёта стипендий",
  "Прогнозирование отказов оборудования по данным датчиков",
  "Сервис проверки заимствований в курсовых работах",
];
const works = [];
students.filter((s) => s.course === 4 && s.status === ACTIVE).forEach((s, i) => {
  if (i % 2) return;
  const n = works.length, [last, first] = s.student.split(" ");
  const supervisor = pick(teachers);
  const reviewer = pick(teachers.filter((t) => t !== supervisor));   // CHECK: рецензент ≠ руководитель
  works.push({ student_id: s.student_id, student: s.student, group_name: s.group_name, work_kind: "ВКР",
    discipline: "Выполнение и защита ВКР", semester: 8,
    topic: n < VKR_TOPICS.length ? VKR_TOPICS[n] : `${VKR_TOPICS[n % VKR_TOPICS.length]} (${last} ${first[0]}.)`,
    supervisor: supervisor.full_name, reviewer: reviewer.full_name, order_number: "145-с/26" });
});
// Курсовая работа — у набора 2024 в 5 семестре: тема с фамилией студента, рецензента и приказа нет
const COURSEWORK_TOPICS = ["Проектирование мобильного клиента библиотеки", "Микросервис уведомлений для портала вуза",
  "Система бронирования аудиторий", "Проектирование модуля расписания занятий", "Архитектура сервиса электронной зачётной книжки",
  "Проектирование системы учёта заявок студентов"];
students.filter((s) => s.course === 3 && s.status === ACTIVE).forEach((s) => {
  const [last, first] = s.student.split(" ");
  works.push({ student_id: s.student_id, student: s.student, group_name: s.group_name, work_kind: "Курсовая работа",
    discipline: "Курсовая работа по проектированию программных систем", semester: 5,
    topic: `${pick(COURSEWORK_TOPICS)} (${last} ${first[0]}.)`, supervisor: pick(teachers).full_name, reviewer: null, order_number: null });
});


/* ═════════ СПРАВОЧНИКИ ДЛЯ ФОРМ ═════════
   В формах фронта связанные записи выбираются из выпадающих списков с поиском (components/form/lookups.ts):
   подпись — название, под ней — уточнение. Здесь те же списки на выдуманных данных. */
const fio = (p) => [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(" ");
employees.forEach((e) => { [e.last_name, e.first_name, e.middle_name] = e.full_name.split(" "); e.position_id = e.position; });
GROUPS.forEach((g, i) => { g.group_id = i + 1; g.curriculum_id = g.year; g.is_archived = false; });
students.forEach((s) => { s.funding_type_id = s.funding; });

// Учебные планы (curriculum) — по году набора; пункты плана (curriculum_item) — дисциплины, курсовые, практики, ВКР
const CURRICULA = [...new Set(GROUPS.map((g) => g.year))].map((y) => ({ curriculum_id: y, start_year: y }));
const ITEM_KIND = (d, ct) => ct === "Курсовая работа" ? "coursework" : ct === "Защита ВКР" ? "final_attestation" : /практика/.test(d) ? "practice" : "discipline";
const KIND_NAME = { discipline: "дисциплина", coursework: "курсовая", practice: "практика", final_attestation: "ГИА / ВКР" };
const ITEMS = CURRICULA.flatMap((c) => CURRICULUM.map(([discipline, semester, control_type]) =>
  ({ item_id: `${c.start_year}-${discipline}-${semester}`, discipline, semester, control_type, kind: ITEM_KIND(discipline, control_type), start_year: c.start_year })));
const itemOf = (discipline, semester, year) => ITEMS.find((i) => i.discipline === discipline && i.semester === semester && i.start_year === year)?.item_id ?? "";
const groupYear = (name) => GROUPS.find((g) => g.name === name)?.year;

// Учебные поручения (teaching_assignment): группа · дисциплина · вид занятия · преподаватель
const ASSIGNMENTS = [];
slots.forEach((s) => {
  let a = ASSIGNMENTS.find((x) => x.group_name === s.group_name && x.discipline === s.discipline && x.lesson_type === s.lesson_type && x.teacher === s.teacher);
  if (!a) ASSIGNMENTS.push(a = { assignment_id: ASSIGNMENTS.length + 1, group_name: s.group_name, discipline: s.discipline, lesson_type: s.lesson_type, teacher: s.teacher, subgroup: s.subgroup });
  Object.assign(s, { assignment_id: a.assignment_id, valid_from: "", valid_to: "", term_id: TERM_NAME });
});
// Вид аудитории — код из справочника, фронт показывает его как есть
const CLASSROOMS = [["А-101", 160, "lecture"], ["А-102", 140, "lecture"], ["Б-101", 120, "lecture"], ["Б-102", 100, "lecture"],
  ["А-201", 24, "computer"], ["А-203", 24, "computer"], ["А-205", 20, "lab"], ["А-210", 20, "lab"],
  ["Б-302", 30, "practice"], ["Б-304", 30, "practice"], ["В-202", 28, "practice"]];
const TERMS = [["2025/26, весенний", "2026-02-09", "2026-06-30"], [TERM_NAME, TERM_FIRST, TERM_LAST]];
buildSchedule();

const FUNDING = ["Бюджет", "Договор"];
const REQUEST_STATUSES = ["Новая", "В работе", "Готова к выдаче", "Выдана", "Отклонена"];
const LEAVE_REASONS = ["По медицинским показаниям", "Семейные обстоятельства", "Беременность и роды", "Уход за ребёнком", "Призыв на военную службу"];
const ORDERS = [["116-с/26", "О направлении на производственную практику", "2026-06-15"], ["145-с/26", "Об утверждении тем и руководителей ВКР", "2026-09-25"],
  ...[...new Set(practices.map((p) => p.order_number))].filter((n) => n !== "116-с/26").map((n) => [n, "О направлении на учебную практику", `20${n.slice(-2)}-06-15`])];
// Люди без записи сотрудника — их можно оформить сотрудником
const PEOPLE = ["Гусев Павел Сергеевич", "Комарова Лидия Андреевна", "Никитин Олег Викторович", "Савельева Ирина Павловна"].map((n) => {
  const [last_name, first_name, middle_name] = n.split(" ");
  return { last_name, first_name, middle_name, email: `${last_name.toLowerCase()}@univ.ru` };
});

works.forEach((w, i) => Object.assign(w, { work_id: i + 1, item_id: itemOf(w.discipline, w.semester, groupYear(w.group_name)) }));
practices.forEach((p, i) => Object.assign(p, { placement_id: i + 1, item_id: itemOf(p.practice, p.semester, groupYear(p.group_name)),
  org_contact_id: ORG_CONTACTS.find(([, n]) => p.org_supervisor.startsWith(n))[1] }));
