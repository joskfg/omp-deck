/**
 * Tests for Auto Work → Telegram notifications (T-67).
 *
 * Covers:
 *  - Each of the 5 message templates renders exactly as specified.
 *  - No Telegram API call is attempted when the bridge isn't configured
 *    (missing bot token / allowed users).
 *  - A Telegram API failure (fetch throws / rejects) never propagates out
 *    of `notify()`.
 *  - The weekly-threshold event is deduped to at most once per calendar day,
 *    persisted via `server_settings` so it survives a restart.
 *
 * `TelegramApi.sendMessage` hits `fetch` directly — we stub `globalThis.fetch`
 * rather than mocking module internals, since that's the actual boundary
 * `notify()` crosses into the outside world.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "../db/index.ts";
import { formatAutoWorkNotification, notify } from "./notify.ts";

let dbDir: string;
let originalEnv: Record<string, string | undefined>;
let originalFetch: typeof fetch;
let fetchCalls: { url: string; body: unknown }[];

const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "OMP_DECK_DATA_DIR", "OMP_DECK_API_BASE"];

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-notify-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });

	originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	// Isolate from any real machine-level telegram config / managed .env file —
	// `loadTelegramBridgeConfig` calls `loadManagedEnvIntoProcess`, which would
	// otherwise read `~/.config/omp-deck/.env` and silently un-skip a test.
	process.env.OMP_DECK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-notify-data-"));

	fetchCalls = [];
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	closeDb();
	globalThis.fetch = originalFetch;
	for (const [k, v] of Object.entries(originalEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		fs.rmSync(dbDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

function configureTelegram(): void {
	process.env.TELEGRAM_BOT_TOKEN = "test-token";
	process.env.TELEGRAM_ALLOWED_USERS = "111,222";
}

function stubFetchOk(): void {
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
		return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1 } } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

function stubFetchThrows(): void {
	globalThis.fetch = (async () => {
		throw new Error("network unreachable");
	}) as unknown as typeof fetch;
}

function telegramText(body: unknown): string {
	if (body && typeof body === "object" && "text" in body && typeof body.text === "string") return body.text;
	throw new Error("expected a telegram payload with a string text field");
}

function telegramChatId(body: unknown): string {
	if (body && typeof body === "object" && "chat_id" in body && typeof body.chat_id === "string") return body.chat_id;
	throw new Error("expected a telegram payload with a string chat_id field");
}

describe("formatAutoWorkNotification", () => {
	test("task_started", () => {
		expect(
			formatAutoWorkNotification({ kind: "task_started", displayId: 42, title: "Ship the thing", model: "anthropic/claude" }),
		).toBe("🤖 AutoWork started T-42: Ship the thing [anthropic/claude]");
	});

	test("task_completed", () => {
		expect(formatAutoWorkNotification({ kind: "task_completed", displayId: 42, prNumber: 7 })).toBe(
			"✅ T-42 → validate. PR #7",
		);
	});

	test("task_completed_pr_failed", () => {
		expect(
			formatAutoWorkNotification({
				kind: "task_completed_pr_failed",
				displayId: 42,
				reason: "GitHub authentication expired or missing — run `gh auth login`",
			}),
		).toBe(
			"⚠️ T-42 → validate (implementation complete, PR creation failed): GitHub authentication expired or missing — run `gh auth login`",
		);
	});

	test("task_failed", () => {
		expect(formatAutoWorkNotification({ kind: "task_failed", displayId: 42, reason: "exceeded 90min timeout" })).toBe(
			"❌ T-42 failed: exceeded 90min timeout",
		);
	});

	test("weekly_threshold", () => {
		expect(
			formatAutoWorkNotification({ kind: "weekly_threshold", cwd: "/tmp/ws", pctUsed: 83.7, thresholdPct: 80 }),
		).toBe("⚠️ AutoWork: weekly budget at 84% (limit: 80%)");
	});

	test("session_limit", () => {
		expect(
			formatAutoWorkNotification({ kind: "session_limit", sessionPctUsed: 45.2, sessionPctLimit: 30 }),
		).toBe("⏸️ AutoWork paused: session limit reached (45% of 30% budget used this run)");
	});
});

describe("notify — configuration gate", () => {
	test("silently skips (no fetch attempted) when the telegram bridge isn't configured", async () => {
		delete process.env.TELEGRAM_BOT_TOKEN;
		delete process.env.TELEGRAM_ALLOWED_USERS;
		stubFetchOk();

		await notify({ kind: "task_started", displayId: 1, title: "X", model: "default" });

		expect(fetchCalls).toHaveLength(0);
	});

	test("sends to every allowed user when configured", async () => {
		configureTelegram();
		stubFetchOk();

		await notify({ kind: "task_completed", displayId: 5, prNumber: 99 });

		expect(fetchCalls).toHaveLength(2);
		const texts = fetchCalls.map((c) => (c.body as { text: string }).text);
		expect(texts).toEqual(["✅ T-5 → validate. PR #99", "✅ T-5 → validate. PR #99"]);
		const chatIds = fetchCalls.map((c) => (c.body as { chat_id: string }).chat_id).sort();
		expect(chatIds).toEqual(["111", "222"]);
	});

	test("sends task_completed_pr_failed to every allowed user when configured", async () => {
		configureTelegram();
		stubFetchOk();

		await notify({ kind: "task_completed_pr_failed", displayId: 5, reason: "boom" });

		expect(fetchCalls).toHaveLength(2);
		const texts = fetchCalls.map((c) => telegramText(c.body));
		expect(texts).toEqual([
			"⚠️ T-5 → validate (implementation complete, PR creation failed): boom",
			"⚠️ T-5 → validate (implementation complete, PR creation failed): boom",
		]);
		const chatIds = fetchCalls.map((c) => telegramChatId(c.body)).sort();
		expect(chatIds).toEqual(["111", "222"]);
	});
});

describe("notify — best-effort delivery", () => {
	test("a Telegram API failure never propagates out of notify()", async () => {
		configureTelegram();
		stubFetchThrows();

		await expect(notify({ kind: "task_failed", displayId: 1, reason: "boom" })).resolves.toBeUndefined();
	});
});

describe("notify — weekly threshold dedup", () => {
	test("sends once, then skips further attempts the same calendar day", async () => {
		configureTelegram();
		stubFetchOk();
		const day1 = new Date("2026-01-01T09:00:00.000Z");

		await notify({ kind: "weekly_threshold", cwd: "/tmp/ws-a", pctUsed: 85, thresholdPct: 80 }, day1);
		expect(fetchCalls).toHaveLength(2); // one per allowed user

		await notify({ kind: "weekly_threshold", cwd: "/tmp/ws-a", pctUsed: 90, thresholdPct: 80 }, new Date("2026-01-01T23:00:00.000Z"));
		expect(fetchCalls).toHaveLength(2); // unchanged — same UTC calendar day
	});

	test("retries later that day when every recipient delivery fails", async () => {
		configureTelegram();
		const now = new Date("2026-01-01T09:00:00.000Z");
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
			throw new Error("network unreachable");
		}) as unknown as typeof fetch;

		await notify({ kind: "weekly_threshold", cwd: "/tmp/ws-retry", pctUsed: 85, thresholdPct: 80 }, now);
		expect(fetchCalls).toHaveLength(2);

		stubFetchOk();
		await notify({ kind: "weekly_threshold", cwd: "/tmp/ws-retry", pctUsed: 85, thresholdPct: 80 }, now);
		expect(fetchCalls).toHaveLength(4);

		await notify({ kind: "weekly_threshold", cwd: "/tmp/ws-retry", pctUsed: 85, thresholdPct: 80 }, now);
		expect(fetchCalls).toHaveLength(4);
	});

	test("sends again once the calendar day rolls over", async () => {
		configureTelegram();
		stubFetchOk();

		await notify({ kind: "weekly_threshold", cwd: "/tmp/ws-b", pctUsed: 85, thresholdPct: 80 }, new Date("2026-01-01T09:00:00.000Z"));
		expect(fetchCalls).toHaveLength(2);

		await notify({ kind: "weekly_threshold", cwd: "/tmp/ws-b", pctUsed: 85, thresholdPct: 80 }, new Date("2026-01-02T00:00:01.000Z"));
		expect(fetchCalls).toHaveLength(4);
	});

	test("dedup is scoped per cwd", async () => {
		configureTelegram();
		stubFetchOk();
		const now = new Date("2026-01-01T09:00:00.000Z");

		await notify({ kind: "weekly_threshold", cwd: "/tmp/ws-c", pctUsed: 85, thresholdPct: 80 }, now);
		expect(fetchCalls).toHaveLength(2);

		await notify({ kind: "weekly_threshold", cwd: "/tmp/ws-d", pctUsed: 85, thresholdPct: 80 }, now);
		expect(fetchCalls).toHaveLength(4);
	});

	test("an unconfigured bridge never marks the day as notified", async () => {
		configureTelegram();
		stubFetchOk();
		const now = new Date("2026-01-01T09:00:00.000Z");

		delete process.env.TELEGRAM_BOT_TOKEN;
		await notify({ kind: "weekly_threshold", cwd: "/tmp/ws-e", pctUsed: 85, thresholdPct: 80 }, now);
		expect(fetchCalls).toHaveLength(0);

		configureTelegram();
		await notify({ kind: "weekly_threshold", cwd: "/tmp/ws-e", pctUsed: 85, thresholdPct: 80 }, now);
		expect(fetchCalls).toHaveLength(2);
	});
});
