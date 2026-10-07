// Хранилище чатов. Сейчас — в браузере (localChatStore); когда бэкенд отдаст список сессий и сообщения
// (GET /agent/sessions, GET /agent/sessions/{id}/messages), появится serverChatStore с тем же интерфейсом.
import type { ProposalSummary } from "../../api/agent";

export interface AttachmentMeta {
  file_id: string;
  version_id: string;
  title: string;
  filename: string;
  mime: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "error";
  text: string;
  at: string;
  attachments?: AttachmentMeta[];
  proposals?: ProposalSummary[];
  tools?: string[];
  requestId?: string;
  /** Решение по предложению агента, принятое в этом браузере: id → статус */
  decisions?: Record<string, "approved" | "rejected">;
}

export interface ChatSummary { id: string; title: string; updatedAt: string; preview: string }

export interface Chat {
  id: string;
  title: string;
  sessionId: string | null;   // сессия агента на бэкенде: с ней агент помнит контекст диалога
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatStore {
  list(): Promise<ChatSummary[]>;
  get(id: string): Promise<Chat | null>;
  save(chat: Chat): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export const titleFrom = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 59) + "…" : t || "Новый чат";
};
