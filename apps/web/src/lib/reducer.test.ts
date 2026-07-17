/**
 * Tests for the prompt-queue lifecycle (T-88). Covers the three synthetic
 * events the bridge emits via the session_event channel — `prompt_queued`,
 * `queue_cleared` — plus the de-dup behavior that drops a queued bubble
 * when the SDK eventually emits the real user message_start it was waiting
 * on.
 */
import { describe, expect, test } from "bun:test";

import type { AgentMessageJson, SessionSnapshot } from "@omp-deck/protocol";

import { applyEvent, initSession, prependHistory, trimHistory } from "./reducer";
import type { SessionUi } from "./types";

function fresh(): SessionUi {
	return initSession({
		sessionId: "s1",
		cwd: "/tmp/x",
		isStreaming: true,
		messages: [],
		todoPhases: [],
	});
}

function queueEvent(text: string, queuedId = `q-${text}`) {
	return { type: "prompt_queued", queuedId, text, behavior: "followUp" } as never;
}

function userMessageStart(text: string, synthetic = false) {
	return {
		type: "message_start",
		message: { role: "user", content: text, synthetic, timestamp: 1700000000000 },
	} as never;
}

describe("reducer session_handoff event (T-32)", () => {
	function handoffEvent(over: Partial<Record<string, unknown>> = {}) {
		return {
			type: "session_handoff",
			reason: "threshold",
			previousSessionId: "old-id",
			previousSessionFile: "/tmp/old.jsonl",
			newSessionId: "new-id",
			newSessionFile: "/tmp/new.jsonl",
			timestamp: 1700000000000,
			...over,
		} as never;
	}

	test("appends a HandoffMsg carrying the why/when/new-identity", () => {
		const state = applyEvent(fresh(), handoffEvent());

		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({
			role: "handoff",
			reason: "threshold",
			previousSessionId: "old-id",
			previousSessionFile: "/tmp/old.jsonl",
			newSessionId: "new-id",
			newSessionFile: "/tmp/new.jsonl",
			timestamp: 1700000000000,
		});
	});

	test("this tab's own sessionId never changes, but sessionFile/parentSessionPath follow the swap", () => {
		const before = fresh();
		const state = applyEvent(before, handoffEvent());

		expect(state.sessionId).toBe(before.sessionId);
		expect(state.sessionFile).toBe("/tmp/new.jsonl");
		expect(state.parentSessionPath).toBe("/tmp/old.jsonl");
	});

	test("a second handoff on the same tab keeps appending and keeps sessionFile current", () => {
		let state = applyEvent(fresh(), handoffEvent());
		state = applyEvent(
			state,
			handoffEvent({ reason: "overflow", previousSessionId: "new-id", previousSessionFile: "/tmp/new.jsonl", newSessionId: "newer-id", newSessionFile: "/tmp/newer.jsonl" }),
		);

		expect(state.messages.filter((m) => m.role === "handoff")).toHaveLength(2);
		expect(state.sessionFile).toBe("/tmp/newer.jsonl");
		expect(state.parentSessionPath).toBe("/tmp/new.jsonl");
	});
});

describe("reducer handoff_origin ingestion (T-32)", () => {
	test("reconstructs the transferred summary from the persisted custom_message handoff marker", () => {
		const state = initSession({
			sessionId: "s1",
			cwd: "/tmp/x",
			isStreaming: false,
			todoPhases: [],
			messages: [
				{
					role: "custom",
					customType: "handoff",
					content: "<handoff-context>\nWe were mid-refactor on foo.ts.\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.",
					timestamp: 1700000000000,
				} as never,
			],
		});

		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({
			role: "handoff_origin",
			document: "We were mid-refactor on foo.ts.",
			timestamp: 1700000000000,
		});
	});

	test("falls back to the raw content when the wrapper tags are absent (forward-compat)", () => {
		const state = initSession({
			sessionId: "s1",
			cwd: "/tmp/x",
			isStreaming: false,
			todoPhases: [],
			messages: [
				{ role: "custom", customType: "handoff", content: "plain text, no wrapper", timestamp: 1 } as never,
			],
		});

		expect(state.messages[0]).toMatchObject({ role: "handoff_origin", document: "plain text, no wrapper" });
	});

	test("ignores a custom message of any other customType", () => {
		const state = initSession({
			sessionId: "s1",
			cwd: "/tmp/x",
			isStreaming: false,
			todoPhases: [],
			messages: [{ role: "custom", customType: "advisor", content: "some note", timestamp: 1 } as never],
		});

		expect(state.messages).toHaveLength(0);
	});
});

