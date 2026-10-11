/* ═════════ OLAP-АНАЛИЗ ═════════
   Куб: факты — результаты контроля, посещаемость, приказы по студентам.
   Измерения — студент → группа → курс, дисциплина, семестр, попытка сдачи (основная → пересдача → комиссия), время.
   Каждый срез — вопрос деканата и OLAP-операция, которой он отвечается. Меры — успеваемость и доли, а не средний балл. */

// Для агента в чате: свёртка результатов по ключу (средний балл, долги, отличники)
function rollup(key, rows = results) {
  const mp = new Map();
  rows.forEach((r) => { const k = key(r); if (!mp.has(k)) mp.set(k, []); mp.get(k).push(r); });
  return [...mp.entries()].map(([name, rs]) => ({ name, avg: avg(rs), debts: rs.filter((r) => r.points == null).length,
    students: new Set(rs.map((r) => r.student)).size, results: rs.length, excellent: rs.filter((r) => mark(r.points) === 5).length }));
}

/* ── Данные, которых нет в остальных вкладках: попытки сдачи, модуль 1 текущего семестра, приказы за год.
   Значения выводятся из id и названий (а не из общего генератора), чтобы не менять данные других вкладок ── */
const h01 = (s) => { let x = 2166136261; for (const c of String(s)) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return ((x >>> 0) % 10000) / 10000; };
const isWeak = (s) => (s.avg_points ?? 40) < 38 || (s.attendance_pct ?? 100) < 70 || s.debts > 0;
// С какой попытки сдано: 1 — в сессию, 2 — на пересдаче, 3 — комиссии. У долга попытки ещё идут
const attemptOf = (r) => {
  if (r.points == null) return null;
  const h = h01(`${r.student_id}|${r.discipline}|${r.semester}`), w = isWeak(studentById(r.student_id));
  return h < (w ? 0.13 : 0.02) ? (h < (w ? 0.035 : 0.005) ? 3 : 2) : 1;
};
const failedFirst = (r) => r.points == null || attemptOf(r) > 1;
const pctOf = (a, b) => (b ? Math.round(a / b * 100) : null);
const groupOf = (name) => GROUPS.find((g) => g.name === name);

// Модуль 1 текущего семестра (баллы; меньше 25 — «не аттестован»)
const modules = [];
students.filter((s) => s.status === ACTIVE).forEach((s) => {
  const g = groupOf(s.group_name);
  curDisc(g).forEach((discipline) => {
    const h = h01(`${s.student_id}|m1|${discipline}`);
    const base = (s.avg_points ?? 40) - ((s.attendance_pct ?? 90) < 70 ? 9 : 0) - (isWeak(s) ? 4 : 0);
    modules.push({ student_id: s.student_id, discipline, points: Math.max(0, Math.min(54, Math.round(base - 9 + h * 20))) });
  });
});

// Приказы за последние 12 месяцев: отчисления и академы — у студентов с таким статусом, остальное — выборочно у обучающихся
const MOVE_TYPES = [["expel", "Отчисление"], ["leave", "Академический отпуск"], ["return", "Выход из академа"], ["restore", "Восстановление"], ["transfer", "Перевод в другую группу"]];
const MOVE_NAME = Object.fromEntries(MOVE_TYPES);
const MONTH_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS12 = Array.from({ length: 12 }, (_, i) => { const d = D(TODAY); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 11 + i); return d.toISOString().slice(0, 7); });
// Отчисления копятся после сессий (февраль, июль), академы — в начале семестров
const PEAKS = { expel: ["02", "03", "07", "09"], leave: ["09", "10", "02"], return: ["09", "02"], restore: ["09", "02"], transfer: ["09", "02", "10"] };
const moves = [];
students.forEach((s) => {
  const h = h01(`move|${s.student_id}`);
  const type = s.status === "Отчислен" ? "expel" : s.status === "Академический отпуск" ? "leave"
    : h < 0.07 ? "restore" : h < 0.14 ? "transfer" : h < 0.2 ? "return" : h < 0.27 ? "leave" : h > 0.9 ? "expel" : null;
  if (!type) return;
  const h2 = h01(`when|${s.student_id}`), peaks = MONTHS12.filter((m) => PEAKS[type].includes(m.slice(5)));
  const month = h2 < 0.7 && peaks.length ? peaks[Math.floor(h2 / 0.7 * peaks.length)] : MONTHS12[Math.floor(h2 * 12)];
  const day = String(1 + Math.floor(h01(`day|${s.student_id}`) * 27)).padStart(2, "0");
  moves.push({ order_number: `${100 + moves.length * 7}-с/${month.slice(2, 4)}`, order_date: `${month}-${day}`, type, order_type: MOVE_NAME[type],
    student: s.student, student_id: s.student_id, group_name: s.group_name, course: s.course });
});
moves.sort((a, b) => a.order_date.localeCompare(b.order_date));

