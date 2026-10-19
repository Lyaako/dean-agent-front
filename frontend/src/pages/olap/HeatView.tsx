import { useMemo } from "react";
import { useOlap, type HeatRow } from "../../api/olap";
import type { Row } from "../../api/resources";
import { Empty, Tiles } from "../student/parts";
import { LoadError, olap, Select, useGroupOptions, type Setter } from "./parts";

/* ═════════ 2. Проблемные дисциплины: Pivot дисциплина × группа + Slice по семестру ═════════ */

const heatClass = (v: number | null) => (v == null ? "" : v === 0 ? "h0" : v < 8 ? "h1" : v < 15 ? "h2" : v < 25 ? "h3" : "h4");
// Доля не сданных с первого раза по набору ячеек
const pctOf = (rows: HeatRow[]) => {
  const results = rows.reduce((t, r) => t + r.results, 0);
  return results ? Math.round((results - rows.reduce((t, r) => t + r.first_pass, 0)) / results * 100) : null;
};
// Прошедшие семестры: у группы с текущим семестром N сданы 1…N−1
const done = (g: Row) => Math.max(0, Number(g.current_semester ?? 1) - 1);

export function HeatView({ set }: { set: Setter }) {
  const groups = useGroupOptions();
  const sems = useMemo(() => Array.from({ length: Math.max(0, ...groups.list.map(done)) }, (_, i) => i + 1), [groups.list]);
  // По умолчанию — самый поздний семестр из тех, что прошли больше всего групп: сравнение полнее
  const nGroups = (sem: number) => groups.list.filter((g) => done(g) >= sem).length;
  const sem = Number(olap.sem) || sems.reduce((best, x) => (nGroups(x) >= nGroups(best) ? x : best), sems[0] ?? 0);
  const report = useOlap<HeatRow>("heat", { semester: sem }, sem > 0);
  const rows = report.data?.rows ?? [];

  if (groups.isLoading || (sem > 0 && report.isLoading)) return <div className="skel" style={{ height: 200 }} />;
  const error = groups.error || report.error;
  if (error) return <LoadError error={error} onRetry={() => { void groups.refetch(); void report.refetch(); }} />;
  // У преподавателя без групп с прошедшими сессиями сравнивать нечего
  if (!sems.length) return <Empty icon="chart" title="Нет данных">У ваших групп ещё не было сессий</Empty>;

  const filters = <div className="olap-filters"><Select label="Slice: семестр" value={String(sem)} onChange={(v) => set({ sem: v })} options={sems.map((x) => [String(x), `${x} семестр`])} /></div>;
  if (!rows.length) return <>{filters}<Empty icon="chart" title="Нет данных">В этом семестре результатов нет</Empty></>;

  const groupNames = [...new Set(rows.map((r) => r.group_name))].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
  const byDisc = [...new Set(rows.map((r) => r.discipline))].map((d) => ({ d, v: pctOf(rows.filter((r) => r.discipline === d)) })).sort((a, b) => (b.v ?? 0) - (a.v ?? 0));
  const byGroup = new Map(groupNames.map((g) => [g, pctOf(rows.filter((r) => r.group_name === g))]));
  const worst = [...byGroup].sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
  const cell = (d: string, g: string) => { const x = rows.filter((r) => r.discipline === d && r.group_name === g); return x.length ? pctOf(x) : null; };
  const td = (key: string, v: number | null, extra = "") => <td key={key} className={`${extra}${heatClass(v)}`}>{v == null ? "—" : `${v}%`}</td>;
  const top = byDisc[0], all = pctOf(rows);

  return (
    <>
      {filters}
      <Tiles items={[
        ["Сложнее всего", top.d, `не сдали с первого раза ${top.v}%`, (top.v ?? 0) >= 15 ? "bad" : ""],
        ["Группа с худшим результатом", worst[0], `не сдали с первого раза ${worst[1]}%`],
        ["В среднем по семестру", `${all ?? "—"}%`, "результатов не сданы с первого раза"],
      ]} />
      <section className="card">
        <div className="table-head">
          <h2>Доля несданных с первой попытки · {sem} семестр</h2>
          <span className="chart-legend">
            {([["h0", "0%"], ["h1", "до 8%"], ["h2", "8–15%"], ["h3", "15–25%"], ["h4", "больше 25%"]] as const).map(([c, l]) => <span key={c}><i className={c} />{l}</span>)}
          </span>
        </div>
        <div className="heat-wrap">
          <table className="heat">
            <thead><tr><th>Дисциплина</th>{groupNames.map((g) => <th key={g}>{g}</th>)}<th className="tot">Всего</th></tr></thead>
            <tbody>
              {byDisc.map(({ d, v }, i) => (
                <tr key={d} style={{ ["--i" as string]: i }}><th>{d}</th>{groupNames.map((g) => td(g, cell(d, g)))}{td("tot", v, "tot ")}</tr>
              ))}
              <tr className="tot"><th>Всего по группе</th>{groupNames.map((g) => td(g, byGroup.get(g) ?? null))}{td("tot", all)}</tr>
            </tbody>
          </table>
        </div>
        <p className="olap-foot">Красная строка — проблема в дисциплине (у всех групп). Красный столбец — проблема в группе (по всем дисциплинам).</p>
      </section>
    </>
  );
}
