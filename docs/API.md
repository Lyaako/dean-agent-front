# API, совместимый с текущим фронтендом


## Согласованные дополнения Б1–Б11, 15.10.2026

Текущий head — `0063_stale_agent_runs`. Ниже — дополнения к прежнему контракту; прежние маршруты и поля сохраняются. Фронтенд коллеги подключается отдельно. Схема и флаги действий сервера определяют доступность кнопок; наличие роли admin само по себе не разрешает решить коррекцию.

Все новые POST изменений требуют обычной авторизации и проверенного `Origin`. В перечисленных маршрутах, кроме смены пароля/выхода, нужен заголовок `Idempotency-Key: UUID`. Повтор того же решения с тем же ключом возвращает существующий результат, в том числе после закрытия ведомости; он не выполняет запись повторно.

| Маршрут | Запрос / результат | Доступ |
| --- | --- | --- |
| `POST /api/v1/auth/password` | `{current_password,new_password}`; 204; новый пароль 8–1024 символа, отличается от текущего | Свой аккаунт; остальные сеансы отзываются |
| `POST /api/v1/auth/logout-all` | 204, отзыв всех собственных сеансов | Все роли |
| `GET /api/v1/me/profile` | Собственные данные и роль; для сотрудника должность/подразделение/ставка/дата приёма, для студента учебные реквизиты | Все роли |
| `POST /api/v1/admin/users/{user_id}/reset-password` | `{user_id,temporary_password,must_change_password:true}`; пароль показывается ровно один раз | Только admin; все сеансы адресата отзываются |
| `GET /api/v1/orders/signers?institute_id=N` | `{items:[{employee_id,person,position,is_director}]}`; действующие директор/заместители, директор первым. Значение для `signed_by_id` — `employee_id` | Деканат своего института, admin |
| `POST /api/v1/orders/{order_number}/students/{student_id}/cancel` | `{}`; отмена будущего неисполненного приказа и задания, результат сохраняется. `order_number` передаётся в пути закодированным (`encodeURIComponent`) и может содержать «/», например `151-%D1%81%2F26` для «151-с/26» | Деканат в своей области; правила БД, включая запрет отмены зачисления |
| `GET /api/v1/resources/grade_sheet/{sheet_id}/missing` | `{items:[{student_id,student}]}` | Деканат; активные студенты группы без записи основной ведомости; для пересдачи `[]` |
| `POST /api/v1/grade-corrections` | `{sheet_id,student_id,new_points,new_is_absent,reason}`; Proposal с `submission_status=submitted` | Экзаменатор своей закрытой ведомости или деканат; reason 10–2000 символов |
| `POST /api/v1/agent/proposals/{id}/undo` | `{picked_item_ids?:[int]}`; применённое обратное Proposal. Без `picked_item_ids` — все обратимые строки (переходный режим) | Тот же решающий, до 15 минут, только обратимые строки |
| `GET /api/v1/audit` | Журнал событиями, см. «Журнал изменений» | admin — весь; director, dean_staff — свой институт; teacher, student — 403 |

`GET /api/v1/agent/capabilities` сохраняет `attachment_context.agent_status` для всех ролей; подробный объект `services` выдаётся только admin.

`Me.must_change_password` — добавленное булево поле. До обязательной смены доступны только `auth/me`, `auth/password`, `auth/logout`; остальная работа, включая запуск агента/SSE и refresh, получает `403 password_change_required`. Повтор запроса одноразового сброса не раскрывает пароль: `409 password_already_issued`. Пароли не попадают в журнал и ответы списка учётных записей.

### Формы и чтение

`employee` — только чтение для всех. `person` меняет только ФИО под admin/director/dean_staff в допустимой области. `app_user` читается только admin и выдаёт ровно `user_id,login,person,role,is_active,last_login_at`. Добавление пользователей, реквизиты сотрудника и привязка личных ролей — операция оператора БД.

Создание и изменение разрешены деканату для 11 справочников: `scholarship_type, document_type, request_status, order_type, leave_reason, contact_relation, specialty, study_program, classroom, academic_term, holiday`. Удаление справочников не добавлено; остальные справочники читаются. Ключ `holiday` — дата. Программа ограничена институтом. Все ограничения PostgreSQL действуют, пересекающиеся учебные периоды дают 409.

`grade_sheet`: создание деканатом, изменение `status,exam_date,closed_date`. `grade` и `attendance`: создание/изменение деканатом или преподавателем только своей ведомости/занятия; закрытые ведомости неизменяемы. Баллы — 25–54 либо null, неявка несовместима с баллами. Преподаватель не получает право редактировать предметные записи другого экзаменатора.

