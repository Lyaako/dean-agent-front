import { ResourceTablePage } from "./ResourceTablePage";
import { EMPLOYEE_COLS } from "./columns";
import type { FormConfig } from "../components/form/RecordDialog";

const FORM: FormConfig = {
  order: ["person_id", "personnel_number", "position_id", "employment_rate", "hire_date", "dismissal_date"],
  labels: { person_id: "Человек" },
  // У созданного сотрудника человек не меняется — правится только его ФИО
  linked: { field: "person_id", table: "person", key: "person_id", fields: ["last_name", "first_name", "middle_name"] },
  checks: (v) => ({
    dismissal_date: v.dismissal_date && v.hire_date && v.dismissal_date < v.hire_date ? "Дата увольнения не может быть раньше даты приёма" : undefined,
  }),
};

export const EmployeesPage = () => (
  <ResourceTablePage id="employees" title="Сотрудники" view="v_employees" table="employee" keyField="employee_id"
    cols={EMPLOYEE_COLS} form={FORM} newTitle="Новый сотрудник" rowTitle={(r) => String(r.full_name)} />
);
