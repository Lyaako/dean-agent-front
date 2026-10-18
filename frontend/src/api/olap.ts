// OLAP: GET /api/v1/olap?mode=… Ответ {mode, level, rows, total, filters}.
// Срезы — как в макете (mockup/redesign/olap.js). Форматы — docs/API.md бекенда, раздел «Пять новых режимов OLAP»
import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export type OlapOp = "session" | "heat" | "risk" | "retake" | "moves";

export interface OlapParams {
  course?: number; group_id?: number; discipline_id?: number; semester?: number;
  level?: string; mod_min?: number; att_min?: number; period?: "month" | "semester" | "year"; pick?: string;
  /** moves: коды видов приказов через запятую, окно по дате приказа «ГГГГ-ММ» (включительно), list — все пары «приказ × студент» окна */
  types?: string; from?: string; to?: string; list?: boolean;
}

export interface OlapReport<R, T = Record<string, unknown>> {
  mode: OlapOp; level: string | null; rows: R[]; total: T; filters: Record<string, unknown>;
  points?: RiskPoint[];
  /** moves с list=true — все пары «приказ × студент» окна */
  orders?: MovesOrder[];
}

/* ── session: «Итоги сессии» (уровни course → group → discipline → result) ── */
export interface SessionStats { students: number; abs_pct: number | null; qual_pct: number | null; debts: number; excellent: number }
export interface SessionRow extends SessionStats { course?: number; group_id?: number; discipline_id?: number; name: string }
export type Attempt = "main" | "retake" | "commission" | "individual";
export interface SessionResult {
  student_id: number; student: string; control_type: string; is_graded: boolean; points: number | null; is_absent: boolean;
  mark: number | null; result: string; attempt: Attempt | null;
}

/* ── heat: «Проблемные дисциплины», дисциплина × группа ── */
export interface HeatRow { discipline_id: number; discipline: string; group_id: number; group_name: string; results: number; first_pass: number; not_first_pass_pct: number }

/* ── risk: «Раннее предупреждение», строка на студента ── */
export interface RiskRow {
  student_id: number; student: string; group_id: number; group_name: string; course: number;
  low_modules: { discipline_id: number; discipline: string; points: number | null; is_absent: boolean }[];
  attendance_pct: number | null; attendance_count: number; attendance_low: boolean; debts: number; score: number; risk: "high" | "medium";
}
export interface RiskTotal { pool: number; at_risk: number; high: number; low_module: number; low_attendance: number; with_debts: number }
export interface RiskPoint { student_id: number; student: string; group_name: string; attendance_pct: number; avg_points: number; debts: number }

/* ── retake: «Пересдачи», воронка по долгам ── */
export interface RetakeRow {
  course?: number; group_id?: number; name: string;
  failed: number; closed_retake: number; closed_commission: number; open: number; closed_pct: number | null;
}
export type RetakeTotal = Omit<RetakeRow, "name" | "course" | "group_id"> & { expulsion_candidates: number };

/* ── moves: «Движение контингента» ── */
// by_type — число приказов по виду; students_by_type — пар «приказ × студент»
export interface MovesRow { period: string; orders: number; students: number; by_type: Record<string, number>; students_by_type: Record<string, number> }
// Пара «приказ × студент»; period — по тому же правилу, что rows[].period; applied_at = null — приказ запланирован
export interface MovesOrder {
  order_id: number; order_number: string; order_date: string; effective_date: string; order_type: string; order_type_code: string;
  applied_at: string | null; student_id: number; student: string; group_id: number; group_name: string; course: number; period: string;
}

export const fetchOlap = <R, T = Record<string, unknown>>(mode: OlapOp, params: OlapParams = {}) =>
  api<OlapReport<R, T>>("/olap", { query: { mode, ...params } });

export const useOlap = <R, T = Record<string, unknown>>(mode: OlapOp, params: OlapParams, enabled = true) =>
  useQuery({ queryKey: ["olap", mode, params], queryFn: () => fetchOlap<R, T>(mode, params), enabled });
