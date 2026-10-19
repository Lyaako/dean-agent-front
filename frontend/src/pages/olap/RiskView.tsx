import { useMemo } from "react";
import { Badge } from "../../components/ui";
import { DataTable } from "../../components/table/DataTable";
import { useTableState } from "../../components/table/useTableState";
import { applyTable, type Column } from "../../components/table/tableLogic";
import { useOlap, type RiskPoint, type RiskRow, type RiskTotal } from "../../api/olap";
import { plural } from "../../lib/format";
import { Tiles } from "../student/parts";
import { CourseGroup, LoadError, olap, useScope, useStudentCard, type Setter } from "./parts";

/* ═════════ 3. Раннее предупреждение: Dice по курсу, модулю 1 и посещаемости ═════════
   Строка на студента: слабый модуль 1, низкая посещаемость, долги прошлых сессий; риск считает сервер */

// Порог: целое в пределах; вне пределов — ошибка под полем, а в расчёте остаётся значение по умолчанию
const numIn = (v: string, [min, max]: [number, number], def: number) => { const n = Number(v); return v !== "" && Number.isInteger(n) && n >= min && n <= max ? n : def; };
const comma = (v: number | null) => (v == null ? "—" : `${String(v).replace(".", ",")}%`);

function NumField({ label, value, suffix, range, onChange }: { label: string; value: string; suffix: string; range: [number, number]; onChange: (v: string) => void }) {
  const bad = Number.isNaN(numIn(value, range, NaN));
  return (
    <label className={`field${bad ? " form-field invalid" : ""}`}><span>{label}</span>
      <span className="num-in"><input className="text-input" type="number" min={range[0]} max={range[1]} step={1} value={value} onChange={(e) => onChange(e.target.value)} /><i>{suffix}</i></span>
      {bad && <small className="field-error" role="alert">Целое число от {range[0]} до {range[1]}</small>}
    </label>
  );
}

const COLS: Column<RiskRow>[] = [
  { label: "Студент", field: "student", filter: "text", bold: true, render: (r) => <b>{r.student}</b> },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Модуль 1 ниже порога", field: (r) => r.low_modules.length, filter: "num", className: "num",
    text: (r) => (r.low_modules.length ? `${r.low_modules.length} дисц.` : "—"),
    render: (r) => (r.low_modules.length
      ? <span title={r.low_modules.map((m) => `${m.discipline}: ${m.is_absent ? "неявка" : m.points ?? "не аттестован"}`).join(", ")}>
          {r.low_modules.length} {plural(r.low_modules.length, "дисциплина", "дисциплины", "дисциплин")}</span>
      : "—") },
  { label: "Посещаемость", field: "attendance_pct", filter: "num", className: "num", text: (r) => comma(r.attendance_pct),
    render: (r) => <span className={r.attendance_low ? "neg" : ""}>{comma(r.attendance_pct)}</span> },
  { label: "Долги прошлых сессий", field: "debts", filter: "num", className: "num", text: (r) => (r.debts ? String(r.debts) : "—") },
  { label: "Риск", field: (r) => (r.risk === "high" ? "Высокий" : "Средний"), filter: "enum", badge: true,
    render: (r) => <Badge kind={r.risk === "high" ? "bad" : "warn"}>{r.risk === "high" ? "Высокий" : "Средний"}</Badge> },
];

