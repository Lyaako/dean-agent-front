import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../Icon";
import {
  DROPDOWN_FROM, enumValues, isSet, plaqueText,
  type Column, type FilterValue, type RangeDate, type RangeNum, type TableState,
} from "./tableLogic";
import { norm } from "../../lib/format";

interface Props<R> {
  state: TableState;
  set: (patch: Partial<TableState> | ((s: TableState) => Partial<TableState>)) => void;
  cols: Column<R>[];
  rows: R[];            // все строки — из них берутся значения для фильтров
  children?: ReactNode; // дополнительные элементы справа (переключатель вида, «Добавить»)
}

// Панель над таблицей: поиск (по колонкам с текстовым фильтром), «Фильтры» с остальными колонками,
// ниже — плашки активных фильтров слева и число записей справа
export function TableTools<R>({ state, set, cols, rows, children }: Props<R>) {
  const [open, setOpen] = useState(false);
  const [dd, setDd] = useState<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Клик мимо выпадающего списка закрывает его, клик мимо панели — всю панель
  useEffect(() => {
    if (!open) return;
    // После действия по кнопке: mousedown сдвигает кнопки ниже открытой панели до click.
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element;
      if (dd != null && !t.closest(".ff-dd")) setDd(null);
      if (!panelRef.current?.contains(t) && !btnRef.current?.contains(t)) { setOpen(false); setDd(null); }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [open, dd]);

  const setF = (i: number, v: FilterValue | undefined) =>
    set((s) => {
      const f = { ...s.f };
      if (v === undefined) delete f[i]; else f[i] = v;
      return { f, page: 1 };
    });

  const active = Object.entries(state.f).filter(([i, f]) => cols[+i] && isSet(f));
  // Текстовые колонки ищутся строкой поиска, в «Фильтрах» их нет
  const searchCols = cols.filter((c) => c.field && c.filter === "text");
  const searchHint = `Поиск: ${searchCols.map((c) => c.label.replace(/\u00AD/g, "")).join(", ")}`;

  return (
    <>
      <div className="toolbar">
        {searchCols.length > 0 && (
          <label className="search">
            <Icon name="search" />
            <input type="text" value={state.q} onChange={(e) => set({ q: e.target.value, page: 1 })}
              placeholder={searchHint} aria-label={searchHint} autoComplete="off" />
            {state.q && (
              <button type="button" className="search-clear" aria-label="Очистить поиск" onClick={() => set({ q: "", page: 1 })}>
                <Icon name="x" />
              </button>
            )}
          </label>
        )}
        <button ref={btnRef} type="button" className={`btn sm ${open || active.length ? "soft" : "ghost"} filter-btn`}
          aria-expanded={open} onClick={() => { setOpen(!open); setDd(null); }}>
          <Icon name="list" /><span>Фильтры</span>
        </button>
        {children}
      </div>

      {open && (
        <section ref={panelRef} className="card fpanel">
          {cols.map((c, i) => c.field && c.filter && c.filter !== "text" ? (
            <FilterField key={i} col={c} rows={rows} value={state.f[i]} onChange={(v) => setF(i, v)}
              ddOpen={dd === i} onDd={() => setDd(dd === i ? null : i)} />
          ) : null)}
        </section>
      )}

      {active.length > 0 && (
        <div className="table-meta">
          {active.length > 0 && (
            <div className="fplaques">
              {active.map(([i, f]) => (
                <span key={i} className="fplaque">
                  {cols[+i].label}: {plaqueText(cols[+i], f)}
                  <button type="button" onClick={() => setF(+i, undefined)} aria-label={`Убрать фильтр «${cols[+i].label}»`}><Icon name="x" /></button>
                </span>
              ))}
              <button type="button" className="btn sm ghost" onClick={() => set({ f: {}, page: 1 })}>Сбросить всё</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

interface FieldProps<R> {
  col: Column<R>;
  rows: R[];
  value: FilterValue | undefined;
  onChange: (v: FilterValue | undefined) => void;
  ddOpen: boolean;
  onDd: () => void;
}

const LONG = 28;   // длиннее — значения не помещаются кнопками, нужен выпадающий список

function FilterField<R>({ col, rows, value, onChange, ddOpen, onDd }: FieldProps<R>) {
  const [q, setQ] = useState("");
  const title = <span className="ff-l">{col.label}</span>;
  const t = col.filter;

  if (t === "enum" || t === "bool") {
    const vals = enumValues(col, rows);
    const sel = Array.isArray(value) ? value : [];
    const toggle = (v: string) => onChange(sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v]);
    // Много значений или длинные — выпадающий список с поиском и галочками, иначе кнопки
    if (vals.length > DROPDOWN_FROM || vals.some((v) => v.length > LONG)) {
      const n = norm(q.trim());
      const shown = n ? vals.filter((v) => norm(v).includes(n)) : vals;
      return (
        <div className="ff">{title}
          <div className="ff-dd">
            <button type="button" className="ff-in ff-dd-btn" aria-expanded={ddOpen} onClick={() => { setQ(""); onDd(); }}>
              <span>{sel.length === 1 ? sel[0] : sel.length ? `Выбрано: ${sel.length}` : "Все"}</span><Icon name="down" />
            </button>
            {ddOpen && (
              <div className="ff-dd-list">
                <input className="ff-in ff-dd-search" autoFocus value={q} onChange={(e) => setQ(e.target.value)}
                  placeholder="Найти…" aria-label={`Найти: ${col.label}`} autoComplete="off" />
                {shown.length ? shown.map((v) => (
                  <label key={v} className="ff-opt">
                    <input type="checkbox" checked={sel.includes(v)} onChange={() => toggle(v)} /><span>{v}</span>
                  </label>
                )) : <div className="ff-empty">Ничего не найдено</div>}
              </div>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="ff">{title}
        <div className="ff-opts">
          {vals.map((v) => (
            <button key={v} type="button" className="fchip" aria-pressed={sel.includes(v)} onClick={() => toggle(v)}>{v}</button>
          ))}
        </div>
      </div>
    );
  }

  const [a, b, type] = t === "num" ? (["min", "max", "number"] as const) : (["from", "to", "date"] as const);
  const range = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as RangeNum & RangeDate;
  // «от» не может быть больше «до»: если перепутали — меняем местами
  const setRange = (next: Record<string, string>) => {
    const lo = next[a], hi = next[b];
    const bigger = t === "num" ? Number(lo) > Number(hi) : lo > hi;
    onChange(lo && hi && bigger ? { ...next, [a]: hi, [b]: lo } : next);
  };
  return (
    <div className="ff">{title}
      <div className="ff-range">
        <input className="ff-in" type={type} value={range[a] ?? ""} placeholder="от" aria-label={`${col.label}: от`}
          max={range[b] || undefined} onChange={(e) => setRange({ ...range, [a]: e.target.value })} />
        <span>—</span>
        <input className="ff-in" type={type} value={range[b] ?? ""} placeholder="до" aria-label={`${col.label}: до`}
          min={range[a] || undefined} onChange={(e) => setRange({ ...range, [b]: e.target.value })} />
      </div>
    </div>
  );
}
