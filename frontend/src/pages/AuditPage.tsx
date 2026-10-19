import { useCallback, useMemo, useState } from "react";
import { Page } from "../components/Shell";
import { Badge } from "../components/ui";
import { Icon } from "../components/Icon";
import { DataTable } from "../components/table/DataTable";
import { useTableState } from "../components/table/useTableState";
import { applyTable, type Column } from "../components/table/tableLogic";
import { fieldLabel, useSchema } from "../api/schema";
import { errorText } from "../api/errors";
import { fmtDateTime } from "../lib/format";
import { OPERATION_NAME, SOURCE_NAME, useAudit, type AuditEvent, type AuditFilters, type AuditOperation, type AuditSource } from "../api/audit";
import { TABLE_NAME } from "../chat/proposals/useProposal";
import { ProposalDialog } from "../chat/proposals/ProposalDialog";

/* ═════════ ЖУРНАЛ ИЗМЕНЕНИЙ ═════════
   Админ видит весь журнал, директор и деканат — свой институт; преподавателю и студенту вкладки нет.
   Строка — одно событие: когда, кто, таблица, действие, запись, источник и «поле: было → стало».
   Фильтры уходят в запрос (журнал отдаётся порциями), следующая порция догружается на последней странице таблицы */

const COLUMN_LABEL: Record<string, string> = { status: "Статус", stage: "Этап", sheet_kind: "Вид ведомости" };
const OP_KIND: Record<AuditOperation, string> = { I: "ok", U: "info", D: "bad" };
const tableName = (t: string) => TABLE_NAME[t] ?? t;
// Скрытые поля приходят как «***» — показываем как есть
// Отметки времени — по-человечески («18.10.2026 14:13»), а не в формате базы
const val = (v: string | null) => (v == null || v === "" ? "—" : v === "true" ? "да" : v === "false" ? "нет"
  : /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v) ? fmtDateTime(v) : v);
// Ключ самой записи уже в колонке «Запись» — в списке изменений его не повторяем
const keyCols = (r: AuditEvent) => new Set(r.record_key.split(",").map((p) => p.split("=")[0].trim()));
const changesOf = (r: AuditEvent) => r.changes.filter((c) => !keyCols(r).has(c.column));

const saved: AuditFilters = {};   // фильтры живут между переключениями вкладок

