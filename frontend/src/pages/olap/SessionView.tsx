import { useMemo } from "react";
import { Badge } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { DataTable } from "../../components/table/DataTable";
import { useTableState } from "../../components/table/useTableState";
import { applyTable, type Column } from "../../components/table/tableLogic";
import { errorText } from "../../api/errors";
import { useOlap, type Attempt, type OlapParams, type SessionResult, type SessionRow, type SessionStats } from "../../api/olap";
import { Empty, Tiles } from "../student/parts";
import { olap, Pct, Pending, type Setter } from "./parts";

/* ═════════ 1. Итоги сессии: Roll-up студент → группа → курс, Drill-down обратно ═════════
   Курс → группы → дисциплины → результаты студентов. Считает сервер (последняя сессия каждой группы) */

const ATTEMPT: Record<Attempt, string> = { main: "В сессию", retake: "На пересдаче", commission: "Комиссии", individual: "Индивидуально" };
const num = (v: number) => (v ? String(v) : "—");

const statCols = (first: string): Column<SessionRow>[] => [
  { label: first, field: "name", filter: "text", bold: true, render: (r) => <b>{r.name}</b> },
  { label: "Студентов", field: "students", filter: "num", className: "num", text: (r) => num(r.students) },
  { label: "Абсолютная успеваемость", field: "abs_pct", filter: "num", className: "num", text: (r) => (r.abs_pct == null ? "—" : `${r.abs_pct}%`), render: (r) => <Pct v={r.abs_pct} /> },
  { label: "Качественная успеваемость", field: "qual_pct", filter: "num", className: "num", text: (r) => (r.qual_pct == null ? "—" : `${r.qual_pct}%`), render: (r) => <Pct v={r.qual_pct} /> },
  { label: "Долгов после сессии", field: "debts", filter: "num", className: "num", text: (r) => num(r.debts) },
  { label: "Отличников", field: "excellent", filter: "num", className: "num", text: (r) => num(r.excellent) },
];
const resultKind = (r: SessionResult) => (r.points == null ? "bad" : !r.is_graded ? "ok" : r.mark === 5 ? "ok" : r.mark === 3 ? "warn" : "info");
const RESULT_COLS: Column<SessionResult>[] = [
  { label: "Студент", field: "student", filter: "text", bold: true, render: (r) => <b>{r.student}</b> },
  { label: "Контроль", field: "control_type", filter: "enum" },
  { label: "Баллы", field: "points", filter: "num", className: "num", text: (r) => (r.points == null ? "—" : String(r.points)) },
  { label: "Результат", field: "result", filter: "enum", badge: true, render: (r) => <Badge kind={resultKind(r)}>{r.result}</Badge> },
  { label: "Сдано", field: (r) => (r.attempt ? ATTEMPT[r.attempt] : "Не сдано"), filter: "enum" },
];

export function SessionView({ set }: { set: Setter }) {
  const [c, g, d] = olap.path;
  const level = !c ? "course" : !g ? "group" : !d ? "discipline" : "result";
  const params: OlapParams = { level, course: c?.course, group_id: g?.group_id, discipline_id: d?.discipline_id };
  const report = useOlap<SessionRow | SessionResult, SessionStats>("session", params);
  // Ответ в прежнем формате (без абсолютной успеваемости) — срез ждёт обновления бекенда
  const fresh = !!report.data && "abs_pct" in (report.data.total ?? {});
  const total = report.data?.total;

  const isResult = level === "result";
  const cols = useMemo(() => (isResult ? RESULT_COLS : statCols({ course: "Курс", group: "Группа", discipline: "Дисциплина" }[level as "course"])), [isResult, level]) as Column<SessionRow | SessionResult>[];
  const id = `olap-s-${olap.path.length}`;
  const [state, setState] = useTableState(id, cols);
  const rows = report.data?.rows ?? [];
  const shown = useMemo(() => applyTable(state, cols, rows), [state, cols, rows]);

  if (report.isLoading) return <div className="skel" style={{ height: 200 }} />;
  if (report.error) return <Empty icon="alert" title="Не удалось загрузить">{errorText(report.error)}</Empty>;
  if (!fresh) return <Pending>Свёртка студентов в группы и курсы: абсолютная и качественная успеваемость, долги после сессии и отличники.</Pending>;

  const crumbs = [{ label: "Все курсы" }, ...olap.path];
  const title = level === "course" ? "Roll-up до курсов · нажмите на курс, чтобы раскрыть группы"
    : level === "group" ? `Drill-down: группы ${c.label} · нажмите на группу, чтобы раскрыть дисциплины`
    : level === "discipline" ? `Drill-down: дисциплины группы ${g.label} · нажмите на дисциплину, чтобы увидеть студентов`
    : `Студенты группы ${g.label} · ${d.label}`;
  const onRow = isResult ? undefined : (r: SessionRow | SessionResult) => {
    const x = r as SessionRow;
    const step = level === "course" ? { course: x.course, label: x.name } : level === "group" ? { group_id: x.group_id, label: x.name } : { discipline_id: x.discipline_id, label: x.name };
    set({ path: [...olap.path, step] });
  };

  return (
    <>
      {total && <Tiles items={[
        ["Студентов в сессии", String(total.students)],
        ["Абсолютная успеваемость", `${total.abs_pct ?? "—"}%`, "сдали всё в сессию, без пересдач", total.abs_pct == null ? "" : total.abs_pct >= 85 ? "ok" : total.abs_pct >= 65 ? "" : "bad"],
        ["Качественная успеваемость", `${total.qual_pct ?? "—"}%`, "только «хорошо» и «отлично»"],
        ["Долгов после сессии", String(total.debts), `отличников — ${total.excellent}`, total.debts ? "bad" : "ok"],
      ]} />}
      {/* Крошки появляются только после drill-down: на верхнем уровне показывать нечего */}
      {crumbs.length > 1 && (
        <nav className="olap-crumbs" aria-label="Уровень">
          {crumbs.map((x, i) => (i === crumbs.length - 1 ? <b key={i}>{x.label}</b>
            : <span key={i}><button type="button" className="link" onClick={() => set({ path: olap.path.slice(0, i) })}>{x.label}</button><Icon name="right" /></span>))}
        </nav>
      )}
      <DataTable cols={cols} rows={shown} base={rows} state={state} set={setState} title={title} onRowClick={onRow}
        rowKey={(r) => String(isResult ? (r as SessionResult).student_id : (r as SessionRow).course ?? (r as SessionRow).group_id ?? (r as SessionRow).discipline_id ?? (r as SessionRow).name)} />
    </>
  );
}
