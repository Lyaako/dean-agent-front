// Логика окна «разрешить / отклонить» изменение агента. Внешний вид окна — в ProposalDialog
// (временный; финальный будет по шаблону из другого проекта), логика при этом не меняется.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { decideProposal, getProposal, type Proposal } from "../../api/agent";
import { newKey } from "../../api/client";
import { errorText, requestIdOf } from "../../api/errors";
import { fieldLabel, useSchema, type FieldSpec } from "../../api/schema";
import { useAuth } from "../../auth/AuthProvider";
import { STAFF_ROLES } from "../../api/auth";

export interface DiffRow { field: string; label: string; spec?: FieldSpec; before: unknown; after: unknown }

// Таблицы, которые агент может менять (PROPOSAL_TABLES бэкенда)
export const TABLE_NAME: Record<string, string> = {
  document_request: "Заявка на справку", academic_work: "Курсовая работа / ВКР", grade: "Оценка", attendance: "Посещаемость",
  practice_placement: "Направление на практику", teaching_assignment: "Учебное поручение", schedule_slot: "Занятие в расписании",
  organization_contact: "Контакт организации", contact_person: "Контактное лицо", grade_sheet: "Ведомость",
};

export const REASON_MIN = 10;
export const REASON_MAX = 2000;

export function useProposal(id: string, onDecided?: (status: "approved" | "rejected") => void) {
  const qc = useQueryClient();
  const { role } = useAuth();
  const { data: schema } = useSchema();
  const q = useQuery({ queryKey: ["proposal", id], queryFn: () => getProposal(id), staleTime: 0 });
  const idemKey = useMemo(newKey, []);   // один ключ на открытие окна: повторное нажатие не применит дважды
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<{ text: string; requestId?: string } | null>(null);

  const p: Proposal | undefined = q.data;
  const rows: DiffRow[] = useMemo(() => {
    if (!p) return [];
    const spec = schema?.[p.preview.table];
    return p.preview.changed_columns.map((f) => ({
      field: f,
      label: fieldLabel(spec?.fields[f], f),
      spec: spec?.fields[f],
      before: p.preview.before?.[f] ?? null,
      after: p.preview.after?.[f] ?? null,
    }));
  }, [p, schema]);

  const canDecide = !!role && STAFF_ROLES.includes(role) && p?.status === "pending";
  const reasonOk = reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX;

  async function decide(approve: boolean) {
    if (!reasonOk) return;
    setBusy(approve ? "approve" : "reject");
    setError(null);
    try {
      const res = await decideProposal(id, approve, reason.trim(), idemKey);
      qc.setQueryData(["proposal", id], (old: Proposal | undefined) => (old ? { ...old, status: res.status, preview: res.preview } : old));
      if (approve) {
        qc.invalidateQueries({ queryKey: ["res"] });
        qc.invalidateQueries({ queryKey: ["row"] });
        qc.invalidateQueries({ queryKey: ["lookup"] });
      }
      onDecided?.(res.status);
    } catch (e) {
      setError({ text: errorText(e), requestId: requestIdOf(e) });
      q.refetch();
    } finally {
      setBusy(null);
    }
  }

  return {
    proposal: p, loading: q.isLoading, loadError: q.error ? errorText(q.error) : null,
    tableName: p?.preview.table, operation: p?.preview.operation, rows,
    reason, setReason, reasonOk, canDecide, busy, error,
    approve: () => decide(true), reject: () => decide(false),
  };
}
