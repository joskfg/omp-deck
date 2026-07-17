import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentBridge, EventListener } from "./bridge/types.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { closeDb, openDb } from "./db/index.ts";
import { setInternalTaskModel } from "./db/server-settings.ts";
import type { ConnectionData } from "./ws.ts";
import { WsHub } from "./ws.ts";

type TestSocket = {
	data: ConnectionData;
	sent: string[];
	send(payload: string): void;
};

function makeSocket(hub: WsHub): TestSocket {
	const socket: TestSocket = {
		data: hub.createConnectionData(),
		sent: [],
		send(payload) {
			this.sent.push(payload);
		},
	};
	hub.onOpen(socket as unknown as ServerWebSocket<ConnectionData>);
	return socket;
}

function frames(socket: TestSocket): Array<{ type: string; [key: string]: unknown }> {
	return socket.sent.map((payload) => JSON.parse(payload) as { type: string; [key: string]: unknown });
}

function fakeBridge(): {
	bridge: AgentBridge;
	emitSessionEvent(event: unknown): void;
	removed: Array<{ sessionId: string; connectionId: string }>;
} {
	const listeners = new Set<EventListener>();
	const removed: Array<{ sessionId: string; connectionId: string }> = [];
	const handle = {
		sessionId: "session-1",
		sessionFile: undefined,
		cwd: "/workspace",
		subscribe(listener: EventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		snapshot() {
			return {};
		},
		getHistory() {
			return { messages: [], startIndex: 0 };
		},
	};

	return {
		bridge: {
			getSession: (sessionId: string) => (sessionId === "session-1" ? handle : undefined),
			trackSubscriberAdded() {},
			trackSubscriberRemoved(sessionId: string, connectionId: string) {
				removed.push({ sessionId, connectionId });
			},
			subscribeUiFrames() {
				return () => {};
			},
			subscribePlanModeFrames() {
				return () => {};
			},
		} as unknown as AgentBridge,
		emitSessionEvent(event: unknown) {
			for (const listener of listeners) listener(event as never);
		},
		removed,
	};
}

const noopSkills = {} as ConstructorParameters<typeof WsHub>[1];

describe("WsHub subscription ownership", () => {
	test("delivers task changes only while that connection explicitly subscribes to tasks", async () => {
		const { bridge } = fakeBridge();
		const hub = new WsHub(bridge, noopSkills);
		const taskView = makeSocket(hub);
		const chatOnly = makeSocket(hub);
		try {
			taskView.sent.length = 0;
			chatOnly.sent.length = 0;

			// The raw wire payload deliberately exercises the public WebSocket
			// boundary; task subscription must not be inferred from a session
			// subscription or from merely having an open connection.
			await hub.onMessage(
				taskView as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "subscribe_tasks" }),
			);
			taskView.sent.length = 0;

			broadcastBus.broadcast({ type: "tasks_changed" });

			expect(frames(taskView)).toEqual([{ type: "tasks_changed" }]);
			expect(frames(chatOnly)).toEqual([]);

			await hub.onMessage(
				taskView as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "unsubscribe_tasks" }),
			);
			taskView.sent.length = 0;
			broadcastBus.broadcast({ type: "tasks_changed" });

			expect(frames(taskView)).toEqual([]);
		} finally {
			hub.onClose(taskView as unknown as ServerWebSocket<ConnectionData>);
			hub.onClose(chatOnly as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});

	test("unsubscribe stops session-event delivery and releases the reaper ownership pin", async () => {
		const { bridge, emitSessionEvent, removed } = fakeBridge();
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			socket.sent.length = 0;
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "subscribe", sessionId: "session-1" }),
			);
			socket.sent.length = 0;

			emitSessionEvent({ type: "agent_start" });
			expect(frames(socket)).toEqual([
				{ type: "session_event", sessionId: "session-1", event: { type: "agent_start" } },
			]);

			socket.sent.length = 0;
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "unsubscribe", sessionId: "session-1" }),
			);
			socket.sent.length = 0;
			emitSessionEvent({ type: "agent_end" });

			expect(frames(socket)).toEqual([]);
			expect(removed).toEqual([{ sessionId: "session-1", connectionId: socket.data.connectionId }]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});
});

/**
 * The subscribe path routes session events through a per-subscriber
 * StreamCoalescer (default 1s interval): streaming updates are throttled to
 * a leading-edge emit + one flush per interval, everything else passes
 * through immediately. These cases only assert the synchronous paths — the
 * timer schedule itself is covered in stream-coalescer.test.ts.
 */