/* ── Состояние вкладки ── */
const olap = { op: "session", path: [], sem: "", course: "", group: "", modMin: "25", attMin: "70", level: "group", period: "month", pick: null };
const OPS = [
  ["session", "Итоги сессии", "Roll-up · Drill-down", "Свёртка студентов в группы и курсы. Нажатие на строку раскрывает уровень ниже: курс → группы → дисциплины → студенты."],
  ["heat", "Проблемные дисциплины", "Pivot · Slice", "Поворот куба: дисциплины в строках, группы в столбцах, срез — один семестр. В ячейке — доля не сдавших с первого раза."],
  ["risk", "Раннее предупреждение", "Dice", "Подкуб: обучающиеся × текущий семестр × пороги по модулю 1 и посещаемости. Видно, кому помочь до сессии."],
  ["attend", "Посещаемость и долги", "Slice", "Срез по курсу или группе: каждый студент — точка. Видно, как прогулы связаны с баллами и долгами."],
  ["retake", "Пересдачи", "Roll-up по попыткам", "Свёртка результатов по попытке сдачи: сессия → пересдача → комиссия. Видно, закрываются долги или копятся."],
  ["moves", "Движение контингента", "Roll-up по времени · Drill-down", "Свёртка приказов по времени: месяц → семестр → год. Нажатие на столбец раскрывает приказы периода."],
];
const ACTIVE_GROUPS = () => GROUPS.filter((g) => doneSemesters(g.year) > 0);
const courseOpts = () => [...new Set(GROUPS.map((g) => course(g.year)))].sort().map((c) => [c, `${c} курс`]);
const olapSelect = (label, key, opts, value, all) => `<label class="field"><span>${label}</span><select class="select" data-olap="${key}">${all ? `<option value="">${all}</option>` : ""}${opts.map(([v, l]) =>
  `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
const olapNum = (label, key, value, suffix) => `<label class="field"><span>${label}</span><span class="num-in"><input class="text-input" type="number" min="0" max="100" data-olap="${key}" value="${esc(value)}"><i>${suffix}</i></span></label>`;
const inCourse = (s) => !olap.course || String(s.course) === String(olap.course);
const inGroup = (s) => !olap.group || s.group_name === olap.group;
const groupOptsFor = () => GROUPS.filter((g) => !olap.course || String(course(g.year)) === String(olap.course)).map((g) => [g.name, g.name]);

// Плитки с ключевыми числами над срезом
const tiles = (items) => `<div class="olap-tiles">${items.map(([label, value, note, kind = ""]) =>
  `<div class="card olap-tile ${kind}"><small>${label}</small><b>${value}</b>${note ? `<span>${note}</span>` : ""}</div>`).join("")}</div>`;
// Процент с полоской под числом: зелёная — хорошо, красная — плохо
const pctCell = (v, good = true) => v == null ? "—"
  : `<span class="pct ${good ? (v >= 85 ? "ok" : v >= 65 ? "mid" : "bad") : (v <= 5 ? "ok" : v <= 15 ? "mid" : "bad")}">${v}%<i style="--w:${v}%"></i></span>`;
const pctCol = (label, field, good = true) => ({ label, field, filter: "num", className: "num", text: (r) => (r[field] == null ? "—" : r[field] + "%"), render: (r) => pctCell(r[field], good) });
const numCol = (label, field) => ({ label, field, filter: "num", className: "num", text: (r) => (r[field] ? String(r[field]) : "—") });

