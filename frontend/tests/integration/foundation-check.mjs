import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { SourceTextModule, SyntheticModule } from "node:vm";

async function load(relative, mocks = {}) {
  const filename = fileURLToPath(new URL(`../../src/${relative}`, import.meta.url));
  const module = new SourceTextModule(stripTypeScriptTypes(readFileSync(filename, "utf8"), { mode: "transform" }), { identifier: filename });
  await module.link((name) => {
    assert.ok(name in mocks, `Unexpected dependency: ${name}`);
    return new SyntheticModule(Object.keys(mocks[name]), function () { for (const [key, value] of Object.entries(mocks[name])) this.setExport(key, value); });
  });
  await module.evaluate();
  return module.namespace;
}

const memory = new Map();
globalThis.localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
const client = await load("api/client.ts");
let calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push([url, opts]);
  return new Response(JSON.stringify(url.endsWith("/auth/refresh") ? { access_token: "renewed" } : calls.filter(([u]) => !u.endsWith("/auth/refresh")).length === 1 ? { error: { code: "invalid_token", message: "expired" } } : { ok: true }),
    { status: url.endsWith("/auth/refresh") || calls.filter(([u]) => !u.endsWith("/auth/refresh")).length > 1 ? 200 : 401 });
};
client.session.start("old", "csrf");
const mutationCode = await client.api("/resources/employee", { method: "POST", json: { person_id: 1 } }).then(() => "replayed", (e) => e.code);
const mutationRequests = calls.filter(([url]) => url.endsWith("/resources/employee")).length;

calls = [];
assert.deepEqual(await client.api("/resources/person"), { ok: true });
assert.equal(calls.filter(([url]) => url.endsWith("/resources/person")).length, 2, "GET refresh replay");
calls = [];
assert.deepEqual(await client.api("/workflows/transfer", { json: { student_id: 1 }, headers: { "Idempotency-Key": "stable" } }), { ok: true });
assert.equal(calls[0][1].headers["Idempotency-Key"], calls[2][1].headers["Idempotency-Key"]);

let resolveRefresh;
globalThis.fetch = () => new Promise((resolve) => { resolveRefresh = resolve; });
const refresh = client.refreshSession();
client.session.clear();
resolveRefresh(new Response(JSON.stringify({ access_token: "late" })));
const lateRefresh = await refresh;
const restoredAccess = client.session.hasAccess();

client.session.start("first-account", "first-csrf");
let resolveOld;
globalThis.fetch = () => new Promise((resolve) => { resolveOld = resolve; });
const oldRequest = client.api("/resources/person");
client.session.start("other-account", "other-csrf");
resolveOld(new Response(JSON.stringify({ private: "first account" })));
const oldResponseCode = await oldRequest.then(() => "delivered", (e) => e.code);

let pageCount = 0;
const resources = await load("api/resources.ts", {
  "@tanstack/react-query": { useQuery: () => {} },
  "./client": { ...client, api: async () => ({ items: [{ id: ++pageCount }], has_more: true }) },
});
await assert.rejects(resources.fetchAll("person"), (e) => e.code === "resource_too_large");
assert.equal(pageCount, 40);
const complete = await load("api/resources.ts", {
  "@tanstack/react-query": { useQuery: () => {} }, "./client": { ...client, api: async () => ({ items: [{ id: 1 }], has_more: false }) },
});
assert.deepEqual(await complete.fetchAll("person"), [{ id: 1 }]);

let query;
const olap = await load("api/olap.ts", { "./client": { api: async (_, opts) => { query = opts.query; return opts.query; } } });
assert.equal(olap.OLAP_MODES.length, 8);
for (const [mode] of olap.OLAP_MODES) {
  await olap.fetchOlap(mode, { group_id: 1, discipline_id: 2, semester: 3, status_id: 4 });
  assert.deepEqual(query, { mode, group_id: 1, discipline_id: 2, semester: 3, status_id: 4 });
}
const logic = await load("pages/olapLogic.ts");
const dimensions = { "rollup-group": "group_id", "rollup-discipline": "discipline_id", "rollup-semester": "semester", "slice-group": "discipline_id", "slice-discipline": "group_id", "drilldown-group": "student_id", "cross-group-semester": "group_id" };
for (const [mode, dimension] of Object.entries(dimensions)) {
  assert.notEqual(logic.olapRowKey(mode, { name: "Одинаковое имя", [dimension]: 1 }), logic.olapRowKey(mode, { name: "Одинаковое имя", [dimension]: 2 }));
}
assert.notEqual(logic.olapRowKey("dice", { student_id: 1, discipline_id: 2, semester: 1 }), logic.olapRowKey("dice", { student_id: 2, discipline_id: 2, semester: 1 }));
assert.notEqual(logic.olapRowKey("dice", { student_id: 1, discipline_id: 2, semester: 1 }), logic.olapRowKey("dice", { student_id: 1, discipline_id: 3, semester: 1 }));
const scale = logic.chartScale([{ min_points: 10, max_points: 19, mark: 3 }, { min_points: 20, max_points: 40, mark: 4 }]);
assert.equal(scale.percent(10), 0); assert.equal(scale.percent(40), 100); assert.equal(scale.mark(30), 4);
assert.equal(logic.chartScale([]), null);
assert.equal(logic.chartPath([{ avg: "20" }, { avg: null }, { avg: "35" }, { avg: "30" }], (i) => i, (v) => v), "M0,20  M2,35 L3,30");
console.log({ mutationCode, mutationRequests, lateRefresh, restoredAccess, oldResponseCode });
assert.equal(mutationCode, "session_refreshed");
assert.equal(mutationRequests, 1, "unkeyed mutation must not automatically replay");
assert.equal(lateRefresh, false);
assert.equal(restoredAccess, false, "late refresh cannot restore a logged-out account");
assert.equal(oldResponseCode, "session_changed", "old account response cannot enter the new account cache");
console.log("Foundation assertions passed: session boundary/replay, pagination, all eight OLAP modes, stable IDs and null chart gaps.");
