import { ResourceTablePage } from "./ResourceTablePage";
import { PRACTICE_COLS } from "./columns";
import type { FormConfig } from "../components/form/RecordDialog";

const FORM: FormConfig = {
  order: ["student_id", "item_id", "supervisor_id", "org_contact_id", "start_date", "end_date", "order_id"],
  labels: { item_id: "Практика из учебного плана", org_contact_id: "Руководитель от организации" },
  lockOnEdit: ["student_id"],
  checks: (v) => ({ end_date: v.start_date && v.end_date && v.end_date < v.start_date ? "Окончание не может быть раньше начала" : undefined }),
  filters: { item_id: (o) => o.row.kind === "practice" },
};

export const PracticePage = () => (
  <ResourceTablePage id="practice" title="Практики" view="v_practice" table="practice_placement" keyField="placement_id"
    cols={PRACTICE_COLS} form={FORM} newTitle="Направление на практику" rowTitle={(r) => `${r.practice}: ${r.student}`} />
);
