# Configuration

omp-deck reads configuration from three layers, in priority order:

1. **Process environment** — values set in the launching shell (or systemd
   unit, or Docker `-e`). Always win.
2. **Deck-managed `.env`** — file the deck writes when you save through the
   Settings → Env UI. Loaded into `process.env` at boot.
3. **Built-in defaults** — declared in
   `apps/server/src/config.ts` and `apps/server/src/env-schema.ts`.

The Settings → Env UI edits layer 2 only. It never overwrites layer 1: if you
launched the deck with `OMP_DECK_PORT=9000` in the shell, the Settings page
still shows port 9000 as the active value with source `process env`, and
saving a new value writes to the managed `.env` (where it will take effect
only after you remove the shell override and restart).

See [.env.example](../.env.example) for a copy-paste template with comments.

## Where the managed `.env` lives

| OS | Path | Override |
|---|---|---|
| Windows | `%LOCALAPPDATA%\omp-deck\.env` | `OMP_DECK_DATA_DIR=…` |
| Linux | `$XDG_CONFIG_HOME/omp-deck/.env` (defaults to `~/.config/omp-deck/.env`) | `OMP_DECK_DATA_DIR=…` |
| macOS | `~/.config/omp-deck/.env` | `OMP_DECK_DATA_DIR=…` |

The same directory holds:

- `env-audit.log` — append-only `timestamp | key | action (set/unset/reveal)`.
  Values are never logged.
- `telegram-bridge.db` — chat→session map (only when the bridge runs).

## Variable reference

### Network

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `OMP_DECK_HOST` | `127.0.0.1` | yes | Bind host. Loopback by default — never `0.0.0.0` without an auth layer. |
| `OMP_DECK_PORT` | `8787` | yes | HTTP + WebSocket port. |
| `OMP_DECK_WEB_PORT` | `5173` | yes | Vite dev server port (dev only). Proxies `/api` and `/ws` to `OMP_DECK_PORT`. |
| `OMP_DECK_API_BASE` | derived | no | Loopback URL standalone bridge processes use. Derived from host+port when unset. |
| `OMP_DECK_TITLE` | `omp-deck` | yes | Visible title in the upper-left corner of the web interface. |

### Workspaces

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `OMP_DECK_DEFAULT_CWD` | `process.cwd()` | next session | Working dir for new chat sessions. |
| `OMP_DECK_WORKSPACES` | _(none)_ | next session | Comma-separated extra workspace roots shown in the picker. |

Per-workspace **default model** is not an env var — it's a UI-managed, DB-backed override (`workspace_preferences` table, one row per exact `cwd`) set from Settings → Workspaces. See `docs/architecture.md`'s database table inventory. Precedence at session creation: explicit request `model` > this override > `OMP_MODEL` / SDK default above.

### omp SDK

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `OMP_AGENT_DIR` | `~/.omp/agent` | yes | omp SDK session + auth data directory. |
| `OMP_MODEL` | SDK default | next session | Default model id (e.g. `anthropic/claude-opus-4-7`). The model picker in the chat header overrides per-session. |
| `PI_NO_TITLE` | _(unset)_ | next session | Set truthy to disable SDK auto-title generation. |

### Auto-start (off by default)

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `OMP_DECK_AUTO_START` | `/start` | no | Prompt fired automatically when a new session opens. Set to `""` or `0` to disable; set to any other string to override the default `/start` slash-command invocation. Requires `~/.omp/agent/commands/start.md` to exist (see [start-command-template](./start-command-template.md)). |
| `OMP_DECK_IDLE_TIMEOUT_MS` | `300000` (5 min) | no | Milliseconds before an unsubscribed idle session is reaped. `0` disables reaping. |

### Storage

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `OMP_DECK_DB_PATH` | `apps/server/data/deck.db` | yes | SQLite database path. Use absolute path in production. |
| `OMP_DECK_DATA_DIR` | `%LOCALAPPDATA%/omp-deck` (Win) / `$XDG_CONFIG_HOME/omp-deck` (Unix) | yes | Directory for managed `.env`, audit log, bridge state. |
| `OMP_DECK_WEB_DIST` | auto-detected | yes | Static web bundle dir for production serving. |

### Logging

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `LOG_LEVEL` | `info` | no | `debug` / `info` / `warn` / `error`. Hot-applied. |

### Telegram bridge

The bridge is a separate Bun process (`apps/bridges/telegram/`) supervised by
the deck. None of these vars are required for the deck itself.

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | _(unset)_ | bridge | From @BotFather. Sensitive. |
| `TELEGRAM_ALLOWED_USERS` | _(unset)_ | bridge | Comma-separated numeric Telegram user IDs. Required. |
| `TELEGRAM_BRIDGE_DB_PATH` | `<dataDir>/telegram-bridge.db` | bridge | SQLite chat→session map. |

See [docs/telegram.md](./telegram.md) for the full bridge setup.

### Provider API keys

Read by the omp SDK directly from `process.env`. The deck Settings UI shows
them masked; reveal requires a loopback request.

| Var | Sensitive? | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API. |
| `OPENAI_API_KEY` | yes | OpenAI API. |
| `OPENROUTER_API_KEY` | yes | OpenRouter aggregator. |
| `GROQ_API_KEY` | yes | Groq API. |
| `GOOGLE_API_KEY` | yes | Gemini API. |
| `XAI_API_KEY` | yes | xAI / Grok API. |

If you authenticated via `omp` CLI (OAuth), the SDK reads credentials from
`~/.omp/agent/auth.db` instead of env vars. Either path works.

## Browser-local settings (not env vars)

A handful of preferences live in the browser's `localStorage`/`sessionStorage`
instead of the server-side layers above — per-browser, not shared across
machines or synced by the server:

| Setting | Where | Storage key |
|---|---|---|
| Stop-streaming keyboard shortcut | Settings → Appearance → Keyboard shortcuts | `abortShortcutKey` (default `/`) |
| Kanban workspace color markers | Board inspector | `omp-deck:project-colors` |
| Kanban workspace filter | Tasks header selector | `omp-deck:tasks:workspace-filter` (`sessionStorage`) |
| Last-active session (for `/` reconnect) | — | `omp-deck:last-session-id` |

## Restart semantics

Vars with `Restart?: yes` need a full server restart to take effect — typically
because they affect the bind socket, the SQLite file path, or the web bundle
location. The Settings UI surfaces a "Restart server to apply" banner with a
one-click button (`POST /api/server/restart`) when you save one.

Vars with `Restart?: no` hot-apply: `LOG_LEVEL` flips the logger threshold,
`OMP_DECK_IDLE_TIMEOUT_MS` re-arms the reaper, `OMP_DECK_AUTO_START` updates
the bridge in-process, etc.

Vars with `Restart?: bridge` mean the deck server keeps running, but the
relevant bridge process (e.g. telegram) must be restarted via Settings →
Messaging → Restart.

Vars with `Restart?: next session` apply only to sessions created **after**
the change — existing in-memory sessions keep their original values.
