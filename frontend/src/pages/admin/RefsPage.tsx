import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Page } from "../../components/Shell";
import { Modal } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { RecordDialog, type FormConfig } from "../../components/form/RecordDialog";
import { useResource, type Row } from "../../api/resources";
import { useCan } from "../../api/schema";
import { errorText } from "../../api/errors";
import { fmtDate, fmtNum, fmtTime, plural } from "../../lib/format";
import { EMPLOYEE_CATEGORY } from "../columns";

/* ═════════ СПРАВОЧНИКИ ═════════
   Как в базе: деканат, директор и админ пополняют и правят разрешённые справочники, но не удаляют — на значения ссылаются данные.
   Остальные справочники — только просмотр. Права берутся из схемы бекенда (операции create/update) */

const s = (v: unknown) => (v == null ? "" : String(v));
const ROOM_KIND: Record<string, string> = { lecture: "лекционная", computer: "компьютерный класс", lab: "лаборатория", practice: "для практик" };

interface Ref {
  name: string;
  table: string;
  key: string;
  /** Значение и пояснение строки (как в макете) */
  row: (r: Row) => [string, string];
  sort?: (a: Row, b: Row) => number;
  form?: FormConfig;
}

// Справочники и их порядок — как в макете (mockup/redesign/roles.js, REFS)
const REFS: Ref[] = [
  { name: "Виды справок", table: "document_type", key: "document_type_id",
    row: (r) => [s(r.name), `${s(r.processing_days)} ${plural(Number(r.processing_days), "день", "дня", "дней")} на подготовку`] },
  { name: "Статусы заявок", table: "request_status", key: "request_status_id", row: (r) => [s(r.name), r.is_final ? "завершающий" : ""] },
  { name: "Основы обучения", table: "funding_type", key: "funding_type_id", row: (r) => [s(r.name), ""] },
  { name: "Причины академического отпуска", table: "leave_reason", key: "reason_id", row: (r) => [s(r.name), ""] },
  { name: "Виды приказов", table: "order_type", key: "order_type_id", row: (r) => [s(r.name), `код ${s(r.code)} · суффикс ${s(r.number_suffix)}`],
    // Код не меняется — по нему процедуры узнают вид приказа
    form: { lockOnEdit: ["code"] } },
  { name: "Виды стипендий", table: "scholarship_type", key: "scholarship_type_id",
    row: (r) => [s(r.name), `${fmtNum(r.amount)} ₽ в месяц${r.budget_only ? " · только бюджет" : ""}`] },
  { name: "Шкала баллов", table: "score_band", key: "band_id", row: (r) => [`${s(r.min_points)}–${s(r.max_points)}`, s(r.mark_name).toLowerCase()],
    sort: (a, b) => Number(a.min_points) - Number(b.min_points) },
  { name: "Время пар", table: "pair_time", key: "pair_number", row: (r) => [`${s(r.pair_number)} пара`, `${fmtTime(r.start_time)}–${fmtTime(r.end_time)}`],
    sort: (a, b) => Number(a.pair_number) - Number(b.pair_number) },
  { name: "Аудитории", table: "classroom", key: "classroom_id",
    row: (r) => [`${s(r.building)}-${s(r.room_number)}`, `${s(r.capacity)} мест · ${ROOM_KIND[s(r.room_kind)] ?? s(r.room_kind)}${r.has_projector ? " · проектор" : ""}`],
    sort: (a, b) => `${a.building}-${a.room_number}`.localeCompare(`${b.building}-${b.room_number}`, "ru", { numeric: true }) },
  { name: "Праздничные дни", table: "holiday", key: "holiday_date", row: (r) => [fmtDate(r.holiday_date), s(r.name) || "занятий нет"],
    sort: (a, b) => s(a.holiday_date).localeCompare(s(b.holiday_date)) },
  { name: "Должности", table: "position", key: "position_id", row: (r) => [s(r.title), EMPLOYEE_CATEGORY[s(r.category)] ?? s(r.category)] },
];

const sorted = (ref: Ref, rows: Row[]) => [...rows].sort(ref.sort ?? ((a, b) => ref.row(a)[0].localeCompare(ref.row(b)[0], "ru", { numeric: true })));

export function RefsPage() {
  const [open, setOpen] = useState<Ref | null>(null);
  return (
    <Page title="Справочники">
      <div className="ref-grid">{REFS.map((ref, i) => <RefCard key={ref.table} refDef={ref} i={i} onOpen={() => setOpen(ref)} />)}</div>
      {open && <RefDialog refDef={open} onClose={() => setOpen(null)} />}
    </Page>
  );
}

function RefCard({ refDef: ref, i, onOpen }: { refDef: Ref; i: number; onOpen: () => void }) {
  const { data, error } = useResource(ref.table);
  const rows = data ? sorted(ref, data) : [];
  return (
    <button type="button" className="card ref-card" style={{ ["--i" as string]: i }} onClick={onOpen}>
      <div><b>{ref.name}</b><small>{ref.table}</small></div>
      <span className="ref-n">{data ? rows.length : "…"}</span>
      <p>{error ? errorText(error) : rows.slice(0, 3).map((r) => ref.row(r)[0]).join(" · ") + (rows.length > 3 ? " …" : "")}</p>
    </button>
  );
}

function RefDialog({ refDef: ref, onClose }: { refDef: Ref; onClose: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const { data, error, isLoading } = useResource(ref.table);
  const rows = data ? sorted(ref, data) : [];
  const canEdit = can(ref.table, "update"), canAdd = can(ref.table, "create");
  const [form, setForm] = useState<{ row: Row | null } | null>(null);
  const n = rows.length;
  return (
    <>
      <Modal onClose={onClose} label={ref.name}>
        <div className="dialog form-dialog ref-dialog">
          <div className="form-head">
            <div><h3>{ref.name}</h3><p>Таблица {ref.table} · {data ? `${n} ${plural(n, "значение", "значения", "значений")}` : "…"}</p></div>
            <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="x" /></button>
          </div>
          <div className="form-body">
            {!canEdit && !canAdd && <div className="form-note">Только просмотр — значения задаёт база</div>}
            {error ? <p className="form-error">{errorText(error)}</p> : isLoading ? <div className="skel" style={{ height: 120 }} /> : (
              <div className="ref-list">
                {rows.map((r) => {
                  const [v, note] = ref.row(r);
                  return (
                    <div key={s(r[ref.key])} className="ref-row">
                      <b>{v}</b>
                      <span className="ref-side">{note && <small>{note}</small>}
                        {canEdit && <button type="button" className="icon-btn" aria-label={`Изменить «${v}»`} title="Изменить" onClick={() => setForm({ row: r })}><Icon name="edit" /></button>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {canAdd && <div><button type="button" className="btn sm ghost" onClick={() => setForm({ row: null })}><Icon name="plus" />Добавить значение</button></div>}
          </div>
        </div>
      </Modal>
      {form && (
        <RecordDialog table={ref.table} config={ref.form}
          recordKey={form.row ? { [ref.key]: form.row[ref.key] } : null}
          title={form.row ? ref.row(form.row)[0] : `${ref.name}: новое значение`}
          onClose={() => setForm(null)}
          onSaved={() => { void qc.invalidateQueries({ queryKey: ["res", ref.table] }); void qc.invalidateQueries({ queryKey: ["lookup"] }); }} />
      )}
    </>
  );
}