/* ═════════ 1. Итоги сессии: Roll-up студент → группа → курс, Drill-down обратно ═════════ */
// Последняя закрытая сессия группы — по её результатам и считаем
const sessionRows = (filter = () => true) => results.filter((r) => { const g = groupOf(r.group_name); return r.semester === doneSemesters(g.year) && filter(r); });
function sessionStats(rows) {
  const by = new Map();
  rows.forEach((r) => { if (!by.has(r.student_id)) by.set(r.student_id, []); by.get(r.student_id).push(r); });
  const st = [...by.values()];
  // По итогам основной сессии: долг, закрытый потом на пересдаче, всё равно считается несданным
  const clean = st.filter((rs) => rs.every((r) => !failedFirst(r)));
  const good = clean.filter((rs) => rs.every((r) => !isGraded(r.control_type) || mark(r.points) >= 4));
  const best = clean.filter((rs) => rs.some((r) => isGraded(r.control_type)) && rs.every((r) => !isGraded(r.control_type) || mark(r.points) === 5));
  return { students: st.length, abs: pctOf(clean.length, st.length), qual: pctOf(good.length, st.length), debts: rows.filter(failedFirst).length, excellent: best.length };
}
const LEVELS = ["Институт", "Курс", "Группа", "Дисциплина"];
function sessionView() {
  const [c, g, d] = olap.path;
  const scope = sessionRows((r) => (c == null || r.course === c) && (!g || r.group_name === g) && (!d || r.discipline === d));
  const total = sessionStats(scope);
  const crumbs = [["Все курсы"], ...(c != null ? [[`${c} курс`]] : []), ...(g ? [[g]] : []), ...(d ? [[d]] : [])];
  // Крошки появляются только после drill-down: на верхнем уровне показывать нечего
  const bc = crumbs.length < 2 ? "" : `<nav class="olap-crumbs" aria-label="Уровень">${crumbs.map(([l], i) => i === crumbs.length - 1 ? `<b>${esc(l)}</b>`
    : `<button type="button" class="link" data-a="olap-crumb" data-i="${i}">${esc(l)}</button>${icon("right")}`).join("")}</nav>`;
  let rows, cols, title, onRow, key = (r) => r.name;
  const statCols = (first) => [{ label: first, field: "name", filter: "text", bold: true }, numCol("Студентов", "students"),
    pctCol("Абсолютная успеваемость", "abs"), pctCol("Качественная успеваемость", "qual"), numCol("Долгов после сессии", "debts"), numCol("Отличников", "excellent")];
  if (c == null) {
    rows = courseOpts().map(([cc]) => ({ name: `${cc} курс`, c: cc, ...sessionStats(sessionRows((r) => r.course === cc)) })).filter((r) => r.students);
    cols = statCols("Курс"); title = "Roll-up до курсов · нажмите на курс, чтобы раскрыть группы"; onRow = (r) => { olap.path = [r.c]; render(); };
  } else if (!g) {
    rows = GROUPS.filter((x) => course(x.year) === c).map((x) => ({ name: x.name, ...sessionStats(sessionRows((r) => r.group_name === x.name)) })).filter((r) => r.students);
    cols = statCols("Группа"); title = `Drill-down: группы ${c} курса · нажмите на группу, чтобы раскрыть дисциплины`; onRow = (r) => { olap.path = [c, r.name]; render(); };
  } else if (!d) {
    const ds = [...new Set(scope.map((r) => r.discipline))];
    rows = ds.map((name) => ({ name, ...sessionStats(scope.filter((r) => r.discipline === name)) }));
    cols = statCols("Дисциплина"); title = `Drill-down: дисциплины группы ${g} · нажмите на дисциплину, чтобы увидеть студентов`; onRow = (r) => { olap.path = [c, g, r.name]; render(); };
  } else {
    rows = scope.map((r) => ({ ...r, name: r.student, attempt: attemptOf(r) }));
    cols = [{ label: "Студент", field: "student", filter: "text", bold: true }, { label: "Контроль", field: "control_type", filter: "enum" },
      { label: "Баллы", field: "points", filter: "num", className: "num", text: (r) => (r.points == null ? "—" : String(r.points)) },
      { label: "Результат", field: (r) => (r.points == null ? "Долг" : isGraded(r.control_type) ? ["", "", "", "Удовлетворительно", "Хорошо", "Отлично"][mark(r.points)] : "Зачтено"),
        filter: "enum", badge: true, render: (r) => (r.points == null ? badge("Долг", "bad") : badge(isGraded(r.control_type) ? ["", "", "", "Удовлетворительно", "Хорошо", "Отлично"][mark(r.points)] : "Зачтено", mark(r.points) === 5 ? "ok" : mark(r.points) === 3 ? "warn" : "info")) },
      { label: "Сдано", field: (r) => (r.points == null ? "Не сдано" : ["", "В сессию", "На пересдаче", "Комиссии"][r.attempt]), filter: "enum" }];
    title = `Студенты группы ${g} · ${d}`; key = (r) => r.student_id;
    onRow = (r) => openStudent(studentById(r.student_id));
  }
  return [tiles([["Студентов в сессии", total.students], ["Абсолютная успеваемость", `${total.abs ?? "—"}%`, "сдали всё в сессию, без пересдач", total.abs >= 85 ? "ok" : total.abs >= 65 ? "" : "bad"],
      ["Качественная успеваемость", `${total.qual ?? "—"}%`, "только «хорошо» и «отлично»"], ["Долгов после сессии", total.debts, `отличников — ${total.excellent}`, total.debts ? "bad" : "ok"]]),
    ...(bc ? [bc] : []), dataTable(`olap-s-${olap.path.length}`, cols, applyTable(`olap-s-${olap.path.length}`, cols, rows), rows, { rowKey: key, title, onRow })];
}

