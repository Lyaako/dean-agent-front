import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Page } from "../../components/Shell";
import { Badge, CodedText, ErrorNote, Modal, useToast } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { TableTools } from "../../components/table/TableTools";
import { DataTable } from "../../components/table/DataTable";
import { useTableState } from "../../components/table/useTableState";
import { applyTable, type Column } from "../../components/table/tableLogic";
import { createRow, updateRow, useResource } from "../../api/resources";
import { errorCode, errorField, errorText, requestIdOf } from "../../api/errors";
import { useAuth } from "../../auth/AuthProvider";
import { addDays, fmtDate, plural, todayIso } from "../../lib/format";
import { STATUS_KIND } from "../columns";
import { Empty } from "./parts";

/* ═════════ СПРАВКИ (студент) ═════════
   Свои заявки на справки. Новую заявку студент может изменить (экземпляры и «куда»), остальные — только посмотреть.
   Отменить и удалить нельзя (база и бекенд не дают студенту удалять заявки) */

// «Куда» — как в макете (mockup/redesign/data.js, PURPOSES)
const PURPOSES = ["В военный комиссариат", "В банк", "По месту требования", "В налоговую инспекцию", "По месту работы родителей",
  "Для оформления общежития", "В поликлинику", "Для перевода в другой вуз", "В органы социальной защиты"];
const COPIES = Array.from({ length: 10 }, (_, i) => i + 1);   // как в базе: 1–10

interface Req {
  request_id: number; document_type_id: number; document: string; copies: number; purpose: string;
  created_at: string; due_date: string; status: string; processed_by: string | null;
}

const COLS: Column<Req>[] = [
  { label: "№", field: "request_id", filter: "text", className: "num" },
  { label: "Документ", field: "document", filter: "enum", bold: true, render: (r) => <b>{r.document}</b> },
  { label: "Экз.", field: "copies", filter: "num", className: "num" },
  { label: "Куда", field: "purpose", filter: "enum" },
  { label: "Подана", field: "created_at", filter: "date", text: (r) => fmtDate(r.created_at) },
  { label: "Готова к", field: "due_date", filter: "date", text: (r) => fmtDate(r.due_date) },
  { label: "Статус", field: "status", filter: "enum", badge: true, render: (r) => <Badge kind={STATUS_KIND[r.status]}>{r.status}</Badge> },
];