describe("WsHub stream coalescing", () => {
	test("delivers the first streaming update, buffers the burst, and drops it when message_end supersedes", async () => {
		const { bridge, emitSessionEvent } = fakeBridge();
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "subscribe", sessionId: "session-1" }),
			);
			socket.sent.length = 0;

			const u1 = { type: "message_update", message: { role: "assistant", content: "He" } };
			const u2 = { type: "message_update", message: { role: "assistant", content: "Hello" } };
			const end = { type: "message_end", message: { role: "assistant", content: "Hello!" } };

			// Leading edge: the first update after subscribe goes out synchronously.
			emitSessionEvent(u1);
			expect(frames(socket)).toEqual([{ type: "session_event", sessionId: "session-1", event: u1 }]);

			// The second update within the interval is held back.
			emitSessionEvent(u2);
			expect(frames(socket)).toEqual([{ type: "session_event", sessionId: "session-1", event: u1 }]);

			// message_end supersedes the buffered update: the end frame arrives,
			// the intermediate u2 never does.
			emitSessionEvent(end);
			expect(frames(socket)).toEqual([
				{ type: "session_event", sessionId: "session-1", event: u1 },
				{ type: "session_event", sessionId: "session-1", event: end },
			]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});

	test("a non-coalescible event passes through immediately, flushing the buffered update ahead of itself", async () => {
		const { bridge, emitSessionEvent } = fakeBridge();
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "subscribe", sessionId: "session-1" }),
			);
			socket.sent.length = 0;

			const u1 = { type: "message_update", message: { role: "assistant", content: "a" } };
			const u2 = { type: "message_update", message: { role: "assistant", content: "ab" } };
			const start = { type: "agent_start" };

			emitSessionEvent(u1); // leading edge — synchronous
			emitSessionEvent(u2); // buffered
			emitSessionEvent(start); // passthrough — must flush u2 first

			expect(frames(socket)).toEqual([
				{ type: "session_event", sessionId: "session-1", event: u1 },
				{ type: "session_event", sessionId: "session-1", event: u2 },
				{ type: "session_event", sessionId: "session-1", event: start },
			]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});
});

/**
 * T-78: `WsHub#maybeAutoTitleSession`, the fire-and-forget hook fired from
 * the top of `handlePrompt`. Needs a real on-disk DB (unlike the rest of
 * this file) because `getInternalTaskModel()` / `generateSessionTitle()`
 * read the `internalTaskModel` server setting directly. The fake one-shot
 * title session's terminal event fires synchronously inside `subscribe()`
 * (no real timer), so the whole chain resolves on the microtask queue —
 * every assertion below synchronizes on either the `sessions_changed`
 * broadcast it ends with, or (for the negative cases, which never reach
 * that broadcast) on a `snapshot()` call plus a microtask flush.
 */
