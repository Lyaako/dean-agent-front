import { api } from "./client";

export const OLAP_MODES = [
  ["rollup-group", "Roll-up по группе"], ["rollup-discipline", "Roll-up по дисциплине"],
  ["rollup-semester", "Roll-up по семестру"], ["slice-group", "Срез по группе"],
  ["slice-discipline", "Срез по дисциплине"], ["dice", "Dice"],
  ["drilldown-group", "Drill-down по группе"], ["cross-group-semester", "Кросс-таблица Группа × Семестр"],
] as const;
export type OlapMode = typeof OLAP_MODES[number][0];
export interface OlapFilters { group_id?: number; discipline_id?: number; semester?: number; status_id?: number }
export interface Metrics { avg: string | null; results: number; excellent: number; debts: number }
export interface OlapRow extends Partial<Metrics> {
  name?: string; student_id?: number; student?: string; group_id?: number; group_name?: string;
  discipline_id?: number; discipline?: string; semester?: number; category?: string;
  control_type?: string; points?: number | null; mark?: number | null; result?: string;
  is_graded?: boolean; has_debt?: boolean; semesters?: Record<string, string | null>;
}
export interface ScoreBand { band_id: number; min_points: number; max_points: number; mark: number; mark_name: string }
export interface OlapReport {
  mode: OlapMode; filters: Record<keyof OlapFilters, number | null>; rows: OlapRow[];
  total: Metrics; semesters: number[]; scale: ScoreBand[];
}
export const fetchOlap = (mode: OlapMode, filters: OlapFilters = {}) =>
  api<OlapReport>("/olap", { query: { mode, ...filters } });
