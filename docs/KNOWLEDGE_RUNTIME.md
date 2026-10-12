# Нормативные документы: оператор и worker

Приёмка11.10.2026 завершена: действующая версия опубликована настоящим BGE-M3 dense/sparse/Qdrant, восстановленный индекс заново построен из проверенных версий. Qwen3.5 через реальный search_regulations процитировала ровно переданный и подтверждённый фрагмент; в React видны название, источник, версия и locator. Источник без source_url получает текстовую подтверждённую цитату; URL не выдумывается. Worker остановка/restart и безопасная деградация проверены, head0039.

P11 добавляет нормативные версии в существующие `regulation`, `regulation_version`, `regulation_chunk`, `job` и `idempotency_record`. Новых таблиц нет. Оригинальные пользовательские attachments остаются своим отдельным источником. Настоящий BGE-M3 dense1024+sparse и Qdrant RRF реализуются в `vector_search`; источник истины о текущей опубликованности и области — PostgreSQL.

## Приватная настройка

Используется Python3.13 backend и существующий Linux file-worker image с digital-only командой. `backend/knowledge.env.example` перечисляет настройки. Оператор и worker используют разные JSON connection files в игнорируемом `.local`. Provisioning требует существующей отдельной DB административной учётной записи и не создаёт frontend admin. Пример для выбранной изолированной БД:

```powershell
python -m backend.db.provision_local_knowledge operator .local/p01-repro-connection.json .local/p11-knowledge-operator.json
python -m backend.db.provision_local_knowledge worker .local/p01-repro-connection.json .local/p11-knowledge-worker.json --host host.docker.internal
$env:KNOWLEDGE_DATABASE_FILE = '.local/p11-knowledge-operator.json'
$env:KNOWLEDGE_TOKEN_FILE = '.local/p11-operator-token.txt'
```

Операторский token file содержит только действующий access token активного admin, полученный штатным login. Токен не передаётся аргументом процесса и не заменяется actor ID/header. Один browser admin token без отдельного DB grant не открывает служебные функции. Provisioner выдаёт только четыре операторские либо восемь worker-функций; членство в backend_api/backend_worker/backend_executor отсутствует. Credentials и token нельзя помещать в repo, stdout или worker logs.

## Операторские команды

```powershell
python -m backend.regulations import C:/sources/regulation.pdf --title 'Название положения' --source 'Официальное наименование источника' --version-label 'Редакция 1' --global-scope --key 34ee1465-d245-4adc-90cf-1c2c2319d0d8
python -m backend.regulations get-version <version-uuid>
python -m backend.regulations reindex <version-uuid> --key <new-request-uuid>
python -m backend.regulations withdraw <version-uuid> --reason 'Подтверждённая причина отзыва'
```

Для области института вместо `--global-scope` обязательно передать один или несколько `--institute-id <existing-id>`. Новая редакция существующего документа принимает `--regulation-id <uuid>` с тем же title. `--source-url`, `--published-date YYYY-MM-DD`, `--effective-date YYYY-MM-DD` передаются только при подтверждённых сведениях. URL не скачивается; отсутствующие значения остаются null. Новые title/source/даты/version/hash/scope требуют новой версии; изменение scope не расширяет прежнюю публикацию. После подготовки новой версии оператор явно отзывает старую, если она больше не должна быть доступна. Система не придумывает автоматическое правило юридического замещения редакций.

Import принимает PDF/DOCX/UTF-8 TXT до10,000,000 bytes и проверяет имя, MIME/сигнатуру, приватный путь и SHA256. Один UUID key+точный запрос возвращают ту же версию и job; тот же key с изменённым запросом даёт конфликт. Версия резервируется в БД до публикации original, запись производится через fsync+неперезаписывающий atomic hard link из regulations/.staging в regulations внутри одного writable mount. Повтор после остановки проверяет existing hash и завершает очередь. Осиротевший original сохраняется для сверки; автоматической очистки источников нет.

CLI возвращает IDs/job; `get-version` также возвращает original metadata/coverage/published_at/published_by/последнюю job. Код ошибки остаётся видимым. Отдельного ручного publish нет: complete digital extraction и успешно проверенный индекс публикуются автоматически. Источник может быть опубликован одновременно с failed/queued reindex; при оценке доступности проверяется published_at+active generation, а не только processing_state.

