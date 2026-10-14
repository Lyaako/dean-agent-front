# P12: подключение закреплённого React

Актуализация 15.10.2026: backend Б1–Б11 переведён на `0056_read_boundaries` (56+16 таблиц, 225 нативных проверок, 14 инструментов). [Изменения, проверка и безопасное обновление](NEW_DATABASE_IMPLEMENTATION.md), [добавленный API](API.md). Нижние записи 11–12 октября сохраняют историю прежней версии; они не подтверждают браузерную приёмку нового фронтенда.

11.10.2026: P12/P13 приняты. `frontend/` основан на полном дереве SHA9c68ae0c5f062b87811058599151bc135576b33d; исходные55 файлов начальной копии были побайтно сверены, reference/prototype сохранены.

Все5ролей/8OLAP modes проверены браузером и SQL controls; common forms/partial-save/retry и все6 workflows дали реальные DB/audit результаты. Серверные чаты/SSE/reload/две вкладки/Stop/physical-delete, queue/claim/transfer/decision и special correction прошли. Genuine file worker TXT/PDF25OCR/DOCXpartial дал31responses/0pageerrors; unavailable model сохраняет draft. ProposalDialog скрывает cached data/actions после потери доступа.

С принятой Qwen3.5/20480/0.6/none все6 natural form/agent parity cases PASS. Фактический HTTPS React/BGE/Qdrant пакет подтвердил file-only уточнение, cited manifest, linked proposal materials, назначенного staff/reject, защищённый оригинал и сохранение при reload, нормативную цитату текущей опубликованной версии. Последний browser tail25responses/0pageerrors/cleanup errors[]; предыдущие принятые шаги связаны previous_packet, изменения не повторялись. Текущие fixture head guards0039; исторические packets сохраняют прежний head.

Полные доказательства и эксплуатационные границы — [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). Ниже сохранены исходные этапы и неудачные попытки; ранние «не проверено» не описывают финальную готовность.

## Foundation: реализация

- Восьмая вкладка: GET /olap, все8 modes, group_id/discipline_id/semester/status_id. Существующие Page/TableTools/DataTable/CSS/SVG-мотивы сохранены. Идентичность по числовым IDs, avg/weighted total/score_band из API; null разрывает линию, пустая шкала не заменяется выдуманной.
- fetchAll:40 страниц по500, оставшийся has_more даёт явную ошибку вместо неполного результата. Ошибка также показывается lookup.
- RecordDialog: busy запрещает close/repeat; linked error виден. Успешный person PATCH обновляет baseline/cache; отказ employee оставляет несохранённые реквизиты и сообщение о сохранённом ФИО. Это два отдельных запроса.
- WorkflowDialog: неизменённый body сохраняет attempt key, исправленная форма получает новый; busy защищает Esc/повтор. ConfirmDialog не закрывается при операции.
- HTTP client: локальная ревизия сессии отбрасывает старые account response и late refresh. Автоповтор после401 только GET/HEAD или с Idempotency-Key. Ordinary mutation после успешного refresh просит явную повторную отправку. AuthProvider чистит Query/recovery и отбрасывает поздний профиль. Storage event CSRF очищает локальный аккаунт; ChatBar key=user_id сбрасывает draft/file objects при прямой смене.

## Адресные доказательства

Node22.14.0/npm10.9.2. Обычный npm ci с сетью воспроизвёл ERESOLVE openapi-typescript7.13.0/TS7.0.2. Согласованный `npm ci --legacy-peer-deps --no-audit --no-fund` установил187 packages. Lock SHA256 `751253f3011d9089ef52571af1f285425121f4f72c3207232d1fdee70796b5bc` совпал с reference. Генератор API не проверялся.

`node --experimental-vm-modules frontend/tests/integration/foundation-check.mjs` прошёл. Сначала воспроизведены3 дефекта: ordinary POST повторялся2 раза; late refresh восстанавливал access после clear; старый ответ выдавался после нового account start. После исправления:1POST/session_refreshed, late refresh=false/access=false, session_changed для старого ответа. Также проверены GET/keyed replay,40-page overflow/complete page, все8 mode/status_id, одинаковые имена с разными IDs, серверная шкала/null gap.

Это Node assertions с mocked fetch, не браузер/сервер. AuthProvider/hooks/forms, Vite/TS build, роли, SQL и модель этим набором не доказаны. Старые общие тесты не запускались.

## Матрица финальной проверки

