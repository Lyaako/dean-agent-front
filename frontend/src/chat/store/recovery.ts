import type { ChatBody } from "../../api/agent";

export interface PendingRun {
  key: string;
  createKey: string;
  title: string;
  body: ChatBody | null;
  chatId: string | null;
  runId: string | null;
  after: number;
  terminal: boolean;
}
const PREFIX = "deanery.chat.";
const pendingKey = (userId: number) => `${PREFIX}pending.${userId}`;
export const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function readPending(userId: number): PendingRun[] {
  const stored = JSON.parse(sessionStorage.getItem(pendingKey(userId)) || "[]");
  const values: PendingRun[] = Array.isArray(stored) ? stored : stored ? [stored] : [];
  const keys = new Set<string>();
  for (const value of values) {
    const body = value?.body;
    if (!value || !isUuid(value.key) || keys.has(value.key) || !isUuid(value.createKey)
      || typeof value.title !== "string" || !value.title.trim() || value.title.length > 255
      || !Number.isSafeInteger(value.after) || value.after < 0 || typeof value.terminal !== "boolean"
      || (value.chatId !== null && !isUuid(value.chatId)) || (value.runId !== null && !isUuid(value.runId))
      || (value.runId && !value.chatId) || (!body && !value.runId)
      || (body !== null && (typeof body?.message !== "string" || !body.message.trim() || body.message.length > 16000
        || Object.keys(body).some((key) => !["message", "session_id", "attachments"].includes(key))
        || (body.session_id ?? null) !== value.chatId
        || (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > 5
          || body.attachments.some((ref) => !isUuid(ref?.file_id) || !isUuid(ref?.version_id)
            || Object.keys(ref).some((key) => !["file_id", "version_id"].includes(key)))))))) {
      throw new Error("Данные восстановления чата повреждены. Отправка не повторена; откройте беседу из списка.");
    }
    keys.add(value.key);
  }
  return values.map(({ key, createKey, title, body, chatId, runId, after, terminal }) => ({ key, createKey, title, body, chatId, runId, after, terminal }));
}
export function savePending(userId: number, values: PendingRun[]) {
  if (values.length) sessionStorage.setItem(pendingKey(userId), JSON.stringify(values.map(({ key, createKey, title, body, chatId, runId, after, terminal }) => ({ key, createKey, title, body, chatId, runId, after, terminal }))));
  else sessionStorage.removeItem(pendingKey(userId));
}
export function activeChat(userId: number, value?: string | null): string | null {
  try {
    const key = `${PREFIX}active.${userId}`;
    if (value !== undefined) { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); }
    const stored = sessionStorage.getItem(key);
    return isUuid(stored) ? stored : null;
  } catch { return null; }
}
export function clearChatRecovery() {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch { /* Browser storage unavailable. */ }
}
