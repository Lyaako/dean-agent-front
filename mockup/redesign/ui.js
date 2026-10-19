/* ═════════ ОБЩИЕ ЭЛЕМЕНТЫ ИНТЕРФЕЙСА ═════════
   Повторяют компоненты React-фронта (frontend/src/components): таблица с поиском и фильтрами,
   окна, формы записей с выпадающими списками, подтверждения и тосты. */

/* ── Форматы (lib/format.ts) ── */
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const WD_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const human = (s) => `${D(s).getUTCDate()} ${MONTHS[D(s).getUTCMonth()]}`;
const fmtDate = (s) => (s ? String(s).slice(0, 10).split("-").reverse().join(".") : "—");
const fmtDateTime = (s) => (s ? `${fmtDate(s)} ${String(s).slice(11, 16)}` : "—");
const fmtNum = (v, dec = 0) => (v == null || v === "" || Number.isNaN(Number(v)) ? "—"
  : Number(v).toLocaleString("ru-RU", { minimumFractionDigits: dec, maximumFractionDigits: dec }));
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
const norm = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
// Текст ошибки формы: строка или ошибка с кодом (код — в рамке, как в пакетах)
const errHtml = (e) => (e?.code ? `${esc(e.message)} ${codeTag(e.code)}` : esc(e?.message ?? e));
// Как btrim(s, E' \t\r\n') в базе: по краям текстовых полей не бывает пробелов, табуляции и переводов строк
const clip = (s) => String(s ?? "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const shortName = (n) => { const [l, f, p] = String(n).split(" "); return f ? `${l} ${f[0]}.${p ? ` ${p[0]}.` : ""}` : l; };
const tone = (s) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 5;
const yes = (v) => (v ? "да" : "—");
const t = (v) => (v == null || v === "" ? "—" : String(v));
const badge = (text, kind = "") => `<span class="badge ${kind}">${esc(text)}</span>`;
let uidN = 0;
const uid = () => `k${++uidN}`;

/* ── Поиск, фильтры, сортировка, страницы (components/table/tableLogic.ts) ──
   Колонка: { label, field, render, text, filter, className, badge, bold, grow, order } */
const PAGE_SIZE = 20;
const DROPDOWN_FROM = 6;   // больше значений — фильтр колонки показывается выпадающим списком
const LONG = 28;           // длиннее — значения не помещаются кнопками, нужен выпадающий список
const rawOf = (c, r) => (typeof c.field === "function" ? c.field(r) : c.field ? r[c.field] : undefined);
const labelOf = (v) => (v == null || v === "" ? "—" : v === true ? "да" : v === false ? "нет" : String(v));
const shownOf = (c, r) => { if (c.text) return c.text(r); const v = rawOf(c, r); return c.filter === "date" && v ? fmtDate(v) : labelOf(v); };
const sortable = (v) => (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v);
const cmp = (a, b) => { const x = sortable(a), y = sortable(b);
  return Number(x == null) - Number(y == null)
    || (typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), "ru", { numeric: true })); };
const isSet = (f) => f != null && (Array.isArray(f) ? f.length > 0 : typeof f === "string" ? f.trim() !== "" : Object.values(f).some((x) => x !== "" && x != null));
function passes(c, f, r) {
  const v = rawOf(c, r);
  if (Array.isArray(f)) return f.includes(labelOf(v));
  if (v == null) return false;
  if (c.filter === "num") return (!f.min || Number(v) >= Number(f.min)) && (!f.max || Number(v) <= Number(f.max));
  const d = String(v).slice(0, 10);
  return (!f.from || d >= f.from) && (!f.to || d <= f.to);
}
// Поиск — только по колонкам с текстовым фильтром: ФИО, тема, номер и т. п.
function applyTable(id, cols, rows) {
  const s = ts(id), q = norm(s.q.trim());
  let out = rows.filter((r) => (!q || cols.some((c) => c.field && c.filter === "text" && norm(shownOf(c, r)).includes(q)))
    && Object.entries(s.f).every(([i, f]) => !isSet(f) || !cols[i] || passes(cols[i], f, r)));
  if (s.sort && cols[s.sort.i]) {
    const c = cols[s.sort.i], dir = s.sort.dir;
    const key = (r) => (c.order ? c.order.indexOf(String(rawOf(c, r))) : rawOf(c, r));
    out = [...out].sort((a, b) => cmp(key(a), key(b)) * dir);
  }
  return out;
}
function enumValues(c, rows) {
  const vals = [...new Set(rows.map((r) => labelOf(rawOf(c, r))))];
  if (c.order) return vals.sort((a, b) => (c.order.indexOf(a) + 1 || 99) - (c.order.indexOf(b) + 1 || 99));
  return vals.sort((a, b) => Number(a === "—") - Number(b === "—") || cmp(a, b));
}
function plaqueText(c, f) {
  if (Array.isArray(f)) return f.join(", ");
  if (c.filter === "num") return [f.min ? `от ${f.min}` : "", f.max ? `до ${f.max}` : ""].filter(Boolean).join(" ");
  return [f.from ? `с ${fmtDate(f.from)}` : "", f.to ? `по ${fmtDate(f.to)}` : ""].filter(Boolean).join(" ");
}
function pageButtons(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const set = [...new Set([1, cur - 1, cur, cur + 1, total])].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  return set.flatMap((n, i) => (i && n - set[i - 1] > 1 ? ["…", n] : [n]));
}

