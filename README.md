# mattermost-mcp-proxy

MCP-прокси для Mattermost с автоматическим извлечением токена авторизации из запущенного Mattermost-клиента через Chrome DevTools Protocol (CDP). Personal Access Token (PAT) не требуется.

## Как это работает

```
MCP-клиент (opencode, Claude Code и др.)
    | stdio
    v
mattermost-mcp-proxy (Node.js)
    |
    |-- 1. Подключается к Mattermost-клиенту через CDP
    |      - Извлекает cookie MMAUTHTOKEN
    |      - Извлекает User-Agent и все cookies домена
    |
    |-- 2. Запускает локальный reverse proxy (http://127.0.0.1:<порт>)
    |      - Подставляет заголовки браузера в каждый запрос
    |      - Обходит antibot/WAF на корпоративных инстансах
    |      - Кэширует ответы для повторных запросов сущностей
    |
    +-- 3. Запускает официальный Mattermost MCP server
           - Направляет его на локальный reverse proxy
           - Передает MM_ACCESS_TOKEN и MM_SERVER_URL
           - Проксирует stdio между MCP-клиентом и MCP-сервером
```

Прокси подключается к Mattermost-клиенту через CDP на `127.0.0.1:9222`. Через WebSocket вызывает `Network.getAllCookies` и `Runtime.evaluate` для получения токена сессии, User-Agent и всех cookies.

## Требования

- **Windows 10+** или **Ubuntu** (или другой Linux-дистрибутив)
- **Mattermost-клиент** (Desktop или любой Electron-клиент), запущенный с CDP
- **Node.js** >= 22 (встроенные `fetch` и `WebSocket`)
- **Go** >= 1.24 (для сборки официального Mattermost MCP server)

## Установка

### Linux

```bash
sudo bash install.sh
```

### Windows