/* ═════════ 2. Проблемные дисциплины: Pivot дисциплина × группа + Slice по семестру ═════════ */
function heatView() {
  const sems = [...new Set(results.map((r) => r.semester))].sort((a, b) => a - b);
  // По умолчанию — самый поздний семестр из тех, что прошли больше всего групп: сравнение полнее
  const nGroups = (s) => ACTIVE_GROUPS().filter((g) => doneSemesters(g.year) >= s).length;
  const sem = +(olap.sem || sems.reduce((best, s) => (nGroups(s) >= nGroups(best) ? s : best), sems[0]));
  const rs = results.filter((r) => r.semester === sem);
  const groups = [...new Set(rs.map((r) => r.group_name))].sort();
  const discs = [...new Set(rs.map((r) => r.discipline))];
  const cell = (rows) => (rows.length ? pctOf(rows.filter(failedFirst).length, rows.length) : null);
  const heat = (v) => (v == null ? "" : v === 0 ? "h0" : v < 8 ? "h1" : v < 15 ? "h2" : v < 25 ? "h3" : "h4");
  const td = (v) => `<td class="${heat(v)}">${v == null ? "—" : v + "%"}</td>`;
  const byDisc = discs.map((d) => ({ d, v: cell(rs.filter((r) => r.discipline === d)) })).sort((a, b) => b.v - a.v);
  const byGroup = groups.map((g) => ({ g, v: cell(rs.filter((r) => r.group_name === g)) })).sort((a, b) => b.v - a.v);
  const table = `<div class="heat-wrap"><table class="heat"><thead><tr><th>Дисциплина</th>${groups.map((g) => `<th>${g}</th>`).join("")}<th class="tot">Всего</th></tr></thead><tbody>
    ${byDisc.map(({ d, v }, i) => `<tr style="--i:${i}"><th>${esc(d)}</th>${groups.map((g) => td(cell(rs.filter((r) => r.discipline === d && r.group_name === g)))).join("")}<td class="tot ${heat(v)}">${v}%</td></tr>`).join("")}
    <tr class="tot"><th>Всего по группе</th>${groups.map((g) => td(cell(rs.filter((r) => r.group_name === g)))).join("")}${td(cell(rs))}</tr></tbody></table></div>`;
  const legend = `<span class="chart-legend">${[["h0", "0%"], ["h1", "до 8%"], ["h2", "8–15%"], ["h3", "15–25%"], ["h4", "больше 25%"]].map(([c, l]) => `<span><i class="${c}"></i>${l}</span>`).join("")}</span>`;
  const top = byDisc[0], worst = byGroup[0];
  return [`<div class="olap-filters">${olapSelect("Slice: семестр", "sem", sems.map((s) => [s, `${s} семестр`]), sem)}</div>`,
    tiles([["Сложнее всего", esc(top.d), `не сдали с первого раза ${top.v}%`, top.v >= 15 ? "bad" : ""], ["Группа с худшим результатом", worst.g, `не сдали с первого раза ${worst.v}%`],
      ["В среднем по семестру", `${cell(rs)}%`, "результатов не сданы с первого раза"]]),
    `<section class="card"><div class="table-head"><h2>Доля несданных с первой попытки · ${sem} семестр</h2>${legend}</div>${table}
      <p class="olap-foot">Красная строка — проблема в дисциплине (у всех групп). Красный столбец — проблема в группе (по всем дисциплинам).</p></section>`];
}

