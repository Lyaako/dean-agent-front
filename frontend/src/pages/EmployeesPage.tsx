import { ResourceTablePage } from "./ResourceTablePage";
import { EMPLOYEE_COLS } from "./columns";
import type { FormConfig } from "../components/form/RecordDialog";

const FORM: FormConfig = {
  order: ["person_id", "personnel_number", "position_id", "employment_rate", "hire_date", "dismissal_date"],
  labels: { person_id: "Человек" },
  note: "Человек выбирается из уже внесённых в систему.",
};

export const EmployeesPage = () => (
  <ResourceTablePage id="employees" title="Сотрудники" view="v_employees" table="employee" keyField="employee_id"
    cols={EMPLOYEE_COLS} form={FORM} newTitle="Новый сотрудник" rowTitle={(r) => String(r.full_name)} />
);
