import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listProposals, type ProposalBox, type ProposalFilters } from "../../api/proposals";
import { useAuth } from "../../auth/AuthProvider";
import { STAFF_ROLES } from "../../api/auth";
import { errorText, requestIdOf } from "../../api/errors";
import { ErrorNote } from "../../components/ui";
import { STATUS, EXECUTION, dateTime } from "./presentation";

const BOXES: [ProposalBox, string][] = [["incoming", "Входящие"], ["mine", "Мои"], ["completed", "История"]];
export function ProposalQueue({ onOpen }: { onOpen: (id: string) => void }) {
  const { me } = useAuth();
  const staff = !!me?.roles.some((role) => STAFF_ROLES.includes(role));
  const [filters, setFilters] = useState<ProposalFilters>({ box: staff ? "incoming" : "mine", limit: 20, offset: 0 });
  const invalidDates = !!(filters.created_from && filters.created_to && filters.created_from > filters.created_to);
  const q = useQuery({ queryKey: ["proposals", me?.user_id, filters], queryFn: () => listProposals(filters), enabled: !!me && !invalidDates });
  const change = (patch: Partial<ProposalFilters>) => setFilters((old) => ({ ...old, ...patch, offset: 0 }));
  return <details className="proposal-queue">
    <summary>На согласовании{q.data ? ` · ${q.data.counts[filters.box]}` : ""}</summary>
    <div className="table-tools" role="group" aria-label="Очередь предложений" style={{ flexWrap: "wrap" }}>
      {BOXES.filter(([box]) => staff || box !== "incoming").map(([box, label]) => <button type="button" className={`btn sm ${filters.box === box ? "primary" : "soft"}`} key={box} aria-pressed={filters.box === box} onClick={() => change({ box })}>{label}{q.data ? ` (${q.data.counts[box]})` : ""}</button>)}
      <button type="button" className="btn sm" disabled={q.isFetching || invalidDates} onClick={() => void q.refetch()}>Обновить</button>
    </div>
    <div className="form-grid">
      <label className="field"><span>Решение</span><select className="text-input" value={filters.status ?? ""} onChange={(e) => change({ status: (e.target.value || undefined) as ProposalFilters["status"] })}><option value="">Все</option>{Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="field"><span>Исполнение</span><select className="text-input" value={filters.execution_status ?? ""} onChange={(e) => change({ execution_status: (e.target.value || undefined) as ProposalFilters["execution_status"] })}><option value="">Все</option>{Object.entries(EXECUTION).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="field"><span>Автор: имя или логин</span><input className="text-input" maxLength={200} value={filters.author ?? ""} onChange={(e) => change({ author: e.target.value })} /></label>
      <label className="field"><span>Создано с (Москва)</span><input className="text-input" type="date" value={filters.created_from ?? ""} onChange={(e) => change({ created_from: e.target.value })} /></label>
      <label className="field"><span>По дату включительно</span><input className="text-input" type="date" value={filters.created_to ?? ""} onChange={(e) => change({ created_to: e.target.value })} /></label>
      <button type="button" className="btn sm soft" onClick={() => setFilters({ box: filters.box, limit: 20, offset: 0 })}>Сбросить фильтры</button>
    </div>
    {invalidDates ? <p className="form-error">Дата окончания должна быть не раньше начала.</p>
      : q.isLoading ? <p className="hint">Загрузка очереди…</p>
      : q.error ? <ErrorNote text={errorText(q.error)} requestId={requestIdOf(q.error)} />
      : <>
        {q.data?.items.map((p) => <div className="proposal-card" key={p.id}><div><b>{p.explanation || "Предложение изменения"}</b><small>{p.initiator.full_name} · {dateTime(p.created_at)} (Москва)</small><small>{STATUS[p.status]} · {EXECUTION[p.execution.status]}</small>{p.routing.assignee_name && <small>В работе: {p.routing.assignee_name}</small>}</div><button type="button" className="btn sm soft go" onClick={() => onOpen(p.id)}>Открыть</button></div>)}
        {q.data && !q.data.items.length && <p className="hint">Предложений по этим условиям нет.</p>}
        <div className="table-tools"><button type="button" className="btn sm" disabled={!filters.offset || q.isFetching} onClick={() => setFilters((old) => ({ ...old, offset: Math.max(0, old.offset - old.limit) }))}>Назад</button><span>Страница {Math.floor(filters.offset / filters.limit) + 1}</span><button type="button" className="btn sm" disabled={!q.data?.has_more || q.isFetching} onClick={() => setFilters((old) => ({ ...old, offset: old.offset + old.limit }))}>Далее</button></div>
      </>}
  </details>;
}
