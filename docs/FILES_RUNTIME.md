# Частные файлы и локальный OCR

Приёмка11.10.2026 завершена на head0039: настоящий React/Linux worker обработал TXT, PDF25/25 страниц с OCR25-й, DOCXpartial; protected originals сверены по SHA-256. Настоящая модель передала/подтвердила/процитировала фрагмент, proposal сохранил linked evidence, назначенный сотрудник получил материалы, reload сохранил manifest. Совместный source P13 использует4 собственных worker; ниже также сохранён первоначальный отдельный P10 запуск.

P10 использует существующие file/file_version/job и run/event/context таблицы. Загрузка PDF/DOCX/TXT ограничена10MB; сообщение —5 версиями/20MB. CSV и PNG/JPEG/WEBP остаются внутренними parser helpers, публичный selector не расширен. Оригиналы, версии и производные сохраняются без очистки по возрасту; удаление чата по прежнему очищает копии переписки по его отдельному контракту.

## Запуск

Нужны Docker Desktop с Linux containers и явно выбранная новая PostgreSQL. Старые deanery containers не используются. Применить актуальную цепочку миграций к выбранной БД, затем один раз создать узкий login:

```powershell
python -m backend.db.provision_local_files .local/p01-repro-connection.json .local/p10-files-repro-connection.json
New-Item -ItemType Directory -Force .local/files/originals/.staging,.local/files/derived,.local/files/temporary
$env:FILES_WORKER_SECRET='./.local/p10-files-repro-connection.json'
docker compose -f compose.files.yaml build file-worker
docker compose -f compose.files.yaml up -d file-worker
```

Provision создаёт новый случайный login только для четырёх функций claim/renew/checkpoint/retry, без членства в backend_worker/backend_executor и без доступа к таблицам. Существующий файл секрета не перезаписывается. API и agent на host используют тот же `FILES_STORAGE_ROOT=.local/files`. Compose требует FILES_WORKER_SECRET; API, agent и worker должны указывать одну выбранную БД. На этой машине initial `.local/p01-connection.json` осталась на0028, проверки исправлений выполнялись исключительно на repro через `.local/p01-repro-connection.json` с0030; не смешивать их. Пароли и токены не входят в Git/логи.

Контейнер отдельного проекта `dean-plan-p10`: непривилегированный UID10001, read-only root и original mount, writable derived/temporary,2CPU/2GiB/32pids, no-new-privileges, все capabilities сняты, /tmp256MiB. Остановка только этого worker безопасна: завершённые checkpoints остаются; истёкший lease позволяет продолжение. Команда `docker compose -f compose.files.yaml stop file-worker` ничего не удаляет.

## Извлечение и пределы ресурсов

Каждая PDF-страница проверяется цифровым extractor. Нет текста, ошибка извлечения либо наличие изображения запускают Tesseract5 rus+eng через Poppler. Поэтому скан после10-й страницы и текстовый заголовок над сканом обрабатываются. Ошибка одной страницы не мешает следующим; пустой/ошибочный OCR сохраняет пригодный цифровой текст и предупреждение. Непустой OCR остаётся непроверенным: confidence<60 даёт low-quality warning. Подпись, печать и неразборчивые реквизиты не восстанавливаются догадкой.

Нет ограничения500 страниц. Отдельный Linux child ограничен AS1536MiB, CPU150s, FSIZE64MiB, NOFILE64; inspect30s, page160s, raster30s и OCR90s. Outer timeout убивает process group вместе с потомками. Растер300dpi, длинная сторона <=5000px, превышение понижает масштаб с warning. Выход OCR <=2MiB на страницу; усечение явно отражается в coverage. DOCX ZIP <=2048 entries/40MB expanded, document.xml<=20MB, шифрование и DTD/entity запрещены, изображения DOCX дают явное предупреждение об отсутствии извлечения. Это технические бюджеты, а не обещание полного разбора любого документа.

TXT/DOCX читаются одним процессом, chunks<=1000 символов сохраняют исходный block..block_end; batches по200 chunks. PDF chunks несут страницу и смещения. Каждый сохранённый unit и индекс имеют SHA-256, version и привязку к хэшу original. Индекс состоит из неизменяемых сегментов <=100 units/1MiB, checkpoint пишет только текущий ограниченный сегмент; накопленный объём растёт линейно. Чтение проверяет хэши/пути, cursor привязан к версии и не является разрешением доступа.

