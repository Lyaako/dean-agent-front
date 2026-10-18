import { useMemo, useState } from "react";
import { useResource } from "../../api/resources";
import { useAuth } from "../../auth/AuthProvider";
import { StudentCard } from "../students/StudentsPage";

// Общее для срезов OLAP (mockup/redesign/olap.js)

export const s = (v: unknown) => (v == null ? "" : String(v));

// Состояние вкладки живёт между переключениями
export const olap = {
  op: "session" as "session" | "heat" | "risk" | "retake" | "moves",
  path: [] as { course?: number; group_id?: number; discipline_id?: number; label: string }[],
  sem: "", course: "", group: "", modMin: "30", attMin: "70",
  level: "group" as "group" | "course", period: "month" as "month" | "semester" | "year", pick: null as string | null,
};
export type Setter = (patch: Partial<typeof olap>) => void;

/** Курс и группа: варианты из v_groups (сервер сам ограничивает область роли) */
export function useGroupOptions() {
  const groups = useResource("v_groups");
  const list = useMemo(() => [...(groups.data ?? [])].sort((a, b) => s(a.group_name).localeCompare(s(b.group_name), "ru", { numeric: true })), [groups.data]);
  const courses = [...new Set(list.map((g) => Number(g.course)))].sort((a, b) => a - b);
  return { list, courses, isLoading: groups.isLoading, error: groups.error };
}

/** Курс и группа из состояния вкладки → параметры запроса */
export function useScope() {
  const groups = useGroupOptions();
  const course = olap.course ? Number(olap.course) : undefined;
  const group = groups.list.find((g) => s(g.group_name) === olap.group);
  return { groups, course, group, scope: { course, group_id: group ? Number(group.group_id) : undefined } };
}

export const Select = ({ label, value, onChange, options, all }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; all?: string }) => (
  <label className="field"><span>{label}</span>
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {all && <option value="">{all}</option>}
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </label>
);

/** Курс и группа — как в макете (группы — только выбранного курса) */
export function CourseGroup({ set, groups }: { set: Setter; groups: ReturnType<typeof useGroupOptions> }) {
  const course = olap.course ? Number(olap.course) : undefined;
  return <>
    <Select label="Курс" value={olap.course} all="Все" onChange={(v) => set({ course: v, group: "", pick: null })} options={groups.courses.map((c) => [String(c), `${c} курс`])} />
    <Select label="Группа" value={olap.group} all="Все" onChange={(v) => set({ group: v, pick: null })}
      options={groups.list.filter((g) => !course || Number(g.course) === course).map((g) => [s(g.group_name), s(g.group_name)])} />
  </>;
}

/** Процент с полоской под числом: зелёная — хорошо, красная — плохо (good = false — наоборот, меньше — лучше) */
export const Pct = ({ v, good = true }: { v: number | null | undefined; good?: boolean }) => (v == null ? <>—</>
  : <span className={`pct ${good ? (v >= 85 ? "ok" : v >= 65 ? "mid" : "bad") : (v <= 5 ? "ok" : v <= 15 ? "mid" : "bad")}`}>{v}%<i style={{ ["--w" as string]: `${v}%` }} /></span>);

/** Карточка студента по клику на строку (как olapOpenStudent в макете); у преподавателя строки не раскрываются */
export function useStudentCard() {
  const { role } = useAuth();
  const [card, setCard] = useState<{ student_id: number; student: string } | null>(null);
  const open = role === "teacher" ? undefined : (r: { student_id: number; student: string }) => setCard({ student_id: r.student_id, student: r.student });
  const node = card && <StudentCard studentId={card.student_id} title={card.student} onClose={() => setCard(null)} />;
  return { open, node };
}
