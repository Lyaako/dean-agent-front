// Поиск, фильтры, сортировка, страницы и ширины колонок — перенесено из mockup/redesign/index.html
import type { ReactNode } from "react";
import { fmtDate, norm } from "../../lib/format";

export type FilterType = "enum" | "bool" | "num" | "date" | "text";

export interface Column<R> {
  label: string;
  /** Поле представления (или функция от строки): по нему ищем, фильтруем и сортируем. Нет — колонка только для показа */
  field?: string | ((r: R) => unknown);
  /** Содержимое ячейки; по умолчанию — значение поля */
  render?: (r: R) => ReactNode;
  /** Видимый текст ячейки — для поиска и расчёта ширины; по умолчанию — значение поля */
  text?: (r: R) => string;
  filter?: FilterType;
  className?: string;
  badge?: boolean;
  bold?: boolean;
}

export type RangeNum = { min?: string; max?: string };
export type RangeDate = { from?: string; to?: string };
export type FilterValue = string[] | string | RangeNum | RangeDate;

export interface TableState {
  q: string;
  f: Record<number, FilterValue>;
  sort: { i: number; dir: 1 | -1 } | null;
  page: number;
}
export const emptyTable = (): TableState => ({ q: "", f: {}, sort: null, page: 1 });

export const DROPDOWN_FROM = 6;   // больше значений — фильтр колонки показывается выпадающим списком
export const PAGE_SIZE = 20;

export const rawOf = <R>(c: Column<R>, r: R): unknown =>
  typeof c.field === "function" ? c.field(r) : c.field ? (r as Record<string, unknown>)[c.field] : undefined;
export const labelOf = (v: unknown) => (v == null || v === "" ? "—" : v === true ? "да" : v === false ? "нет" : String(v));
export const shownOf = <R>(c: Column<R>, r: R) => {
  if (c.text) return c.text(r);
  const v = rawOf(c, r);
  return c.filter === "date" && v ? fmtDate(v) : labelOf(v);
};
// Значение для сравнения: decimal из API приходит строкой — сравниваем как число
const sortable = (v: unknown) => (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v);
export const cmp = (a: unknown, b: unknown) => {
  const x = sortable(a), y = sortable(b);
  return Number(x == null) - Number(y == null)
    || (typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), "ru", { numeric: true }));
};

export const isSet = (f: FilterValue | undefined) =>
  f != null && (Array.isArray(f) ? f.length > 0 : typeof f === "string" ? f.trim() !== "" : Object.values(f).some((x) => x !== "" && x != null));

function passes<R>(c: Column<R>, f: FilterValue, r: R) {
  const v = rawOf(c, r);
  if (Array.isArray(f)) return f.includes(labelOf(v));
  if (typeof f === "string") return norm(labelOf(v)).includes(norm(f.trim()));
  if (v == null) return false;
  if (c.filter === "num") {
    const { min, max } = f as RangeNum;
    return (!min || Number(v) >= Number(min)) && (!max || Number(v) <= Number(max));
  }
  const { from, to } = f as RangeDate, d = String(v).slice(0, 10);
  return (!from || d >= from) && (!to || d <= to);
}

export function applyTable<R>(s: TableState, cols: Column<R>[], rows: R[]): R[] {
  const q = norm(s.q.trim());
  let out = rows.filter((r) => (!q || cols.some((c) => c.field && norm(shownOf(c, r)).includes(q)))
    && Object.entries(s.f).every(([i, f]) => !isSet(f) || !cols[+i] || passes(cols[+i], f, r)));
  if (s.sort && cols[s.sort.i]) {
    const c = cols[s.sort.i], dir = s.sort.dir;
    out = [...out].sort((a, b) => cmp(rawOf(c, a), rawOf(c, b)) * dir);
  }
  return out;
}

export function enumValues<R>(c: Column<R>, rows: R[]) {
  return [...new Set(rows.map((r) => labelOf(rawOf(c, r))))].sort((a, b) => Number(a === "—") - Number(b === "—") || cmp(a, b));
}