/* ═════════ 3. Раннее предупреждение: Dice по курсу, модулю 1 и посещаемости ═════════ */
function riskView() {
  const mMin = +olap.modMin || 0, aMin = +olap.attMin || 0;
  const pool = students.filter((s) => s.status === ACTIVE && inCourse(s) && inGroup(s));
  const rows = pool.map((s) => {
    const low = modules.filter((m) => m.student_id === s.student_id && m.points < mMin);
    const att = s.attendance_pct != null && s.attendance_pct < aMin;
    const score = (low.length ? 1 : 0) + (att ? 1 : 0) + (s.debts ? 1 : 0);
    return { ...s, low: low.length, lowList: low.map((m) => `${m.discipline}: ${m.points}`).join(", "), att, score,
      risk: score >= 2 ? "Высокий" : score === 1 ? "Средний" : null };
  }).filter((r) => r.score).sort((a, b) => b.score - a.score || b.low - a.low);
  const cols = [{ label: "Студент", field: "student", filter: "text", bold: true }, { label: "Группа", field: "group_name", filter: "enum" },
    { label: "Модуль 1 ниже порога", field: "low", filter: "num", className: "num", text: (r) => (r.low ? `${r.low} дисц.` : "—"),
      render: (r) => (r.low ? `<span title="${esc(r.lowList)}">${r.low} ${plural(r.low, "дисциплина", "дисциплины", "дисциплин")}</span>` : "—") },
    { label: "Посещаемость", field: "attendance_pct", filter: "num", className: "num", text: (r) => `${String(r.attendance_pct).replace(".", ",")}%`,
      render: (r) => `<span class="${r.att ? "neg" : ""}">${String(r.attendance_pct).replace(".", ",")}%</span>` },
    numCol("Долги прошлых сессий", "debts"),
    { label: "Риск", field: "risk", filter: "enum", badge: true, render: (r) => badge(r.risk, r.score >= 2 ? "bad" : "warn") }];
  const n = (f) => rows.filter(f).length;
  return [`<div class="olap-filters">${olapSelect("Курс", "course", courseOpts(), olap.course, "Все")}${olapSelect("Группа", "group", groupOptsFor(), olap.group, "Все")}
      ${olapNum("Модуль 1 меньше", "modMin", olap.modMin, "баллов")}${olapNum("Посещаемость ниже", "attMin", olap.attMin, "%")}</div>`,
    tiles([["В зоне риска", `${rows.length} из ${pool.length}`, `высокий риск — ${n((r) => r.score >= 2)}`, rows.length ? "bad" : "ok"],
      ["Слабый модуль 1", n((r) => r.low), `меньше ${mMin} баллов хотя бы по одной дисциплине`], ["Низкая посещаемость", n((r) => r.att), `ниже ${aMin}%`],
      ["С долгами прошлых сессий", n((r) => r.debts)]]),
    dataTable("olap-risk", cols, applyTable("olap-risk", cols, rows), rows, { rowKey: (r) => r.student_id,
      title: "Студенты, которым нужна помощь до сессии · Dice: обучающиеся × текущий семестр × пороги", onRow: (r) => openStudent(studentById(r.student_id)) })];
}

