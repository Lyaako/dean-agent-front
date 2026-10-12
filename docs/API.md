# API, совместимый с текущим фронтендом

Этот документ фиксирует обращения зафиксированного React. Очередь/передача, раздельные состояния исполнения и использование вложений добавляют серверные маршруты и поля по разделам 5 и 9 [DETAILED_IMPLEMENTATION_PLAN.md](DETAILED_IMPLEMENTATION_PLAN.md). Рабочий React подключает текущий API; полнота фактической проверки описана в [прогрессе](IMPLEMENTATION_STATUS.md).

Полный OLAP, серверные чаты, стипендии, коррекция закрытой оценки и согласованные отмены реализованы. Действуют [контракт чатов](CHAT_API_CONTRACT.md), [SSE](SSE_API_CONTRACT.md) и [коррекция](GRADE_CORRECTION_CONTRACT.md). Новые расширения требуют отдельного согласования. Head0039 включает последние подтверждённые ограничения: root-контакты admin-only, новая стипендия сегодня/будущее.

Префикс `/api/v1`. Источники контракта: ветка **react-frontend**, `frontend/src/api/{auth,client,schema,resources,agent,files,errors}.ts`, `WorkflowDialog`, `RecordDialog`, `useChat`, `useAttachments`. Версия закреплена в [FRONTEND_VERSION.md](FRONTEND_VERSION.md). Форматы ниже — текущий контракт; его реализация и проверка отдельных сценариев учитываются отдельно.

Обычные DB-зависимости завершают транзакцию до отправки HTTP-ответа (`scope="function"`): успешные login/refresh уже видимы следующему запросу, logout204 уже отозвал сессию. Actor и маршрут используют одну cached connection. SSE сохраняет собственные короткие транзакции до открытия потока; FileResponse использует проверенный путь без удержания DB connection. Native ASGI/independent DB before/after proof и настоящий two-tab browser подтверждены в P12/task12.

## 1. Маршруты без изменения клиента

| Метод и путь | Вход / заголовки | Ответ |
|---|---|---|
| `POST /auth/login` | `{login,password}`, credentials include | `{access_token,csrf_token}`; HttpOnly refresh cookie |
| `POST /auth/refresh` | cookie, `X-CSRF-Token`, JSON `{}` | `{access_token}`; ротированная cookie |
| `GET /auth/me` | `Authorization: Bearer …` | `Me`, см. ниже |
| `POST /auth/logout` | Bearer и cookie | `204`, отзыв сессии и очистка cookie |
| `GET /health/ready` | Без credentials | `200 {"status":"ready"}` при готовой БД/схеме API; иначе503 с безопасным `error_code`. Модель не выключает готовность форм |
| `GET /schema` | Bearer | `{version:number,resources:Record<string,ResourceSpec>}` |
| `GET /resources/{name}` | Bearer; limit, offset, sort и фильтры | `{items,limit,offset,has_more}` |
| `POST /resources/{table}` | JSON полей, Bearer | Сохранённая строка `Row`, не proposal |
| `PATCH /resources/{table}` | PK в query, JSON изменённых полей | Сохранённая строка `Row` |
| `PATCH /resources/person?person_id={id}` | `{last_name?,first_name?,middle_name?}` из формы сотрудника | Сохранённая person с разрешёнными полями; проверка права менять ФИО именно этой персоны |
| `DELETE /resources/{table}` | PK в query | `204` либо удалённая строка; запрет зависимых/официальных записей |
| `POST /workflows/{name}` | JSON по существующей форме; Idempotency-Key | `{student_id,order_id,status,effective_date}`; status `pending` для будущего приказа, `applied` для применённого |
| `GET /agent/capabilities` | Bearer | Совместимый `attachment_context` и отдельный `services`, см. ниже |
| `POST /agent/chat/stream` | `{message,session_id?,attachments?}`, Bearer, Accept SSE | `text/event-stream`, ровно события текущего клиента |
| `GET /agent/proposals/{id}` | Bearer | `Proposal`, доступ только автору/разрешённому согласующему |
| `POST /agent/proposals/{id}/decision` | `{approve:boolean,reason:string,expected_version:int}`, Idempotency-Key | Полный актуальный `Proposal`; решение и исполнение отдельно |
| `POST /files` | multipart: `file`, `title`, `purpose:"attachment"`; Idempotency-Key | `{file_id,version_id,job:Job}` |
| `GET /jobs/{id}` | Bearer | `Job` с прогрессом и результатом обработки |
| `GET /files/{file_id}/versions/{version_id}/download` | Bearer | Оригинал версии, корректный MIME и Content-Disposition |