Студент читает только свои `grade,grade_sheet,attendance,v_attendance,v_last_result,v_debtors,v_current_modules,v_active_scholarships,v_student_orders`. Текущие модули определяются семестром его текущей группы, последней попыткой по дисциплине/этапу. Стипендия содержит сумму конкретного назначения. Студент создаёт свою заявку и меняет только `copies,purpose` своей заявки в статусе «Новая»; удалить её через API не может. Деканат удаляет заявки любого статуса в своей области.

Ресурс `v_audit` (строка на поле) сохранён без изменений; для экрана журнала используйте `GET /api/v1/audit`. `v_audit` доступен деканату с ограничением института, включая правки персон студентов; admin видит весь журнал. Паспортные данные, СНИЛС/ИНН, адрес, дата рождения и хэш пароля исключены. Фильтры `changed_at__gte`, `changed_at__lte` принимают ISO-даты/время; дата верхней границы включает весь день по Москве. Календарь сохраняет фильтры `lesson_date__gte/lte`. Обычные списки сортируются/фильтруются и разбиваются на страницы в SQL; `limit=1..500`, `offset>=0`, `has_more` рассчитывается по следующей строке.

### Пакетные предложения и отмена

Добавлен `kind=batch`. Модель получает 14-й инструмент `prepare_batch_changes(items,explanation,reason,attachment_chunk_ids?)`. Каждый входной item: `{item_id,resource,operation:create|update,key,fields}`. Только разрешённые агенту INSERT/UPDATE, без DELETE, приказов, коррекций; не более 200 строк. Значения полей буквальные. Повтор одного поля одной записи в пакете запрещён.

Добавленное поле Proposal `items`: `[{item_id,table,key,field,before,after,snapshot_hash,state,message}]`. Здесь `field` — массив изменяемых имён (строка пакета может менять несколько полей), `before` — прежняя полная разрешённая запись/null при вставке, `after` — новые значения полей. `preview.items[].after` содержит полный прогноз записи. `state`: `ok|already_done|conflict|gone|rule_violation`. Детальное GET также проверяет ограничения БД без сохранения пробной записи; список очереди использует быстрые состояния снимка.

В прежний `POST .../decision` добавлено `picked_item_ids:[1,2,...]`: для одобрения batch обязателен непустой уникальный набор существующих item_id. Только выбранные строки записываются одной транзакцией. Одна устаревшая выбранная строка откатывает весь пакет (`stale_item`, `details.item_id`). Неотмеченные строки не исполняются. Отклонённое/одобренное предложение не решается заново; повтор существующего ключа не создаёт второго эффекта.

Преподаватель подтверждает собственные grade/attendance; другие изменения подтверждает деканат. Такие преподавательские строки нельзя смешивать с темами работ в одном пакете. Коррекцию решает другой действующий директор/заместитель института группы; admin должен действительно занимать эту должность. Отсутствие подходящего руководителя — `correction_manager_missing`, без создания предметной коррекции.

`actions.can_undo` добавлен к прежним флагам. Обратимы `document_request.request_status_id` между незавершёнными статусами, `academic_work.topic`, `student.needs_dormitory`, `schedule_slot.classroom_id/weekday/pair_number`, `grade.points/is_absent` в открытой ведомости, `attendance.is_present/absence_reason`. Добавления и другие поля пропускаются; результат обратного предложения сообщает `execution.skipped`, исходное — `execution.undo_skipped/undo_id`. Если ни одной обратимой строки нет — `undo_unavailable`. Если после применения изменена любая из выбранных обратимых строк, отмена целиком откатывается с `undo_changed` и item_id; проверяются полная строка и номер аудита, поэтому изменение и возврат к прежнему значению также обнаруживаются. Перед сверкой берутся блокировки предметных данных: конкурирующая ручная правка не затирается. Повтор undo с тем же ключом возвращает то же обратное предложение.

### Решения Р1–Р9, 16.10.2026 (миграция `0057_decision_contract`)

**Комментарий к решению.** `POST .../decision` для `kind=grade_correction`: `reason` 10–500 символов после обрезки (столбец `grade_correction.decision_comment VARCHAR(500)`); иначе 422 `validation_error`, `details:{field:"reason",max:500}`. Для остальных видов — 10–2000, как раньше. Отказ без комментария невозможен (поле обязательно).