Lease120s обновляется каждые15s. Запись прогресса и итогов требует текущего владельца lease. Максимум3 попытки; временная недоступность storage повторяет job с задержкой30×attempts секунд и прежним checkpoint. Повреждённый/нечитаемый документ завершается явной ошибкой; полезный неполный результат —partial. `succeeded` описывает завершение задачи, `extraction_state=ready` и coverage.complete — полноту извлечения. Прекращение обработки, качество и неуспешные страницы не скрываются.

## Извлечено, предоставлено и использовано

Файловый worker не вызывает модель. Полный OCR хранится отдельно от её контекста. Qwen2.5-7B text-only использует ровно12 разрешённых tools после добавления только `read_attachment_text`; произвольного файлового/URL инструмента нет. Начальные2k символов, чтение2k, run8k/20chunks ограничены измеренным окном16384 и полным телом provider request. Статическая часть3818tokens+256margin, dynamic UTF-8 byte bound+32/message+512reserve, output1536. Изменённый fingerprint требует новой калибровки.

Manifest хранит точные выбранные, отправленные и подтверждённые chunks, последующие чтения, warnings и остановку. Ready-файл сам по себе не означает, что модель видела весь текст; подтверждённая доставка не доказывает точность понимания. Ссылки предложения берутся только из разрешённых предоставленных chunks и атомарно сохраняются с prepare. Текущие права проверяются повторно для download, tool, истории и итоговой публикации. Vision-модель не включалась.

## Проверенные результаты

Собран локальный образ с Python3.13 bookworm, Tesseract5.3.0-2, языками rus/eng1:4.1.0-2, Poppler22.12.0-2+deb12u3; base digest `sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641`. Python: psycopg3.2.3, PyMuPDF1.26.7, pypdf6.1.1, Pillow12.0.0, multipart0.0.20. Это зафиксированные фактические версии сборки; будущая apt-сборка может получать исправления безопасности.

10 новых parser/artifact случаев прошли накопительно в Linux container. Реальный25-страничный PDF:7.34s, OCR на11-й/25-й страницах читает русский и английский текст,22 цифровые страницы,1 намеренно введённая ошибка12-й страницы,0 необработанных. Ошибка12 — инъекция проверки, а не сбой настоящего Tesseract. Все25 промежуточных checkpoints видны; итогpartial. Тест501 страниц проверяет отсутствие прежнего отказа, но не является OCR всех501 страниц.

Четыре новых HTTP/DB случая прошли на repro0030; дополнительное усиление одного проверяет сохранение точного checkpoint после временного storage failure. Единственный затронутый старый job-case прошёл после исправления двух ожидаемых полей P09. Реальный restricted Compose worker обработал synthetic HTTP upload: attempt1, succeeded/ready, полный1 text chunk с контрольным значением SAPPHIRE-742. Свидетельство `.local/p10-real-worker-evidence.json`; оно не является модельным тестом. Отдельный реальный Qwen/file run и независимая приёмка описываются в текущем mission report.

Отдельный реальный Qwen/file run прошёл за21.07s (проверка28.18s): существующий execute_run отправил1 chunk, точные IDs provider request совпали с manifest, ответ подтвердил контрольное значение и серверную каноническую цитату. Manifest acknowledged/used, authenticated download совпал по SHA-256, vision и proposals отсутствовали. `.local/p10-real-agent-evidence.json` содержит безопасные IDs/лимиты/результаты без bearer. Forward0031 и адресный borrower-initiator regression прошли на repro; заимствованное предложение не сохраняет доступ после передачи назначения. Это доказательство начального текстового контекста, а не отдельного вызова read-tool моделью.

Независимая приёмка P10 завершена; capability support включён, max_text_chunks=20. Статус ready требует read-only ответа настроенного LM Studio `/api/v0/models`, точной загруженной модели и откалиброванного context; используются существующие AgentSettings. Ошибка, отсутствие модели или неверный context дают unavailable, поддержка формата остаётся true. Общий timeout1.5s, ответ<=64KiB, без inference/redirects/proxy; ручного флага нет. Отдельная готовность worker относится к P13. Изменённый capability-контракт проверен отдельно: положительный, недоступный и wrong-context сценарии —1 passed за0.41s; реальный read-only probe вернул ready за0.218s. Актуальный React ещё подключается в P12; текущая успешная серверная обработка не означает готовый пользовательский продукт. Общий регрессионный прогон и полный свежий replay миграций отложены до P12/P13 по указанию пользователя.
