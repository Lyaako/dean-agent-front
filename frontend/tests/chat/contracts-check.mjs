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
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const storage = {};
globalThis.sessionStorage = Object.assign(storage, {
  getItem: (key) => storage[key] ?? null, setItem: (key, value) => { storage[key] = value; }, removeItem: (key) => { delete storage[key]; },
});
const recovery = await load("chat/store/recovery.ts");
const pending = { key: id(1), createKey: id(2), title: "Чат", body: { message: "Привет", session_id: id(3), attachments: [{ file_id: id(4), version_id: id(5) }] }, chatId: id(3), runId: null, after: 0, terminal: false };
recovery.savePending(1, [pending, { ...pending, key: id(6), runId: id(7) }]);
assert.equal(recovery.readPending(1).length, 2);
assert.deepEqual(recovery.readPending(1)[0], pending);
storage["deanery.chat.pending.1"] = JSON.stringify([{ ...pending, onAccepted: "must not reach runtime", status: "must not reach UI" }]);
assert.deepEqual(recovery.readPending(1)[0], pending);
assert.deepEqual(recovery.readPending(2), []);
for (const bad of [{ ...pending, key: "bad" }, { ...pending, after: -1 }, { ...pending, body: { message: "x" } }, { ...pending, body: { ...pending.body, attachments: [{ file_id: id(4) }] } }, { ...pending, body: { ...pending.body, message: "x".repeat(16001) } }, { ...pending, body: { ...pending.body, user_id: 9 } }]) {
  storage["deanery.chat.pending.1"] = JSON.stringify([bad]);
  assert.throws(() => recovery.readPending(1), /повреждены/);
}
recovery.activeChat(1, id(3)); assert.equal(recovery.activeChat(1), id(3));
storage.unrelated = "kept"; recovery.clearChatRecovery();
assert.equal(storage.unrelated, "kept"); assert.deepEqual(recovery.readPending(1), []); assert.equal(recovery.activeChat(1), null);
const originalSet = storage.setItem; storage.setItem = () => { throw new Error("quota"); };
assert.throws(() => recovery.savePending(1, [pending]), /quota/); storage.setItem = originalSet;

const wire = [];
const agent = await load("api/agent.ts", {
  "../chat/store/recovery": recovery,
  "./client": { api: async (...args) => { wire.push(args); return {}; }, apiRaw: async (...args) => { wire.push(args); return new Response(": heartbeat\n\n"); } },
});
const frame = `: heartbeat\r\n\r\nid: 1\r\nevent: session\r\ndata: {"session_id":"${id(3)}",\r\ndata: "run_id":"${id(7)}"}\r\n\r\nid: 2\r\nevent: status\r\ndata: {"phase":"model","message":"Русский текст"}\r\n\r\n`;
const bytes = new TextEncoder().encode(frame);
const response = (chunks) => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }));
for (let split = 1; split < bytes.length; split++) {
  const events = []; await agent.readEvents(response([bytes.slice(0, split), bytes.slice(split)]), (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.id), [1, 2]); assert.equal(events[1].data.message, "Русский текст");
}
const byteEvents = []; await agent.readEvents(response([...bytes].map((byte) => Uint8Array.of(byte))), (event) => byteEvents.push(event));
assert.equal(byteEvents.length, 2);
let cursor = 0;
await assert.rejects(agent.readEvents(new Response(frame + 'id: 3\nevent: done\ndata: {'), (event) => { cursor = event.id; }), /внутри события/); assert.equal(cursor, 2);
for (const block of ['id: nope\nevent: status\ndata: {}', 'id: 1\nevent: session\ndata: {}', 'id: 1\nevent: done\ndata: null']) assert.throws(() => agent.parseEvent(block));
cursor = 0;
await assert.rejects(agent.readEvents(new Response(frame), () => { throw new Error("application failed"); }), /application failed/); assert.equal(cursor, 0);
const ac = new AbortController();
await agent.streamChat(pending.body, pending.key, () => {}, ac.signal);
await agent.streamChat(pending.body, pending.key, () => {}, ac.signal);
assert.deepEqual(wire[0], wire[1]); assert.equal(wire[0][1].headers["Idempotency-Key"], pending.key);
await agent.replayChat(id(7), 2, () => {}, ac.signal); assert.deepEqual(wire[2][1].query, { after: 2 });
ac.abort(); assert.equal(wire.length, 3, "disconnect sends no cancel command");
await agent.cancelRun(id(7)); assert.deepEqual(wire[3], [`/agent/runs/${id(7)}/cancel`, { method: "POST", json: {} }]);

let storeCalls = [];
const store = await load("chat/store/serverChatStore.ts", { "../../api/client": { api: async (path, options) => {
  storeCalls.push([path, options]);
  if (path.endsWith("/messages")) return { items: [{ id: "terminal", runId: id(7), role: "agent" }], has_more: false };
  return { id: id(3), activeRunId: id(7) };
} } });
const rows = Array.from({ length: 1101 }, (_, n) => n);
const offsets = [];
const all = await store.allPages(async (offset) => { offsets.push(offset); return { items: rows.slice(offset, offset + 500), has_more: offset + 500 < rows.length }; });
assert.deepEqual(all, rows); assert.deepEqual(offsets, [0, 500, 1000]);
await assert.rejects(store.allPages(async () => ({ items: [], has_more: true })), /пустую страницу/);
assert.equal((await store.serverChatStore.get(id(3))).activeRunId, null, "terminal history wins over stale active-run read");
await store.serverChatStore.create("Имя", id(2)); await store.serverChatStore.rename(id(3), "Другое"); await store.serverChatStore.remove(id(3));
assert.equal(storeCalls[2][1].headers["Idempotency-Key"], id(2));
assert.deepEqual(storeCalls[3][1], { method: "PATCH", json: { title: "Другое" } }); assert.equal(storeCalls[4][1].method, "DELETE");

const fileCalls = [];
const files = await load("api/files.ts", { "./client": { newKey: () => id(1), api: async (...args) => { fileCalls.push(args); return { status: "succeeded", result: { extraction_state: "partial" } }; }, apiRaw: async (...args) => { fileCalls.push(args); return new Response("protected"); } } });
await files.uploadFile(new File(["text"], "a.txt", { type: "wrong" }), id(8));
assert.equal(fileCalls[0][1].headers["Idempotency-Key"], id(8)); assert.equal(fileCalls[0][1].body.get("file").type, "text/plain");
assert.equal((await files.waitJob(id(9))).result.extraction_state, "partial");
await files.downloadVersion(id(4), id(5)); await files.downloadVersion(id(4), id(5));
assert.equal(fileCalls[2][0], `/files/${id(4)}/versions/${id(5)}/download`); assert.equal(fileCalls[3][0], fileCalls[2][0]);
console.log(`PASS: recovery isolation/validation/storage failure; SSE ${bytes.length - 1} split positions + byte chunks, malformed/application failure/immutable send/replay/cancel; 1101-row paging/contracts/terminal race; upload/partial/exact-version fresh download.`);