**Передача.** `POST .../assignment`: `reason` 10–2000 символов после обрезки; иначе 422 `validation_error`, `details:{field:"reason"}`.

**Повтор просьбы.** `actions.can_redo` есть во всех ответах Proposal: истинен у автора, если предложение создал запуск агента, оно истекло (`validity.state=expired`) или отклонено и чат не удалён. `GET /agent/proposals/{id}` дополнительно отдаёт `request_text` — исходный текст просьбы, только автору агентного предложения; иначе `null`. В списке очереди `request_text` нет. Для `kind=grade_correction` (с миграции `0061_redo_grade_correction`) правило своё, одинаковое для формы и агента: `can_redo` истинен у автора, если предложение отклонено и по той же оценке нет заявки в статусе `pending` или `approved`; срока у исправлений нет. Повтор — новая заявка `POST /grade-corrections` с той же ведомостью и студентом, отдельного маршрута нет; `request_text` у заявки через форму — `null`.

**Обратимость строк пакета.** У `items[]` пакета: `reversible:boolean`, `undo_reason: null|irreversible|sheet_closed|request_final|expired`. До одобрения — прогноз по полям и текущим данным; после одобрения — по применённой строке, после окна 15 минут или выполненной отмены — `expired`; неприменённая строка — `reversible=false, undo_reason=null`. `actions.can_undo` ложен, если обратимых строк нет или срок истёк. **Подписи строк** (с миграции `0062_batch_labels`): у каждой строки `items[]` и `preview.items[]` пакета есть `label: {record, sub, fields}` — подпись записи по-русски по текущим данным: `student` — ФИО и шифр группы; `grade` — ФИО и номер ведомости; `attendance` — ФИО и «дата · N пара · дисциплина»; `document_request` — «Заявка № N» и «вид справки · Фамилия И. О.»; `academic_work` — ФИО и «Курсовая работа»/«ВКР»; `schedule_slot` — «дисциплина · группа» и «день недели · N пара»; остальные — описание таблицы и ключ `col=value`. Новая запись подписывается по своим значениям («Новая заявка» и т. п.); если не из чего — описание таблицы и «новая запись». `fields` — названия изменяемых полей по `col_description` (`{"needs_dormitory": "Нуждается в общежитии"}`). Подпись видна всем, кто видит предложение, даже если сама запись вне их вкладок; в `snapshot_hash`, `state` и проверки не входит.

**Отмена по выбранным строкам.** `POST .../undo` с `picked_item_ids` (непустой, без повторов, только применённые строки, иначе 422 `validation_error`, `details.field="picked_item_ids"`) отменяет ровно эти строки одной транзакцией. Если хоть одну отменить нельзя, ничего не отменяется: 409 с `details:{item_id,reason}` — `undo_changed`/`changed` (строку изменили после применения) или `undo_unavailable`/`irreversible|sheet_closed|request_final|conflict` (`conflict` — правило базы отклонило возврат, например аудитория занята; текст ошибки базы в `message`). Ключ идемпотентности привязан к набору строк: тот же ключ с другим набором — 409 `idempotency_conflict`. Ошибка всей отмены `undo_unavailable` содержит `details.reason` (`expired` — срок истёк или отмена уже выполнена; `irreversible`; либо общая причина строк). `execution.skipped`/`undo_skipped`: `[{item_id,code,reason}]`.

**Журнал изменений.** `GET /api/v1/audit?changed_at__gte&changed_at__lte&table_name&operation=I|U|D&changed_by=<логин>&source=ui|agent&limit=1..500(100)&offset`. Ответ `{items,limit,offset,has_more}`, сортировка от новых. Событие: `{audit_id:string,changed_at,table_name,record_key,operation:"I"|"U"|"D",changed_by,changed_by_name,source:"ui"|"agent",proposal_id,changes:[{column,old,new}]}`. `limit` и `has_more` считают события, одно изменение не делится между страницами. `source=agent` — только изменения из запуска агента; формы (в том числе исправление оценки и отмена через форму) — `ui`. `proposal_id` — предложение, через которое прошло изменение, иначе `null`. Паспорт, СНИЛС, ИНН, дата рождения, адрес и хэш пароля приходят как `***`. Даты — как у ресурсов: верхняя дата включает весь день по Москве.

### Ведомости преподавателя, 16.10.2026 (миграция `0058_teacher_sheets`)