describe("WsHub auto-title-on-first-prompt", () => {
	let dbDir: string;

	beforeEach(() => {
		dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-ws-auto-title-db-"));
		openDb({ path: path.join(dbDir, "deck.db") });
	});

	afterEach(() => {
		closeDb();
		fs.rmSync(dbDir, { recursive: true, force: true });
	});

	function fakePromptBridge(opts: { sessionName?: string; titleResponse?: string } = {}): {
		bridge: AgentBridge;
		promptCalls: string[];
		setNameCalls: string[];
		generateTitleCalls: Parameters<AgentBridge["generateTitle"]>[0][];
		snapshotCalled: Promise<void>;
	} {
		const promptCalls: string[] = [];
		const setNameCalls: string[] = [];
		const generateTitleCalls: Parameters<AgentBridge["generateTitle"]>[0][] = [];
		const snapshotCalled = Promise.withResolvers<void>();

		const handle = {
			sessionId: "session-1",
			sessionFile: undefined,
			cwd: "/workspace",
			subscribe(_listener: EventListener) {
				return () => {};
			},
			snapshot() {
				snapshotCalled.resolve();
				return opts.sessionName ? { sessionName: opts.sessionName } : {};
			},
			getHistory() {
				return { messages: [], startIndex: 0 };
			},
			async prompt(text: string) {
				promptCalls.push(text);
			},
			async setName(name: string) {
				setNameCalls.push(name);
			},
		};


		return {
			bridge: {
				getSession: (sessionId: string) => (sessionId === "session-1" ? handle : undefined),
				trackSubscriberAdded() {},
				trackSubscriberRemoved() {},
				subscribeUiFrames() {
					return () => {};
				},
				subscribePlanModeFrames() {
					return () => {};
				},
				bumpActivity() {},
				async generateTitle(request: Parameters<AgentBridge["generateTitle"]>[0]) {
					generateTitleCalls.push(request);
					return opts.titleResponse ?? "Generated Title";
				},
			} as unknown as AgentBridge,
			promptCalls,
			setNameCalls,
			generateTitleCalls,
			snapshotCalled: snapshotCalled.promise,
		};
	}

	test("triggers title generation on the first prompt, renaming the session and broadcasting sessions_changed", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const { bridge, setNameCalls, generateTitleCalls } = fakePromptBridge({ titleResponse: "Fix The Login Bug" });
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			const sessionsChanged = new Promise<void>((resolve) => {
				const stop = broadcastBus.subscribe((frame) => {
					if (frame.type === "sessions_changed") {
						stop();
						resolve();
					}
				});
			});

			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "prompt", sessionId: "session-1", text: "Fix the login bug please" }),
			);
			await sessionsChanged;

			expect(generateTitleCalls).toHaveLength(1);
			expect(setNameCalls).toEqual(["Fix The Login Bug"]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});

	test("never renames a session that already has a sessionName", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const { bridge, setNameCalls, generateTitleCalls, snapshotCalled } = fakePromptBridge({
			sessionName: "Already Named",
		});
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "prompt", sessionId: "session-1", text: "Hello" }),
			);
			await snapshotCalled;
			// Flush the microtask hops between `snapshot()` resolving and the
			// early `if (snapshot.sessionName) return` landing right after it.
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(setNameCalls).toEqual([]);
			expect(generateTitleCalls).toEqual([]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});

	test("a second prompt on the same session never re-triggers generation", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const { bridge, generateTitleCalls } = fakePromptBridge({ titleResponse: "First Title" });
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			const sessionsChanged = new Promise<void>((resolve) => {
				const stop = broadcastBus.subscribe((frame) => {
					if (frame.type === "sessions_changed") {
						stop();
						resolve();
					}
				});
			});
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "prompt", sessionId: "session-1", text: "First message" }),
			);
			await sessionsChanged;
			expect(generateTitleCalls).toHaveLength(1);

			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "prompt", sessionId: "session-1", text: "Second message" }),
			);

			expect(generateTitleCalls).toHaveLength(1);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});

	test("attempts no title generation at all when internalTaskModel is unset, leaving the normal prompt flow unchanged", async () => {
		const { bridge, setNameCalls, generateTitleCalls, promptCalls } = fakePromptBridge();
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "prompt", sessionId: "session-1", text: "Hello" }),
			);

			expect(promptCalls).toEqual(["Hello"]);
			expect(generateTitleCalls).toEqual([]);
			expect(setNameCalls).toEqual([]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});
});

