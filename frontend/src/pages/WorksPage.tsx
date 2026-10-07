import { ResourceTablePage } from "./ResourceTablePage";
import { WORK_COLS } from "./columns";
import type { FormConfig } from "../components/form/RecordDialog";

const FORM: FormConfig = {
  order: ["student_id", "item_id", "topic", "supervisor_id", "reviewer_id", "order_id"],
  labels: { item_id: "Работа из учебного плана", order_id: "Приказ об утверждении темы" },
  // В списке — только курсовые и ВКР
  filters: { item_id: (o) => o.row.kind === "coursework" || o.row.kind === "final_attestation" },
};

export const WorksPage = () => (
  <ResourceTablePage id="works" title="Курсовые и ВКР" view="v_academic_works" table="academic_work" keyField="work_id"
    cols={WORK_COLS} form={FORM} newTitle="Новая работа" rowTitle={(r) => `${r.work_kind}: ${r.student}`} />
);
