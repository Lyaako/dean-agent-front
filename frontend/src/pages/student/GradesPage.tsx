import { useMemo, useState } from "react";
import { Page } from "../../components/Shell";
import { Badge } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { useResource, type Row } from "../../api/resources";
import { errorText } from "../../api/errors";
import { useScale, type Scale } from "../../api/sheets";
import { comma, Tiles } from "./parts";

/* ═════════ УСПЕВАЕМОСТЬ (студент) ═════════
   Плитки по сводке студента, долги, текущий семестр (модули) и прошлые семестры (итоговые результаты).
   Бекенд отдаёт студенту только его строки (v_student_summary, v_debtors, v_current_modules, v_last_result) */

const s = (v: unknown) => (v == null ? "" : String(v));
const ATTEMPT: Record<string, string> = { main: "В сессию", retake: "На пересдаче", commission: "Комиссии", individual: "Индивидуально" };

// Итог без баллов — как fn_result_name(…, final = TRUE): неявка, иначе «Неудовлетворительно» или «Не зачтено»
function finalResult(scale: Scale | undefined, controlType: string, points: number | null, absent: boolean): [string, string] {
  const graded = scale?.graded.get(controlType) ?? true;
  if (absent) return ["Неявка", "bad"];
  if (points == null) return [graded ? "Неудовлетворительно" : "Не зачтено", "bad"];
  if (!graded) return ["Зачтено", "ok"];
  const band = scale?.bands.find((b) => points >= b.min && points <= b.max);
  return band ? [band.name, band.mark === 5 ? "ok" : band.mark === 3 ? "warn" : "info"] : ["Неудовлетворительно", "bad"];
}

// Ячейка модуля — как fn_result_cell: баллы, «н/а» (не аттестован) или «неявка»; нет оценки — «—»
function ModuleCell({ r }: { r?: Row }) {
  if (!r) return <>—</>;
  if (r.is_absent) return <span className="neg">неявка</span>;
  if (r.points == null) return <span className="neg">н/а</span>;
  return <>{s(r.points)}</>;
}

export function GradesPage() {
  const summary = useResource("v_student_summary");
  const groups = useResource("v_groups");
  const debtors = useResource("v_debtors");
  const modules = useResource("v_current_modules");
  const curriculum = useResource("v_curriculum");
  const results = useResource("v_last_result", { stage: "final" });
  const sheets = useResource("grade_sheet");
  const scale = useScale();

  const me = summary.data?.[0];
  const group = groups.data?.find((g) => s(g.group_name) === s(me?.group_name));
  const cur = group?.current_semester == null ? null : Number(group.current_semester);
  const items = useMemo(() => new Map((curriculum.data ?? []).map((c) => [Number(c.item_id), c])), [curriculum.data]);
  const kindOf = useMemo(() => new Map((sheets.data ?? []).map((x) => [Number(x.sheet_id), s(x.sheet_kind)])), [sheets.data]);

  const sems = useMemo(() => [...new Set((results.data ?? []).map((r) => Number(r.semester)))].filter((n) => n !== cur).sort((a, b) => b - a), [results.data, cur]);
  const [sem, setSem] = useState<"cur" | number>("cur");
  const pick = sem === "cur" || !sems.includes(sem) ? "cur" : sem;

  const curDiscs = (curriculum.data ?? []).filter((c) => Number(c.semester) === cur);
  const moduleOf = (discipline: string, stage: string) => (modules.data ?? []).find((m) => s(m.discipline) === discipline && s(m.stage) === stage);
  const past = (results.data ?? []).filter((r) => Number(r.semester) === pick)
    .map((r) => ({ r, c: items.get(Number(r.item_id)) }))
    .sort((a, b) => s(a.c?.discipline).localeCompare(s(b.c?.discipline), "ru"));

  const loading = summary.isLoading || groups.isLoading || curriculum.isLoading || results.isLoading;
  const error = summary.error || groups.error || debtors.error || modules.error || curriculum.error || results.error || sheets.error;
  const debts = Number(me?.debts ?? 0);

  return (
    <Page title="Успеваемость">
      <Tiles items={[
        ["Средний балл", loading ? "…" : comma(me?.avg_points), "по всем сданным"],
        ["Долги", loading ? "…" : String(debts), debts ? "нужно пересдать" : "долгов нет", debts ? "bad" : "ok"],
        ["Категория", loading ? "…" : s(me?.category) || "—"],
        ["Стипендия", loading ? "…" : me?.scholarships ? "Назначена" : "Нет",
          me?.scholarships ? s(me.scholarships) : me?.funding === "Договор" ? "обучение по договору" : "нужны оценки «хорошо» и «отлично»", me?.scholarships ? "ok" : ""],
      ]} />
      {!!debtors.data?.length && (
        <section className="card debts-card">
          <div className="table-head"><h2>Долги</h2></div>
          <div className="debt-list">
            {debtors.data.map((d, i) => (
              <div key={i} className="debt-row"><Icon name="alert" />
                <div><b>{s(d.discipline)}</b><small>{s(d.semester)} семестр · {s(d.control_type)} · {s(d.last_result)} · попыток: {s(d.attempts)}</small></div>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="card">
        <div className="table-head">
          <h2>{pick === "cur" ? `${cur ?? "…"} семестр — текущий` : `${pick} семестр`}</h2>
          <select className="pill-select" aria-label="Семестр" value={String(pick)} onChange={(e) => setSem(e.target.value === "cur" ? "cur" : Number(e.target.value))}>
            <option value="cur">Текущий семестр</option>
            {sems.map((n) => <option key={n} value={n}>{n} семестр</option>)}
          </select>
        </div>
        {error ? <p className="form-error">{errorText(error)}</p> : loading ? <div className="skel" style={{ height: 120 }} /> : (
          <div className="sheet-wrap">
            {pick === "cur" ? (
              <table className="sheet-table grades">
                <thead><tr><th>Дисциплина</th><th>Модуль 1</th><th>Модуль 2</th><th>Итог</th></tr></thead>
                <tbody>{curDiscs.map((c) => (
                  <tr key={s(c.item_id)}><td>{s(c.discipline)}</td>
                    <td><ModuleCell r={moduleOf(s(c.discipline), "module_1")} /></td>
                    <td><ModuleCell r={moduleOf(s(c.discipline), "module_2")} /></td>
                    <td><span className="muted">в сессию</span></td></tr>
                ))}</tbody>
              </table>
            ) : (
              <table className="sheet-table grades">
                <thead><tr><th>Дисциплина</th><th>Контроль</th><th>Баллы</th><th>Оценка</th><th>Сдано</th></tr></thead>
                <tbody>{past.map(({ r, c }) => {
                  const points = r.points == null ? null : Number(r.points);
                  const [name, kind] = finalResult(scale.data, s(c?.control_type), points, !!r.is_absent);
                  return (
                    <tr key={s(r.sheet_id) + s(r.item_id)}>
                      <td>{s(c?.discipline) || "—"}</td><td>{s(c?.control_type) || "—"}</td>
                      <td>{points ?? <span className="neg">{r.is_absent ? "неявка" : "н/а"}</span>}</td>
                      <td><Badge kind={kind}>{name}</Badge></td>
                      <td>{points == null ? "—" : ATTEMPT[kindOf.get(Number(r.sheet_id)) ?? ""] ?? "—"}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </Page>
  );
}
