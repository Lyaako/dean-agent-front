import { useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createProposalAttempt, getAssignees, getProposal, getProposalEvents, reasonMax, REASON_MIN, sendProposalAttempt,
  type Proposal, type ProposalAttempt, type ProposalIntent } from "../../api/proposals";
import { ApiError } from "../../api/client";
import { errorCode, errorText, requestIdOf } from "../../api/errors";
import { fieldLabel, useSchema, type FieldSpec } from "../../api/schema";

export interface DiffRow { field: string; label: string; spec?: FieldSpec; before: unknown; after: unknown }
export const TABLE_NAME: Record<string, string> = {
  document_request: "Заявка на справку", academic_work: "Курсовая работа / ВКР", grade: "Оценка", attendance: "Посещаемость",
  practice_placement: "Направление на практику", teaching_assignment: "Учебное поручение", schedule_slot: "Занятие в расписании",
  organization_contact: "Контакт организации", contact_person: "Контактное лицо", grade_sheet: "Ведомость",
  student: "Студент", person: "Личные данные", employee: "Сотрудник", academic_leave: "Академический отпуск",
  scholarship: "Стипендия", student_scholarship: "Назначение стипендии", scholarship_assignment: "Назначение стипендии",
  order: "Приказ", student_order: "Приказ", order_student: "Студент в приказе", grade_correction: "Коррекция оценки",
};
export { REASON_MIN };

export function useProposal(id: string, onDecided?: (proposal: Proposal) => void) {
  const qc = useQueryClient();
  const { data: schema } = useSchema();
  const q = useQuery({ queryKey: ["proposal", id], queryFn: () => getProposal(id), staleTime: 0 });
  const events = useInfiniteQuery({ queryKey: ["proposal-events", id], initialPageParam: 0,
    queryFn: ({ pageParam }) => getProposalEvents(id, pageParam),
    getNextPageParam: (page) => page.has_more ? page.items.at(-1)?.id : undefined, enabled: !!q.data });
  const assignees = useQuery({ queryKey: ["proposal-assignees", id, q.data?.version], queryFn: () => getAssignees(id), enabled: !!q.data?.actions.can_assign });
  const attemptKey = ["proposal-attempt", id];
  const [attempt, setAttempt] = useState<ProposalAttempt | null>(() => qc.getQueryData<ProposalAttempt>(attemptKey) ?? null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState<{ text: string; requestId?: string; code?: string } | null>(null);
  // Ошибка длины с details.field = "reason" — под полем: комментария к решению или причины передачи
  const [reasonError, setReasonError] = useState<{ action: ProposalIntent["action"]; text: string } | null>(null);
  const p = q.data;
  const rows: DiffRow[] = useMemo(() => {
    if (!p) return [];
    const spec = schema?.[p.preview.table];
    return p.preview.changed_columns.map((f) => ({ field: f, label: fieldLabel(spec?.fields[f], f), spec: spec?.fields[f],
      before: p.preview.before?.[f] ?? null, after: p.preview.after?.[f] ?? null }));
  }, [p, schema]);

  async function mutate(intent?: ProposalIntent) {
    if (sending.current || !p) return;
    sending.current = true; setBusy(true); setError(null); setReasonError(null);
    try {
      const current = attempt ?? (intent ? createProposalAttempt(p, intent) : null);
      if (!current) return;
      // Retain the exact attempt on an ambiguous outcome, including closing and reopening this dialog.
      qc.setQueryData(attemptKey, current); setAttempt(current);
      const result = await sendProposalAttempt(id, current);
      qc.removeQueries({ queryKey: attemptKey, exact: true }); setAttempt(null);
      qc.setQueryData(["proposal", id], result);
      for (const key of ["proposals", "proposal-events", "proposal-assignees", "res", "row", "lookup"]) void qc.invalidateQueries({ queryKey: [key] });
      onDecided?.(result);
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408) {
        qc.removeQueries({ queryKey: attemptKey, exact: true }); setAttempt(null);
      }
      const field = e instanceof ApiError ? (e.details as { field?: unknown; max?: unknown } | null)?.field : undefined;
      if (e instanceof ApiError && e.code === "validation_error" && field === "reason") {
        const max = Number((e.details as { max?: unknown }).max) || reasonMax(p, (attempt ?? intent)?.action);
        setReasonError({ action: (attempt ?? intent)!.action, text: `От ${REASON_MIN} до ${max} символов` });
      } else setError({ text: errorText(e), requestId: requestIdOf(e), code: errorCode(e) });
      void q.refetch();
      void qc.invalidateQueries({ queryKey: ["proposals"] });
    } finally { sending.current = false; setBusy(false); }
  }
  return { proposal: p, loading: q.isLoading, loadError: q.error ? errorText(q.error) : null, refresh: q.refetch,
    tableName: p?.preview.table, operation: p?.preview.operation, rows, reason, setReason,
    reasonMax: reasonMax(p),
    reasonOk: reason.trim().length >= REASON_MIN && reason.trim().length <= reasonMax(p),
    busy, error, reasonError, attempt, mutate, events, assignees };
}