describe("WsHub lifecycle failures", () => {
	test("reserves concurrent session subscriptions and releases their one teardown", async () => {
		let resolveSnapshot!: (snapshot: {}) => void;
		const snapshot = new Promise<{}>((resolve) => {
			resolveSnapshot = resolve;
		});
		const sessionListeners = new Set<EventListener>();
		const uiListeners = new Set<(frame: unknown) => void>();
		const planListeners = new Set<(frame: unknown) => void>();
		let added = 0;
		let removed = 0;
		const bridge = {
			getSession: (sessionId: string) =>
				sessionId === "session-1"
					? {
							sessionId,
							sessionFile: undefined,
							cwd: "/workspace",
							subscribe(listener: EventListener) {
								sessionListeners.add(listener);
								return () => sessionListeners.delete(listener);
							},
							snapshot: () => snapshot,
							getHistory() {
								return { messages: [], startIndex: 0 };
							},
						}
					: undefined,
			trackSubscriberAdded() {
				added++;
			},
			trackSubscriberRemoved() {
				removed++;
			},
			subscribeUiFrames(_sessionId: string, listener: (frame: unknown) => void) {
				uiListeners.add(listener);
				return () => uiListeners.delete(listener);
			},
			subscribePlanModeFrames(_sessionId: string, listener: (frame: unknown) => void) {
				planListeners.add(listener);
				return () => planListeners.delete(listener);
			},
			bumpActivity() {},
		} as unknown as AgentBridge;
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			socket.sent.length = 0;
			const first = hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "subscribe", sessionId: "session-1" }),
			);
			const second = hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "subscribe", sessionId: "session-1" }),
			);

			expect(socket.data.subscriptions.size).toBe(1);
			expect(sessionListeners.size).toBe(1);
			expect(uiListeners.size).toBe(1);
			expect(planListeners.size).toBe(1);
			expect(added).toBe(1);

			resolveSnapshot({});
			await Promise.all([first, second]);
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);

			expect(sessionListeners.size).toBe(0);
			expect(uiListeners.size).toBe(0);
			expect(planListeners.size).toBe(0);
			expect(removed).toBe(1);
		} finally {
			hub.dispose();
		}
	});

	test("cleans partial subscription listeners when snapshot setup rejects", async () => {
		const sessionListeners = new Set<EventListener>();
		const uiListeners = new Set<(frame: unknown) => void>();
		const planListeners = new Set<(frame: unknown) => void>();
		let removed = 0;
		const bridge = {
			getSession: () => ({
				sessionId: "session-1",
				sessionFile: undefined,
				cwd: "/workspace",
				subscribe(listener: EventListener) {
					sessionListeners.add(listener);
					return () => sessionListeners.delete(listener);
				},
				snapshot: () => Promise.reject(new Error("snapshot failed")),
				getHistory() {
					return { messages: [], startIndex: 0 };
				},
			}),
			trackSubscriberAdded() {},
			trackSubscriberRemoved() {
				removed++;
			},
			subscribeUiFrames(_sessionId: string, listener: (frame: unknown) => void) {
				uiListeners.add(listener);
				return () => uiListeners.delete(listener);
			},
			subscribePlanModeFrames(_sessionId: string, listener: (frame: unknown) => void) {
				planListeners.add(listener);
				return () => planListeners.delete(listener);
			},
		} as unknown as AgentBridge;
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			socket.sent.length = 0;
			await expect(
				hub.onMessage(
					socket as unknown as ServerWebSocket<ConnectionData>,
					JSON.stringify({ type: "subscribe", sessionId: "session-1" }),
				),
			).resolves.toBeUndefined();

			expect(socket.data.subscriptions.size).toBe(0);
			expect(sessionListeners.size).toBe(0);
			expect(uiListeners.size).toBe(0);
			expect(planListeners.size).toBe(0);
			expect(removed).toBe(1);
			expect(frames(socket)).toEqual([{ type: "error", error: "message handling failed" }]);
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});

	test("contains UI and plan frame send races", async () => {
		const uiListeners = new Set<(frame: unknown) => void>();
		const planListeners = new Set<(frame: unknown) => void>();
		const bridge = {
			getSession: () => ({
				sessionId: "session-1",
				sessionFile: undefined,
				cwd: "/workspace",
				subscribe() {
					return () => {};
				},
				snapshot() {
					return {};
				},
				getHistory() {
					return { messages: [], startIndex: 0 };
				},
			}),
			trackSubscriberAdded() {},
			trackSubscriberRemoved() {},
			subscribeUiFrames(_sessionId: string, listener: (frame: unknown) => void) {
				uiListeners.add(listener);
				return () => uiListeners.delete(listener);
			},
			subscribePlanModeFrames(_sessionId: string, listener: (frame: unknown) => void) {
				planListeners.add(listener);
				return () => planListeners.delete(listener);
			},
		} as unknown as AgentBridge;
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		try {
			await hub.onMessage(
				socket as unknown as ServerWebSocket<ConnectionData>,
				JSON.stringify({ type: "subscribe", sessionId: "session-1" }),
			);
			socket.send = () => {
				throw new Error("socket closed");
			};

			expect(() => {
				for (const listener of uiListeners) {
					listener({
						type: "ext_ui_dialog_cancel",
						sessionId: "session-1",
						dialogId: "dialog-1",
						reason: "aborted",
					});
				}
				for (const listener of planListeners) {
					listener({ type: "plan_mode_changed", sessionId: "session-1", enabled: true, planFilePath: "local://PLAN.md" });
				}
			}).not.toThrow();
		} finally {
			hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
			hub.dispose();
		}
	});

	test("detaches its broadcast-bus listener when disposed", () => {
		const { bridge } = fakeBridge();
		const hub = new WsHub(bridge, noopSkills);
		const socket = makeSocket(hub);
		socket.sent.length = 0;

		hub.dispose();
		broadcastBus.broadcast({ type: "models_changed" });

		expect(frames(socket)).toEqual([]);
		hub.onClose(socket as unknown as ServerWebSocket<ConnectionData>);
	});
});