describe("reducer queue lifecycle", () => {
	test("prompt_queued appends a QueuedPrompt with the server id", () => {
		const s1 = applyEvent(fresh(), queueEvent("first", "abc"));
		expect(s1.queuedPrompts).toHaveLength(1);
		expect(s1.queuedPrompts[0]).toMatchObject({
			id: "abc",
			text: "first",
			behavior: "followUp",
		});
		const s2 = applyEvent(s1, queueEvent("second", "def"));
		expect(s2.queuedPrompts.map((q) => q.id)).toEqual(["abc", "def"]);
	});

	test("real user message_start drops the first matching queued entry (FIFO)", () => {
		let s = fresh();
		s = applyEvent(s, queueEvent("alpha", "1"));
		s = applyEvent(s, queueEvent("beta", "2"));
		s = applyEvent(s, queueEvent("alpha", "3")); // duplicate text — drop the oldest

		s = applyEvent(s, userMessageStart("alpha"));
		expect(s.queuedPrompts.map((q) => q.id)).toEqual(["2", "3"]);
		// The real user message also lands in `messages` so the chat shows it.
		expect(s.messages.at(-1)).toMatchObject({ role: "user", text: "alpha", synthetic: false });
	});

	test("synthetic user message_start does NOT drop a queued entry", () => {
		// Slash-command round-trips emit synthetic user messages with the
		// command text. They didn't come from the composer queue, so they
		// must not consume a queued bubble even if the text happens to match.
		let s = fresh();
		s = applyEvent(s, queueEvent("/help", "z"));
		s = applyEvent(s, userMessageStart("/help", true));
		expect(s.queuedPrompts.map((q) => q.id)).toEqual(["z"]);
	});

	test("queue_cleared empties the queue", () => {
		let s = fresh();
		s = applyEvent(s, queueEvent("a"));
		s = applyEvent(s, queueEvent("b"));
		expect(s.queuedPrompts).toHaveLength(2);

		s = applyEvent(s, { type: "queue_cleared", cleared: { steering: 0, followUp: 2 } } as never);
		expect(s.queuedPrompts).toHaveLength(0);
	});

	test("queue_cleared on an already-empty queue is a no-op (returns same ref)", () => {
		const s = fresh();
		const next = applyEvent(s, { type: "queue_cleared", cleared: { steering: 0, followUp: 0 } } as never);
		expect(next).toBe(s);
	});

	test("non-matching user message leaves the queue untouched", () => {
		let s = fresh();
		s = applyEvent(s, queueEvent("hello", "h"));
		s = applyEvent(s, userMessageStart("something unrelated"));
		expect(s.queuedPrompts.map((q) => q.id)).toEqual(["h"]);
	});

	test("initSession seeds queuedPrompts as an empty array", () => {
		expect(fresh().queuedPrompts).toEqual([]);
	});
});

/**
 * T-106: bridge synthesizes `todo_phases_set` after every `todo`
 * `tool_execution_end` so the Inspector doesn't show stale todos between
 * SDK reminder ticks. Reducer must normalize the carried `todoPhases`
 * into the same shape `todo_reminder` produces, and must coexist with
 * the existing reminder path without one stomping the other.
 */