## Извлечение, поколения и восстановление

Worker работает как `python -m backend.knowledge_worker [--once]` в существующем Linux file-worker image; Windows глобальные OCR инструменты не устанавливаются. Команда использует собственный узкий DB secret. Original `regulations` монтируется read-only; существующие `derived`/`temporary` writable и общие parser ограничения сохраняются. В compose knowledge runtime требуется отдельный `KNOWLEDGE_WORKER_SECRET`; operator token в контейнер не монтируется. Нужны только новые сервисы/изолированный Qdrant volume, без прежних deanery контейнеров и старых индексов.

Существующий `process_document` сохраняет каждую страницу/пакет и хэшированные сегменты index. PDF использует отдельную digital operation того же parser: raster/пустая/невычитанная страница предупреждается и не запускает OCR. DOCX с невычитанными images также partial. Полнота без warnings обязательна для sealing chunks; original и accepted text никогда не заменяются переиндексацией. UUID chunk детерминирован версией, sequence и exact text hash; locator содержит реальные page/block и quality без придуманных пунктов.

Одна active job на версию; lease120s, heartbeat15s, максимум3 attempts, network/storage retry30×attempts секунд. Повтор после lease loss использует прежнее candidate generation. HTTP/embedding не удерживает DB transaction. Qdrant получает новое generation рядом с active; worker проверяет все ожидаемые IDs/count/hash, затем короткая DB транзакция сверяет receipt с sealed manifest и переключает generation. Partial/неверный receipt/stale worker не публикуют версию. На failed reindex прежние опубликованные generation/chunks остаются доступными. Reindex с новым ключом восстанавливает потерянный индекс из original+сохранённых chunks, без сброса collection.

Withdraw прекращает незавершённые jobs и немедленно исключает версию из `regulation_version_visible`/current evidence. Старые Qdrant points не считаются полномочием. Run/history/final citation повторно применяют эту проверку в соответствующем P11 agent-контуре. Текст нормативного источника является данными, а не командой для tools.

## Проверенное состояние и границы

11.10.2026: explicit migration0032 применена только к repro. **7 новых проверок /1.90s**, **2 непосредственно затронутые прежние OCR parametrizations** passed. Проверены71tables, неподдельная operator attribution, отсутствие grants обычным runtime roles, idempotency, immutable bytes/chunks/scope, complete/partial, count/hash receipt, lease reclaim, failed reindex, current visibility и withdrawal. DB тесты откатываются; receipt в них намеренно подменён тестовым проверенным индексатором. Это доказывает согласование store/worker и не заменяет реальное BGE/Qdrant доказательство. Реальный Linux knowledge worker, BGE cold/warm memory/latency, Russian hybrid retrieval и окончательная Qwen calibration/citation должны получить отдельные доказательства перед приёмкой P11. Полная интеграция и restore относятся P12/P13.

Откат активации: остановить только новые knowledge worker/BGE/Qdrant сервисы, сохранить private originals, versions, chunks и audit. Применённые миграции не редактировать и не откатывать разрушением источников; исправления выполнять forward migration. Старое published generation остаётся DB-authoritative при любой ошибке нового индекса.