// Состояние таблиц живёт между переключениями вкладок
const tstore = {};
const ts = (id) => (tstore[id] ||= { q: "", f: {}, sort: null, page: 1, open: false, dd: null, ddq: "" });

/* Ширины колонок: каждая — по своему самому длинному значению (длинный текст переносится),
   свободное место делится по весу колонки. Считается по всем строкам таблицы — колонки не прыгают. */
let measureSpan = null;
const widthCache = new Map();
function textW(text, size, weight = 400) {
  const k = `${size}|${weight}|${text}`;
  if (!widthCache.has(k)) {
    if (!measureSpan) {
      const box = document.createElement("div");
      box.className = "table-wrap";
      box.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none";
      box.innerHTML = '<table><tbody><tr><td><span style="white-space:nowrap"></span></td></tr></tbody></table>';
      document.body.append(box);
      measureSpan = box.querySelector("span");
    }
    Object.assign(measureSpan.style, { fontSize: size + "px", fontWeight: String(weight) });
    measureSpan.textContent = text;
    widthCache.set(k, measureSpan.getBoundingClientRect().width);
  }
  return widthCache.get(k);
}
const WRAP_MAX = 230;
function colWidths(cols, rows, avail, edge = 20, pad = 7) {
  const small = innerWidth <= 1360, fs = small ? 12 : 13, hs = small ? 11 : 11.5;
  const content = [], least = [], shorts = [];
  const sample = rows.length > 600 ? rows.filter((_, i) => i % Math.ceil(rows.length / 600) === 0) : rows;
  cols.forEach((c) => {
    const size = c.badge ? hs : fs, weight = c.bold ? 700 : c.badge ? 500 : 400;
    const vals = sample.map((r) => shownOf(c, r));
    const full = Math.max(0, ...vals.map((v) => textW(v, size, weight)));
    const word = Math.max(0, ...vals.flatMap((v) => v.split(/\s+/)).map((x) => textW(x, size, weight)));
    const wraps = vals.some((v) => /\s/.test(v));
    let w = wraps && !c.badge ? Math.min(full, Math.max(word, WRAP_MAX)) : full;
    const extraBadge = c.badge ? 36 : 0;
    w += extraBadge;
    const head = textW(c.label, hs, 500) + 14;
    // Заголовок может переноситься по пробелам и мягким переносам (­: «Обще-житие»)
    const headWord = Math.max(...c.label.split(/\s+/).flatMap((wd) => {
      const parts = wd.split("­");
      return parts.map((x, i) => textW(i < parts.length - 1 ? x + "-" : x, hs, 500));
    })) + 8;
    content.push(Math.ceil(Math.max(w, head)) + 2);
    const short = full + extraBadge <= 140;
    shorts.push(short && !c.badge);
    least.push(Math.ceil(Math.max(wraps && !short ? word + extraBadge : w, headWord)) + 2);
  });
  const pads = cols.map((_, j) => (j === 0 ? edge : pad) + (j === cols.length - 1 ? edge : pad));
  let widths = content.map((w, j) => w + pads[j]);
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= avail) {
    const weights = cols.map((c) => c.grow ?? 1), sumW = weights.reduce((a, b) => a + b, 0) || 1;
    widths = widths.map((w, j) => w + (avail - total) * weights[j] / sumW);
  } else {
    // Не помещается: сначала сужаем обычные колонки, и только потом — колонки с метками
    const slack = content.map((w, j) => w - least[j]);
    let over = total - avail;
    for (const badgePhase of [false, true]) {
      if (over <= 0) break;
      const inPhase = (j) => !!cols[j].badge === badgePhase;
      const room = slack.reduce((a, x, j) => a + (inPhase(j) ? x : 0), 0);
      const k = Math.min(1, over / (room || 1));
      widths = widths.map((w, j) => (inPhase(j) ? w - slack[j] * k : w));
      over -= Math.min(over, room);
    }
  }
  return { widths, sum: widths.reduce((a, b) => a + b, 0), short: shorts };
}
const pageAvail = () => { const pg = $("#page"); if (!pg) return 1000; const cs = getComputedStyle(pg); return pg.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); };

