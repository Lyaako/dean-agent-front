import type { ProposalSummary } from "../../api/proposals";
import type { AttachmentContext } from "../../api/agent";
import type { ExtractionResult } from "../../api/files";

export interface AttachmentMeta {
  file_id: string;
  version_id: string;
  title: string;
  filename: string;
  mime: string;
  size: number;
  extraction?: ExtractionResult;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "error";
  text: string;
  at: string;
  runId?: string;
  attachment_context?: AttachmentContext;
  attachments?: AttachmentMeta[];
  proposals?: ProposalSummary[];
  tools?: string[];
  requestId?: string;
  /** Актуальные решения из серверной истории. */
  decisions?: Record<string, "approved" | "rejected">;
}

export interface ChatSummary { id: string; title: string; updatedAt: string; preview: string }

export interface SessionInfo {
  id: string;
  title: string;
  sessionId: string;
  activeRunId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Chat extends SessionInfo { messages: ChatMessage[] }

export interface ChatStore {
  list(signal?: AbortSignal): Promise<ChatSummary[]>;
  get(id: string, signal?: AbortSignal): Promise<Chat>;
  create(title: string, key: string, signal?: AbortSignal): Promise<SessionInfo>;
  rename(id: string, title: string): Promise<SessionInfo>;
  remove(id: string): Promise<void>;
}

export const titleFrom = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 59) + "…" : t || "Новый чат";
};