describe("reducer todo_phases_set (T-106)", () => {
	test("replaces todoPhases with the carried snapshot, normalized", () => {
		let s = fresh();
		s = applyEvent(s, {
			type: "todo_phases_set",
			todoPhases: [
				{
					id: "phase-1",
					name: "Merge",
					tasks: [
						{ id: "t1", content: "Stage A", status: "completed" },
						{ id: "t2", content: "Stage B", status: "in_progress" },
					],
				},
			],
		} as never);
		expect(s.todoPhases).toHaveLength(1);
		expect(s.todoPhases[0]!.name).toBe("Merge");
		expect(s.todoPhases[0]!.tasks.map((t) => t.status)).toEqual(["completed", "in_progress"]);
	});

	test("empty array clears todoPhases", () => {
		let s = fresh();
		s = applyEvent(s, {
			type: "todo_phases_set",
			todoPhases: [{ name: "phase", tasks: [{ content: "x", status: "pending" }] }],
		} as never);
		expect(s.todoPhases).toHaveLength(1);
		s = applyEvent(s, { type: "todo_phases_set", todoPhases: [] } as never);
		expect(s.todoPhases).toEqual([]);
	});

	test("preserves the last todo list when SDK auto-clear fires", () => {
		let s = fresh();
		s = applyEvent(s, {
			type: "todo_phases_set",
			todoPhases: [{ name: "Done", tasks: [{ content: "Ship it", status: "completed" }] }],
		} as never);

		s = applyEvent(s, { type: "todo_auto_clear" } as never);

		expect(s.todoPhases).toEqual([
			{ name: "Done", tasks: [{ content: "Ship it", status: "completed" }] },
		]);
	});

	test("missing todoPhases payload is treated as empty (defensive)", () => {
		let s = fresh();
		s = applyEvent(s, { type: "todo_phases_set" } as never);
		expect(s.todoPhases).toEqual([]);
	});

	test("does not interfere with todo_reminder's existing wrap-once shape", () => {
		let s = fresh();
		// SDK-style reminder: single phase value (NOT wrapped)
		s = applyEvent(s, {
			type: "todo_reminder",
			todos: { name: "from-reminder", tasks: [{ content: "x", status: "pending" }] },
		} as never);
		expect(s.todoPhases[0]!.name).toBe("from-reminder");
		// Synthetic event then overrides cleanly with the canonical shape
		s = applyEvent(s, {
			type: "todo_phases_set",
			todoPhases: [{ name: "from-sync", tasks: [{ content: "y", status: "completed" }] }],
		} as never);
		expect(s.todoPhases[0]!.name).toBe("from-sync");
	});
});

describe("reducer queue_state event", () => {
	test("replaces queuedPrompts wholesale with the broadcast list", () => {
		let s = fresh();
		s = applyEvent(s, queueEvent("a", "1"));
		s = applyEvent(s, queueEvent("b", "2"));
		s = applyEvent(s, queueEvent("c", "3"));

		s = applyEvent(s, {
			type: "queue_state",
			queue: [
				{ id: "1", text: "a", behavior: "followUp", queuedAt: 1 },
				{ id: "3", text: "c", behavior: "followUp", queuedAt: 3 },
			],
		} as never);
		expect(s.queuedPrompts.map((q) => q.id)).toEqual(["1", "3"]);
	});

	test("returns the same state ref when the broadcast queue is structurally identical", () => {
		let s = fresh();
		s = applyEvent(s, queueEvent("a", "1"));
		const before = s;
		s = applyEvent(s, {
			type: "queue_state",
			queue: [{ id: "1", text: "a", behavior: "followUp", queuedAt: 1 }],
		} as never);
		expect(s).toBe(before);
	});

	test("queue_state with edited text on the same id updates that entry only", () => {
		let s = fresh();
		s = applyEvent(s, queueEvent("draft", "x"));
		s = applyEvent(s, {
			type: "queue_state",
			queue: [{ id: "x", text: "polished", behavior: "followUp", queuedAt: 1 }],
		} as never);
		expect(s.queuedPrompts[0]).toMatchObject({ id: "x", text: "polished" });
	});

	test("malformed queue entries (no id) are dropped, not crashed on", () => {
		const s = applyEvent(fresh(), {
			type: "queue_state",
			queue: [
				{ text: "ghost", behavior: "followUp" },
				{ id: "ok", text: "kept", behavior: "followUp", queuedAt: 1 },
			],
		} as never);
		expect(s.queuedPrompts.map((q) => q.id)).toEqual(["ok"]);
	});
});

