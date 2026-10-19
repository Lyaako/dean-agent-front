import { api } from "../../api/client";
import type { ChatMessage, ChatStore, ChatSummary, SessionInfo } from "./ChatStore";

interface Page<T> { items: T[]; limit: number; offset: number; has_more: boolean }

export async function allPages<T>(read: (offset: number) => Promise<Page<T>>): Promise<T[]> {
  const result: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await read(offset);
    result.push(...page.items);
    if (!page.has_more) return result;
    if (!page.items.length) throw new Error("Сервер вернул пустую страницу истории. Повторите загрузку.");
    offset += page.items.length;
  }
}

export const serverChatStore: ChatStore = {
  list: (signal) => allPages<ChatSummary>((offset) => api("/agent/sessions", { query: { limit: 500, offset }, signal })),
  async get(id, signal) {
    const [info, messages] = await Promise.all([
      api<SessionInfo>(`/agent/sessions/${id}`, { signal }),
      allPages<ChatMessage>((offset) => api(`/agent/sessions/${id}/messages`, { query: { limit: 500, offset }, signal })),
    ]);
    // History may finish while the parallel session read still reports the old run.
    const terminal = messages.some((m) => m.runId === info.activeRunId && m.role !== "user");
    return { ...info, activeRunId: terminal ? null : info.activeRunId, messages };
  },
  create: (title, key, signal) => api("/agent/sessions", { method: "POST", json: { title }, headers: { "Idempotency-Key": key }, signal }),
  rename: (id, title) => api(`/agent/sessions/${id}`, { method: "PATCH", json: { title } }),
  remove: (id) => api(`/agent/sessions/${id}`, { method: "DELETE" }),
};
