import { useMemo } from "react";
import { Seg } from "../../components/ui";
import { DataTable } from "../../components/table/DataTable";
import { useTableState } from "../../components/table/useTableState";
import { applyTable, type Column } from "../../components/table/tableLogic";
import { errorText } from "../../api/errors";
import { useOlap, type RetakeRow, type RetakeTotal } from "../../api/olap";
import { Empty, Tiles } from "../student/parts";
import { CourseGroup, olap, Pct, Pending, useScope, type Setter } from "./parts";

/* ═════════ 4. Пересдачи: Roll-up по попытке сдачи ═════════
   Воронка по долгам сессии: не сдали в сессию → закрыли на пересдаче → комиссией → не закрыто */

const num = (v: number) => (v ? String(v) : "—");
const cols = (byCourse: boolean): Column<RetakeRow>[] => [
  { label: byCourse ? "Курс" : "Группа", field: "name", filter: "text", bold: true, render: (r) => <b>{r.name}</b> },
  { label: "Не сдали в сессию", field: "failed", filter: "num", className: "num", text: (r) => num(r.failed) },
  { label: "Закрыто на пересдаче", field: "closed_retake", filter: "num", className: "num", text: (r) => num(r.closed_retake) },
  { label: "Закрыто комиссией", field: "closed_commission", filter: "num", className: "num", text: (r) => num(r.closed_commission) },
  { label: "Не закрыто", field: "open", filter: "num", className: "num", text: (r) => num(r.open) },
  { label: "Закрыто долгов", field: "closed_pct", filter: "num", className: "num", text: (r) => (r.closed_pct == null ? "—" : `${r.closed_pct}%`), render: (r) => <Pct v={r.closed_pct} /> },
];

export function RetakeView({ set }: { set: Setter }) {
  const { groups, scope } = useScope();
  const report = useOlap<RetakeRow, RetakeTotal>("retake", { ...scope, level: olap.level });
  const fresh = !!report.data && "failed" in (report.data.total ?? {});
  const rows = fresh ? report.data!.rows : [];
  const c = useMemo(() => cols(olap.level === "course"), [olap.level]); // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useTableState(`olap-retake-${olap.level}`, c);
  const shown = useMemo(() => applyTable(state, c, rows), [state, c, rows]);
  const t = report.data?.total;

  const filters = (
    <div className="olap-filters">
      <CourseGroup set={set} groups={groups} />
      <label className="field"><span>Roll-up до</span>
        <Seg value={olap.level} onChange={(v) => set({ level: v })} options={[["group", "Групп"], ["course", "Курсов"]]} /></label>
    </div>
  );
  if (report.error) return <>{filters}<Empty icon="alert" title="Не удалось загрузить">{errorText(report.error)}</Empty></>;
  if (report.isLoading) return <>{filters}<div className="skel" style={{ height: 200 }} /></>;
  if (!fresh || !t) return <Pending>Судьба долгов: сколько закрыто на пересдаче и комиссией, сколько ещё открыто и кто кандидат на отчисление.</Pending>;

  const closed = t.closed_retake + t.closed_commission;
  const steps: [string, number, string][] = [
    ["Не сдали в сессию", t.failed, "all"], ["Закрыли на пересдаче", t.closed_retake, "ok"], ["Закрыли комиссии", t.closed_commission, "ok2"], ["Не закрыто", t.open, "bad"],
  ];
  return (
    <>
      {filters}
      <Tiles items={[
        ["Закрыто долгов", `${t.closed_pct ?? "—"}%`, `${closed} из ${t.failed}`, (t.closed_pct ?? 0) >= 70 ? "ok" : "bad"],
        ["Ещё не закрыто", String(t.open), "долгов у обучающихся", t.open ? "bad" : "ok"],
        ["Кандидатов на отчисление", String(t.expulsion_candidates), "три долга или не сдана комиссия", t.expulsion_candidates ? "bad" : "ok"],
      ]} />
      <section className="card">
        <div className="table-head"><h2>Судьба долгов: от сессии до комиссии</h2></div>
        <div className="funnel">
          {steps.map(([l, v, cls], i) => (
            <div key={l} className="fn-row" style={{ ["--i" as string]: i }}><span>{l}</span>
              <div className="fn-track"><i className={cls} style={{ ["--w" as string]: `${t.failed ? v / t.failed * 100 : 0}%` }} /></div><b>{v}</b></div>
          ))}
        </div>
      </section>
      <DataTable cols={c} rows={shown} base={rows} state={state} set={setState} rowKey={(r) => r.name}
        title={`Roll-up по ${olap.level === "course" ? "курсам" : "группам"}`} />
    </>
  );
}