`X-Actor-ID` и общий approval token прежнего прототипа не являются авторизацией. Отдельные `/students`, `/operations/.../preview`, `/agent/runs`, `/proposals` не нужны: клиент их не вызывает.

## 2. Авторизация и ошибки

```json
{"user_id":7,"login":"dean.staff","roles":["dean_staff"],"person_id":12,"institute_ids":[1],"student_id":null,"teacher_id":null}
```

Все поля `Me` присутствуют; nullable-поля — `null`. Значения определяет БД, а не request body. ФИО фронтенд отдельно читает через `/resources/person?person_id=12&limit=1`, поэтому собственная person должна быть доступна любой роли для разрешённых полей.

Refresh защищён CSRF + Origin. CSRF хранится в localStorage; Web Locks клиента сериализует ротацию общей refresh cookie между вкладками. Остальные защищённые действия требуют Bearer и проверки Origin: текущий `apiRaw` не отправляет X-CSRF-Token во все CRUD-запросы. Нельзя сделать его обязательным на этих маршрутах без изменения клиента. CORS и reverse proxy не дают стороннему origin читать/использовать токен.

```json
{"error":{"code":"domain_conflict","message":"Занятие пересекается с существующим","details":null},"request_id":"<uuid>"}
```

Также отдаётся `X-Request-ID`. Коды lowercase, ровно как в `api/errors.ts`: `invalid_credentials`, `login_rate_limit`, `invalid_origin`, `invalid_token`, `inactive_session`, `forbidden`, `validation_error`, `invalid_filter`, `invalid_value`, `required_field`, `constraint_violation`, `duplicate`, `relationship_conflict`, `period_conflict`, `concurrent_change`, `domain_conflict`, `not_found`, `query_timeout`, `database_unavailable`, `idempotency_conflict`, `body_too_large`, `agent_unavailable`, `agent_busy`, `session_busy`, `session_not_found`, `agent_error`, `agent_protocol_error`, `agent_outcome_unknown`, `agent_attachments_unsupported`, `proposal_not_found`, `proposal_decided`, `proposal_expired`, `stale_proposal`, `file_not_ready`.

Проверка входа и прав выполняется до запуска модели/операции, в том числе перед автоматическим повтором после `401`. Исключения PostgreSQL переводятся в безопасные коды без DSN, SQL и содержимого закрытых полей. Недоступный объект возвращает `404`, если его существование нельзя раскрывать.

## 3. Schema и ресурсы

```json
{
  "version":1,
  "resources":{
    "student":{
      "kind":"table","key":["student_id"],
      "fields":{
        "student_id":{"type":"integer","nullable":false,"default":"identity","description":"Идентификатор студента","relation":null},
        "funding_type_id":{"type":"integer","nullable":false,"default":null,"description":"Основа обучения","relation":{"table":"funding_type","column":"funding_type_id","on_delete":"NO ACTION"}},
        "needs_dormitory":{"type":"boolean","nullable":false,"default":"false","description":"Нуждается в общежитии","relation":null},
        "is_foreign":{"type":"boolean","nullable":false,"default":"false","description":"Иностранный студент","relation":null}
      },
      "read_fields":["student_id","funding_type_id","needs_dormitory","is_foreign"],
      "write_fields":["funding_type_id","needs_dormitory","is_foreign"],
      "read_roles":["admin","director","dean_staff","teacher","student"],
      "write_roles":["admin","director","dean_staff"],
      "operations":["read","update","workflow"],
      "operation_roles":{"read":["admin","director","dean_staff","teacher","student"],"update":["admin","director","dean_staff"],"workflow":["admin","director","dean_staff"]},
      "workflow_only":["group_id","status_id"]
    }
  }
}
```