/* ── Панель над таблицей (TableTools.tsx): поиск по текстовым колонкам, «Фильтры» с остальными колонками,
   ниже — плашки активных фильтров слева и число записей справа ── */
function tableTools(id, cols, rows, count, extra = "") {
  const s = ts(id);
  const active = Object.entries(s.f).filter(([i, f]) => cols[i] && isSet(f));
  const searchCols = cols.filter((c) => c.field && c.filter === "text");
  const hint = `Поиск: ${searchCols.map((c) => c.label.replace(/­/g, "")).join(", ")}`;
  const search = searchCols.length ? `<label class="search">${icon("search")}
    <input type="text" data-tq="${id}" value="${esc(s.q)}" placeholder="${esc(hint)}" aria-label="${esc(hint)}" autocomplete="off">
    ${s.q ? `<button type="button" class="search-clear" data-a="tqclear" data-id="${id}" aria-label="Очистить поиск">${icon("x")}</button>` : ""}</label>` : "";
  const panel = s.open ? `<section class="card fpanel" data-fpanel="${id}" data-k="fpanel">${cols.map((c, i) =>
    (c.field && c.filter && c.filter !== "text" ? filterField(id, c, i, rows, s.f[i]) : "")).join("")}</section>` : "";
  const plaques = active.length ? `<div class="fplaques" data-k="plaques">${active.map(([i, f]) => `<span class="fplaque" data-k="f${i}">${esc(cols[i].label)}: ${esc(plaqueText(cols[i], f))}
      <button type="button" data-a="tclear" data-id="${id}" data-i="${i}" aria-label="Убрать фильтр «${esc(cols[i].label)}»">${icon("x")}</button></span>`).join("")}
      <button type="button" class="btn sm ghost" data-a="tclear" data-id="${id}" data-i="*">Сбросить всё</button></div>` : "";
  const meta = active.length ? `<div class="table-meta" data-k="meta">${plaques}</div>` : "";
  return `<div class="toolbar" data-k="toolbar">${search}
    <button type="button" class="btn sm ${s.open || active.length ? "soft" : "ghost"} filter-btn" data-a="tpanel" data-id="${id}" aria-expanded="${s.open}">${icon("list")}<span>Фильтры</span></button>
${extra}</div>${panel}${meta}`;
}
function filterField(id, c, i, rows, value) {
  const title = `<span class="ff-l">${esc(c.label)}</span>`;
  const s = ts(id);
  if (c.filter === "enum" || c.filter === "bool") {
    const vals = enumValues(c, rows), sel = Array.isArray(value) ? value : [];
    // Много значений или длинные — выпадающий список с поиском и галочками, иначе кнопки
    if (vals.length > DROPDOWN_FROM || vals.some((v) => v.length > LONG)) {
      const open = s.dd === i, n = norm(s.ddq.trim());
      const shown = n ? vals.filter((v) => norm(v).includes(n)) : vals;
      return `<div class="ff">${title}<div class="ff-dd">
        <button type="button" class="ff-in ff-dd-btn" data-a="tdd" data-id="${id}" data-i="${i}" aria-expanded="${open}"><span>${sel.length === 1 ? esc(sel[0]) : sel.length ? `Выбрано: ${sel.length}` : "Все"}</span>${icon("down")}</button>
        ${open ? `<div class="ff-dd-list"><input class="ff-in ff-dd-search" data-ddq="${id}" value="${esc(s.ddq)}" placeholder="Найти…" aria-label="Найти: ${esc(c.label)}" autocomplete="off">
          ${shown.length ? shown.map((v) => `<label class="ff-opt"><input type="checkbox" data-tchk="${id}|${i}" value="${esc(v)}" ${sel.includes(v) ? "checked" : ""}><span>${esc(v)}</span></label>`).join("")
            : `<div class="ff-empty">Ничего не найдено</div>`}</div>` : ""}
      </div></div>`;
    }
    return `<div class="ff">${title}<div class="ff-opts">${vals.map((v) =>
      `<button type="button" class="fchip" data-a="tenum" data-id="${id}" data-i="${i}" data-v="${esc(v)}" aria-pressed="${sel.includes(v)}">${esc(v)}</button>`).join("")}</div></div>`;
  }
  const [a, b, type] = c.filter === "num" ? ["min", "max", "number"] : ["from", "to", "date"];
  const r = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return `<div class="ff">${title}<div class="ff-range">
    <input class="ff-in" type="${type}" data-trange="${id}|${i}|${a}" value="${esc(r[a] ?? "")}" placeholder="от" aria-label="${esc(c.label)}: от" ${r[b] ? `max="${esc(r[b])}"` : ""}><span>—</span>
    <input class="ff-in" type="${type}" data-trange="${id}|${i}|${b}" value="${esc(r[b] ?? "")}" placeholder="до" aria-label="${esc(c.label)}: до" ${r[a] ? `min="${esc(r[a])}"` : ""}></div></div>`;
}

