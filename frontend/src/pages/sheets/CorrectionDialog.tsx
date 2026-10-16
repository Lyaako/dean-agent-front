import { useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CodedText, ErrorNote, Modal, Seg, useToast } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { ApiError } from "../../api/client";
import { errorCode, errorText, requestIdOf } from "../../api/errors";
import { requestCorrection, resultText, useScale, type RosterRow, type Sheet } from "../../api/sheets";
import { ptsError, RES_MODES, type Mode } from "./result";

/* ── Заявка на исправление оценки в закрытой ведомости (Б5): решает директор или заместитель в «Согласовании».
   Основание — 10–2000 символов. Как в базе: при одобрении оценка должна быть той же, что при подаче ── */
const REASON_MIN = 10, REASON_MAX = 2000;

const modeOfGrade = (r: RosterRow): Mode => (r.grade?.is_absent ? "absent" : r.grade?.points != null ? "points" : "na");

export function CorrectionDialog({ sheet, row, onClose }: { sheet: Sheet; row: RosterRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const scale = useScale();
  const curMode = modeOfGrade(row);
  // По умолчанию — другой вид результата, чем сейчас: баллы, если их нет, иначе «не аттестован»
  const [mode, setMode] = useState<Mode>(curMode === "points" ? "na" : "points");
  const [pts, setPts] = useState("");
  const [reason, setReason] = useState("");
  const [errs, setErrs] = useState<{ pts?: ReactNode; res?: string; reason?: ReactNode }>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef<{ body: string; key: string } | null>(null);

  const label = (p: number | null, absent: boolean, na: boolean) => {
    const [t] = resultText(sheet, scale.data, p, absent, na);
    return p != null ? `${p} · ${t}` : t;
  };
  const current = label(row.grade?.points ?? null, !!row.grade?.is_absent, true);

  async function send() {
    if (busy) return;
    const r = reason.trim();
    const e: typeof errs = {};
    if (mode === "points" && pts === "") e.pts = "Введите баллы";
    else if (mode === "points" && ptsError(pts)) e.pts = ptsError(pts);
    else if (mode === curMode && (mode !== "points" || Number(pts) === row.grade?.points)) e.res = "Новый результат совпадает с текущим";
    if (r.length < REASON_MIN) e.reason = `Не короче ${REASON_MIN} символов`;
    setErrs(e); setFailure(null);
    if (Object.keys(e).length) return;
    const body = { sheet_id: sheet.sheet_id, student_id: row.student_id, new_points: mode === "points" ? Number(pts) : null, new_is_absent: mode === "absent", reason: r };
    // Повтор того же тела после сбоя сети — с тем же ключом, новое тело — новый ключ
    const serialized = JSON.stringify(body);
    if (key.current?.body !== serialized) key.current = { body: serialized, key: crypto.randomUUID() };
    setBusy(true);
    try {
      await requestCorrection(body, key.current.key);
      key.current = null;
      void qc.invalidateQueries({ queryKey: ["proposals"] });
      toast("Заявка отправлена директору");
      onClose();
    } catch (ex) {
      if (ex instanceof ApiError && ex.status < 500) key.current = null;
      const field = ex instanceof ApiError ? (ex.details as { field?: unknown } | null)?.field : undefined;
      const coded = <CodedText text={errorText(ex, "grade_correction")} code={errorCode(ex)} />;
      if (ex instanceof ApiError && ex.code === "validation_error" && field === "reason") setErrs({ reason: `От ${REASON_MIN} до ${REASON_MAX} символов` });
      else if (ex instanceof ApiError && (ex.code === "points_out_of_scale" || ex.code === "correction_stale")) setErrs({ pts: coded });
      else setFailure(ex);
    } finally { setBusy(false); }
  }

  return (
    <Modal onClose={() => { if (!busy) onClose(); }} outsideClose={!reason.trim() && !pts} label="Запросить исправление">
      <div className="dialog form-dialog">
        <div className="form-head">
          <div><h3>Запросить исправление</h3><p>{row.student} · {sheet.discipline} · ведомость {sheet.sheet_number}</p></div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose} disabled={busy}><Icon name="x" /></button>
        </div>
        <div className="form-body">
          <div className="field"><span>Текущий результат</span><b className="cur-res">{current}</b></div>
          <div className={`field form-field${errs.res ? " invalid" : ""}`}>
            <span>Новый результат</span>
            <div className="fix-res">
              <Seg value={mode} options={RES_MODES} disabled={busy} label="Новый результат"
                onChange={(m) => { setMode(m); if (m !== "points") setPts(""); setErrs({}); }} />
              <div className={errs.pts ? "form-field invalid" : undefined}>
                <input className="text-input pts" type="number" min={25} max={54} step={1} inputMode="numeric" aria-label="Новые баллы"
                  value={pts} disabled={mode !== "points" || busy}
                  onChange={(e) => { setPts(e.target.value.trim()); setErrs(({ pts: _, res: __, ...rest }) => rest); }} />
                {errs.pts && <small className="field-error" role="alert">{errs.pts}</small>}
              </div>
            </div>
            {errs.res && <small className="field-error" role="alert">{errs.res}</small>}
          </div>
          <div className={`field form-field${errs.reason ? " invalid" : ""}`}>
            <label htmlFor="fix-reason">Основание</label>
            <textarea id="fix-reason" className="text-input textarea" rows={3} maxLength={REASON_MAX} disabled={busy} value={reason}
              placeholder="Например: ошибка при переносе баллов из протокола экзамена"
              onChange={(e) => { setReason(e.target.value); setErrs(({ reason: _, ...rest }) => rest); }} />
            {errs.reason ? <small className="field-error" role="alert">{errs.reason}</small>
              : <small className="hint">От {REASON_MIN} до {REASON_MAX} символов. Заявку рассмотрит директор или заместитель директора</small>}
          </div>
          {failure != null && <ErrorNote text={errorText(failure, "grade_correction")} requestId={requestIdOf(failure)} code={errorCode(failure)} />}
        </div>
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Отменить</button>
          <button type="button" className="btn primary" onClick={send} disabled={busy}>{busy ? "Отправляем…" : "Отправить директору"}</button>
        </div>
      </div>
    </Modal>
  );
}