/* ═════════ 4. Посещаемость и долги: Slice по курсу и группе ═════════ */
function attendView() {
  const pool = students.filter((s) => s.status === ACTIVE && s.avg_points != null && inCourse(s) && inGroup(s));
  const aMin = +olap.attMin || 70;
  // Шкалы по данным, а не по всей шкале оценок: точки занимают всё поле
  const atts = pool.map((s) => s.attendance_pct), pts = pool.map((s) => s.avg_points);
  const X0 = Math.max(0, Math.floor((Math.min(aMin, ...atts) - 4) / 10) * 10), X1 = 100;
  const Y0 = Math.floor((Math.min(...pts) - 1) / 5) * 5, Y1 = Math.ceil((Math.max(...pts) + 1) / 5) * 5;
  const W = 1000, H = 320, L = 34, R = 12, T = 12, B = 30;
  const x = (v) => L + (Math.max(X0, Math.min(X1, v)) - X0) / (X1 - X0) * (W - L - R);
  const y = (v) => T + (1 - (v - Y0) / (Y1 - Y0)) * (H - T - B);
  const range = (a, b, st) => Array.from({ length: Math.floor((b - a) / st) + 1 }, (_, i) => a + i * st);
  let g = `<rect class="zone" x="${L}" y="${T}" width="${x(aMin) - L}" height="${H - T - B}"/>`;
  g += range(Y0, Y1, 5).map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("");
  g += range(X0, X1, 10).map((v) => `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${T}" y2="${H - B}"/><text x="${x(v)}" y="${H - 8}" text-anchor="middle">${v}%</text>`).join("");
  g += `<line class="cut" x1="${x(aMin)}" x2="${x(aMin)}" y1="${T}" y2="${H - B}"/><text class="cut-l" x="${x(aMin) - 8}" y="${T + 16}" text-anchor="end">ниже ${aMin}%</text>`;
  g += pool.map((s, i) => `<circle class="${s.debts ? "debt" : "ok"}" style="--i:${i % 40}" cx="${x(s.attendance_pct)}" cy="${y(s.avg_points)}" r="7"><title>${esc(s.student)} · ${s.group_name}: посещаемость ${s.attendance_pct}%, средний балл ${s.avg_points}${s.debts ? `, долгов ${s.debts}` : ""}</title></circle>`).join("");
  const lo = pool.filter((s) => s.attendance_pct < aMin), hi = pool.filter((s) => s.attendance_pct >= aMin);
  const debtShare = (a) => pctOf(a.filter((s) => s.debts).length, a.length);
  const avgOf = (a) => (a.length ? (a.reduce((t, s) => t + s.avg_points, 0) / a.length).toFixed(1).replace(".", ",") : "—");
  return [`<div class="olap-filters">${olapSelect("Slice: курс", "course", courseOpts(), olap.course, "Все")}${olapSelect("Группа", "group", groupOptsFor(), olap.group, "Все")}
      ${olapNum("Граница посещаемости", "attMin", olap.attMin, "%")}</div>`,
    tiles([[`Посещаемость ниже ${aMin}%`, `${debtShare(lo) ?? "—"}%`, `с долгами · ${lo.length} ${plural(lo.length, "студент", "студента", "студентов")}, средний балл ${avgOf(lo)}`, "bad"],
      [`Посещаемость ${aMin}% и выше`, `${debtShare(hi) ?? "—"}%`, `с долгами · ${hi.length} ${plural(hi.length, "студент", "студента", "студентов")}, средний балл ${avgOf(hi)}`, "ok"]]),
    `<section class="card"><div class="table-head"><h2>Посещаемость и средний балл</h2>
      <span class="chart-legend"><span><i class="dot ok"></i>без долгов</span><span><i class="dot debt"></i>есть долги</span><span>точка — студент</span></span></div>
      <div class="chart scatter"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Посещаемость и средний балл">${g}</svg></div></section>`];
}

