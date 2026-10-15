import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Page } from "../components/Shell";
import { Badge, ErrorNote } from "../components/ui";
import { TableTools } from "../components/table/TableTools";
import { DataTable } from "../components/table/DataTable";
import { useTableState } from "../components/table/useTableState";
import { applyTable, type Column } from "../components/table/tableLogic";
import { fetchOlap, OLAP_MODES, type OlapFilters, type OlapMode, type OlapReport, type OlapRow } from "../api/olap";
import { useResource } from "../api/resources";
import { errorText } from "../api/errors";
import { chartPath, chartScale, olapRowKey } from "./olapLogic";

const METRICS: Column<OlapRow>[] = [
  { label: "Средний балл", field: "avg", filter: "num", className: "num" },
  { label: "Результатов", field: "results", filter: "num", className: "num" },
  { label: "На «отлично»", field: "excellent", filter: "num", className: "num" },
  { label: "Долгов", field: "debts", filter: "num", className: "num" },
];

function columns(mode: OlapMode, semesters: number[]): Column<OlapRow>[] {
  if (mode === "dice") return [
    { label: "Студент", field: "student", filter: "text" }, { label: "Группа", field: "group_name", filter: "enum" },
    { label: "Дисциплина", field: "discipline", filter: "enum" }, { label: "Семестр", field: "semester", filter: "enum", className: "num" },
    { label: "Контроль", field: "control_type", filter: "enum" }, { label: "Баллы", field: "points", filter: "num", className: "num" },
    { label: "Результат", field: "result", filter: "enum" },
    { label: "Долг", field: "has_debt", filter: "bool", render: (r) => r.has_debt ? <Badge kind="bad">долг</Badge> : "—" },
  ];
  if (mode === "drilldown-group") return [
    { label: "Студент", field: "student", filter: "text" }, METRICS[0], METRICS[3],
    { label: "Категория", field: "category", filter: "enum" },
  ];
  if (mode === "cross-group-semester") return [
    { label: "Группа", field: "name", filter: "text" },
    ...semesters.map((sem): Column<OlapRow> => ({ label: `${sem} сем.`, field: (r) => r.semesters?.[String(sem)], filter: "num", className: "num" })),
  ];
  return [{ label: mode === "rollup-semester" ? "Семестр" : mode === "rollup-discipline" || mode === "slice-group" ? "Дисциплина" : "Группа", field: "name", filter: "text" }, ...METRICS];
}

