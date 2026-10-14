# Запуск из новой копии и продолжение работы

Эта инструкция не требует файлов с прежнего компьютера. Пароли, базы, веса моделей, загруженные документы и приватные журналы не входят в Git. Новый запуск создаёт отдельные синтетические данные; состояние прежнего стенда переносится отдельно по [OPERATIONS.md](OPERATIONS.md).

Проверенный путь: Windows 11, Docker Desktop с Linux-контейнерами amd64, Docker Compose 2.24.4+, Python 3.13 и Node.js 22. Для модели нужен LM Studio с поддержкой Qwen3.5. На проверочном компьютере использовались 16 ГБ RAM и RTX 4060 Laptop с 8 ГБ VRAM; запас памяти был мал. На другой машине заново измеряется контекст, а производительность и другие ОС не считаются проверенными автоматически.

## 1. Копия и зависимости

```powershell
git clone https://github.com/PurpleCloudy/backend_dean.git
Set-Location backend_dean
py -3.13 -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
.venv\Scripts\python.exe deploy/prepare_local.py
```

Последняя команда создаёт игнорируемые `.local/p13-deploy-*`, новый случайный пароль PostgreSQL, шаблон настройки модели и приватный Compose env. Повторная подготовка не перезаписывает существующие файлы. Не запускайте её заново для уже настроенной копии.

```powershell
$c = @('-p','deanery-p13','--env-file','.local/p13-deploy-compose.env',
       '-f','compose.files.yaml','-f','compose.knowledge.yaml','-f','compose.yaml',
       '-f','deploy/local-http.compose.yaml')
docker compose @c config --quiet
docker compose @c build api file-worker proxy bge
```

Пакет собирает backend, React, OCR-обработчик и BGE из закреплённых зависимостей. Qdrant скачивается из официального образа по digest, прежний локальный тег не нужен. Загрузка BGE при первой сборке требует доступа к Hugging Face и места под веса. Фронтенд устанавливается по `package-lock.json`; его зависимости не следует обновлять во время переноса.

Все дальнейшие команды выполняются из корня. Если порт8443 занят другим стендом, освободите именно этот стенд или согласуйте другой origin/port. Для одновременных копий используйте разные `-p`, каталоги и порты, а не общий volume.

## 2. Только первая инициализация пустой базы

```powershell
$existing = docker volume ls --filter 'name=^deanery-p13_postgres_data$' --format '{{.Name}}'
if ($LASTEXITCODE -ne 0) { throw 'Не удалось проверить volume' }
if ($existing) { throw 'База уже существует: используйте раздел повторного запуска' }
docker compose @c -f deploy/bootstrap.compose.yaml up -d --wait db
docker compose @c run --rm --no-deps bootstrap
docker compose @c run --rm --no-deps migrate
docker compose @c run --rm --no-deps provision
docker compose @c run --rm --no-deps synthetic-seed
docker compose @c up -d --wait --force-recreate db
```

Проверяйте код завершения каждой команды; после сбоя не запускайте следующие шаги вслепую. Bootstrap, миграции, отдельные ограниченные подключения и seed уже реализованы в существующих модулях. Последний запуск БД сохраняет данные и убирает временный административный секрет из контейнера. `synthetic-seed` используется только для новой пустой тестовой базы, создаёт пароли для пяти существующих ролей в `.local/p13-deploy-secrets/acceptance-logins.json` и отказывается повторно засевать данные. Этот файл открывайте локально, в Git его не добавляйте.

На обычном Linux, где bind-mount сохраняет UID, приватным каталогам файлов/health и секретам нужны права пользователя контейнера10001, а `postgres-password` читает postgres999. Настройте владельцев только этих новых каталогов перед bootstrap и после редактирования секретов. Нативный Linux также требует явно доступного контейнеру адреса LM Studio; не расширяйте автоматически сетевую доступность провайдера. Приведённая последовательность проверяется с Docker Desktop, а исторические Windows browser-harness не являются универсальным Linux-запуском.

## 3. Модель и калибровка

В LM Studio загрузите `bartowski/Qwen_Qwen3.5-9B-GGUF`, квантование `Q4_K_M`, задайте identifier `qwen_qwen3.5-9b`, context20480, parallel1 и запустите OpenAI-compatible server на1234. При наличии установленной CLI и весов соответствующие команды:

