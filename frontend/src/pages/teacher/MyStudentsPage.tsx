import { useMemo } from "react";
import { Page } from "../../components/Shell";
import { TableTools } from "../../components/table/TableTools";
import { DataTable } from "../../components/table/DataTable";
import { useTableState } from "../../components/table/useTableState";
import { applyTable, type Column } from "../../components/table/tableLogic";
import { useAuth } from "../../auth/AuthProvider";
import { useResource, type Row } from "../../api/resources";
import { errorText } from "../../api/errors";

/* ═════════ МОИ СТУДЕНТЫ (преподаватель) ═════════
   Обучающиеся студенты групп, где он сейчас ведёт занятия (teaching_assignment), и его дисциплины в каждой группе */

const s = (v: unknown) => (v == null ? "" : String(v));
const comma = (v: unknown) => (v == null || v === "" ? "—" : String(v).replace(".", ","));

export function MyStudentsPage() {
  const { me, fullName } = useAuth();
  const assignments = useResource("teaching_assignment", { teacher_id: me?.teacher_id ?? undefined }, me?.teacher_id != null);
  const groups = useResource("v_groups");
  const curriculum = useResource("v_curriculum");
  const students = useResource("v_student_summary");

  // Группа → мои дисциплины в ней
  const mine = useMemo(() => {
    const gname = new Map((groups.data ?? []).map((g) => [Number(g.group_id), s(g.group_name)]));
    const disc = new Map((curriculum.data ?? []).map((c) => [Number(c.item_id), s(c.discipline)]));
    const m = new Map<string, Set<string>>();
    for (const a of assignments.data ?? []) {
      const g = gname.get(Number(a.group_id));
      if (!g) continue;
      if (!m.has(g)) m.set(g, new Set());
      const d = disc.get(Number(a.item_id));
      if (d) m.get(g)!.add(d);
    }
    return m;
  }, [assignments.data, groups.data, curriculum.data]);
  const gs = [...mine.keys()].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
  const all = useMemo(() => (students.data ?? []).filter((r) => mine.has(s(r.group_name)) && r.status === "Обучается"), [students.data, mine]);
  const cur = (groups.data ?? []).find((g) => fullName && g.curator === fullName);

  const cols = useMemo<Column<Row>[]>(() => [
    { label: "ФИО", field: "student", filter: "text", bold: true, render: (r) => <b>{s(r.student)}</b> },
    { label: "Группа", field: "group_name", filter: "enum" },
    { label: "Курс", field: "course", filter: "enum", className: "num" },
    { label: "Мои дисциплины", field: (r) => [...(mine.get(s(r.group_name)) ?? [])].sort().join(", "), filter: "text", className: "wrap-sm" },
    { label: "Посещ., %", field: "attendance_pct", filter: "num", className: "num", text: (r) => comma(r.attendance_pct) },
    { label: "Ср. балл", field: "avg_points", filter: "num", className: "num", text: (r) => comma(r.avg_points) },
    { label: "Долги", field: "debts", filter: "num", className: "num", text: (r) => (r.debts ? s(r.debts) : "—") },
  ], [mine]);
  const [state, set] = useTableState("mystudents", cols);
  const shown = useMemo(() => applyTable(state, cols, all), [state, cols, all]);
  const loading = assignments.isLoading || groups.isLoading || curriculum.isLoading || students.isLoading;
  const error = assignments.error || groups.error || curriculum.error || students.error;
  const withDebts = all.filter((r) => Number(r.debts) > 0).length;

  return (
    <Page title="Мои студенты">
      {/* Коротко одной строкой, как в макете */}
      <p className="stat-line">
        <span>{gs.length === 1 ? "Группа" : "Группы"} <b>{gs.join(", ") || "—"}</b></span>
        <span>Студентов <b>{all.length}</b></span>
        <span>С долгами <b className={withDebts ? "neg" : ""}>{withDebts}</b></span>
        {cur && <span>Вы куратор <b>{s(cur.group_name)}</b></span>}
      </p>
      <TableTools state={state} set={set} cols={cols} rows={all} count={loading || error ? undefined : shown.length} />
      <DataTable cols={cols} rows={shown} base={all} state={state} set={set} rowKey={(r) => s(r.student_id)}
        loading={loading} error={error ? errorText(error) : null} onRetry={() => students.refetch()} />
    </Page>
  );
}
