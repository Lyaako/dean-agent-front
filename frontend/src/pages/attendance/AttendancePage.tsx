import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Page } from "../../components/Shell";
import { Icon } from "../../components/Icon";
import { Badge, ErrorNote, Modal } from "../../components/ui";
import { useAuth } from "../../auth/AuthProvider";
import { createRow, updateRow, useResource, type Row } from "../../api/resources";
import { errorCode, errorText, requestIdOf } from "../../api/errors";
import { useStudents, type Student } from "../../api/sheets";
import { addDays, human, initials, mondayOf, todayIso, tone, weekdayOf, WD_SHORT } from "../../lib/format";
import { WeekGrid, type Slot } from "../schedule/WeekGrid";

/* ═════════ ПОСЕЩАЕМОСТЬ (attendance) — вкладка преподавателя ═════════
   Неделя как в расписании: на каждом прошедшем занятии — отметки; нажатие открывает список группы.
   Отметка — строка attendance (занятие, студент, дата, был / не был); сохраняется сразу */

interface Mark { attendance_id: number; slot_id: number; student_id: number; lesson_date: string; is_present: boolean }
const lessonKey = (slotId: unknown, date: unknown) => `${date}|${slotId}`;

const saved = { date: todayIso() };   // выбранная неделя живёт между переключениями вкладок

export function AttendancePage() {
  const { me, fullName } = useAuth();
  const today = todayIso();
  const [date, setDate] = useState(saved.date);
  const go = (d: string) => { saved.date = d; setDate(d); };

  // Текущий семестр — тот, в который попадает сегодняшний день (иначе ближайший)
  const terms = useResource("academic_term");
  const term = useMemo(() => {
    const list = [...(terms.data ?? [])].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
    return list.find((t) => String(t.start_date) <= today && today <= String(t.end_date))
      ?? list.find((t) => String(t.start_date) > today) ?? list[list.length - 1] ?? null;
  }, [terms.data, today]);

  // Свои занятия: календарь отдаёт ФИО преподавателя, отметки — по teacher_id
  const lessons = useResource("v_schedule_calendar", term && fullName
    ? { teacher: fullName, lesson_date__gte: String(term.start_date), lesson_date__lte: String(term.end_date), sort: "lesson_date,pair_number" } : {}, !!term && !!fullName);
  const marks = useResource("v_attendance", { teacher_id: me?.teacher_id ?? undefined }, me?.teacher_id != null);
  const students = useStudents();
  const holidays = useResource("holiday");
  const pairs = useResource("pair_time");

  const marksBy = useMemo(() => {
    const m = new Map<string, Map<number, Mark>>();
    for (const r of (marks.data ?? []) as unknown as Mark[]) {
      const k = lessonKey(r.slot_id, r.lesson_date);
      if (!m.has(k)) m.set(k, new Map());
      m.get(k)!.set(Number(r.student_id), r);
    }
    return m;
  }, [marks.data]);
  const rosterOf = (group: string) => (students.data ?? []).filter((s) => s.group_name === group && s.active)
    .sort((a, b) => a.student.localeCompare(b.student, "ru"));

  // Состояние занятия: не отмечено (сколько из скольких) или «Были N из M»
  const status = (l: Slot): [string, "warn" | "ok" | "info" | ""] => {
    if (l.lesson_date > today) return ["", ""];
    const m = marksBy.get(lessonKey(l.slot_id, l.lesson_date)), roster = rosterOf(l.group_name);
    const done = roster.filter((s) => m?.has(s.student_id)).length;
    if (done < roster.length) return [`Не отмечено${done ? ` · ${done} из ${roster.length}` : ""}`, "warn"];
    const here = roster.filter((s) => m?.get(s.student_id)?.is_present).length;
    return [`Были ${here} из ${roster.length}`, here === roster.length ? "ok" : "info"];
  };

  const all = (lessons.data ?? []) as Slot[];
  const ready = !lessons.isLoading && !marks.isLoading && !students.isLoading;
  const todo = ready ? all.filter((l) => l.lesson_date <= today && status(l)[1] === "warn").length : 0;

  const mon = mondayOf(date), prev = addDays(mon, -7), next = addDays(mon, 7);
  const first = term ? mondayOf(String(term.start_date)) : null;
  const week = all.filter((l) => l.lesson_date >= mon && l.lesson_date <= addDays(mon, 5));
  const [open, setOpen] = useState<Slot | null>(null);
  const error = terms.error || lessons.error || marks.error || students.error;

  return (
    <Page title="Посещаемость">
      <div className="week-bar">
        <div className="week-nav">
          <button className="icon-btn soft" onClick={() => go(prev)} disabled={!!first && prev < first} aria-label="Предыдущая неделя"><Icon name="left" /></button>
          <div className="week-label"><b>{human(mon)} — {human(addDays(mon, 5))}</b></div>
          <button className="icon-btn soft" onClick={() => go(next)} disabled={!!term && next > String(term.end_date)} aria-label="Следующая неделя"><Icon name="right" /></button>
        </div>
        {todo > 0 && <span className="att-todo"><Badge kind="warn">Не отмечено занятий: {todo}</Badge></span>}
      </div>
      <div className="enter" key={mon}>
        <WeekGrid mon={mon} today={today} hide="teacher" lessons={week}
          holidays={new Set((holidays.data ?? []).map((h) => String(h.holiday_date)))}
          pairTimes={pairs.data ?? []} loading={!ready || terms.isLoading} error={error ? errorText(error) : null}
          disabled={(l) => l.lesson_date > today}
          extra={(l) => {
            const [t, k] = status(l);
            return t ? <span className={`l-att ${k}`}><Icon name={k === "warn" ? "alert" : "check"} />{t}</span> : null;
          }}
          onLesson={(l) => setOpen(l)} />
      </div>
      {open && (
        <AttendanceDialog lesson={open} roster={rosterOf(open.group_name)}
          marks={marksBy.get(lessonKey(open.slot_id, open.lesson_date)) ?? new Map()} onClose={() => setOpen(null)} />
      )}
    </Page>
  );
}

