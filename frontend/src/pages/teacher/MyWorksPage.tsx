import { useMemo } from "react";
import { Page } from "../../components/Shell";
import { Badge } from "../../components/ui";
import { TableTools } from "../../components/table/TableTools";
import { DataTable } from "../../components/table/DataTable";
import { useTableState } from "../../components/table/useTableState";
import { applyTable, type Column } from "../../components/table/tableLogic";
import { useAuth } from "../../auth/AuthProvider";
import { useResource, type Row } from "../../api/resources";
import { errorText } from "../../api/errors";
import { Empty } from "../student/parts";

/* ═════════ КУРСОВЫЕ И ВКР (преподаватель) ═════════
   Работы, где он руководитель или рецензент. Только просмотр */

const s = (v: unknown) => (v == null ? "" : String(v));

export function MyWorksPage() {
  const { fullName } = useAuth();
  const works = useResource("v_academic_works");
  const all = useMemo(() => (works.data ?? []).filter((w) => fullName && (w.supervisor === fullName || w.reviewer === fullName)), [works.data, fullName]);
  const role = (r: Row) => (r.supervisor === fullName ? "Руководитель" : "Рецензент");
  const cols = useMemo<Column<Row>[]>(() => [
    { label: "Студент", field: "student", filter: "text", bold: true, render: (r) => <b>{s(r.student)}</b> },
    { label: "Группа", field: "group_name", filter: "enum" },
    { label: "Вид", field: "work_kind", filter: "enum" },
    { label: "Тема", field: "topic", filter: "text", className: "wrap" },
    { label: "Моя роль", field: role, filter: "enum", badge: true, render: (r) => <Badge kind={role(r) === "Руководитель" ? "info" : "muted"}>{role(r)}</Badge> },
    { label: "Приказ", field: "order_number", filter: "enum", text: (r) => s(r.order_number) || "—" },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [fullName]);
  const [state, set] = useTableState("myworks", cols);
  const shown = useMemo(() => applyTable(state, cols, all), [state, cols, all]);

  return (
    <Page title="Курсовые и ВКР">
      {!works.isLoading && !works.error && !all.length
        ? <Empty icon="cap" title="Нет работ">Вы не руководитель и не рецензент ни одной курсовой или ВКР</Empty>
        : <>
          <TableTools state={state} set={set} cols={cols} rows={all} count={works.isLoading || works.error ? undefined : shown.length} />
          <DataTable cols={cols} rows={shown} base={all} state={state} set={set} rowKey={(r) => s(r.work_id)}
            loading={works.isLoading} error={works.error ? errorText(works.error) : null} onRetry={() => works.refetch()} />
        </>}
    </Page>
  );
}
