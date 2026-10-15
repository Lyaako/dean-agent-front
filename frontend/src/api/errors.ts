import { ApiError } from "./client";

// Бэкенд отдаёт безопасный код без подробностей SQL — показываем свой понятный текст
const MESSAGES: Record<string, string> = {
  invalid_credentials: "Неверный логин или пароль",
  login_rate_limit: "Слишком много попыток входа. Подождите несколько минут",
  invalid_origin: "Сервер не принимает запросы с этого адреса (ALLOWED_ORIGINS)",
  invalid_token: "Сессия истекла — войдите снова",
  inactive_session: "Сессия завершена — войдите снова",
  session_changed: "Аккаунт изменился — повторите действие",
  session_refreshed: "Сессия обновлена — отправьте форму ещё раз",
  password_change_required: "Сначала задайте новый пароль",
  invalid_current_password: "Неверный текущий пароль",
  password_unchanged: "Новый пароль совпадает с текущим",
  password_already_issued: "Пароль уже выдан",
  // Ошибки базы по решению Р2 (docs/api-gaps.md §6.2)
  correction_pending_exists: "По этой оценке уже есть заявка",
  sheet_open: "Ведомость открыта — исправьте оценку в ведомости",
  sheet_cancelled: "Ведомость отменена — исправлять в ней нечего",
  correction_not_allowed: "Подать заявку на исправление может только работающий сотрудник",
  correction_not_own_sheet: "Преподаватель может подать заявку только по своей ведомости",
  correction_self_decision: "Автор заявки не может сам её подтвердить",
  correction_not_manager: "Решение по заявке принимает директор или заместитель директора института",
  correction_decided: "Заявка уже рассмотрена",
  order_cancel_enrollment: "Зачисление отменяется удалением студента",
  order_not_pending: "Приказ уже исполнен или отменён",
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
  resource_too_large: "Таблица содержит больше 20 000 строк. Полная загрузка недоступна; уточните выборку через агента",
  olap_too_large: "Для анализа выбрано больше 100 000 записей — уточните группу, дисциплину или семестр",
  group_required: "Выберите группу",
  discipline_required: "Выберите дисциплину",
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

/* ── Коды ошибок макета (mockup/redesign/batch.js, ERRORS): этап и заголовок.
   AG — подготовка агентом, RW — проверка строки, CH — изменения, пока окно открыто, AP — применение, UN — отмена, XX — неизвестное ── */
export const ERROR_CODES: Record<string, string> = {
  "AG-01": "Нет прав на это действие",
  "AG-02": "Слишком много записей для одного пакета",
  "AG-03": "Не удалось прочитать данные",
  "AG-04": "Связь с агентом прервалась",
  "RW-01": "Значение не проходит правила базы",
  "RW-02": "Недопустимый переход",
  "RW-03": "Запись закрыта для изменений",
  "RW-04": "Нет доступа к записи",
  "RW-05": "Запись удалена",
  "RW-06": "Противоречие внутри пакета",
  // Правила новой базы: в формах показываются под полем, к которому относятся
  "RW-07": "Приказ не может вступить в силу задним числом",
  "RW-08": "Подписать может только директор или заместитель института",
  "RW-09": "У студента уже есть запланированный приказ",
  "RW-10": "Дисциплина не из семестра этой группы",
  "RW-11": "Даты ведомости не сходятся",
  "RW-12": "Баллы — от 25 до 54",
  "RW-13": "Не у всех студентов есть результат",
  "CH-01": "Уже сделано",
  "CH-02": "Конфликт: запись изменили по-другому",
  "CH-03": "Запись удалили",
  "CH-04": "Пакет устарел",
  "CH-05": "Сессия истекла",
  "AP-01": "Запись изменилась во время применения",
  "AP-02": "Запись не прошла проверку базы данных",
  "AP-03": "У вас больше нет прав на эти изменения",
  "AP-04": "Сервер не смог применить изменения",
  "AP-05": "Нет ответа от сервера",
  "AP-06": "Пакет уже был применён",
  "UN-01": "Запись изменили после применения — не отменяется",
  "UN-02": "Срок отмены истёк",
  "UN-03": "Изменение необратимо",
  "XX-00": "Неизвестная ошибка",
};

// Коды бекенда (error.code, задача Б11) → коды макета (mockup/redesign/batch.js, BACKEND_CODES).
// stale_item при решении откатывает пакет целиком — это AP-01 с номером строки в details.item_id (§6.1).
// Коды без пары в макете (correction_*, коды Р2, order_*) — текстом без кода; undo_unavailable — по details.reason (Р9)
export const BACKEND_CODES: Record<string, string> = {
  order_past_date: "RW-07", effective_date_past: "RW-07", order_signer_invalid: "RW-08", order_pending_exists: "RW-09",
  slot_semester_mismatch: "RW-10", sheet_dates_invalid: "RW-11", points_out_of_scale: "RW-12", sheet_incomplete: "RW-13",
  sheet_closed: "RW-03", request_final: "RW-02", blank_text: "RW-01", batch_too_large: "AG-02",
  stale_item: "AP-01", undo_changed: "UN-01", undo_unavailable: "UN-02",
};

// Поле из details.field, если в форме его нет под этим именем: подписант приходит и как signed_by_id,
// а у академического отпуска нет «Вступает в силу» — дата приказа там «Начало»
const FIELD_ALIASES: Record<string, string[]> = { signed_by_id: ["signed_by"], effective_date: ["start"] };

// Причина недоступности отмены (Р9): срок истёк — UN-02, остальное — UN-03
const UNDO_REASON: Record<string, [string, string]> = {
  expired: ["UN-02", "Срок отмены истёк"],
  sheet_closed: ["UN-03", "Ведомость закрыта — нужна заявка на исправление"],
  request_final: ["UN-03", "Заявка в завершающем статусе"],
  irreversible: ["UN-03", "Это изменение не отменяется"],
};
const detail = (e: ApiError, k: string) => (e.details as Record<string, unknown> | null | undefined)?.[k];
const undoReason = (e: unknown) => (e instanceof ApiError && e.code === "undo_unavailable" ? UNDO_REASON[String(detail(e, "reason"))] : undefined);
/** Текст причины для строки пакета (items[].undo_reason) */
export const undoReasonText = (reason: string | null | undefined) => (reason ? UNDO_REASON[reason]?.[1] : undefined);

/** Код макета для ошибки бекенда, если он согласован */
export const errorCode = (e: unknown) => undoReason(e)?.[0] ?? (e instanceof ApiError ? BACKEND_CODES[e.code] : undefined);

/** Поле формы, под которым показать ошибку (из details.field), или undefined — тогда ошибка внизу формы */
export function errorField(e: unknown, names: string[]): string | undefined {
  if (!(e instanceof ApiError) || !errorCode(e)) return undefined;
  const field = (e.details as { field?: unknown } | null | undefined)?.field;
  if (typeof field !== "string") return undefined;
  return [field, ...(FIELD_ALIASES[field] ?? [])].find((n) => names.includes(n));
}

/** Список из details.items (у sheet_incomplete — ФИО студентов без результата) */
export function errorItems(e: unknown): string[] {
  const items = e instanceof ApiError ? (e.details as { items?: unknown } | null | undefined)?.items : undefined;
  return Array.isArray(items) ? items.map(String) : [];
}

export function errorText(e: unknown, table?: string): string {
  const undo = undoReason(e);
  if (undo) return undo[1];
  const code = errorCode(e);
  if (code) return ERROR_CODES[code];
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
