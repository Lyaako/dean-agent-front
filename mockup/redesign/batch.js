/* ═════════ ПАКЕТНОЕ ИЗМЕНЕНИЕ ОТ АГЕНТА ═════════
   Когда агент меняет сразу много записей: в чате — сводка, в окне — сводка последствий, список с галочками
   (Shift+клик отмечает диапазон, как в проводнике), фильтры и поиск. Применяются только отмеченные строки —
   все вместе или ни одной. У каждой ошибки и пометки есть код; сообщение всегда отвечает:
   что случилось, что с данными, что делать, — и показывает подробности для IT-отдела. Загружается после roles.js. */

const BATCH_PREVIEW = 50;          // столько строк показываем сразу, остальные — по кнопке
const UNDO_MINUTES = 15;           // столько времени после применения пакет можно отменить
let batchN = 0;
// Сбои сервера в макете не случаются сами. Чтобы посмотреть их вид, в консоли браузера: BATCH_SIM = "AP-04"
// (AP-01, AP-02, AP-03, AP-04, AP-05, AP-05ok, AP-06, CH-04, CH-05); пусто — без сбоя
window.BATCH_SIM = "";

/* ── Каталог кодов: этап (AG — подготовка агентом, RW — проверка строки, CH — изменения, пока окно открыто,
   AP — применение, UN — отмена, XX — неизвестное), заголовок и что с данными ── */
const DATA_NONE = "Ничего не изменилось.", DATA_DONE = "Изменения применены.", DATA_UNKNOWN = "Неизвестно, применились ли изменения.";
const ERRORS = {
  "AG-01": { title: "Нет прав на это действие" },
  "AG-02": { title: "Слишком много записей для одного пакета" },
  "AG-03": { title: "Не удалось прочитать данные" },
  "AG-04": { title: "Связь с агентом прервалась" },
  "RW-01": { title: "Значение не проходит правила базы" },
  "RW-02": { title: "Недопустимый переход" },
  "RW-03": { title: "Запись закрыта для изменений" },
  "RW-04": { title: "Нет доступа к записи" },
  "RW-05": { title: "Запись удалена" },
  "RW-06": { title: "Противоречие внутри пакета" },
  "CH-01": { title: "Уже сделано" },
  "CH-02": { title: "Конфликт: запись изменили по-другому" },
  "CH-03": { title: "Запись удалили" },
  "CH-04": { title: "Пакет устарел", data: DATA_NONE },
  "CH-05": { title: "Сессия истекла", data: DATA_NONE },
  "AP-01": { title: "Запись изменилась во время применения", data: DATA_NONE },
  "AP-02": { title: "Запись не прошла проверку базы данных", data: DATA_NONE },
  "AP-03": { title: "У вас больше нет прав на эти изменения", data: DATA_NONE },
  "AP-04": { title: "Сервер не смог применить изменения", data: DATA_NONE },
  "AP-05": { title: "Нет ответа от сервера", data: DATA_UNKNOWN },
  "AP-06": { title: "Пакет уже был применён", data: DATA_DONE },
  "UN-01": { title: "Запись изменили после применения — не отменяется" },
  "UN-02": { title: "Срок отмены истёк" },
  "XX-00": { title: "Неизвестная ошибка", data: DATA_UNKNOWN },
};
const codeTag = (code) => `<span class="err-code">${code}</span>`;
// Ошибка — объект с кодом; всё, что не наше, превращается в XX-00, а не в тишину
const bErr = (code, extra = {}) => Object.assign(new Error(ERRORS[code].title), { code, ...extra });
const asErr = (e) => (e?.code && ERRORS[e.code] ? e : bErr("XX-00", { text: String(e?.message ?? e), todo: "Обратитесь в IT-отдел и сообщите код и номер пакета." }));
const stamp = () => `${fmtDate(TODAY)} ${new Date().toTimeString().slice(0, 8)}`;

/* ── Строка пакета: { id, record, sub, field, before, after, rule: [код RW, текст] | null, warn: [текст, вид] | null,
   now() — значение в данных сейчас (GONE — запись удалена), alter() — запись меняет другой человек, apply(), undo() } ── */
