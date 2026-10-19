import { useMemo } from "react";
import { Badge, Seg } from "../../components/ui";
import { DataTable } from "../../components/table/DataTable";
import { useTableState } from "../../components/table/useTableState";
import { applyTable, type Column } from "../../components/table/tableLogic";
import { useResource } from "../../api/resources";
import { useOlap, type MovesRow } from "../../api/olap";
import { fmtDate, plural, todayIso } from "../../lib/format";
import { Tiles } from "../student/parts";
import { CourseGroup, LoadError, olap, s, useScope, type Setter } from "./parts";

/* ═════════ 5. Движение контингента: Roll-up по времени (месяц → семестр → год), Drill-down до приказов ═════════
   Один запрос на выбранную детализацию: пять видов движения, окно 12 месяцев (from/to) и list=true — столбцы (rows)
   и все пары «приказ × студент» окна (orders). Клик по столбцу фильтрует таблицу по orders[].period без новых запросов */

const MOVE_TYPES = ["expel", "leave", "leave_return", "reinstate", "transfer"] as const;
const MOVE_KIND: Record<string, string> = { expel: "bad", leave: "warn", leave_return: "info", reinstate: "ok", transfer: "muted" };
const MONTH_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
type Period = typeof olap.period;

// Последние 12 месяцев (ключи «ГГГГ-ММ»)
const months12 = () => {
  const t = todayIso(), now = Number(t.slice(0, 4)) * 12 + Number(t.slice(5, 7)) - 1;
  return Array.from({ length: 12 }, (_, i) => { const k = now - 11 + i; return `${Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, "0")}`; });
};
// Ключ периода бекенда для месяца: семестр «2025/26-1» (сентябрь–январь) или «-2» (февраль–август);
// год — учебный «2025/26» (сентябрь–август), как семестр без суффикса.
// Нужен, чтобы показать и пустые периоды окна: в rows бекенд отдаёт только периоды с приказами
const periodOf = (month: string, period: Period) => {
  const y = Number(month.slice(0, 4)), mo = Number(month.slice(5));
  if (period === "month") return month;
  const start = mo >= 9 ? y : y - 1, year = `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
  return period === "year" ? year : `${year}-${mo >= 9 || mo === 1 ? 1 : 2}`;
};
const periodLabel = (p: string, period: Period) =>
  period === "month" ? `${MONTH_SHORT[Number(p.slice(5)) - 1]} ${p.slice(2, 4)}`
    : period === "semester" ? `${p.slice(0, -2)}, ${p.endsWith("-1") ? "осень" : "весна"}` : `${p} уч. год`;

// Движение считается по студентам (пары «приказ × студент»), как в макете
const countOf = (r: MovesRow | undefined, t: string) => r?.students_by_type[t] ?? 0;

interface MoveLine { key: string; period: string; order_date: string; order_number: string; order_type: string; code: string; student: string; group_name: string; planned: boolean }

export function MovesView({ set }: { set: Setter }) {
  const { groups, scope } = useScope();
  const orderTypes = useResource("order_type");
  const typeName = useMemo(() => new Map((orderTypes.data ?? []).map((t) => [s(t.code), s(t.name)])), [orderTypes.data]);
  const window = months12();
  const report = useOlap<MovesRow>("moves", { ...scope, period: olap.period, types: MOVE_TYPES.join(","), from: window[0], to: window[11], list: true });
  const periodRows = report.data?.rows;
  const periods = [...new Set(window.map((m) => periodOf(m, olap.period)))];
  const data = periods.map((p) => {
    const r = periodRows?.find((x) => x.period === p);
    return { p, by: Object.fromEntries(MOVE_TYPES.map((t) => [t, countOf(r, t)])) as Record<string, number> };
  });
  const sum = (by: Record<string, number>) => MOVE_TYPES.reduce((t, k) => t + by[k], 0);
  const max = Math.max(1, ...data.map((d) => sum(d.by)));
  const pick = olap.pick && periods.includes(olap.pick) ? olap.pick : null;

  // Все приказы окна; выбранный столбец — те же строки с его period
  const all = useMemo<MoveLine[]>(() => (report.data?.orders ?? []).map((o) => ({
    key: `${o.order_id}|${o.student_id}`, period: o.period, order_date: o.order_date, order_number: o.order_number,
    order_type: o.order_type, code: o.order_type_code, student: o.student, group_name: o.group_name, planned: o.applied_at == null,
  })), [report.data]);
  const lines = useMemo(() => (pick ? all.filter((l) => l.period === pick) : all), [all, pick]);

  const cols = useMemo<Column<MoveLine>[]>(() => [
    { label: "Дата", field: "order_date", filter: "date", text: (r) => fmtDate(r.order_date) },
    { label: "Приказ", field: "order_number", filter: "text" },
    { label: "Вид", field: "order_type", filter: "enum", badge: true,
      render: (r) => <><Badge kind={MOVE_KIND[r.code]}>{r.order_type}</Badge>{r.planned && <small className="hint"> запланирован</small>}</> },
    { label: "Студент", field: "student", filter: "text", bold: true, render: (r) => <b>{r.student}</b> },
    { label: "Группа", field: "group_name", filter: "enum" },
  ], []);
  const [state, setState] = useTableState("olap-moves", cols);
  const shown = useMemo(() => applyTable(state, cols, lines), [state, cols, lines]);

  // Окно from/to уже применено сервером: сумма по столбцам — итог за 12 месяцев при любой детализации
  const n = (t: string) => (periodRows ?? []).reduce((acc, r) => acc + countOf(r, t), 0);
  const error = groups.error || report.error;
  const loading = report.isLoading;

  return (
    <>
      <div className="olap-filters">
        <CourseGroup set={set} groups={groups} />
        <label className="field"><span>Roll-up по времени</span>
          <Seg value={olap.period} onChange={(v) => set({ period: v, pick: null })} options={[["month", "Месяцы"], ["semester", "Семестры"], ["year", "Год"]]} /></label>
      </div>
      {error ? <LoadError error={error} onRetry={() => { void groups.refetch(); void report.refetch(); }} /> : <>
        <Tiles items={[
          ["Отчислено", loading ? "…" : String(n("expel")), "за 12 месяцев", n("expel") ? "bad" : ""],
          ["Ушли в академ", loading ? "…" : String(n("leave")), `вернулись — ${n("leave_return")}`],
          ["Восстановлено", loading ? "…" : String(n("reinstate")), "", "ok"],
          ["Переведено", loading ? "…" : String(n("transfer")), "в другую группу"],
        ]} />
        <section className="card">
          <div className="table-head">
            <h2>Приказы по студентам</h2>
            <span className="chart-legend">{MOVE_TYPES.map((t) => <span key={t}><i className={`mv-${t}`} />{typeName.get(t) ?? t}</span>)}</span>
          </div>
          {loading ? <div className="skel" style={{ height: 180 }} /> : (
            <div className="stack-chart" style={{ ["--n" as string]: periods.length }}>
              {data.map(({ p, by }, i) => {
                const total = sum(by);
                return (
                  <button key={p} type="button" className={`sc-col${pick === p ? " on" : ""}`} style={{ ["--i" as string]: i }}
                    title={`${periodLabel(p, olap.period)}: ${total}`} onClick={() => set({ pick: pick === p ? null : p })}>
                    <span className="sc-v">{total || ""}</span>
                    <span className="sc-bar" style={{ ["--h" as string]: `${total / max * 100}%` }}>
                      {MOVE_TYPES.map((t) => (by[t] ? <i key={t} className={`mv-${t}`} style={{ flex: by[t] }} /> : null))}
                    </span>
                    <span className="sc-l">{periodLabel(p, olap.period)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
        <DataTable cols={cols} rows={shown} base={lines} state={state} set={setState} rowKey={(r) => r.key} loading={loading}
          title={pick ? `Drill-down: ${periodLabel(pick, olap.period)} · ${lines.length} ${plural(lines.length, "приказ", "приказа", "приказов")}`
            : "Все приказы за 12 месяцев · нажмите на столбец, чтобы раскрыть период"} />
      </>}
    </>
  );
}
