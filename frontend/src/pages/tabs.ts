import type { IconName } from "../components/Icon";
import type { Role } from "../api/auth";

export interface TabDef {
  id: string;
  path: string;
  title: string;
  short?: string;
  icon: IconName;
  /** Представление, из которого вкладка читает данные; нет его в /schema для роли — вкладка скрыта */
  view: string | null;
  /** Роли, которым вкладка нужна (как в макете, mockup/redesign/roles.js); нет — всем, кто читает view */
  roles?: Role[];
}

// Студенту — свои вкладки (mockup/redesign/roles.js, ROLES.student); вкладки сотрудников ему не нужны
const NOT_STUDENT: Role[] = ["dean_staff", "director", "admin", "teacher"];
const STUDENT: Role[] = ["student"];

export const TABS: TabDef[] = [
  { id: "students", path: "/students", title: "Студенты", icon: "users", view: "v_student_summary", roles: NOT_STUDENT },
  { id: "groups", path: "/groups", title: "Группы", icon: "layers", view: "v_groups", roles: NOT_STUDENT },
  { id: "schedule", path: "/schedule", title: "Расписание", icon: "calendar", view: "v_schedule_calendar" },
  { id: "grades", path: "/grades", title: "Успеваемость", short: "Оценки", icon: "award", view: "v_last_result", roles: STUDENT },
  { id: "myattendance", path: "/my-attendance", title: "Посещаемость", short: "Посещения", icon: "done", view: "v_attendance", roles: STUDENT },
  { id: "myrequests", path: "/my-requests", title: "Справки", icon: "file", view: "document_request", roles: STUDENT },
  { id: "mystudy", path: "/my-study", title: "Моя учёба", short: "Учёба", icon: "briefcase", view: "v_student_summary", roles: STUDENT },
  { id: "sheets", path: "/sheets", title: "Ведомости", icon: "edit", view: "grade_sheet", roles: ["dean_staff", "director", "teacher", "admin"] },
  { id: "attendance", path: "/attendance", title: "Посещаемость", short: "Посещения", icon: "done", view: "v_attendance", roles: ["teacher"] },
  { id: "works", path: "/works", title: "Курсовые и ВКР", short: "КР и ВКР", icon: "cap", view: "v_academic_works", roles: NOT_STUDENT },
  { id: "requests", path: "/requests", title: "Заявки на справки", short: "Справки", icon: "file", view: "v_document_queue", roles: NOT_STUDENT },
  { id: "practice", path: "/practice", title: "Практики", icon: "briefcase", view: "v_practice", roles: NOT_STUDENT },
  { id: "employees", path: "/employees", title: "Сотрудники", icon: "badge", view: "v_employees", roles: NOT_STUDENT },
  { id: "olap", path: "/olap", title: "OLAP-анализ", short: "OLAP", icon: "chart", view: null, roles: NOT_STUDENT },
  // Журнал отдаёт GET /audit, а не ресурс схемы — видимость задают только роли (Р6)
  { id: "audit", path: "/audit", title: "Журнал изменений", short: "Журнал", icon: "clock", view: null, roles: ["dean_staff", "director", "admin"] },
];