export function AuditPage() {
  const [filters, setFilters] = useState<AuditFilters>(saved);
  const set = (patch: Partial<AuditFilters>) => setFilters((f) => {
    const next = { ...f, ...patch };
    for (const k of Object.keys(next) as (keyof AuditFilters)[]) if (!next[k]) delete next[k];
    Object.keys(saved).forEach((k) => delete saved[k as keyof AuditFilters]);
    Object.assign(saved, next);
    return next;
  });
  const audit = useAudit(filters);
  // Следующая порция журнала — когда таблица дошла до последней загруженной страницы
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = audit;
  const more = useCallback(() => { if (hasNextPage && !isFetchingNextPage) void fetchNextPage(); }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const rows = useMemo(() => audit.data?.pages.flatMap((p) => p.items) ?? [], [audit.data]);
  const { data: schema } = useSchema();
  const [proposal, setProposal] = useState<string | null>(null);

  // Подпись поля — из описания столбца; где описание начинается со значения («open — открыта…»), подпись своя
  const colLabel = (table: string, column: string) => {
    const l = fieldLabel(schema?.[table]?.fields[column], column);
    return /^[a-z_]+$/.test(l) ? COLUMN_LABEL[column] ?? l : l;
  };
  const cols = useMemo<Column<AuditEvent>[]>(() => [
    { label: "Когда", field: "changed_at", text: (r) => fmtDateTime(r.changed_at) },
    { label: "Кто", field: (r) => r.changed_by_name ?? r.changed_by ?? "Система", bold: true,
      render: (r) => <b title={r.changed_by ? `Логин: ${r.changed_by}` : undefined}>{r.changed_by_name ?? r.changed_by ?? "Система"}</b> },
    { label: "Таблица", field: (r) => tableName(r.table_name) },
    { label: "Действие", field: (r) => OPERATION_NAME[r.operation], badge: true,
      render: (r) => <Badge kind={OP_KIND[r.operation]}>{OPERATION_NAME[r.operation]}</Badge> },
    { label: "Запись", field: "record_key", className: "wrap-sm" },
    { label: "Что изменено", className: "wrap", grow: 3,
      text: (r) => changesOf(r).map((c) => `${colLabel(r.table_name, c.column)}: ${val(c.old)} → ${val(c.new)}`).join("; "),
      render: (r) => (
        <ul className="effects">
          {changesOf(r).map((c) => <li key={c.column}>{colLabel(r.table_name, c.column)}: {r.operation === "I" ? val(c.new) : <>{val(c.old)} → {val(c.new)}</>}</li>)}
        </ul>
      ) },
    { label: "Источник", field: (r) => SOURCE_NAME[r.source], badge: true,
      render: (r) => (
        <span className="audit-src">
          <Badge kind={r.source === "agent" ? "warn" : "muted"}>{SOURCE_NAME[r.source]}</Badge>
          {/* Изменение прошло через согласование — по ссылке видно, что предлагали и кто решил */}
          {r.proposal_id && <button type="button" className="audit-link" title="Что предлагалось и кто согласовал"
            onClick={(e) => { e.stopPropagation(); setProposal(r.proposal_id); }}>Открыть заявку<Icon name="right" /></button>}
        </span>
      ) },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [schema]);
  const [state, setState] = useTableState("audit", cols);
  const shown = useMemo(() => applyTable(state, cols, rows), [state, cols, rows]);

  // Варианты фильтров: таблицы и авторы — из уже загруженных событий (плюс выбранное значение)
  const tables = useMemo(() => [...new Set([...rows.map((r) => r.table_name), ...(filters.table_name ? [filters.table_name] : [])])]
    .sort((a, b) => tableName(a).localeCompare(tableName(b), "ru")), [rows, filters.table_name]);
  const authors = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.changed_by) m.set(r.changed_by, r.changed_by_name ?? r.changed_by);
    if (filters.changed_by && !m.has(filters.changed_by)) m.set(filters.changed_by, filters.changed_by);
    return [...m].sort((a, b) => a[1].localeCompare(b[1], "ru"));
  }, [rows, filters.changed_by]);
  const any = Object.keys(filters).length > 0;

  return (
    <Page title="Журнал изменений">
      <div className="olap-filters">
        <label className="field"><span>С даты</span>
          <input className="text-input" type="date" value={filters.changed_at__gte ?? ""} max={filters.changed_at__lte}
            onChange={(e) => set({ changed_at__gte: e.target.value })} /></label>
        <label className="field"><span>По дату</span>
          <input className="text-input" type="date" value={filters.changed_at__lte ?? ""} min={filters.changed_at__gte}
            onChange={(e) => set({ changed_at__lte: e.target.value })} /></label>
        <label className="field"><span>Таблица</span>
          <select className="select" value={filters.table_name ?? ""} onChange={(e) => set({ table_name: e.target.value })}>
            <option value="">Все</option>{tables.map((t) => <option key={t} value={t}>{tableName(t)}</option>)}
          </select></label>
        <label className="field"><span>Действие</span>
          <select className="select" value={filters.operation ?? ""} onChange={(e) => set({ operation: e.target.value as AuditOperation })}>
            <option value="">Все</option>{(Object.keys(OPERATION_NAME) as AuditOperation[]).map((o) => <option key={o} value={o}>{OPERATION_NAME[o]}</option>)}
          </select></label>
        <label className="field"><span>Кто</span>
          <select className="select" value={filters.changed_by ?? ""} onChange={(e) => set({ changed_by: e.target.value })}>
            <option value="">Все</option>{authors.map(([login, name]) => <option key={login} value={login}>{name}</option>)}
          </select></label>
        <label className="field"><span>Источник</span>
          <select className="select" value={filters.source ?? ""} onChange={(e) => set({ source: e.target.value as AuditSource })}>
            <option value="">Все</option>{(Object.keys(SOURCE_NAME) as AuditSource[]).map((s) => <option key={s} value={s}>{SOURCE_NAME[s]}</option>)}
          </select></label>
        {any && <button type="button" className="btn ghost" onClick={() => set({ changed_at__gte: undefined, changed_at__lte: undefined, table_name: undefined, operation: undefined, changed_by: undefined, source: undefined })}>Сбросить</button>}
      </div>
      <DataTable cols={cols} rows={shown} base={rows} state={state} set={setState} rowKey={(r) => r.audit_id}
        loading={audit.isLoading} error={audit.error ? errorText(audit.error) : null} onRetry={() => audit.refetch()}
        more={audit.hasNextPage} onMore={more} />
      {proposal && <ProposalDialog id={proposal} onClose={() => setProposal(null)} />}
    </Page>
  );
}
