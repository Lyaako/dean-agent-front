import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ConfirmDialog, ErrorNote, useToast } from "../ui";
import { Icon } from "../Icon";
import { Field, fromInput, kindOf, rowToValues, type Values } from "./fields";
import type { Option } from "./lookups";
import { useCan, useSchema, type FieldSpec } from "../../api/schema";
import { createRow, deleteRow, getRow, updateRow, type Key, type Row } from "../../api/resources";
import { errorText, requestIdOf } from "../../api/errors";

// Настройка формы таблицы на конкретной вкладке
export interface FormConfig {
  order?: string[];
  hide?: string[];
  labels?: Record<string, string>;
  /** Какие варианты показывать в выпадающем списке поля (по уже введённым значениям формы) */
  filters?: Record<string, (o: Option, v: Values) => boolean>;
  note?: ReactNode;
  /** Связанные поля: после изменения одного поля подставить значения в другие */
  derive?: (changed: string, v: Values) => Partial<Values>;
}

interface Props {
  table: string;
  recordKey: Key | null;          // null — новая запись
  title: string;
  config?: FormConfig;
  initial?: Values;               // подстановка для новой записи
  onClose: () => void;
  onSaved?: (row: Row, created: boolean) => void;
  extra?: (row: Row | null) => ReactNode;  // дополнительные действия в подвале окна
}

export function RecordDialog({ table, recordKey, title, config, initial, onClose, onSaved, extra }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const { data: schema } = useSchema();
  const spec = schema?.[table];
  const isNew = !recordKey;

  const row = useQuery({
    queryKey: ["row", table, recordKey],
    queryFn: () => getRow(table, recordKey!),
    enabled: !isNew,
    staleTime: 0,
  });

  const fields = useMemo<[string, FieldSpec][]>(() => {
    if (!spec) return [];
    const order = config?.order ?? [];
    const names = spec.write_fields.filter((f) => !config?.hide?.includes(f));
    names.sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
    return names.map((n) => [n, spec.fields[n]]);
  }, [spec, config]);

  const [values, setValues] = useState<Values>({});
  const [base, setBase] = useState<Values>({});
  useEffect(() => {
    if (!fields.length) return;
    if (isNew) {
      const v = { ...rowToValues(null, fields), ...initial };
      setValues(v);
      setBase(rowToValues(null, fields));
    } else if (row.data) {
      const v = rowToValues(row.data, fields);
      setValues(v);
      setBase(v);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, row.data, isNew]);

  const editable = isNew ? can(table, "create") : can(table, "update");
  const deletable = !isNew && can(table, "delete");
  const required = (sp: FieldSpec) => !sp.nullable && sp.default == null;
  const changed = fields.filter(([n]) => values[n] !== base[n]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["res"] });
    qc.invalidateQueries({ queryKey: ["lookup"] });
    qc.invalidateQueries({ queryKey: ["row", table] });
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      let saved: Row;
      if (isNew) {
        const payload: Row = {};
        for (const [n, sp] of fields) {
          const v = fromInput(values[n], kindOf(n, sp), sp);
          if (v !== null) payload[n] = v;
        }
        saved = await createRow(table, payload);
      } else {
        const payload: Row = {};
        for (const [n, sp] of changed) payload[n] = fromInput(values[n], kindOf(n, sp), sp);
        saved = await updateRow(table, recordKey!, payload);
      }
      refresh();
      toast(isNew ? "Запись добавлена" : "Изменение сохранено");
      onSaved?.(saved, isNew);
      onClose();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      await deleteRow(table, recordKey!);
      refresh();
      toast("Запись удалена");
      onClose();
    } catch (e2) {
      setErr(e2);
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  const loading = !spec || (!isNew && row.isLoading);

  return (
    <Modal onClose={onClose} label={title}>
      <form className="dialog form-dialog" onSubmit={save}>
        <div className="form-head">
          <span className="dialog-ico"><Icon name={isNew ? "plus" : "edit"} /></span>
          <div>
            <h3>{title}</h3>
            {!editable && !loading && <p>Только просмотр — недостаточно прав для изменения</p>}
          </div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="x" /></button>
        </div>

        {config?.note && <div className="form-note">{config.note}</div>}

        {!schema ? <div className="skel" style={{ height: 120 }} />
          : !spec ? <p className="form-error">Таблица «{table}» недоступна для вашей роли</p>
          : loading ? <div className="form-grid">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skel" style={{ height: 64 }} />)}</div>
          : row.error ? <ErrorNote text={errorText(row.error, table)} requestId={requestIdOf(row.error)} />
          : !isNew && !row.data ? <p className="form-error">Запись не найдена — возможно, её уже удалили</p>
          : (
            <div className="form-grid">
              {fields.map(([n, sp]) => (
                <Field key={n} name={n} spec={sp} value={values[n] ?? ""} label={config?.labels?.[n]}
                  required={required(sp)} disabled={!editable || busy}
                  filter={config?.filters?.[n] ? (o) => config.filters![n](o, values) : undefined}
                  onChange={(v) => setValues((s) => {
                    const next = { ...s, [n]: v };
                    return { ...next, ...config?.derive?.(n, next) } as Values;
                  })} />
              ))}
            </div>
          )}

        {!!err && <ErrorNote text={errorText(err, table)} requestId={requestIdOf(err)} />}

        <div className="actions">
          {deletable && <button type="button" className="btn ghost danger-text" onClick={() => setConfirmDelete(true)} disabled={busy}><Icon name="trash" />Удалить</button>}
          {extra?.(row.data ?? null)}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>{editable ? "Отменить" : "Закрыть"}</button>
          {editable && (
            <button className="btn primary" disabled={busy || loading || (!isNew && !changed.length)}>
              {busy ? "Сохраняем…" : isNew ? "Добавить" : "Сохранить"}
            </button>
          )}
        </div>
      </form>
      {confirmDelete && (
        <ConfirmDialog title="Удалить запись?" text="Это действие нельзя отменить." confirm="Удалить" danger busy={busy}
          onConfirm={remove} onCancel={() => setConfirmDelete(false)} />
      )}
    </Modal>
  );
}
