// Журнал изменений событиями: GET /api/v1/audit (решение Р6). Одно событие — одна запись audit_log
// со списком изменённых полей; страница и has_more считают события
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "./client";

export type AuditOperation = "I" | "U" | "D";
export type AuditSource = "ui" | "agent";

export interface AuditEvent {
  audit_id: string;                // большие идентификаторы — строкой
  changed_at: string;
  table_name: string;
  record_key: string;
  operation: AuditOperation;
  changed_by: string | null;       // логин
  changed_by_name: string | null;
  source: AuditSource;
  proposal_id: string | null;
  changes: { column: string; old: string | null; new: string | null }[];
}

export interface AuditFilters {
  changed_at__gte?: string;
  changed_at__lte?: string;
  table_name?: string;
  operation?: AuditOperation;
  changed_by?: string;
  source?: AuditSource;
}

export const OPERATION_NAME: Record<AuditOperation, string> = { I: "Добавление", U: "Изменение", D: "Удаление" };
export const SOURCE_NAME: Record<AuditSource, string> = { ui: "Интерфейс", agent: "Чат-агент" };

const PAGE = 100;

export const useAudit = (filters: AuditFilters) => useInfiniteQuery({
  queryKey: ["audit", filters],
  initialPageParam: 0,
  queryFn: ({ pageParam }) => api<{ items: AuditEvent[]; has_more: boolean }>("/audit", { query: { ...filters, limit: PAGE, offset: pageParam } }),
  getNextPageParam: (last, pages) => (last.has_more ? pages.length * PAGE : undefined),
});
