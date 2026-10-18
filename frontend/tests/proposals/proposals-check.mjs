import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SourceTextModule, SyntheticModule } from "node:vm";
import { transformSync } from "rolldown/utils";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

async function load(relative, mocks = {}) {
  const filename = fileURLToPath(new URL(`../../src/${relative}`, import.meta.url));
  const transformed = transformSync(filename, readFileSync(filename, "utf8"), { jsx: { runtime: "automatic" } });
  assert.deepEqual(transformed.errors, []);
  const module = new SourceTextModule(transformed.code, { identifier: filename });
  await module.link((name) => {
    assert.ok(name in mocks, `Unexpected dependency: ${name}`);
    return new SyntheticModule(Object.keys(mocks[name]), function () { for (const [key, value] of Object.entries(mocks[name])) this.setExport(key, value); });
  });
  await module.evaluate();
  return module.namespace;
}

const calls = [];
let key = 0, apiResult = null, apiFailure;
const api = await load("api/proposals.ts", { "./client": { newKey: () => `key-${++key}`, api: async (path, options) => {
  calls.push({ path, options }); if (apiFailure) throw apiFailure; return apiResult;
} } });
const p = {
  id: "proposal-id", version: 11, kind: "record_change", status: "pending", submission_status: null, correction_id: null,
  created_at: "2024-06-04T21:00:00Z", expires_at: "2024-06-05T21:00:00Z", explanation: "Проверяемое изменение", reason: "Основание пользователя",
  initiator: { user_id: 7, full_name: "Автор" }, routing: { assignee_user_id: 8, assignee_name: "Согласующий", institute_id: 1 },
  actions: { can_claim: false, can_assign: true, can_submit: false, can_approve: true, can_reject: true },
  execution: { status: "not_started", error: null }, validity: { state: "current" }, context_files: [],
  preview: { table: "person", operation: "UPDATE", changed_columns: [], related_effects: [], before: {}, after: {} },
};
const reason = "  Подтверждаю по заявлению  ";
const approve = api.createProposalAttempt(p, { action: "decision", approve: true, reason });
assert.deepEqual(approve.body, { expected_version: 11, approve: true, reason: reason.trim() });
assert.ok(Object.isFrozen(approve) && Object.isFrozen(approve.body));
apiFailure = new TypeError("lost response");
await assert.rejects(api.sendProposalAttempt(p.id, approve), /lost response/);
apiFailure = null;
apiResult = { ...p, version: 12, status: "approved", execution: { status: "scheduled" } };
assert.equal(await api.sendProposalAttempt(p.id, approve), apiResult);
assert.deepEqual(calls[0], calls[1], "ambiguous retry preserves route, body, key and old expected_version");
const rejected = api.createProposalAttempt({ ...p, version: 12 }, { action: "decision", approve: false, reason });
assert.notEqual(rejected.key, approve.key);
assert.equal(rejected.body.expected_version, 12);
assert.equal(rejected.body.approve, false);
assert.throws(() => api.createProposalAttempt(p, { action: "decision", approve: true, reason: "short" }));
assert.throws(() => api.createProposalAttempt(p, { action: "decision", approve: true, reason: "x".repeat(2001) }));
const stale = { ...p, validity: { state: "stale" }, actions: { ...p.actions, can_approve: false } };
assert.throws(() => api.createProposalAttempt(stale, { action: "decision", approve: true, reason }));
assert.equal(api.createProposalAttempt(stale, { action: "decision", approve: false, reason }).body.approve, false);
assert.throws(() => api.createProposalAttempt(p, { action: "submit" }));
const draft = { ...p, kind: "grade_correction", submission_status: "draft", actions: { can_submit: true, can_approve: false, can_reject: false, can_claim: false, can_assign: false } };
assert.deepEqual(api.createProposalAttempt(draft, { action: "submit" }).body, { expected_version: 11 });
assert.throws(() => api.createProposalAttempt(draft, { action: "decision", approve: true, reason }));
assert.throws(() => api.createProposalAttempt(p, { action: "assignment", assignee_user_id: 8, reason: "" }));
assert.throws(() => api.createProposalAttempt(p, { action: "assignment", assignee_user_id: NaN, reason: "Передача по заявке" }));
// Причина передачи — 10–2000 символов (решение Р3)
assert.throws(() => api.createProposalAttempt(p, { action: "assignment", assignee_user_id: 9, reason: "Передача" }));
assert.equal(api.createProposalAttempt(p, { action: "assignment", assignee_user_id: 9, reason: "Передача по заявке" }).body.assignee_user_id, 9);
// Комментарий к решению по исправлению оценки — до 500 символов (решение Р1)
const correction = { ...p, kind: "grade_correction" };
assert.throws(() => api.createProposalAttempt(correction, { action: "decision", approve: true, reason: "x".repeat(501) }));
assert.equal(api.createProposalAttempt(correction, { action: "decision", approve: true, reason: "x".repeat(500) }).body.approve, true);
assert.throws(() => api.createProposalAttempt(p, { action: "assignment", assignee_user_id: 8, reason: "Взято в работу", claim: true }));
const claim = api.createProposalAttempt({ ...p, actions: { ...p.actions, can_claim: true } }, { action: "assignment", assignee_user_id: 8, reason: "Взято в работу", claim: true });
assert.deepEqual(claim.body, { expected_version: 11, assignee_user_id: 8, reason: "Взято в работу" });
const filters = { box: "completed", status: "approved", execution_status: "failed", author: "%_", created_from: "2024-06-05", created_to: "2024-06-05", limit: 20, offset: 40 };
await api.listProposals(filters);
assert.deepEqual(calls.at(-1), { path: "/agent/proposals", options: { query: filters } });
await api.getProposalEvents(p.id, 123);
assert.deepEqual(calls.at(-1).options.query, { after: 123, limit: 25 });
await api.getAssignees(p.id);
assert.equal(calls.at(-1).path, "/agent/proposals/proposal-id/assignees");

