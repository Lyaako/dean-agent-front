import { useMemo } from "react";
import { Badge, Seg } from "../../components/ui";
import { DataTable } from "../../components/table/DataTable";
import { useTableState } from "../../components/table/useTableState";
import { applyTable, type Column } from "../../components/table/tableLogic";
import { useResource } from "../../api/resources";
import { errorText } from "../../api/errors";
import { useOlap, type MovesOrder, type MovesRow } from "../../api/olap";
import { fmtDate, plural, todayIso } from "../../lib/format";
import { Empty, Tiles } from "../student/parts";
import { CourseGroup, olap, s, useScope, type Setter } from "./parts";

/* ═════════ 5. Движение контингента: Roll-up по времени (месяц → семестр → год), Drill-down до приказов ═════════
   Бекенд отдаёт все виды приказов и все периоды — здесь пять видов движения и окно 12 месяцев, как в макете.
   Отступление от макета, пока бекенд не отдаёт список приказов окна (ТЗ docs/olap-backend-task.md, раздел 4):
   таблица приказов — только выбранного столбца, одним запросом (параллельные запросы к /olap сейчас дают 503) */

const MOVE_TYPES = ["expel", "leave", "leave_return", "reinstate", "transfer"] as const;
const MOVE_KIND: Record<string, string> = { expel: "bad", leave: "warn", leave_return: "info", reinstate: "ok", transfer: "muted" };
const MONTH_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
type Period = typeof olap.period;

// Последние 12 месяцев (ключи «ГГГГ-ММ»)
const months12 = () => {
  const t = todayIso(), now = Number(t.slice(0, 4)) * 12 + Number(t.slice(5, 7)) - 1;
  return Array.from({ length: 12 }, (_, i) => { const k = now - 11 + i; return `${Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, "0")}`; });
};
// Ключ периода бекенда для месяца: семестр «2025/26-1» (сентябрь–январь) или «-2» (февраль–август); год — календарный
const periodOf = (month: string, period: Period) => {
  const y = Number(month.slice(0, 4)), mo = Number(month.slice(5));
  if (period === "month") return month;
  if (period === "year") return String(y);
  const start = mo >= 9 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}-${mo >= 9 || mo === 1 ? 1 : 2}`;
};
const periodLabel = (p: string, period: Period) =>
  period === "month" ? `${MONTH_SHORT[Number(p.slice(5)) - 1]} ${p.slice(2, 4)}`
    : period === "semester" ? `${p.slice(0, -2)}, ${p.endsWith("-1") ? "осень" : "весна"}` : `${p} год`;

// Движение считается по студентам (как в макете); пока бекенд не отдаёт students_by_type — по приказам
const countOf = (r: MovesRow | undefined, t: string) => (r ? (r.students_by_type ?? r.by_type)[t] ?? 0 : 0);

interface MoveLine { key: string; order_date: string; order_number: string; order_type: string; code: string; student: string; group_name: string }

export function MovesView({ set }: { set: Setter }) {
  const { groups, group, scope } = useScope();
  const orderTypes = useResource("order_type");
  const typeName = useMemo(() => new Map((orderTypes.data ?? []).map((t) => [s(t.code), s(t.name)])), [orderTypes.data]);
  const window = months12();
  // По месяцам — для плиток «за 12 месяцев»; по выбранному периоду — для столбцов
  const byMonth = useOlap<MovesRow>("moves", { ...scope, period: "month" });
  // Запросы к /olap — по одному: параллельные сервер пока не выдерживает
  const byPeriod = useOlap<MovesRow>("moves", { ...scope, period: olap.period }, olap.period !== "month" && !!byMonth.data);
  const periodRows = olap.period === "month" ? byMonth.data?.rows : byPeriod.data?.rows;
  const periods = [...new Set(window.map((m) => periodOf(m, olap.period)))];
  const data = periods.map((p) => {
    const r = periodRows?.find((x) => x.period === p);
    return { p, by: Object.fromEntries(MOVE_TYPES.map((t) => [t, countOf(r, t)])) as Record<string, number> };
  });
  const sum = (by: Record<string, number>) => MOVE_TYPES.reduce((t, k) => t + by[k], 0);
  const max = Math.max(1, ...data.map((d) => sum(d.by)));
  const pick = olap.pick && periods.includes(olap.pick) ? olap.pick : null;

  // Приказы выбранного периода — один запрос
  const picked = useOlap<MovesOrder>("moves", { ...scope, period: olap.period, pick: pick ?? undefined }, !!pick && !!periodRows);
  const lines = useMemo<MoveLine[]>(() => (pick ? picked.data?.rows ?? [] : [])
    // Весь выбранный период, как в его столбце (у семестра и года на краю окна — и месяцы вне 12)
    .filter((o) => (MOVE_TYPES as readonly string[]).includes(o.order_type_code))
    .flatMap((o) => o.students.filter((st) => !group || st.group_id === Number(group.group_id)).map((st) => ({
      key: `${o.order_id}|${st.student_id}`, order_date: o.order_date, order_number: o.order_number, order_type: o.order_type,
      code: o.order_type_code, student: st.student, group_name: st.group_name,
    }))).sort((a, b) => b.order_date.localeCompare(a.order_date)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  [picked.data, pick, group?.group_id]);

  const cols = useMemo<Column<MoveLine>[]>(() => [
    { label: "Дата", field: "order_date", filter: "date", text: (r) => fmtDate(r.order_date) },
    { label: "Приказ", field: "order_number", filter: "text" },
    { label: "Вид", field: "order_type", filter: "enum", badge: true, render: (r) => <Badge kind={MOVE_KIND[r.code]}>{r.order_type}</Badge> },
    { label: "Студент", field: "student", filter: "text", bold: true, render: (r) => <b>{r.student}</b> },
    { label: "Группа", field: "group_name", filter: "enum" },
  ], []);
  const [state, setState] = useTableState("olap-moves", cols);
  const shown = useMemo(() => applyTable(state, cols, lines), [state, cols, lines]);

  const monthRows = (byMonth.data?.rows ?? []).filter((r) => window.includes(r.period));
  const n = (t: string) => monthRows.reduce((acc, r) => acc + countOf(r, t), 0);
  const error = groups.error || byMonth.error || byPeriod.error;
  const loading = byMonth.isLoading || (olap.period !== "month" && byPeriod.isLoading);
  const listError = pick ? picked.error : null;

  return (
    <>
      <div className="olap-filters">
        <CourseGroup set={set} groups={groups} />
        <label className="field"><span>Roll-up по времени</span>
          <Seg value={olap.period} onChange={(v) => set({ period: v, pick: null })} options={[["month", "Месяцы"], ["semester", "Семестры"], ["year", "Год"]]} /></label>
      </div>
      {error ? <Empty icon="alert" title="Не удалось загрузить">{errorText(error)}</Empty> : <>
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
        {pick ? (
          <DataTable cols={cols} rows={shown} base={lines} state={state} set={setState} rowKey={(r) => r.key}
            loading={picked.isLoading} error={listError ? errorText(listError) : null}
            title={`Drill-down: ${periodLabel(pick, olap.period)} · ${lines.length} ${plural(lines.length, "приказ", "приказа", "приказов")}`} />
        ) : <p className="olap-foot">Нажмите на столбец, чтобы увидеть приказы периода.</p>}
      </>}
    </>
  );
}
