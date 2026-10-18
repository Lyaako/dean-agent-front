import { useState } from "react";
import { Icon } from "../../components/Icon";
import { Badge, ErrorNote, Modal } from "../../components/ui";
import { REASON_MIN, TABLE_NAME, useProposal } from "./useProposal";
import { prefillChat } from "../../lib/chatPrefill";
import type { Proposal } from "../../api/proposals";
import { useAuth } from "../../auth/AuthProvider";
import { errorText } from "../../api/errors";
import { FileViewer, MessageThumbs, type ViewTarget } from "../attachments/Thumbs";
import { STATUS, EXECUTION, VALIDITY, dateTime } from "./presentation";
import { RedoCorrectionDialog } from "../../pages/sheets/CorrectionDialog";
import { applied, BatchItems, nRec, pickable, Value, type BatchMode } from "./BatchItems";

const EVENTS: Record<string, string> = { prepared: "Подготовлено", created: "Подготовлено", assigned: "Назначен согласующий", assignment: "Назначен согласующий", claimed: "Взято в работу", submitted: "Заявка подана", approved: "Подтверждено", rejected: "Отклонено", execution: "Изменилось исполнение", attachment_context: "Добавлены материалы", superseded: "Заменено новым предложением" };

type Props = { id: string; onClose: () => void; onDecided?: (proposal: Proposal) => void };
export function ProposalDialog(props: Props) { return <DialogContent key={props.id} {...props} />; }
function DialogContent({ id, onClose, onDecided }: Props) {
  const m = useProposal(id, onDecided);
  const { me } = useAuth();
  const [transfer, setTransfer] = useState(false);
  const [assignee, setAssignee] = useState("");
  const [assignmentReason, setAssignmentReason] = useState("");
  const [viewer, setViewer] = useState<ViewTarget | null>(null);
  const [redoFix, setRedoFix] = useState<{ sheetId: number; studentId: number } | null>(null);
  // Пакет: отмеченные строки для применения (null — по умолчанию все доступные) и для отмены (null — окно отмены закрыто)
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const [undoPick, setUndoPick] = useState<Set<number> | null>(null);
  const p = m.loadError ? undefined : m.proposal;
  const batch = p?.kind === "batch" ? p : undefined;
  // Окно отмены открыто, пока сервер разрешает отмену: после выполненной отмены can_undo снимается и окно закрывается само
  const undoing = !!undoPick && !!batch?.actions.can_undo;
  const mode: BatchMode = undoing ? "undo" : batch?.actions.can_approve ? "approve" : "view";
  const items = batch?.items ?? [];
  // Отмеченные — только среди строк, которые сейчас можно выбрать (после «Обновить» строка могла устареть)
  const pickSet = batch ? new Set([...((undoing ? undoPick : null) ?? picked ?? items.filter((it) => it.state === "ok").map((it) => it.item_id))]
    .filter((id) => items.some((it) => it.item_id === id && pickable(batch, it, mode)))) : new Set<number>();
  const setPick = (next: Set<number>) => (undoing ? setUndoPick(next) : setPicked(next));
  const approveBatch = (ids: number[]) => void m.mutate({ action: "decision", approve: true, reason: m.reason, picked_item_ids: ids });
  const undoBatch = (ids: number[]) => void m.mutate({ action: "undo", picked_item_ids: ids });
  // Строка, из-за которой сервер откатил весь пакет или отмену (details.item_id), — снять её и повторить с остальными
  const dropCulprit = () => {
    const id = m.error?.itemId; if (id == null) return;
    const rest = [...pickSet].filter((x) => x !== id);
    setPick(new Set(rest)); m.clearError();
    if (rest.length) { if (undoing) undoBatch(rest); else approveBatch(rest); }
  };
  // Ведомость и студент исправления — из строки оценки (preview.before)
  const fixOf = (x: Proposal) => { const g = x.preview.before ?? x.preview.after; const sheetId = Number(g?.sheet_id), studentId = Number(g?.student_id);
    return sheetId > 0 && studentId > 0 ? { sheetId, studentId } : null; };
  const locked = m.busy || !!m.attempt || !!m.loadError;
  const close = () => { if (!m.busy) onClose(); };
  return <>
    <Modal onClose={close} label="Изменение от агента" outsideClose={false}>
      <div className={`dialog proposal-dialog${batch ? " batch-dialog" : ""}`}>
        <div className="form-head"><div><h3>{batch ? (undoing ? "Отменить изменения?" : batch.actions.can_approve ? "Применить изменения?" : "Пакетное изменение") : p?.kind === "grade_correction" ? "Коррекция оценки" : "Изменение от агента"}</h3>
          <p>{batch ? `Пакет от агента · ${nRec(items.length)}` : p?.explanation || "Предложение агента требует согласования."}</p></div><button type="button" className="icon-btn" aria-label="Закрыть" disabled={m.busy} onClick={close}><Icon name="x" /></button></div>
        {m.loading ? <div className="skel" style={{ height: 140 }} /> : m.loadError ? <p className="form-error">{m.loadError}</p> : p && <>
          {batch ? <>
            <div className="batch-sum"><Icon name="sparkle" /><div><p>{batch.explanation}</p>
              {batch.status === "approved" && <p>Применено {applied(batch).size} из {items.length}{batch.execution.undo_id ? " · отменено" : ""}.</p>}
              {batch.reason && <small className="hint">Основание агента: {batch.reason}</small>}</div></div>
            <BatchItems p={batch} mode={mode} picked={pickSet} onPick={setPick} culprit={m.error?.itemId} disabled={locked} undone={m.undone} />
            {mode === "approve" && !items.some((it) => it.state === "ok") && <p className="form-error">Ни одну строку применить нельзя — причины указаны в строках.</p>}
          </> : <div className={`diff${p.execution.status === "succeeded" ? " applied" : ""}`}>
            <div className="entity"><b>{m.operation === "INSERT" ? "Новая запись" : "Изменение записи"}</b><small>{TABLE_NAME[m.tableName ?? ""] ?? m.tableName}</small><Badge kind={p.status === "approved" ? "ok" : p.status === "pending" ? "info" : "muted"}>{STATUS[p.status]}</Badge></div>
            {m.rows.map((r, i) => <div key={r.field} className="diff-row" style={{ ["--i" as string]: i }}><span className="k">{r.label}</span><span className="old"><Value v={r.before} spec={r.spec} /></span><span className="to"><Icon name="arrow" /></span><span className="new"><Value v={r.after} spec={r.spec} /></span></div>)}
            {!!p.preview.related_effects.length && <ul className="effects">{p.preview.related_effects.map((e, i) => <li key={i}>{e}</li>)}</ul>}
            {p.preview.note && <small className="hint">{p.preview.note}</small>}
            {p.reason && <small className="hint">Основание: {p.reason}</small>}
          </div>}
          <div className="hint"><p>Автор: {p.initiator.full_name}. Создано: {dateTime(p.created_at)} (Москва).</p><p>Согласующий: {p.routing.assignee_name || "Пока не назначен"}.</p>
            {p.kind === "grade_correction" && <p>{p.submission_status === "draft" ? "Черновик: автор должен подать заявку." : `Заявка №${p.correction_id} подана. Решение принимает другой уполномоченный директор или заместитель директора института.`}</p>}
            {/* Актуальность важна только до решения: у решённых сервер хранит служебное значение (у отклонённого исправления — всегда stale) */}
            {p.status === "pending" && p.validity.state !== "current" && <p className="form-error">{VALIDITY[p.validity.state]}</p>}
            {p.status === "pending" && p.submission_status !== "submitted" && <p>Срок предложения: {dateTime(p.expires_at)} (Москва).</p>}
            <p>Исполнение: <b>{EXECUTION[p.execution.status]}</b>{p.execution.effective_date ? ` · дата: ${p.execution.effective_date}` : ""}{p.execution.order_id ? ` · приказ №${p.execution.order_id}` : ""}.</p>
            {p.execution.completed_at && <p>Завершено: {dateTime(p.execution.completed_at)} (Москва).</p>}
            {p.execution.error && <p className="form-error">Исполнение завершилось ошибкой. Обновите данные перед дальнейшими действиями.</p>}
            {p.decision_reason && <p>Комментарий к решению: {p.decision_reason}{p.decided_by ? ` · ${p.decided_by}` : ""}{p.decided_at ? ` · ${dateTime(p.decided_at)}` : ""}</p>}
          </div>
          {!!p.context_files.length && <details className="attach-hint"><summary>Материалы предложения: {p.context_files.length}</summary><MessageThumbs items={p.context_files} onOpen={(meta) => setViewer({ name: meta.filename, meta })} />{p.context_files.map((file) => <p key={file.version_id}>{file.filename}: связано фрагментов — {file.chunks.length}{file.chunks.some((chunk) => chunk.page != null) ? `; страницы: ${[...new Set(file.chunks.flatMap((chunk) => chunk.page != null ? [chunk.page] : []))].join(", ")}` : ""}. Это материалы данного предложения.</p>)}</details>}
          {(p.actions.can_claim || p.actions.can_assign) && <div className="actions">
            {p.actions.can_claim && <button type="button" className="btn" disabled={locked || !me} onClick={() => void m.mutate({ action: "assignment", assignee_user_id: me!.user_id, reason: "Взято в работу", claim: true })}>Взять в работу</button>}
            {p.actions.can_assign && <button type="button" className="btn" disabled={locked} onClick={() => setTransfer(!transfer)}>{transfer ? "Отменить передачу" : "Передать"}</button>}
          </div>}
          {transfer && p.actions.can_assign && <div className="form-grid"><label className="field"><span>Кому передать</span><select className="text-input" value={assignee} disabled={locked} onChange={(e) => setAssignee(e.target.value)}><option value="">Выберите сотрудника</option>{m.assignees.data?.filter((a) => a.user_id !== p.routing.assignee_user_id).map((a) => <option key={a.user_id} value={a.user_id}>{a.full_name}</option>)}</select></label><div className={`field form-field wide${m.reasonError?.action === "assignment" ? " invalid" : ""}`}><label htmlFor="pr-assign-reason">Причина передачи</label><textarea id="pr-assign-reason" className="text-input textarea" value={assignmentReason} maxLength={2000} disabled={locked} onChange={(e) => setAssignmentReason(e.target.value)} />{m.reasonError?.action === "assignment" ? <small className="field-error" role="alert">{m.reasonError.text}</small> : <small className="hint">От {REASON_MIN} до 2000 символов · {assignmentReason.trim().length} / 2000</small>}</div>{m.assignees.error && <p className="form-error">{errorText(m.assignees.error)}</p>}<button type="button" className="btn" disabled={locked || !assignee || assignmentReason.trim().length < REASON_MIN || !m.assignees.data?.some((a) => a.user_id === Number(assignee))} onClick={() => void m.mutate({ action: "assignment", assignee_user_id: Number(assignee), reason: assignmentReason })}>Передать предложение</button></div>}
          {(p.actions.can_approve || p.actions.can_reject) && <div className={`field form-field${m.reasonError?.action === "decision" ? " invalid" : ""}`}><label htmlFor="pr-reason">Комментарий к решению</label><textarea id="pr-reason" className="text-input textarea" rows={2} value={m.reason} disabled={locked} onChange={(e) => m.setReason(e.target.value)} placeholder="Например: подтверждаю по заявлению студента" maxLength={m.reasonMax} />{m.reasonError?.action === "decision" ? <small className="field-error" role="alert">{m.reasonError.text}</small> : <small className="hint">От {REASON_MIN} до {m.reasonMax} символов · {m.reason.trim().length} / {m.reasonMax}</small>}</div>}
          <details><summary>История действий</summary>{m.events.data?.pages.flatMap((page) => page.items).map((event) => <p className="hint" key={event.id}>{dateTime(event.created_at)} (Москва) · {EVENTS[event.event_type] || "Обновлено"} · {event.actor_user_id == null ? "Система" : event.actor_user_id === p.initiator.user_id ? p.initiator.full_name : event.actor_user_id === p.routing.assignee_user_id ? p.routing.assignee_name : `Пользователь №${event.actor_user_id}`}{event.reason ? ` · ${event.reason}` : ""}</p>)}{m.events.error && <p className="form-error">{errorText(m.events.error)}</p>}<button type="button" className="btn sm soft" disabled={m.events.isFetching} onClick={() => void m.events.refetch()}>Обновить историю</button>{m.events.hasNextPage && <button type="button" className="btn sm soft" disabled={m.events.isFetching} onClick={() => void m.events.fetchNextPage()}>Ещё</button>}</details>
        </>}
        {m.error && <ErrorNote text={m.error.text} requestId={m.error.requestId} code={m.error.code} />}
        {batch && m.error?.itemId != null && pickSet.has(m.error.itemId) && <div className="err-acts">
          <button type="button" className="btn sm soft" disabled={m.busy} onClick={dropCulprit}>{undoing ? "Снять строку и повторить" : "Снять строку и применить остальные"}</button></div>}
        {m.attempt && !m.busy && <p className="form-error">Результат запроса пока не подтверждён. Повторите тот же запрос, чтобы узнать результат.</p>}
        <div className="actions">
          {p?.actions.can_reject && !undoing && <button type="button" className="btn ghost danger-text" disabled={locked || !m.reasonOk} onClick={() => void m.mutate({ action: "decision", approve: false, reason: m.reason })}>Отклонить</button>}
          <span className="spacer" /><button type="button" className="btn" onClick={() => void m.refresh()} disabled={m.busy}>Обновить</button><button type="button" className="btn" onClick={close} disabled={m.busy}>{p?.status === "pending" ? "Позже" : "Закрыть"}</button>
          {/* «Подготовить заново» — по флагу сервера; исправление оценки — новой заявкой через форму с той же ведомостью и студентом */}
          {p?.actions.can_redo && p.request_text && p.kind !== "grade_correction" && <button type="button" className="btn" disabled={m.busy}
            onClick={() => { prefillChat(p.request_text!); onClose(); }}><Icon name="refresh" />Подготовить заново</button>}
          {p?.actions.can_redo && p.kind === "grade_correction" && fixOf(p) && <button type="button" className="btn" disabled={m.busy}
            onClick={() => setRedoFix(fixOf(p))}><Icon name="refresh" />Подготовить заново</button>}
          {p?.actions.can_submit && <button type="button" className="btn primary" disabled={locked} onClick={() => void m.mutate({ action: "submit" })}>Подать заявку</button>}
          {p?.actions.can_approve && !batch && <button type="button" className="btn primary" disabled={locked || !m.reasonOk} onClick={() => void m.mutate({ action: "decision", approve: true, reason: m.reason })}>Подтвердить</button>}
          {batch?.actions.can_approve && <button type="button" className="btn primary" disabled={locked || !m.reasonOk || !pickSet.size} onClick={() => approveBatch([...pickSet])}>Применить {pickSet.size} из {items.length}</button>}
          {/* Отмена — по флагу сервера (Ф-Р9); окно отмены повторяет окно одобрения: применённые обратимые строки, отмечены все (Ф-Р8) */}
          {batch?.actions.can_undo && !undoing && <button type="button" className="btn" disabled={locked}
            onClick={() => { m.clearError(); setUndoPick(new Set(items.filter((it) => pickable(batch, it, "undo")).map((it) => it.item_id))); }}><Icon name="refresh" />Отменить…</button>}
          {undoing && <button type="button" className="btn" disabled={m.busy} onClick={() => { m.clearError(); setUndoPick(null); }}>Не отменять</button>}
          {undoing && <button type="button" className="btn primary" disabled={locked || !pickSet.size} onClick={() => undoBatch([...pickSet])}>Отменить {nRec(pickSet.size)}</button>}
          {m.attempt && <button type="button" className="btn primary" disabled={m.busy || !!m.loadError} onClick={() => void m.mutate()}>Повторить запрос</button>}
          {m.busy && <span role="status">Подождите…</span>}
        </div>
      </div>
    </Modal>
    {viewer && <FileViewer target={viewer} onClose={() => setViewer(null)} />}
    {redoFix && <RedoCorrectionDialog sheetId={redoFix.sheetId} studentId={redoFix.studentId} onClose={() => setRedoFix(null)} />}
  </>;
}
