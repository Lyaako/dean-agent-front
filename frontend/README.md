# Фронт агента деканата

React + TypeScript + Vite. Внешний вид — из макета `../mockup/redesign/`, данные — из бэкенда
[backend_dean](https://github.com/PurpleCloudy/backend_dean).

## Запуск

1. Поднять бэкенд по его README. Локально он работает на `http://localhost:8010`
   (порт задан в `~/backend_dean/.local/compose.port.yaml`).
2. Установить зависимости и запустить:

```bash
npm --prefix frontend install
```

```bash
npm --prefix frontend run dev
```

Откройте `http://localhost:5173` — именно `localhost`, не `127.0.0.1`: cookie обновления сессии `SameSite=Strict`.
Вход — `admin`, пароль — `BOOTSTRAP_PASSWORD` из `~/backend_dean/.env.local`.

Запросы `/api` проксируются на бэкенд (`vite.config.ts`). Другой адрес бэкенда — переменная `VITE_API_TARGET`.

## Устройство

- `src/api/` — запросы: вход и обновление токена (`client.ts`, `auth.ts`), таблицы (`resources.ts`), описание полей (`schema.ts`), агент (`agent.ts`), файлы (`files.ts`), тексты ошибок (`errors.ts`).
- `src/components/table/` — таблица из макета: поиск, фильтры, сортировка, страницы.
- `src/components/form/` — форма записи по `GET /api/v1/schema`, выпадающие списки связанных таблиц (`lookups.ts`), формы приказов.
- `src/pages/` — вкладки. Новая вкладка = представление + таблица для изменений + колонки (`columns.tsx`).
- `src/chat/` — чат: стрим ответов, сохранённые чаты (`store/`), вложения (`attachments/`), окно подтверждения изменений агента (`proposals/`).

## Что временно

- Чаты хранятся в браузере (`localChatStore`): у бэкенда пока нет списка сессий и сообщений. Появится — нужен `serverChatStore` с тем же интерфейсом `ChatStore`.
- `chat/proposals/ProposalDialog.tsx` — временный вид окна «разрешить / отклонить»; финальный будет по шаблону из другого проекта. Логика — в `useProposal.ts`.
- Вложения уходят агенту, только когда `GET /agent/capabilities` отвечает `agent_supported: true`; сейчас исходный агент их не читает.
- OLAP — следующий этап.