Адресные исправления после review: общий PDF parser проверяет `get_image_info`, который учитывает inline raster ([PyMuPDF](https://pymupdf.readthedocs.io/en/latest/page.html#Page.get_image_info)); обычные attachments по-прежнему выбирают OCR, normative остаются partial. DOCX digital-text помечает невычитанные footnote/endnote/header/footer/altChunk части предупреждением. Для новой text operation сохранён прежний64MiB output bound. Forward0034/SQL027 переводит истёкший последний lease вместе с processing_state в failed, сохраняя published generation.

Накопительно **13 новых случаев +2 прямо затронутых OCR cases** прошли: первоначальные7, затем5 новых DB cases в адресном наборе8/1.80s, плюс настоящий Linux digital-text9MB/>8MiB structured-output case1/3.47s. Private operator/worker logins уже provisioned для repro; реальными подключениями подтверждены точные4/8function grants, отсутствие runtime-role membership, table и agent_backend schema privileges. Token для реального operator session не создавался. Финальный image после этих исправлений: `dean-plan-p10-file-worker:local`, manifest `sha256:81d66d2d1159a6554a47539d9da4092b563e2c6153e8d01d5e9cf07104278898`. Источник истины о последующих vector/runtime проверках — отдельный handoff/evidence Defender; приведённые parser/store доказательства не означают завершённую приёмку BGE/Qdrant/agent.

## Фактический BGE/worker/Qwen checkpoint

11.10.2026, Defender: repro до0035. Official BGE-M3 revision5617a9f61b028005a4858fdac845db406aefb181 работает CPUfloat32/2CPU/3GiB/no-swap: первая inference2.873s, dense1024/sparse17, peak2424102912bytes, без OOM. BGE image `deanery-bge-m3:p11`, image config `sha256:34d301641bd7c157d36dc16bca9bbb59e7b9481dcd46450870958d244e13ab64`; pip freeze `.local/p11-bge-resolved.txt`. Qdrant `deanery-verified-qdrant:1.15.5`, изолированный volume.

Protected CLI→отдельный Linux knowledge-worker→реальные BGE/Qdrant→verified receipt→atomic publication прошёл за5.78s. Worker image `dean-plan-p11-knowledge-worker:local`, manifest-list `sha256:623f81a31dbc327d53eba786484aceae720c93062a851d7ef770d56f25f7e499`. До top-k оба prefetch/fusion ограничиваются текущими generation IDs PostgreSQL, затем chunks проверяются SQL: реальный контроль с48 stale points показал12 старых результатов без фильтра и1 актуальный с ним. Forward0035 и4 новых DB checks прошли; финальная адресная R4 matrix71passed.

Qwen run51.57s/2provider requests/13tools вызвал search_regulations/query_deanery. Actual wire и DB acknowledged evidence подтвердились; ответ содержал код нормы/7 дней и student count1, отсутствующую дату не придумал, source injection не выполнил (0 proposals). Но citation token отсутствовал, citedIDs=[], положительная assertion упала. **P11 не принят**; поI112 новый владелец проверяет одну bounded insertion-only попытку ремонта без изменения facts/tools/static fingerprint. Исходный обычный prompt не заменяется подсказанной демонстрацией. Временные auth secrets отозваны; собственные BGE/Qdrant сохранены для утверждённых проверок. Безопасные синтетические evidence/trace: `.local/p11-real-rag-evidence.json`/`.local/p11-real-rag-trace.json`; handoff — текущая mission/task2-evidence.md. Это обновляет прежний parser/store checkpoint выше, но не доказывает итоговые restore/HTTP/browser сценарии.

## Положительная проверка цитирования после I114

11.10.2026: исходный обычный вопрос без демонстрационной подсказки прошёл на том же Qwen/context16384, с неизменным13-tool/static fingerprint c49f. За66.23s выполнены3 provider requests. Raw draft вновь пропустил citation; единственный repair вернул выбранные самой моделью точную уникальную цитату и реально acknowledged chunk_id. После строгой проверки аннотации deterministic insertion сохранила исходный draft, а текущая SQL-проверка сформировала canonical Markdown link и citedID. Ответ сохранил код нормы/7 дней/count1, не выдумал отсутствующую дату/срок; инструкция источника про1 января явно названа посторонней и не исполнена,0proposals. Это доказательство одной выбранной аннотации, не утверждение, что все предложения ответа аннотированы отдельно.

Строгие JSON annotation/unknown ID/overlap/count gates сохраняют общий run/deadline/8-step, запрет tools в repair, wire budget и повторную текущую видимость.31 выбранный новый/затронутый runtime+actual loopback-wire случай прошёл за5.84s (включает прежние16/4, не суммировать).2 реальные многосоединительные проверки порядка withdrawal прошли за20.04s с pg_blocking_pids и отзывом replay/history.10 прямо затронутых прежних runtime/wire случаев прошли за2.86s. Первый full-answer repair ранее завершился protocol error; старый harness потерял точное расхождение, причина неизвестна.

Safe synthetic evidence `.local/p11-citation-repair-evidence.json` и trace `.local/p11-citation-repair-trace.json` теперь сохраняются до assertions. Cleanup отдельно проверил activejobs=0/activeruns=0, отзыв временных Qwen/race sessions и восстановление seed hashes до commit. Существующие сервисы сохранены. Task2-evidence.md текущей Nelson mission содержит точную историю. Independent reviewer, общая browser/full-suite/restore приёмка ещё требуются; этот положительный runtime proof сам по себе не завершает P12/P13.
