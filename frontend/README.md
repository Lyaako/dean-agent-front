# Фронт агента деканата

Рабочая React-копия закреплённого commit `9c68ae0c5f062b87811058599151bc135576b33d`. Эталон `references/frontend-source/frontend` и макет неизменяемы. Сервер — текущий `backend/` этого проекта.

## Установка и запуск

Проверено: Node22.14.0/npm10.9.2. Все версии утверждённого lock сохраняются:

```powershell
npm --prefix frontend ci --legacy-peer-deps --no-audit --no-fund
$env:VITE_API_TARGET = 'http://localhost:<порт текущего backend>'
npm --prefix frontend run dev
```

Перед запуском замените порт на фактический адрес API. Без `VITE_API_TARGET` dev завершится явной ошибкой. Браузер открывает `http://localhost:5173`; backend разрешает именно этот Origin и использует предусмотренный режим localhost-cookie. `/api` идёт через same-origin proxy. Учётные данные берутся из отдельно подготовленной приватной fixture; секретов в исходниках нет.

Флаг установки нужен из-за peer-требования `openapi-typescript7.13.0 → TypeScript^5.x` при закреплённом TS7.0.2. `gen:api` не используется и не проверен, его исходный POSIX script напрямую не запускается в PowerShell. Версии не понижались:187 packages установлены, SHA256 lock совпал с эталоном.

## Проверки

Только новые foundation assertions, без DB/модели:

```powershell
node --experimental-vm-modules frontend/tests/integration/foundation-check.mjs
```

Проверяются смена сессии/поздний refresh, HTTP replay, явный предел20 000 строк, все8 OLAP mode/status_id, числовые ключи и null gap графика. Используется встроенный Node TypeScript stripping; TS7 не экспортирует прежний transpileModule. Новых test dependencies нет.

Общий `npm run build` прошёл (tsc + Vite8.3.3,619 modules). Исправлены4 compile ошибки PDF.js6/TS7 без смены зависимостей. Foundation/chat адресные assertions прошли повторно. Bundled Playwright1.62.1 с установленным Chromium1208 (browser145.0.7632.6) действительно запущен; настоящий React StrictMode login render прошёл без pageerrors. Единая полная browser/API/DB матрица ещё не принята.

Изолированная P12 fixture: private `.local/p12-ui-{connection,api,agent}.json` и `.local/p12-browser-credentials.json`. Только для неё `frontend/tests/integration/runtime.py` проверяет0037/71 application tables/5roles перед созданием паролей и запускает API8881 без вывода секретов. Текущий проверочный Origin — `http://127.0.0.1:5174`:5173 занят посторонним старым preview. Из корня, в двух отдельных процессах:

```powershell
.venv\Scripts\python.exe frontend\tests\integration\runtime.py api
```

```powershell
Set-Location frontend
$env:VITE_API_TARGET = 'http://127.0.0.1:8881'
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort
```

Затем из корня `node frontend/tests/integration/browser-check.mjs baseline`. Harness использует один установленный Chromium worker; его пути привязаны к этой машине. Итоговая evidence не включает passwords/tokens/headers. Это baseline ролей/страниц/OLAP/auth, полная матрица форм/очереди/файлов/агента проверяется отдельно внутри того же приложения.

Bounded `browser-check.mjs discipline` прошёл: настоящее нажатие slice-discipline,15rows/717results/11debts,15HTTPresponses,0pageerrors,logout. `discipline-check.py live` прошёл для5roles:59catalog rows/read200/write403/directscope equality и unauthenticated/revoked401. Forward0037 оставляет прежний auth gate побайтно,13tool staticfingerprint c49f иagent registry не меняются. Для полного baseline5×8/auth остаётся отдельный следующий прогон.

Сохранены восемь вкладок, таблицы, формы и CSS. OLAP использует серверные значения/weighted total/scale. Форма сотрудника сообщает о сохранённом ФИО при отказе второго employee PATCH. Chat/history/replay/files и proposals/queue интегрируются отдельными владельцами. Матрица доказательств — [FRONTEND_INTEGRATION.md](../docs/FRONTEND_INTEGRATION.md), общая готовность — [IMPLEMENTATION_STATUS.md](../docs/IMPLEMENTATION_STATUS.md).