/* ═════════ 5. Пересдачи: Roll-up по попытке сдачи ═════════ */
function retakeView() {
  const rs = results.filter((r) => inCourse(r) && inGroup(r) && isActive(r.student_id));
  const fail = (a) => a.filter(failedFirst);
  const stat = (a) => { const f = fail(a), r2 = f.filter((r) => attemptOf(r) === 2).length, r3 = f.filter((r) => attemptOf(r) === 3).length, open = f.filter((r) => r.points == null).length;
    return { failed: f.length, r2, r3, open, closed: pctOf(r2 + r3, f.length) }; };
  const t = stat(rs);
  const toExpel = expulsionNow().filter((e) => inCourse(studentById(e.student_id)) && inGroup(studentById(e.student_id))).length;
  const steps = [["Не сдали в сессию", t.failed, "all"], ["Закрыли на пересдаче", t.r2, "ok"], ["Закрыли комиссии", t.r3, "ok2"], ["Не закрыто", t.open, "bad"]];
  const funnel = `<div class="funnel">${steps.map(([l, v, c], i) => `<div class="fn-row" style="--i:${i}"><span>${l}</span>
    <div class="fn-track"><i class="${c}" style="--w:${t.failed ? v / t.failed * 100 : 0}%"></i></div><b>${v}</b></div>`).join("")}</div>`;
  const byLevel = olap.level === "course"
    ? courseOpts().map(([c]) => ({ name: `${c} курс`, ...stat(rs.filter((r) => r.course === c)) }))
    : [...new Set(rs.map((r) => r.group_name))].sort().map((g) => ({ name: g, ...stat(rs.filter((r) => r.group_name === g)) }));
  const rows = byLevel.filter((r) => r.failed);
  const cols = [{ label: olap.level === "course" ? "Курс" : "Группа", field: "name", filter: "text", bold: true }, numCol("Не сдали в сессию", "failed"),
    numCol("Закрыто на пересдаче", "r2"), numCol("Закрыто комиссией", "r3"), numCol("Не закрыто", "open"), pctCol("Закрыто долгов", "closed")];
  return [`<div class="olap-filters">${olapSelect("Курс", "course", courseOpts(), olap.course, "Все")}${olapSelect("Группа", "group", groupOptsFor(), olap.group, "Все")}
      <label class="field"><span>Roll-up до</span>${seg("olap-level", [["group", "Групп"], ["course", "Курсов"]], olap.level)}</label></div>`,
    tiles([["Закрыто долгов", `${t.closed ?? "—"}%`, `${t.r2 + t.r3} из ${t.failed}`, t.closed >= 70 ? "ok" : "bad"], ["Ещё не закрыто", t.open, "долгов у обучающихся", t.open ? "bad" : "ok"],
      ["Кандидатов на отчисление", toExpel, "три долга или не сдана комиссия", toExpel ? "bad" : "ok"]]),
    `<section class="card"><div class="table-head"><h2>Судьба долгов: от сессии до комиссии</h2></div>${funnel}</section>`,
    dataTable("olap-retake", cols, applyTable("olap-retake", cols, rows), rows, { rowKey: (r) => r.name, title: `Roll-up по ${olap.level === "course" ? "курсам" : "группам"}` })];
}

