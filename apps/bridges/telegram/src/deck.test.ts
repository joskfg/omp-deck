/**
 * Tests for `DeckClient.promptSession`'s final-result-only contract (T-125).
 *
 * `promptSession` no longer exposes a partial-text callback at all — these
 * tests drive a fake WS transport (injected via the `wsFactory` constructor
 * param) through the deck's `session_event` wire frames and assert on the
 * single resolved string, which is the only thing a caller can ever observe.
 */
import { describe, expect, test } from "bun:test";

import { DeckClient, SessionNotActiveError, type DeckWebSocket } from "./deck.ts";

class FakeWebSocket implements DeckWebSocket {
	readonly sent: string[] = [];
	closed = false;
	onopen: DeckWebSocket["onopen"] = null;
	onerror: DeckWebSocket["onerror"] = null;
	onclose: DeckWebSocket["onclose"] = null;
	onmessage: DeckWebSocket["onmessage"] = null;

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		this.sent.push(String(data));
	}

	close(): void {
		this.closed = true;
	}

	open(): void {
		this.onopen?.(undefined as unknown as Event);
	}

	emit(frame: unknown): void {
		this.onmessage?.({ data: JSON.stringify(frame) } as unknown as MessageEvent);
	}

	fail(): void {
		this.onerror?.(undefined as unknown as Event);
	}

	forceClose(): void {
		this.onclose?.(undefined as unknown as CloseEvent);
	}
}

function harness(): { client: DeckClient; ws: FakeWebSocket } {
	const ws = new FakeWebSocket();
	const client = new DeckClient("http://deck.test", "ws://deck.test/ws", () => ws);
	return { client, ws };
}

function assistantSessionEvent(eventType: string, text: string): unknown {
	return { type: "session_event", sessionId: "s1", event: { type: eventType, message: { role: "assistant", content: [{ type: "text", text }] } } };
}

describe("DeckClient.promptSession", () => {
	test("sends subscribe then prompt, and resolves with the streamed assistant text", async () => {
		const { client, ws } = harness();
		const result = client.promptSession({ sessionId: "s1", text: "hi" });
		ws.open();
		expect(ws.sent).toHaveLength(1);
		expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "subscribe", sessionId: "s1" });

		ws.emit({ type: "subscribed", sessionId: "s1", snapshot: {} });
		expect(ws.sent).toHaveLength(2);
		expect(JSON.parse(ws.sent[1]!)).toEqual({ type: "prompt", sessionId: "s1", text: "hi" });

		ws.emit(assistantSessionEvent("message_update", "Hello there"));
		ws.emit({ type: "session_event", sessionId: "s1", event: { type: "turn_end" } });

		expect(await result).toBe("Hello there");
		expect(ws.closed).toBe(true);
	});

	test("includes images in the prompt frame only when provided", async () => {
		const { client, ws } = harness();
		const result = client.promptSession({ sessionId: "s1", text: "hi", images: [{ type: "image", data: "AA==", mimeType: "image/png" }] });
		ws.open();
		ws.emit({ type: "subscribed", sessionId: "s1", snapshot: {} });
		expect(JSON.parse(ws.sent[1]!)).toMatchObject({ images: [{ type: "image", data: "AA==", mimeType: "image/png" }] });

		ws.emit({ type: "session_event", sessionId: "s1", event: { type: "turn_end" } });
		await result;
	});

	test("prefers the turn_end event's own message over stale earlier streamed text", async () => {
		const { client, ws } = harness();
		const result = client.promptSession({ sessionId: "s1", text: "hi" });
		ws.open();
		ws.emit({ type: "subscribed", sessionId: "s1", snapshot: {} });

		ws.emit(assistantSessionEvent("message_update", "Let me check the code..."));
		ws.emit({
			type: "session_event",
			sessionId: "s1",
			event: { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Fixed the bug." }] } },
		});

		expect(await result).toBe("Fixed the bug.");
	});

	test("clears stale narration when the terminal message carries no text (T-125 leak)", async () => {
		const { client, ws } = harness();
		const result = client.promptSession({ sessionId: "s1", text: "hi" });
		ws.open();
		ws.emit({ type: "subscribed", sessionId: "s1", snapshot: {} });

		// Preamble narration before tool work — must never be treated as final.
		ws.emit(assistantSessionEvent("message_update", "Let me check the code..."));
		ws.emit({
			type: "session_event",
			sessionId: "s1",
			event: { type: "turn_end", message: { role: "assistant", content: [{ type: "tool_use", name: "read" }] } },
		});

		expect(await result).toBe("Turn complete.");
	});

	test("falls back to Turn complete. when the turn never produced assistant text", async () => {
		const { client, ws } = harness();
		const result = client.promptSession({ sessionId: "s1", text: "hi" });
		ws.open();
		ws.emit({ type: "subscribed", sessionId: "s1", snapshot: {} });
		ws.emit({ type: "session_event", sessionId: "s1", event: { type: "agent_end" } });

		expect(await result).toBe("Turn complete.");
	});

	test("rejects with SessionNotActiveError when the deck reports the session inactive", async () => {
		const { client, ws } = harness();
		const result = client.promptSession({ sessionId: "s1", text: "hi" });
		ws.open();
		ws.emit({ type: "error", sessionId: "s1", error: "session not active: s1" });

		await expect(result).rejects.toBeInstanceOf(SessionNotActiveError);
	});

	test("rejects with a plain error for other error frames", async () => {
		const { client, ws } = harness();
		const result = client.promptSession({ sessionId: "s1", text: "hi" });
		ws.open();
		ws.emit({ type: "error", sessionId: "s1", error: "boom" });

		await expect(result).rejects.toThrow("boom");
	});

	test("rejects when the socket errors", async () => {
		const { client, ws } = harness();
		const result = client.promptSession({ sessionId: "s1", text: "hi" });
		ws.open();
		ws.fail();

		await expect(result).rejects.toThrow("deck websocket failed");
	});

	test("rejects if the socket closes before the turn ends", async () => {
		const { client, ws } = harness();
		const result = client.promptSession({ sessionId: "s1", text: "hi" });
		ws.open();
		ws.forceClose();

		await expect(result).rejects.toThrow("closed before turn ended");
	});

	test("ignores session_event frames for a different sessionId", async () => {
		const { client, ws } = harness();
		const result = client.promptSession({ sessionId: "s1", text: "hi" });
		ws.open();
		ws.emit({ type: "subscribed", sessionId: "s1", snapshot: {} });

		ws.emit(assistantSessionEvent("message_update", "Hello there"));
		// A frame for another session must never settle or contaminate this turn.
		ws.emit({ type: "session_event", sessionId: "other", event: { type: "turn_end" } });
		ws.emit({ type: "session_event", sessionId: "s1", event: { type: "turn_end" } });

		expect(await result).toBe("Hello there");
	});
});
