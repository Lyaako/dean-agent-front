import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../Icon";
import { colWidths, pageButtons, shownOf, PAGE_SIZE, type Column, type TableState } from "./tableLogic";

interface Props<R> {
  cols: Column<R>[];
  rows: R[];           // после поиска, фильтров и сортировки
  base: R[];           // все строки — по ним считаются ширины колонок
  state: TableState;
  set: (patch: Partial<TableState>) => void;
  rowKey: (r: R) => string;
  title?: ReactNode;
  onRowClick?: (r: R) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  flashKey?: string | null;
  /** Открыть страницу, на которой первая строка, подходящая под условие (например, выбранная неделя) */
  startAt?: (r: R) => boolean;
}

export function DataTable<R>({ cols, rows, base, state, set, rowKey, title, onRowClick, loading, error, onRetry, flashKey, startAt }: Props<R>) {
  const cardRef = useRef<HTMLElement>(null);
  const [avail, setAvail] = useState(0);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  // Открыть на нужной странице один раз, когда данные пришли
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !startAt || !rows.length) return;
    started.current = true;
    const i = rows.findIndex(startAt);
    if (i > 0) set({ page: Math.floor(i / PAGE_SIZE) + 1 });
  }, [rows, startAt, set]);

  // Подсветить строку и перейти на её страницу
  useEffect(() => {
    if (!flashKey) return;
    const i = rows.findIndex((r) => rowKey(r) === flashKey);
    if (i >= 0 && Math.floor(i / PAGE_SIZE) + 1 !== state.page) set({ page: Math.floor(i / PAGE_SIZE) + 1 });
    requestAnimationFrame(() => {
      const tr = cardRef.current?.querySelector<HTMLElement>(`tr[data-k="${CSS.escape(flashKey)}"]`);
      if (!tr) return;
      tr.scrollIntoView({ block: "center", behavior: "smooth" });
      tr.classList.remove("flash"); void tr.offsetWidth; tr.classList.add("flash");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashKey]);

  const p = Math.min(state.page, pages);
  const shown = rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const cw = avail ? colWidths(cols, base.length ? base : rows, avail) : null;
  // Значения без пробелов и короткие значения не переносим
  const nw = cols.map((c, j) => shown.every((r) => !/\s/.test(shownOf(c, r))) || !!cw?.short[j]);
  const so = state.sort;

  const go = (n: number) => {
    set({ page: n });
    const card = cardRef.current;
    if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const sortBy = (i: number) =>
    set({ sort: so?.i !== i ? { i, dir: 1 } : so.dir === 1 ? { i, dir: -1 } : null });

  const a = rows.length ? (p - 1) * PAGE_SIZE + 1 : 0, b = Math.min(p * PAGE_SIZE, rows.length);

  return (
    <section ref={cardRef} className="card table-card">
      {title && <div className="table-head"><h2>{title}</h2></div>}
      <div className="table-wrap">
        <table className="fixed" style={cw ? { width: cw.sum } : undefined}>
          {cw && <colgroup>{cw.widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>}
          <thead>
            <tr>
              {cols.map((c, i) => c.field ? (
                <th key={i} className={`${c.className ?? ""} sortable`} onClick={() => sortBy(i)} title="Сортировать"
                  aria-sort={so?.i === i ? (so.dir > 0 ? "ascending" : "descending") : "none"}>
                  {c.label}<span className="sort-ic">{so?.i === i ? (so.dir > 0 ? "↑" : "↓") : ""}</span>
                </th>
              ) : <th key={i} className={c.className}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 6 }, (_, i) => (
                <tr key={i}>{cols.map((_, j) => <td key={j}><div className="skel" style={{ height: 14 }} /></td>)}</tr>
              ))
            ) : error ? (
              <tr><td colSpan={cols.length} className="empty"><Icon name="alert" /><b>Не удалось загрузить</b>{error}
                {onRetry && <div><button className="btn sm soft retry" onClick={onRetry}><Icon name="refresh" />Повторить</button></div>}</td></tr>
            ) : shown.length ? (
              shown.map((r, i) => {
                const k = rowKey(r);
                return (
                  <tr key={k} data-k={k} style={{ ["--r" as string]: Math.min(i, 14) }} className={onRowClick ? "clickable" : undefined}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}>
                    {cols.map((c, j) => (
                      <td key={j} className={`${c.className ?? ""}${nw[j] ? " nw" : ""}`}>{c.render ? c.render(r) : shownOf(c, r)}</td>
                    ))}
                  </tr>
                );
              })
            ) : (
              <tr><td colSpan={cols.length} className="empty"><Icon name="search" /><b>Ничего не найдено</b>Измените фильтры или спросите агента</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && !loading && (
        <div className="pager">
          <span>{a}–{b} из {rows.length}</span>
          <div className="pages">
            <button onClick={() => go(p - 1)} disabled={p <= 1} aria-label="Предыдущая страница"><Icon name="left" /></button>
            {pageButtons(p, pages).map((n, i) => n === "…"
              ? <span key={`g${i}`} className="gap">…</span>
              : <button key={n} className={n === p ? "cur" : ""} onClick={() => go(n)}>{n}</button>)}
            <button onClick={() => go(p + 1)} disabled={p >= pages} aria-label="Следующая страница"><Icon name="right" /></button>
          </div>
        </div>
      )}
    </section>
  );
}