Это иллюстрация формы ответа, не окончательная матрица прав. Реальные fields/read_fields включают все разрешённые поля, необходимые фронту; паспортные поля и password_hash не выдаются автоматически. Полный реестр формируется из проверенных метаданных PostgreSQL и кодовой политики. Имя/тип поля должны совпадать с `format_type`: `integer`, `boolean`, `character varying(n)`, `numeric(p,s)`, `timestamp with time zone`, а не самодельное `INT/VARCHAR` из справочного JSON.

Нельзя выдавать только FK ID: lookup ожидает полные разрешённые строки и конкретные псевдонимы представлений. Ключи могут быть составными. GET допускает фильтр по разрешённому полю, не только по PK: RequestsPage ищет `employee` по `person_id`. PATCH/DELETE требуют полный PK и запрещают его изменение.

Для новой формы сотрудника `/schema.resources.person` описывает last_name/first_name/middle_name с русскими descriptions и nullable, а операция update разрешается только требуемой роли/области. Для сотрудника person_id задаётся при создании и не меняется после него. У academic_work, practice_placement, document_request student_id задаётся при создании и также не меняется после него. UI lockOnEdit не заменяет серверный запрет.

Сохранение сотрудника с ФИО и реквизитами вызывает два PATCH последовательно: person, затем employee. Сервер возвращает сохранённую строку в каждом запросе; общей атомарности двух запросов текущий контракт не предоставляет.

`limit` 1..500, `offset` >=0. Стабильная сортировка по указанным разрешённым полям и ключу для равных значений. `sort=lesson_date,pair_number,group_name`, `lesson_date__gte`, `lesson_date__lte` обязательны для календаря. Точные фильтры `person_id`, `student_id` и остальных разрешённых полей валидируются по типу. Неизвестный фильтр/поле — ошибка, без вставки SQL-фрагмента.

DATE — `YYYY-MM-DD`, TIME — строка времени, TIMESTAMPTZ — ISO 8601 с зоной, numeric — точная строка; frontend умеет сравнивать numeric-строки. `null` отличается от отсутствующего поля PATCH. Идентификаторы остаются числами в безопасном диапазоне JS; большие audit ID передаются строками.

## 4. SSE и результат агента

```json
{"message":"Покажи задолженности ИДБ-23-11","session_id":"<uuid>","attachments":[{"file_id":"<uuid>","version_id":"<uuid>"}]}
```

Первая беседа не содержит session_id. Сервер сразу создаёт принадлежащую пользователю сессию и отдаёт событие `session`. Чужой/удалённый ID — `session_not_found`; параллельный запуск в той же сессии — `session_busy`.

В новой ветке можно отправить одни файлы: frontend сам подставляет непустое `message: "Вложения: имя1, имя2"`. Прежняя проверка непустого сообщения сохраняется, но обработка опирается на проверенные attachments, а не на перечисленные имена. Отложенная отправка ждёт готовности job; backend не получает новый специальный endpoint. Черновики отделены по чатам на клиенте.

| event | data |
|---|---|
| `status` | `{phase,message,elapsed_s?}` |
| `session` | `{session_id,run_id}` |
| `tool_call` | `{name,run_id,input}` — безопасная сводка разрешённых аргументов |
| `tool_result` | `{run_id,output,truncated}` — ограниченная безопасная строка |
| `done` | `{run_id,session_id,answer,proposals,tools_used,attachment_context?}` |
| `error` | `{type,message,run_id?,session_id?}` |

`done.answer` — Markdown с текстом, таблицами, источниками, который уже отображает ReactMarkdown. Не вводятся новые `blocks` или обязательные события, для которых нет renderer. Предложения создаёт сервер, а не текст модели. SSE без буферизации, с heartbeat-комментариями и завершающей пустой строкой; TCP-чанки могут делить UTF-8/JSON. Токеновая анимация не обязательна: текущий frontend ждёт конечный `done`.

