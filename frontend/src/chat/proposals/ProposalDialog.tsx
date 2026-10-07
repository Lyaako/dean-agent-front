// ВРЕМЕННЫЙ внешний вид окна «разрешить / отклонить» — окно «было → стало» из макета.
// Финальный вариант будет по шаблону из другого проекта: меняется только этот файл, логика — в useProposal.
import { Icon } from "../../components/Icon";
import { Badge, ErrorNote, Modal } from "../../components/ui";
import { REASON_MIN, TABLE_NAME, useProposal } from "./useProposal";
import { useLookup } from "../../components/form/lookups";
import type { FieldSpec } from "../../api/schema";

const STATUS: Record<string, [string, string]> = {
  pending: ["Ждёт решения", "info"], approved: ["Применено", "ok"], rejected: ["Отклонено", "muted"],
};
const show = (v: unknown) => (v == null || v === "" ? "—" : typeof v === "boolean" ? (v ? "да" : "нет") : String(v));

// Ссылка на другую таблицу показывается её названием, а не id
function Value({ v, spec }: { v: unknown; spec?: FieldSpec }) {
  const rel = spec?.relation;
  const { data } = useLookup(rel?.table, rel?.column);
  const o = rel && v != null ? data?.find((x) => String(x.value) === String(v)) : undefined;
  return <>{o ? o.label : show(v)}</>;
}

export function ProposalDialog({ id, onClose, onDecided }: { id: string; onClose: () => void; onDecided?: (s: "approved" | "rejected") => void }) {
  const m = useProposal(id, onDecided);
  const p = m.proposal;
  const st = p ? STATUS[p.status] : null;

  return (
    <Modal onClose={onClose} label="Изменение от агента">
      <div className="dialog proposal-dialog">
        <div className="form-head">
          <span className="dialog-ico"><Icon name="sparkle" /></span>
          <div>
            <h3>{p?.status === "pending" || !p ? "Применить изменения?" : "Изменение от агента"}</h3>
            <p>{p?.explanation || "Агент подготовил изменение. Пока вы его не примените, в базе ничего не меняется."}</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="x" /></button>
        </div>

        {m.loading ? <div className="skel" style={{ height: 140 }} />
          : m.loadError ? <p className="form-error">{m.loadError}</p>
          : p && (
            <div className={`diff${p.status === "approved" ? " applied" : ""}`}>
              <div className="entity">
                <b>{m.operation === "INSERT" ? "Новая запись" : "Изменение записи"}</b>
                <small>{TABLE_NAME[m.tableName ?? ""] ?? m.tableName}</small>
                {st && <Badge kind={st[1]}>{st[0]}</Badge>}
              </div>
              {m.rows.map((r, i) => (
                <div key={r.field} className="diff-row" style={{ ["--i" as string]: i }}>
                  <span className="k">{r.label}</span>
                  <span className="old"><Value v={r.before} spec={r.spec} /></span>
                  <span className="to"><Icon name="arrow" /></span>
                  <span className="new"><Value v={r.after} spec={r.spec} /></span>
                </div>
              ))}
              {p.preview.related_effects.length > 0 && (
                <ul className="effects">{p.preview.related_effects.map((e, i) => <li key={i}>{e}</li>)}</ul>
              )}
              {p.preview.note && <small className="hint">{p.preview.note}</small>}
              {p.reason && <small className="hint">Основание агента: {p.reason}</small>}
              {p.decision_reason && <small className="hint">Комментарий к решению: {p.decision_reason}</small>}
            </div>
          )}

        {m.canDecide && (
          <label className="field">
            <span>Комментарий к решению (не короче {REASON_MIN} символов)</span>
            <textarea className="text-input textarea" rows={2} value={m.reason} onChange={(e) => m.setReason(e.target.value)}
              placeholder="Например: подтверждаю по заявлению студента" maxLength={2000} />
          </label>
        )}
        {p && p.status === "pending" && !m.canDecide && <p className="hint">Решение принимает сотрудник деканата.</p>}
        {m.error && <ErrorNote text={m.error.text} requestId={m.error.requestId} />}

        <div className="actions">
          {m.canDecide ? (
            <>
              <button className="btn ghost danger-text" onClick={m.reject} disabled={!m.reasonOk || !!m.busy}>{m.busy === "reject" ? "Отклоняем…" : "Отклонить"}</button>
              <span className="spacer" />
              <button className="btn" onClick={onClose}>Позже</button>
              <button className="btn primary" onClick={m.approve} disabled={!m.reasonOk || !!m.busy}>{m.busy === "approve" ? "Применяем…" : "Применить изменения"}</button>
            </>
          ) : <><span className="spacer" /><button className="btn" onClick={onClose}>Закрыть</button></>}
        </div>
      </div>
    </Modal>
  );
}