/* ── Таблица со страницами (DataTable.tsx): клик по строке открывает запись ── */
const tables = {};
let flashReq = null;   // { id, key } — подсветить строку после сохранения
function dataTable(id, cols, rows, base, { rowKey, title = "", onRow = null } = {}) {
  tables[id] = { rows, rowKey, onRow };
  const s = ts(id);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(s.page, pages);
  const shown = rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const cw = colWidths(cols, base.length ? base : rows, pageAvail());
  const nw = cols.map((c, j) => shown.every((r) => !/\s/.test(shownOf(c, r))) || cw.short[j]);
  const so = s.sort;
  const head = cols.map((c, i) => (c.field
    ? `<th class="${c.className ?? ""} sortable" data-a="tsort" data-id="${id}" data-i="${i}" title="Сортировать" aria-sort="${so?.i === i ? (so.dir > 0 ? "ascending" : "descending") : "none"}">${c.label}<span class="sort-ic">${so?.i === i ? (so.dir > 0 ? "↑" : "↓") : ""}</span></th>`
    : `<th class="${c.className ?? ""}">${c.label}</th>`)).join("");
  const body = shown.length
    ? shown.map((r, i) => { const k = esc(rowKey(r));
      return `<tr data-k="${k}" ${onRow ? `class="clickable" data-row="${id}"` : ""} style="--r:${Math.min(i, 14)}">${cols.map((c, j) =>
        `<td class="${c.className ?? ""}${nw[j] ? " nw" : ""}">${c.render ? c.render(r) : esc(shownOf(c, r))}</td>`).join("")}</tr>`; }).join("")
    : `<tr data-k="empty"><td colspan="${cols.length}" class="empty">${icon("search")}<b>Ничего не найдено</b>Измените фильтры или спросите агента</td></tr>`;
  const a = rows.length ? (p - 1) * PAGE_SIZE + 1 : 0, b = Math.min(p * PAGE_SIZE, rows.length);
  const pager = pages > 1 ? `<div class="pager"><span>${a}–${b} из ${rows.length}</span><div class="pages">
      <button data-a="pg" data-id="${id}" data-n="${p - 1}" ${p <= 1 ? "disabled" : ""} aria-label="Предыдущая страница">${icon("left")}</button>
      ${pageButtons(p, pages).map((n) => (n === "…" ? `<span class="gap">…</span>` : `<button data-a="pg" data-id="${id}" data-n="${n}" class="${n === p ? "cur" : ""}">${n}</button>`)).join("")}
      <button data-a="pg" data-id="${id}" data-n="${p + 1}" ${p >= pages ? "disabled" : ""} aria-label="Следующая страница">${icon("right")}</button></div></div>` : "";
  return `<section class="card table-card" data-table="${id}">${title ? `<div class="table-head"><h2>${title}</h2></div>` : ""}
    <div class="table-wrap"><table class="fixed" style="width:${cw.sum.toFixed(1)}px"><colgroup>${cw.widths.map((w) => `<col style="width:${w.toFixed(1)}px">`).join("")}</colgroup>
    <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${pager}</section>`;
}
// Подсветить строку и перейти на её страницу (после сохранения записи)
function applyFlash() {
  if (!flashReq) return;
  const { id, key } = flashReq, tb = tables[id];
  flashReq = null;
  if (!tb) return;
  const i = tb.rows.findIndex((r) => String(tb.rowKey(r)) === String(key));
  if (i < 0) return;
  const p = Math.floor(i / PAGE_SIZE) + 1;
  if (ts(id).page !== p) { ts(id).page = p; render(); }
  requestAnimationFrame(() => {
    const tr = $(`[data-table="${id}"] tr[data-k="${CSS.escape(String(key))}"]`);
    if (!tr) return;
    tr.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" });
    tr.classList.remove("flash"); void tr.offsetWidth; tr.classList.add("flash");
  });
}

