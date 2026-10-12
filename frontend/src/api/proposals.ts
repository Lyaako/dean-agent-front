import { api, newKey } from "./client";
import type { AttachmentMeta } from "../chat/store/ChatStore";

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
export type ProposalStatus = "pending" | "approved" | "rejected";
export type ExecutionStatus = "not_started" | "scheduled" | "running" | "succeeded" | "failed" | "cancelled";
export interface Proposal extends ProposalSummary {
  status: ProposalStatus;
  kind: string;
  submission_status: "draft" | "submitted" | null;
  correction_id: number | null;
  version: number;
  created_at: string;
  expires_at: string;
  initiator: { user_id: number; full_name: string };
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  validity: { state: "current" | "stale" | "expired" | "superseded"; reason: string | null };
  routing: { institute_id: number | null; assignee_user_id: number | null; assignee_name: string | null };
  execution: { status: ExecutionStatus; effective_date: string | null; order_id: number | null; job_id: string | null;
    started_at: string | null; completed_at: string | null; error: { code?: string; message?: string } | string | null };
  actions: { can_claim: boolean; can_assign: boolean; can_submit: boolean; can_approve: boolean; can_reject: boolean };
  context_files: (AttachmentMeta & { chunks: { chunk_id: string; page?: number; block?: number; block_end?: number }[] })[];
}
export type ProposalBox = "incoming" | "mine" | "completed";
export interface ProposalFilters {
  box: ProposalBox; status?: ProposalStatus; execution_status?: ExecutionStatus;
  author?: string; created_from?: string; created_to?: string; limit: number; offset: number;
}
export interface ProposalPage { items: Proposal[]; limit: number; offset: number; has_more: boolean; counts: Record<ProposalBox, number> }
export interface Assignee { user_id: number; full_name: string; role: string }
export interface ProposalEvent { id: number; actor_user_id: number | null; event_type: string; reason: string | null; data: Record<string, unknown>; created_at: string }
export interface EventPage { items: ProposalEvent[]; has_more: boolean }
export type ProposalIntent = { action: "decision"; approve: boolean; reason: string }
  | { action: "assignment"; assignee_user_id: number; reason: string; claim?: boolean }
  | { action: "submit" };
export type ProposalAttempt = Readonly<{ key: string; action: ProposalIntent["action"]; body: Readonly<Record<string, string | number | boolean>> }>;

export const getProposal = (id: string) => api<Proposal>(`/agent/proposals/${id}`);
export const listProposals = (filters: ProposalFilters) => api<ProposalPage>("/agent/proposals", { query: { ...filters } });
export const getAssignees = (id: string) => api<Assignee[]>(`/agent/proposals/${id}/assignees`);
export const getProposalEvents = (id: string, after = 0) => api<EventPage>(`/agent/proposals/${id}/events`, { query: { after, limit: 25 } });

export function createProposalAttempt(proposal: Proposal, intent: ProposalIntent): ProposalAttempt {
  const allowed = intent.action === "submit" ? proposal.actions.can_submit : intent.action === "decision"
    ? (intent.approve ? proposal.actions.can_approve : proposal.actions.can_reject)
    : intent.claim ? proposal.actions.can_claim : proposal.actions.can_assign;
  if (!allowed) throw new Error("Действие недоступно — обновите предложение");
  const body: Record<string, string | number | boolean> = { expected_version: proposal.version };
  if (intent.action !== "submit") {
    const reason = intent.reason.trim();
    if (reason.length < (intent.action === "decision" ? 10 : 1) || reason.length > 2000) throw new Error("Проверьте длину комментария");
    body.reason = reason;
    if (intent.action === "decision") body.approve = intent.approve;
    else {
      if (!Number.isSafeInteger(intent.assignee_user_id) || intent.assignee_user_id < 1) throw new Error("Выберите сотрудника");
      body.assignee_user_id = intent.assignee_user_id;
    }
  }
  return Object.freeze({ key: newKey(), action: intent.action, body: Object.freeze(body) });
}

export const sendProposalAttempt = (id: string, attempt: ProposalAttempt) => api<Proposal>(`/agent/proposals/${id}/${attempt.action}`, {
  method: "POST", json: attempt.body, headers: { "Idempotency-Key": attempt.key },
});
