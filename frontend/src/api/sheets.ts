// Ведомости (grade_sheet) и оценки (grade). Представления ведомостей в базе нет — список собирается из
// grade_sheet + v_curriculum (дисциплина, семестр, форма контроля) + v_groups + v_teachers.
// Результат студента — строка grade: баллы 25–54, «не аттестован» (баллов нет, не неявка) или неявка.
// Строки grade нет — результат ещё не выставлен.
import { useQueries, useQuery } from "@tanstack/react-query";
import { fetchAll, createRow, updateRow, type Row } from "./resources";
import { api } from "./client";
import { todayIso } from "../lib/format";

export type Stage = "module_1" | "module_2" | "final";
export type SheetKind = "main" | "retake" | "commission" | "individual";
export type SheetStatus = "open" | "closed" | "cancelled";

export const STAGE_NAME: Record<Stage, string> = { module_1: "Модуль 1", module_2: "Модуль 2", final: "Итог" };
export const KIND_NAME: Record<SheetKind, string> = { main: "Основная", retake: "Пересдача", commission: "Комиссия", individual: "Индивидуальная" };
export const STATUS_NAME: Record<SheetStatus, string> = { open: "Открыта", closed: "Закрыта", cancelled: "Отменена" };

export interface Sheet {
  sheet_id: number;
  sheet_number: string;
  item_id: number;
  group_id: number;
  examiner_id: number;
  stage: Stage;
  sheet_kind: SheetKind;
  issue_date: string;
  exam_date: string | null;
  closed_date: string | null;
  status: SheetStatus;
  // Из справочников
  group_name: string;
  discipline: string;
  semester: number | null;
  control_type: string;
  examiner: string;
}

export interface Grade { grade_id: number; sheet_id: number; student_id: number; points: number | null; is_absent: boolean }

export interface Student { student_id: number; student: string; group_name: string; active: boolean }

const str = (v: unknown) => (v == null ? "" : String(v));

async function loadSheets(): Promise<Sheet[]> {
  const [sheets, items, groups, teachers] = await Promise.all([
    fetchAll("grade_sheet"), fetchAll("v_curriculum"), fetchAll("v_groups"), fetchAll("v_teachers"),
  ]);
  const item = new Map(items.map((r) => [Number(r.item_id), r]));
  const group = new Map(groups.map((r) => [Number(r.group_id), str(r.group_name)]));
  const teacher = new Map(teachers.map((r) => [Number(r.employee_id), str(r.full_name)]));
  return sheets.map((s) => {
    const ci = item.get(Number(s.item_id));
    return {
      ...(s as unknown as Sheet),
      group_name: group.get(Number(s.group_id)) ?? "",
      discipline: str(ci?.discipline),
      semester: ci?.semester == null ? null : Number(ci.semester),
      control_type: str(ci?.control_type),
      examiner: teacher.get(Number(s.examiner_id)) ?? "",
    };
  });
}

export const useSheets = () => useQuery({ queryKey: ["sheets"], queryFn: loadSheets });

// Студенты с признаком «обучается» (student_status.is_active): им ставят оценки, их ждёт основная ведомость
async function loadStudents(): Promise<Student[]> {
  const [rows, statuses] = await Promise.all([fetchAll("v_students"), fetchAll("student_status")]);
  const active = new Set(statuses.filter((s) => s.is_active).map((s) => str(s.name)));
  return rows.map((r) => ({ student_id: Number(r.student_id), student: str(r.full_name), group_name: str(r.group_name), active: active.has(str(r.status)) }));
}
export const useStudents = () => useQuery({ queryKey: ["sheet-students"], queryFn: loadStudents, staleTime: 60_000 });

// Шкала оценок (score_band) и формы контроля: для подписи результата, как fn_result_name
export const useScale = () => useQuery({
  queryKey: ["scale"], staleTime: Infinity,
  queryFn: async () => {
    const [bands, types] = await Promise.all([fetchAll("score_band"), fetchAll("control_type")]);
    return {
      bands: bands.map((b) => ({ min: Number(b.min_points), max: Number(b.max_points), name: str(b.mark_name), mark: Number(b.mark) })),
      graded: new Map(types.map((t) => [str(t.name), !!t.is_graded])),
    };
  },
});
export type Scale = NonNullable<ReturnType<typeof useScale>["data"]>;

const gradesKey = (sheetId: number) => ["grades", sheetId];
const loadGrades = async (sheetId: number) => (await fetchAll("grade", { sheet_id: sheetId })) as unknown as Grade[];
export const useGrades = (sheetId: number | null) =>
  useQuery({ queryKey: gradesKey(sheetId ?? 0), queryFn: () => loadGrades(sheetId!), enabled: sheetId != null });
// Оценки сразу нескольких ведомостей (открытые и попытки того же этапа) — каждая своим запросом, кэш общий с окном ведомости
export const useGradesOf = (ids: number[]) =>
  useQueries({ queries: ids.map((id) => ({ queryKey: gradesKey(id), queryFn: () => loadGrades(id) })) });