После открытия SSE ошибка отправляется событием `error`; до открытия — обычным HTTP error. Текущий `error`-обработчик показывает `message`, поэтому сообщение должно быть безопасным и понятным. По прямому подтверждению пользователя обрыв связи/перезагрузка больше не останавливают run: клиент переподключается к тому же запуску и получает пропущенные события/итог без дубликатов. «Остановить» требует явной серверной команды, которую один AbortController не заменяет. Точные маршруты запуска/подписки/остановки, идентификаторы и курсор ещё согласуются по разделу 5.6 актуального плана; старый клиент этого пока не реализует.

## 5. Предложения

```json
{
  "id":"<uuid>","status":"pending","sql_text":"<нормализованный SQL разрешённой записи или пустая строка для workflow>",
  "explanation":"Создать заявку на справку","reason":"Заявление студента №24",
  "decided_by":null,"decision_reason":null,
  "preview":{"operation":"INSERT","table":"document_request","affected_rows":1,"before":null,"after":{"student_id":103,"document_type_id":1,"copies":1},"changed_columns":["student_id","document_type_id","copies"],"snapshot_hash":null,"related_effects":[],"note":null,"applied":null}
}
```

Summary в `done.proposals` содержит только `id,preview,explanation,reason`. UPDATE содержит before и snapshot_hash. Workflow также представляется существующим preview: основная таблица student/person/academic_leave, INSERT либо UPDATE, дополнительные эффекты описаны в related_effects/note. Сохранённая серверная команда определяет выполнение; sql_text не исполняется повторно как непроверенный код и не содержит секретов.

Комментарий решения — 10..2000 символов, как в `useProposal`. Успешный статус `approved` публикуется после транзакции; повтор того же Idempotency-Key с тем же телом возвращает прежний результат, с другим — `idempotency_conflict`. Решение не принимает новые параметры изменения. Чужая роль/область не получает право от наличия UUID.

## 6. Файлы

`POST /api/v1/files` принимает Bearer, разрешённый Origin, UUID `Idempotency-Key` и ровно три multipart-поля: `file`, `title` (1..255 символов), `purpose=attachment`. Ответ201: `{file_id,version_id,job}`. Аутентификация выполняется до чтения тела; считаются реальные байты потока, проверяются имя, расширение, MIME и сигнатура. Повтор того же ключа и содержимого возвращает прежнюю версию; другое содержимое даёт409 до публикации оригинала. Оригинал и SHA-256 неизменяемы.

`Job`: `id,kind,status,attempts,max_attempts,progress,result,error_code`. Для `kind=attachment` status — `queued/running/succeeded/failed`; состояние `cancelled` прежних задач приказов сохраняется. Progress0..100 описывает извлечение. `GET /api/v1/jobs/{id}?page_offset=0&page_limit=100` выдаёт метаданные, `extraction_state`, coverage, warnings и окно описаний страниц без текста/путей. `page_limit`1..100. `succeeded` может означать `partial`: клиент обязан показать предупреждения и число неуспешных/необработанных страниц. Полнота OCR не означает, что весь файл передан модели.

`GET /api/v1/files/{file_id}/versions/{version_id}/download` возвращает исходные байты с `Cache-Control: private, no-store` после текущей проверки прав и контрольной суммы. Чужой/неверный ID даёт404. Владельцу доступен original ещё до завершения извлечения. Заимствованная версия доступна только через точную связь с предложением и действующее право согласования; UUID сам по себе прав не даёт. Задача извлечения видна только владельцу.

Capabilities:

```json
{"attachment_context":{"protocol":"deanery.attachments.v1","backend_supported":true,"agent_supported":true,"agent_status":"ready","max_attachments":5,"max_total_bytes":20000000,"max_text_chunks":20}}
```

