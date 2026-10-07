// Колонки таблиц — как в представлениях БД и в макете (mockup/redesign/index.html)
import type { Row } from "../api/resources";
import type { Column } from "../components/table/tableLogic";
import { Badge } from "../components/ui";
import { fmtDate, fmtDateTime, fmtNum, fmtTime, todayIso, yes } from "../lib/format";

const t = (v: unknown) => (v == null || v === "" ? "—" : String(v));

export const CATEGORY_KIND: Record<string, string> = {
  "Отличник": "ok", "Хорошист": "ok", "Есть тройки": "info", "Есть задолженности": "warn", "Кандидат на отчисление": "bad",
  "Академический отпуск": "muted", "Отчислен": "muted", "Выпускник": "muted", "Ещё не сдавал сессию": "info",
};
export const LESSON_KIND: Record<string, string> = { "Лекция": "info plain", "Практика": "violet plain", "Лабораторная": "warn plain" };
export const STATUS_KIND: Record<string, string> = { "Новая": "info", "В работе": "warn", "Готова к выдаче": "ok", "Выдана": "muted", "Отклонена": "bad" };
export const EMPLOYEE_CATEGORY: Record<string, string> = { administration: "Администрация", support: "Учебно-вспомогательный персонал", teaching: "Преподаватели" };
const FINAL_STATUS = ["Готова к выдаче", "Выдана", "Отклонена"];

export const STUDENT_COLS: Column<Row>[] = [
  { label: "ФИО", field: "student", filter: "text" },
  { label: "Зачётка", field: "record_book_number", filter: "text" },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Курс", field: "course", filter: "enum", className: "num" },
  { label: "Статус", field: "status", filter: "enum", className: "wrap-xs" },
  { label: "Основа", field: "funding", filter: "enum" },
  { label: "Ср. балл", field: "avg_points", filter: "num", className: "num" },
  { label: "Долги", field: "debts", filter: "num", className: "num", text: (r) => (r.debts ? String(r.debts) : "—"),
    render: (r) => (r.debts ? <span className="late">{String(r.debts)}</span> : "—") },
  { label: "Посещ., %", field: "attendance_pct", filter: "num", className: "num", text: (r) => fmtNum(r.attendance_pct, 1) },
  { label: "Стипендия", field: "scholarships", filter: "enum", className: "wrap-sm" },
  { label: "Староста", field: "is_headman", filter: "bool", text: (r) => yes(r.is_headman) },
  { label: "Иностранец", field: "is_foreign", filter: "bool", text: (r) => yes(r.is_foreign) },
  { label: "Общежитие", field: "needs_dormitory", filter: "bool", text: (r) => yes(r.needs_dormitory) },
  { label: "Категория", field: "category", filter: "enum", badge: true,
    render: (r) => <Badge kind={CATEGORY_KIND[String(r.category)]}>{t(r.category)}</Badge> },
];

export const GROUP_COLS: Column<Row>[] = [
  { label: "Группа", field: "group_name", filter: "enum", bold: true, render: (r) => <b>{t(r.group_name)}</b> },
  { label: "Направление", field: "specialty", filter: "enum" },
  { label: "Профиль", field: "profile", filter: "enum", className: "wrap" },
  { label: "Форма", field: "study_form", filter: "enum" },
  { label: "Год набора", field: "admission_year", filter: "enum", className: "num" },
  { label: "Курс", field: "course", filter: "enum", className: "num" },
  { label: "Семестр", field: "current_semester", filter: "enum", className: "num" },
  { label: "Куратор", field: "curator", filter: "enum" },
  { label: "Староста", field: "headman", filter: "text" },
  { label: "Студентов", field: "active_students", filter: "num", className: "num" },
  { label: "Из них бюджет", field: "budget_students", filter: "num", className: "num" },
];

