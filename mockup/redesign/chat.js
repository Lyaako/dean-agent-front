/* ═════════ ЧАТ С АГЕНТОМ (chat/ChatBar.tsx, useChat.ts) ═════════
   Свёрнут — строка ввода в шапке; развёрнут — список чатов слева и переписка. У каждого чата свой черновик
   (текст и вложения). Агент — заглушка: отвечает по ключевым словам на выдуманных данных, изменения
   предлагает карточкой «Посмотреть изменение» — в базе ничего не меняется, пока сотрудник их не применит. */

const chat = { open: false, listOpen: true, chats: [], activeId: null, busyId: null, status: null, timers: [],
  texts: {}, att: {}, notice: null, queued: false, editing: null, inputH: 40, copied: null, shownCount: -1 };
const ATT = {};            // вложения: id → { id, file, name, thumb, status, error }
const PROPOSALS = {};      // предложения агента: id → { status, explanation, reason, table, operation, rows, effects, apply }
const ATTACH_TYPES = [".pdf", ".docx", ".txt"];
const MAX_FILE_BYTES = 10_000_000, MAX_COUNT = 5, MAX_TOTAL = 20_000_000;
const TOOL_STATUS = { query_deanery: "Ищу в базе деканата…", propose_sql_change: "Готовлю изменение…" };
const activeChat = () => chat.chats.find((c) => c.id === chat.activeId) ?? null;
const draftKey = () => chat.activeId ?? "new";
const draftItems = () => (chat.att[draftKey()] ?? []).map((id) => ATT[id]).filter(Boolean);
const titleFrom = (text) => { const s = text.replace(/\s+/g, " ").trim(); return s.length > 60 ? s.slice(0, 59) + "…" : s || "Новый чат"; };
const touch = (c) => { c.updatedAt = Date.now(); chat.chats.sort((a, b) => b.updatedAt - a.updatedAt); };
const extOf = (name) => (name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();

function chatHtml() {
  const c = activeChat(), busy = !!chat.busyId && chat.busyId === c?.id;
  const items = draftItems(), text = chat.texts[draftKey()] ?? "";
  const msgs = c?.messages ?? [];
  return `<section class="chat${chat.open ? " open" : ""}${busy ? " busy" : ""}" aria-label="Чат с агентом">
    <div class="chat-head">
      <button type="button" class="icon-btn" data-a="chat-list" aria-label="Список чатов" aria-pressed="${chat.listOpen}">${icon("sidebar")}</button>
      <span class="orb"></span><div class="who"><b>Агент деканата</b><small>${esc(c?.title ?? "Новый чат")}</small></div>
    </div>
    <div class="chat-body">
      ${chat.open && chat.listOpen ? chatListHtml() : ""}
      <div class="chat-pane" data-k="pane">
        <div class="messages" id="messages" aria-live="polite"><div class="thread">
          ${!msgs.length ? `<div class="hello" data-k="hello"><span class="orb xl"></span><h2>Чем помочь?</h2></div>` : ""}
          ${msgs.map(messageHtml).join("")}
          ${busy ? `<div class="msg agent" data-k="typing"><span class="orb busy"></span><div class="typing"><div class="dots3"><i></i><i></i><i></i></div>${chat.status ? `<small>${esc(chat.status)}</small>` : ""}</div></div>` : ""}
        </div></div>
        <div class="composer">
          ${items.length ? `<div class="thumbs${items.every((i) => leaving.has(i.id)) ? " out" : ""}" data-k="thumbs">${items.map(composerThumb).join("")}</div>` : ""}
          ${chat.notice ? `<small class="form-error attach-hint" data-k="notice">${esc(chat.notice)}</small>` : ""}
          <form class="input-row" data-chat-form data-k="form">
            <input type="file" id="fileInput" accept="${ATTACH_TYPES.join(",")}" multiple hidden>
            <button type="button" class="icon-btn" title="Прикрепить файлы" aria-label="Прикрепить файлы" data-a="attach">${icon("clip")}</button>
            <textarea rows="1" placeholder="Сообщение…" aria-label="Сообщение" data-chat-input style="height:${chat.inputH}px">${esc(text)}</textarea>
            ${busy ? `<button type="button" class="icon-btn send" title="Остановить" aria-label="Остановить" data-a="stop">${icon("stop")}</button>`
              : chat.queued ? `<button type="button" class="icon-btn send" title="Отправим, когда файлы загрузятся" aria-label="Ждём загрузку файлов" data-a="unqueue"><span class="spinner sm"></span></button>`
              : `<button type="submit" class="icon-btn send" title="Отправить" aria-label="Отправить" ${canSend() ? "" : "disabled"}>${icon("up")}</button>`}
            <button type="button" class="icon-btn toggle" title="${chat.open ? "Свернуть чат" : "Развернуть чат"}" aria-expanded="${chat.open}" data-a="chat-toggle">${icon("down")}</button>
          </form>
        </div>
      </div>
    </div></section>`;
}
const copyBtn = (id) => `<div class="msg-acts"><button type="button" class="msg-act" data-a="copy" data-id="${id}" aria-label="${chat.copied === id ? "Скопировано" : "Копировать"}">${icon(chat.copied === id ? "check" : "copy")}</button></div>`;
function messageHtml(m) {
  if (m.role === "user") {
    return `<div class="msg user" data-k="${m.id}">${m.attachments?.length ? `<div class="thumbs">${m.attachments.map((a) =>
      `<div class="thumb"><button type="button" class="pic" data-a="msg-file" data-id="${a.id}" title="${esc(a.name)}">${picHtml(ATT[a.id]?.thumb ?? { kind: "ext", ext: extOf(a.name).slice(1) })}</button><span class="name">${esc(a.name)}</span></div>`).join("")}</div>` : ""}
      ${m.text ? `<div class="bubble" data-k="bubble">${esc(m.text)}</div>` : ""}${copyBtn(m.id)}</div>`;
  }
  if (m.role === "error") {
    return `<div class="msg agent error" data-k="${m.id}"><span class="dialog-ico danger sm">${icon("alert")}</span>
      <div class="body"><p>${esc(m.text)}</p>${copyBtn(m.id)}</div></div>`;
  }
  return `<div class="msg agent" data-k="${m.id}"><span class="orb"></span><div class="body"><div class="md">${m.html}</div>
    ${(m.proposals ?? []).map((pid) => { const p = PROPOSALS[pid], d = p.status !== "pending" ? p.status : null;
      if (p.batch) return batchCard(pid);   // много записей — сводка (batch.js)
      return `<div class="proposal-card">${icon("sparkle")}<div><b>${esc(p.explanation)}</b><small>${esc(p.table)} · ${p.operation === "INSERT" ? "новая запись" : `полей: ${p.rows.length}`}</small></div>
        ${d ? badge(d === "approved" ? "Применено" : "Отклонено", d === "approved" ? "ok" : "muted") : ""}
        <button class="btn sm soft go" data-a="proposal" data-id="${pid}">${d ? "Открыть" : "Посмотреть изменение"}${icon("arrow")}</button></div>`; }).join("")}
    ${copyBtn(m.id)}</div></div>`;
}
const dayGroup = (ts0) => { const days = Math.floor((new Date(new Date().toDateString()) - new Date(new Date(ts0).toDateString())) / 864e5); return days <= 0 ? "Сегодня" : days === 1 ? "Вчера" : "Ранее"; };
function chatListHtml() {
  const groups = ["Сегодня", "Вчера", "Ранее"].map((g) => [g, chat.chats.filter((c) => dayGroup(c.updatedAt) === g)]).filter(([, l]) => l.length);
  return `<aside class="chat-list" data-k="list" aria-label="Чаты"><button type="button" class="btn sm soft new-chat" data-a="new-chat">${icon("plus")}Новый чат</button>
    ${!chat.chats.length ? `<p class="hint">Здесь будут ваши чаты</p>` : ""}
    ${groups.map(([g, list]) => `<div class="cl-group" data-k="${g}"><small class="ff-l">${g}</small>${list.map((c) => (chat.editing?.id === c.id
      ? `<form class="cl-item editing" data-rename="${c.id}" data-k="${c.id}-edit"><input class="ff-in" data-rename-input value="${esc(chat.editing.title)}"></form>`
      : `<div class="cl-item${c.id === chat.activeId ? " active" : ""}" data-k="${c.id}"><button type="button" class="cl-open" data-a="open-chat" data-id="${c.id}" title="${esc(c.title)}">${icon("message")}<span>${esc(c.title)}</span></button>
        <button type="button" class="cl-act" aria-label="Переименовать" data-a="rename-chat" data-id="${c.id}">${icon("edit")}</button>
        <button type="button" class="cl-act" aria-label="Удалить" data-a="remove-chat" data-id="${c.id}">${icon("trash")}</button></div>`)).join("")}</div>`).join("")}
  </aside>`;
}

/* ── Отправка ── */
// Можно отправить текст, вложения или и то и другое; файлы с ошибкой надо убрать или повторить
function canSend() {
  const items = draftItems(), text = chat.texts[draftKey()] ?? "";
  return (!!text.trim() || items.length > 0) && !items.some((i) => i.status === "error") && !chat.busyId && !chat.queued;
}
const pendingFiles = () => draftItems().some((i) => i.status === "uploading" || i.status === "processing");
function submitChat() {
  if (!canSend()) return;
  chat.open = true;
  // Файлы ещё проверяются — отправим, как только будут готовы
  if (pendingFiles()) { chat.queued = true; render(); } else send();
}
function send() {
  const key = draftKey(), text = (chat.texts[key] ?? "").trim();
  const files = draftItems().filter((i) => i.status === "ready");
  if (!text && !files.length) return;
  const names = files.map((f) => f.name).join(", ");
  let c = activeChat();
  if (!c) { c = { id: uid(), title: titleFrom(text || names), updatedAt: Date.now(), messages: [] }; chat.chats.unshift(c); chat.activeId = c.id; }
  c.messages.push({ id: uid(), role: "user", text, attachments: files.length ? files.map((f) => ({ id: f.id, name: f.name })) : undefined });
  chat.texts[key] = ""; chat.att[key] = []; chat.notice = null; chat.inputH = 40;
  touch(c);
  runAgent(c, text, files);
}
// Ответ агента приходит потоком: сначала «думает», потом инструмент (поиск в базе / подготовка изменения), потом ответ
function runAgent(c, text, files) {
  const res = text ? reply(text) : { html: `<p>Вижу вложения: <b>${esc(files.map((f) => f.name).join(", "))}</b>. Читать содержимое файлов я пока не умею — напишите словами, что с ними сделать.</p>` };
  chat.busyId = c.id; chat.status = "Агент думает…";
  render();
  const later = (ms, fn) => chat.timers.push(setTimeout(fn, REDUCED ? 0 : ms));
  if (res.tool) later(650, () => { chat.status = TOOL_STATUS[res.tool]; render(); });
  later(res.tool ? 1500 + Math.random() * 500 : 900, () => {
    chat.timers = [];
    const pid = res.proposal ? uid() : null;
    if (pid) PROPOSALS[pid] = { status: "pending", decision_reason: null, ...res.proposal };
    c.messages.push({ id: uid(), role: "agent", html: res.html, proposals: pid ? [pid] : [] });
    chat.busyId = null; chat.status = null;
    touch(c); render();
  });
}
function stopAgent() {
  chat.timers.forEach(clearTimeout); chat.timers = [];
  const c = chat.chats.find((x) => x.id === chat.busyId);
  c?.messages.push({ id: uid(), role: "error", text: "Остановлено. Агент мог успеть выполнить запрос на сервере." });
  chat.busyId = null; chat.status = null;
  render();
}
function newChat() { chat.activeId = null; chat.notice = null; render(); $("[data-chat-input]")?.focus(); }

/* ── Вложения: загружаются сразу при прикреплении (загрузка → проверка антивирусом → готово) ── */
function addFiles(files) {
  const key = draftKey(), cur = draftItems(), errors = [];
  let count = cur.length, total = cur.reduce((s, x) => s + x.file.size, 0);
  for (const file of files) {
    if (!ATTACH_TYPES.includes(extOf(file.name))) { errors.push(`«${file.name}»: можно только ${ATTACH_TYPES.join(", ")}`); continue; }
    if (file.size > MAX_FILE_BYTES) { errors.push(`«${file.name}» больше 10 МБ`); continue; }
    if (count >= MAX_COUNT) { errors.push(`Не больше ${MAX_COUNT} файлов в одном сообщении`); break; }
    if (total + file.size > MAX_TOTAL) { errors.push(`Вместе файлы больше ${Math.round(MAX_TOTAL / 1e6)} МБ`); break; }
    count += 1; total += file.size;
    const it = { id: uid(), file, name: file.name, thumb: null, status: "uploading" };
    ATT[it.id] = it;
    (chat.att[key] ||= []).push(it.id);
    upload(it);
    makeThumb(file).then((thumb) => { it.thumb = thumb; render(); });
  }
  chat.notice = errors.length ? errors.join(". ") : null;
  render();
  $("[data-chat-input]")?.focus();
}
// В макете файл с «вирус» в названии не проходит антивирусную проверку — так видно состояние ошибки
function upload(it) {
  it.status = "uploading"; it.error = undefined;
  setTimeout(() => {
    it.status = "processing"; render();
    setTimeout(() => {
      if (/вирус|virus/i.test(it.name)) Object.assign(it, { status: "error", error: "Файл не прошёл антивирусную проверку" });
      else it.status = "ready";
      if (chat.queued && !pendingFiles()) { chat.queued = false; if (!draftItems().some((i) => i.status === "error")) send(); }
      render();
    }, REDUCED ? 0 : 900 + Math.random() * 600);
  }, REDUCED ? 0 : 600);
}
const picHtml = (th, loading) => (!th ? `<span class="pic-inner${loading ? "" : " ext"}">${loading ? "" : "файл"}</span>`
  : th.kind === "img" ? `<img src="${th.src}" alt="">` : th.kind === "text" ? `<div class="page">${esc(th.text)}</div>` : `<div class="ext">${esc(th.ext)}</div>`);
const leaving = new Set();   // файлы, которые сейчас плавно исчезают
const composerThumb = (it) => `<div class="thumb st-${it.status}${leaving.has(it.id) ? " out" : ""}" data-k="${it.id}">
  <button type="button" class="pic${!it.thumb ? " loading" : ""}" data-a="att-open" data-id="${it.id}" title="${esc(it.name)}">${picHtml(it.thumb, !it.thumb)}
    ${it.status === "uploading" || it.status === "processing" ? `<span class="thumb-busy" aria-label="Загружается"><span class="spinner"></span></span>` : ""}
    ${it.status === "error" ? `<span class="thumb-state bad" title="${esc(it.error)}">Ошибка</span>` : ""}</button>
  <span class="name" title="${esc(it.error ?? it.name)}">${esc(it.status === "error" ? it.error : it.name)}</span>
  ${it.status === "error" ? `<button type="button" class="thumb-retry" data-a="att-retry" data-id="${it.id}">${icon("refresh")}Повторить</button>` : ""}
  <button type="button" class="remove" aria-label="Убрать ${esc(it.name)}" data-a="att-remove" data-id="${it.id}">${icon("x")}</button></div>`;

/* Превью: первая страница PDF (pdf.js), текст DOCX (mammoth), текст TXT */
async function renderPdfPage(pdf, n, width) {
  const page = await pdf.getPage(n), v1 = page.getViewport({ scale: 1 }), v = page.getViewport({ scale: width / v1.width });
  const c = document.createElement("canvas");
  c.width = Math.ceil(v.width); c.height = Math.ceil(v.height);
  await page.render({ canvasContext: c.getContext("2d"), viewport: v }).promise;
  return c;
}
async function makeThumb(file) {
  const ext = extOf(file.name);
  try {
    if (ext === ".pdf" && window.pdfjsLib) return { kind: "img", src: (await renderPdfPage(await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise, 1, 168)).toDataURL() };
    if (ext === ".docx" && window.mammoth) return { kind: "text", text: (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value.trim().slice(0, 600) };
    if (ext === ".txt") return { kind: "text", text: (await file.text()).trim().slice(0, 600) };
  } catch { /* повреждённый файл — покажем расширение */ }
  return { kind: "ext", ext: ext.replace(".", "") || "файл" };
}
// Просмотр документа во всё окно: название, крестик и сам документ
function fileViewer(it) {
  const m = { label: it.name, body: null, err: null,
    html: () => `<div class="viewer"><div class="viewer-head"><span>${esc(it.name)}</span><button class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
      <div class="viewer-body${!m.body && !m.err ? " loading" : ""}" data-viewer>${m.err ? `<p class="form-error">${esc(m.err)}</p>` : !m.body ? `<span class="spinner" aria-label="Загружается"></span>` : ""}</div></div>`,
    close: () => closeModal(m),
    click: (el) => { if (el.dataset.a === "close") closeModal(m); },
    after: () => { const host = $(`[data-k="${m.key}"] [data-viewer]`); if (m.body && host && !host.contains(m.body)) { host.replaceChildren(m.body); } } };
  openModal(m);
  (async () => {
    try {
      const ext = extOf(it.name), box = document.createElement("div");
      if (!it.file) throw new Error("Файл недоступен: в макете вложения хранятся только до перезагрузки страницы");
      if (ext === ".pdf") {
        const pdf = await pdfjsLib.getDocument({ data: await it.file.arrayBuffer() }).promise;
        for (let n = 1; n <= Math.min(pdf.numPages, 50); n++) { const h = document.createElement("div"); h.className = "canvas-host"; h.append(await renderPdfPage(pdf, n, 1400)); box.append(h); }
      } else if (ext === ".docx") {
        box.className = "doc html";
        box.innerHTML = (await mammoth.convertToHtml({ arrayBuffer: await it.file.arrayBuffer() })).value;
        box.querySelectorAll("script, iframe, object, embed").forEach((x) => x.remove());
      } else { box.className = "doc"; box.textContent = await it.file.text(); }
      m.body = box;
    } catch (e) { m.err = e.message || "Не удалось открыть файл"; }
    render();
  })();
}

/* ═════════ ОКНО «ПРИМЕНИТЬ ИЗМЕНЕНИЯ?» (chat/proposals/ProposalDialog.tsx) ═════════
   Пока предложение не применено, в базе ничего не меняется. Решение — с комментарием не короче 10 символов */
const REASON_MIN = 10;
function proposalDialog(pid) {
  const p = PROPOSALS[pid];
  const m = { label: "Изменение от агента", outsideClose: false, reason: "", busy: null, error: null,
    html: () => {
      const st = { pending: ["Ждёт решения", "info"], approved: ["Применено", "ok"], rejected: ["Отклонено", "muted"] }[p.status];
      // Отклонение не окончательное: отклонённое изменение можно открыть снова и применить
      const can = p.status === "pending" || p.status === "rejected", ok = clip(m.reason).length >= REASON_MIN;
      return `<div class="dialog proposal-dialog">
        <div class="form-head"><div><h3>${can ? "Применить изменения?" : "Изменение от агента"}</h3><p>${esc(p.explanation)}</p></div>
          <button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
        <div class="diff${p.status === "approved" ? " applied" : ""}"><div class="entity"><b>${p.operation === "INSERT" ? "Новая запись" : "Изменение записи"}</b><small>${esc(p.table)}</small>${badge(st[0], st[1])}</div>
          ${p.rows.map((r, i) => `<div class="diff-row" style="--i:${i}"><span class="k">${esc(r.label)}</span><span class="old">${esc(t(r.before))}</span><span class="to">${icon("arrow")}</span><span class="new">${esc(t(r.after))}</span></div>`).join("")}
          ${p.effects?.length ? `<ul class="effects">${p.effects.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
          ${p.reason ? `<small class="hint">Основание агента: ${esc(p.reason)}</small>` : ""}
          ${p.decision_reason ? `<small class="hint">Комментарий к решению: ${esc(p.decision_reason)}</small>` : ""}</div>
        ${can ? `<label class="field"><span>Комментарий к решению (не короче ${REASON_MIN} символов)</span>
          <textarea class="text-input textarea" rows="2" data-reason maxlength="2000" placeholder="Например: подтверждаю по заявлению студента">${esc(m.reason)}</textarea></label>` : ""}
        ${m.error ? `<p class="form-error" role="alert">${esc(m.error)}</p>` : ""}
        <div class="actions">${can ? `${p.status === "rejected" ? "" : `<button class="btn ghost danger-text" data-a="reject" ${!ok || m.busy ? "disabled" : ""}>${m.busy === "reject" ? "Отклоняем…" : "Отклонить"}</button>`}
          <span class="spacer"></span><button class="btn" data-a="close">Позже</button>
          <button class="btn primary" data-a="approve" ${!ok || m.busy ? "disabled" : ""}>${m.busy === "approve" ? "Применяем…" : "Применить изменения"}</button>`
          : `<span class="spacer"></span><button class="btn" data-a="close">Закрыть</button>`}</div></div>`;
    },
    close: () => closeModal(m),
    input: (el) => { if (el.dataset.reason != null) { m.reason = el.value; render(); } },
    async click(el) {
      const a = el.dataset.a;
      if (a === "close") return closeModal(m);
      if (a !== "approve" && a !== "reject") return;
      m.busy = a; m.error = null; render();
      await wait(600);
      try {
        if (a === "approve") { p.apply(); window.onProposalApplied?.(p); }
        Object.assign(p, { status: a === "approve" ? "approved" : "rejected", decision_reason: clip(m.reason) });
      } catch (e) { m.error = e.message; }
      m.busy = null; render();
    } };
  openModal(m);
}

/* ═════════ ОТВЕТЫ АГЕНТА (заглушка: разбор по ключевым словам) ═════════ */
const CHANGE_WORDS = /(измени|исправ|добав|удали|постав|обнови|внеси|запиши|перевед|замени|смени|отметь|оформи|созда)/;
const groupIn = (raw) => { const mm = raw.match(/[иi][дd][бb]\s*-?\s*(\d{2})\s*-?\s*(\d{2})/i); return mm ? `ИДБ-${mm[1]}-${mm[2]}` : null; };
const stemOf = (last) => last.slice(0, last.endsWith("а") ? -2 : -1);
function findPeople(list, nameOf, raw) {
  const s = " " + norm(raw).replace(/[^а-я0-9]+/g, " ") + " ";
  const full = list.filter((p) => s.includes(" " + norm(nameOf(p)) + " "));
  if (full.length) return full;
  const hits = list.filter((p) => { const st = stemOf(norm(nameOf(p).split(" ")[0])); return st.length >= 3 && s.includes(" " + st); });
  const byFirst = hits.filter((p) => s.includes(" " + norm(nameOf(p).split(" ")[1]).slice(0, -1)));
  return byFirst.length ? byFirst : hits;
}
function dateIn(s) {
  if (/послезавтра/.test(s)) return addDays(TODAY, 2);
  if (/завтра/.test(s)) return addDays(TODAY, 1);
  if (/вчера/.test(s)) return addDays(TODAY, -1);
  if (/сегодня/.test(s)) return TODAY;
  const days = [/воскресен/, /понедельник/, /вторник/, /(^|[^а-я])сред[ауы]([^а-я]|$)/, /четверг/, /пятниц/, /суббот/];
  const i = days.findIndex((re) => re.test(s));
  return i < 0 ? null : addDays(TODAY, (i - D(TODAY).getUTCDay() + 7) % 7);
}
// Таблица в ответе — как таблица Markdown во фронте (обёрнута в .mini)
const mdTable = (head, rows, limit = 8) => `<div class="mini"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
  <tbody>${rows.slice(0, limit).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${rows.length > limit ? `<p>…и ещё ${rows.length - limit}.</p>` : ""}`;
const P = (s) => `<p>${s}</p>`;
const q = (html) => ({ html, tool: "query_deanery" });

function reply(raw) {
  const s = norm(raw), g = groupIn(raw);
  if (g && !GROUP_NAMES.includes(g)) return q(P(`Группы <b>${esc(g)}</b> в базе нет. Есть: ${GROUP_NAMES.join(", ")}.`));
  if (CHANGE_WORDS.test(s)) return proposeChange(raw, s, g);
  if (/телефон|контакт|почт|email|e-mail|связат/.test(s)) return contactsReply(raw);
  if (/отчисл/.test(s)) return expulsionReply();
  if (/просроч/.test(s)) return overdueReply();
  const st = findPeople(students, (x) => x.student, raw);
  if (st.length) return studentReply(st);
  if (/(^|[^а-я])(открой|открыть|перейди|перейти|вкладк)/.test(s)) {
    const tab = TABS.find((x) => norm(x.title).split(" ").some((w) => w.length > 3 && s.includes(w.slice(0, -1))));
    return { html: P(tab ? `Откройте вкладку «${tab.title}» внизу экрана — там можно найти, отфильтровать и изменить записи.` : "Разделы — во вкладках внизу экрана.") };
  }
  if (/стипенд/.test(s)) return scholarshipReply(s);
  if (/расписан|занят|(^|[^а-я])пар(а|ы|у|ой)?([^а-я]|$)/.test(s)) return scheduleReply(s, g);
  if (/практик/.test(s)) return practiceReply(g);
  if (/средн|балл|сложн|успеваем|рейтинг/.test(s)) return statsReply(s);
  if (/долг|задолж|должник/.test(s)) return debtsReply(g);
  if (g) return groupReply(g);
  return { html: P("Могу найти студента, группу, занятия, долги, практики и контакты сотрудников. Могу подготовить изменение: статус заявки на справку, новую заявку или тему курсовой / ВКР — его нужно будет применить в окне подтверждения.") };
}

function proposeChange(raw, s, g) {
  // Статус заявки на справку
  const rq = s.match(/заявк\D{0,8}(\d{2,4})/);
  if (rq) {
    const r = requests.find((x) => x.request_id === +rq[1]);
    if (!r) return q(P(`Заявку <b>№ ${esc(rq[1])}</b> не нашёл. Есть номера с ${Math.min(...requests.map((x) => x.request_id))} по ${Math.max(...requests.map((x) => x.request_id))}.`));
    if (/удали/.test(s)) return { html: P(`Удалять записи я не могу. Откройте заявку № ${r.request_id} на вкладке «Заявки на справки» и нажмите «Удалить».`) };
    const to = /отклон/.test(s) ? "Отклонена" : /выдан/.test(s) ? "Выдана" : /готов/.test(s) ? "Готова к выдаче" : /работ/.test(s) ? "В работе" : /нов/.test(s) ? "Новая" : null;
    if (!to) return q(P(`Какой статус поставить заявке <b>№ ${r.request_id}</b>? Сейчас — «${esc(r.status)}». Можно: ${REQUEST_STATUSES.filter((x) => x !== r.status).map((x) => `«${x}»`).join(", ")}.`));
    if (r.status === to) return q(P(`Заявка <b>№ ${r.request_id}</b> уже в статусе «${esc(to)}» — менять нечего.`));
    const rows = [{ label: "Статус", before: r.status, after: to }];
    if (!r.processed_by) rows.push({ label: "Исполнитель", before: null, after: ME.full_name });
    return { tool: "propose_sql_change", html: P(`Подготовил изменение заявки № ${r.request_id} (${esc(r.document)}, ${esc(shortName(r.student))}). Проверьте его и примените.`),
      proposal: { explanation: `Сменить статус заявки № ${r.request_id} на «${to}»`, reason: `Запрос сотрудника: «${raw.trim()}»`, table: "Заявка на справку", operation: "UPDATE", rows,
        effects: to === "Готова к выдаче" ? ["Заявка пропадёт из просроченных"] : [],
        apply: () => { if (!requests.includes(r)) throw new Error("Заявка уже удалена — изменение не применено"); r.status = to; r.processed_by ||= ME.full_name; } } };
  }
  const st = findPeople(students, (x) => x.student, raw);
  // Новая заявка на справку
  if (/справк|заявк/.test(s)) {
    if (!st.length) return q(P("Для кого оформить заявку? Назовите студента."));
    if (st.length > 1) return q(P(`Нашёл ${st.length} студентов с такой фамилией: ${st.slice(0, 5).map((x) => `${esc(x.student)} (${x.group_name})`).join(", ")}. Уточните имя.`));
    const stu = st[0], doc = (DOC_TYPES.find(([d]) => norm(d).split(" ").slice(1).some((w) => w.length > 4 && s.includes(w.slice(0, -2)))) ?? DOC_TYPES[0])[0];
    return { tool: "propose_sql_change", html: P(`Подготовил новую заявку для <b>${esc(stu.student)}</b>. Проверьте и примените.`),
      proposal: { explanation: `Новая заявка: ${doc.toLowerCase()} для ${shortName(stu.student)}`, reason: `Запрос сотрудника: «${raw.trim()}»`, table: "Заявка на справку", operation: "INSERT",
        rows: [{ label: "Студент", after: stu.student }, { label: "Вид документа", after: doc }, { label: "Количество экземпляров", after: 1 }, { label: "Цель", after: "По месту требования" }, { label: "Статус", after: "Новая" }],
        effects: [`Срок готовности — ${fmtDate(addDays(TODAY, DOC_TYPES.find(([d]) => d === doc)[1]))}`],
        apply: () => {
          const id = Math.max(...requests.map((x) => x.request_id)) + 1;
          requests.push({ request_id: id, student_id: stu.student_id, student: stu.student, group_name: stu.group_name, document: doc, copies: 1, purpose: "По месту требования",
            status: "Новая", created_at: `${TODAY} ${new Date().toTimeString().slice(0, 5)}`, due_date: addDays(TODAY, DOC_TYPES.find(([d]) => d === doc)[1]), processed_by: null });
        } } };
  }
  // Тема курсовой или ВКР
  if (/тем/.test(s)) {
    const ws = works.filter((w) => st.some((x) => x.student_id === w.student_id));
    if (!ws.length) return q(P(st.length ? `У ${esc(st[0].student)} нет курсовой или ВКР в этом году.` : "У кого изменить тему? Назовите студента."));
    const topic = raw.match(/[«"“]([^»"”]+)[»"”]/)?.[1];
    if (!topic) return q(P(`Какую тему поставить? Сейчас у ${esc(ws[0].student)}: «${esc(ws[0].topic)}». Напишите новую тему в кавычках.`));
    const w = ws[0];
    return { tool: "propose_sql_change", html: P(`Подготовил изменение темы (${esc(w.work_kind)}, ${esc(shortName(w.student))}). Проверьте и примените.`),
      proposal: { explanation: `Изменить тему: ${w.work_kind}, ${shortName(w.student)}`, reason: `Запрос сотрудника: «${raw.trim()}»`, table: "Курсовая работа / ВКР", operation: "UPDATE",
        rows: [{ label: "Тема", before: w.topic, after: topic }], effects: w.order_number ? [`Тема утверждена приказом ${w.order_number} — понадобится новый приказ`] : [],
        apply: () => { w.topic = topic; } } };
  }
  if (st.length) return q(P("Перевод в другую группу, академический отпуск, отчисление и восстановление оформляются приказом: откройте студента на вкладке «Студенты» и нажмите «Приказ». Основу обучения и общежитие можно поменять там же, в окне студента."));
  return { html: P("Уточните, что изменить: статус заявки на справку (например, «заявку 235 — в работу»), новую заявку на справку или тему курсовой / ВКР.") };
}
function contactsReply(raw) {
  const es = findPeople(employees, (e) => e.full_name, raw);
  if (!es.length) return q(P("Чьи контакты нужны? Назовите фамилию сотрудника."));
  return q(P(es.length > 1 ? `Нашёл ${es.length} ${plural(es.length, "сотрудника", "сотрудников", "сотрудников")}:` : "Вот контакты:")
    + mdTable(["Сотрудник", "Должность", "Телефон", "Email"], es.map((e) => [esc(e.full_name), esc(e.position), esc(e.phone), esc(e.email)]), 5));
}
function expulsionReply() {
  const rows = expulsionNow();
  if (!rows.length) return q(P("Кандидатов на отчисление сейчас нет."));
  return q(P(`Кандидатов на отчисление — <b>${rows.length}</b>:`) + mdTable(["Студент", "Группа", "Долгов", "Причина"], rows.map((r) => [esc(r.student), r.group_name, r.debts, esc(r.reason)])));
}
function overdueReply() {
  const rows = requests.filter(isOverdue);
  if (!rows.length) return q(P("Просроченных заявок нет."));
  return q(P(`Просрочено <b>${rows.length}</b> ${plural(rows.length, "заявка", "заявки", "заявок")}:`)
    + mdTable(["№", "Студент", "Документ", "Срок"], rows.map((r) => [r.request_id, esc(r.student), esc(r.document), fmtDate(r.due_date)])));
}
function studentReply(st) {
  if (st.length === 1) {
    const x = st[0];
    return q(P(`<b>${esc(x.student)}</b> — ${x.group_name}, ${x.course} курс, зачётка ${x.record_book_number}.`)
      + `<ul><li>Статус: ${esc(x.status)}; категория: ${esc(x.category)}</li><li>Средний балл: ${x.avg_points ?? "—"}; долгов: ${x.debts || "нет"}</li>
        <li>Посещаемость: ${x.attendance_pct == null ? "—" : fmtNum(x.attendance_pct, 1) + "%"}</li><li>Основа: ${x.funding}; стипендия: ${esc(x.scholarships || "нет")}</li></ul>`);
  }
  return q(P(`Нашёл ${st.length} ${plural(st.length, "студента", "студентов", "студентов")}:`)
    + mdTable(["Зачётка", "ФИО", "Группа", "Категория"], st.map((r) => [r.record_book_number, esc(r.student), r.group_name, esc(r.category)])));
}
function scholarshipReply(s) {
  const all = students.filter((x) => x.scholarships), top = all.filter((x) => x.scholarships.startsWith("Повышенная"));
  const hi = /повыш/.test(s) && top.length > 0, rows = hi ? top : all;
  const note = /повыш/.test(s) && !top.length ? "Повышенную стипендию сейчас не получает никто — отличников нет. " : "";
  return q(P(`${note}${hi ? "Повышенную стипендию" : "Стипендию"} получают <b>${rows.length}</b> ${plural(rows.length, "студент", "студента", "студентов")}:`)
    + mdTable(["Студент", "Группа", "Стипендия"], rows.map((r) => [esc(r.student), r.group_name, esc(r.scholarships)])));
}
function scheduleReply(s, g) {
  const d = dateIn(s) || TODAY;
  const ls = schedule.filter((l) => l.lesson_date === d && (!g || l.group_name === g));
  const rel0 = d === TODAY ? "сегодня, " : d === addDays(TODAY, 1) ? "завтра, " : "";
  const when = `${rel0}${WD_FULL[D(d).getUTCDay()].toLowerCase()}, ${human(d)}`;
  if (!ls.length) return q(P(`${g ? `У <b>${g}</b>` : "У групп"} занятий нет — ${when}.`));
  return q(P(`${g ? `<b>${g}</b>` : "Все группы"} · ${when} — ${ls.length} ${plural(ls.length, "занятие", "занятия", "занятий")}:`)
    + mdTable(["Пара", "Дисциплина", "Вид", "Аудитория", "Преподаватель", ...(g ? [] : ["Группа"])],
      ls.map((l) => [`${l.pair_number} (${l.start_time})`, esc(l.discipline), l.lesson_type, l.classroom, esc(shortName(l.teacher)), ...(g ? [] : [l.group_name])]), 10));
}
function practiceReply(g) {
  const rows = practices.filter((p) => !g || p.group_name === g);
  if (!rows.length) return q(P(g ? `У <b>${g}</b> практик в этом году не было.` : "Практик не найдено."));
  const orgs = new Set(rows.map((r) => r.organization)).size;
  return q(P(`${g ? `<b>${g}</b>: ` : ""}${rows.length} ${plural(rows.length, "студент", "студента", "студентов")} в ${orgs} ${plural(orgs, "организации", "организациях", "организациях")}:`)
    + mdTable(["Студент", "Группа", "Практика", "Организация"], rows.map((r) => [esc(r.student), r.group_name, r.practice, esc(r.organization)])));
}
function statsReply(s) {
  if (/сложн|трудн|хуж|низк/.test(s)) {
    const rows = rollup((r) => r.discipline).filter((r) => r.avg != null).sort((a, b) => a.avg - b.avg);
    return q(P(`Сложнее всего даётся <b>${esc(rows[0].name)}</b>: средний балл ${rows[0].avg}, долгов — ${rows[0].debts}.`)
      + mdTable(["Дисциплина", "Средний балл", "Долгов"], rows.slice(0, 5).map((r) => [esc(r.name), r.avg, r.debts])));
  }
  const rows = rollup((r) => r.group_name).sort((a, b) => b.avg - a.avg);
  return q(P(`Лучший средний балл у <b>${rows[0].name}</b> — ${rows[0].avg}, ниже всех у <b>${rows.at(-1).name}</b> — ${rows.at(-1).avg}.`)
    + mdTable(["Группа", "Средний балл", "Долгов"], rows.map((r) => [r.name, r.avg, r.debts])));
}
function debtsReply(g) {
  const rows = debtorsNow().filter((d) => !g || d.group_name === g);
  if (!rows.length) return q(P(`${g ? `У <b>${g}</b>` : "У студентов"} задолженностей нет.`));
  const people = new Set(rows.map((r) => r.student)).size;
  return q(P(`${g ? `<b>${g}</b>: ` : ""}${rows.length} ${plural(rows.length, "задолженность", "задолженности", "задолженностей")} у ${people} ${plural(people, "студента", "студентов", "студентов")}:`)
    + mdTable(["Студент", "Группа", "Дисциплина", "Попыток"], rows.map((r) => [esc(r.student), r.group_name, esc(r.discipline), r.attempts])));
}
function groupReply(g) {
  const r = groupRow(GROUPS.find((x) => x.name === g));
  const debts = debtorsNow().filter((d) => d.group_name === g).length, a = avg(results.filter((x) => x.group_name === g));
  return q(P(`Сводка по группе <b>${g}</b>:`) + `<ul><li>${esc(r.specialty)}, ${r.course} курс, ${r.current_semester}-й семестр</li>
    <li>Куратор: ${esc(r.curator ? shortName(r.curator) : "—")}; староста: ${esc(r.headman ? shortName(r.headman) : "—")}</li>
    <li>Студентов: ${r.active_students}, из них на бюджете: ${r.budget_students}</li><li>Средний балл: ${a ?? "—"}; задолженностей: ${debts}</li></ul>`);
}

// Чаты из «прошлых» сессий — чтобы было видно список чатов по дням
[["Кто кандидаты на отчисление?", 1], ["Покажи просроченные заявки", 4]].forEach(([text, daysAgo]) => {
  const at = Date.now() - daysAgo * 864e5;
  chat.chats.push({ id: uid(), title: titleFrom(text), updatedAt: at,
    messages: [{ id: uid(), role: "user", text }, { id: uid(), role: "agent", html: reply(text).html, proposals: [] }] });
});

/* ═════════ СОБЫТИЯ ═════════ */
const ACT = {
  me: () => { meOpen = !meOpen; render(); },
  logout: () => logout(),
  account: () => { meOpen = false; accountDialog(); },
  scrim: () => { chat.open = false; render(); },
  // таблицы
  tpanel: (el) => { const s = ts(el.dataset.id); s.open = !s.open; s.dd = null; render(); },
  tdd: (el) => { const s = ts(el.dataset.id), i = +el.dataset.i; s.dd = s.dd === i ? null : i; s.ddq = ""; render(); $(".ff-dd-search")?.focus(); },
  tenum: (el) => { const s = ts(el.dataset.id), i = el.dataset.i, v = el.dataset.v, cur = s.f[i] || []; s.f[i] = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]; s.page = 1; render(); },
  tclear: (el) => { const s = ts(el.dataset.id); if (el.dataset.i === "*") s.f = {}; else delete s.f[el.dataset.i]; s.page = 1; render(); },
  tsort: (el) => { const s = ts(el.dataset.id), i = +el.dataset.i; s.sort = s.sort?.i !== i ? { i, dir: 1 } : s.sort.dir === 1 ? { i, dir: -1 } : null; render(); },
  tqclear: (el) => { Object.assign(ts(el.dataset.id), { q: "", page: 1 }); render(); },
  pg: (el) => {
    ts(el.dataset.id).page = +el.dataset.n; render();
    const card = $(`[data-table="${el.dataset.id}"]`);
    if (card && card.getBoundingClientRect().top < $("#content").getBoundingClientRect().top) card.scrollIntoView({ block: "start", behavior: REDUCED ? "auto" : "smooth" });
  },
  // вкладки
  enroll: () => workflowDialog(ENROLL),
  "add-groups": () => openGroup(null), "add-works": () => openWork(null), "add-requests": () => openRequest(null),
  "add-practice": () => openPractice(null), "add-employees": () => openEmployee(null), "add-schedule": () => openSlot(null, { term_id: TERM_NAME }),
  group: (el) => openGroup(GROUPS.find((g) => g.group_id === +el.dataset.id)),
  "group-students": (el) => goTab("students", { group_name: el.dataset.v }),
  "group-schedule": (el) => { Object.assign(sched, { view: "week", by: "group", who: el.dataset.v }); goTab("schedule"); },
  "groups-view": (el) => { groupsView = el.dataset.v; render(); },
  "sched-view": (el) => { sched.view = el.dataset.v; render(); },
  "sched-by": (el) => { sched.by = el.dataset.v; sched.who = ""; render(); },
  week: (el) => { sched.date = el.dataset.v; ts("schedule").page = 1; render(); },
  slot: (el) => openSlot(slotById(el.dataset.id)),
  "slot-new": (el) => openSlot(null, { weekday: el.dataset.wd, pair_number: el.dataset.p, term_id: TERM_NAME }),
  "olap-op": (el) => { olap.op = el.dataset.v; olap.pick = null; render(); },
  "olap-crumb": (el) => { olap.path = olap.path.slice(0, +el.dataset.i); render(); },
  "olap-level": (el) => { olap.level = el.dataset.v; render(); },
  "olap-period": (el) => { olap.period = el.dataset.v; olap.pick = null; render(); },
  "olap-pick": (el) => { olap.pick = olap.pick === el.dataset.v ? null : el.dataset.v; render(); },
  // чат
  "chat-list": () => { chat.listOpen = !chat.listOpen; render(); },
  "chat-toggle": () => { chat.open = !chat.open; render(); },
  "new-chat": () => newChat(),
  "open-chat": (el) => { chat.activeId = el.dataset.id; chat.notice = null; render(); },
  "rename-chat": (el) => { chat.editing = { id: el.dataset.id, title: chat.chats.find((c) => c.id === el.dataset.id).title }; render(); $("[data-rename-input]")?.focus(); },
  "remove-chat": (el) => { const c = chat.chats.find((x) => x.id === el.dataset.id);
    confirmDialog({ title: "Удалить чат?", text: `«${c.title}» исчезнет из списка вместе с перепиской.`, confirm: "Удалить", danger: true, busyMs: 0,
      onConfirm: () => { chat.chats.splice(chat.chats.indexOf(c), 1); if (chat.activeId === c.id) chat.activeId = null; render(); } }); },
  attach: () => $("#fileInput").click(),
  "att-remove": (el) => {
    // Сначала файл (а если он последний — и вся полоса) плавно исчезает, потом убираем его из черновика
    const id = el.dataset.id, last = draftItems().every((i) => i.id === id || leaving.has(i.id));
    leaving.add(id); render();
    setTimeout(() => { leaving.delete(id); for (const k in chat.att) chat.att[k] = chat.att[k].filter((x) => x !== id); delete ATT[id]; render(); }, REDUCED ? 0 : last ? 320 : 200);
  },
  "att-retry": (el) => { upload(ATT[el.dataset.id]); render(); },
  "att-open": (el) => fileViewer(ATT[el.dataset.id]),
  "msg-file": (el) => fileViewer(ATT[el.dataset.id] ?? { name: el.title }),
  copy: async (el) => {
    const node = $(`[data-k="${el.dataset.id}"] .bubble, [data-k="${el.dataset.id}"] .md, [data-k="${el.dataset.id}"] .body p`);
    try { await navigator.clipboard.writeText(node?.innerText ?? ""); } catch { /* нет доступа к буферу */ }
    chat.copied = el.dataset.id; render();
    setTimeout(() => { if (chat.copied === el.dataset.id) { chat.copied = null; render(); } }, 1500);
  },
  proposal: (el) => proposalDialog(el.dataset.id),
  stop: () => stopAgent(),
  unqueue: () => { chat.queued = false; render(); },
};
const topModal = () => modals[modals.length - 1];
document.addEventListener("click", (e) => {
  const sc = e.target.closest("#modals .modal-scrim");
  if (sc) { const m = modals[+sc.dataset.m]; m?.click?.(e.target.closest("[data-a]") ?? e.target, e); return; }
  if (meOpen && !e.target.closest(".me")) { meOpen = false; render(); }
  const el = e.target.closest("[data-a],[data-row]");
  if (!el || el.disabled) return;
  if (el.dataset.row) {
    const tb = tables[el.dataset.row], row = tb.rows.find((r) => String(tb.rowKey(r)) === el.dataset.k);
    if (row) tb.onRow(row);
    return;
  }
  ACT[el.dataset.a]?.(el, e);
});
document.addEventListener("mousedown", (e) => {
  // Клик мимо окна закрывает его (формы — только крестиком или Esc)
  const sc = e.target.closest("#modals .modal-scrim");
  if (sc && (e.target === sc || e.target === sc.firstElementChild)) { const m = modals[+sc.dataset.m]; if (m && m.outsideClose !== false) m.close(); return; }
  // Клик мимо выпадающего списка закрывает его, клик мимо панели — всю панель
  let changed = false;
  for (const [id, s] of Object.entries(tstore)) {
    if (s.dd != null && !e.target.closest(".ff-dd")) { s.dd = null; changed = true; }
    if (s.open && !e.target.closest(`[data-fpanel="${id}"]`) && !e.target.closest(`[data-a="tpanel"][data-id="${id}"]`)) { s.open = false; s.dd = null; changed = true; }
  }
  if (changed) render();
});
document.addEventListener("input", (e) => {
  const el = e.target, d = el.dataset;
  if (el.closest("#modals")) { const sc = el.closest(".modal-scrim"); modals[+sc.dataset.m]?.input?.(el, e); return; }
  if (el.closest("[data-login]")) { if (el.name === "login") auth.login = el.value; return; }
  if (d.tq) { Object.assign(ts(d.tq), { q: el.value, page: 1 }); render(); }
  else if (d.ddq) { ts(d.ddq).ddq = el.value; render(); }
  else if (d.trange) {
    // «от» не может быть больше «до»: если перепутали — меняем местами
    const [id, i, part] = d.trange.split("|"), s = ts(id);
    const next = { ...(s.f[i] || {}), [part]: el.value };
    const num = part === "min" || part === "max", [a, b] = num ? ["min", "max"] : ["from", "to"], lo = next[a], hi = next[b];
    s.f[i] = lo && hi && (num ? Number(lo) > Number(hi) : lo > hi) ? { [a]: hi, [b]: lo } : next;
    s.page = 1; render();
  } else if (d.chatInput != null) {
    chat.texts[draftKey()] = el.value;
    el.style.height = "40px";
    chat.inputH = el.value ? Math.max(40, Math.min(el.scrollHeight, 160)) : 40;
    render();
  } else if (d.renameInput != null) chat.editing.title = el.value;
});
document.addEventListener("change", (e) => {
  const el = e.target, d = el.dataset;
  if (el.closest("#modals")) { const sc = el.closest(".modal-scrim"); modals[+sc.dataset.m]?.change?.(el, e); return; }
  if (d.tchk) {
    const [id, i] = d.tchk.split("|"), s = ts(id), cur = s.f[i] || [];
    s.f[i] = el.checked ? [...cur, el.value] : cur.filter((x) => x !== el.value);
    s.page = 1; render();
  } else if (d.who != null) { sched.who = el.value; render(); }
  else if (d.olap) { olap[d.olap] = el.value; if (d.olap === "course") olap.group = ""; render(); }
  else if (el.id === "fileInput") { if (el.files.length) addFiles([...el.files]); el.value = ""; }
});
document.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.closest("#modals")) { const sc = f.closest(".modal-scrim"); modals[+sc.dataset.m]?.submit?.(e); return; }
  if (f.dataset.login != null) doLogin(f);
  else if (f.dataset.chatForm != null) submitChat();
  else if (f.dataset.rename) commitRename();
});
function commitRename() {
  if (!chat.editing) return;
  const c = chat.chats.find((x) => x.id === chat.editing.id), title = chat.editing.title.trim();
  if (c && title) c.title = title;
  chat.editing = null; render();
}
// Невидимое поле выпадающего списка: фокус с клавиатуры (Tab) открывает список
document.addEventListener("focusin", (e) => {
  const name = e.target.dataset?.lkfocus, sc = e.target.closest?.("#modals .modal-scrim");
  if (!name || !sc) return;
  const m = modals[+sc.dataset.m];
  if (m && !m.busy && m.lk !== name) { m.lk = name; m.lq = ""; m.lhi = 0; render(); $(`[data-k="${m.key}"] [data-lq]`)?.focus(); }
});
document.addEventListener("focusout", (e) => { if (e.target.dataset?.renameInput != null && chat.editing) setTimeout(commitRename); });
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") { e.preventDefault(); $("[data-chat-input]")?.focus(); return; }
  const m = topModal();
  if (m && m.keydown?.(e)) return;
  if (e.key === "Escape") {
    if (m) { e.preventDefault(); if (!m.esc?.()) m.close(); return; }
    if (chat.editing && e.target.dataset.renameInput != null) { chat.editing = null; render(); return; }
    if (meOpen) { meOpen = false; render(); return; }
    if (chat.open) { chat.open = false; render(); }
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target.dataset?.chatInput != null) { e.preventDefault(); submitChat(); }
});

/* ═════════ РЕНДЕР ═════════ */
function renderChat() {
  morphInto($("#chatSlot"), chatHtml());
  const c = activeChat(), n = (c?.messages.length ?? 0) * 2 + (chat.busyId ? 1 : 0) + (chat.open ? 0.5 : 0) + (c ? 0 : 0.25);
  if (n !== chat.shownCount) {
    chat.shownCount = n;
    const box = $("#messages");
    requestAnimationFrame(() => box?.scrollTo({ top: box.scrollHeight, behavior: REDUCED ? "auto" : "smooth" }));
  }
}
let lastTab = null;
// Замена узла с фокусом вызывает blur/change, а их обработчики снова зовут render — откладываем повторный рендер
let rendering = false, renderAgain = false;
function render() {
  if (rendering) { renderAgain = true; return; }
  rendering = true;
  try { renderNow(); } finally { rendering = false; }
  if (renderAgain) { renderAgain = false; render(); }
}
function renderNow() {
  const root = $("#root");
  if (!auth.on) {
    if ($("#app")) root.innerHTML = "";
    morphInto(root, loginHtml());
    renderModals();
    return;
  }
  if (!$("#app")) {
    root.innerHTML = shellHtml();
    $("#scrim").dataset.a = "scrim";
    $("#content").addEventListener("scroll", (e) => $("#app").classList.toggle("scrolled", e.target.scrollTop > 4), { passive: true });
  }
  const tab = currentTab();
  if (tab !== lastTab) { $("#content").scrollTop = 0; lastTab = tab; }
  morphInto($("#me"), meHtml());
  const tabs = $("#tabs");
  tabs.style.setProperty("--n", TABS.length);
  tabs.style.setProperty("--i", TABS.findIndex((x) => x.id === tab));
  morphInto(tabs, tabsHtml());
  $("#scrim").classList.toggle("show", chat.open);
  morphInto($("#page"), PAGES[tab]());
  renderChat();
  // Свёрнутый чат лежит поверх страницы — место под ним подстраиваем под его высоту
  const sec = $("#chatSlot .chat");
  if (sec && !sec.classList.contains("open")) $("#chatSlot").style.height = sec.offsetHeight + "px";
  renderModals();
  applyFlash();
}
addEventListener("hashchange", render);
let resizeT;
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(render, 120); });
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
render();