**Чтение для teacher.** Кроме групп и строк плана текущих поручений, преподаватель видит строку `curriculum_item`/`v_curriculum` и группу `study_group`/`v_groups`, если он экзаменатор (`grade_sheet.examiner_id`) хотя бы одной ведомости по ним. Набор полей не меняется. Студенты, расписание, работы, практики и OLAP по-прежнему ограничены текущими поручениями.

**Состав ведомости.** `GET /api/v1/resources/grade_sheet/{sheet_id}/roster` → `{items:[{student_id,student,active,grade_id,points,is_absent}]}`, сортировка по ФИО; `grade_id=null` — результата ещё нет. Правила (как `trg_grade_check`/`trg_sheet_status`): закрытая или отменённая — студенты с оценкой в ней; открытая `main` — обучающиеся студенты группы плюс все с оценкой; открытая `retake`/`commission`/`individual` — с оценкой плюс обучающиеся, у кого есть несданная попытка того же этапа по дисциплине (discipline_id + semester) в ведомости этой группы, нет попытки с баллами ни в одной группе и нет оценки в другой открытой ведомости этого этапа (с миграции `0059_retake_roster_group`). Доступ: admin, director, dean_staff — ведомость в их области; teacher — только где он экзаменатор; иначе 404 `not_found` (как для несуществующей). Отдаются только ФИО и `active`.

**Запланированные приказы (проверено, без изменений).** Деканат читает `v_pending_orders` (`order_type_code`, `due_date`, `days_left`) в области своего института; преподавателю и студенту ресурс недоступен. После `cancel` строка `order_student` удаляется, приказ пропадает из `v_pending_orders` и `v_student_orders`; статуса «Отменён» нет. Отмена зачисления — `order_cancel_enrollment`.

### Пять новых режимов OLAP

Прежние восемь mode сохраняются. Добавлены `session,heat,risk,retake,moves` для admin/director/dean_staff и teacher; преподаватель видит только группы текущих поручений, студент получает 403. Ответ `{mode,level,rows,total,filters}` (у `risk` ещё `points`). Фильтры: `course,group_id,discipline_id,semester,status_id`; `mod_min=25..54` (30), `att_min=0..100` (70 с миграции `0060_olap_metrics`, раньше 75), `period=month|semester|year`, `pick` для периода движения. В `filters` возвращаются все применённые значения, включая подставленные по умолчанию.

**Общие определения (`session`, `retake`).** Ключ результата — (студент, `discipline_id`, `semester`), этап `final`, как в `v_last_result`. Попытка, с которой сдано, — вид ведомости самой ранней записи с баллами по ключу (порядок `exam_date`, затем `sheet_id`); нет такой — `null`. С первого раза — `main` или `individual`. Долг сессии — ключ, не сданный с первого раза. Сессия студента — семестр `current_semester − 1` его группы (при `current_semester = 1` сессии нет).

**`session` — итоги сессии.** `level=course` (по умолчанию) | `group` (нужен `course`) | `discipline` (нужен `group_id`) | `result` (нужны `group_id`, `discipline_id`); `student` — синоним `result`. `semester=1..12` — общая сессия для всех вместо `current_semester − 1`. Ошибки параметров — 422 `validation_error`, `details.field` = имя параметра. Строка агрегата: `{course|group_id|discipline_id, name, students, abs_pct, qual_pct, debts, excellent}`; `students` — студенты с результатами в сессии; `abs_pct` — доля студентов, у которых все результаты сессии сданы с первого раза; `qual_pct` — то же и у всех результатов с `is_graded` оценка ≥ 4 (зачёты не мешают); проценты целые, `null` при `students = 0`; `debts` — число долгов (ключей); `excellent` — все с первого раза, есть оценочные результаты и все они на 5. На уровне `discipline` учитываются только результаты этой дисциплины. Строки без студентов не отдаются; сортировка: курс, шифр группы, название дисциплины. Строка `result`: `{student_id, student, control_type, is_graded, points, is_absent, mark, result, attempt}`, `result` — как `fn_result_name(points, is_absent, is_graded, TRUE)`, `attempt` — `main|retake|commission|individual|null`, сортировка по ФИО. `total` — те же пять величин по всей области запроса.

