import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Page } from "../../components/Shell";
import { Icon } from "../../components/Icon";
import { Seg } from "../../components/ui";
import { TableTools } from "../../components/table/TableTools";
import { DataTable } from "../../components/table/DataTable";
import { useTableState } from "../../components/table/useTableState";
import { applyTable } from "../../components/table/tableLogic";
import { RecordDialog, type FormConfig } from "../../components/form/RecordDialog";
import type { Values } from "../../components/form/fields";
import { useResource } from "../../api/resources";
import { useCan } from "../../api/schema";
import { errorText } from "../../api/errors";
import { addDays, human, mondayOf, todayIso } from "../../lib/format";
import { SCHEDULE_COLS } from "../columns";
import { WeekGrid, type Slot } from "./WeekGrid";

export type By = "group" | "teacher" | "classroom";
export const BY: [By, string, string][] = [["group", "Группа", "group_name"], ["teacher", "Преподаватель", "teacher"], ["classroom", "Аудитория", "classroom"]];
const byField = (by: By) => BY.find(([v]) => v === by)![2];

// Состояние вкладки сохраняется между переключениями, как в макете
const saved = { view: "table" as "table" | "week", date: todayIso(), by: "group" as By, who: "" };
export const clearScheduleState = () => Object.assign(saved, { view: "table", date: todayIso(), by: "group", who: "" });

const SORT = "lesson_date,pair_number,group_name";

