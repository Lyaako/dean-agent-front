import type { ExecutionStatus, ProposalStatus } from "../../api/proposals";

export const STATUS: Record<ProposalStatus, string> = { pending: "Ждёт решения", approved: "Подтверждено", rejected: "Отклонено" };
export const EXECUTION: Record<ExecutionStatus, string> = {
  not_started: "Не начато", scheduled: "Запланировано", running: "Исполняется", succeeded: "Исполнено", failed: "Ошибка исполнения", cancelled: "Исполнение отменено",
};
export const VALIDITY = { current: "Актуально", stale: "Исходные данные изменились", expired: "Срок предложения истёк", superseded: "Заменено новым предложением" };
export const dateTime = (iso: string | null) => iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : "—";