describe("reducer queuedPrompts snapshot hydration", () => {
	test("initSession hydrates queuedPrompts from snapshot when present", () => {
		const s = initSession({
			sessionId: "s1",
			cwd: "/tmp/x",
			isStreaming: true,
			messages: [],
			todoPhases: [],
			queuedPrompts: [
				{ id: "k1", text: "first", behavior: "followUp", queuedAt: 1 },
				{ id: "k2", text: "second", behavior: "steer", queuedAt: 2 },
			],
		});
		expect(s.queuedPrompts.map((q) => q.id)).toEqual(["k1", "k2"]);
		expect(s.queuedPrompts[1]?.behavior).toBe("steer");
	});
});

describe("reducer Goal Mode lifecycle", () => {
	test("hydrates goal progress and clears it after cancellation", () => {
		const active = applyEvent(fresh(), {
			type: "goal_updated",
			goal: {
				objective: "Ship safely",
				status: "active",
				tokenBudget: 100,
				tokensUsed: 25,
				timeUsedSeconds: 9,
			},
			state: { enabled: true },
		} as never);
		expect(active.goalMode).toEqual({
			enabled: true,
			objective: "Ship safely",
			status: "active",
			tokenBudget: 100,
			tokensUsed: 25,
			timeUsedSeconds: 9,
			reason: undefined,
		});

		const cancelled = applyEvent(active, { type: "goal_updated", goal: null } as never);
		expect(cancelled.goalMode).toBeUndefined();
		expect(cancelled.goal).toBeNull();
	});
});

// ─── History paging (tail-sliced snapshots) ────────────────────────────────

function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return { sessionId: "s1", cwd: "/tmp/x", isStreaming: false, messages: [], todoPhases: [], ...over };
}

function userMsg(text: string): AgentMessageJson {
	return { role: "user", content: text };
}

function toolResultMsg(toolCallId: string, text: string): AgentMessageJson {
	return { role: "toolResult", toolCallId, toolName: "ls", content: [{ type: "text", text }] };
}

function srcIndexes(state: SessionUi): Array<number | undefined> {
	return state.messages.map((m) => ("srcIndex" in m ? m.srcIndex : undefined));
}

/** User messages by text; non-user entries collapse to their role name. */
function texts(state: SessionUi): string[] {
	return state.messages.map((m) => (m.role === "user" ? m.text : m.role));
}

const FULL_ROLLUP = { input: 100, output: 50, cacheRead: 5, cacheWrite: 6, totalTokens: 161, cost: 1.25 };

describe("initSession history paging", () => {
	test("tail snapshot: srcIndex counts every snapshot position, including toolResults folded into toolCalls", () => {
		const state = initSession(
			snap({
				messagesStartIndex: 40,
				messages: [userMsg("q"), toolResultMsg("t1", "out"), { role: "assistant", content: [{ type: "text", text: "a" }] }],
			}),
		);
		expect(state.historyStartIndex).toBe(40);
		// The toolResult occupies history index 41 but folds into toolCalls,
		// so the assistant that follows must still land on 42 — otherwise the
		// paging cursor drifts and re-fetches skip or duplicate messages.
		expect(srcIndexes(state)).toEqual([40, 42]);
		expect(state.toolCalls["t1"]?.status).toBe("complete");
	});

	test("snapshot without messagesStartIndex numbers the full history from 0", () => {
		const state = initSession(snap({ messages: [userMsg("a"), userMsg("b")] }));
		expect(state.historyStartIndex).toBe(0);
		expect(srcIndexes(state)).toEqual([0, 1]);
	});

	test("snapshot usageRollup replaces the tail-derived usage instead of adding to it", () => {
		const tail: AgentMessageJson[] = [
			{ role: "assistant", content: [], usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.5 } } },
		];
		// Without a rollup the tail messages seed usage…
		expect(initSession(snap({ messages: tail })).usage.input).toBe(1);
		// …with one, the server-computed full-history totals win wholesale
		// (input must be 100, not 101 — replace, never sum).
		const state = initSession(snap({ messages: tail, messagesStartIndex: 500, usageRollup: FULL_ROLLUP }));
		expect(state.usage).toEqual(FULL_ROLLUP);
	});
});