Запустите PowerShell от имени администратора:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install.ps1
```

### Что делает скрипт установки

Скрипты `install.sh` (Linux) и `install.ps1` (Windows) выполняют одинаковые шаги:

1. Установят Node.js 22 и Go 1.24 (если не установлены)
2. Склонируют и соберут официальный [Mattermost MCP server](https://github.com/mattermost/mattermost-plugin-agents) (`mcpserver/cmd/main.go`)
3. Соберут и установят `mattermost-mcp-proxy` (Linux: `/opt/mattermost-mcp-proxy`, Windows: `%ProgramFiles%\mattermost-mcp-proxy`)
4. Создадут шаблон конфига `~/.mattermost-mcp-proxy.json`

### После установки

1. Отредактируйте `~/.mattermost-mcp-proxy.json`:

```json
{
  "serverUrl": "https://mattermost.your-company.com",
  "mcpServerPath": "/usr/local/bin/mattermost-mcp-server",
  "cdpPort": 9222,
  "tlsVerify": false,
  "cacheTtl": 300,
  "restrictions": {
    "allowedTools": ["read_channel", "create_post", "search_posts", "get_channel_info"],
    "allowedChannels": ["town-square", "dev-team"],
    "allowedUsers": ["john.doe"]
  }
}
```

2. Запустите Mattermost-клиент с флагом `--remote-debugging-port=9222`

3. Проверьте работу:

```bash
mattermost-mcp-proxy
```

В stderr должны появиться логи извлечения токена и запуска MCP-сервера.

## Конфигурация

Конфигурация загружается из переменных окружения и/или JSON-файла `~/.mattermost-mcp-proxy.json`. Переменные окружения имеют приоритет.

| Переменная окружения | Ключ в JSON | Обязательный | Описание |
|---|---|---|---|
| `MM_SERVER_URL` | `serverUrl` | да | URL сервера Mattermost |
| `MM_MCP_SERVER_PATH` | `mcpServerPath` | да | Путь к бинарнику `mattermost-mcp-server` |
| `MM_MCP_SERVER_ARGS` | `mcpServerArgs` | нет | Доп. аргументы для MCP-сервера (через пробел) |
| `MM_CDP_PORT` | `cdpPort` | нет | Порт CDP (по умолчанию: 9222) |
| `MM_TLS_VERIFY` | `tlsVerify` | нет | Проверка TLS-сертификатов: `true`/`1` — включить, `false`/`0` — выключить (по умолчанию: `false`) |
| `MM_CACHE_TTL` | `cacheTtl` | нет | TTL кэша сущностей в секундах (по умолчанию: `300` = 5 мин). `0` — отключить кэш |
| `MCP_PROXY_CONFIG` | -- | нет | Путь к JSON-конфигу (по умолчанию: `~/.mattermost-mcp-proxy.json`) |
| -- | `restrictions` | нет | Ограничения возможностей агента (см. ниже) |

### Кэширование сущностей

Reverse proxy автоматически кэширует ответы для часто запрашиваемых сущностей Mattermost. Это ускоряет работу агента, т.к. при типичном сценарии одни и те же пользователи, каналы и команды запрашиваются многократно.

**Кэшируемые GET-эндпоинты (lookup по ID/имени):**

| Эндпоинт | Описание |
|---|---|
| `/api/v4/users/{id}` | Пользователь по ID |
| `/api/v4/users/username/{username}` | Пользователь по имени |
| `/api/v4/users/me` | Текущий пользователь |
| `/api/v4/users/me/teams` | Команды текущего пользователя |
| `/api/v4/teams/{id}` | Команда по ID |
| `/api/v4/teams/{id}/channels/name/{name}` | Канал по имени |
| `/api/v4/channels/{id}` | Канал по ID |
| `/api/v4/channels/{id}/members` | Участники канала |

**Кэшируемые POST-эндпоинты (поиск пользователей и каналов):**

| Эндпоинт | Описание |
|---|---|
| `POST /api/v4/users/search` | Поиск пользователей по критериям |
| `POST /api/v4/users/autocomplete` | Автодополнение имени пользователя |
| `POST /api/v4/users/ids` | Получение пользователей по списку ID |
| `POST /api/v4/users/usernames` | Получение пользователей по списку имён |
| `POST /api/v4/teams/{id}/channels/search` | Поиск каналов в команде |
| `POST /api/v4/channels/search` | Поиск каналов по всем командам |
| `POST /api/v4/channels/ids` | Получение каналов по списку ID |

Для POST-запросов ключ кэша формируется из URL + SHA-256 хэша тела запроса, т.е. одинаковые поисковые запросы возвращают кэшированный результат.

- TTL по умолчанию: **5 минут** (настраивается через `cacheTtl`)
- Кэшируются только успешные ответы (2xx)
- Посты, результаты поиска постов и другие динамические данные **не кэшируются**
- Для кэшируемых запросов отключается сжатие (`accept-encoding`), чтобы хранить plain text
- Установите `cacheTtl: 0` для полного отключения кэша

```
[mattermost-mcp-proxy/reverse-proxy] Cache HIT: /api/v4/users/abc123def456ghi789jkl012mn
[mattermost-mcp-proxy/reverse-proxy] Cache HIT: POST /api/v4/users/search
[mattermost-mcp-proxy/cache] Cached: POST:/api/v4/users/search:a1b2c3d4e5f6g7h8 (512 bytes, 5 entries total)
```

### Ограничения (`restrictions`)

Секция `restrictions` позволяет ограничить возможности агента на уровне прокси. Все поля опциональны и работают независимо.

```json
{
  "restrictions": {
    "allowedTools": ["read_channel", "create_post", "search_posts"],
    "allowedChannels": ["town-square", "dev-team"],
    "allowedUsers": ["john.doe", "bot-account"]
  }
}
```

| Ключ | Описание |
|---|---|
| `allowedTools` | Whitelist инструментов MCP-сервера. Остальные скрыты из `tools/list` и заблокированы при вызове |
| `allowedChannels` | Whitelist каналов для записи. Чтение не ограничивается. Можно указывать имена каналов или ID |
| `allowedUsers` | Whitelist пользователей для записи (DM, добавление в канал/команду) и прямых сообщений. Можно указывать username или ID |

Имена каналов и пользователей автоматически резолвятся в ID через Mattermost API при старте прокси. Если значение уже выглядит как ID (26 символов), оно используется как есть.

#### Полный список инструментов MCP-сервера

В таблице ниже перечислены все инструменты официального Mattermost MCP server и ограничения, которые наш прокси может применить к каждому из них.

| Инструмент | Тип | `allowedTools` | `allowedChannels` | `allowedUsers` | Параметры |
|---|---|---|---|---|---|
| `read_post` | чтение | фильтруется | — | — | `post_id`, `include_thread` |
| `read_channel` | чтение | фильтруется | — | — | `channel_id`, `limit`, `since` |
| `search_posts` | чтение | фильтруется | — | — | `query`, `team_id`, `channel_id` |
| `get_channel_info` | чтение | фильтруется | — | — | `channel_id`, `channel_display_name`, `channel_name`, `team_id` |
| `get_channel_members` | чтение | фильтруется | — | — | `channel_id`, `limit`, `page` |
| `get_user_channels` | чтение | фильтруется | — | — | `team_id`, `page`, `per_page` |
| `get_team_info` | чтение | фильтруется | — | — | `team_id`, `team_display_name`, `team_name` |
| `get_team_members` | чтение | фильтруется | — | — | `team_id`, `limit`, `page` |
| `search_users` | чтение | фильтруется | — | — | `term`, `limit` |
| `create_post` | запись | фильтруется | по `channel_id` | — | `channel_id`, `channel_display_name`, `team_display_name`, `message`, `root_id`, `attachments` |
| `create_channel` | запись | фильтруется | — | — | `name`, `display_name`, `type`, `team_id`, `purpose`, `header` |
| `add_user_to_channel` | запись | фильтруется | по `channel_id` | по `user_id` | `user_id`, `channel_id` |
| `add_user_to_team` | запись | фильтруется | — | по `user_id` | `user_id`, `team_id` |
| `dm` | DM | фильтруется | — | по `username` | `username`, `message`, `attachments` |
| `group_message` | DM | фильтруется | — | по `usernames[]` | `usernames[]`, `message`, `attachments` |
| `create_user` | запись (dev) | фильтруется | — | — | `username`, `email`, `password`, `first_name`, `last_name`, `nickname`, `profile_image` |
| `create_post_as_user` | запись (dev) | фильтруется | по `channel_id` | — | `username`, `password`, `channel_id`, `message`, `root_id`, `props`, `attachments` |
| `create_team` | запись (dev) | фильтруется | — | — | `name`, `display_name`, `type`, `description`, `team_icon` |
| `add_user_to_team` | запись (dev) | фильтруется | — | по `user_id` | `user_id`, `team_id` |

**Обозначения:**
- **`allowedTools`** — если настроен, инструмент полностью скрыт и заблокирован, если не в списке
- **`allowedChannels`** — блокирует вызов, если `channel_id` не в списке разрешённых (только для записи)
- **`allowedUsers`** — блокирует вызов, если `user_id` не в списке (для write tools) или `username`/`usernames[]` не в списке (для DM tools)
- **чтение** — не ограничивается `allowedChannels`/`allowedUsers` (но может быть полностью отключено через `allowedTools`)
- **dev** — инструменты, доступные только в dev-режиме MCP-сервера

### Логирование

Все вызовы инструментов логируются в stderr с полными аргументами:

```
[mattermost-mcp-proxy/filter] Tool call: "create_post" args={"channel_id":"abc123","message":"Hello"}
[mattermost-mcp-proxy/filter] Blocked DM: "dm" targeting username "john.doe"
```

Это позволяет отслеживать все действия агента и блокировки в реальном времени.

## Подключение к MCP-клиентам

### opencode

`opencode.json`:

```json
{
  "mcp": {
    "mattermost": {
      "type": "local",
      "command": ["mattermost-mcp-proxy"],
      "environment": {
        "MM_SERVER_URL": "https://mattermost.your-company.com",
        "MM_MCP_SERVER_PATH": "/usr/local/bin/mattermost-mcp-server",
        "MM_CDP_PORT": "9222"
      }
    }
  }
}
```

## Архитектура

```
src/
  index.ts          -- Точка входа: извлечение токена и запуск MCP-сервера
  config.ts         -- Загрузка конфигурации из env и JSON
  cdp-extract.ts    -- Извлечение токена, cookies и User-Agent через CDP WebSocket
  reverse-proxy.ts  -- Локальный HTTP reverse proxy с подстановкой заголовков браузера и кэшированием
  proxy.ts          -- Запуск MCP-сервера через reverse proxy
  mcp-filter.ts     -- Фильтрация MCP JSON-RPC сообщений (инструменты, каналы, пользователи)
  resolve.ts        -- Резолвинг имён каналов/пользователей в ID через Mattermost API
  cache.ts          -- In-memory кэш для GET/POST-запросов к API сущностей Mattermost