/* ── Сегментированный переключатель (ui.tsx) ── */
function seg(action, opts, value, extra = "") {
  const i = Math.max(0, opts.findIndex(([v]) => String(v) === String(value)));
  return `<div class="seg" role="group" style="--n:${opts.length};--i:${i}">${opts.map(([v, l, ic]) =>
    `<button type="button" data-a="${action}" data-v="${esc(v)}" ${extra} aria-pressed="${String(v) === String(value)}">${ic ? icon(ic) : ""}<span>${esc(l)}</span></button>`).join("")}</div>`;
}

/* ── Тосты ── */
function toast(text, bad = false) {
  const el = document.createElement("div");
  el.className = `toast${bad ? " bad" : ""}`;
  el.innerHTML = `<span class="tick">${icon(bad ? "x" : "check")}</span>${esc(text)}`;
  $("#toasts").append(el);
  setTimeout(() => el.classList.add("out"), 2600);
  setTimeout(() => el.remove(), 2900);
}

/* ═════════ ОКНА ═════════
   Стек окон: Esc закрывает только верхнее, клик мимо — только по подложке этого окна.
   Окно — объект { key, label, html(), close(), click(t,e), input(t,e), change(t,e), submit(e), outsideClose, after() } */
const modals = [];
const anyModalOpen = () => modals.length > 0;
function openModal(m) { m.key ||= uid(); modals.push(m); render(); m.opened?.(); return m; }
function closeModal(m) { const i = modals.indexOf(m); if (i >= 0) modals.splice(i, 1); render(); }
function renderModals() {
  morphInto($("#modals"), modals.map((m, i) => `<div class="modal-scrim" role="presentation" data-m="${i}" data-k="${m.key}">
    <div class="modal-box" role="dialog" aria-modal="true" aria-label="${esc(m.label || "")}">${m.html()}</div></div>`).join(""));
  modals.forEach((m) => m.after?.());
}

// Подтверждение (удаление и т. п.)
function confirmDialog({ title, text = "", confirm, danger = false, onConfirm, busyMs = 350 }) {
  const m = { label: title, busy: false,
    html: () => `<div class="dialog confirm"><span class="dialog-ico${danger ? " danger" : ""}">${icon(danger ? "trash" : "sparkle")}</span>
      <div><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ""}</div>
      <div class="actions"><button class="btn" data-a="cancel">Отменить</button>
        <button class="btn ${danger ? "danger" : "primary"}" data-a="ok" ${m.busy ? "disabled" : ""}>${m.busy ? "Подождите…" : esc(confirm)}</button></div></div>`,
    close: () => closeModal(m),
    async click(el) {
      if (el.dataset.a === "cancel") closeModal(m);
      if (el.dataset.a === "ok") { m.busy = true; render(); await wait(busyMs); closeModal(m); onConfirm(); }
    },
    opened: () => $(`[data-k="${m.key}"] [data-a="ok"]`)?.focus() };
  return openModal(m);
}
// Закрытие формы с несохранёнными изменениями: сохранить, не сохранять или вернуться к форме
function unsavedDialog({ onSave, onDiscard, saveLabel = "Сохранить", title = "Сохранить изменения?", text = "В форме есть несохранённые изменения." }) {
  const m = { label: title,
    html: () => `<div class="dialog confirm"><div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>
      <div class="actions"><button class="btn ghost" data-a="cancel">Отменить</button><span class="spacer"></span>
        <button class="btn" data-a="discard">Не сохранять</button><button class="btn primary" data-a="save">${esc(saveLabel)}</button></div></div>`,
    close: () => closeModal(m),
    click(el) {
      const a = el.dataset.a;
      if (!a) return;
      closeModal(m);
      if (a === "discard") onDiscard();
      if (a === "save") onSave();
    },
    opened: () => $(`[data-k="${m.key}"] [data-a="save"]`)?.focus() };
  return openModal(m);
}

/* ═════════ ФОРМЫ (RecordDialog.tsx, WorkflowDialog.tsx, fields.tsx) ═════════
   Поле: { name, label, kind: text|textarea|int|decimal|date|time|bool|choice|relation, required, hint, wide,
           options() → [{ value, label, sub }] (для choice и relation), filter(o, values), range: [min, max], min/max (для date), locked } */
function checkField(f, value) {
  if (f.kind === "bool") return undefined;
  const v = String(value ?? "").trim();
  if (!v) return f.required ? "Заполните поле" : undefined;
  if (f.kind === "int" || f.kind === "decimal") {
    const n = Number(v.replace(",", "."));
    if (Number.isNaN(n)) return "Введите число";
    if (f.kind === "int" && !Number.isInteger(n)) return "Введите целое число";
    if (f.range && (n < f.range[0] || n > f.range[1])) return `Допустимо от ${String(f.range[0]).replace(".", ",")} до ${String(f.range[1]).replace(".", ",")}`;
    if (n < 0) return "Значение не может быть отрицательным";
  }
  return undefined;
}