/* ── Кто в ведомости ── */
// Попытки того же этапа дисциплины у этой группы: строка плана, группа и этап совпадают; отменённые не считаются
export const attemptsOf = (sheet: Sheet, all: Sheet[]) =>
  all.filter((s) => s.sheet_id !== sheet.sheet_id && s.group_id === sheet.group_id && s.item_id === sheet.item_id && s.stage === sheet.stage && s.status !== "cancelled");

export interface RosterRow { student_id: number; student: string; active: boolean; grade: Grade | null }

interface RosterItem { student_id: number; student: string; active: boolean; grade_id: number | null; points: number | null; is_absent: boolean }

/** Состав ведомости считает сервер по правилам базы (trg_grade_check / trg_sheet_status), GET …/grade_sheet/{id}/roster:
 *  закрытая или отменённая — студенты с оценкой; открытая основная — обучающиеся студенты группы и все с оценкой;
 *  открытая пересдача, комиссия, индивидуальная — с оценкой и обучающиеся, кого база разрешает внести (несданная попытка этапа
 *  по дисциплине в другой ведомости, нет оценки в другой открытой). grade_id = null — результата ещё нет */
const rosterKey = (sheetId: number) => ["roster", sheetId];
const loadRoster = async (sheetId: number): Promise<RosterRow[]> =>
  (await api<{ items: RosterItem[] }>(`/resources/grade_sheet/${sheetId}/roster`)).items.map((r) => ({
    student_id: r.student_id, student: r.student, active: r.active,
    grade: r.grade_id == null ? null : { grade_id: r.grade_id, sheet_id: sheetId, student_id: r.student_id, points: r.points, is_absent: r.is_absent },
  }));
export const useRoster = (sheetId: number) => useQuery({ queryKey: rosterKey(sheetId), queryFn: () => loadRoster(sheetId) });
export const useRosters = (ids: number[]) =>
  useQueries({ queries: ids.map((id) => ({ queryKey: rosterKey(id), queryFn: () => loadRoster(id) })) });

/** Кандидаты в пересдачу из закрытой ведомости: обучающиеся без аттестации, которые не сдали этап в другой попытке
 *  и ещё не внесены в открытую ведомость этого этапа */
export function retakeCandidates(rows: RosterRow[], attempts: { sheet: Sheet; grades: Grade[] | undefined }[]) {
  if (attempts.some((a) => !a.grades)) return [];
  const blocked = new Set<number>();
  for (const a of attempts) for (const g of a.grades!) if (g.points != null || a.sheet.status === "open") blocked.add(g.student_id);
  return rows.filter((r) => r.active && r.grade && r.grade.points == null && !blocked.has(r.student_id));
}

/* ── Результат: как fn_result_name ── */
export type Kind = "ok" | "info" | "bad" | "";
export function resultText(sheet: Sheet, scale: Scale | undefined, points: number | null, absent: boolean, na: boolean): [string, Kind] {
  if (absent) return ["Неявка", "bad"];
  const graded = scale?.graded.get(sheet.control_type) ?? true;
  if (points == null) {
    if (sheet.status !== "closed" && !na) return ["—", ""];
    if (sheet.stage !== "final") return ["Не аттестован", "bad"];
    return [graded ? "Неудовлетворительно" : "Не зачтено", "bad"];
  }
  if (sheet.stage !== "final") return points >= 25 ? ["Аттестован", "ok"] : ["Не аттестован", "bad"];
  if (!graded) return points >= 25 ? ["Зачтено", "ok"] : ["Не зачтено", "bad"];
  const band = scale?.bands.find((b) => points >= b.min && points <= b.max);
  if (!band) return ["Неудовлетворительно", "bad"];
  return [band.name, band.mark === 5 ? "ok" : "info"];
}

/* ── Запись ── */
export const saveGrade = (sheetId: number, studentId: number, gradeId: number | null, points: number | null, isAbsent: boolean) =>
  gradeId == null
    ? createRow("grade", { sheet_id: sheetId, student_id: studentId, points, is_absent: isAbsent })
    : updateRow("grade", { grade_id: gradeId }, { points, is_absent: isAbsent });

// Закрытие: статус, дата экзамена и дата закрытия (сегодня). Обратно открыть нельзя
export const closeSheet = (sheetId: number, examDate: string) =>
  updateRow("grade_sheet", { sheet_id: sheetId }, { status: "closed", exam_date: examDate, closed_date: todayIso() });

// Номер пересдачи: номер исходной ведомости, последняя часть — «П1», «П2»… (у модулей — «М1П1»)
export function retakeNumber(sheet: Sheet, all: Sheet[]) {
  const n = attemptsOf(sheet, all).filter((s) => s.sheet_kind === "retake").length + 1;
  const base = sheet.sheet_number.replace(/\/[^/]*$/, "");
  const suffix = sheet.stage === "final" ? `П${n}` : `${sheet.stage === "module_1" ? "М1" : "М2"}П${n}`;
  return `${base}/${suffix}`.slice(0, 20);
}

export const createRetake = (sheet: Sheet, all: Sheet[]) => createRow("grade_sheet", {
  sheet_number: retakeNumber(sheet, all), item_id: sheet.item_id, group_id: sheet.group_id, examiner_id: sheet.examiner_id,
  stage: sheet.stage, sheet_kind: "retake", issue_date: todayIso(),
}) as Promise<Row>;