/* ═════════ 6. Движение контингента: Roll-up по времени (месяц → семестр → год), Drill-down до приказов ═════════ */
const termOf = (m) => { const y = +m.slice(0, 4), mo = +m.slice(5); return mo >= 9 ? `${y}/${String(y + 1).slice(2)}, осень` : mo === 1 ? `${y - 1}/${String(y).slice(2)}, осень` : `${y - 1}/${String(y).slice(2)}, весна`; };
const yearOf = (m) => { const y = +m.slice(0, 4), mo = +m.slice(5); return mo >= 9 ? `${y}/${String(y + 1).slice(2)} уч. год` : `${y - 1}/${String(y).slice(2)} уч. год`; };
function movesView() {
  const ms = moves.filter((m) => inCourse(m) && inGroup(m) && MONTHS12.includes(m.order_date.slice(0, 7)));
  const keyOf = (m) => (olap.period === "term" ? termOf(m) : olap.period === "year" ? yearOf(m) : m);
  const labelOf = (k) => (olap.period === "month" ? `${MONTH_SHORT[+k.slice(5) - 1]} ${k.slice(2, 4)}` : k);
  const periods = [...new Set(MONTHS12.map(keyOf))];
  const data = periods.map((p) => ({ p, by: Object.fromEntries(MOVE_TYPES.map(([t]) => [t, ms.filter((m) => keyOf(m.order_date.slice(0, 7)) === p && m.type === t).length])) }));
  const max = Math.max(1, ...data.map((d) => Object.values(d.by).reduce((a, b) => a + b, 0)));
  const pick = periods.includes(olap.pick) ? olap.pick : null;
  const bars = `<div class="stack-chart" style="--n:${periods.length}">${data.map(({ p, by }, i) => {
    const sum = Object.values(by).reduce((a, b) => a + b, 0);
    return `<button type="button" class="sc-col${pick === p ? " on" : ""}" style="--i:${i}" data-a="olap-pick" data-v="${esc(p)}" title="${esc(labelOf(p))}: ${sum}">
      <span class="sc-v">${sum || ""}</span><span class="sc-bar" style="--h:${sum / max * 100}%">${MOVE_TYPES.map(([t]) => (by[t] ? `<i class="mv-${t}" style="flex:${by[t]}"></i>` : "")).join("")}</span>
      <span class="sc-l">${esc(labelOf(p))}</span></button>`; }).join("")}</div>`;
  const legend = `<span class="chart-legend">${MOVE_TYPES.map(([t, l]) => `<span><i class="mv-${t}"></i>${l}</span>`).join("")}</span>`;
  const n = (t) => ms.filter((m) => m.type === t).length;
  const list = pick ? ms.filter((m) => keyOf(m.order_date.slice(0, 7)) === pick) : ms;
  const cols = [{ label: "Дата", field: "order_date", filter: "date" }, { label: "Приказ", field: "order_number", filter: "text" },
    { label: "Вид", field: "order_type", filter: "enum", badge: true, render: (r) => badge(r.order_type, { expel: "bad", leave: "warn", return: "info", restore: "ok", transfer: "muted" }[r.type]) },
    { label: "Студент", field: "student", filter: "text", bold: true }, { label: "Группа", field: "group_name", filter: "enum" }];
  return [`<div class="olap-filters">${olapSelect("Курс", "course", courseOpts(), olap.course, "Все")}${olapSelect("Группа", "group", groupOptsFor(), olap.group, "Все")}
      <label class="field"><span>Roll-up по времени</span>${seg("olap-period", [["month", "Месяцы"], ["term", "Семестры"], ["year", "Год"]], olap.period)}</label></div>`,
    tiles([["Отчислено", n("expel"), "за 12 месяцев", n("expel") ? "bad" : ""], ["Ушли в академ", n("leave"), `вернулись — ${n("return")}`], ["Восстановлено", n("restore"), "", "ok"], ["Переведено", n("transfer"), "в другую группу"]]),
    `<section class="card"><div class="table-head"><h2>Приказы по студентам</h2>${legend}</div>${bars}</section>`,
    dataTable("olap-moves", cols, applyTable("olap-moves", cols, list), list, { rowKey: (r) => r.order_number,
      title: pick ? `Drill-down: ${labelOf(pick)} · ${list.length} ${plural(list.length, "приказ", "приказа", "приказов")}` : "Все приказы за 12 месяцев · нажмите на столбец, чтобы раскрыть период" })];
}

/* ── Страница ── */
PAGES.olap = () => {
  const view = { session: sessionView, heat: heatView, risk: riskView, attend: attendView, retake: retakeView, moves: movesView }[olap.op];
  return pageView("olap", "OLAP-анализ", [
    `<nav class="olap-ops" aria-label="Срезы">${OPS.map(([v, l, t]) => `<button type="button" class="olap-op" data-a="olap-op" data-v="${v}" aria-pressed="${v === olap.op}"><b>${l}</b><small>${t}</small></button>`).join("")}</nav>`,
    ...view().map((x, i) => `<div class="enter" data-k="${olap.op}#${i}">${x}</div>`)]);
};