describe("prependHistory", () => {
	test("prepends the ingested page in front of the window and moves the cursor", () => {
		const state = initSession(snap({ messages: [userMsg("new")], messagesStartIndex: 2 }));
		const next = prependHistory(state, [userMsg("old0"), userMsg("old1")], 0);
		expect(texts(next)).toEqual(["old0", "old1", "new"]);
		expect(srcIndexes(next)).toEqual([0, 1, 2]);
		expect(next.historyStartIndex).toBe(0);
		expect(next.historyLoading).toBe(false);
	});

	test("existing tool-call streams win over re-folded historical ones", () => {
		const state = initSession(snap({ messages: [toolResultMsg("t1", "live")], messagesStartIndex: 4 }));
		const next = prependHistory(state, [toolResultMsg("t0", "older"), toolResultMsg("t1", "stale")], 2);
		expect(next.toolCalls["t1"]?.resultContent).toEqual([{ type: "text", text: "live" }]);
		expect(next.toolCalls["t0"]?.resultContent).toEqual([{ type: "text", text: "older" }]);
	});

	test("does not double-count usage or drain queued prompts while ingesting the page", () => {
		let state = initSession(snap({ messages: [], messagesStartIndex: 10, usageRollup: FULL_ROLLUP }));
		state = applyEvent(state, queueEvent("hi"));
		const page: AgentMessageJson[] = [
			// The rollup already covers this historical assistant turn.
			{ role: "assistant", content: [], usage: { input: 7, output: 7, totalTokens: 14, cost: { total: 1 } } },
			// Same text as the queued prompt — a historical user message must
			// not be mistaken for the queued prompt's real echo.
			userMsg("hi"),
		];
		const next = prependHistory(state, page, 8);
		expect(next.usage).toEqual(FULL_ROLLUP);
		expect(next.queuedPrompts.map((q) => q.text)).toEqual(["hi"]);
	});

	test("an empty page still updates the cursor and clears the loading flag", () => {
		const state = { ...initSession(snap({ messages: [userMsg("only")], messagesStartIndex: 9 })), historyLoading: true };
		const next = prependHistory(state, [], 5);
		expect(next.historyStartIndex).toBe(5);
		expect(next.historyLoading).toBe(false);
		expect(next.messages).toBe(state.messages);
	});
});

describe("trimHistory", () => {
	test("returns the same state when the window is already within target", () => {
		const state = initSession(snap({ messages: [userMsg("a"), userMsg("b")] }));
		expect(trimHistory(state, 2)).toBe(state);
		expect(trimHistory(state, 5)).toBe(state);
	});

	test("returns the same state when no droppable message carries a known srcIndex", () => {
		let state = initSession(snap());
		for (const t of ["l0", "l1", "l2", "l3"]) {
			state = applyEvent(state, userMessageStart(t));
		}
		// Live-appended messages have no history index yet — cutting here
		// would leave historyStartIndex pointing at the wrong page.
		expect(trimHistory(state, 2)).toBe(state);
	});

	test("cuts at the latest known srcIndex within the excess, skipping unindexed live messages", () => {
		let state = initSession(snap());
		for (const t of ["l0", "l1", "l2"]) {
			state = applyEvent(state, userMessageStart(t));
		}
		state = prependHistory(state, [userMsg("h0"), userMsg("h1"), userMsg("h2")], 0);
		expect(texts(state)).toEqual(["h0", "h1", "h2", "l0", "l1", "l2"]);

		// excess = 3, but messages[3] (l0) has no srcIndex — the cut lands on
		// h2 (srcIndex 2), the newest safe boundary at or before the excess.
		const trimmed = trimHistory(state, 3);
		expect(texts(trimmed)).toEqual(["h2", "l0", "l1", "l2"]);
		expect(trimmed.historyStartIndex).toBe(2);
	});

	test("drops tool-call streams owned by dropped assistant messages and keeps the rest", () => {
		const state = initSession(
			snap({
				messagesStartIndex: 0,
				messages: [
					{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "ls", arguments: {} }] },
					toolResultMsg("t1", "one"),
					userMsg("mid"),
					{ role: "assistant", content: [{ type: "toolCall", id: "t2", name: "cat", arguments: {} }] },
					toolResultMsg("t2", "two"),
					userMsg("tail"),
				],
			}),
		);
		expect(Object.keys(state.toolCalls).sort()).toEqual(["t1", "t2"]);

		// Window: [asst(0), user(2), asst(3), user(5)] — trim to 2 cuts at the
		// second assistant (srcIndex 3), dropping the first turn and its tool.
		const trimmed = trimHistory(state, 2);
		expect(srcIndexes(trimmed)).toEqual([3, 5]);
		expect(trimmed.historyStartIndex).toBe(3);
		expect(Object.keys(trimmed.toolCalls)).toEqual(["t2"]);
	});
});

