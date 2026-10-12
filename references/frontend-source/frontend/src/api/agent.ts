// Агент: потоковый чат (POST + SSE), предложения изменений, вложения (docs/INTEGRATION.md)
import { api, apiRaw, newKey } from "./client";

export interface ProposalPreview {
  operation: "INSERT" | "UPDATE";
  table: string;
  affected_rows: number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  changed_columns: string[];
  snapshot_hash: string | null;
  related_effects: string[];
  note: string | null;
  applied?: Record<string, unknown> | null;
}
export interface ProposalSummary { id: string; preview: ProposalPreview; explanation: string; reason: string }
export interface Proposal extends ProposalSummary {
  status: "pending" | "approved" | "rejected";
  sql_text: string;
  decided_by: string | null;
  decision_reason: string | null;
}

export interface AttachmentRef { file_id: string; version_id: string }
export interface ChatResult {
  run_id: string;
  session_id: string;
  answer: string;
  proposals: ProposalSummary[];
  tools_used: string[];
  attachment_context?: unknown;
}

export type ChatEvent =
  | { event: "status"; data: { phase: string; message: string; elapsed_s?: number } }
  | { event: "session"; data: { session_id: string; run_id: string } }
  | { event: "tool_call"; data: { name: string; run_id: string; input: unknown } }
  | { event: "tool_result"; data: { run_id: string; output: string; truncated: boolean } }
  | { event: "done"; data: ChatResult }
  | { event: "error"; data: { type: string; message: string; run_id?: string; session_id?: string } };

// Разбор SSE: события разделены пустой строкой и могут прийти частями в любых кусках сети
function parseEvent(block: string): ChatEvent | null {
  let event = "message", data = "";
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) } as ChatEvent; } catch { return null; }
}

export async function streamChat(
  body: { message: string; session_id?: string | null; attachments?: AttachmentRef[] },
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const payload: Record<string, unknown> = { message: body.message };
  if (body.session_id) payload.session_id = body.session_id;
  if (body.attachments?.length) payload.attachments = body.attachments;
  const res = await apiRaw("/agent/chat/stream", { method: "POST", json: payload, signal, headers: { Accept: "text/event-stream" } });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const ev = parseEvent(block);
      if (ev) onEvent(ev);
    }
  }
  if (buf.trim()) { const ev = parseEvent(buf); if (ev) onEvent(ev); }
}

export const getProposal = (id: string) => api<Proposal>(`/agent/proposals/${id}`);

export const decideProposal = (id: string, approve: boolean, reason: string, idempotencyKey = newKey()) =>
  api<{ id: string; status: "approved" | "rejected"; preview: ProposalPreview }>(`/agent/proposals/${id}/decision`, {
    method: "POST", json: { approve, reason }, headers: { "Idempotency-Key": idempotencyKey },
  });

export interface Capabilities {
  attachment_context: {
    protocol: string; backend_supported: boolean; agent_supported: boolean; agent_status: "ready" | "unavailable";
    max_attachments: number; max_total_bytes: number; max_text_chunks: number;
  };
}
export const getCapabilities = () => api<Capabilities>("/agent/capabilities");