export function plaqueText<R>(c: Column<R>, f: FilterValue) {
  if (Array.isArray(f)) return f.join(", ");
  if (typeof f === "string") return `«${f.trim()}»`;
  if (c.filter === "num") {
    const { min, max } = f as RangeNum;
    return [min ? `от ${min}` : "", max ? `до ${max}` : ""].filter(Boolean).join(" ");
  }
  const { from, to } = f as RangeDate;
  return [from ? `с ${fmtDate(from)}` : "", to ? `по ${fmtDate(to)}` : ""].filter(Boolean).join(" ");
}

export function pageButtons(cur: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const set = [...new Set([1, cur - 1, cur, cur + 1, total])].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  return set.flatMap((n, i) => (i && n - set[i - 1] > 1 ? (["…", n] as const) : [n]));
}

/* Ширины колонок: каждая — по своему самому длинному значению (длинный текст переносится),
   свободное место делится поровну, поэтому промежутки между колонками одинаковые.
   Считается по всем строкам таблицы (до поиска и фильтров) — колонки не прыгают. */
let measureSpan: HTMLSpanElement | null = null;
const widthCache = new Map<string, number>();
function textW(t: string, size: number, weight = 400) {
  const k = `${size}|${weight}|${t}`;
  let w = widthCache.get(k);
  if (w == null) {
    if (!measureSpan) {
      const box = document.createElement("div");
      box.className = "table-wrap";
      box.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none";
      box.innerHTML = '<table><tbody><tr><td><span style="white-space:nowrap"></span></td></tr></tbody></table>';
      document.body.append(box);
      measureSpan = box.querySelector("span");
    }
    Object.assign(measureSpan!.style, { fontSize: size + "px", fontWeight: String(weight) });
    measureSpan!.textContent = t;
    w = measureSpan!.getBoundingClientRect().width;
    widthCache.set(k, w);
  }
  return w;
}
const WRAP_MAX = 230;

export function colWidths<R>(cols: Column<R>[], rows: R[], avail: number, edge = 22) {
  const small = innerWidth <= 1360, fs = small ? 12 : 13, hs = small ? 11 : 11.5;
  const content: number[] = [], least: number[] = [], shorts: boolean[] = [];
  // Для ширины хватает выборки: на больших таблицах мерить каждую строку дорого
  const sample = rows.length > 600 ? rows.filter((_, i) => i % Math.ceil(rows.length / 600) === 0) : rows;
  cols.forEach((c) => {
    const size = c.badge ? hs : fs, weight = c.bold ? 700 : c.badge ? 500 : 400;
    const vals = sample.map((r) => shownOf(c, r));
    const full = Math.max(0, ...vals.map((v) => textW(v, size, weight)));
    const word = Math.max(0, ...vals.flatMap((v) => v.split(/\s+/)).map((x) => textW(x, size, weight)));
    const wraps = vals.some((v) => /\s/.test(v));
    let w = wraps && !c.badge ? Math.min(full, Math.max(word, WRAP_MAX)) : full;
    const extraBadge = c.badge ? 34 : 0;
    w += extraBadge;
    const head = textW(c.label, hs, 500) + 14;
    const headWord = Math.max(...c.label.split(/\s+/).map((x) => textW(x, hs, 500))) + 14;
    content.push(Math.ceil(Math.max(w, head)) + 2);
    const short = full + extraBadge <= 140;
    shorts.push(short && !c.badge);
    least.push(Math.ceil(Math.max(wraps && !short ? word + extraBadge : w, headWord)) + 4);
  });
  const pads = cols.map((_, j) => (j === 0 ? edge : 8) + (j === cols.length - 1 ? edge : 8));
  let widths = content.map((w, j) => w + pads[j]);
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= avail) {
    const extra = (avail - total) / cols.length;
    widths = widths.map((w) => w + extra);
  } else {
    const slack = content.map((w, j) => w - least[j]), room = slack.reduce((a, b) => a + b, 0);
    const k = Math.min(1, (total - avail) / (room || 1));
    widths = widths.map((w, j) => w - slack[j] * k);
  }
  return { widths, sum: widths.reduce((a, b) => a + b, 0), short: shorts };
}
