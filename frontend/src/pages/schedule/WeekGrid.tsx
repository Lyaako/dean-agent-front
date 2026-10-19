import type { ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { Badge } from "../../components/ui";
import { addDays, fmtTime, human, weekdayOf, WD_SHORT } from "../../lib/format";
import { LESSON_KIND } from "../columns";
import type { Row } from "../../api/resources";

export interface Slot extends Row {
  slot_id: number; lesson_date: string; pair_number: number; lesson_type: string; discipline: string;
  group_name: string; teacher: string; classroom: string; subgroup: number | null;
}

interface Props {
  mon: string;
  today: string;
  hide: string;              // поле, которое уже видно из выбора (группа / преподаватель / аудитория)
  lessons: Slot[];
  holidays: Set<string>;
  pairTimes: Row[];
  loading: boolean;
  error: string | null;
  onLesson: (l: Slot) => void;
  onEmpty?: (weekday: number, pair: number) => void;
  /** Строка под занятием (посещаемость: «Были 20 из 22») */
  extra?: (l: Slot) => ReactNode;
  /** Занятие нельзя открыть (будущее — посещаемость ещё не отмечают) */
  disabled?: (l: Slot) => boolean;
}

// «Неделя» — расписание одного объекта: Пн–Сб × пары (как в макете)
export function WeekGrid({ mon, today, hide, lessons, holidays, pairTimes, loading, error, onLesson, onEmpty, extra, disabled }: Props) {
  const days = Array.from({ length: 6 }, (_, i) => addDays(mon, i));
  const timeOf = new Map(pairTimes.map((p) => [Number(p.pair_number), p]));
  const maxPair = Math.max(4, ...lessons.map((l) => Number(l.pair_number)));
  const pairs = Array.from({ length: maxPair }, (_, i) => i + 1);

  if (error) return <section className="card empty-day"><Icon name="alert" /><b>Не удалось загрузить</b>{error}</section>;

  return (
    <section className="card week-card">
      <div className="week-grid">
        <div className="wg-h" />
        {days.map((d) => (
          <div key={d} className={`wg-h${d === today ? " today" : ""}`}>
            <b>{WD_SHORT[weekdayOf(d)]}, {human(d)}</b>{holidays.has(d) && <small>праздник</small>}
          </div>
        ))}
        {pairs.map((p) => {
          const pt = timeOf.get(p);
          return [
            <div key={`t${p}`} className="wg-time"><b>{pt ? fmtTime(pt.start_time) : `${p}`}</b><small>{p} пара{pt ? ` · до ${fmtTime(pt.end_time)}` : ""}</small></div>,
            ...days.map((d, di) => {
              const here = lessons.filter((l) => l.lesson_date === d && Number(l.pair_number) === p);
              return (
                <div key={`${d}${p}`} className={`wg-cell${d === today ? " today" : ""}${!here.length && onEmpty && !loading ? " can-add" : ""}`}
                  onClick={!here.length && onEmpty && !loading ? () => onEmpty(di + 1, p) : undefined}
                  title={!here.length && onEmpty ? "Добавить занятие" : undefined}>
                  {loading ? <div className="skel" style={{ height: 52 }} /> : here.map((l) => (
                    <button type="button" key={`${l.slot_id}`} className={`lesson ${l.lesson_type === "Лекция" ? "lec" : "prac"}${disabled?.(l) ? " future" : ""}`}
                      disabled={disabled?.(l)} onClick={(e) => { e.stopPropagation(); onLesson(l); }}>
                      <div className="l-top"><Badge kind={LESSON_KIND[l.lesson_type]}>{l.lesson_type}</Badge><span className="l-room"><Icon name="pin" />{l.classroom}</span></div>
                      <b>{l.discipline}</b>
                      <small>{[hide !== "group_name" && l.group_name, l.subgroup && `подгруппа ${l.subgroup}`, hide !== "teacher" && l.teacher].filter(Boolean).join(" · ")}</small>
                      {extra?.(l)}
                    </button>
                  ))}
                  {!here.length && onEmpty && !loading && <span className="wg-add"><Icon name="plus" /></span>}
                </div>
              );
            }),
          ];
        })}
      </div>
    </section>
  );
}
