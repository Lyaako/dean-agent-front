# Проверка проектного пакета

Актуализация 15.10.2026: backend Б1–Б11 переведён на `0056_read_boundaries` (56+16 таблиц, 225 нативных проверок, 14 инструментов). [Изменения, проверка и безопасное обновление](NEW_DATABASE_IMPLEMENTATION.md), [добавленный API](API.md). Нижние записи 11–12 октября сохраняют историю прежней версии; они не подтверждают браузерную приёмку нового фронтенда.

P00–P13 реализованы и приняты11.10.2026. Актуальная доказательная матрица: [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md), React — [FRONTEND_INTEGRATION.md](FRONTEND_INTEGRATION.md). Нижние разделы сохраняют историю первоначального прототипа; его screenshots/canned answers не использованы как доказательство настоящего backend/LLM.

Итог:184 исходных SQL checks; backend baseline396PASS+7skips/403nodes и последующие адресные checks;5 native races;5-role/8-mode OLAP,6 UI workflows;6 настоящих form/agent parity cases с отдельным решением/audit; TXT/PDF25OCR/DOCXpartial; actual HTTPS model/materials/citation/reload; source/restore72 tables/ACL/owners/sequences/11files и native reindex/retrieval. Forward0038 policy8checks,0039 live chat/scope7checks, packaging13tests/11subtests PASS. Перезапуск4 workers сохраняет orders/jobs/audit; формы доступны при unavailable workers. Финальные8 статусов ready, активных тестовых runs/jobs/sessions/tokens0. Образы112/34 разрешённых файлов точно совпадают с source; private credentials исключены.

Python source syntax, текущий public model example/13-tool fingerprint, React build, prototype/catalog/API-route/document-link checks прошли. Общая403-node baseline после последних исправлений не повторялась: выполнялись затронутые проверки. Production/повышенная concurrency не проверялись; RAM и TLS границы указаны в статусе и OPERATIONS.md.

## Проверено сейчас

- Новый подробный план проверен на наличие 14 последовательных этапов P00–P13 с условиями завершения, четырёх выбранных функций F01–F04 и 32 сценариев агента A01–A32. Два JSON-примера разбираются; локальные ссылки документов существуют. Повторная проверка исходного макета и каталога прошла. Это проверка документации, не реализация или приёмка новых функций.
- Через GitHub проверены ветки main и react-frontend и их различия. Актуальная основа — **react-frontend**, commit `9c68ae0c5f062b87811058599151bc135576b33d`; [версия и изменения](FRONTEND_VERSION.md). Изучены обновлённые авторизация, формы, блокировки связанных полей, чат и вложения. Код `backend_dean` не использован.
- Все десять локальных файлов исходного макета сверены SHA-256 с `references/frontend-source/mockup/redesign`; список закреплён в source.json. Проверены существование ассетов и синтаксис пяти JS отдельно и вместе. Это точная копия макета новой ветки, без изменения React-исходников.
- Структура приложенного SQL разобрана: 56 таблиц, 312 полей, 83 FK, включая ALTER-связь старосты, 27 views. Ключи и FK проверены; отдельно проверены составные PK order_student, student_contact, audit_log_detail.
- Проверяются наличие описанных API-маршрутов, восемь вкладок из tabs.ts, зафиксированный SHA в README/плане и локальные ссылки документов. Отдельно проверено наличие linked-полей сотрудника в источнике и переход CSRF-хранилища на localStorage.
- HTML и его ассеты открыты локальным preview. В браузере проверены демонстрационный login, стартовая страница студентов, раскрытие/сворачивание чата, демонстрационный ответ на вопрос о задолженностях и появление правильного заголовка каждой из восьми вкладок.
- Проверены поля Фамилия/Имя/Отчество существующего сотрудника, окно «Сохранить изменения?» при закрытии изменённой формы и выход из него без сохранения.
- Сохранены новые [скриншот интерфейса](../prototype/preview.jpg) и [раскрытый чат](../prototype/preview-agent.jpg), уже из react-frontend. Мобильная приёмка новой версии в этом этапе не проводилась.