**`risk` — раннее предупреждение.** Рассматриваются обучающиеся (`student_status.is_active`) студенты области, семестр — текущий семестр группы. Факторы: слабый модуль 1 (запись `modules` есть и это неявка, «не аттестован» или `points < mod_min`; нет записи — не фактор); посещаемость `attendance_pct < att_min` (доля присутствий по отметкам текущего семестра, одна цифра; нет отметок — `null`, фактора нет); долги — строки `v_debtors` (`debts > 0`). `score` — число факторов, `risk` = `high` при `score ≥ 2`, `medium` при 1. Строки — только `score ≥ 1`: `{student_id, student, group_id, group_name, course, low_modules:[{discipline_id, discipline, points, is_absent}], attendance_pct, attendance_count, attendance_low, debts, score, risk}`, сортировка: `score` ↓, число слабых модулей ↓, ФИО. `total`: `{pool, at_risk, high, low_module, low_attendance, with_debts}`. `points` — все студенты `pool` со средним баллом: `{student_id, student, group_name, attendance_pct, avg_points, debts}`, `avg_points` — среднее баллов итоговых результатов, одна цифра (как в `v_student_summary`).

**`retake` — пересдачи.** `level=group` (по умолчанию) | `course`. Долги сессии всех завершённых семестров (`semester < current_semester`) обучающихся студентов области; закрытие — по попытке, с которой сдано: `retake`, `commission` или не сдано (`open`, такие ключи — строки `v_debtors`). Строка: `{group_id|course, name, failed, closed_retake, closed_commission, open, closed_pct}`, `closed_pct = round(100·(closed_retake + closed_commission)/failed)`; строки с `failed = 0` не отдаются. `total` — те же поля плюс `expulsion_candidates` — студенты области по правилу `v_expulsion_risk` (по строкам `v_debtors`: `MAX(attempts) ≥ 3` или `COUNT(*) ≥ 3`).

`heat` — доля результатов, не сданных с основной/индивидуальной ведомости, по группе/дисциплине. `moves` — уникальные приказы и студенты по дате приказа/типу/периоду, с раскрытием приказов через pick. Ключ периода: `month` — `YYYY-MM`; `semester` — `YYYY/YY-1` (сентябрь–январь) и `YYYY/YY-2` (февраль–август); `year` — учебный год `YYYY/YY`, с сентября по август (с 18.10.2026; раньше — календарный `YYYY`). `pick` и `orders[].period` — в том же виде. Строка `rows` (без `pick`): `{period, orders, students, by_type, students_by_type}`; `by_type` считает приказы, `students_by_type` — пары «приказ × студент» по коду вида (один приказ об отчислении двух студентов — `by_type.expel = 1`, `students_by_type.expel = 2`). Необязательные параметры: `types` — коды `order_type.code` через запятую; `from`, `to` — окно по `order_date` в формате `YYYY-MM`, включительно; оба действуют и на `rows`, и на `orders`. `list=true` добавляет ключ `orders` — все пары «приказ × студент» окна: `{order_id, order_number, order_date, effective_date, order_type, order_type_code, applied_at, student_id, student, group_id, group_name, course, period}`, где `period` считается тем же правилом, что `rows[].period` (строки `orders` с `period = X` — ровно пары строки `rows` с `period = X`); `applied_at = null` — приказ запланирован; сортировка: `order_date` по убыванию, `order_number`, ФИО. С `pick` строки `rows` — приказы одного периода, как раньше, а `orders` — всё окно. Группа и курс у пары — текущие у студента (группа на дату приказа в базе не хранится). Ошибки — 422 `validation_error`: `from`/`to` не `YYYY-MM` — поле `from`/`to`; `from` позже `to` — `from`; неизвестный или пустой код — `types`; `list` не `true`/`false` — `list`. В `filters` возвращаются `types`, `from`, `to`, `list`. Остаётся защитный лимит 100 000 фактов аналитики (`olap_too_large`). **Одновременные запросы.** Набор фактов собирается в базе одним JSON, поэтому в процессе API одновременно идёт не больше `OLAP_MAX_CONCURRENT` расчётов (по умолчанию 2) — для всех режимов `/olap` и инструмента агента `get_olap_report` (у процесса агента свой такой же лимит). Остальные запросы ждут до `OLAP_QUEUE_TIMEOUT` секунд (20) и затем получают `429 olap_busy` с заголовком `Retry-After: 5`: это не ошибка базы, запрос можно повторить. Набор фактов кэшируется в памяти процесса на `OLAP_CACHE_TTL` секунд (15) по ключу «пользователь + параметры запроса к базе», не больше `OLAP_CACHE_MAX` записей (4, одна запись — около 21 МБ); кэш одного пользователя другому не отдаётся. Одинаковые одновременные запросы одного пользователя ждут один расчёт. Изменения данных и прав видны в OLAP не позже чем через 15 с. Ошибки параметров (`validation_error`, `invalid_filter`) возвращаются до ожидания слота. Лимит и кэш действуют на процесс: если процессов `uvicorn` станет несколько, лимит умножится.