/* opts: { title, subtitle, note (текст или (m) → html), fields, values, base, submitLabel, busyLabel, cleanDisabled, onSubmit(values) → { toast, flash },
           onDelete, extra(m) → html, extraClick(el, m), checks(values), derive(changed, values), unsaved: { title, text, saveLabel } } */
function formDialog(opts) {
  const base = opts.base ?? Object.fromEntries(opts.fields.map((f) => [f.name, f.kind === "bool" ? false : ""]));
  const m = { label: opts.title, values: { ...base, ...opts.values }, base: { ...base }, errors: {}, err: null, busy: false,
    lk: null, lq: "", lhi: 0, outsideClose: false };
  const fields = () => opts.fields;
  m.dirty = () => (opts.cleanDisabled
    ? fields().some((f) => m.values[f.name] !== m.base[f.name])
    : fields().some((f) => m.values[f.name] !== m.base[f.name] && m.values[f.name] !== "" && m.values[f.name] !== false));
  m.close = () => {
    if (m.dirty() && !m.busy) unsavedDialog({ ...(opts.unsaved ?? {}), onSave: () => m.save(), onDiscard: () => closeModal(m) });
    else closeModal(m);
  };
  m.set = (name, v) => {
    delete m.errors[name];
    m.values = { ...m.values, [name]: v };
    Object.assign(m.values, opts.derive?.(name, m.values) ?? {});
  };
  m.validate = () => {
    const e = {};
    for (const f of fields()) { const msg = f.locked ? undefined : checkField(f, m.values[f.name]); if (msg) e[f.name] = msg; }
    for (const [n, msg] of Object.entries(opts.checks?.(m.values) ?? {})) if (msg && !e[n]) e[n] = msg;
    m.errors = e;
    const first = Object.keys(e)[0];
    if (first) requestAnimationFrame(() => $(`[data-k="${m.key}"] [data-field="${first}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    return !first;
  };
  m.save = async () => {
    m.lk = null;
    for (const f of fields()) if ((!f.kind || f.kind === "text" || f.kind === "textarea") && typeof m.values[f.name] === "string") m.values[f.name] = clip(m.values[f.name]);
    if (!m.validate()) return render();
    m.busy = true; m.err = null; render();
    await wait(450);   // как запрос к серверу
    try {
      const res = opts.onSubmit(m.values) || {};
      closeModal(m);
      if (res.toast) toast(res.toast);
      if (res.flash) { flashReq = res.flash; render(); }
    } catch (e) {
      // Ошибка с кодом и полем (details.field) — под этим полем; без поля — внизу формы
      if (e.code && e.field && fields().some((f) => f.name === e.field)) m.errors = { ...m.errors, [e.field]: e };
      else m.err = e.code ? e : e.message;
      m.busy = false; render();
    }
  };
  m.html = () => {
    const dis = m.busy;
    const grid = fields().map((f) => fieldHtml(m, f, dis)).join("");
    const canSave = !opts.cleanDisabled || m.dirty();
    return `<form class="dialog form-dialog" data-form novalidate>
      <div class="form-head"><div><h3>${esc(opts.title)}</h3>${opts.subtitle ? `<p>${esc(opts.subtitle)}</p>` : ""}</div>
        <button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
      <div class="form-body">${typeof opts.note === "function" ? opts.note(m) : opts.note ? `<div class="form-note" data-k="note">${esc(opts.note)}</div>` : ""}
        <div class="form-grid" data-k="grid">${grid}</div>${m.err ? `<p class="form-error" role="alert" data-k="err">${errHtml(m.err)}</p>` : ""}</div>
      <div class="actions">${opts.onDelete ? `<button type="button" class="btn sm danger" data-a="delete" ${dis ? "disabled" : ""}>${icon("trash")}Удалить</button>` : ""}
        ${opts.extra ? opts.extra(m) : ""}<span class="spacer"></span>
        <button class="btn primary" ${dis || !canSave ? "disabled" : ""}>${m.busy ? opts.busyLabel : opts.submitLabel}</button></div></form>`;
  };
  m.submit = (e) => { e.preventDefault(); m.save(); };
  m.click = (el, e) => {
    const a = el.dataset.a;
    if (a !== "lkopen" && a !== "lkpick" && a !== "lkclose" && a !== "lkclear" && m.lk && !e.target.closest(".lookup")) { m.lk = null; render(); }
    if (a === "close") m.close();
    else if (a === "delete") confirmDialog({ title: "Удалить запись?", text: "Это действие нельзя отменить.", confirm: "Удалить", danger: true,
      onConfirm: () => {
        try { opts.onDelete(); closeModal(m); toast("Запись удалена"); } catch (err) { m.err = err.message; render(); }
      } });
    else if (a === "lkopen") { if (!m.busy && !el.dataset.dis) { m.lk = el.dataset.name; m.lq = ""; m.lhi = 0; render(); $(`[data-k="${m.key}"] [data-lq]`)?.focus(); } }
    else if (a === "lkclose") { m.lk = null; render(); }
    else if (a === "lkclear") { e.stopPropagation(); m.set(el.dataset.name, ""); m.lk = null; render(); }
    else if (a === "lkpick") { m.set(m.lk, el.dataset.v); m.lk = null; render(); }
    else opts.extraClick?.(el, m, e);
  };
  m.input = (el) => {
    if (el.dataset.lq != null) { m.lq = el.value; m.lhi = 0; render(); return; }
    if (el.dataset.f) { m.set(el.dataset.f, el.type === "checkbox" ? el.checked : el.value); render(); }
  };
  m.change = m.input;
  m.keydown = (e) => {
    if (e.target.dataset.lq == null) return false;
    const list = lookupShown(m, fields().find((f) => f.name === m.lk));
    if (e.key === "ArrowDown") { e.preventDefault(); m.lhi = Math.min(m.lhi + 1, list.length - 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); m.lhi = Math.max(m.lhi - 1, 0); }
    else if (e.key === "Enter") { e.preventDefault(); if (list[m.lhi]) m.set(m.lk, String(list[m.lhi].value)); m.lk = null; }
    else if (e.key === "Tab") m.lk = null;
    else return false;
    render();
    $(`[data-k="${m.key}"] .lookup-opt.hi`)?.scrollIntoView({ block: "nearest" });
    return true;
  };
  m.esc = () => { if (m.lk) { m.lk = null; render(); return true; } return false; };
  // Список — поверх окна (position: fixed), чтобы его не обрезала прокрутка; не помещается снизу — открывается вверх
  m.after = () => {
    const list = $(`[data-k="${m.key}"] .lookup-list`);
    if (!list) return;
    const r = list.parentElement.getBoundingClientRect();
    const below = innerHeight - r.bottom - 12, above = r.top - 12, up = below < 220 && above > below;
    Object.assign(list.style, { position: "fixed", left: r.left + "px", width: r.width + "px", right: "auto", maxHeight: Math.min(280, up ? above : below) + "px",
      top: up ? "auto" : r.bottom + 6 + "px", bottom: up ? innerHeight - r.top + 6 + "px" : "auto" });
  };
  return openModal(m);
}
const optionsOf = (m, f) => (f.options?.() ?? []).filter((o) => !f.filter || f.filter(o, m.values) || String(o.value) === String(m.values[f.name]));
function lookupShown(m, f) {
  if (!f) return [];
  const n = norm(m.lq.trim()), opts = optionsOf(m, f);
  return (n ? opts.filter((o) => norm(`${o.label} ${o.sub ?? ""}`).includes(n)) : opts).slice(0, 200);
}
function fieldHtml(m, f, busy) {
  const v = m.values[f.name] ?? "", id = `f-${m.key}-${f.name}`, dis = busy || f.locked;
  const err = m.errors[f.name];
  if (f.kind === "bool") {
    return `<label class="check form-check" ${f.hint ? `title="${esc(f.hint)}"` : ""}><input type="checkbox" data-f="${f.name}" ${v ? "checked" : ""} ${dis ? "disabled" : ""}><span>${esc(f.label)}</span></label>`;
  }
  let input;
  if (f.kind === "relation") input = lookupHtml(m, f, v, id, dis);
  else if (f.kind === "choice") {
    input = `<select id="${id}" class="select" data-f="${f.name}" ${dis ? "disabled" : ""}>${!f.required || v === "" ? `<option value="">—</option>` : ""}
      ${f.options().map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
  } else if (f.kind === "textarea") {
    input = `<textarea id="${id}" class="text-input textarea" data-f="${f.name}" rows="3" ${dis ? "disabled" : ""}>${esc(v)}</textarea>`;
  } else {
    const type = { int: "number", decimal: "number", date: "date", time: "time" }[f.kind] ?? "text";
    input = `<input id="${id}" class="text-input" type="${type}" data-f="${f.name}" value="${esc(v)}" ${f.kind === "decimal" ? 'step="0.01"' : f.kind === "int" ? 'step="1"' : ""} ${f.min ? `min="${f.min}"` : ""} ${f.max ? `max="${f.max}"` : ""} ${dis ? "disabled" : ""}>`;
  }
  return `<div class="field form-field${f.kind === "textarea" || f.wide ? " wide" : ""}${err ? " invalid" : ""}" data-field="${f.name}">
    <label for="${id}">${esc(f.label)}${f.required ? `<i class="req" aria-label="обязательное">*</i>` : ""}</label>${input}
    ${err ? `<small class="field-error" role="alert">${errHtml(err)}</small>` : f.hint && f.kind !== "choice" ? `<small class="hint">${esc(f.hint)}</small>` : ""}</div>`;
}
// Выпадающий список с поиском по связанной таблице: закрыт — выбранное значение целиком, открыт — строка поиска
function lookupHtml(m, f, value, id, dis) {
  const all = f.options() ?? [];
  const cur = all.find((o) => String(o.value) === String(value));
  const shownValue = cur?.label ?? (value ? String(value) : "");
  if (m.lk === f.name && !dis) {
    const list = lookupShown(m, f);
    return `<div class="lookup"><div class="lookup-in text-input open">
        <input id="${id}" data-lq="1" value="${esc(m.lq)}" placeholder="${esc(shownValue || "Выберите…")}" autocomplete="off">
        <button type="button" class="lookup-toggle open" aria-label="Свернуть список" data-a="lkclose">${icon("down").replace('class="ic"', 'class="ic lookup-caret"')}</button></div>
      <div class="lookup-list" role="listbox">${!list.length ? `<div class="lookup-empty">Ничего не найдено</div>` : list.map((o, i) =>
        `<button type="button" role="option" data-k="${esc(o.value)}" data-a="lkpick" data-v="${esc(o.value)}" aria-selected="${String(o.value) === String(value)}" class="lookup-opt${i === m.lhi ? " hi" : ""}"><b>${esc(o.label)}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ""}</button>`).join("")}</div></div>`;
  }
  return `<div class="lookup"><div class="lookup-in lookup-closed text-input${dis ? " disabled" : ""}" data-a="lkopen" data-name="${f.name}" ${dis ? 'data-dis="1"' : ""}>
      <input id="${id}" class="lookup-focus" value="${value ? "1" : ""}" data-lkfocus="${f.name}" aria-label="${esc(shownValue || "Выберите…")}" ${dis ? "disabled" : ""} tabindex="0" readonly>
      <div class="lookup-value">${shownValue ? `<b>${esc(shownValue)}</b>${cur?.sub ? `<small>${esc(cur.sub)}</small>` : ""}` : `<span class="lookup-ph">Выберите…</span>`}</div>
      ${value && !dis && !f.required ? `<button type="button" class="lookup-clear" aria-label="Очистить" data-a="lkclear" data-name="${f.name}">${icon("x")}</button>` : ""}
      ${icon("down").replace('class="ic"', 'class="ic lookup-caret"')}</div></div>`;
}

/* ═════════ РЕНДЕР: точечное обновление DOM, чтобы переходы CSS отыгрывали плавно ═════════ */
function morph(a, b) {
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  if (a.tagName === "INPUT") {
    if (a.type === "checkbox") a.checked = b.hasAttribute("checked");
    else if (a !== document.activeElement) a.value = b.getAttribute("value") ?? "";
    return;
  }
  // Поле с курсором переписываем, только если текст в состоянии другой (например, очищен после отправки) — иначе прыгнет курсор
  if (a.tagName === "TEXTAREA") { if (a.value !== b.textContent) a.value = b.textContent; return; }
  const v = a.tagName === "SELECT" ? b.value : null;
  morphChildren(a, b);
  if (v != null) a.value = v;
}
// Как в React: дочерние элементы с data-k сопоставляются по ключу (переставляются, а не пересоздаются),
// без ключа — по порядку. Поэтому новый блок рядом не пересоздаёт соседей и их анимации не проигрываются заново
function morphChildren(a, b) {
  const old = [...a.childNodes], byKey = new Map(), plain = [];
  for (const o of old) (o.nodeType === 1 && o.dataset.k != null ? byKey.set(o.dataset.k, o) : plain.push(o));
  let pi = 0;
  const want = [...b.childNodes].map((n) => {
    let o;
    if (n.nodeType === 1 && n.dataset.k != null) { o = byKey.get(n.dataset.k); byKey.delete(n.dataset.k); }
    else o = plain[pi++];
    if (!o || o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) return n;
    if (o.nodeType === 1) morph(o, n); else if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue;
    return o;
  });
  want.forEach((d, i) => { const cur = a.childNodes[i]; if (cur !== d) a.insertBefore(d, cur ?? null); });
  while (a.childNodes.length > want.length) a.lastChild.remove();
}
function morphInto(el, html) {
  const tpl = document.createElement(el.tagName);
  tpl.innerHTML = html;
  morphChildren(el, tpl);
}
