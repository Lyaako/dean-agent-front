import { useMemo } from "react";
import { Page } from "../../components/Shell";
import { Badge } from "../../components/ui";
import { useResource } from "../../api/resources";
import { errorText } from "../../api/errors";
import { fmtDate } from "../../lib/format";
import { LESSON_KIND } from "../columns";
import { Pct, Tiles, useCurrentTerm } from "./parts";

/* ═════════ ПОСЕЩАЕМОСТЬ (студент) ═════════
   Отметки текущего семестра (v_attendance — только свои): плитки, по дисциплинам, список пропусков.
   Считаются отмеченные занятия; ещё не отмеченные преподавателем в процент не входят */

const s = (v: unknown) => (v == null ? "" : String(v));

export function MyAttendancePage() {
  const { term, isLoading: termLoading, error: termError } = useCurrentTerm();
  const marks = useResource("v_attendance");
  // Тип занятия (лекция, практика) — из календаря по занятию и дате
  const lessons = useResource("v_schedule_calendar",
    term ? { lesson_date__gte: String(term.start_date), lesson_date__lte: String(term.end_date) } : {}, !!term);

  const rows = useMemo(() => (marks.data ?? []).filter((r) => term && s(r.lesson_date) >= s(term.start_date) && s(r.lesson_date) <= s(term.end_date)), [marks.data, term]);
  const typeOf = useMemo(() => new Map((lessons.data ?? []).map((l) => [`${l.lesson_date}|${l.slot_id}`, s(l.lesson_type)])), [lessons.data]);

  const by = useMemo(() => {
    const m = new Map<string, { n: number; miss: number }>();
    for (const r of rows) {
      const x = m.get(s(r.discipline)) ?? { n: 0, miss: 0 };
      x.n++; if (!r.is_present) x.miss++;
      m.set(s(r.discipline), x);
    }
    return [...m].map(([d, x]) => ({ d, ...x, pct: Math.round((x.n - x.miss) / x.n * 100) })).sort((a, b) => a.pct - b.pct);
  }, [rows]);
  const miss = rows.filter((r) => !r.is_present).sort((a, b) => s(b.lesson_date).localeCompare(s(a.lesson_date)) || Number(b.pair_number) - Number(a.pair_number));
  const pct = rows.length ? Math.round((rows.length - miss.length) / rows.length * 100) : null;
  const loading = termLoading || marks.isLoading;
  const error = termError || marks.error;
  const termName = s(term?.name);

  return (
    <Page title="Посещаемость">
      <Tiles items={[
        ["Посещаемость", loading ? "…" : `${pct ?? "—"}%`, termName ? `за ${termName} семестр` : "за текущий семестр", pct == null ? "" : pct >= 70 ? "ok" : "bad"],
        ["Пропущено занятий", loading ? "…" : String(miss.length), `из ${rows.length} отмеченных`, miss.length ? "" : "ok"],
        ["Хуже всего посещаю", by[0] ? `${by[0].pct}%` : "—", by[0]?.d ?? "", by[0] && by[0].pct < 70 ? "bad" : ""],
      ]} />
      <section className="card">
        <div className="table-head"><h2>По дисциплинам</h2></div>
        {error ? <p className="form-error">{errorText(error)}</p> : loading ? <div className="skel" style={{ height: 120 }} />
          : !by.length ? <p className="olap-foot">Отметок посещаемости в этом семестре пока нет.</p> : (
            <div className="sheet-wrap">
              <table className="sheet-table">
                <thead><tr><th>Дисциплина</th><th>Занятий</th><th>Пропусков</th><th>Посещаемость</th></tr></thead>
                <tbody>{by.map((r) => <tr key={r.d}><td>{r.d}</td><td>{r.n}</td><td>{r.miss || "—"}</td><td><Pct v={r.pct} /></td></tr>)}</tbody>
              </table>
            </div>
          )}
      </section>
      {miss.length > 0 && (
        <section className="card">
          <div className="table-head"><h2>Пропуски</h2></div>
          <div className="miss-list">
            {miss.map((r) => {
              const type = typeOf.get(`${r.lesson_date}|${r.slot_id}`);
              return (
                <div key={s(r.attendance_id)} className="miss-row">
                  <b>{fmtDate(r.lesson_date)}</b><span>{s(r.pair_number)} пара</span><span>{s(r.discipline)}</span>
                  {type && <Badge kind={LESSON_KIND[type]}>{type}</Badge>}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </Page>
  );
}
