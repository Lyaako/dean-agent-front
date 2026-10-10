import { ApiError } from "./client";

// Бэкенд отдаёт безопасный код без подробностей SQL — показываем свой понятный текст
const MESSAGES: Record<string, string> = {
  invalid_credentials: "Неверный логин или пароль",
  login_rate_limit: "Слишком много попыток входа. Подождите несколько минут",
  invalid_origin: "Сервер не принимает запросы с этого адреса (ALLOWED_ORIGINS)",
  invalid_token: "Сессия истекла — войдите снова",
  inactive_session: "Сессия завершена — войдите снова",
  forbidden: "Недостаточно прав для этого действия",
  validation_error: "Сервер не принял данные — проверьте заполнение полей",
  invalid_filter: "Недопустимый фильтр",
  invalid_value: "Недопустимое значение",
  required_field: "Не заполнено обязательное поле — оно отмечено звёздочкой",
  constraint_violation: "Значение вне допустимых пределов — проверьте числа и даты в форме (например, дата окончания не раньше даты начала)",
  duplicate: "Такая запись уже есть",
  relationship_conflict: "Запись связана с другими данными — сначала измените или удалите их",
  period_conflict: "Периоды пересекаются",
  concurrent_change: "Данные одновременно изменил кто-то ещё — повторите",
  domain_conflict: "Действие противоречит правилам базы данных",
  not_found: "Запись не найдена",
  query_timeout: "Сервер долго отвечает — попробуйте позже",
  database_unavailable: "База данных недоступна",
  idempotency_conflict: "Этот запрос уже отправлялся с другими данными",
  body_too_large: "Слишком большой запрос или файл",
  agent_unavailable: "Агент сейчас недоступен",
  agent_busy: "Агент занят другими запросами — попробуйте через минуту",
  session_busy: "Агент ещё отвечает в этом чате — дождитесь ответа",
  session_not_found: "Этот диалог не найден на сервере — начните новый чат",
  agent_error: "Агент не смог ответить",
  agent_protocol_error: "Агент ответил в неожиданном формате",
  agent_outcome_unknown: "Неизвестно, выполнил ли агент запрос — проверьте данные",
  agent_attachments_unsupported: "Агент пока не умеет читать вложения",
  proposal_not_found: "Предложение не найдено или недоступно",
  proposal_decided: "По этому изменению уже принято решение",
  proposal_expired: "Срок предложения истёк — попросите агента подготовить его заново",
  stale_proposal: "Данные изменились после подготовки предложения — попросите агента подготовить его заново",
  file_not_ready: "Файл ещё обрабатывается",
  http_504: "Сервер не дождался ответа",
};

// Уточнения для отдельных таблиц
const BY_TABLE: Record<string, Record<string, string>> = {
  schedule_slot: {
    domain_conflict: "Пересечение в расписании: преподаватель, группа или аудитория уже заняты в это время, аудитория мала или даты вне семестра",
  },
  study_group: { relationship_conflict: "В группе есть студенты или занятия — удалить её нельзя" },
  employee: {
    constraint_violation: "Доля ставки должна быть от 0,25 до 1,50, а дата увольнения — не раньше даты приёма",
    relationship_conflict: "Сотрудник связан с другими данными (занятия, работы, приказы) — удалить его нельзя",
    duplicate: "Такой табельный номер уже есть, или у этого человека уже есть запись сотрудника",
  },
};

export function errorText(e: unknown, table?: string): string {
  if (e instanceof ApiError) {
    const known = (table && BY_TABLE[table]?.[e.code]) || MESSAGES[e.code];
    if (known) return known;
    if (e.status >= 500) return "Ошибка сервера — попробуйте ещё раз";
    // Служебные сообщения бэкенда на английском пользователю не показываем
    return /[а-яё]/i.test(e.message) ? e.message : "Сервер не принял данные — проверьте заполнение формы";
  }
  if (e instanceof DOMException && e.name === "AbortError") return "Остановлено";
  if (e instanceof TypeError) return "Нет связи с сервером";
  return e instanceof Error ? e.message : String(e);
}

export const requestIdOf = (e: unknown) => (e instanceof ApiError ? e.requestId : undefined);
