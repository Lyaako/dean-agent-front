import type { OlapMode, OlapRow, ScoreBand } from "../api/olap";

export function olapRowKey(mode: OlapMode, row: OlapRow): string {
  if (mode === "dice") return `${row.student_id}|${row.discipline_id}|${row.semester}`;
  if (mode === "drilldown-group") return String(row.student_id);
  if (mode === "rollup-semester") return String(row.semester);
  if (mode === "rollup-discipline" || mode === "slice-group") return String(row.discipline_id);
  return String(row.group_id);
}

export function chartScale(scale: ScoreBand[]) {
  if (!scale.length) return null;
  const min = Math.min(...scale.map((b) => b.min_points));
  const max = Math.max(...scale.map((b) => b.max_points));
  return {
    ticks: [...new Set(scale.flatMap((b) => [b.min_points, b.max_points]))].sort((a, b) => a - b),
    percent: (value: number) => max === min ? 50 : Math.max(0, Math.min(100, (value - min) / (max - min) * 100)),
    mark: (value: number) => [...scale].sort((a, b) => b.min_points - a.min_points).find((b) => value >= b.min_points)?.mark,
  };
}

// Отсутствующий балл разрывает линию, а не превращается в нижнюю границу шкалы.
export function chartPath(rows: OlapRow[], x: (index: number) => number, y: (value: number) => number) {
  let connected = false;
  return rows.map((r, i) => {
    if (r.avg == null) { connected = false; return ""; }
    const command = connected ? "L" : "M";
    connected = true;
    return `${command}${x(i)},${y(Number(r.avg))}`;
  }).join(" ");
}