```powershell
lms server start --port 1234
lms load qwen_qwen3.5-9b --identifier qwen_qwen3.5-9b --context-length 20480 --parallel 1 --gpu max
docker compose @c --profile knowledge-start up -d --no-deps bge qdrant
docker compose @c run --rm --no-deps api python -m backend.agent_calibration measure --env-file /app/.local/agent.env > .local/calibration.json
if ($LASTEXITCODE -ne 0) { throw 'Калибровка не прошла; агент пока не запускается' }
.venv\Scripts\python.exe -m backend.agent_calibration apply --env-file .local/p13-deploy-secrets/agent.env --result .local/calibration.json
docker compose @c --profile agent-start up -d --no-deps api agent-worker file-worker knowledge-worker order-worker proxy
```

`lms load` требует реально установленную модель с указанным ключом; после загрузки через каталог LM Studio при необходимости выберите фактический путь GGUF вместо короткого ключа. Не загружайте одновременно вторую LLM в8 ГБ VRAM. Не запускайте второй BGE, если решили использовать уже существующий экземпляр: тогда задайте его доступный URL в приватном Compose env и пропустите запуск `bge`.

Новая калибровка использует один настоящий запрос с точными14 tools и не выполняет предметных действий. В файл попадают только параметры и бюджет, а не ответы модели или секреты. Применение сверяет модель, endpoint, context и остальные параметры; предыдущий env сохраняется. После замены модели, адреса, настроек или tool/schema калибровку повторяют. Начальный шаблон намеренно не считается откалиброванным.

Приложение: **http://localhost:8443**. Только proxy опубликован на127.0.0.1. Этот дополнительный конфиг предназначен для локальной разработки без сертификата; основной [HTTPS runbook](../deploy/README.md) сохранён. Формы должны работать независимо от наличия модели. Пустой нормативный индекс после первого запуска означает отсутствие нормативов, а не успешный поиск: импорт/публикация описаны в [KNOWLEDGE_RUNTIME.md](KNOWLEDGE_RUNTIME.md).

## 4. Повторный запуск

После перезагрузки сначала запустите Docker Desktop и ту же модель/LM Studio. В новой PowerShell-сессии заново задайте массив `$c` из раздела1, затем:

```powershell
docker compose @c up -d --wait --no-deps db qdrant
docker compose @c run --rm --no-deps migrate
docker compose @c --profile knowledge-start up -d --no-deps bge
docker compose @c --profile agent-start up -d --no-deps api agent-worker file-worker knowledge-worker order-worker proxy
```

Bootstrap, provision и seed повторно не выполняются. После добавления/смены сотрудников оператор запускает `python -m backend.db.provision_personal_roles <private-admin.json>`; при обновлении с 0039 это обязательно после миграций и создания/проверки служебных LOGIN. Процедура идемпотентна. Новая схема — head `0056_read_boundaries`, 56 предметных +16 служебных таблиц; порядок безопасного обновления существующей базы указан в [NEW_DATABASE_IMPLEMENTATION.md](NEW_DATABASE_IMPLEMENTATION.md). После миграций меняйте калибровку только если изменился соответствующий профиль. Для остановки сохраняющей данные: `docker compose @c --profile agent-start --profile knowledge-start stop`. Не используйте `down -v` при переносе или продолжении.

## 5. Проверки и точка продолжения

```powershell
.venv\Scripts\python.exe -m pytest backend/tests deploy/test_packaging.py deploy/test_portable.py -q -p no:cacheprovider
node prototype/check.cjs
Set-Location frontend
npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund
npm run build
node --experimental-vm-modules tests/chat/contracts-check.mjs
node --experimental-vm-modules tests/proposals/proposals-check.mjs
```

Без `TEST_DATABASE_DSN` интеграционные SQL-тесты явно пропускаются. Для них нужна отдельная мигрированная/засеянная тестовая БД; не подставляйте рабочую базу. Архивные `p12_*`/`p13_*` harness привязаны к своим схемам, приватным fixture и прежней машине. Для продолжения актуальны [план](DETAILED_IMPLEMENTATION_PLAN.md), [статус](IMPLEMENTATION_STATUS.md), [109 браузерных случаев и незакрытые ошибки](VISIBLE_BROWSER_QA.md), [API](API.md) и [эксплуатация](OPERATIONS.md). Доказательства с синтетическими данными сохранены в `docs/qa`; приватные дампы и полномасштабные модельные журналы остаются вне Git.