export function SchedulePage() {
  const can = useCan();
  const [s, setS] = useState(saved);
  const set = (patch: Partial<typeof saved>) => setS((x) => { Object.assign(saved, x, patch); return { ...saved }; });

  // Переход из карточки группы: ?view=week&by=group&who=ИДБ-24-11
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (!params.get("view")) return;
    set({ view: params.get("view") === "week" ? "week" : "table", by: (params.get("by") as By) || "group", who: params.get("who") || "" });
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Текущий семестр — тот, в который попадает сегодняшний день (иначе ближайший)
  const terms = useResource("academic_term");
  const term = useMemo(() => {
    const list = [...(terms.data ?? [])].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
    const today = todayIso();
    return list.find((t) => String(t.start_date) <= today && today <= String(t.end_date))
      ?? list.find((t) => String(t.start_date) > today) ?? list[list.length - 1] ?? null;
  }, [terms.data]);

  const lessons = useResource("v_schedule_calendar",
    term ? { lesson_date__gte: String(term.start_date), lesson_date__lte: String(term.end_date), sort: SORT } : {}, !!term);
  const rows = useMemo(() => lessons.data ?? [], [lessons.data]);
  const holidays = useResource("holiday");
  const pairs = useResource("pair_time");

  const mon = mondayOf(s.date);
  const first = term ? mondayOf(String(term.start_date)) : null;
  const prev = addDays(mon, -7), next = addDays(mon, 7);
  const today = todayIso();

  // Таблица показывает выбранную неделю: даты задаёт переключатель недель, а не фильтр
  const weekRows = useMemo(() => rows.filter((r) => String(r.lesson_date) >= mon && String(r.lesson_date) <= addDays(mon, 6)), [rows, mon]);
  const [tstate, tset] = useTableState("schedule", SCHEDULE_COLS);
  const filtered = useMemo(() => applyTable(tstate, SCHEDULE_COLS, weekRows), [tstate, weekRows]);

  const whoOptions = useMemo(() => {
    const f = byField(s.by);
    return [...new Set(rows.map((r) => String(r[f] ?? "")).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
  }, [rows, s.by]);
  const who = whoOptions.includes(s.who) ? s.who : whoOptions[0] ?? "";

  const [open, setOpen] = useState<{ slotId: unknown } | { initial: Values } | null>(null);
  const form = useMemo<FormConfig>(() => ({
    order: ["assignment_id", "classroom_id", "weekday", "pair_number", "week_parity", "term_id", "valid_from", "valid_to"],
    labels: { assignment_id: "Занятие (группа · дисциплина)", term_id: "Семестр" },
    // Чётность недели в новом занятии не спрашиваем: база ставит «каждую неделю»
    hideOnCreate: ["week_parity"],
    checks: (v) => ({ valid_to: v.valid_from && v.valid_to && v.valid_to < v.valid_from ? "«Действует по» не может быть раньше «Действует с»" : undefined }),
    // Выбранная в «Неделе» группа или преподаватель сужает список поручений
    filters: s.view === "week" && s.by !== "classroom" && who
      ? { assignment_id: (o) => String(o.row[s.by === "group" ? "group_name" : "teacher"]) === who } : undefined,
    note: open && "slotId" in open ? "Изменится занятие на все даты семестра, а не только на выбранный день." : undefined,
  }), [s.view, s.by, who, open]);

  const bar = (
    <div className="week-bar">
      <div className="week-nav">
        <button className="icon-btn soft" onClick={() => set({ date: prev })} disabled={!!first && prev < first} aria-label="Предыдущая неделя"><Icon name="left" /></button>
        <div className="week-label"><b>{human(mon)} — {human(addDays(mon, 5))}</b></div>
        <button className="icon-btn soft" onClick={() => set({ date: next })} disabled={!!term && next > String(term.end_date)} aria-label="Следующая неделя"><Icon name="right" /></button>
      </div>
      <Seg value={s.view} onChange={(v) => set({ view: v })} options={[["table", "Таблица", "list"], ["week", "Неделя", "calendar"]]} />
    </div>
  );

  const addBtn = can("schedule_slot", "create") && (
    <button className="btn sm primary" onClick={() => setOpen({ initial: term ? { term_id: String(term.term_id) } : {} })}><Icon name="plus" />Добавить</button>
  );
  const error = terms.error || lessons.error;

  return (
    <Page title="Расписание">
      {bar}
      {s.view === "table" ? (
        <>
          <TableTools state={tstate} set={tset} cols={SCHEDULE_COLS} rows={weekRows} count={lessons.isLoading || error ? undefined : filtered.length}>
            <span className="spacer" />
            {addBtn}
          </TableTools>
          <div className="enter" key="table">
            <DataTable cols={SCHEDULE_COLS} rows={filtered} base={weekRows} state={tstate} set={tset}
              rowKey={(r) => `${r.lesson_date}|${r.slot_id}`} title={term ? `${term.name} семестр · ${human(mon)} — ${human(addDays(mon, 5))}` : ""}
              loading={terms.isLoading || lessons.isLoading} error={error ? errorText(error) : null} onRetry={() => lessons.refetch()}
              onRowClick={(r) => setOpen({ slotId: r.slot_id })} />
          </div>
        </>
      ) : (
        <>
          <div className="toolbar">
            <Seg value={s.by} onChange={(v) => set({ by: v, who: "" })} options={BY.map(([v, l]) => [v, l] as [By, string])} />
            <select className="pill-select who-select" value={who} onChange={(e) => set({ who: e.target.value })} aria-label={BY.find(([v]) => v === s.by)![1]}>
              {whoOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <span className="spacer" />
            {addBtn}
          </div>
          <div className="enter" key={`${s.by}|${who}|${mon}`}>
            <WeekGrid mon={mon} today={today} hide={byField(s.by)}
              lessons={rows.filter((l) => String(l[byField(s.by)]) === who && String(l.lesson_date) >= mon && String(l.lesson_date) <= addDays(mon, 5)) as Slot[]}
              holidays={new Set((holidays.data ?? []).map((h) => String(h.holiday_date)))}
              pairTimes={pairs.data ?? []} loading={lessons.isLoading || terms.isLoading} error={error ? errorText(error) : null}
              onLesson={(l) => setOpen({ slotId: l.slot_id })}
              onEmpty={can("schedule_slot", "create") ? (weekday, pair) => setOpen({ initial: { weekday: String(weekday), pair_number: String(pair), ...(term ? { term_id: String(term.term_id) } : {}) } }) : undefined} />
          </div>
        </>
      )}
      {open && (
        <RecordDialog table="schedule_slot" config={form}
          recordKey={"slotId" in open ? { slot_id: open.slotId } : null}
          initial={"initial" in open ? open.initial : undefined}
          title={"slotId" in open ? "Занятие в расписании" : "Новое занятие"}
          onClose={() => setOpen(null)} />
      )}
    </Page>
  );
}
