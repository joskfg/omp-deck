/**
 * Auto Work → Telegram notifications (T-67). Every lifecycle trigger in
 * `engine.ts` funnels through the single `notify(event)` helper here.
 *
 * Integration point: this module is a *second* consumer of the exact same
 * Telegram integration the interactive chat bridge already uses —
 * `loadTelegramBridgeConfig()` (bot token + allowed user ids, validated) and
 * `TelegramApi.sendMessage` from `apps/bridges/telegram/src/{config,telegram}.ts`.
 * No parallel Telegram client, and no new "is configured" mechanism: the
 * gate is `isTelegramBridgeConfigured()` from `../bridge-supervisor.ts`,
 * the same `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ALLOWED_USERS` presence check
 * `BridgeSupervisor.start` already refuses to launch the bridge without.
 * `apps/bridges/telegram` itself is read-only — nothing there is modified.
 *
 * Delivery is push-only: there is no chat session for an auto-work event to
 * reply into, so every configured allowed-user id is treated as its own
 * Telegram chat id (true once that user has started a DM with the bot, the
 * standard assumption private bots make for unprompted pushes).
 *
 * Sending is best-effort — `notify()` never throws. An unconfigured bridge
 * is a silent no-op; a Telegram API failure is logged and swallowed so it
 * can never abort an auto-work cycle or leave a task/run in a bad state.
 */

import { loadTelegramBridgeConfig } from "../../../bridges/telegram/src/config.ts";
import { TelegramApi } from "../../../bridges/telegram/src/telegram.ts";
import { isTelegramBridgeConfigured } from "../bridge-supervisor.ts";
import { getServerSetting, setServerSetting } from "../db/server-settings.ts";
import { logger } from "../log.ts";

const log = logger("auto-work:notify");

export type AutoWorkNotificationEvent =
	| { kind: "task_started"; displayId: number; title: string; model: string }
	| { kind: "task_completed"; displayId: number; prNumber: number }
	| { kind: "task_auto_merging"; displayId: number; prNumber: number }
	| { kind: "task_auto_merged"; displayId: number; prNumber: number }
	| { kind: "task_completed_pr_failed"; displayId: number; reason: string }
	| { kind: "task_failed"; displayId: number; reason: string }
	| { kind: "weekly_threshold"; cwd: string; pctUsed: number; thresholdPct: number }
	| { kind: "session_limit"; sessionPctUsed: number; sessionPctLimit: number };

/** Renders the exact message template for `event`. Pure and independently testable. */
export function formatAutoWorkNotification(event: AutoWorkNotificationEvent): string {
	switch (event.kind) {
		case "task_started":
			return `🤖 AutoWork started T-${event.displayId}: ${event.title} [${event.model}]`;
		case "task_completed":
			return `✅ T-${event.displayId} → validate. PR #${event.prNumber}`;
		case "task_auto_merging":
			return `🔀 T-${event.displayId}: auto-merge armed (waiting for CI). PR #${event.prNumber}`;
		case "task_auto_merged":
			return `🎉 T-${event.displayId} merged → done. PR #${event.prNumber}`;
		case "task_completed_pr_failed":
			return `⚠️ T-${event.displayId} → validate (implementation complete, PR creation failed): ${event.reason}`;
		case "task_failed":
			return `❌ T-${event.displayId} failed: ${event.reason}`;
		case "weekly_threshold":
			return `⚠️ AutoWork: weekly budget at ${Math.round(event.pctUsed)}% (limit: ${event.thresholdPct}%)`;
		case "session_limit":
			return `⏸️ AutoWork paused: session limit reached (${Math.round(event.sessionPctUsed)}% of ${event.sessionPctLimit}% budget used this run)`;
	}
}

/** `server_settings` KV key tracking the last calendar date (UTC, `YYYY-MM-DD`) a weekly-threshold warning was sent for `cwd`. */
function weeklyThresholdDedupKey(cwd: string): string {
	return `auto_work:weekly_threshold_notified_date:${cwd}`;
}

function calendarDate(now: Date): string {
	return now.toISOString().slice(0, 10);
}

/**
 * Sends `event` to every allowed Telegram user. Resolves once every send
 * has either delivered or failed — never rejects.
 *
 * The `weekly_threshold` event is deduped to at most once per calendar day
 * (UTC) per `cwd`, persisted via the T-61 `server_settings` KV store so the
 * dedup survives a server restart. The dedup marker is only written once at
 * least one recipient receives the message, so an unconfigured or entirely
 * failed delivery never "uses up" the day's notification.
 */
export async function notify(event: AutoWorkNotificationEvent, now: Date = new Date()): Promise<void> {
	try {
		if (!isTelegramBridgeConfigured()) {
			log.debug(`telegram bridge not configured — skipping ${event.kind} notification`);
			return;
		}

		const dedupKey = event.kind === "weekly_threshold" ? weeklyThresholdDedupKey(event.cwd) : undefined;
		if (event.kind === "weekly_threshold" && dedupKey && getServerSetting(dedupKey) === calendarDate(now)) {
			log.debug(`weekly threshold notification for ${event.cwd} already sent today — skipping`);
			return;
		}

		const telegramConfig = loadTelegramBridgeConfig();
		const text = formatAutoWorkNotification(event);
		const api = new TelegramApi(telegramConfig.botToken);
		let delivered = false;
		await Promise.all(
			Array.from(telegramConfig.allowedUserIds).map(async (chatId) => {
				try {
					await api.sendMessage(chatId, text);
					delivered = true;
				} catch (err) {
					log.warn(`telegram sendMessage failed for chat ${chatId}`, err);
				}
			}),
		);

		if (dedupKey && delivered) setServerSetting(dedupKey, calendarDate(now));
	} catch (err) {
		// Belt-and-braces: `loadTelegramBridgeConfig` can still throw (e.g. a
		// malformed TELEGRAM_ALLOWED_USERS slipped past `isTelegramBridgeConfigured`'s
		// presence-only check). A notification is never allowed to propagate.
		log.warn(`auto-work notify(${event.kind}) failed`, err);
	}
}