const GONE = Symbol("удалена");
function rowState(it) {
  if (it.rule) return { code: it.rule[0], text: it.rule[1], kind: "bad", blocked: true };
  if (!it.done && it.now) {
    const cur = it.now();
    if (cur === GONE) return { code: "CH-03", text: "Запись удалили", kind: "bad", blocked: true };
    if (String(cur ?? "") !== String(it.before ?? "")) {
      return String(cur ?? "") === String(it.after ?? "")
        ? { code: "CH-01", text: `Уже сделано${it.changedBy ? ` · ${it.changedBy}` : ""}`, kind: "muted", blocked: true }
        : { code: "CH-02", text: `Конфликт: сейчас «${valText(cur)}»${it.changedBy ? ` · ${it.changedBy}` : ""}`, kind: "warn", blocked: true };
    }
  }
  return it.warn ? { code: null, text: it.warn[0], kind: it.warn[1], blocked: false } : null;
}
const blocked = (it) => !!rowState(it)?.blocked;
function makeBatch({ explanation, table, summary, items, reason, prompt }) {
  const no = `П-${String(++batchN).padStart(3, "0")}`;
  items.forEach((it, i) => { it.id = i; });
  return { batch: true, no, explanation, table, summary, items, reason, prompt, operation: "UPDATE", rows: [], appliedIds: [],
    picked: new Set(items.filter((it) => !blocked(it)).map((it) => it.id)) };
}
const warnCount = (p) => p.items.filter((it) => rowState(it)).length;
const valText = (v) => (v == null || v === "" ? "—" : String(v));
const nRec = (n) => `${n} ${plural(n, "запись", "записи", "записей")}`;

/* ── Карточка в чате: только сводка и состояние ── */
function batchCard(pid) {
  const p = PROPOSALS[pid], w = warnCount(p);
  const st = { approved: badge(`Применено ${p.appliedIds.length} из ${p.items.length}`, "ok"), rejected: badge("Отклонено", "muted"), undone: badge("Отменено", "muted"),
    failed: badge(`Не применено · ${p.lastCode}`, "bad"), unknown: badge("Итог неизвестен · AP-05", "warn") }[p.status] ?? "";
  const undoLeft = p.status === "approved" ? UNDO_MINUTES * 6e4 - (Date.now() - p.appliedAt) : 0;
  return `<div class="proposal-card batch-card">${icon("sparkle")}<div><b>${esc(p.explanation)}</b>
      <small>${esc(p.table)} · ${nRec(p.items.length)}${w && p.status === "pending" ? ` · <span class="warn-t">${icon("alert")}${w} ${plural(w, "требует", "требуют", "требуют")} внимания</span>` : ""}
      ${p.status === "approved" && undoLeft <= 0 ? ` · <span title="Отменить можно было в течение ${UNDO_MINUTES} минут. Вернуть прежнее можно новой просьбой агенту">отмена недоступна ${codeTag("UN-02")}</span>` : ""}</small></div>
    ${st}${undoLeft > 0 ? `<button class="btn sm ghost" data-a="batch-undo" data-id="${pid}">${icon("refresh")}Отменить</button>` : ""}
    <button class="btn sm soft go" data-a="proposal" data-id="${pid}">${p.status === "approved" ? "Открыть" : "Проверить изменения"}${icon("arrow")}</button></div>`;
}

/* ── Блок ошибки: что случилось · что с данными · что делать · подробности для IT (всегда развёрнуты) ── */
function errorBlock(err, p, actions = "") {
  const e = asErr(err), meta = ERRORS[e.code];
  const kind = e.kind ?? (["AP-05", "CH-04", "CH-05"].includes(e.code) ? "warn" : e.code === "AP-06" ? "info" : "bad");
  const details = `Код ${e.code} · Пакет ${p.no} · ${e.at ?? stamp()} · ${auth.login}${e.http ? ` · HTTP ${e.http}` : ""}${e.row ? ` · строка «${e.row}»` : ""}`;
  return `<div class="batch-error ${kind}" role="alert">${icon(kind === "info" ? "check" : kind === "checking" ? "clock" : "alert")}<div>
    <b>${esc(e.headline ?? meta.title)}</b>${e.text ? `<p>${esc(e.text)}</p>` : ""}
    ${(e.data ?? meta.data) && (e.data ?? meta.data).replace(/\.$/, "") !== (e.headline ?? meta.title) ? `<p class="err-data">${esc(e.data ?? meta.data)}</p>` : ""}
    ${e.todo ? `<p>${esc(e.todo)}</p>` : ""}${actions ? `<div class="err-acts">${actions}</div>` : ""}
    <div class="err-details"><span>${esc(details)}</span><button type="button" class="btn sm ghost" data-a="b-copy" data-v="${esc(details)}">${icon("copy")}Скопировать</button></div>
  </div></div>`;
}

