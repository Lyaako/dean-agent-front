import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Icon } from "../Icon";
import { fieldHint, fieldLabel, type FieldSpec } from "../../api/schema";
import { useLookup, type Option } from "./lookups";
import { norm } from "../../lib/format";
import type { Row } from "../../api/resources";

export type Kind = "int" | "decimal" | "text" | "textarea" | "date" | "time" | "datetime" | "bool" | "choice" | "relation";

const WEEKDAYS: [string, string][] = [["1", "Понедельник"], ["2", "Вторник"], ["3", "Среда"], ["4", "Четверг"], ["5", "Пятница"], ["6", "Суббота"]];

// Варианты из описания поля в БД: «Неделя: every — каждая, odd — нечётная, even — чётная»
export function choicesOf(name: string, spec: FieldSpec): [string, string][] | null {
  if (name === "weekday") return WEEKDAYS;
  const d = spec.description ?? "";
  const tail = d.includes(":") ? d.slice(d.indexOf(":") + 1) : "";
  const pairs = [...tail.matchAll(/([A-Za-z_]+|\d+)\s+—\s+([^,;]+)/g)].map((m) => [m[1], m[2].trim()] as [string, string]);
  return pairs.length >= 2 ? pairs : null;
}

export function kindOf(name: string, spec: FieldSpec): Kind {
  if (spec.relation) return "relation";
  if (choicesOf(name, spec)) return "choice";
  const t = spec.type;
  if (t === "boolean") return "bool";
  if (/^(integer|smallint|bigint)/.test(t)) return "int";
  if (t.startsWith("numeric")) return "decimal";
  if (t === "date") return "date";
  if (t.startsWith("time ") || t === "time without time zone") return "time";
  if (t.startsWith("timestamp")) return "datetime";
  const len = Number(t.match(/\((\d+)\)/)?.[1] ?? 0);
  return t === "text" || len > 200 ? "textarea" : "text";
}

const maxLen = (spec: FieldSpec) => Number(spec.type.match(/character(?: varying)?\((\d+)\)/)?.[1] ?? 0) || undefined;

// Значение из API → строка для поля ввода
export function toInput(v: unknown, kind: Kind): string | boolean {
  if (kind === "bool") return !!v;
  if (v == null) return "";
  if (kind === "datetime") return String(v).slice(0, 16);
  if (kind === "time") return String(v).slice(0, 5);
  return String(v);
}

// Строка из поля ввода → значение для API (пусто → null)
export function fromInput(v: unknown, kind: Kind, spec: FieldSpec): unknown {
  if (kind === "bool") return !!v;
  if (v === "" || v == null) return null;
  if (kind === "int" || (kind === "relation" && /^(integer|smallint|bigint)/.test(spec.type))) return Number(v);
  if (kind === "choice" && /^(integer|smallint)/.test(spec.type)) return Number(v);
  return v;
}

export interface FieldProps {
  name: string;
  spec: FieldSpec;
  value: string | boolean;
  onChange: (v: string | boolean) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  filter?: (o: Option) => boolean;
}

