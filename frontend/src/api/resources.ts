import { useQuery } from "@tanstack/react-query";
import { api, newKey } from "./client";

export type Row = Record<string, unknown>;
export type Params = Record<string, string | number | boolean | null | undefined>;

interface Page { items: Row[]; limit: number; offset: number; has_more: boolean }

const PAGE = 500;          // максимум, который отдаёт бэкенд за раз
const MAX_PAGES = 40;      // предохранитель: не больше 20 000 строк в одну таблицу

// Списки отдаются страницами без общего количества — забираем всё, пока has_more
export async function fetchAll(name: string, params: Params = {}): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await api<Page>(`/resources/${name}`, { query: { ...params, limit: PAGE, offset: i * PAGE } });
    out.push(...page.items);
    if (!page.has_more) break;
  }
  return out;
}

export function useResource(name: string | null, params: Params = {}, enabled = true) {
  return useQuery({
    queryKey: ["res", name, params],
    queryFn: () => fetchAll(name!, params),
    enabled: !!name && enabled,
  });
}

export type Key = Record<string, unknown>;

const keyQuery = (key: Key): Params => Object.fromEntries(Object.entries(key).map(([k, v]) => [k, v as string]));

export async function getRow(table: string, key: Key): Promise<Row | null> {
  const page = await api<Page>(`/resources/${table}`, { query: { ...keyQuery(key), limit: 1 } });
  return page.items[0] ?? null;
}

export const createRow = (table: string, data: Row) => api<Row>(`/resources/${table}`, { method: "POST", json: data });

export const updateRow = (table: string, key: Key, data: Row) =>
  api<Row>(`/resources/${table}`, { method: "PATCH", query: keyQuery(key), json: data });

export const deleteRow = (table: string, key: Key) =>
  api<Row>(`/resources/${table}`, { method: "DELETE", query: keyQuery(key) });

// Предметные команды (приказы и т. п.) — всегда с ключом идемпотентности
export const runWorkflow = <T = Row>(name: string, body: Row, idempotencyKey = newKey()) =>
  api<T>(`/workflows/${name}`, { method: "POST", json: body, headers: { "Idempotency-Key": idempotencyKey } });
