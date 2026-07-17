/**
 * Tests for the final-only Telegram delivery contract (T-125).
 *
 * `TelegramApi.sendMessage`/`editMessageText` hit `fetch` directly — stub
 * `globalThis.fetch` rather than mocking module internals, matching the
 * existing convention in `auto-work/notify.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { sendFinalReply, splitTelegramText } from "./reply.ts";
import { TelegramApi } from "./telegram.ts";

let originalFetch: typeof fetch;
let calls: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
	originalFetch = globalThis.fetch;
	calls = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
		return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length, chat: { id: 1 } } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("splitTelegramText", () => {
	test("returns short text unchanged as a single chunk", () => {
		expect(splitTelegramText("hello")).toEqual(["hello"]);
	});

	test("falls back to a placeholder for blank text", () => {
		expect(splitTelegramText("   ")).toEqual(["Turn complete."]);
	});

	test("splits long text into multiple chunks that reconstruct the original", () => {
		const long = "x".repeat(9000);
		const chunks = splitTelegramText(long);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.join("")).toBe(long);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(3900);
	});
});

describe("sendFinalReply", () => {
	test("sends the final text as a single sendMessage reply, never editMessageText", async () => {
		const telegram = new TelegramApi("test-token");
		await sendFinalReply(telegram, 42, 7, "The fix is done.");

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toContain("/sendMessage");
		expect(calls.some((c) => c.url.includes("editMessageText"))).toBe(false);
		expect(calls[0]!.body.text).toBe("The fix is done.");
		expect(calls[0]!.body.chat_id).toBe(42);
		expect(calls[0]!.body.reply_to_message_id).toBe(7);
	});

	test("chunks long text across multiple sendMessage calls, only the first replying to the trigger message", async () => {
		const telegram = new TelegramApi("test-token");
		const long = "line\n".repeat(1200);
		await sendFinalReply(telegram, 42, 7, long);

		expect(calls.length).toBeGreaterThan(1);
		for (const call of calls) expect(call.url).toContain("/sendMessage");
		expect(calls[0]!.body.reply_to_message_id).toBe(7);
		expect(calls[1]!.body.reply_to_message_id).toBeUndefined();
	});

	test("still sends exactly one message (the Turn complete. fallback) for empty text", async () => {
		const telegram = new TelegramApi("test-token");
		await sendFinalReply(telegram, 42, 7, "");

		expect(calls).toHaveLength(1);
		expect(calls[0]!.body.text).toBe("Turn complete.");
	});
});
