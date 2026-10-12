import { api, apiRaw } from "./client";
import type { ProposalSummary } from "./proposals";
import type { ExtractionCoverage } from "./files";
import { isUuid } from "../chat/store/recovery";

export interface AttachmentRef { file_id: string; version_id: string }
export interface AttachmentContextFile extends AttachmentRef {
  filename: string;
  extraction_state: string;
  context_state: string;
  read_mode: string;
  delivery_state: "pending" | "submitted" | "acknowledged" | "unknown";
  provided_chunk_ids: string[];
  read_chunk_ids: string[];
  cited_chunk_ids: string[];
  provided_pages: number[];
  cited_pages: number[];
  extraction_coverage: ExtractionCoverage;
  coverage: { total_pages?: number | null; provided_chunks?: number; truncated?: boolean };
  limits: Record<string, unknown>;
  warnings: string[];
}
export interface AttachmentContext { protocol: string; run_id: string; files: AttachmentContextFile[] }
export interface ChatBody { message: string; session_id?: string; attachments?: AttachmentRef[] }
export interface ChatResult {
  run_id: string; session_id: string; answer: string; proposals: ProposalSummary[]; tools_used: string[];
  attachment_context?: AttachmentContext;
}
export type ChatEvent = { id: number } & (
  | { event: "status"; data: { phase: string; message: string; elapsed_s?: number } }
  | { event: "session"; data: { session_id: string; run_id: string } }
  | { event: "tool_call"; data: { name: string; run_id: string; input: unknown } }
  | { event: "tool_result"; data: { run_id: string; output: string; truncated: boolean } }
  | { event: "done"; data: ChatResult }
  | { event: "error"; data: { type: string; message: string; run_id?: string; session_id?: string; manifest?: { attachment_context?: AttachmentContext } } }
);

export function parseEvent(block: string): ChatEvent | null {
  let event = "message", id = "";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new Error("Некорректный номер события агента");
  if (!["status", "session", "tool_call", "tool_result", "done", "error"].includes(event)) throw new Error("Неизвестное событие агента");
  const payload = JSON.parse(data.join("\n"));
  const valid = payload && typeof payload === "object" && !Array.isArray(payload)
    && (event === "session" ? isUuid(payload.session_id) && isUuid(payload.run_id)
      : event === "status" ? typeof payload.phase === "string" && typeof payload.message === "string"
      : event === "tool_call" ? isUuid(payload.run_id) && typeof payload.name === "string"
      : event === "tool_result" ? isUuid(payload.run_id) && typeof payload.output === "string" && typeof payload.truncated === "boolean"
      : event === "done" ? isUuid(payload.run_id) && isUuid(payload.session_id) && typeof payload.answer === "string" && Array.isArray(payload.proposals) && Array.isArray(payload.tools_used)
      : typeof payload.type === "string" && typeof payload.message === "string" && (payload.run_id === undefined || isUuid(payload.run_id)) && (payload.session_id === undefined || isUuid(payload.session_id)));
  if (!valid) throw new Error("Некорректные данные события агента");
  return { id: Number(id), event, data: payload } as ChatEvent;
}

export async function readEvents(res: Response, onEvent: (e: ChatEvent) => void | Promise<void>): Promise<void> {
  if (!res.body) throw new Error("Поток агента недоступен");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buf))) {
        const ev = parseEvent(buf.slice(0, boundary.index));
        buf = buf.slice(boundary.index + boundary[0].length);
        if (ev) await onEvent(ev);
      }
    }
    // An incomplete final frame is replayed; it must never advance the persisted cursor.
    if (buf.trim()) throw new Error("Соединение прервано внутри события агента");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function streamChat(body: ChatBody, key: string, onEvent: (e: ChatEvent) => void | Promise<void>, signal?: AbortSignal) {
  await readEvents(await apiRaw("/agent/chat/stream", { method: "POST", json: body, signal, headers: { Accept: "text/event-stream", "Idempotency-Key": key } }), onEvent);
}
export async function replayChat(runId: string, after: number, onEvent: (e: ChatEvent) => void | Promise<void>, signal?: AbortSignal) {
  await readEvents(await apiRaw(`/agent/runs/${runId}/events`, { query: { after }, signal, headers: { Accept: "text/event-stream" } }), onEvent);
}
export const cancelRun = (runId: string) => api<{ run_id: string; stop_requested: boolean }>(`/agent/runs/${runId}/cancel`, { method: "POST", json: {} });
export const getAttachmentContext = (runId: string) => api<AttachmentContext>(`/agent/runs/${runId}/attachment-context`);

export interface Capabilities {
  attachment_context: {
    protocol: string; backend_supported: boolean; agent_supported: boolean; agent_status: "ready" | "unavailable";
    max_attachments: number; max_total_bytes: number; max_text_chunks: number;
  };
}
export const getCapabilities = () => api<Capabilities>("/agent/capabilities");