Поддержка включена после независимой приёмки и реального Qwen/file run. `agent_supported` отражает поддержку формата; `agent_status` сохраняет толькоready/unavailable и требует точную loaded model/context, откалиброванный static request и свежий agent-worker heartbeat. `services` отдельно возвращаетmodel,calibration,embedding,index,agent_worker,file_worker,knowledge_worker,order_worker; calibration может бытьuncalibrated, остальныеready/unavailable. Три параллельные read-only metadata GET ограничены1.5s каждый и64KiB, без redirects/proxy/inference/index creation; support-флаги от сбоя не меняются. BGE/index failure не выключает формы и обычное чтение агентом. Worker marker свежий45s и обновляется после committed poll/renew; отсутствующий worker даётunavailable. Эти проверки не доказывают правильность ответа модели. Partial/manifest уже подключены в рабочем React, полная browser приёмка ещё продолжается. Неготовый файл даёт409 `file_not_ready`, недоступный —404, неподдерживаемый context —412 `agent_attachments_unsupported`, превышение совокупного размера —413 `body_too_large`.

Фронт принимает PDF/DOCX/TXT до 10 000 000 байт за файл, до 5 файлов и 20 000 000 байт суммарно. Проверки повторяются на сервере; MIME из браузера не считается доказательством содержимого.

`GET /api/v1/agent/runs/{run_id}/attachment-context` возвращает владельцу проверенный manifest запуска: выбранные версии, фактически отправленные начальные chunks, результаты последующих чтений, подтверждение ответа провайдера и предупреждения. Доступ проверяется заново, в том числе для источников прошлых сообщений. Только разрешённые отправленные chunks могут стать цитатой/источником предложения. Состояния partial/stopped/неподтверждённая доставка не превращаются в заявление о полном чтении. Текст, пути хранения, произвольные URL и слова модели «прочитано» не являются доказательством.

Текущий Qwen text-only получает до2000 символов начального контекста, до2000 на `read_attachment_text`, до8000 новых символов/20chunks за run, дополнительно ограниченных реальным окном16384 с system/tools/history/output. Все страницы PDF обрабатываются независимо от этих лимитов. Детали изоляции и запуска — [FILES_RUNTIME.md](FILES_RUNTIME.md).

## 7. Внутренние операции, без новых экранов

Нормативные версии обслуживает приватная CLI `python -m backend.regulations`: `import`, `get-version`, `reindex`, `withdraw`. Каждый вызов требует отдельного DB login с точными операторскими функциями и живого access token активного admin из приватного файла. Обычные роли API/agent/executor/worker таких grants не имеют; frontend и model tools не вызывают эти операции. Настройка и примеры — [KNOWLEDGE_RUNTIME.md](KNOWLEDGE_RUNTIME.md).

Импорт принимает original PDF/DOCX/UTF-8 TXT до10MB, явные title/source/version label/scope и UUID ключ повтора. Подтверждённые даты и source URL необязательны, отсутствующие значения остаются null. URL служит ссылкой источника, сеть при импорте не запрашивается. Original/hash/metadata/chunks неизменяемы; пользовательское вложение не становится нормативной версией. Аудит связывает import/reindex/publication/withdraw с аутентифицированным admin.

Успешная complete digital extraction и проверенный индекс автоматически публикуют версию. Скан, растровая часть PDF, невычитанные DOCX images, partial или ошибка остаются неопубликованными. Worker создаёт candidate generation; PostgreSQL переключает active generation только после точного count/hash receipt. Во время reindex прежняя опубликованная версия остаётся доступной; ошибка не удаляет её индекс. `get-version` показывает metadata, coverage, processing state, опубликованность и последнюю job с error_code. Withdraw немедленно исключает версию через текущую проверку БД; старые векторные точки сами не дают доступа. Scope версии неизменяем: новый scope требует новой версии и явного отзыва старой.

## P12 клиентские границы

Рабочий frontend использует те же auth/resources/workflows. Текущие chat/proposal/SSE contracts определяются CHAT_API_CONTRACT/SSE_API_CONTRACT; исторические описания выше не заменяют их. OLAP eighth tab подключён к GET /olap с mode/group_id/discipline_id/semester/status_id и rows/total/semesters/scale. Weighted avg и долги считаются сервером.