export const SCHEDULE_COLS: Column<Row>[] = [
  { label: "Дата", field: "lesson_date", filter: "date" },
  { label: "День", field: "weekday_name", filter: "enum" },
  { label: "Пара", field: "pair_number", filter: "enum", className: "num" },
  { label: "Начало", field: (r) => fmtTime(r.start_time), filter: "enum" },
  { label: "Окончание", field: (r) => fmtTime(r.end_time), filter: "enum" },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Дисциплина", field: "discipline", filter: "enum" },
  { label: "Вид", field: "lesson_type", filter: "enum", badge: true,
    render: (r) => <Badge kind={LESSON_KIND[String(r.lesson_type)]}>{t(r.lesson_type)}</Badge> },
  { label: "Преподаватель", field: "teacher", filter: "enum" },
  { label: "Аудитория", field: "classroom", filter: "enum" },
  { label: "Подгруппа", field: "subgroup", filter: "enum", className: "num" },
  { label: "Неделя", field: "week", filter: "enum" },
];

export const WORK_COLS: Column<Row>[] = [
  { label: "Студент", field: "student", filter: "text" },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Вид работы", field: "work_kind", filter: "enum" },
  { label: "Дисциплина", field: "discipline", filter: "enum" },
  { label: "Семестр", field: "semester", filter: "enum", className: "num" },
  { label: "Тема", field: "topic", filter: "text", className: "wrap" },
  { label: "Руководитель", field: "supervisor", filter: "enum" },
  { label: "Рецензент", field: "reviewer", filter: "enum" },
  { label: "Приказ", field: "order_number", filter: "enum" },
];

const overdue = (r: Row) => !!r.due_date && String(r.due_date) < todayIso() && !FINAL_STATUS.includes(String(r.status));
export const REQUEST_COLS: Column<Row>[] = [
  { label: "№", field: "request_id", filter: "text" },
  { label: "Студент", field: "student", filter: "text" },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Документ", field: "document", filter: "enum" },
  { label: "Экз.", field: "copies", filter: "num", className: "num" },
  { label: "Цель", field: "purpose", filter: "enum" },
  { label: "Статус", field: "status", filter: "enum", badge: true, render: (r) => <Badge kind={STATUS_KIND[String(r.status)]}>{t(r.status)}</Badge> },
  { label: "Создана", field: "created_at", filter: "date", text: (r) => fmtDateTime(r.created_at) },
  { label: "Срок", field: "due_date", filter: "date",
    render: (r) => overdue(r) ? <span className="late" title="Просрочена">{fmtDate(r.due_date)}</span>
      : r.due_date === todayIso() && !FINAL_STATUS.includes(String(r.status)) ? <span className="soon" title="Срок сегодня">{fmtDate(r.due_date)}</span>
      : fmtDate(r.due_date) },
  { label: "Исполнитель", field: (r) => r.processed_by || null, filter: "enum" },
];

export const PRACTICE_COLS: Column<Row>[] = [
  { label: "Студент", field: "student", filter: "text" },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Практика", field: "practice", filter: "enum" },
  { label: "Семестр", field: "semester", filter: "enum", className: "num" },
  { label: "Организация", field: "organization", filter: "enum" },
  { label: "Руководитель от вуза", field: "supervisor", filter: "enum" },
  { label: "Руководитель от организации", field: "org_supervisor", filter: "enum" },
  { label: "Начало", field: "start_date", filter: "date" },
  { label: "Окончание", field: "end_date", filter: "date" },
  { label: "Приказ", field: "order_number", filter: "enum" },
];

export const EMPLOYEE_COLS: Column<Row>[] = [
  { label: "Таб. №", field: "personnel_number", filter: "text" },
  { label: "ФИО", field: "full_name", filter: "text" },
  { label: "Должность", field: "position", filter: "enum" },
  { label: "Категория", field: (r) => EMPLOYEE_CATEGORY[String(r.category)] ?? r.category, filter: "enum", className: "wrap-sm" },
  { label: "Подразделение", field: "unit", filter: "enum" },
  { label: "Ставка", field: "employment_rate", filter: "num", className: "num", text: (r) => fmtNum(r.employment_rate, 2) },
  { label: "Принят", field: "hire_date", filter: "date" },
  { label: "Уволен", field: "dismissal_date", filter: "date" },
];