export function Field({ name, spec, value, onChange, label, required, disabled, filter }: FieldProps) {
  const kind = kindOf(name, spec);
  const title = label ?? fieldLabel(spec, name);
  const hint = fieldHint(spec);
  const id = `f-${name}`;

  if (kind === "bool") {
    return (
      <label className="check form-check" title={hint}>
        <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{title}</span>
      </label>
    );
  }

  let input;
  if (kind === "relation") {
    input = <LookupSelect id={id} table={spec.relation!.table} column={spec.relation!.column} value={String(value)}
      onChange={onChange} disabled={disabled} required={required} filter={filter} />;
  } else if (kind === "choice") {
    input = (
      <select id={id} className="select" value={String(value)} disabled={disabled} required={required} onChange={(e) => onChange(e.target.value)}>
        {(!required || value === "") && <option value="">—</option>}
        {choicesOf(name, spec)!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    );
  } else if (kind === "textarea") {
    input = <textarea id={id} className="text-input textarea" value={String(value)} maxLength={maxLen(spec)} disabled={disabled}
      required={required} rows={3} onChange={(e) => onChange(e.target.value)} />;
  } else {
    const type = { int: "number", decimal: "number", date: "date", time: "time", datetime: "datetime-local", text: "text" }[kind as string] ?? "text";
    input = <input id={id} className="text-input" type={type} value={String(value)} disabled={disabled} required={required}
      step={kind === "decimal" ? "0.01" : kind === "int" ? "1" : undefined} maxLength={maxLen(spec)} onChange={(e) => onChange(e.target.value)} />;
  }

  return (
    <div className={`field form-field${kind === "textarea" ? " wide" : ""}`}>
      <label htmlFor={id}>{title}{required && <i className="req" aria-label="обязательное">*</i>}</label>
      {input}
      {hint && kind !== "choice" && <small className="hint">{hint}</small>}
    </div>
  );
}

// Выпадающий список с поиском по связанной таблице
export function LookupSelect({ id, table, column, value, onChange, disabled, required, filter, placeholder = "Выберите…", byLabel }: {
  id?: string; table: string; column: string; value: string; onChange: (v: string) => void;
  disabled?: boolean; required?: boolean; filter?: (o: Option) => boolean; placeholder?: string;
  /** Значение — подпись, а не id (команды бэкенда принимают название группы, основы и т. п.) */
  byLabel?: boolean;
}) {
  const { data, isLoading, error } = useLookup(table, column);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const valOf = (o: Option) => (byLabel ? o.label : String(o.value));

  const options = useMemo(() => (data ?? []).filter((o) => !filter || filter(o) || valOf(o) === value),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, filter, value, byLabel]);
  const current = options.find((o) => valOf(o) === value) ?? data?.find((o) => valOf(o) === value);
  const shown = useMemo(() => {
    const n = norm(q.trim());
    const hits = n ? options.filter((o) => norm(`${o.label} ${o.sub ?? ""}`).includes(n)) : options;
    return hits.slice(0, 200);
  }, [options, q]);

  // Список — поверх окна (position: fixed), чтобы его не обрезала прокрутка диалога; не помещается снизу — открывается вверх
  const [pos, setPos] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = box.current!.getBoundingClientRect();
      const below = innerHeight - r.bottom - 12, above = r.top - 12;
      const up = below < 220 && above > below;
      setPos({ position: "fixed", left: r.left, width: r.width, right: "auto", maxHeight: Math.min(280, up ? above : below),
        ...(up ? { top: "auto", bottom: innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
    };
    place();
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => { removeEventListener("resize", place); removeEventListener("scroll", place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    // Esc закрывает только список, а не окно: перехватываем раньше обработчика окна
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); setQ(""); } };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [open]);
  useEffect(() => { list.current?.children[hi]?.scrollIntoView({ block: "nearest" }); }, [hi]);

  const pick = (o: Option | null) => { onChange(o ? valOf(o) : ""); setOpen(false); setQ(""); };

  return (
    <div className="lookup" ref={box}>
      <div className={`lookup-in text-input${open ? " open" : ""}${disabled ? " disabled" : ""}`}>
        <input id={id} value={open ? q : current?.label ?? (value ? (byLabel ? value : `№ ${value}`) : "")} disabled={disabled}
          placeholder={isLoading ? "Загрузка…" : placeholder} autoComplete="off" required={required && !value}
          onFocus={() => { setOpen(true); setHi(0); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
            else if (e.key === "Enter" && open) { e.preventDefault(); if (shown[hi]) pick(shown[hi]); }
            else if (e.key === "Tab") setOpen(false);
          }} />
        {!open && current?.sub && <small className="lookup-sub">{current.sub}</small>}
        {value && !disabled && !required && (
          <button type="button" className="lookup-clear" aria-label="Очистить" onClick={() => pick(null)}><Icon name="x" /></button>
        )}
        <Icon name="down" className="ic lookup-caret" />
      </div>
      {open && !disabled && (
        <div className="lookup-list" ref={list} role="listbox" style={pos}>
          {error ? <div className="lookup-empty">Не удалось загрузить список</div>
            : isLoading ? <div className="lookup-empty">Загрузка…</div>
            : !shown.length ? <div className="lookup-empty">Ничего не найдено</div>
            : shown.map((o, i) => (
              <button type="button" key={String(o.value)} role="option" aria-selected={valOf(o) === value}
                className={`lookup-opt${i === hi ? " hi" : ""}`} onMouseEnter={() => setHi(i)} onClick={() => pick(o)}>
                <b>{o.label}</b>{o.sub && <small>{o.sub}</small>}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export type Values = Record<string, string | boolean>;
export const rowToValues = (row: Row | null | undefined, fields: [string, FieldSpec][]): Values =>
  Object.fromEntries(fields.map(([n, sp]) => [n, toInput(row?.[n], kindOf(n, sp))]));
