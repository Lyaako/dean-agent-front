import { Page } from "../../components/Shell";
import { Badge } from "../../components/ui";
import { useResource } from "../../api/resources";
import { errorText } from "../../api/errors";
import { fmtDate, fmtNum, todayIso } from "../../lib/format";
import { Empty, KvCard } from "./parts";

/* ═════════ МОЯ УЧЁБА (студент) ═════════
   Курсовая или ВКР, практика, стипендия и приказы обо мне. Всё — только свои строки.
   Приказ запланирован, пока у него нет даты исполнения (v_student_orders.applied_at, решение Р7) */

const s = (v: unknown) => (v == null || v === "" ? "—" : String(v));

export function MyStudyPage() {
  const summary = useResource("v_student_summary");
  const works = useResource("v_academic_works");
  const practice = useResource("v_practice");
  const scholarships = useResource("v_active_scholarships");
  const orders = useResource("v_student_orders");

  const me = summary.data?.[0];
  const today = todayIso();
  // Последняя по семестру работа и последняя практика
  const w = [...(works.data ?? [])].sort((a, b) => Number(b.semester) - Number(a.semester))[0];
  const p = [...(practice.data ?? [])].sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))[0];
  const sch = scholarships.data?.[0];
  const ord = [...(orders.data ?? [])].sort((a, b) => String(b.order_date).localeCompare(String(a.order_date)));
  const error = summary.error || works.error || practice.error || scholarships.error || orders.error;
  const loading = summary.isLoading || works.isLoading || practice.isLoading || scholarships.isLoading || orders.isLoading;

  if (error) return <Page title="Моя учёба"><Empty icon="alert" title="Не удалось загрузить">{errorText(error)}</Empty></Page>;
  if (loading) return <Page title="Моя учёба"><div className="skel" style={{ height: 160 }} /></Page>;

  return (
    <Page title="Моя учёба">
      {w ? (
        <KvCard title={w.work_kind === "ВКР" ? "Выпускная квалификационная работа" : "Курсовая работа"}
          extra={<Badge kind="info">{s(w.semester)} семестр</Badge>}
          items={[["Тема", s(w.topic)], ["Руководитель", s(w.supervisor)], ["Рецензент", w.reviewer ? String(w.reviewer) : "не назначается"],
            ["Приказ об утверждении темы", w.order_number ? String(w.order_number) : "не требуется"]]} />
      ) : <Empty icon="cap" title="Курсовой или ВКР в этом году нет">Тема появится, когда её утвердит кафедра</Empty>}
      {p ? (
        <KvCard title={s(p.practice)}
          extra={<Badge kind={String(p.end_date) < today ? "ok" : "info"}>{String(p.end_date) < today ? "Пройдена" : "Предстоит"}</Badge>}
          items={[["Организация", s(p.organization)], ["Сроки", `${fmtDate(p.start_date)} — ${fmtDate(p.end_date)}`], ["Руководитель от вуза", s(p.supervisor)],
            ["Руководитель от организации", s(p.org_supervisor)], ["Приказ", s(p.order_number)]]} />
      ) : <Empty icon="briefcase" title="Практики пока нет">Направление на практику оформит деканат</Empty>}
      <KvCard title="Стипендия" items={[
        ["Сейчас", sch ? s(sch.scholarship) : "Не назначена"],
        ...(sch ? [["Размер", `${fmtNum(sch.amount)} ₽ в месяц`], ["Действует", `${fmtDate(sch.start_date)} — ${fmtDate(sch.end_date)}`]] as [string, string][] : []),
        ["Основа обучения", s(me?.funding)],
        ["Почему", sch ? "сессия сдана на «хорошо» и «отлично»" : me?.funding === "Договор" ? "академическая стипендия — только на бюджете" : "нужно сдать сессию без троек и долгов"],
      ]} />
      <section className="card">
        <div className="table-head"><h2>Приказы обо мне</h2></div>
        {ord.length ? (
          <div className="miss-list">
            {ord.map((o) => (
              <div key={String(o.order_number)} className="miss-row">
                <b>{fmtDate(o.order_date)}</b><span>{s(o.order_number)}</span><span>{s(o.order_type)}</span>
                {o.applied_at == null
                  ? <Badge kind="warn">Запланирован на {fmtDate(o.effective_date)}</Badge>
                  : <Badge kind="muted">{s(o.state)}</Badge>}
              </div>
            ))}
          </div>
        ) : <p className="olap-foot">Приказов о вас пока нет.</p>}
      </section>
    </Page>
  );
}
