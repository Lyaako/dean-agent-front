import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { emptyTable, labelOf, type Column, type TableState } from "./tableLogic";

// Состояние таблиц живёт между переключениями вкладок, как в макете
const store = new Map<string, TableState>();
export const clearTableState = () => store.clear();

export function useTableState<R>(id: string, cols: Column<R>[]) {
  const [state, setLocal] = useState<TableState>(() => store.get(id) ?? emptyTable());
  const set = useCallback((patch: Partial<TableState> | ((s: TableState) => Partial<TableState>)) => {
    setLocal((s) => {
      const next = { ...s, ...(typeof patch === "function" ? patch(s) : patch) };
      store.set(id, next);
      return next;
    });
  }, [id]);

  // Переход с другой вкладки (`?group_name=ИДБ-24-11`) — сбрасываем фильтры и ставим фильтр по колонке
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const f: TableState["f"] = {};
    let q = "", any = false;
    params.forEach((v, k) => {
      if (k === "q") { q = v; any = true; return; }
      const i = cols.findIndex((c) => c.field === k);
      if (i >= 0) { f[i] = [labelOf(v)]; any = true; }
    });
    if (!any) return;
    set({ q, f, sort: null, page: 1 });
    const rest = new URLSearchParams(params);
    for (const k of [...rest.keys()]) if (k === "q" || cols.some((c) => c.field === k)) rest.delete(k);
    setParams(rest, { replace: true });
  }, [params, cols, set, setParams]);

  return [state, set] as const;
}
