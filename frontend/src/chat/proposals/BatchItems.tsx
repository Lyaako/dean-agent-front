import { useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { Badge } from "../../components/ui";
import { useLookup } from "../../components/form/lookups";
import { fieldLabel, useSchema, type FieldSpec } from "../../api/schema";
import { undoReasonText } from "../../api/errors";
import { plural } from "../../lib/format";
import type { BatchItem, Proposal } from "../../api/proposals";
import { TABLE_NAME } from "./useProposal";

/* ── Строки пакета от агента (mockup/redesign/batch.js, batchDialog): отметки, фильтры, причины.
   mode: approve — выбор строк для применения (можно только state = ok); undo — выбор применённых обратимых строк для отмены (Ф-Р8);
   view — без отметок: итог применения и причины, почему строку не отменить (Ф-Р9) ── */

const PREVIEW = 50;
export type BatchMode = "approve" | "undo" | "view";
type Kind = "ok" | "muted" | "warn" | "bad" | "info";

const show = (v: unknown) => (v == null || v === "" ? "—" : typeof v === "boolean" ? (v ? "да" : "нет") : String(v));
export function Value({ v, spec }: { v: unknown; spec?: FieldSpec }) {
  const rel = spec?.relation;
  const { data } = useLookup(rel?.table, rel?.column);
  const o = rel && v != null ? data?.find((x) => String(x.value) === String(v)) : undefined;
  return <>{o ? o.label : show(v)}</>;
}

// Подпись записи — от бекенда (label), иначе запасной вариант «таблица · ключ»
const keyText = (key: Record<string, unknown>) => Object.entries(key).map(([k, v]) => `${k}=${String(v)}`).join(", ");
export const recordOf = (it: BatchItem) => it.label?.record ?? TABLE_NAME[it.table] ?? it.table;
export const subOf = (it: BatchItem) => (it.label ? it.label.sub : keyText(it.key) || "новая запись");

// Состояние строки до решения (state сервера) → подпись с кодом макета
const STATE_NOTE: Record<string, [string, Kind]> = {
  already_done: ["CH-01 · Уже сделано", "muted"],
  conflict: ["CH-02 · Конфликт: запись изменили по-другому", "warn"],
  gone: ["CH-03 · Запись удалили", "bad"],
};
export const applied = (p: Proposal) => new Set(p.execution.picked_item_ids ?? []);
/** Можно ли отметить строку в этом режиме */
export const pickable = (p: Proposal, it: BatchItem, mode: BatchMode) =>
  mode === "approve" ? it.state === "ok" : mode === "undo" ? applied(p).has(it.item_id) && !!it.reversible : false;

function notes(p: Proposal, it: BatchItem, undone?: Set<number>): [string, Kind][] {
  if (p.status === "pending") {
    if (it.state === "rule_violation") return [[it.message || "Не пройдёт проверку базы данных", "bad"]];
    return STATE_NOTE[it.state] ? [STATE_NOTE[it.state]] : [];
  }
  if (p.status !== "approved") return [];
  const done = applied(p).has(it.item_id);
  const out: [string, Kind][] = [done ? ["Применено", "ok"] : ["Пропущено", "muted"]];
  // Отмена уже выполнена: какие строки она вернула — из обратного предложения (execution.undo_id → его picked_item_ids).
  // undo_reason у строк после отмены — expired, но «срок истёк» здесь неверно: строку отменили или сняли с отмены
  if (done && p.execution.undo_id) { if (undone) out.push(undone.has(it.item_id) ? ["Отменено", "muted"] : ["Не отменено", "muted"]); return out; }
  const skipped = p.execution.undo_skipped?.find((x) => x.item_id === it.item_id);
  if (done && it.reversible === false) {
    const why = undoReasonText(it.undo_reason ?? skipped?.reason);
    if (why) out.push([why, "muted"]);
  }
  return out;
}

interface Props {
  p: Proposal; mode: BatchMode; picked: Set<number>; onPick: (next: Set<number>) => void;
  culprit?: number; disabled?: boolean;
  /** Строки, которые вернула выполненная отмена */
  undone?: Set<number>;
}
export function BatchItems({ p, mode, picked, onPick, culprit, disabled, undone }: Props) {
  const { data: schema } = useSchema();
  const [filter, setFilter] = useState<"all" | "picked" | "warn">("all");
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const last = useRef<number | null>(null);
  const items = useMemo(() => {
    const list = p.items ?? [];
    // Отмена — только среди применённых строк
    return mode === "undo" ? list.filter((it) => applied(p).has(it.item_id)) : list;
  }, [p, mode]);
  const check = mode !== "view";
  const warn = p.status === "pending" ? items.filter((it) => notes(p, it, undone).length) : [];
  // Строку с ошибкой показываем всегда, даже если она отфильтрована
  const shown = items.filter((it) => it.item_id === culprit || ((filter === "picked" ? picked.has(it.item_id) : filter === "warn" ? warn.includes(it) : true)
    && (!q || `${recordOf(it)} ${subOf(it) ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))));
  const rows = all ? shown : shown.slice(0, PREVIEW);
  const can = shown.filter((it) => pickable(p, it, mode));
  const allOn = can.length > 0 && can.every((it) => picked.has(it.item_id));
  // Одно поле одной таблицы во всём пакете — пишем его один раз в шапке, а не в каждой строке
  const fields = new Set(items.map((it) => `${it.table}.${it.field.join(",")}`));
  const one = fields.size === 1 && items[0]?.field.length === 1 ? items[0] : undefined;
  const title = (it: BatchItem, f: string) => it.label?.fields?.[f] ?? fieldLabel(schema?.[it.table]?.fields[f], f);

  const toggle = (id: number, on: boolean, shift: boolean) => {
    const next = new Set(picked);
    // Shift+клик: строкам между прошлым и этим кликом — то же состояние
    const i = shift && last.current != null ? shown.findIndex((x) => x.item_id === last.current) : -1, j = shown.findIndex((x) => x.item_id === id);
    const ids = i >= 0 && j >= 0 ? shown.slice(Math.min(i, j), Math.max(i, j) + 1).filter((x) => pickable(p, x, mode)).map((x) => x.item_id) : [id];
    ids.forEach((x) => (on ? next.add(x) : next.delete(x)));
    last.current = id; onPick(next);
  };
  const chip = (v: typeof filter, label: React.ReactNode, n: number) => (
    <button type="button" className="fchip" aria-pressed={filter === v} onClick={() => { setFilter(v); setAll(false); }}>{label}<span className="n">{n}</span></button>
  );

  return <>
    <div className="batch-tools">
      <div className="chips">{chip("all", "Все", items.length)}{check && chip("picked", "Отмечено", picked.size)}{!!warn.length && chip("warn", <><Icon name="alert" />Внимание</>, warn.length)}</div>
      <label className="search sm"><Icon name="search" /><input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти запись" aria-label="Найти запись" autoComplete="off" /></label>
    </div>
    {!check && one && <p className="hint">{title(one, one.field[0])}: было → стало</p>}
    <div className="batch-list" role="list">
      {check && (
        <label className="b-row b-head">
          <input type="checkbox" checked={allOn} disabled={disabled || !can.length} aria-label="Отметить все"
            onChange={(e) => { const next = new Set(picked); can.forEach((it) => (e.target.checked ? next.add(it.item_id) : next.delete(it.item_id))); onPick(next); }} />
          <span>Отметить все{filter !== "all" || q ? " найденные" : ""}</span>
          <span className="hint">{one ? `${title(one, one.field[0])}: было → стало · ` : ""}Shift+клик — диапазон</span>
        </label>
      )}
      {rows.map((it) => {
        const ok = pickable(p, it, mode), on = picked.has(it.item_id);
        const blocked = check && !ok;
        return (
          <div key={it.item_id} role="listitem"
            className={`b-row${blocked ? " invalid" : ""}${it.state === "conflict" || it.state === "gone" ? " stale" : ""}${it.item_id === culprit ? " culprit" : ""}${check && !on ? " off" : ""}`}>
            {check && <input type="checkbox" checked={on} disabled={disabled || !ok} aria-label={`${recordOf(it)} ${subOf(it) ?? ""}`}
              onChange={(e) => toggle(it.item_id, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)} />}
            <div className="b-rec"><b>{recordOf(it)}</b>{subOf(it) && <small>{subOf(it)}</small>}</div>
            <div className="b-val">{it.field.map((f) => {
              const spec = schema?.[it.table]?.fields[f], before = it.before?.[f];
              return <span key={f} style={{ display: "contents" }}>
                {!one && <span className="k">{title(it, f)}</span>}
                {it.before && before != null && before !== "" && <><span className="old"><Value v={before} spec={spec} /></span><Icon name="arrow" /></>}
                <span className="new"><Value v={it.after[f]} spec={spec} /></span>
              </span>;
            })}</div>
            <div className="b-note">{notes(p, it, undone).map(([t, k]) => <Badge key={t} kind={k}>{t}</Badge>)}</div>
          </div>
        );
      })}
      {!shown.length && <p className="hint b-empty">Ничего не найдено</p>}
      {shown.length > rows.length && <button type="button" className="btn sm ghost b-more" onClick={() => setAll(true)}>Показать ещё {shown.length - rows.length}</button>}
    </div>
  </>;
}

export const nRec = (n: number) => `${n} ${plural(n, "запись", "записи", "записей")}`;