export function RiskView({ set }: { set: Setter }) {
  const { groups, scope } = useScope();
  const modMin = numIn(olap.modMin, [25, 54], 30), attMin = numIn(olap.attMin, [0, 100], 70);
  const report = useOlap<RiskRow, RiskTotal>("risk", { ...scope, mod_min: modMin, att_min: attMin });
  const rows = useMemo(() => report.data?.rows ?? [], [report.data]);
  const [state, setState] = useTableState("olap-risk", COLS);
  const shown = useMemo(() => applyTable(state, COLS, rows), [state, rows]);
  const t = report.data?.total;
  const card = useStudentCard();

  const filters = (
    <div className="olap-filters">
      <CourseGroup set={set} groups={groups} />
      <NumField label="Модуль 1 меньше" value={olap.modMin} suffix="баллов" range={[25, 54]} onChange={(v) => set({ modMin: v })} />
      <NumField label="Посещаемость ниже" value={olap.attMin} suffix="%" range={[0, 100]} onChange={(v) => set({ attMin: v })} />
    </div>
  );
  if (report.error) return <>{filters}<LoadError error={report.error} onRetry={() => void report.refetch()} /></>;
  if (report.isLoading) return <>{filters}<div className="skel" style={{ height: 200 }} /></>;
  if (!t) return null;

  return (
    <>
      {filters}
      <Tiles items={[
        ["В зоне риска", `${t.at_risk} из ${t.pool}`, `высокий риск — ${t.high}`, t.at_risk ? "bad" : "ok"],
        ["Слабый модуль 1", String(t.low_module), `меньше ${modMin} баллов или «не аттестован» хотя бы по одной дисциплине`],
        ["Низкая посещаемость", String(t.low_attendance), `ниже ${attMin}%`],
        ["С долгами прошлых сессий", String(t.with_debts)],
      ]} />
      <DataTable cols={COLS} rows={shown} base={rows} state={state} set={setState} rowKey={(r) => String(r.student_id)} onRowClick={card.open}
        title="Студенты, которым нужна помощь до сессии · Dice: обучающиеся × текущий семестр × пороги" />
      {!!report.data?.points?.length && <AttendChart pool={report.data.points} aMin={attMin} />}
      {card.node}
    </>
  );
}

/* ── Точечный график «посещаемость × средний балл» под таблицей «Раннего предупреждения» ── */
function AttendChart({ pool, aMin }: { pool: RiskPoint[]; aMin: number }) {
  // Шкалы по данным, а не по всей шкале оценок: точки занимают всё поле
  const atts = pool.map((p) => p.attendance_pct), pts = pool.map((p) => p.avg_points);
  const X0 = Math.max(0, Math.floor((Math.min(aMin, ...atts) - 4) / 10) * 10), X1 = 100;
  const Y0 = Math.floor((Math.min(...pts) - 1) / 5) * 5, Y1 = Math.ceil((Math.max(...pts) + 1) / 5) * 5;
  const W = 1000, H = 320, L = 34, R = 24, T = 16, B = 30;   // справа и сверху — запас под точки на краю (100 %)
  const x = (v: number) => L + (Math.max(X0, Math.min(X1, v)) - X0) / (X1 - X0) * (W - L - R);
  const y = (v: number) => T + (1 - (v - Y0) / (Y1 - Y0)) * (H - T - B);
  const range = (a: number, b: number, st: number) => Array.from({ length: Math.floor((b - a) / st) + 1 }, (_, i) => a + i * st);
  return (
    <section className="card">
      <div className="table-head"><h2>Посещаемость и средний балл</h2>
        <span className="chart-legend"><span><i className="dot ok" />без долгов</span><span><i className="dot debt" />есть долги</span><span>точка — студент</span></span></div>
      <div className="chart scatter">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Посещаемость и средний балл">
          <rect className="zone" x={L} y={T} width={x(aMin) - L} height={H - T - B} />
          {range(Y0, Y1, 5).map((v) => <g key={`y${v}`}><line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text x={L - 8} y={y(v) + 4} textAnchor="end">{v}</text></g>)}
          {range(X0, X1, 10).map((v) => <g key={`x${v}`}><line className="grid" x1={x(v)} x2={x(v)} y1={T} y2={H - B} /><text x={x(v)} y={H - 8} textAnchor="middle">{v}%</text></g>)}
          <line className="cut" x1={x(aMin)} x2={x(aMin)} y1={T} y2={H - B} /><text className="cut-l" x={x(aMin) - 8} y={T + 16} textAnchor="end">ниже {aMin}%</text>
          {pool.map((p, i) => (
            <circle key={p.student_id} className={p.debts ? "debt" : "ok"} style={{ ["--i" as string]: i % 40 }} cx={x(p.attendance_pct)} cy={y(p.avg_points)} r={7}>
              <title>{`${p.student} · ${p.group_name}: посещаемость ${p.attendance_pct}%, средний балл ${p.avg_points}${p.debts ? `, долгов ${p.debts}` : ""}`}</title>
            </circle>
          ))}
        </svg>
      </div>
    </section>
  );
}
