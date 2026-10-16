import { useMemo, useState } from "react";
import { Page } from "../../components/Shell";
import { Badge } from "../../components/ui";
import { TableTools } from "../../components/table/TableTools";
import { DataTable } from "../../components/table/DataTable";
import { useTableState } from "../../components/table/useTableState";
import { applyTable, type Column } from "../../components/table/tableLogic";
import { useAuth } from "../../auth/AuthProvider";
import { errorText } from "../../api/errors";
import {
  KIND_NAME, STAGE_NAME, STATUS_NAME, useRosters, useSheets, type Sheet,
} from "../../api/sheets";
import { SheetDialog } from "./SheetDialog";

const n = (v: number) => v.toLocaleString("ru-RU");

// «Заполнено» считаем только у открытых ведомостей: у закрытых результат есть у всех, а все оценки базы (больше 20 000) не грузим
const COLS = (filled: Map<number, [number, number]>, mine: boolean): Column<Sheet>[] => [
  { label: "Номер", field: "sheet_number", filter: "text" },
  { label: "Группа", field: "group_name", filter: "enum" },
  { label: "Дисциплина", field: "discipline", filter: "text", bold: true, render: (r) => <b>{r.discipline}</b> },
  { label: "Сем.", field: "semester", filter: "enum", className: "num" },
  { label: "Этап", field: (r) => STAGE_NAME[r.stage], filter: "enum" },
  { label: "Вид", field: (r) => KIND_NAME[r.sheet_kind], filter: "enum" },
  ...(mine ? [] : [{ label: "Экзаменатор", field: "examiner", filter: "enum" } as Column<Sheet>]),
  { label: "Заполнено", className: "num", text: (r) => { const f = filled.get(r.sheet_id); return r.status !== "open" ? "—" : f ? `${f[0]} из ${f[1]}` : "…"; } },
  { label: "Статус", field: (r) => STATUS_NAME[r.status], filter: "enum", badge: true,
    render: (r) => <Badge kind={r.status === "open" ? "warn" : "muted"}>{STATUS_NAME[r.status]}</Badge> },
];

export function SheetsPage() {
  const { role } = useAuth();
  const mine = role === "teacher";   // преподаватель видит только свои ведомости — так отдаёт бэкенд
  const sheets = useSheets();
  const all = useMemo(() => [...(sheets.data ?? [])].sort((a, b) =>
    a.status === b.status
      ? (b.semester ?? 0) - (a.semester ?? 0) || a.group_name.localeCompare(b.group_name, "ru", { numeric: true }) || a.sheet_number.localeCompare(b.sheet_number, "ru", { numeric: true })
      : a.status === "open" ? -1 : b.status === "open" ? 1 : 0), [sheets.data]);

  // Состав открытых ведомостей — с сервера (/roster): у пересдачи это все, кого база разрешает внести
  const open = useMemo(() => all.filter((s) => s.status === "open"), [all]);
  const rosters = useRosters(open.map((s) => s.sheet_id));
  const loaded = rosters.map((q) => q.dataUpdatedAt).join();
  const filled = useMemo(() => {
    const out = new Map<number, [number, number]>();
    open.forEach((s, i) => { const r = rosters[i]?.data; if (r) out.set(s.sheet_id, [r.filter((x) => x.grade).length, r.length]); });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loaded]);
  const filledReady = open.every((s) => filled.has(s.sheet_id));
  const sum = (i: 0 | 1) => open.reduce((t, s) => t + (filled.get(s.sheet_id)?.[i] ?? 0), 0);

  const cols = useMemo(() => COLS(filled, mine), [filled, mine]);
  const [state, set] = useTableState("sheets", cols);
  const rows = useMemo(() => applyTable(state, cols, all), [state, cols, all]);
  const [openId, setOpenId] = useState<number | null>(null);
  const current = openId == null ? null : all.find((s) => s.sheet_id === openId) ?? null;

  const tiles: [string, string, string, string?][] = [
    ["Открытых ведомостей", n(open.length), mine ? "ждут ваших баллов" : "ещё не закрыты", open.length ? "" : "ok"],
    ["Заполнено в открытых", filledReady ? `${n(sum(0))} из ${n(sum(1))}` : "…", "студентов с баллами"],
    ["Пересдачи", n(open.filter((s) => s.sheet_kind === "retake").length), "открытых ведомостей пересдачи"],
  ];

  return (
    <Page title={mine ? "Мои ведомости" : "Ведомости"}>
      <div className="olap-tiles">
        {tiles.map(([label, value, note, kind = ""]) => (
          <div key={label} className={`card olap-tile ${kind}`}><small>{label}</small><b>{sheets.isLoading ? "…" : value}</b><span>{note}</span></div>
        ))}
      </div>
      <TableTools state={state} set={set} cols={cols} rows={all} count={sheets.isLoading || sheets.error ? undefined : rows.length} />
      <DataTable cols={cols} rows={rows} base={all} state={state} set={set} rowKey={(r) => String(r.sheet_id)}
        onRowClick={(r) => setOpenId(r.sheet_id)} loading={sheets.isLoading}
        error={sheets.error ? errorText(sheets.error) : null} onRetry={() => sheets.refetch()} />
      {current && <SheetDialog key={current.sheet_id} sheet={current} all={all} onClose={() => setOpenId(null)} onOpen={(id) => setOpenId(id)} />}
    </Page>
  );
}