После401 frontend автоматически повторяет GET/HEAD и мутацию с тем же Idempotency-Key. Для ordinary POST/PATCH/DELETE без ключа успешный refresh даёт локальный `session_refreshed` с предложением повторить форму явно. `session_changed` защищает от ответа прежнего аккаунта. `resource_too_large` также локален:40 страниц по500 с оставшимся has_more не выдаются за полную таблицу. Эти коды не вводят серверные маршруты. Employee остаётся двумяPATCH; UI сохраняет baseline первого person и явно сообщает отказ второго employee.

Frontend файлы, пройденные Node assertions и ещё необходимая browser/API/DB матрица — [FRONTEND_INTEGRATION.md](FRONTEND_INTEGRATION.md). Реализация не означает завершённую P12 приёмку.

P12 forward0037/SQL030 включает существующий `discipline` catalog в authenticated manual `GET /resources/discipline` и `/schema` для всех5roles. Только read:write403. Сохраняется исходный token/session/current-account gate; существующая agent catalog policy иstatic13tool prompt не меняются. Это lookup числовых discipline_id/name для OLAP, не новая форма CRUD. Проверено на отдельной UIclone, полный finalrole/button gate остаётся открытым.

## Очередь предложений: актуальное расширение P12

GET `/agent/proposals` принимает `box=incoming|mine|completed`, `status=pending|approved|rejected`, `execution_status=not_started|scheduled|running|succeeded|failed|cancelled`, `limit`1..100 и `offset`≥0. Новые необязательные фильтры: `author` — буквальная подстрока имени или login, без учёта регистра, с trim, не более200 символов; `created_from`/`created_to` — ISO календарные даты. Начало from включительно, начало дня после to исключительно, часовой пояс Europe/Moscow независимо от timezone соединения. Неверные даты, обратный диапазон и превышение длины дают422. `%`/`_` не являются wildcard.

Ответ `{items,limit,offset,has_more,counts:{incoming,mine,completed}}`: действующие права ограничивают строки до фильтрации; все фильтры применяются до подсчёта каждой коробки и стабильной страницы `created_at DESC,id DESC`. Counts относятся к тем же условиям, а не ко всей видимой очереди. Исполнение scheduled/failed/cancelled остаётся отдельным от подтверждённого решения. Mine включает собственные предложения; обычные expired/stale могут попасть в History, submitted correction остаётся в Incoming до решения по специальному контракту.

GET `/agent/proposals/{id}` возвращает также version, kind, submission_status, correction_id, created_at/expires_at, initiator, routing, validity, execution, actions и context_files. Клиент не вычисляет право решения по роли: использует `can_claim`, `can_assign`, `can_submit`, `can_approve`, `can_reject`. Контекстные файлы содержат точные file/version/chunk IDs и защищённый download; reviewer не запрашивает чужой run attachment-context.

GET `/{id}/assignees` возвращает действующих допустимых сотрудников; GET `/{id}/events?after=0&limit=25` — `{items,has_more}`, курсор следующей страницы равен последнему event.id. POST `/{id}/assignment` принимает `{assignee_user_id,reason,expected_version}`; claim передаёт свой user_id. Null-assignee/unassign не поддерживается: «Отменить передачу» закрывает форму без запроса. POST `/{id}/submit` принимает `{expected_version}`. Обе операции и decision требуют Idempotency-Key и возвращают полный Proposal.

Каждая логическая попытка сохраняет точные body/version/key. Неизвестный сетевой/серверный результат разрешает явный повтор той же попытки; после определённого отказа новое намерение получает новый ключ. Correction draft подаёт автор, submitted решает другой фактический директор/заместитель директора института; роль admin сама по себе это право не даёт. Миграция0036/SQL029 расширяет существующую list-функцию без новых таблиц, сохраняет6-аргументный SQL wrapper и минимальные grants.
