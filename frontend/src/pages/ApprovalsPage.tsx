import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Page } from "../components/Shell";
import { Badge, Seg } from "../components/ui";
import { TableTools } from "../components/table/TableTools";
import { DataTable } from "../components/table/DataTable";
import { useTableState } from "../components/table/useTableState";
import { applyTable, type Column } from "../components/table/tableLogic";
import { useAuth } from "../auth/AuthProvider";
import { listProposals, type Proposal, type ProposalBox } from "../api/proposals";
import { errorText } from "../api/errors";
import { fmtDateTime } from "../lib/format";
import { ProposalDialog } from "../chat/proposals/ProposalDialog";

/* ═════════ СОГЛАСОВАНИЕ ═════════
   Входящие — что я могу решить; Мои — отправленные мной; История — решённые, отменённые и истёкшие (так делит сервер).
   Строка открывает окно решения — то же, что в чате. Кнопки окна — по флагам сервера (actions.*) */

const PAGE = 100, MAX_PAGES = 20;

// Решение: истёкшее — «Истекло», иначе по статусу
const decision = (p: Proposal) => (p.status === "pending" && p.validity.state === "expired" ? "Истекло"
  : { pending: "Ждёт решения", approved: "Одобрено", rejected: "Отклонено" }[p.status]);
const DECISION_KIND: Record<string, string> = { "Одобрено": "ok", "Отклонено": "bad", "Истекло": "muted", "Ждёт решения": "info" };
// Исполнение: пока не начато — «—»
const EXECUTION: Record<string, string> = { scheduled: "Запланировано", running: "Исполняется", succeeded: "Выполнено", failed: "Ошибка", cancelled: "Отменено" };
const EXECUTION_KIND: Record<string, string> = { "Выполнено": "ok", "Ошибка": "bad", "Запланировано": "info", "Исполняется": "warn", "Отменено": "muted" };
const execution = (p: Proposal) => EXECUTION[p.execution.status] ?? "—";

const COLS: Column<Proposal>[] = [
  { label: "Что", field: (r) => r.explanation || "Предложение изменения", filter: "text", className: "wrap" },
  { label: "Автор", field: (r) => r.initiator.full_name, filter: "enum" },
  { label: "Когда", field: "created_at", filter: "date", text: (r) => fmtDateTime(r.created_at) },
  { label: "Исполнитель", field: (r) => r.routing.assignee_name ?? "—", filter: "enum" },
  { label: "Решение", field: decision, filter: "enum", badge: true, render: (r) => <Badge kind={DECISION_KIND[decision(r)] ?? "info"}>{decision(r)}</Badge> },
  { label: "Исполнение", field: execution, filter: "enum", badge: true,
    render: (r) => (execution(r) === "—" ? "—" : <Badge kind={EXECUTION_KIND[execution(r)] ?? "info"}>{execution(r)}</Badge>) },
];

// Все строки коробки — страницами по 100, пока есть следующая (фильтры таблицы — по загруженным строкам, как в макете)
async function loadBox(box: ProposalBox) {
  const items: Proposal[] = [];
  let counts: Record<ProposalBox, number> | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await listProposals({ box, limit: PAGE, offset: i * PAGE });
    items.push(...page.items);
    counts = page.counts;
    if (!page.has_more) break;
  }
  return { items, counts: counts! };
}

export function ApprovalsPage() {
  const { me, role } = useAuth();
  // У студента — только «Мои»
  const views: [ProposalBox, string][] = role === "student" ? [["mine", "Мои"]] : [["incoming", "Входящие"], ["mine", "Мои"], ["completed", "История"]];
  const [box, setBox] = useState<ProposalBox>(views[0][0]);
  const q = useQuery({ queryKey: ["proposals", me?.user_id, "box", box], queryFn: () => loadBox(box), enabled: !!me });
  const rows = useMemo(() => q.data?.items ?? [], [q.data]);
  const [state, set] = useTableState(`appr-${box}`, COLS);
  const shown = useMemo(() => applyTable(state, COLS, rows), [state, rows]);
  const [open, setOpen] = useState<string | null>(null);
  const counts = q.data?.counts;

  return (
    <Page title="Согласование">
      <TableTools state={state} set={set} cols={COLS} rows={rows}>
        {views.length > 1 && <>
          <span className="spacer" />
          <Seg value={box} onChange={setBox} label="Очередь"
            options={views.map(([v, l]) => [v, counts ? `${l} ${counts[v]}` : l] as [ProposalBox, string])} />
        </>}
      </TableTools>
      <DataTable cols={COLS} rows={shown} base={rows} state={state} set={set} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)}
        loading={q.isLoading} error={q.error ? errorText(q.error) : null} onRetry={() => q.refetch()} />
      {open && <ProposalDialog id={open} onClose={() => setOpen(null)} />}
    </Page>
  );
}
