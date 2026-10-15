import { useEffect, useRef, useState } from "react";
import { ResourceTablePage } from "../ResourceTablePage";
import { STUDENT_COLS } from "../columns";
import { ENROLL, STUDENT_ACTIONS, type WfDef } from "./studentActions";
import { WorkflowDialog } from "../../components/form/WorkflowDialog";
import { Icon } from "../../components/Icon";
import { useCan } from "../../api/schema";
import type { FormConfig } from "../../components/form/RecordDialog";
import type { Row } from "../../api/resources";
import { fetchAll } from "../../api/resources";
import { cancelStudentOrder } from "../../api/orders";
import { errorCode, errorText } from "../../api/errors";
import { Badge, ConfirmDialog, useToast } from "../../components/ui";
import { ApiError } from "../../api/client";
import { fmtDate, plural } from "../../lib/format";
import { useQuery, useQueryClient } from "@tanstack/react-query";

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
        dialogExtra={canOrders ? (viewRow) => () => <OrdersMenu student={viewRow} /> : undefined}
        dialogTop={canOrders ? (viewRow) => <PendingOrder student={viewRow} /> : undefined} />
      {enroll && <WorkflowDialog def={ENROLL} onClose={() => setEnroll(false)} />}
    </>
  );
}

// Запланированный (ещё не исполненный) приказ студента — из v_pending_orders (Р7). У студента он не больше одного
interface Pending { order_number: string; order_type: string; order_type_code: string; due_date: string; days_left: number }
const usePendingOrder = (studentId: number) => useQuery({
  queryKey: ["pending-order", studentId],
  queryFn: async () => ((await fetchAll("v_pending_orders", { student_id: studentId }))[0] ?? null) as unknown as Pending | null,
});
const inDays = (n: number) => (n <= 0 ? "сегодня" : n === 1 ? "завтра" : `через ${n} ${plural(n, "день", "дня", "дней")}`);

function PendingOrder({ student }: { student: Row }) {
  const id = Number(student.student_id);
  const { data: o } = usePendingOrder(id);
  const qc = useQueryClient();
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef<string | undefined>(undefined);
  if (!o) return null;
  const enroll = o.order_type_code === "enroll";
  const refresh = () => Promise.all(["pending-order", "res", "row"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  async function cancel() {
    setBusy(true); setErr(null);
    try {
      key.current ??= crypto.randomUUID();      // повтор после сбоя сети — с тем же ключом
      await cancelStudentOrder(o!.order_number, id, key.current);
      key.current = undefined;
      setAsk(false);
      toast("Приказ отменён");
      await refresh();                            // статуса «Отменён» нет — приказ просто пропадает из списка
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) key.current = undefined;
      if (e instanceof ApiError && (e.code === "order_not_pending" || e.code === "order_cancel_enrollment")) {
        setAsk(false); toast(errorText(e), true); await refresh();
      } else setErr(errorText(e) + (errorCode(e) ? ` · ${errorCode(e)}` : ""));
    } finally { setBusy(false); }
  }
  return (
    <div className="form-note order-note">
      <Badge kind="warn">Запланирован</Badge>
      <span className="order-text">приказ № {o.order_number} «{o.order_type}» на {fmtDate(o.due_date)}, {inDays(o.days_left)}{enroll ? ". Зачисление отменяется удалением студента" : ""}</span>
      {!enroll && <button type="button" className="btn sm ghost" onClick={() => setAsk(true)}>Отменить приказ</button>}
      {ask && <ConfirmDialog title="Отменить приказ?" text={`Приказ № ${o.order_number} будет отменён для этого студента.`} confirm="Отменить приказ"
        danger busy={busy} error={err} onCancel={() => { setAsk(false); setErr(null); }} onConfirm={cancel} />}
    </div>
  );
}

function OrdersMenu({ student }: { student: Row }) {
  const [open, setOpen] = useState(false);
  // Как в базе: у студента не больше одного запланированного приказа
  const pending = !!usePendingOrder(Number(student.student_id)).data;
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
      <button type="button" className="btn soft" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        disabled={pending} title={pending ? "Сначала дождитесь исполнения или отмените приказ" : undefined}>
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
