import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, ErrorNote, useToast } from "../ui";
import { Icon } from "../Icon";
import { LookupSelect } from "./fields";
import { newKey } from "../../api/client";
import { runWorkflow, type Row } from "../../api/resources";
import { errorText, requestIdOf } from "../../api/errors";
import { fmtDate } from "../../lib/format";
import type { WfDef, WfField } from "../../pages/students/studentActions";

interface Props {
  def: WfDef;
  studentId?: number;
  subtitle?: string;
  onClose: () => void;
}

// Форма приказа: один ключ идемпотентности на открытие окна — повторное нажатие не создаст второй приказ
export function WorkflowDialog({ def, studentId, subtitle, onClose }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const idemKey = useMemo(newKey, []);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body: Row = studentId ? { student_id: studentId } : {};
      for (const f of def.fields) {
        const v = values[f.name]?.trim();
        if (v) body[f.name] = f.kind === "employee" ? Number(v) : v;
      }
      const res = await runWorkflow<Row>(def.name, body, idemKey);
      qc.invalidateQueries({ queryKey: ["res"] });
      qc.invalidateQueries({ queryKey: ["lookup"] });
      qc.invalidateQueries({ queryKey: ["row"] });
      toast(res.status === "pending" ? `Приказ запланирован на ${fmtDate(res.effective_date)}` : "Приказ проведён");
      onClose();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  }

  const set = (n: string) => (v: string) => setValues((s) => ({ ...s, [n]: v }));

  return (
    <Modal onClose={onClose} label={def.title}>
      <form className="dialog form-dialog" onSubmit={submit}>
        <div className="form-head">
          <span className="dialog-ico"><Icon name="file" /></span>
          <div><h3>{def.title}</h3>{subtitle && <p>{subtitle}</p>}</div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="form-grid">
          {def.fields.map((f) => <WfInput key={f.name} f={f} value={values[f.name] ?? ""} onChange={set(f.name)} disabled={busy} />)}
        </div>
        {!!err && <ErrorNote text={errorText(err)} requestId={requestIdOf(err)} />}
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Отменить</button>
          <button className="btn primary" disabled={busy}>{busy ? "Проводим…" : def.confirm}</button>
        </div>
      </form>
    </Modal>
  );
}

function WfInput({ f, value, onChange, disabled }: { f: WfField; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const id = `wf-${f.name}`;
  let input;
  switch (f.kind) {
    case "group":
      input = <LookupSelect id={id} table="study_group" column="group_id" byLabel value={value} onChange={onChange} disabled={disabled}
        required={f.required} filter={(o) => !o.row.is_archived} />;
      break;
    case "funding":
      input = <LookupSelect id={id} table="funding_type" column="funding_type_id" byLabel value={value} onChange={onChange} disabled={disabled} required={f.required} />;
      break;
    case "leave_reason":
      input = <LookupSelect id={id} table="leave_reason" column="reason_id" byLabel value={value} onChange={onChange} disabled={disabled} required={f.required} />;
      break;
    case "employee":
      input = <LookupSelect id={id} table="employee" column="employee_id" value={value} onChange={onChange} disabled={disabled}
        required={f.required} filter={(o) => !o.row.dismissal_date} />;
      break;
    case "gender":
      input = (
        <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={f.required}>
          <option value="">—</option><option value="M">Мужской</option><option value="F">Женский</option>
        </select>
      );
      break;
    case "textarea":
      input = <textarea id={id} className="text-input textarea" rows={3} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={f.required} />;
      break;
    default:
      input = <input id={id} className="text-input" type={f.kind === "date" ? "date" : "text"} value={value}
        onChange={(e) => onChange(e.target.value)} disabled={disabled} required={f.required} />;
  }
  return (
    <div className={`field form-field${f.kind === "textarea" ? " wide" : ""}`}>
      <label htmlFor={id}>{f.label}{f.required && <i className="req" aria-label="обязательное">*</i>}</label>
      {input}
      {f.hint && <small className="hint">{f.hint}</small>}
    </div>
  );
}