export function MyRequestsPage() {
  const requests = useResource("document_request");
  const types = useResource("document_type");
  const statuses = useResource("request_status");
  const queue = useResource("v_document_queue");   // срок и исполнитель для заявок в работе

  const rows = useMemo<Req[]>(() => {
    const type = new Map((types.data ?? []).map((t) => [Number(t.document_type_id), t]));
    const status = new Map((statuses.data ?? []).map((x) => [Number(x.request_status_id), String(x.name)]));
    const q = new Map((queue.data ?? []).map((x) => [Number(x.request_id), x]));
    return (requests.data ?? []).map((r) => {
      const t = type.get(Number(r.document_type_id)), inQueue = q.get(Number(r.request_id));
      const created = String(r.created_at);
      return {
        request_id: Number(r.request_id), document_type_id: Number(r.document_type_id), document: String(t?.name ?? "—"),
        copies: Number(r.copies), purpose: String(r.purpose ?? ""), created_at: created,
        // Срок — из очереди деканата, иначе дата подачи + нормативный срок вида документа
        due_date: String(inQueue?.due_date ?? addDays(created.slice(0, 10), Number(t?.processing_days ?? 0))),
        status: status.get(Number(r.request_status_id)) ?? "—",
        processed_by: inQueue?.processed_by == null ? null : String(inQueue.processed_by),
      };
    }).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [requests.data, types.data, statuses.data, queue.data]);

  const [state, set] = useTableState("myrequests", COLS);
  const shown = useMemo(() => applyTable(state, COLS, rows), [state, rows]);
  const [ordering, setOrdering] = useState(false);
  const [open, setOpen] = useState<Req | null>(null);
  const loading = requests.isLoading || types.isLoading || statuses.isLoading;
  const error = requests.error || types.error || statuses.error;

  return (
    <Page title="Справки">
      <TableTools state={state} set={set} cols={COLS} rows={rows} count={loading || error ? undefined : shown.length}>
        <span className="spacer" />
        <button className="btn sm primary" onClick={() => setOrdering(true)} disabled={!types.data?.length}><Icon name="plus" />Заказать справку</button>
      </TableTools>
      {!loading && !error && !rows.length
        ? <Empty icon="file" title="Заявок пока нет">Нажмите «Заказать справку» — деканат подготовит её в срок</Empty>
        : <DataTable cols={COLS} rows={shown} base={rows} state={state} set={set} rowKey={(r) => String(r.request_id)} onRowClick={setOpen}
            loading={loading} error={error ? errorText(error) : null} onRetry={() => requests.refetch()} />}
      {ordering && <OrderDialog types={types.data ?? []} onClose={() => setOrdering(false)} />}
      {open && <RequestDialog r={open} onClose={() => setOpen(null)} />}
    </Page>
  );
}

const refreshKeys = ["res"];

function OrderDialog({ types, onClose }: { types: Record<string, unknown>[]; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [doc, setDoc] = useState(String(types[0]?.document_type_id ?? ""));
  const [copies, setCopies] = useState("1");
  const [purpose, setPurpose] = useState(PURPOSES[2]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const t = types.find((x) => String(x.document_type_id) === doc);
  const days = Number(t?.processing_days ?? 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !me?.student_id) return;
    setBusy(true); setFailure(null);
    try {
      const saved = await createRow("document_request", { student_id: me.student_id, document_type_id: Number(doc), copies: Number(copies), purpose: purpose.trim() });
      await Promise.all(refreshKeys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast(`Заявка № ${String(saved.request_id)} отправлена в деканат`);
      onClose();
    } catch (ex) { setFailure(ex); } finally { setBusy(false); }
  }

  return (
    <Modal onClose={() => { if (!busy) onClose(); }} label="Заказать справку">
      <form className="dialog form-dialog order-dialog" onSubmit={submit} noValidate>
        <div className="form-head"><div><h3>Заказать справку</h3><p>Деканат подготовит её в нормативный срок</p></div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose} disabled={busy}><Icon name="x" /></button></div>
        <div className="form-body"><div className="form-grid">
          <div className="field form-field wide"><label htmlFor="od-doc">Документ</label>
            <select id="od-doc" className="select" value={doc} disabled={busy} onChange={(e) => setDoc(e.target.value)}>
              {types.map((x) => <option key={String(x.document_type_id)} value={String(x.document_type_id)}>{String(x.name)}</option>)}
            </select>
            <small className="hint">Срок подготовки — {days} {plural(days, "день", "дня", "дней")}, будет готова к {fmtDate(addDays(todayIso(), days))}</small></div>
          <div className="field form-field"><label htmlFor="od-copies">Экземпляров</label>
            <select id="od-copies" className="select" value={copies} disabled={busy} onChange={(e) => setCopies(e.target.value)}>
              {COPIES.map((n) => <option key={n}>{n}</option>)}
            </select></div>
          <div className="field form-field"><label htmlFor="od-purpose">Куда</label>
            <select id="od-purpose" className="select" value={purpose} disabled={busy} onChange={(e) => setPurpose(e.target.value)}>
              {PURPOSES.map((p) => <option key={p}>{p}</option>)}
            </select></div>
        </div>
        {failure != null && <ErrorNote text={errorText(failure, "document_request")} requestId={requestIdOf(failure)} code={errorCode(failure)} />}</div>
        <div className="actions"><span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Отменить</button>
          <button className="btn primary" disabled={busy || !doc}>{busy ? "Отправляем…" : "Заказать"}</button></div>
      </form>
    </Modal>
  );
}

// Своя заявка: «Новую» можно изменить (экземпляры и «куда»), остальные — только посмотреть
function RequestDialog({ r, onClose }: { r: Req; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const edit = r.status === "Новая";
  const [copies, setCopies] = useState(String(r.copies));
  const [purpose, setPurpose] = useState(r.purpose);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const dirty = Number(copies) !== r.copies || purpose !== r.purpose;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!edit || !dirty || busy) return;
    setBusy(true); setFailure(null);
    try {
      const patch: Record<string, unknown> = {};
      if (Number(copies) !== r.copies) patch.copies = Number(copies);
      if (purpose !== r.purpose) patch.purpose = purpose.trim();
      await updateRow("document_request", { request_id: r.request_id }, patch);
      await Promise.all(refreshKeys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast(`Заявка № ${r.request_id} изменена`);
      onClose();
    } catch (ex) {
      // Пока окно было открыто, деканат мог взять заявку в работу
      setFailure(ex);
      void qc.invalidateQueries({ queryKey: ["res"] });
    } finally { setBusy(false); }
  }

  const field = failure ? errorField(failure, ["copies", "purpose"]) : undefined;
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} label={edit ? "Изменить заявку" : `Заявка № ${r.request_id}`}>
      <form className="dialog form-dialog order-dialog" onSubmit={submit} noValidate>
        <div className="form-head">
          <div><h3>{edit ? "Изменить заявку" : `Заявка № ${r.request_id}`}</h3>
            <p>{edit ? `Заявка № ${r.request_id} · пока деканат не взял её в работу` : `${r.document} · подана ${fmtDate(r.created_at)}`}</p></div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose} disabled={busy}><Icon name="x" /></button>
        </div>
        <div className="form-body">
          {edit ? (
            <div className="form-grid">
              <div className="field form-field wide"><label>Документ</label><b className="cur-res">{r.document}</b><small className="hint">Готова к {fmtDate(r.due_date)}</small></div>
              <div className={`field form-field${field === "copies" ? " invalid" : ""}`}><label htmlFor="mr-copies">Экземпляров</label>
                <select id="mr-copies" className="select" value={copies} disabled={busy} onChange={(e) => setCopies(e.target.value)}>
                  {COPIES.map((n) => <option key={n}>{n}</option>)}
                </select></div>
              <div className={`field form-field${field === "purpose" ? " invalid" : ""}`}><label htmlFor="mr-purpose">Куда</label>
                <select id="mr-purpose" className="select" value={purpose} disabled={busy} onChange={(e) => setPurpose(e.target.value)}>
                  {[...new Set([...PURPOSES, r.purpose])].map((x) => <option key={x}>{x}</option>)}
                </select></div>
            </div>
          ) : (
            <>
              <div className="kv-grid">
                {([["Документ", r.document], ["Экземпляров", r.copies], ["Куда", r.purpose], ["Статус", <Badge kind={STATUS_KIND[r.status]}>{r.status}</Badge>],
                  ["Готова к", fmtDate(r.due_date)], ["Обрабатывает", r.processed_by ?? "—"]] as [string, ReactNode][]).map(([l, v]) => <div key={l}><small>{l}</small><b>{v}</b></div>)}
              </div>
              <div className="form-note">Деканат уже {r.status === "В работе" ? "готовит" : "обработал"} заявку — изменить её нельзя. Если нужна другая справка, закажите новую.</div>
            </>
          )}
          {failure != null && (field
            ? <p className="form-error" role="alert"><CodedText text={errorText(failure, "document_request")} code={errorCode(failure)} /></p>
            : <ErrorNote text={errorText(failure, "document_request")} requestId={requestIdOf(failure)} code={errorCode(failure)} />)}
        </div>
        <div className="actions"><span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Закрыть</button>
          {edit && <button className="btn primary" disabled={busy || !dirty}>{busy ? "Сохраняем…" : "Сохранить"}</button>}
        </div>
      </form>
    </Modal>
  );
}