Повторяемая локальная проверка: `node prototype/check.cjs`. Обновление справочного каталога: `python docs/build_catalog.py`. Это проверки файлов и документации, а не тесты ещё не написанного backend.

## Исторические границы проверки прототипа

Рабочий backend, аутентификация, исполнение SQL/procedures, LLM, SSE backend, обработка файлов, антивирус, BGE-M3, Qdrant, транзакционные гонки и worker сейчас не созданы и не запускались. SQL-набор `06_tests.sql` не выполнялся. React-приложение не собиралось и не проходило E2E с сервером; проверен его исходный контракт и отдельно его HTML-макет.

Демонстрационный ответ HTML не доказывает работу реального агента. Макет содержит собственные синтетические данные и сценарии, включая условные числа попыток и OLAP. В React `main.tsx` OLAP пока ComingSoonPage, но пользователь прямо потребовал полную реализацию OLAP. Восемь режимов макета проверены по источнику; определения реальных показателей и новые API ещё требуют прямого согласования и не реализованы.

Исходный frontend имеет ограничения транспорта: bulk-лимит 20 000 строк, отсутствие версии в PATCH и ключа идемпотентности в обычном POST ресурсов, локальное хранение списка чатов и отсутствие восстановления SSE. Новая ветка также сохраняет ФИО и реквизиты сотрудника отдельными PATCH и имеет fallback без Web Locks для refresh. Ограничения описаны в разделе 12 [подробного плана](DETAILED_IMPLEMENTATION_PLAN.md), не скрыты обещанием полной надёжности.

Это исторический frontend snapshot: рабочая копия уже использует серверные чаты, durable SSE и видимый partial-save результат. PATCH без версии и обычный resource POST без idempotency остаются отдельно зафиксированными контрактными границами.

Источник визуала сохранён без исправления возможных собственных особенностей/ошибок. Это согласованный пользователем интерфейс; его копирование не означает готовность использовать демонстрационные data/ui/app/chat.js как production frontend. Шрифты и некоторые функции вложений исходного HTML используют внешние CDN. Предпросмотр запускался временно для проверки; сохранённые HTML/документы доступны в workspace.

## Текущие адресные доказательства11.10.2026

P12 Stage2 task16: положительные teacher8 OLAP modes/8 SQL controls, отдельные filters/foreign-selection/local-controls after repair, common employee partial save и workflow retry, все6 настоящих приказов с6 distinct applied orders/jobs/audit,2 crafted Dice/drilldown edge cases. Exact cleanup восстановил employee/teacher и удалил только новые open grade fixtures; official workflow/audit retained, own auth sessions0/historical5 untouched. Task16 evidence сохраняет before failures и отдельные after proofs, не выдаёт промежуточный failed packet за полный PASS.

Root I147:5 настоящих proposal concurrency races с доказанными двумя blocked PostgreSQL transactions; один официальный effect при same-key/same-intent retries и одном winner competing decision. Root I152: real HTTPS/3-role cookie/CSRF/foreign-origin, server two-client chats, SSE heartbeat/replay/same-run/idempotency/API restart/explicitStop/physical-delete SQL proof; provider0/cleanup errors[]. Root I151: read-only72-table hash/owner/grant/sequence inventory и binary manifest/tamper checks, actual restore ещё не запускался. Новые checks не повторяли общую backend baseline.

Qwen3.5 architecture теперь загружается после ручного user update LM Studio, но cold-load memory tight и первый natural document request не сделал proposal. Tool metadata I163 уточняет уже существующие defaults без ослабления guards;3 focused checks/static fingerprint passed, semantic retry ещё идёт. Полный agent и React chat/queue/files/P13 restore readiness этим документом не заявляются.
