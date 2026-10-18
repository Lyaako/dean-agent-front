import type { ExecutionStatus, ProposalStatus, ProposalSummary } from "../../api/proposals";

export const STATUS: Record<ProposalStatus, string> = { pending: "Ждёт решения", approved: "Подтверждено", rejected: "Отклонено" };
export const EXECUTION: Record<ExecutionStatus, string> = {
  not_started: "Не начато", scheduled: "Запланировано", running: "Исполняется", succeeded: "Исполнено", failed: "Ошибка исполнения", cancelled: "Исполнение отменено",
};
export const VALIDITY = { current: "Актуально", stale: "Исходные данные изменились", expired: "Срок предложения истёк", superseded: "Заменено новым предложением" };
export const dateTime = (iso: string | null) => iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : "—";

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;
/** Карточка предложения в чате: подпись под заголовком, бейдж решения, кнопка. Пакет — «N записей» и «Применено», как batchCard в макете */
export function cardText(p: ProposalSummary, table: Record<string, string>, decision?: string) {
  const batch = p.preview.operation === "BATCH";
  const n = p.preview.items?.length ?? p.preview.affected_rows;
  const sub = batch ? `Пакет изменений · ${n} ${plural(n, "запись", "записи", "записей")}`
    : `${table[p.preview.table] ?? p.preview.table} · ${p.preview.operation === "INSERT" ? "новая запись" : `полей: ${p.preview.changed_columns.length}`}`;
  const badge = !decision ? null : decision === "approved" ? (batch ? "Применено" : "Подтверждено") : "Отклонено";
  const button = decision ? "Открыть" : batch ? "Проверить изменения" : "Посмотреть изменение";
  return { sub, badge, button };
}
