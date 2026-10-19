# Макет деканата (`mockup/redesign`)

Макет — **эталон внешнего вида и сценариев экранов**: раскладка, тексты, цвета и темы, порядок шагов, какие окна открываются и что в них показано.

Макет **не эталон поведения**. Права, доступность кнопок, коды и тексты ошибок, форматы запросов и ответов определяют:

- API бекенда — `~/backend_dean_master/docs/API.md` (репозиторий `PurpleCloudy/backend_dean`);
- React-фронт — `frontend/` в этом репозитории (там же правила в `frontend/src/api/errors.ts`, `frontend/src/api/*.ts`).

Логика в `*.js` макета — имитация для показа сценариев (данные из `data.js`, ошибки по `window.BATCH_SIM` / `FORM_SIM`). Макет не синхронизируется с решениями бекенда и дальше не правится под них.

## Как переносить экран в React

1. Вид, тексты и сценарий — из макета.
2. Права и доступность действий — из ответа сервера: флаги `actions.*`, `can_*`, схема `GET /schema`. Свои проверки ролей из макета не переносить.
3. Ошибки — по `error.code` бекенда и таблицам `BACKEND_CODES` / `ERROR_CODES` / `MESSAGES` в `frontend/src/api/errors.ts`; новые коды макета (RW-…) не придумывать.
4. Поля и форматы — по `docs/API.md`; если макет и API расходятся — по API, если API и база — по базе (`deanery_db 4/`).

## Что в макете устарело

Относительно решений Р1–Р9 (`docs/api-decisions-tasks.md`, раздел «Фронт»):

| В макете | Как на самом деле |
|---|---|
| Свои проверки прав `canDecide`, `canWork`, `canRedo` (`roles.js:699–711`) | Кнопки предложений — только по флагам сервера `actions.can_approve`, `can_reject`, `can_claim`, `can_assign`, `can_submit`, `can_undo`, `can_redo` |
| `reversible()` у строк пакета (`batch.js:96`) и молчаливый пропуск изменённых строк при отмене | «Отменить» — по `actions.can_undo`; у строк `items[].reversible` и `undo_reason`; отмена по выбранным строкам `picked_item_ids`, ошибка строки — по `details.item_id` |
| Период «term» в OLAP (`olap.js:260, 278`) | `period=semester` |
| Коды ошибок только до RW-13 (`batch.js:33–36`) | Новые коды бекенда Р2 — текстом из `MESSAGES` фронта; RW-14+ в макете не заведены |
| Генератор временного пароля на фронте (`roles.js`, окно сброса пароля) | Временный пароль выдаёт сервер (`temporary_password` в ответе, показывается один раз; повтор — `409 password_already_issued`) |
| Журнал изменений без `changes[]` и `source` (`roles.js:109`, `logAudit`) | `GET /api/v1/audit`: `changes:[{column,old,new}]`, `source: ui|agent`, `proposal_id` |
| Подписант приказа по ФИО (`app.js:260, 322`) | `signed_by_id` = `employee_id` из `GET /orders/signers`, директор первым |

Список не полный: при расхождении всегда прав API, а не макет.
