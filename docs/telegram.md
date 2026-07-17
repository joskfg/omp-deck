# Telegram bridge

The Telegram bridge lets you chat with the omp agent from any Telegram
client — phone, desktop, web. DMs to your bot create or resume an omp
session keyed by `chat_id`. The bridge waits for the agent's turn to finish
and replies with the turn's final result only, never the intermediate flow.

The bridge is a **standalone Bun process** in `apps/bridges/telegram/`,
supervised by the deck server. Crashing the bridge does not affect the
deck or any in-flight chat sessions.

## Why standalone?

- Telegram long-polling has its own lifecycle (rate limits, transient 5xx,
  occasional 429s). Isolating it from the deck server keeps a single
  Telegram hiccup from interrupting the chat UI.
- The bridge can be restarted independently when you change credentials.

## Setup

### 1. Create the bot

Talk to [@BotFather](https://t.me/BotFather) on Telegram. Send `/newbot`,
pick a name and username, copy the bot token he gives you. It looks like:

```
1234567890:ABCdefGHIJklmnopQRSTuvwxyz
```

### 2. Find your numeric user ID

Telegram usernames are not enough — the bridge allowlist needs the numeric
user ID. Message [@userinfobot](https://t.me/userinfobot) on Telegram. It
echoes your ID back, like `987654321`.

If multiple people will DM the bot, collect each of their IDs.

### 3. Save the credentials in the deck

Open the deck, navigate to **Settings → Messaging → Telegram**.

- **Bot token** — paste the token. Saved masked.
- **Allowed users** — comma-separated numeric IDs (e.g. `987654321,123456789`).

Both must be set. The bridge refuses to start without them.

### 4. Start the bridge

Click **Start** in the Telegram card. The status pill flips to **RUNNING**,
showing the pid and uptime. Expand **Bridge logs** to confirm
`telegram bridge started` lands within a second.

### 5. Send a DM to your bot

Open Telegram, search for the bot username, hit Start, send any message.
Within a few seconds the bridge:

1. Creates a new omp session at `OMP_DECK_DEFAULT_CWD` (or the cwd of the
   chat-to-session mapping if you've messaged the bot before).
2. Forwards your text as a prompt.
3. Waits for the agent turn to finish, then sends the final assistant
   message as the reply — no tool calls, thinking, or partial text is ever
   sent, and nothing is sent until the turn ends. If the turn produces no
   final text, the bridge replies with "Turn complete.".

If the final reply exceeds Telegram's 4096-char message cap, the bridge
chunks it across multiple messages.

## Image attachments

Send a photo with an optional caption. The bridge downloads the largest
size, base64-encodes it, and forwards it as an omp `ImageAttachment` on the
prompt frame. The agent can `read` it like any other image.

## `/reset`

Send `/reset` in the Telegram chat. The bridge disposes the current omp
session and drops the chat→session mapping. The next message starts a fresh
session.

## Persistent chat→session map

The mapping lives at `<dataDir>/telegram-bridge.db` (SQLite). It survives
deck restarts so your conversation with the bot picks up across sessions.

To reset: `rm <dataDir>/telegram-bridge.db` while the bridge is stopped, then
restart it.

## Operations

| What | How |
|---|---|
| Start | Settings → Messaging → Telegram → Start |
| Stop | Settings → Messaging → Telegram → Stop |
| Restart (after token change) | Restart button (or Stop then Start) |
| View logs | Toggle "Bridge logs" in the Telegram card |
| Crash detection | Status pill flips to **CRASHED** with the exit code; crash count increments. Click Start to retry. |

The deck supervises the child process — when the deck server shuts down
(`Ctrl+C` or `/api/server/restart`), the bridge child is killed via
`safeShutdown`. There's no orphaned process after a clean exit.

## What's not in v1

- **Group chats**. DM-only.
- **Multi-user routing**. Single owner, single bot. If two people in
  `TELEGRAM_ALLOWED_USERS` DM the bot at the same time, they get **separate**
  sessions (keyed by `chat_id`) but share `OMP_DECK_DEFAULT_CWD` and provider
  quotas.
- **Hosting outside the tailnet**. The bridge always uses Telegram's
  outbound API (no inbound port needed), so it works behind NAT/Tailscale
  without exposing a port. But the deck it talks to is still loopback-only;
  the bridge is the only thing reaching out.
- **Slack / Discord / Matrix**. Same pattern but distinct catalog work —
  filed under deck-future. The bridge supervisor framework is reusable.

## Troubleshooting

**Bridge crashes immediately with "TELEGRAM_BOT_TOKEN is required".**
The credentials saved in Settings aren't reaching the bridge process. The
deck's managed `.env` writes to `<dataDir>/.env` and the bridge reads from
the same file. Confirm via `cat <dataDir>/.env` (Linux/macOS) or
`type %LOCALAPPDATA%\omp-deck\.env` (Windows).

**Bridge crashes with "TELEGRAM_ALLOWED_USERS must contain at least one numeric Telegram user id".**
You set a username instead of the numeric ID. Get the numeric ID via
[@userinfobot](https://t.me/userinfobot).

**Bot doesn't respond to messages.**
Check logs (expand "Bridge logs" in the card). The most common cause is
the user not being in the allowlist — the bridge replies with
"This omp-deck bot is private." and refuses to process.

**Replies only arrive once the agent turn finishes.**
By design (T-125) the bridge never sends a partial preview — a long coding
turn means a long wait before any reply, not a stream of intermediate
messages. There is no interval to tune for this.