// ─── T-97: Codex sub-agent cost display ────────────────────────────────────

/** A task `tool_execution_end` event carrying sub-agent results with the full
 *  SDK `usage` shape (`cost` as an object). Uses a non-zero `cost.total` so
 *  any accidental serialisation or extraction bug is detectable. */
function taskEndEvent(costTotal: number, tokens: number, isError = false): never {
	const usage = {
		input: 1000,
		output: 200,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1200,
		cost: { input: 0.01, output: 0.032, cacheRead: 0, cacheWrite: 0, total: costTotal },
	};
	return {
		type: "tool_execution_end",
		toolCallId: "tc-task-1",
		toolName: "task",
		isError,
		result: {
			content: [{ type: "text", text: "done" }],
			details: {
				projectAgentsDir: null,
				results: [
					{
						index: 0,
						id: "Worker1",
						agent: "task",
						agentSource: "bundled",
						tokens,
						requests: 3,
						exitCode: 0,
						durationMs: 8000,
						usage,
					},
				],
				totalDurationMs: 8000,
				usage,
			},
		},
	} as never;
}

describe("T-97: task tool sub-agent cost display (Codex fixture)", () => {
	test("sub-agent result row: tokens and usage.cost survive the reducer unchanged", () => {
		const state = applyEvent(fresh(), taskEndEvent(0.042, 5432));
		const result = state.toolCalls["tc-task-1"]?.result as Record<string, unknown> | undefined;
		expect(result).toBeDefined();
		const details = result?.details as Record<string, unknown> | undefined;
		const results = details?.results as Array<Record<string, unknown>> | undefined;
		expect(Array.isArray(results) && results.length).toBe(1);
		const row = results?.[0];
		expect(row?.tokens).toBe(5432);
		const rowUsage = row?.usage as Record<string, unknown> | undefined;
		const rowCost = rowUsage?.cost as Record<string, unknown> | undefined;
		expect(rowCost?.total).toBe(0.042);
	});

	test("parent CostStrip: details.usage.cost.total is rolled into session usage", () => {
		const state = applyEvent(fresh(), taskEndEvent(0.042, 5432));
		// Without the fix this is 0 — the bug: rollupUsage is never called from tool_execution_end.
		expect(state.usage.cost).toBeCloseTo(0.042, 6);
	});

	test("parent CostStrip: details.usage tokens are rolled in alongside cost", () => {
		const state = applyEvent(fresh(), taskEndEvent(0.042, 5432));
		expect(state.usage.totalTokens).toBe(1200);
	});

	test("parent CostStrip: errors do not roll up sub-agent usage", () => {
		const state = applyEvent(fresh(), taskEndEvent(0.042, 5432, true));
		expect(state.usage.cost).toBe(0);
	});
});
