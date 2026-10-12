import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Page } from "../components/Shell";
import { Icon } from "../components/Icon";
import { Badge, Seg } from "../components/ui";
import { TableTools } from "../components/table/TableTools";
import { DataTable } from "../components/table/DataTable";
import { useTableState } from "../components/table/useTableState";
import { applyTable } from "../components/table/tableLogic";
import { RecordDialog, type FormConfig } from "../components/form/RecordDialog";
import { useResource, type Row } from "../api/resources";
import { useCan } from "../api/schema";
import { errorText } from "../api/errors";
import { GROUP_COLS } from "./columns";

const FORM: FormConfig = {
  order: ["name", "curriculum_id", "curator_id", "headman_id", "is_archived"],
  labels: { name: "Шифр группы", curriculum_id: "Учебный план", is_archived: "Группа выпущена или расформирована" },
  // Староста — только из студентов этой группы
  filters: { headman_id: (o, v) => !v.name || o.row.group_name === v.name },
};

let lastView: "cards" | "table" = "cards";
const t = (v: unknown) => (v == null || v === "" ? "—" : String(v));

export function GroupsPage() {
  const can = useCan();
  const navigate = useNavigate();
  const data = useResource("v_groups");
  const rows = useMemo(() => data.data ?? [], [data.data]);
  const [state, set] = useTableState("groups", GROUP_COLS);
  const filtered = useMemo(() => applyTable(state, GROUP_COLS, rows), [state, rows]);
  const [view, setView] = useState(lastView);
  const [open, setOpen] = useState<{ row: Row | null } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const addBtn = can("study_group", "create") && (
    <button className="btn sm primary" onClick={() => setOpen({ row: null })}><Icon name="plus" />Добавить</button>
  );

  const card = (r: Row, i: number) => (
    <article key={String(r.group_id)} className="card gcard clickable" style={{ ["--i" as string]: i + 1 }} onClick={() => setOpen({ row: r })}>
      <div className="gc-top"><span className="gc-name">{t(r.group_name)}</span><Badge kind="info plain">{t(r.course)} курс</Badge></div>
      <p className="gc-spec">{t(r.specialty)}</p>
      <p className="gc-spec">{t(r.profile)}</p>
      <dl className="kv">
        <dt>Форма</dt><dd>{t(r.study_form)}</dd>
        <dt>Год набора</dt><dd>{t(r.admission_year)}</dd>
        <dt>Семестр</dt><dd>{t(r.current_semester)}</dd>
        <dt>Куратор</dt><dd title={t(r.curator)}>{t(r.curator)}</dd>
        <dt>Староста</dt><dd title={t(r.headman)}>{t(r.headman)}</dd>
        <dt>Количество студентов</dt><dd>{t(r.active_students)}</dd>
        <dt>На бюджете</dt><dd>{t(r.budget_students)}</dd>
      </dl>
      <div className="gc-acts" onClick={(e) => e.stopPropagation()}>
        <button className="btn sm soft go" onClick={() => navigate(`/students?group_name=${encodeURIComponent(String(r.group_name))}`)}>Студенты<Icon name="arrow" /></button>
        <button className="btn sm ghost" onClick={() => navigate(`/schedule?view=week&by=group&who=${encodeURIComponent(String(r.group_name))}`)}>Расписание</button>
      </div>
    </article>
  );

  return (
    <Page title="Группы">
      <TableTools state={state} set={set} cols={GROUP_COLS} rows={rows} count={data.isLoading || data.error ? undefined : filtered.length}>
        <span className="spacer" />
        {addBtn}
        <Seg value={view} onChange={(v) => { lastView = v; setView(v); }} options={[["cards", "Карточки", "grid"], ["table", "Таблица", "list"]]} />
      </TableTools>
      {view === "cards" ? (
        <div className="enter" key="cards">
          {data.isLoading ? <div className="cards">{Array.from({ length: 6 }, (_, i) => <div key={i} className="card skel" style={{ height: 320 }} />)}</div>
            : data.error ? <section className="card empty-day"><Icon name="alert" /><b>Не удалось загрузить</b>{errorText(data.error)}
                <button className="btn sm soft retry" onClick={() => data.refetch()}><Icon name="refresh" />Повторить</button></section>
            : filtered.length ? <div className="cards stagger">{filtered.map(card)}</div>
            : <section className="card empty-day"><Icon name="search" /><b>Ничего не найдено</b></section>}
        </div>
      ) : (
        <div className="enter" key="table">
          <DataTable cols={GROUP_COLS} rows={filtered} base={rows} state={state} set={set} rowKey={(r) => String(r.group_id)}
            onRowClick={(r) => setOpen({ row: r })} loading={data.isLoading} error={data.error ? errorText(data.error) : null}
            onRetry={() => data.refetch()} flashKey={flash} />
        </div>
      )}
      {open && (
        <RecordDialog table="study_group" config={FORM} recordKey={open.row ? { group_id: open.row.group_id } : null}
          title={open.row ? `Группа ${open.row.group_name}` : "Новая группа"} onClose={() => setOpen(null)}
          onSaved={(saved) => { setFlash(null); requestAnimationFrame(() => setFlash(String(saved.group_id))); }} />
      )}
    </Page>
  );
}
