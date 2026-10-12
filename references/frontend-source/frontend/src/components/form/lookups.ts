// Как показывать связанные записи в выпадающих списках: значение (id) → понятная подпись
import { useQuery } from "@tanstack/react-query";
import { fetchAll, type Row } from "../../api/resources";
import { fmtTime } from "../../lib/format";

export interface Option { value: unknown; label: string; sub?: string; row: Row }

const s = (v: unknown) => (v == null ? "" : String(v));
const fio = (r: Row) => [r.last_name, r.first_name, r.middle_name].filter(Boolean).join(" ");
const index = (rows: Row[], key: string) => new Map(rows.map((r) => [r[key], r]));
const join = (...parts: unknown[]) => parts.filter((p) => p != null && p !== "").join(" · ");

export const KIND_NAME: Record<string, string> = {
  discipline: "дисциплина", coursework: "курсовая", practice: "практика", final_attestation: "ГИА / ВКР",
};

const LOOKUPS: Record<string, () => Promise<Option[]>> = {
  study_group: async () => (await fetchAll("study_group")).map((r) => ({ value: r.group_id, label: s(r.name), sub: r.is_archived ? "в архиве" : undefined, row: r })),
  teacher: async () => (await fetchAll("v_teachers")).map((r) => ({ value: r.employee_id, label: s(r.full_name), sub: join(r.position, r.department), row: r })),
  employee: async () => (await fetchAll("v_employees")).map((r) => ({ value: r.employee_id, label: s(r.full_name), sub: join(r.position, r.unit), row: r })),
  student: async () => (await fetchAll("v_students")).map((r) => ({ value: r.student_id, label: s(r.full_name), sub: join(r.group_name, r.record_book_number, r.status), row: r })),
  person: async () => (await fetchAll("person")).map((r) => ({ value: r.person_id, label: fio(r), sub: s(r.email) || undefined, row: r })),
  dean_office_staff: async () => {
    const [staff, emps] = await Promise.all([fetchAll("dean_office_staff"), fetchAll("v_employees")]);
    const byId = index(emps, "employee_id");
    return staff.map((r) => ({ value: r.employee_id, label: s(byId.get(r.employee_id)?.full_name ?? `Сотрудник ${r.employee_id}`), sub: s(byId.get(r.employee_id)?.position) || undefined, row: { ...byId.get(r.employee_id), ...r } }));
  },
  teaching_assignment: async () => (await fetchAll("v_schedule_hours")).map((r) => ({ value: r.assignment_id, label: join(r.group_name, r.discipline), sub: join(r.lesson_type, r.teacher), row: r })),
  curriculum_item: async () => (await fetchAll("v_curriculum")).map((r) => ({
    value: r.item_id, label: s(r.discipline),
    sub: join(`${r.semester} сем.`, KIND_NAME[s(r.kind)] ?? r.kind, r.control_type, `${r.specialty}, ${r.start_year}`), row: r,
  })),
  curriculum: async () => {
    const [cs, programs, specs, forms] = await Promise.all([fetchAll("curriculum"), fetchAll("study_program"), fetchAll("specialty"), fetchAll("study_form")]);
    const prog = index(programs, "program_id"), spec = index(specs, "specialty_id"), form = index(forms, "study_form_id");
    return cs.map((r) => {
      const p = prog.get(r.program_id), sp = p ? spec.get(p.specialty_id) : undefined;
      return { value: r.curriculum_id, label: join(sp ? `${sp.code} ${sp.name}` : `Программа ${r.program_id}`, r.start_year), sub: join(p?.profile, form.get(r.study_form_id)?.name), row: r };
    });
  },
  classroom: async () => (await fetchAll("classroom")).map((r) => ({ value: r.classroom_id, label: join(r.building, r.room_number), sub: join(r.capacity != null ? `${r.capacity} мест` : null, r.room_kind), row: r })),
  pair_time: async () => (await fetchAll("pair_time")).map((r) => ({ value: r.pair_number, label: `${r.pair_number} пара`, sub: `${fmtTime(r.start_time)}–${fmtTime(r.end_time)}`, row: r })),
  academic_term: async () => (await fetchAll("academic_term")).map((r) => ({ value: r.term_id, label: s(r.name), sub: `${s(r.start_date)} — ${s(r.end_date)}`, row: r })),
  organization_contact: async () => {
    const [cs, orgs] = await Promise.all([fetchAll("organization_contact"), fetchAll("organization")]);
    const org = index(orgs, "organization_id");
    return cs.map((r) => ({ value: r.org_contact_id, label: fio(r), sub: join(org.get(r.organization_id)?.name, r.job_title), row: r }));
  },
  academic_order: async () => (await fetchAll("academic_order")).map((r) => ({ value: r.order_id, label: s(r.order_number), sub: join(r.title, r.order_date), row: r })),
  position: async () => (await fetchAll("position")).map((r) => ({ value: r.position_id, label: s(r.title), row: r })),
};

// Запасной вариант для справочников: name / title / первое текстовое поле
async function generic(table: string, key: string): Promise<Option[]> {
  return (await fetchAll(table)).map((r) => {
    const text = r.name ?? r.title ?? Object.entries(r).find(([k, v]) => k !== key && typeof v === "string")?.[1];
    return { value: r[key], label: s(text ?? r[key]), row: r };
  });
}

export function useLookup(table: string | undefined, key: string | undefined) {
  return useQuery({
    queryKey: ["lookup", table],
    queryFn: () => (LOOKUPS[table!] ? LOOKUPS[table!]() : generic(table!, key!)),
    enabled: !!table,
    staleTime: 60_000,
  });
}
