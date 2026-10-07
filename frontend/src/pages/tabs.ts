import type { IconName } from "../components/Icon";

export interface TabDef {
  id: string;
  path: string;
  title: string;
  short?: string;
  icon: IconName;
  /** Представление, из которого вкладка читает данные; нет его в /schema для роли — вкладка скрыта */
  view: string | null;
}

export const TABS: TabDef[] = [
  { id: "students", path: "/students", title: "Студенты", icon: "users", view: "v_student_summary" },
  { id: "groups", path: "/groups", title: "Группы", icon: "layers", view: "v_groups" },
  { id: "schedule", path: "/schedule", title: "Расписание", icon: "calendar", view: "v_schedule_calendar" },
  { id: "works", path: "/works", title: "Курсовые и ВКР", short: "КР и ВКР", icon: "cap", view: "v_academic_works" },
  { id: "requests", path: "/requests", title: "Заявки на справки", short: "Справки", icon: "file", view: "v_document_queue" },
  { id: "practice", path: "/practice", title: "Практики", icon: "briefcase", view: "v_practice" },
  { id: "employees", path: "/employees", title: "Сотрудники", icon: "badge", view: "v_employees" },
  { id: "olap", path: "/olap", title: "OLAP-анализ", short: "OLAP", icon: "chart", view: null },
];