### Коды предметных ошибок

Форма: `{error:{code,message,details},request_id}`. В details могут быть field/items/item_id/reason/max. Внутренние SQL, имена функций, чувствительные реквизиты исключены.

| code | HTTP | details / смысл |
| --- | --- | --- |
| `order_past_date`, `effective_date_past` | 422 | effective_date, прошедшая дата |
| `order_signer_invalid` | 422 | signed_by_id |
| `order_pending_exists` | 409 | student_id |
| `slot_semester_mismatch` | 422 | assignment_id |
| `sheet_dates_invalid` | 422 | exam_date: от выдачи до +366 дней, закрытие после экзамена |
| `points_out_of_scale` | 422 | points |
| `sheet_incomplete` | 409 | status, items: ФИО без записи оценки |
| `sheet_closed` | 409 | sheet_id |
| `correction_later_attempt` | 409 | sheet_id |
| `correction_stale` | 409 | new_points |
| `request_final` | 409 | request_status_id |
| `blank_text` | 422 | поле с пустотой/краевыми пробелами |
| `batch_too_large` | 422 | больше 200 строк |
| `olap_busy` | 429 | заголовок `Retry-After: 5`; все слоты расчёта OLAP заняты дольше `OLAP_QUEUE_TIMEOUT` |
| `stale_item`, `undo_changed` | 409 | item_id |
| `undo_unavailable` | 409 | reason: `expired`, `sheet_closed`, `request_final`, `irreversible`, `conflict`; item_id для строки |
| `validation_error` | 422 | field (`reason` — с `max` для исправления оценки; `picked_item_ids`) |
| `correction_pending_exists` | 409 | sheet_id; по оценке уже есть открытая заявка |
| `sheet_open` | 409 | sheet_id; ведомость открыта — исправлять обычным изменением |
| `sheet_cancelled` | 409 | sheet_id; ведомость отменена — исправлять нечего |
| `correction_not_allowed` | 403 | подать заявку может только работающий сотрудник |
| `correction_not_own_sheet` | 403 | sheet_id; преподаватель — только по своей ведомости |
| `correction_self_decision` | 403 | автор не решает свою заявку |
| `correction_not_manager` | 403 | решает директор или заместитель института |
| `correction_decided` | 409 | заявка уже рассмотрена |
| `order_cancel_enrollment` | 409 | зачисление отменяется удалением студента |
| `order_not_pending` | 409 | запланированного приказа нет (исполнен или не существует) |

Прочие прежние `forbidden/not_found/conflict/invalid_record` сохраняются. Дополнительные детали развёртывания и исключения источника БД: [NEW_DATABASE_IMPLEMENTATION.md](NEW_DATABASE_IMPLEMENTATION.md).


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

Первая беседа не содержит session_id. Сервер сразу создаёт принадлежащую пользователю сессию и отдаёт событие `session`. Чужой/удалённый ID — `session_not_found`; параллельный запуск в той же сессии — `session_busy`. **Зависшие запуски** (с миграции `0063_stale_agent_runs`): воркер держит аренду запуска 60 с и продлевает её каждые 15 с. Запуск в `running` без живой аренды (истекла или её нет) считается прерванным и завершается при первом обращении — чтении событий `GET /agent/runs/{id}/events`, открытии сессии `GET /agent/sessions/{id}`, новом сообщении в эту сессию, удалении сессии, а также при опросе очереди воркером: в поток приходит событие `error` с `type: agent_outcome_unknown` и `finished`, `activeRunId` у сессии пропадает, `session_busy` больше не возникает. Запуск в `queued`, который ждёт воркера дольше `AGENT_QUEUE_TIMEOUT` секунд (по умолчанию 600), завершается так же с `type: agent_unavailable` («Агент сейчас недоступен. Отправьте запрос позже.» — этот же текст теперь у недоступной модели). `POST /agent/runs/{id}/cancel` у запуска без живой аренды завершает его сразу (`agent_cancelled`), у запуска с живой арендой — как раньше, только просит воркер остановиться; ответ в обоих случаях `stop_requested: true`. Запуски с живой арендой не трогаются. Новое сообщение при недоступном воркере по-прежнему ставится в очередь, а не отклоняется `503`.

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
