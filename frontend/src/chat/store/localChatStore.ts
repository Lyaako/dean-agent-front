import type { Chat, ChatStore, ChatSummary } from "./ChatStore";

const MAX_CHATS = 50;
const MAX_MESSAGES = 300;

// Чаты пользователя в localStorage (ключ — user_id). Видны только в этом браузере.
export function localChatStore(userId: number): ChatStore {
  const key = `deanery.chats.${userId}`;
  const read = (): Chat[] => {
    try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
  };
  const write = (chats: Chat[]) => {
    try { localStorage.setItem(key, JSON.stringify(chats.slice(0, MAX_CHATS))); } catch { /* хранилище недоступно или заполнено */ }
  };
  const summary = (c: Chat): ChatSummary => {
    const last = [...c.messages].reverse().find((m) => m.role !== "error");
    return { id: c.id, title: c.title, updatedAt: c.updatedAt, preview: last?.text.slice(0, 120) ?? "" };
  };
  return {
    async list() {
      return read().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary);
    },
    async get(id) {
      return read().find((c) => c.id === id) ?? null;
    },
    async save(chat) {
      const trimmed = { ...chat, messages: chat.messages.slice(-MAX_MESSAGES) };
      write([trimmed, ...read().filter((c) => c.id !== chat.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    },
    async rename(id, title) {
      write(read().map((c) => (c.id === id ? { ...c, title } : c)));
    },
    async remove(id) {
      write(read().filter((c) => c.id !== id));
    },
  };
}
