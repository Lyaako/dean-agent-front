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
let current = p, loadError = null;
const dialog = await load("chat/proposals/ProposalDialog.tsx", {
  "react": React, "react/jsx-runtime": jsx,
  "../../components/Icon": { Icon: () => null },
  "../../components/ui": { Modal: ({ children }) => React.createElement("section", null, children), Badge: ({ children }) => React.createElement("span", null, children), ErrorNote: ({ text }) => text },
  "./useProposal": { REASON_MIN: 10, TABLE_NAME: { person: "Личные данные" }, useProposal: () => ({ proposal: current, rows: [], reason: "", reasonOk: false,
    reasonMax: 2000, reasonError: null, events: {}, assignees: {}, tableName: "person", operation: "UPDATE", loadError }) },
  "../../lib/chatPrefill": { prefillChat() {} },
  "../../components/form/lookups": { useLookup: () => ({}) },
  "../../auth/AuthProvider": { useAuth: () => ({ me: { user_id: 8 } }) },
  "../../api/errors": { errorText: String },
  "../attachments/Thumbs": { FileViewer: () => null, MessageThumbs: () => null },
  "./presentation": presentation,
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

// Очередь предложений перенесена из чата во вкладку «Согласование» (pages/ApprovalsPage.tsx)
console.log("Proposal API/immutable attempt assertions and React server-render action/status checks passed. Hooks, click flows and browser remain integration work.");
