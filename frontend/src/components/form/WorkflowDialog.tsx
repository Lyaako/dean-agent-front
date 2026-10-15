import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, CodedText, ErrorNote, UnsavedDialog, useToast } from "../ui";
import { Icon } from "../Icon";
import { LookupSelect } from "./fields";
import type { Option } from "./lookups";
import { useAuth } from "../../auth/AuthProvider";
import { getSigners } from "../../api/orders";
import { newKey } from "../../api/client";
import { runWorkflow, type Row } from "../../api/resources";
import { errorCode, errorField, errorText, requestIdOf } from "../../api/errors";
import { fmtDate } from "../../lib/format";
import type { WfDef, WfField } from "../../pages/students/studentActions";

interface Props {
  def: WfDef;
  studentId?: number;
  subtitle?: string;
  onClose: () => void;
}

// Повтор неизменённой попытки сохраняет ключ; исправленная форма получает новый.
export function WorkflowDialog({ def, studentId, subtitle, onClose }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const pending = useRef(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const [errors, setErrors] = useState<Record<string, ReactNode>>({});
  const [askUnsaved, setAskUnsaved] = useState(false);
  const dirty = Object.values(values).some((v) => v.trim() !== "");

  // Проверка до отправки: обязательные поля и порядок дат
  function validate() {
    const e: Record<string, ReactNode> = {};
    for (const f of def.fields) if (f.required && !values[f.name]?.trim()) e[f.name] = "Заполните поле";
    if (values.start && values.end && values.end < values.start) e.end = "Окончание не может быть раньше начала";
    setErrors(e);
    return !Object.keys(e).length;
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (pending.current) return;
    setAskUnsaved(false);
    if (!validate()) return;
    pending.current = true;
    setBusy(true);
    setErr(null);
    try {
      const body: Row = studentId ? { student_id: studentId } : {};
      for (const f of def.fields) {
        const v = values[f.name]?.trim();
        if (v) body[f.name] = f.kind === "employee" || f.kind === "signer" ? Number(v) : v;
      }
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) attempt.current = { body: serialized, key: newKey() };
      const res = await runWorkflow<Row>(def.name, body, attempt.current.key);
      qc.invalidateQueries({ queryKey: ["res"] });
      qc.invalidateQueries({ queryKey: ["lookup"] });
      qc.invalidateQueries({ queryKey: ["row"] });
      toast(res.status === "pending" ? `Приказ запланирован на ${fmtDate(res.effective_date)}` : "Приказ проведён");
      onClose();
    } catch (e2) {
      // Ошибка правила базы с полем (details.field) — под этим полем, остальные — внизу формы
      const field = errorField(e2, def.fields.map((f) => f.name));
      if (field) setErrors((e) => ({ ...e, [field]: <CodedText text={errorText(e2)} code={errorCode(e2)} /> }));
      else setErr(e2);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const requestClose = () => { if (pending.current) return; if (dirty) setAskUnsaved(true); else onClose(); };

  const set = (n: string) => (v: string) => {
    setErrors((e) => { const { [n]: _, ...rest } = e; return rest; });
    setValues((s) => ({ ...s, [n]: v }));
  };

  return (
    <Modal onClose={requestClose} label={def.title} outsideClose={false}>
      <form className="dialog form-dialog" onSubmit={submit} noValidate>
        <div className="form-head">
          <div><h3>{def.title}</h3>{subtitle && <p>{subtitle}</p>}</div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={requestClose}><Icon name="x" /></button>
        </div>
        <div className="form-body">
          <div className="form-grid">
            {def.fields.map((f) => <WfInput key={f.name} f={f} value={values[f.name] ?? ""} onChange={set(f.name)} disabled={busy} error={errors[f.name]} />)}
          </div>
          {!!err && <ErrorNote text={errorText(err)} requestId={requestIdOf(err)} code={errorCode(err)} />}
        </div>
        <div className="actions">
          <span className="spacer" />
          <button className="btn primary" disabled={busy}>{busy ? "Проводим…" : def.confirm}</button>
        </div>
      </form>
      {askUnsaved && (
        <UnsavedDialog title="Провести приказ?" text="Форма приказа заполнена, но приказ ещё не проведён." saveLabel={def.confirm}
          onSave={() => submit()} onDiscard={onClose} onCancel={() => setAskUnsaved(false)} />
      )}
    </Modal>
  );
}

function WfInput({ f, value, onChange, disabled, error }: { f: WfField; value: string; onChange: (v: string) => void; disabled: boolean; error?: ReactNode }) {
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
    case "signer":
      input = <SignerSelect id={id} value={value} onChange={onChange} disabled={disabled} required={f.required} />;
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
    <div className={`field form-field${f.kind === "textarea" ? " wide" : ""}${error ? " invalid" : ""}`}>
      <label htmlFor={id}>{f.label}{f.required && <i className="req" aria-label="обязательное">*</i>}</label>
      {input}
      {error ? <small className="field-error" role="alert">{error}</small> : f.hint && <small className="hint">{f.hint}</small>}
    </div>
  );
}

// «Подписал» — действующие директор и заместители института из /orders/signers (Р5): значение — employee_id,
// подпись — ФИО и должность, директор первым. У админа институтов несколько — список по каждому
function SignerSelect(props: { id: string; value: string; onChange: (v: string) => void; disabled: boolean; required?: boolean }) {
  const { me } = useAuth();
  const ids = me?.institute_ids ?? [];
  const signers = useQuery({
    queryKey: ["signers", ids],
    queryFn: async () => (await Promise.all(ids.map((i) => getSigners(i)))).flat(),
    enabled: ids.length > 0, staleTime: 60_000,
  });
  const data = signers.data?.map((s): Option => ({ value: s.employee_id, label: s.person, sub: s.position, row: s as unknown as Row }));
  return <LookupSelect {...props} source={{ data, isLoading: signers.isLoading, error: signers.error }} />;
}