| Элемент | Роль/API | Необходимое доказательство | Статус |
|---|---|---|---|
| Вход/reload/две вкладки/logout/account switch | Все5 ролей; auth/* | StrictMode, revoked session, late profile, отсутствие старого Query/chat/file cache | Helper assertions частично; browser впереди |
| Навигация/search/filter/reset/sort/pages/retry | Scoped schema/resources | Все7 data tabs, direct forbidden, overflow/empty/error | Controls сохранены; browser впереди |
| Open/add/save/delete/cancel/Esc/Unsaved | Schema actions, student own request | Validation/full key, locked student/person, busy/double submit, nested forms | Source fixes; React/API proof впереди |
| ФИО/реквизиты сотрудника | PATCH person → PATCH employee | Первый успех/второй отказ, таблица/baseline, повтор без лишнего person PATCH | Source fix; browser впереди |
| Шесть приказов | workflows/{name}+UUID | Samebody/retry, changedbody/newkey, scheduled/applied, actor audit | Source fix; DB/browser впереди |
| Group links/week/table/prev-next/selectors/slot | Scoped views/schedule_slot | Общая выбранная неделя, empty/error, slot edit для всех дат | Сохранено; browser впереди |
| OLAP8 modes/4 metrics/charts/cross/selectors/search/sort/pages | GET olap+lookups | PostgreSQL: duplicate names, attempts/null/non-graded/debt, foreign/empty, weighted total | Pure mapping/keys/scale/null; actual DB/browser впереди |
| Chat list/new/open/rename/delete/send/Stop/reload/replay | Owner sessions/messages/runs | Stable immutable attempt, cursor dedup/lost first event/canonical history/explicit cancel | Task6 в работе |
| Queue Incoming/Mine/History/claim/assign/submit/decide | Server actions/version | Pagination/author/date/concurrency/correction author-manager/decision-execution | Отдельный владелец, впереди |
| Files upload/retry/remove/wait/preview/context | Exact protected versions/jobs/manifest | Partial/coverage/actual acknowledged chunks/pages/reassignment/cache revoke | Task6 в работе; real proof впереди |

Планируемый приватный credentials file: `.local/p12-browser-credentials.json` (foundation не создавал). Единую изолированную DB/current head/least-privilege runtime нужно выбрать явно; не использовать admin DSN для API и не смешивать initial/repro. VITE_API_TARGET задаётся явно; Origin localhost5173. HTTPS/Compose — P13.

Перед приёмкой освободить пути всех владельцев, один integrated typecheck/build и bounded review. Далее browser/API/DB матрица, viewport/keyboard/focus/busy/empty/error и hash эталонов. Общие SQL/backend/concurrency/agent tests и8 OLAP сверок только на финальном P12/P13 gate. P11 normative acceptance требует фактического citation proof.

## Task8: общая сборка и настоящий runtime

11.10.2026. После освобождения всех frontend paths общий tsc/Vite build прошёл:619 modules.4 конкретные compile ошибки исправлены поI119:PDFDocumentProxy.loadingTask.destroy в обоих preview путях и явный string для default idempotency keys upload/workflow. Foundation/chat asserts прошли повторно; lock SHA256 остался `751253f3011d9089ef52571af1f285425121f4f72c3207232d1fdee70796b5bc`. Production index chunk601.21kB даёт предупреждение Vite; chunk split/performance не менялись.

Dev без VITE_API_TARGET действительно завершился явной ошибкой. Установленный Playwright1.62.1 запустил Chromium1208 (145.0.7632.6), настоящий React StrictMode login render прошёл без pageerrors. Существующий старый preview на5173 сохранён; нынешний Vite работает127.0.0.1:5174→API8881 с точным backendOrigin5174 и dev-cookie(I121).

UI использует отдельный clean clone `deanery_p12_ui_92004917`, сделанный до backend suites из fresh0036+original03seed. Assert head0036/56deanery+15agent_backend tables/5seedroles прошёл до установки random local-only password_hash. Credentials остаются private `.local/p12-browser-credentials.json`; API иagent используют отдельные least-privileged private connection files. Старые initial/repro DB не используются. Проверяющие сценарии находятся в `frontend/tests/integration/`; evidence содержит только role/route/status/mode/count, не login payload или токены.

Первая live baseline достигла admin/all8tabs и3OLAP modes, затем упала из-за timing самого harness (раннее чтение selects); evidence сохранена в mission/task8-browser-baseline-1.json. Второй прогон с actual click-response capture подтвердил ещё slice-group, но обнаружил реальный404 `/resources/discipline`: manual RESOURCES registry не содержит существующего scoped справочника, поэтому slice-discipline не может выбрать ID. Это интеграционный дефект, не успешная8-mode приёмка. Runtime остаётся для bounded repair/retest; остальные роли/authtwo-tabs/fullbuttons и P13 впереди.

Defect исправлен поI123/I124: единственная READ registration `discipline:ALL` плюс forward0037_discipline_lookup/SQL030. Один manual registry дал schema, но real read422: прежний SQL007 visible_rows_for_actor не знал discipline; существующий SQL017 agent_rows_for_actor уже имел discipline catalog TRUE. SQL030 сохраняет исходный token/session/current-account gate побайтно и направляет только discipline в этот существующий reader с проверенным user_id. ELSE/grants прежние; таблиц/ролей/write rights не добавлено. UIclone теперь0037/71application tables, private credentials сохранены.

Финальный affected `discipline-check.py live` прошёл:5roles realHTTP/schema,59discipline rows,read200/write403/direct authenticatedDBscope equality,unauthenticated/revoked401,forged-token SQL empty,auth gate exact-source comparison. Offline настоящий DeepAgents graph даёт13tools и неизменный calibrated staticfingerprint c49f44d79438805d7ba7eb49aa7d845399bc3ddcd983d56bb0b31535e4c443f6; semantic AGENT_RESOURCES hash также прежний, provider_calls0. Во время первого параллельного browser/HTTP прогона один schema response не содержал resources; его status не сохранился, точная причина неизвестна. Два последовательных адресных повтора после safe status diagnostics прошли; concurrent-schema scenario остаётся в полной browser матрице.

Actual React StrictMode admin slice-discipline click прошёл:15rows/717results/11debts,15HTTPresponses,0pageerrors и logout. Evidence `task8-browser-discipline.json`, `task8-discipline-evidence.json` и authenticated `task8-react-olap.png` находятся в текущей Nelson mission. Baseline archives1–3 сохраняют timing/404/422 failures. Полный5role×8mode/authreload/twotabs/forms/queue/files/provider matrix этим не доказан и остаётся следующему владельцу. Task9 полный backend baseline был импортирован до READ repair на отдельной0036DB; он применяет0037delta отдельно после своих originalSQL/affected checks.

Финальный write denial проверен с настоящими issued Bearer+CSRF и точным разрешённым Origin:для всех5roles403`forbidden`, поэтому это отказ read-only policy. Один дополнительный ранний post-logout assertion также не совпал с401 до сохранения status; причина не установлена. После safe status diagnostics итоговый affected прогон прошёл полностью. Оба intermittent response случая передаются в auth/concurrency gate без вывода о причине или ослабления ожиданий.

Дополнительный review focus: старые module-level table/schedule UI stores при account switch; неоднозначная workflow network error перед сменой intent; permission/empty linked row; modal focus/keyboard. Эти browser сценарии ещё не проверены и не приняты.

## Task7: очередь и окно предложений

Реализованы `api/proposals.ts`, `chat/proposals/ProposalQueue`, существующий ProposalDialog/useProposal. Swift монтирует queue внутри ChatBar, открывает общий dialog и после полного Proposal обновляет текущий серверный чат. Использованы прежние Modal/Badge/form/table/proposal styles и FileViewer; shared styles и reference не менялись. Server actions определяют отдельные claim/assign/submit/approve/reject; роль staff не подменяет полномочия. Закрытие блокируется во время запроса, причина/version/key фиксируются на попытку; после неоднозначной ошибки хранится тот же запрос в account-cleared Query cache для явного повтора. Перезагрузка страницы перечитывает серверную версию; сохранение proposal attempt в постоянное хранилище не добавлялось. Новое предложение/другое действие не отправляется автоматически после ошибки.

Approved отображается «Подтверждено», исполнение отдельно: not_started/scheduled/running/succeeded/failed/cancelled, дата/приказ/ошибка. Стиль applied появляется только для succeeded. Correction draft имеет «Подать заявку» вместо обычного approve; special manager rights остаются на сервере. История загружается страницами after-ID; linked context_files показывают реальные связанные фрагменты/страницы и открывают защищённую точную версию без глобального byte cache. «Отменить передачу» закрывает локальную форму; API unassign не добавлен.

Фильтры server-side: author literal case-insensitive trim≤200, from/to по Moscow calendar days, status/execution; counts всех коробок фильтрованы одинаково.0036/SQL029 сохраняет6-аргументную совместимость и grants.4 новых HTTP+реальных PostgreSQL случая (26.120s) проверили inclusive/exclusive midnight/UTC timezone, literal `%`/`_`/SQL-like author, login/имя/case, одинаковые даты и стабильные pages, state/counts/foreign scope/валидацию/legacy grants.2 напрямую затронутых прежних случая (2.067s) проверили student→staff claim/transfer и чужую область. Изолированные fixtures/password hashes откатились, DB slot освобождён.

`node --experimental-vm-modules frontend/tests/proposals/proposals-check.mjs` прошёл: immutable payload/version/key и retry, intent validation/actions, query/events serialization; настоящая React server-render проверка подтверждения/отложенного исполнения/failed/cancelled, draft submit, stale reject и queue role labels. API/state fixtures замоканы; hook effects, нажатия, StrictMode, browser reauthorization и полностью интегрированный typecheck/build этим не доказаны. Они остаются в финальной общей матрице. Полных прежних suite не запускали.

## Task12: bounded Stage1, 11.10.2026

Два настоящих дефекта исправлены по I131/I133. Module-level tableMap/scheduleSaved теперь очищаются existing AuthProvider.reset: actual admin→student больше не сохраняет search/week. Все29 существующих DB Depends используют function scope; транзакция завершается до HTTP-ответа, cached actor/route sharing сохранён. Native ASGI + independent real UI DB без timing injection показал login/refresh/logout state invisible-at-send до repair и visible-at-send после. SSE собственные транзакции и FileResponse path lifecycle проверены отдельно и не заменены.

Focused real React/StrictMode auth PASS193responses/0pageerrors: account reset, native WebLocks,8director simultaneous two-tab reload rounds, logout propagation, delayed actualperson200 при смене account не возвращает staleadmin. Delay отмечен как test timing interception; backend response настоящий. Аffected discipline5roles READ59/write403/currentOrigin-CSRF/scopeequal/unauth-revoked401 и13tool/staticc49 identities повторно прошли, provider0.

Admin/director actual8tabs×8modes/alltablepages/chart values/cross cells были проверены до обнаружения authrace; их16 currentHTTP/SQL controls затем прошли послеrepair. Dean_staff/teacher/student actualbatch послеrepair прошёл8modes each,189responses/0pageerrors, reload/two-tabs/concurrent schema/logout/revoked401 и24SQL controls. Итого40role×mode SQL comparisons. Teacherseed0results/debts честно проверен как empty; nonemptyteacherfixture/filter/chart-position/search/sort/foreign-selection остаются следующему batch. Student36results, staff8719; rights/teaching fixtures не менялись.

Unifiedtsc/Vite8.3.3 buildPASS619modules, pinnedlock unchanged; indexchunk601.34kB warning retained. Oldruntime отсутствовал и восстановлен: API8881/session33617/pid55196; Vite5174→8881/session54699/pid46884. UIclone0037/71tables/0active runs/jobs; private fixtures сохранены, browser closed, workers/provider не запускались. Evidence/handoff task12-* в current Nelson mission. Oldtask8 uncapturedschema/logout exactcauses остаются unknown; current fresh-cookie401 и commit-order defect доказаны. Полная P12/P13 acceptance ещё впереди.

## Task16: адресная Stage2 приёмка

Положительные teacher8 modes/SQL и графики подтверждены отдельной I069 fixture;8 серверных filters/SQL и5 foreign-selector случаев проверены адресно. Два общих UI дефекта исправлены минимально: TableTools dismissal по click предотвращает потерю действий ниже панели; ResourceTablePage даёт OrdersMenu обновлённую строку того же PK после приказа. Все callers просмотрены, tsc -b прошёл, package/lock/layout unchanged. Before/after native traces и границы пакетов находятся в task16-evidence.md.

Employee common form/partial-save retry и все6 workflow native effects проверены реальными React/HTTP/SQL, включая immutable body/key, busy/Esc/double-submit и отдельный source same-day-return отказ. Последний lifecycle packet продолжал private progress без повторения уже применённых приказов. Created workflow/order/audit fixtures сохранены; остальные employee/teacher/OLAP fixtures очищены только по собственным ID. OLAP Dice/drilldown crafted cases подтверждают distinct IDs при одинаковом ФИО, latest retake, NULL denominator и nongraded/excellent/debt semantics; это отдельный2-mode пакет без повторения всей матрицы.

Текущие retained процессы: UI API8881 PID57840 и Vite5174 PID8572/session34090. Managed headless Chrome0; unrelated5173/user Chrome/historical5 auth sessions не затрагивались. UI DB0037 имеет56+15 application tables и0 queued/running run/job. Browser chat paging/SSE/canonical history/Stop/delete, queue assignment/correction/materials и protected files/partial/reassignment остаются следующим Stage3. P13 HTTPS/native-server smoke root прошёл отдельно, он не заменяет эти React interactions.