```

### Извлечение токена

При каждом запуске прокси подключается к Mattermost-клиенту через CDP (`http://127.0.0.1:<cdpPort>/json`), находит страницу Mattermost, и через WebSocket вызывает `Network.getAllCookies` и `Runtime.evaluate("navigator.userAgent")` для получения токена, cookies и User-Agent.

## Включение CDP на Mattermost-клиенте

Запустите Mattermost-клиент с флагом:

```bash
/path/to/mattermost-desktop --remote-debugging-port=9222
```

Проверка работы CDP:

```bash
curl -s http://127.0.0.1:9222/json | head -20
```

Должен вернуться JSON-массив с целями браузера.

## Решение проблем

### "CDP returned no result"

- Mattermost-клиент не запущен или запущен без `--remote-debugging-port=9222`
- Проверьте: `curl -s http://127.0.0.1:9222/json`

### "Failed to start MCP server: spawn ... ENOENT"

- Бинарник MCP-сервера не собран. Перезапустите `sudo bash install.sh` или соберите вручную:

```bash
git clone https://github.com/mattermost/mattermost-plugin-agents.git /tmp/mm-mcp
cd /tmp/mm-mcp
git checkout 46a4f9a8262369965d9054931f7274f69b070219
go build -o /usr/local/bin/mattermost-mcp-server ./mcpserver/cmd/main.go
chmod +x /usr/local/bin/mattermost-mcp-server
```

> Коммит `46a4f9a` зафиксирован для воспроизводимой сборки. Если нужна новая версия — обновите хэш здесь и в `install.sh`.

## Нулевые зависимости

У прокси **нет runtime npm-зависимостей**. Используются только встроенные API Node.js 22:

- `fetch` -- HTTP-запросы
- `WebSocket` -- коммуникация с CDP
- `http`/`https` -- reverse proxy
- `child_process` -- запуск MCP-сервера

Build-зависимости (TypeScript) удаляются после компиляции.