export function OlapPage() {
  const [mode, setMode] = useState<OlapMode>("rollup-group");
  const [filters, setFilters] = useState<OlapFilters>({});
  const groups = useResource("study_group"), disciplines = useResource("discipline"), statuses = useResource("student_status");
  const needsGroup = mode === "slice-group" || mode === "drilldown-group";
  const needsDiscipline = mode === "slice-discipline";
  const selected = { ...filters,
    ...(needsGroup && !filters.group_id && groups.data?.length ? { group_id: Number(groups.data[0].group_id) } : {}),
    ...(needsDiscipline && !filters.discipline_id && disciplines.data?.length ? { discipline_id: Number(disciplines.data[0].discipline_id) } : {}),
  };
  const ready = (!needsGroup || !!selected.group_id) && (!needsDiscipline || !!selected.discipline_id);
  const report = useQuery({ queryKey: ["olap", mode, selected], queryFn: () => fetchOlap(mode, selected), enabled: ready });
  const setFilter = (field: keyof OlapFilters, value: string) => setFilters((f) => ({ ...f, [field]: value ? Number(value) : undefined }));
  const choice = (label: string, field: keyof OlapFilters, options: [number, string][], required = false) => (
    <label className="field"><span>{label}</span><select className="select" value={selected[field] ?? ""} onChange={(e) => setFilter(field, e.target.value)}>
      {!required && <option value="">Все</option>}
      {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select></label>
  );
  const lookupError = groups.error || disciplines.error || statuses.error;
  return <Page title="OLAP-анализ">
    <section className="card ops">
      <div className="chips">{OLAP_MODES.map(([value, label]) => <button key={value} type="button" className="fchip" aria-pressed={mode === value}
        onClick={() => { setMode(value); setFilters({}); }}>{label}</button>)}</div>
      <div className="filters">
        {choice("Группа", "group_id", (groups.data ?? []).map((r) => [Number(r.group_id), String(r.name)]), needsGroup)}
        {choice("Дисциплина", "discipline_id", (disciplines.data ?? []).map((r) => [Number(r.discipline_id), String(r.name)]), needsDiscipline)}
        {choice("Семестр", "semester", [...new Set([...(report.data?.semesters ?? []), ...(selected.semester ? [selected.semester] : [])])].sort((a, b) => a - b).map((sem) => [sem, `${sem} семестр`]))}
        {choice("Статус студента", "status_id", (statuses.data ?? []).map((r) => [Number(r.status_id), String(r.name)]))}
        <button type="button" className="btn sm ghost" onClick={() => setFilters({})}>Сбросить</button>
      </div>
      {lookupError && <ErrorNote text={errorText(lookupError)} />}
      {!ready && !groups.isLoading && !disciplines.isLoading && <p className="hint">Нет доступных {needsGroup ? "групп" : "дисциплин"} для этого среза.</p>}
    </section>
    <OlapTable key={`${mode}|${JSON.stringify(selected)}`} mode={mode} report={report.data} loading={report.isFetching || groups.isLoading || disciplines.isLoading}
      error={report.error} retry={() => { report.refetch(); groups.refetch(); disciplines.refetch(); statuses.refetch(); }} />
  </Page>;
}

function OlapTable({ mode, report, loading, error, retry }: {
  mode: OlapMode; report?: OlapReport; loading: boolean; error: unknown; retry: () => void;
}) {
  const cols = useMemo(() => columns(mode, report?.semesters ?? []), [mode, report?.semesters]);
  const rows = useMemo(() => report?.rows ?? [], [report]);
  const [state, set] = useTableState(`olap-${mode}`, cols);
  const filtered = useMemo(() => applyTable(state, cols, rows), [state, cols, rows]);
  return <>
    <TableTools state={state} set={set} cols={cols} rows={rows} count={loading || error ? undefined : filtered.length} />
    {report && !loading && !error && <>
      <div className="table-meta"><span>Всего по выбранному срезу: средний балл <b>{report.total.avg ?? "—"}</b> · результатов {report.total.results} · на «отлично» {report.total.excellent} · долгов {report.total.debts}</span></div>
      {mode.startsWith("rollup-") && filtered.length > 0 && <OlapChart mode={mode} rows={filtered} report={report} />}
    </>}
    <DataTable cols={cols} rows={filtered} base={rows} state={state} set={set} rowKey={(r) => olapRowKey(mode, r)}
      title={mode === "cross-group-semester" ? "Средний балл: группа × семестр" : undefined}
      loading={loading} error={error ? errorText(error) : null} onRetry={retry} />
  </>;
}

function OlapChart({ mode, rows, report }: { mode: OlapMode; rows: OlapRow[]; report: OlapReport }) {
  const scale = chartScale(report.scale);
  if (!scale) return null;
  const label = mode === "rollup-group" ? "Средний балл по группам" : mode === "rollup-discipline" ? "Средний балл по дисциплинам" : "Средний балл по семестрам";
  const mean = report.total.avg;
  const sorted = [...rows].sort((a, b) => mode === "rollup-semester" ? a.semester! - b.semester! : Number(b.avg) - Number(a.avg));
  const x = (i: number) => sorted.length === 1 ? 485 : 94 + i * 792 / (sorted.length - 1);
  const y = (v: number) => 26 + 170 * (1 - scale.percent(v) / 100);
  return <section className="card chart-card">
    <div className="table-head"><h2>{label}</h2><span className="chart-legend">
      {report.scale.map((b) => <span key={b.band_id}><i className={`b${b.mark}`} />{b.mark_name}</span>)}
      {mean != null && <span><i className="mean" />среднее {mean}</span>}
    </span></div>
    {mode === "rollup-semester" ? <div className="chart line-chart"><svg viewBox="0 0 1000 230" role="img" aria-label={label}>
      {report.scale.map((b) => <g key={b.band_id}><rect className={`band b${b.mark}`} x={44} y={y(b.max_points)} width={932} height={y(b.min_points) - y(b.max_points)} />
        <text className="band-l" x={968} y={y(b.max_points) + 14} textAnchor="end">{b.mark_name}</text></g>)}
      {scale.ticks.map((v) => <text key={v} x={34} y={y(v) + 4} textAnchor="end">{v}</text>)}
      {mean != null && <line className="mean" x1={44} x2={976} y1={y(Number(mean))} y2={y(Number(mean))} />}
      <path className="line" d={chartPath(sorted, x, y)} />
      {sorted.map((r, i) => <g key={olapRowKey(mode, r)} className="pt">
        {r.avg != null && <><circle className={`m${scale.mark(Number(r.avg))}`} cx={x(i)} cy={y(Number(r.avg))} r={6}><title>{r.name}: {r.avg}</title></circle>
          <text className="pt-v" x={x(i)} y={y(Number(r.avg)) - 12} textAnchor="middle">{r.avg}</text></>}
        <text x={x(i)} y={220} textAnchor="middle">{r.name}{r.avg == null ? " · —" : ""}</text>
      </g>)}
    </svg></div> : <div className="dotplot" style={{ "--mean": mean == null ? "-10%" : `${scale.percent(Number(mean))}%` } as CSSProperties}>
      {sorted.map((r) => <div className="dp-row" key={olapRowKey(mode, r)}><span className="dp-l" title={r.name}>{r.name}</span>
        <div className="dp-track">{report.scale.map((b) => <i key={b.band_id} className={`b${b.mark}`} style={{ left: `${scale.percent(b.min_points)}%`, width: `${scale.percent(b.max_points) - scale.percent(b.min_points)}%` }} />)}
          {r.avg != null && <b className={`dp-dot m${scale.mark(Number(r.avg))}`} style={{ left: `${scale.percent(Number(r.avg))}%` }} title={`${r.name}: ${r.avg}`} />}
        </div><b className="dp-v">{r.avg ?? "—"}</b></div>)}
      <div className="dp-row dp-ticks"><span /><div className="dp-track">{scale.ticks.map((v) => <span key={v} style={{ left: `${scale.percent(v)}%` }}>{v}</span>)}</div><span /></div>
    </div>}
  </section>;
}