const presentation = await load("chat/proposals/presentation.ts");
const undoText = { sheet_closed: "Ведомость закрыта — нужна заявка на исправление" };
const batchItems = await load("chat/proposals/BatchItems.tsx", {
  "react": React, "react/jsx-runtime": jsx,
  "../../components/Icon": { Icon: () => null },
  "../../components/ui": { Badge: ({ children }) => React.createElement("span", null, children) },
  "../../components/form/lookups": { useLookup: () => ({}) },
  "../../api/schema": { useSchema: () => ({ data: { student: { fields: { needs_dormitory: { description: "Нуждается в общежитии" } } } } }),
    fieldLabel: (spec, name) => spec?.description ?? name },
  "../../api/errors": { undoReasonText: (r) => undoText[r] },
  "../../lib/format": { plural: (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c) },
  "./useProposal": { TABLE_NAME: { student: "Студент" } },
});
let current = p, loadError = null, undone;
const dialog = await load("chat/proposals/ProposalDialog.tsx", {
  "react": React, "react/jsx-runtime": jsx,
  "../../components/Icon": { Icon: () => null },
  "../../components/ui": { Modal: ({ children }) => React.createElement("section", null, children), Badge: ({ children }) => React.createElement("span", null, children), ErrorNote: ({ text }) => text, useToast: () => () => {} },
  "./useProposal": { REASON_MIN: 10, TABLE_NAME: { person: "Личные данные" }, useProposal: () => ({ proposal: current, rows: [], reason: "", reasonOk: false,
    reasonMax: 2000, reasonError: null, events: {}, assignees: {}, tableName: "person", operation: "UPDATE", loadError, undone }) },
  "../../lib/chatPrefill": { prefillChat() {} },
  "../../components/form/lookups": { useLookup: () => ({}) },
  "../../auth/AuthProvider": { useAuth: () => ({ me: { user_id: 8 } }) },
  "../../api/errors": { errorText: String },
  "../attachments/Thumbs": { FileViewer: () => null, MessageThumbs: () => null },
  "./presentation": presentation,
  "../../pages/sheets/CorrectionDialog": { RedoCorrectionDialog: () => null },
  "./BatchItems": batchItems,
});
const render = (proposal) => { current = proposal; return renderToStaticMarkup(React.createElement(dialog.ProposalDialog, { id: p.id, onClose() {} })); };
const scheduled = render({ ...p, status: "approved", actions: {}, execution: { status: "scheduled", effective_date: "2027-01-01", order_id: 42 } });
assert.match(scheduled, /Подтверждено/); assert.match(scheduled, /Запланировано/); assert.match(scheduled, /2027-01-01/);
assert.doesNotMatch(scheduled, /Применено|class="diff applied"/);
assert.match(render({ ...p, status: "approved", execution: { status: "succeeded" } }), /class="diff applied"/);
assert.match(render({ ...p, status: "approved", execution: { status: "cancelled" } }), /Исполнение отменено/);
assert.match(render({ ...p, status: "approved", execution: { status: "failed", error: "execution_failed" } }), /Ошибка исполнения/);
assert.match(render(draft), /Подать заявку/); assert.doesNotMatch(render(draft), />Подтвердить</);
assert.match(render(stale), />Отклонить</); assert.doesNotMatch(render(stale), />Подтвердить</);
assert.doesNotMatch(render({ ...p, actions: {} }), />Взять в работу<|>Передать<|>Подтвердить<|>Отклонить<|>Подать заявку</);
assert.match(render({ ...p, actions: { can_claim: true } }), />Взять в работу</);
loadError = "Предложение недоступно";
const denied = render({ ...p, actions: { can_claim: true, can_assign: true, can_approve: true, can_reject: true, can_submit: true } });
assert.match(denied, /Предложение недоступно/);
assert.doesNotMatch(denied, />Взять в работу<|>Передать<|>Подтвердить<|>Отклонить<|>Подать заявку<|class="diff/);
loadError = null;
// «Подготовить заново» у исправления оценки — по can_redo и строке оценки в preview.before (Ф-Р4)
const fix = { ...p, kind: "grade_correction", status: "rejected", submission_status: "submitted", actions: { can_redo: true }, request_text: "исправь оценку",
  preview: { ...p.preview, table: "grade", before: { grade_id: 5, sheet_id: 3, student_id: 9 } } };
assert.match(render(fix), /Подготовить заново/);
assert.doesNotMatch(render({ ...fix, actions: {} }), /Подготовить заново/);
assert.doesNotMatch(render({ ...fix, preview: { ...fix.preview, before: null } }), /Подготовить заново/);
// Плашка актуальности — только до решения: у отклонённого исправления сервер хранит stale
assert.doesNotMatch(render({ ...fix, validity: { state: "stale" } }), /Исходные данные изменились/);
assert.match(render({ ...p, status: "pending", validity: { state: "stale" } }), /Исходные данные изменились/);

// Пакет (Ф-Р8, Ф-Р9): строки с отметками, подпись «таблица · ключ» без label, причины по state и undo_reason
const row = (item_id, extra = {}) => ({ item_id, table: "student", key: { student_id: item_id + 1 }, field: ["needs_dormitory"],
  before: { student_id: item_id + 1, needs_dormitory: true }, after: { needs_dormitory: false }, state: "ok", message: null, reversible: true, undo_reason: null, ...extra });
const batch = { ...p, kind: "batch", explanation: "Общежитие трём студентам", actions: { can_approve: true, can_reject: true },
  items: [row(1), row(2, { label: { record: "Сидоров Никита", sub: "ИДБ-23-11" } }), row(3, { state: "conflict" })] };
const pending = render(batch);
assert.match(pending, /Применить изменения\?/); assert.match(pending, /Применить 2 из 3/);
assert.match(pending, /Студент/); assert.match(pending, /student_id=2/); assert.match(pending, /Сидоров Никита/);
assert.match(pending, /CH-02/); assert.match(pending, /Нуждается в общежитии: было → стало/);
assert.doesNotMatch(pending, />Подтвердить</);
const done = render({ ...batch, status: "approved", actions: { can_undo: true },
  execution: { status: "succeeded", picked_item_ids: [1, 2] }, items: [row(1), row(2, { reversible: false, undo_reason: "sheet_closed" }), row(3, { reversible: false })] });
assert.match(done, /Пакетное изменение/); assert.match(done, /Применено 2 из 3/); assert.match(done, /Пропущено/);
assert.match(done, /Ведомость закрыта — нужна заявка на исправление/); assert.match(done, /Отменить…/);
assert.doesNotMatch(render({ ...batch, status: "approved", actions: {}, execution: { status: "succeeded", picked_item_ids: [1] } }), /Отменить…/);
// После выполненной отмены: «Отменено» у возвращённых строк, «Не отменено» у снятых — не «срок истёк»
undone = new Set([1]);
const reverted = render({ ...batch, status: "approved", actions: {}, execution: { status: "succeeded", picked_item_ids: [1, 3], undo_id: "inverse" },
  items: [row(1, { reversible: false, undo_reason: "expired" }), row(2, { reversible: false }), row(3, { reversible: false, undo_reason: "expired" })] });
assert.match(reverted, /Отменено/); assert.match(reverted, /Не отменено/); assert.doesNotMatch(reverted, /Срок отмены истёк|Внимание/);
undone = undefined;
// Тело решения по пакету — с picked_item_ids; отмена — только выбранные строки
const decided = api.createProposalAttempt(batch, { action: "decision", approve: true, reason: "Проверено, применяем", picked_item_ids: [1, 2] });
assert.deepEqual(decided.body.picked_item_ids, [1, 2]);
assert.throws(() => api.createProposalAttempt(batch, { action: "decision", approve: true, reason: "Проверено, применяем", picked_item_ids: [] }));
assert.throws(() => api.createProposalAttempt(batch, { action: "undo", picked_item_ids: [1] }));
const undo = api.createProposalAttempt({ ...batch, actions: { can_undo: true } }, { action: "undo", picked_item_ids: [2] });
assert.equal(undo.action, "undo"); assert.deepEqual(undo.body, { picked_item_ids: [2] });

// Карточка в чате: пакет — «Пакет изменений · N записей», решение «Применено»; одиночное — как раньше
const batchCard = presentation.cardText({ ...batch, preview: { operation: "BATCH", table: "Пакет изменений", items: [1, 2, 3], changed_columns: ["a", "b", "c"], affected_rows: 3 } }, {});
assert.equal(batchCard.sub, "Пакет изменений · 3 записи"); assert.equal(batchCard.button, "Проверить изменения"); assert.equal(batchCard.badge, null);
assert.equal(presentation.cardText({ ...batch, preview: { operation: "BATCH", table: "Пакет изменений", items: [1], changed_columns: ["a"], affected_rows: 1 } }, {}, "approved").badge, "Применено");
const single = presentation.cardText(p, { person: "Личные данные" }, "approved");
assert.match(single.sub, /^Личные данные · /); assert.equal(single.badge, "Подтверждено"); assert.equal(single.button, "Открыть");

// Очередь предложений перенесена из чата во вкладку «Согласование» (pages/ApprovalsPage.tsx)
console.log("Proposal API/immutable attempt assertions and React server-render action/status checks passed. Hooks, click flows and browser remain integration work.");
