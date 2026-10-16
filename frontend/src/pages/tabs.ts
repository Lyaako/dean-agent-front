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

// Наборы вкладок по ролям — как в макете (mockup/redesign/roles.js, ROLES): у студента и преподавателя свои вкладки
const STAFF: Role[] = ["dean_staff", "director", "admin"];
const NOT_STUDENT: Role[] = [...STAFF, "teacher"];
const STUDENT: Role[] = ["student"];
const TEACHER: Role[] = ["teacher"];

export const TABS: TabDef[] = [
  { id: "students", path: "/students", title: "Студенты", icon: "users", view: "v_student_summary", roles: STAFF },
  { id: "groups", path: "/groups", title: "Группы", icon: "layers", view: "v_groups", roles: STAFF },
  { id: "schedule", path: "/schedule", title: "Расписание", icon: "calendar", view: "v_schedule_calendar" },
  { id: "grades", path: "/grades", title: "Успеваемость", short: "Оценки", icon: "award", view: "v_last_result", roles: STUDENT },
  { id: "myattendance", path: "/my-attendance", title: "Посещаемость", short: "Посещения", icon: "done", view: "v_attendance", roles: STUDENT },
  { id: "myrequests", path: "/my-requests", title: "Справки", icon: "file", view: "document_request", roles: STUDENT },
  { id: "mystudy", path: "/my-study", title: "Моя учёба", short: "Учёба", icon: "briefcase", view: "v_student_summary", roles: STUDENT },
  { id: "sheets", path: "/sheets", title: "Ведомости", icon: "edit", view: "grade_sheet", roles: ["dean_staff", "director", "teacher", "admin"] },
  { id: "attendance", path: "/attendance", title: "Посещаемость", short: "Посещения", icon: "done", view: "v_attendance", roles: ["teacher"] },
  { id: "mystudents", path: "/my-students", title: "Мои студенты", short: "Студенты", icon: "users", view: "v_student_summary", roles: TEACHER },
  { id: "myworks", path: "/my-works", title: "Курсовые и ВКР", short: "КР и ВКР", icon: "cap", view: "v_academic_works", roles: TEACHER },
  { id: "works", path: "/works", title: "Курсовые и ВКР", short: "КР и ВКР", icon: "cap", view: "v_academic_works", roles: STAFF },
  { id: "requests", path: "/requests", title: "Заявки на справки", short: "Справки", icon: "file", view: "v_document_queue", roles: STAFF },
  { id: "practice", path: "/practice", title: "Практики", icon: "briefcase", view: "v_practice", roles: STAFF },
  { id: "employees", path: "/employees", title: "Сотрудники", icon: "badge", view: "v_employees", roles: STAFF },
  { id: "olap", path: "/olap", title: "OLAP-анализ", short: "OLAP", icon: "chart", view: null, roles: NOT_STUDENT },
  { id: "users", path: "/users", title: "Пользователи", short: "Доступ", icon: "users", view: "app_user", roles: ["admin"] },
  { id: "refs", path: "/refs", title: "Справочники", short: "Списки", icon: "list", view: null, roles: ["admin"] },
  // Журнал отдаёт GET /audit, а не ресурс схемы — видимость задают только роли (Р6)
  { id: "audit", path: "/audit", title: "Журнал изменений", short: "Журнал", icon: "clock", view: null, roles: ["dean_staff", "director", "admin"] },
  // Согласование — у всех ролей; кого что видно, решает сервер (box=incoming|mine|completed)
  { id: "approvals", path: "/approvals", title: "Согласование", short: "Согласов.", icon: "check", view: null },
];
