import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ConfirmDialog, ErrorNote, UnsavedDialog, useToast } from "../ui";
import { Icon } from "../Icon";
import { checkField, Field, fromInput, kindOf, rowToValues, type Values } from "./fields";
import type { Option } from "./lookups";
import { useCan, useSchema, type FieldSpec } from "../../api/schema";
import { createRow, deleteRow, getRow, updateRow, type Key, type Row } from "../../api/resources";
import { errorText, requestIdOf } from "../../api/errors";

// Настройка формы таблицы на конкретной вкладке
export interface FormConfig {
  order?: string[];
  hide?: string[];
  /** Поля, которых нет в форме добавления (значение по умолчанию поставит база) */
  hideOnCreate?: string[];
  /** Поля, которые в уже созданной записи не меняются (например, чья это курсовая) */
  lockOnEdit?: string[];
  labels?: Record<string, string>;
  /** Какие варианты показывать в выпадающем списке поля (по уже введённым значениям формы) */
  filters?: Record<string, (o: Option, v: Values) => boolean>;
  note?: ReactNode;
  /** Связанные поля: после изменения одного поля подставить значения в другие */
  derive?: (changed: string, v: Values) => Partial<Values>;
  /** Проверки между полями: имя поля → текст ошибки */
  checks?: (v: Values) => Record<string, string | undefined>;
  /** В уже созданной записи вместо выбора связанной записи (человека) правятся её поля (ФИО) */
  linked?: { field: string; table: string; key: string; fields: string[] };
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

const isRequired = (sp: FieldSpec) => !sp.nullable && sp.default == null;

export function RecordDialog({ table, recordKey, title, config, initial, onClose, onSaved, extra }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const { data: schema } = useSchema();
  const spec = schema?.[table];
  const isNew = !recordKey;
  const linked = !isNew ? config?.linked : undefined;
  const linkedSpec = linked ? schema?.[linked.table] : undefined;

  const row = useQuery({ queryKey: ["row", table, recordKey], queryFn: () => getRow(table, recordKey!), enabled: !isNew, staleTime: 0 });
  const linkedKey = linked && row.data ? { [linked.key]: row.data[linked.field] } : null;
  const linkedRow = useQuery({
    queryKey: ["row", linked?.table, linkedKey], queryFn: () => getRow(linked!.table, linkedKey!), enabled: !!linkedKey, staleTime: 0,
  });

  const fields = useMemo<[string, FieldSpec][]>(() => {
    if (!spec) return [];
    const order = config?.order ?? [];
    const hidden = [...(config?.hide ?? []), ...(isNew ? config?.hideOnCreate ?? [] : []), ...(linked ? [linked.field] : [])];
    const names = spec.write_fields.filter((f) => !hidden.includes(f));
    names.sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
    return names.map((n) => [n, spec.fields[n]]);
  }, [spec, config, isNew, linked]);
  const linkedFields = useMemo<[string, FieldSpec][]>(
    () => (linked && linkedSpec ? linked.fields.filter((f) => linkedSpec.fields[f]).map((f) => [f, linkedSpec.fields[f]]) : []),
    [linked, linkedSpec]);

  const [values, setValues] = useState<Values>({});
  const [base, setBase] = useState<Values>({});
  const [lValues, setLValues] = useState<Values>({});
  const [lBase, setLBase] = useState<Values>({});
  useEffect(() => {
    if (!fields.length) return;
    if (isNew) {
      setValues({ ...rowToValues(null, fields), ...initial });
      setBase(rowToValues(null, fields));
    } else if (row.data) {
      const v = rowToValues(row.data, fields);
      setValues(v);
      setBase(v);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, row.data, isNew]);
  useEffect(() => {
    if (!linkedFields.length || !linkedRow.data) return;
    const v = rowToValues(linkedRow.data, linkedFields);
    setLValues(v);
    setLBase(v);
  }, [linkedFields, linkedRow.data]);

  const editable = isNew ? can(table, "create") : can(table, "update");
  const linkedEditable = !!linked && can(linked.table, "update");
  const deletable = !isNew && can(table, "delete");
  const changed = fields.filter(([n]) => values[n] !== base[n]);
  const lChanged = linkedFields.filter(([n]) => lValues[n] !== lBase[n]);
  const dirty = (isNew ? fields.some(([n]) => values[n] !== base[n] && values[n] !== "" && values[n] !== false) : changed.length > 0) || lChanged.length > 0;

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [askUnsaved, setAskUnsaved] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["res"] });
    qc.invalidateQueries({ queryKey: ["lookup"] });
    qc.invalidateQueries({ queryKey: ["row"] });
  };

  // Проверка до отправки: обязательные поля, числа и диапазоны, правила между полями
  function validate(): boolean {
    const e: Record<string, string> = {};
    for (const [n, sp] of fields) {
      const m = checkField(n, sp, values[n] ?? "", isRequired(sp));
      if (m) e[n] = m;
    }
    for (const [n, sp] of linkedFields) {
      const m = checkField(n, sp, lValues[n] ?? "", isRequired(sp));
      if (m) e[`linked.${n}`] = m;
    }
    for (const [n, m] of Object.entries(config?.checks?.(values) ?? {})) if (m && !e[n]) e[n] = m;
    setErrors(e);
    const first = Object.keys(e)[0];
    if (first) formRef.current?.querySelector(`[data-field="${first}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    return !first;
  }

  async function save(e?: FormEvent) {
    e?.preventDefault();
    setAskUnsaved(false);
    if (!validate()) return;
    setBusy(true);
    setErr(null);
    try {
      if (linked && lChanged.length) {
        const patch: Row = {};
        for (const [n, sp] of lChanged) patch[n] = fromInput(lValues[n], kindOf(n, sp), sp);
        await updateRow(linked.table, linkedKey!, patch);
      }
      let saved: Row = row.data ?? {};
      if (isNew) {
        const payload: Row = {};
        for (const [n, sp] of fields) {
          const v = fromInput(values[n], kindOf(n, sp), sp);
          if (v !== null) payload[n] = v;
        }
        saved = await createRow(table, payload);
      } else if (changed.length) {
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

  // Закрыть крестиком или Esc: если есть несохранённые изменения — спросить
  const requestClose = () => { if (dirty && !busy) setAskUnsaved(true); else onClose(); };

  const loading = !spec || (!isNew && (row.isLoading || (!!linkedKey && linkedRow.isLoading)));
  const setField = (n: string, v: string | boolean) => {
    setErrors((e) => { const { [n]: _, ...rest } = e; return rest; });
    setValues((s) => {
      const next = { ...s, [n]: v };
      return { ...next, ...config?.derive?.(n, next) } as Values;
    });
  };

  return (
    <Modal onClose={requestClose} label={title} outsideClose={false}>
      <form ref={formRef} className="dialog form-dialog" onSubmit={save} noValidate>
        <div className="form-head">
          <div>
            <h3>{title}</h3>
            {!editable && !loading && <p>Только просмотр — недостаточно прав для изменения</p>}
          </div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={requestClose}><Icon name="x" /></button>
        </div>

        <div className="form-body">
          {config?.note && <div className="form-note">{config.note}</div>}

          {!schema ? <div className="skel" style={{ height: 120 }} />
            : !spec ? <p className="form-error">Таблица «{table}» недоступна для вашей роли</p>
            : loading ? <div className="form-grid">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skel" style={{ height: 64 }} />)}</div>
            : row.error ? <ErrorNote text={errorText(row.error, table)} requestId={requestIdOf(row.error)} />
            : !isNew && !row.data ? <p className="form-error">Запись не найдена — возможно, её уже удалили</p>
            : (
              <div className="form-grid">
                {linkedFields.map(([n, sp]) => (
                  <Field key={`linked.${n}`} name={`linked.${n}`} spec={sp} value={lValues[n] ?? ""} required={isRequired(sp)}
                    disabled={!linkedEditable || busy} error={errors[`linked.${n}`]}
                    onChange={(v) => { setErrors((e) => { const { [`linked.${n}`]: _, ...rest } = e; return rest; }); setLValues((s) => ({ ...s, [n]: v })); }} />
                ))}
                {fields.map(([n, sp]) => (
                  <Field key={n} name={n} spec={sp} value={values[n] ?? ""} label={config?.labels?.[n]}
                    required={isRequired(sp)} disabled={!editable || busy || (!isNew && !!config?.lockOnEdit?.includes(n))}
                    error={errors[n]}
                    filter={config?.filters?.[n] ? (o) => config.filters![n](o, values) : undefined}
                    onChange={(v) => setField(n, v)} />
                ))}
              </div>
            )}

          {!!err && <ErrorNote text={errorText(err, table)} requestId={requestIdOf(err)} />}
        </div>

        {(deletable || extra || editable) && (
          <div className="actions">
            {deletable && <button type="button" className="btn sm danger" onClick={() => setConfirmDelete(true)} disabled={busy}><Icon name="trash" />Удалить</button>}
            {extra?.(row.data ?? null)}
            <span className="spacer" />
            {(editable || linkedEditable) && (
              <button className="btn primary" disabled={busy || loading || (!isNew && !dirty)}>
                {busy ? "Сохраняем…" : isNew ? "Добавить" : "Сохранить"}
              </button>
            )}
          </div>
        )}
      </form>
      {confirmDelete && (
        <ConfirmDialog title="Удалить запись?" text="Это действие нельзя отменить." confirm="Удалить" danger busy={busy}
          onConfirm={remove} onCancel={() => setConfirmDelete(false)} />
      )}
      {askUnsaved && (
        <UnsavedDialog onSave={() => save()} onDiscard={onClose} onCancel={() => setAskUnsaved(false)} saveLabel={isNew ? "Добавить" : "Сохранить"} />
      )}
    </Modal>
  );
}
