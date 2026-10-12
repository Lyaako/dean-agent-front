import { useMemo, useState, type ReactNode } from "react";
import { Page } from "../components/Shell";
import { Icon } from "../components/Icon";
import { TableTools } from "../components/table/TableTools";
import { DataTable } from "../components/table/DataTable";
import { useTableState } from "../components/table/useTableState";
import { applyTable, type Column } from "../components/table/tableLogic";
import { RecordDialog, type FormConfig } from "../components/form/RecordDialog";
import type { Values } from "../components/form/fields";
import { useResource, type Row } from "../api/resources";
import { useCan } from "../api/schema";
import { errorText } from "../api/errors";

export interface ResourceTableProps {
  id: string;
  title: string;
  view: string;
  table: string;
  keyField: string;
  cols: Column<Row>[];
  form?: FormConfig;
  rowTitle: (r: Row) => string;
  newTitle: string;
  /** Подстановка для новой записи */
  initial?: Values;
  /** Свои кнопки в шапке таблицы */
  actions?: ReactNode;
  /** Свои действия в окне записи */
  dialogExtra?: (viewRow: Row) => (row: Row | null) => ReactNode;
}

// Вкладка = таблица представления + окно записи исходной таблицы (ключ в представлении и в таблице один)
export function ResourceTablePage({ id, title, view, table, keyField, cols, form, rowTitle, newTitle, initial, actions, dialogExtra }: ResourceTableProps) {
  const can = useCan();
  const data = useResource(view);
  const rows = useMemo(() => data.data ?? [], [data.data]);
  const [state, set] = useTableState(id, cols);
  const filtered = useMemo(() => applyTable(state, cols, rows), [state, cols, rows]);
  const [open, setOpen] = useState<{ row: Row | null } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const dialogRow = open?.row ? rows.find((r) => r[keyField] === open.row?.[keyField]) ?? open.row : null;

  return (
    <Page title={title}>
      <TableTools state={state} set={set} cols={cols} rows={rows} count={data.isLoading || data.error ? undefined : filtered.length}>
        <span className="spacer" />
        {actions}
        {can(table, "create") && <button className="btn sm primary" onClick={() => setOpen({ row: null })}><Icon name="plus" />Добавить</button>}
      </TableTools>
      <DataTable cols={cols} rows={filtered} base={rows} state={state} set={set}
        rowKey={(r) => String(r[keyField])} onRowClick={(r) => setOpen({ row: r })}
        loading={data.isLoading} error={data.error ? errorText(data.error) : null} onRetry={() => data.refetch()} flashKey={flash} />
      {open && (
        <RecordDialog table={table} config={form} initial={initial}
          recordKey={open.row ? { [keyField]: open.row[keyField] } : null}
          title={open.row ? rowTitle(open.row) : newTitle}
          extra={dialogRow && dialogExtra ? dialogExtra(dialogRow) : undefined}
          onClose={() => setOpen(null)}
          onSaved={(saved) => { setFlash(null); requestAnimationFrame(() => setFlash(String(saved[keyField]))); }} />
      )}
    </Page>
  );
}
