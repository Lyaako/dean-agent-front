import { useMemo, type ReactNode } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { useResource } from "../../api/resources";
import { todayIso } from "../../lib/format";

// Общее для экранов студента (mockup/redesign/roles.js, «СТУДЕНТ»)

/** Плитки: подпись, значение, пояснение, вид (ok — зелёное, bad — красное) */
export const Tiles = ({ items }: { items: [string, ReactNode, ReactNode?, string?][] }) => (
  <div className="olap-tiles">
    {items.map(([label, value, note, kind = ""]) => (
      <div key={label} className={`card olap-tile ${kind}`}><small>{label}</small><b>{value}</b>{note && <span>{note}</span>}</div>
    ))}
  </div>
);

/** Карточка «подпись — значение» */
export const KvCard = ({ title, items, extra }: { title: string; items: [string, ReactNode][]; extra?: ReactNode }) => (
  <section className="card me-card">
    <div className="table-head"><h2>{title}</h2>{extra}</div>
    <div className="kv-grid me-kv">{items.map(([l, v]) => <div key={l}><small>{l}</small><b>{v}</b></div>)}</div>
  </section>
);

export const Empty = ({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) => (
  <section className="card empty-day"><Icon name={icon} /><b>{title}</b>{children}</section>
);

/** Процент с полоской под числом: зелёная — хорошо, красная — плохо (как pctCell в макете OLAP) */
export const Pct = ({ v }: { v: number | null }) => (v == null ? <>—</>
  : <span className={`pct ${v >= 85 ? "ok" : v >= 65 ? "mid" : "bad"}`}>{v}%<i style={{ ["--w" as string]: `${v}%` }} /></span>);

/** Текущий семестр — тот, в который попадает сегодняшний день (иначе ближайший) */
export function useCurrentTerm() {
  const terms = useResource("academic_term");
  const term = useMemo(() => {
    const today = todayIso();
    const list = [...(terms.data ?? [])].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
    return list.find((t) => String(t.start_date) <= today && today <= String(t.end_date))
      ?? list.find((t) => String(t.start_date) > today) ?? list[list.length - 1] ?? null;
  }, [terms.data]);
  return { term, isLoading: terms.isLoading, error: terms.error };
}

export const comma = (v: unknown) => (v == null || v === "" ? "—" : String(v).replace(".", ","));