/* ── Окно подтверждения пакета ── */
function batchDialog(pid) {
  const p = PROPOSALS[pid];
  const m = { label: "Пакетное изменение от агента", outsideClose: false, reason: "", busy: null, error: p.lastError ?? null, filter: "all", q: "", all: false, last: null, seen: new Set() };
  if (window.BATCH_SIM === "CH-04" && p.status === "pending") p.expired = /Ведомость/.test(p.table) ? "Ведомость закрыл деканат — баллы в неё больше не вносятся." : "С момента подготовки прошло больше суток — данные могли измениться.";
  // Отклонённый, отменённый или неприменившийся пакет можно открыть и применить; устаревший — только подготовить заново
  const can = () => ["pending", "rejected", "undone", "failed"].includes(p.status) && !p.expired;
  const shown = () => p.items.filter((it) => (m.filter === "picked" ? p.picked.has(it.id) : m.filter === "warn" ? rowState(it) : true)
    && (!m.q || norm(`${it.record} ${it.sub ?? ""}`).includes(norm(m.q))));
  m.html = () => {
    // Строки, которые стали недоступны, пока окно открыто, снимаются — и об этом говорится над кнопками
    p.items.filter((it) => blocked(it) && p.picked.has(it.id) && it.changedBy).forEach((it) => { p.picked.delete(it.id); m.seen.add(it.id); });
    const list = shown(), rows = m.all ? list : list.slice(0, BATCH_PREVIEW), n = p.picked.size, ok = m.reason.trim().length >= REASON_MIN;
    const pickable = list.filter((it) => !blocked(it)), allOn = pickable.length && pickable.every((it) => p.picked.has(it.id));
    const oneField = new Set(p.items.map((it) => it.field)).size === 1 ? p.items[0].field : undefined;
    const none = !p.items.some((it) => !blocked(it));
    const stateOf = (it) => p.status === "approved" ? (p.appliedIds.includes(it.id) ? badge("Применено", "ok") : badge("Пропущено", "muted")) : "";
    const chip = (v, l, k) => `<button type="button" class="fchip" data-a="b-filter" data-v="${v}" aria-pressed="${m.filter === v}">${l}<span class="n">${k}</span></button>`;
    const note = (it) => { const s = rowState(it); return s ? badge(s.code ? `${s.code} · ${s.text}` : s.text, s.kind) : ""; };
    const changed = [...m.seen].map((id) => p.items[id]);
    return `<div class="dialog form-dialog batch-dialog">
      <div class="form-head"><div><h3>${can() || p.status === "unknown" ? "Применить изменения?" : "Пакетное изменение"}</h3><p>${esc(p.explanation)} · ${esc(p.table)} · пакет ${p.no}</p></div>
        <button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
      <div class="form-body">
        <div class="batch-sum">${icon("sparkle")}<div>${p.summary.map((s) => `<p>${s}</p>`).join("")}${p.reason ? `<small class="hint">Основание агента: ${esc(p.reason)}</small>` : ""}</div></div>
        <div class="batch-tools"><div class="chips">${chip("all", "Все", p.items.length)}${can() ? chip("picked", "Отмечено", n) : ""}${warnCount(p) ? chip("warn", `${icon("alert")}Внимание`, warnCount(p)) : ""}</div>
          <label class="search sm">${icon("search")}<input type="text" data-bq value="${esc(m.q)}" placeholder="Найти запись" aria-label="Найти запись" autocomplete="off"></label></div>
        <div class="batch-list" role="list">
          ${can() ? `<label class="b-row b-head"><input type="checkbox" data-a="b-all" ${allOn ? "checked" : ""} ${none ? "disabled" : ""} aria-label="Отметить все"><span>Отметить все${m.filter !== "all" || m.q ? " найденные" : ""}</span><span class="hint">${oneField ? `${esc(oneField)}: было → стало · ` : ""}Shift+клик — диапазон</span></label>` : ""}
          ${rows.map((it) => { const s = rowState(it);
            return `<div class="b-row${s?.blocked ? " invalid" : ""}${s?.code?.startsWith("CH") ? " stale" : ""}${m.error?.rowId === it.id ? " culprit" : ""}${p.picked.has(it.id) || !can() ? "" : " off"}" role="listitem" data-k="${it.id}">
            ${can() ? `<input type="checkbox" data-a="b-pick" data-id="${it.id}" ${p.picked.has(it.id) ? "checked" : ""} ${s?.blocked ? "disabled" : ""} aria-label="${esc(it.record)}">` : ""}
            <div class="b-rec"><b>${esc(it.record)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</div>
            <div class="b-val">${it.field && oneField === undefined ? `<span class="k">${esc(it.field)}</span>` : ""}${it.before == null || it.before === "" ? "" : `<span class="old">${esc(valText(it.before))}</span>${icon("arrow")}`}<span class="new">${esc(valText(it.after))}</span></div>
            <div class="b-note">${note(it)}${stateOf(it)}</div></div>`; }).join("")}
          ${!list.length ? `<p class="hint b-empty">Ничего не найдено</p>` : ""}
          ${list.length > rows.length ? `<button type="button" class="btn sm ghost b-more" data-a="b-more">Показать ещё ${list.length - rows.length}</button>` : ""}
        </div>
        ${can() ? `<label class="field"><span>Комментарий к решению (не короче ${REASON_MIN} символов)</span>
          <textarea class="text-input textarea" rows="2" data-reason maxlength="2000" placeholder="Например: баллы по ведомости модуля 2">${esc(m.reason)}</textarea></label>` : ""}
        ${p.decision_reason ? `<small class="hint">Комментарий к решению: ${esc(p.decision_reason)}</small>` : ""}
      </div>
      ${p.expired ? errorBlock(bErr("CH-04", { text: p.expired, todo: "Попросите агента подготовить пакет заново по свежим данным." }), p, `<button type="button" class="btn sm" data-a="b-redo">${icon("refresh")}Подготовить заново</button>`) : ""}
      ${!p.expired && m.error ? errorBlock(m.error, p, m.error.actions ?? "") : ""}
      ${!m.error && !p.expired && changed.length ? `<div class="batch-note">${icon("alert")}<span>${changed.length} ${plural(changed.length, "запись изменилась", "записи изменились", "записей изменились")}, пока вы смотрели пакет, — ${plural(changed.length, "снята", "сняты", "сняты")}
        (${[...new Set(changed.map((it) => rowState(it)?.code).filter(Boolean))].join(", ")}).</span><button type="button" class="btn sm ghost" data-a="b-filter" data-v="warn">Показать</button>
        ${changed.some((it) => rowState(it)?.code === "CH-02") ? `<button type="button" class="btn sm ghost" data-a="b-redo">Обновить пакет</button>` : ""}</div>` : ""}
      ${none && can() && !m.error ? `<div class="batch-note">${icon("alert")}<span>Ни одну строку применить нельзя — причины указаны в строках.</span></div>` : ""}
      <div class="actions">${can() ? `${p.status !== "pending" && !m.error ? `<span class="b-was">${{ rejected: "Отклонено ранее", undone: "Отменено ранее", failed: "Не применилось ранее" }[p.status]} — можно применить заново</span>` : ""}
        <button class="btn ghost danger-text${p.status !== "pending" ? " hidden" : ""}" data-a="reject" ${!ok || m.busy ? "disabled" : ""}>${m.busy === "reject" ? "Отклоняем…" : "Отклонить"}</button>
        <span class="spacer"></span><button class="btn" data-a="close">Позже</button>
        <button class="btn primary" data-a="approve" ${!ok || !n || m.busy || m.error?.code === "AP-03" ? "disabled" : ""}>${m.busy === "approve" ? "Применяем…" : `Применить ${n} из ${p.items.length}`}</button>` : ""}</div></div>`;
  };
  m.close = () => closeModal(m);
  m.input = (el) => {
    if (el.dataset.reason != null) { m.reason = el.value; render(); }
    if (el.dataset.bq != null) { m.q = el.value; render(); }
  };
  // Повторить ту же просьбу агенту — он подготовит пакет по свежим данным
  const redo = () => { closeModal(m); if (!p.prompt) return; chat.open = true; chat.texts[draftKey()] = p.prompt; render(); submitChat(); };
  m.click = async (el, e) => {
    const a = el.dataset.a;
    if (a === "close") return closeModal(m);
    if (a === "b-copy") { try { await navigator.clipboard.writeText(el.dataset.v); toast("Скопировано — передайте в IT-отдел"); } catch { toast("Не удалось скопировать — выделите текст вручную", true); } return; }
    if (a === "b-redo") return redo();
    if (a === "b-filter") { m.filter = el.dataset.v; m.all = false; return render(); }
    if (a === "b-more") { m.all = true; return render(); }
    if (a === "b-all") { const on = el.checked; shown().filter((it) => !blocked(it)).forEach((it) => (on ? p.picked.add(it.id) : p.picked.delete(it.id))); return render(); }
    if (a === "b-pick") {
      // Shift+клик: всем строкам между прошлым и этим кликом ставится то же состояние, что у этой
      const id = +el.dataset.id, on = el.checked, list = shown();
      const ids = e?.shiftKey && m.last != null ? (() => { const i = list.findIndex((x) => x.id === m.last), j = list.findIndex((x) => x.id === id);
        return i < 0 || j < 0 ? [id] : list.slice(Math.min(i, j), Math.max(i, j) + 1).filter((x) => !blocked(x)).map((x) => x.id); })() : [id];
      ids.forEach((x) => (on ? p.picked.add(x) : p.picked.delete(x)));
      m.last = id; return render();
    }
    if (a === "b-relogin") { m.busy = "approve"; render(); await wait(700); m.busy = null; m.error = null; window.BATCH_SIM = ""; toast("Вы снова вошли — отметки и комментарий сохранены"); return render(); }
    if (a === "b-check") return checkOutcome();
    if (a === "b-drop") { p.picked.delete(m.error.rowId); m.error = null; window.BATCH_SIM = ""; return approve(); }
    if (a === "approve") return approve();
    if (a === "reject") {
      m.busy = "reject"; render(); await wait(500);
      Object.assign(p, { status: "rejected", decision_reason: m.reason.trim() }); closeModal(m); toast("Пакет отклонён");
    }
  };
  const fail = (err) => {
    const e = asErr(err);
    e.at = stamp();
    e.actions = { "AP-01": `<button type="button" class="btn sm" data-a="b-drop">Снять строку и применить остальные</button><button type="button" class="btn sm ghost" data-a="b-redo">Обновить пакет</button>`,
      "AP-02": `<button type="button" class="btn sm" data-a="b-drop">Снять строку и применить остальные</button>`,
      "AP-04": `<button type="button" class="btn sm" data-a="approve">${icon("refresh")}Повторить</button>`,
      "AP-05": `<button type="button" class="btn sm" data-a="b-check">${icon("refresh")}Проверить ещё раз</button>`,
      "CH-05": `<button type="button" class="btn sm" data-a="b-relogin">Войти снова</button>`,
      "XX-00": `<button type="button" class="btn sm" data-a="approve">${icon("refresh")}Повторить</button>` }[e.code] ?? "";
    m.error = e;
    if (e.rowId != null) { m.filter = "all"; m.q = ""; requestAnimationFrame(() => $(`[data-k="${m.key}"] .b-row.culprit`)?.scrollIntoView({ block: "center", behavior: "smooth" })); }
    if (["AP-01", "AP-02", "AP-03", "AP-04", "XX-00"].includes(e.code)) Object.assign(p, { status: "failed", lastCode: e.code });
  };
  const succeed = (note = "") => {
    Object.assign(p, { status: "approved", decision_reason: m.reason.trim(), lastError: null });
    closeModal(m);
    toast(`Применено ${nRec(p.appliedIds.length)} · пакет ${p.no}${note}`);
  };
  // AP-05: ответ потерян — спрашиваем сервер, что с пакетом (номер пакета — ключ повтора, задвоения не будет)
  async function checkOutcome() {
    m.error = bErr("AP-05", { headline: "Проверяем, применились ли изменения…", kind: "checking", data: "Пока неизвестно.", text: "Ответ сервера потерялся. Спрашиваем сервер, что с пакетом." });
    m.busy = "approve"; render(); await wait(1500); m.busy = null;
    if (window.BATCH_SIM === "AP-05ok") { window.BATCH_SIM = ""; applyBatch(p); return succeed(" · ответ потерялся, но проверка подтвердила"); }
    window.BATCH_SIM = "AP-05ok";   // в макете: следующая проверка удаётся
    Object.assign(p, { status: "unknown", lastCode: "AP-05" });
    fail(bErr("AP-05", { headline: "Неизвестно, применились ли изменения", text: "Ответ сервера потерялся, проверить итог тоже не удалось.",
      todo: "Не применяйте пакет повторно и не меняйте эти записи вручную — это может задвоить изменения. Нажмите «Проверить ещё раз»; если не поможет — обратитесь в IT-отдел и сообщите код и номер пакета." }));
    p.lastError = m.error; render();
  }
  async function approve() {
    m.busy = "approve"; m.error = null; render();
    await wait(700);
    try {
      const sim = window.BATCH_SIM, picked = p.items.filter((it) => p.picked.has(it.id));
      if (sim === "CH-05") throw bErr("CH-05", { http: 401, text: "Вы слишком долго не работали в системе.", todo: "Войдите снова — отметки и комментарий сохранятся." });
      if (sim === "AP-03") throw bErr("AP-03", { http: 403, text: "Администратор изменил вашу роль или доступ, пока окно было открыто.", todo: "Обратитесь к администратору." });
      if (sim === "AP-04") throw bErr("AP-04", { http: 503, text: "База данных временно недоступна. Транзакция отменена целиком.", todo: "Нажмите «Повторить» — это безопасно. Если ошибка повторится — обратитесь в IT-отдел и сообщите код и номер пакета." });
      if (sim === "AP-01") { const it = picked[0]; it.alter?.(); throw bErr("AP-01", { http: 409, rowId: it.id, row: it.record, text: `«${it.record}» изменили в момент применения, поэтому весь пакет отменён.`,
        todo: "Снимите эту строку и примените остальные или попросите агента обновить пакет." }); }
      if (sim === "AP-02") { const it = picked.at(-1); throw bErr("AP-02", { http: 422, rowId: it.id, row: it.record, text: `«${it.record}» не прошла проверку базы данных: ${it.dbRule ?? "нарушено ограничение"}.`,
        todo: "Снимите эту строку и примените остальные. Если такая ошибка повторяется — обратитесь в IT-отдел и сообщите код и номер пакета." }); }
      if (sim === "AP-05" || sim === "AP-05ok") { m.busy = null; return checkOutcome(); }
      // Настоящая проверка при применении: каждая отмеченная строка — как при подготовке (версия записи не изменилась)
      const bad = picked.find(blocked);
      if (bad) throw bErr("AP-01", { http: 409, rowId: bad.id, row: bad.record, text: `«${bad.record}» изменили после подготовки пакета, поэтому весь пакет отменён.`, todo: "Снимите эту строку и примените остальные." });
      applyBatch(p);
      if (sim === "AP-06") { window.BATCH_SIM = ""; m.busy = "done"; m.error = bErr("AP-06", { kind: "info", text: "Пакет пришёл на сервер второй раз (двойное нажатие или вторая вкладка). Сервер не стал применять его повторно и вернул итог первого раза." }); render(); await wait(2500); }
      succeed();
    } catch (err) { fail(err); }
    m.busy = null; render();
  }
  openModal(m);
}
// Всё или ничего: проверки — выше, здесь меняем данные и пишем одну запись в журнал на весь пакет
function applyBatch(p) {
  const picked = p.items.filter((it) => p.picked.has(it.id));
  picked.forEach((it) => { it.apply(); it.done = true; });
  Object.assign(p, { appliedIds: picked.map((it) => it.id), appliedAt: Date.now() });
  logAudit(p.table, "UPDATE", `Пакет ${p.no}: ${p.explanation}`, nRec(picked.length), "Чат-агент");
}
// Отмена — тоже пакет: строку, которую изменили после применения, не трогаем (UN-01)
function undoBatch(pid) {
  const p = PROPOSALS[pid];
  if (Date.now() - p.appliedAt >= UNDO_MINUTES * 6e4) { toast("UN-02 · Срок отмены истёк — вернуть прежнее можно новой просьбой агенту", true); return render(); }
  const applied = p.items.filter((it) => p.appliedIds.includes(it.id));
  const moved = applied.filter((it) => it.now && String(it.now() ?? "") !== String(it.after ?? ""));
  confirmDialog({ title: "Отменить пакет?", text: `Вернутся прежние значения у ${nRec(applied.length - moved.length)}.${moved.length ? ` ${nRec(moved.length)} изменили после применения — их не трогаем (UN-01).` : ""} Пакет ${p.no}.`,
    confirm: "Отменить пакет", onConfirm: () => {
      applied.filter((it) => !moved.includes(it)).forEach((it) => { it.undo(); it.done = false; });
      p.status = "undone";
      logAudit(p.table, "UPDATE", `Пакет ${p.no} отменён`, `${nRec(applied.length - moved.length)} — прежние значения${moved.length ? `; не отменено ${moved.length} (UN-01)` : ""}`);
      toast(moved.length ? `Отменено ${applied.length - moved.length}, не отменено ${moved.length} · UN-01` : "Пакет отменён"); render();
    } });
}
const proposalDialogBase = proposalDialog;
proposalDialog = (pid) => (PROPOSALS[pid].batch ? batchDialog(pid) : proposalDialogBase(pid));
Object.assign(ACT, { "batch-undo": (el) => undoBatch(el.dataset.id) });

/* ── Сценарии: агент готовит пакет ── */
// Деканат: «переведи все новые заявки в работу»
function requestsBatch(raw, s) {
  const to = /готов/.test(s) ? "Готова к выдаче" : "В работе";
  const from = /просроч/.test(s) ? requests.filter((r) => isOverdue(r) && r.status !== to) : requests.filter((r) => r.status === "Новая");
  if (!from.length) return q(P(/просроч/.test(s) ? "Просроченных заявок нет." : `Новых заявок нет — все уже ${requests.some((r) => r.status === "В работе") ? "в работе или выданы" : "обработаны"}.`));
  const mate = deanStaff.find((x) => x !== ME) ?? deanStaff[0];
  const items = from.map((r) => ({ record: `Заявка № ${r.request_id}`, sub: `${r.document} · ${shortName(r.student)}`, field: "Статус", before: r.status, after: to,
    warn: isOverdue(r) ? ["Просрочена", "bad"] : r.processed_by && r.processed_by !== ME.full_name ? [`Ведёт ${shortName(r.processed_by)}`, "warn"] : null,
    now: () => (requests.includes(r) ? r.status : GONE), dbRule: "переход статуса запрещён для выданных заявок",
    alter() { r.status = "Отклонена"; r.processed_by = mate.full_name; this.changedBy = `изменила ${shortName(mate.full_name)}`; },
    apply() { this.prev = [r.status, r.processed_by]; r.status = to; r.processed_by ||= ME.full_name; }, undo() { [r.status, r.processed_by] = this.prev; } }));
  const over = from.filter(isOverdue).length;
  const batch = makeBatch({ explanation: `${from.length} ${plural(from.length, "заявка", "заявки", "заявок")} → «${to}»`, table: "Заявка на справку", reason: `Запрос сотрудника: «${raw.trim()}»`, prompt: raw.trim(),
    summary: [`${from.length} ${plural(from.length, "заявка перейдёт", "заявки перейдут", "заявок перейдут")} в статус «${esc(to)}», исполнителем там, где его нет, станете вы.`,
      ...(over ? [`${over} из них уже ${plural(over, "просрочена", "просрочены", "просрочены")} — студенты ждут дольше срока.`] : [])], items });
  // Пока сотрудник смотрит пакет, коллеги работают: одну заявку берут в работу (CH-01 — уже сделано), другую отклоняют (CH-02 — конфликт)
  const later = (it, r, ms, fn) => setTimeout(() => { if (!it || it.done || r.status !== it.before) return; fn(); render(); }, REDUCED ? 0 : ms);
  later(items[1], from[1], 6000, () => { from[1].status = to; from[1].processed_by = mate.full_name; items[1].changedBy = `взяла ${shortName(mate.full_name)}`; });
  later(items[3], from[3], 11000, () => { from[3].status = "Отклонена"; from[3].processed_by = mate.full_name; items[3].changedBy = `изменила ${shortName(mate.full_name)}`; });
  return { tool: "propose_sql_change", html: P(`Подготовил пакет: ${from.length} ${plural(from.length, "заявка", "заявки", "заявок")} → «${to}». Проверьте и примените.`), proposal: batch };
}
// Преподаватель: «выставь баллы за модуль 2» — по своей открытой ведомости
function pointsBatch(raw) {
  const sh = sheets.filter((x) => x.examiner === ME.full_name && x.status === "Открыта").find((x) => norm(raw).includes(norm(x.discipline).slice(0, 6)))
    ?? sheets.find((x) => x.examiner === ME.full_name && x.status === "Открыта" && x.stage === "module_2");
  if (!sh) return { html: P("У вас нет открытых ведомостей.") };
  const m1 = sheets.find((x) => x.group_name === sh.group_name && x.discipline === sh.discipline && x.stage === "module_1");
  const items = sh.rows.map((r, i) => {
    const base = m1?.rows.find((x) => x.student_id === r.student_id)?.points ?? 35;
    // Баллы «из файла»: близко к модулю 1; одна строка с опечаткой (больше 54), у одной уже стояли баллы
    const after = i === 3 ? 58 : Math.max(10, Math.min(54, Math.round(base + (h01(`m2|${r.student_id}`) - 0.45) * 14)));
    if (i === 5 && r.points == null) r.points = 35;
    const before = r.points;
    return { record: shortName(r.student), sub: sh.group_name, field: null, before, after,
      rule: after > 54 ? ["RW-01", "Больше 54 — не пройдёт проверку"] : null,
      warn: before != null ? [`Перезапись: было ${before}`, "warn"] : after < 25 ? ["Не аттестован", "bad"] : null,
      now: () => (sh.status === "Открыта" ? r.points : GONE), dbRule: "студента перевели в другую группу — в этой ведомости его больше нет",
      alter() { r.points = 30; this.changedBy = "исправил деканат"; },
      apply() { this.prev = [r.points, r.absent]; r.points = after; r.absent = false; }, undo() { [r.points, r.absent] = this.prev; } };
  });
  const low = items.filter((it) => !it.rule && it.after < 25).length;
  return { tool: "propose_sql_change", html: P(`Подготовил баллы за ${STAGE_NAME[sh.stage].toLowerCase()} по ведомости ${sh.sheet_number} — ${items.length} ${plural(items.length, "студент", "студента", "студентов")}. Проверьте и примените.`),
    proposal: makeBatch({ explanation: `Баллы: ${STAGE_NAME[sh.stage]} · ${sh.discipline}`, table: `Ведомость ${sh.sheet_number} · ${sh.group_name}`, reason: `Запрос преподавателя: «${raw.trim()}»`, prompt: raw.trim(),
      summary: [`${items.length} студентам выставятся баллы за ${STAGE_NAME[sh.stage].toLowerCase()} по «${esc(sh.discipline)}».`,
        ...(low ? [`${low} ${plural(low, "студент получит", "студента получат", "студентов получат")} «не аттестован» и ${plural(low, "попадёт", "попадут", "попадут")} в «Раннее предупреждение».`] : []),
        "Одна строка с ошибкой (больше 54 баллов) применена не будет — исправьте её отдельно."], items }) };
}
const replyRoles = reply;
reply = (raw) => {
  const s = norm(raw);
  if (ROLE === "teacher" && /(выстав|заполн|постав|внеси)/.test(s) && /(модул|всем|групп|ведомост)/.test(s)) return pointsBatch(raw);
  if (["dean_staff", "director"].includes(ROLE) && /(все|всех)/.test(s) && /заявк/.test(s) && CHANGE_WORDS.test(s)) return requestsBatch(raw, s);
  return replyRoles(raw);
};
