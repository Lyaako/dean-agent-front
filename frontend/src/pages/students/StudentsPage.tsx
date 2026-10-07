import { useEffect, useRef, useState } from "react";
import { ResourceTablePage } from "../ResourceTablePage";
import { STUDENT_COLS } from "../columns";
import { ENROLL, STUDENT_ACTIONS, type WfDef } from "./studentActions";
import { WorkflowDialog } from "../../components/form/WorkflowDialog";
import { Icon } from "../../components/Icon";
import { useCan } from "../../api/schema";
import type { FormConfig } from "../../components/form/RecordDialog";
import type { Row } from "../../api/resources";

// Напрямую у студента меняются только основа, общежитие и гражданство; остальное — приказами
const FORM: FormConfig = {
  order: ["funding_type_id", "needs_dormitory", "is_foreign"],
  note: "Группа и статус меняются приказом — кнопка «Приказ» внизу окна.",
};

export function StudentsPage() {
  const can = useCan();
  const [enroll, setEnroll] = useState(false);
  const canOrders = can("student", "workflow");
  return (
    <>
      <ResourceTablePage id="students" title="Студенты" view="v_student_summary" table="student" keyField="student_id"
        cols={STUDENT_COLS} form={canOrders ? FORM : { ...FORM, note: undefined }} newTitle="" rowTitle={(r) => String(r.student)}
        actions={canOrders && <button className="btn sm primary" onClick={() => setEnroll(true)}><Icon name="plus" />Зачислить</button>}
        dialogExtra={canOrders ? (viewRow) => () => <OrdersMenu student={viewRow} /> : undefined} />
      {enroll && <WorkflowDialog def={ENROLL} onClose={() => setEnroll(false)} />}
    </>
  );
}

function OrdersMenu({ student }: { student: Row }) {
  const [open, setOpen] = useState(false);
  const [def, setDef] = useState<WfDef | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const status = String(student.status ?? "");
  const actions = STUDENT_ACTIONS.filter((a) => !a.when || a.when(status));
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="btn soft" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="file" />Приказ<Icon name="down" />
      </button>
      {open && (
        <div className="menu up" role="menu">
          {actions.map((a) => (
            <button key={a.name} type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); setDef(a); }}>
              <span>{a.title}</span>
            </button>
          ))}
        </div>
      )}
      {def && <WorkflowDialog def={def} studentId={Number(student.student_id)} subtitle={`${student.student} · ${student.group_name}`} onClose={() => setDef(null)} />}
    </div>
  );
}