function AttendanceDialog({ lesson: l, roster, marks, onClose }: { lesson: Slot; roster: Student[]; marks: Map<number, Mark>; onClose: () => void }) {
  const qc = useQueryClient();
  // Отметки этого окна: сохранённые в базе + только что поставленные (до перезагрузки списка)
  const [local, setLocal] = useState(() => new Map<number, { id: number | null; present: boolean }>(
    [...marks].map(([id, m]) => [id, { id: m.attendance_id, present: m.is_present }])));
  const [pending, setPending] = useState(0);
  const [failure, setFailure] = useState<unknown>(null);

  async function mark(ids: number[], present: boolean) {
    setFailure(null);
    const before = new Map(local);
    setLocal((m) => { const n = new Map(m); for (const id of ids) n.set(id, { id: m.get(id)?.id ?? null, present }); return n; });
    setPending((p) => p + 1);
    try {
      for (const id of ids) {
        const cur = before.get(id);
        if (cur && cur.present === present) continue;
        const saved: Row = cur?.id != null
          ? await updateRow("attendance", { attendance_id: cur.id }, { is_present: present })
          : await createRow("attendance", { slot_id: l.slot_id, student_id: id, lesson_date: l.lesson_date, is_present: present });
        setLocal((m) => new Map(m).set(id, { id: Number(saved.attendance_id), present }));
      }
    } catch (ex) {
      setFailure(ex);
      setLocal(before);
    } finally {
      setPending((p) => p - 1);
    }
  }

  const close = () => { qc.invalidateQueries({ queryKey: ["res", "v_attendance"] }); onClose(); };
  const done = roster.filter((s) => local.has(s.student_id)).length;
  const here = roster.filter((s) => local.get(s.student_id)?.present).length;

  return (
    <Modal onClose={close} label={`Посещаемость: ${l.discipline}`}>
      <div className="dialog form-dialog att-dialog">
        <div className="form-head">
          <div><h3>{l.discipline}</h3><p>{l.group_name} · {l.lesson_type} · {WD_SHORT[weekdayOf(l.lesson_date)]}, {human(l.lesson_date)}, {l.pair_number} пара · {l.classroom}</p></div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={close}><Icon name="x" /></button>
        </div>
        <div className="form-body">
          <div className="att-head">
            <span>{done < roster.length ? <Badge kind="warn">Отмечено {done} из {roster.length}</Badge> : <>Были <b>{here}</b> из {roster.length}</>}</span>
            <button type="button" className="btn sm ghost" disabled={pending > 0 || !roster.length}
              onClick={() => mark(roster.map((s) => s.student_id), true)}><Icon name="check" />Все были</button>
          </div>
          <div className="att-list">
            {roster.map((s) => {
              const v = local.get(s.student_id)?.present;
              return (
                <div key={s.student_id} className="att-row">
                  <span className={`avatar t${tone(s.student)}`}>{initials(s.student)}</span><b>{s.student}</b>
                  <div className="seg att-seg" role="group" aria-label={s.student} style={{ ["--n" as string]: 2, ["--i" as string]: v === false ? 1 : 0 }} data-unset={v == null}>
                    <button type="button" data-v="1" aria-pressed={v === true} onClick={() => mark([s.student_id], true)}>Был</button>
                    <button type="button" data-v="0" aria-pressed={v === false} onClick={() => mark([s.student_id], false)}>Не был</button>
                  </div>
                </div>
              );
            })}
          </div>
          {failure != null && <ErrorNote text={errorText(failure, "attendance")} requestId={requestIdOf(failure)} code={errorCode(failure)} />}
        </div>
      </div>
    </Modal>
  );
}
