/**
 * Tests the observable title-generation boundary. The title service reads its
 * model from the real settings DB and its prompt from the composed KB
 * integration, then delegates one direct request to the bridge.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ModelRef } from "@omp-deck/protocol";

import { broadcastBus } from "./broadcast-bus.ts";
import type { AgentBridge, SessionHandle } from "./bridge/types.ts";
import { closeDb, openDb } from "./db/index.ts";
import { setInternalTaskModel } from "./db/server-settings.ts";
import { createTask } from "./db/tasks.ts";
import { generateSessionTitle, maybeAutoTitleSession } from "./session-title.ts";

let dbDir: string;

type GenerateTitleRequest = {
	sessionId: string;
	model: ModelRef;
	systemPrompt: string;
	userMessage: string;
};

function fakeBridge(
	response: string | null,
	calls: GenerateTitleRequest[],
	error?: Error,
): AgentBridge {
	return {
		async generateTitle(request: GenerateTitleRequest) {
			calls.push(request);
			if (error) throw error;
			return response;
		},
	} as unknown as AgentBridge;
}

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-session-title-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
});

afterEach(() => {
	closeDb();
	fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("generateSessionTitle", () => {
	test("returns undefined without calling the bridge when no internal model is configured", async () => {
		const calls: GenerateTitleRequest[] = [];

		const result = await generateSessionTitle(fakeBridge("unused", calls), {
			sessionId: "session-1",
			firstMessage: "Fix the login bug",
		});

		expect(result).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("sanitizes the first line of a quoted title response", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const calls: GenerateTitleRequest[] = [];

		const result = await generateSessionTitle(
			fakeBridge('"Fix the login flow"\nextra reasoning the title generator should ignore', calls),
			{ sessionId: "session-1", firstMessage: "Fix the login bug" },
		);

		expect(result).toBe("Fix the login flow");
	});

	test("uses only the base session-title integration plus its user sidecar", async () => {
		const savedKbRoot = process.env.OMP_DECK_KB_ROOT;
		const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-session-title-kb-"));
		fs.mkdirSync(path.join(kbRoot, "integrations"), { recursive: true });
		fs.writeFileSync(path.join(kbRoot, "integrations", "session-title.md"), "Base title instructions.", "utf8");
		fs.writeFileSync(path.join(kbRoot, "integrations", "session-title.user.md"), "User title addition.", "utf8");
		process.env.OMP_DECK_KB_ROOT = kbRoot;
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const calls: GenerateTitleRequest[] = [];

		try {
			await generateSessionTitle(fakeBridge("Title", calls), { sessionId: "session-1", firstMessage: "Hi" });
			expect(calls).toHaveLength(1);
			expect(calls[0]?.systemPrompt).toBe("Base title instructions.\n\nUser title addition.");
		} finally {
			if (savedKbRoot === undefined) delete process.env.OMP_DECK_KB_ROOT;
			else process.env.OMP_DECK_KB_ROOT = savedKbRoot;
			fs.rmSync(kbRoot, { recursive: true, force: true });
		}
	});

	test("includes a linked task's title and body in the title generation request", async () => {
		setInternalTaskModel({ provider: "openai", id: "gpt-title" });
		const task = createTask({ title: "Fix the login flow", body: "Steps to repro..." });
		const calls: GenerateTitleRequest[] = [];

		await generateSessionTitle(fakeBridge("T-1: Fix the login flow", calls), {
			sessionId: "session-target-42",
			firstMessage: `Please look at GET /api/tasks/${task.id} and fix it`,
		});

		expect(calls[0]?.userMessage).toContain(`Linked kanban task: T-${task.displayId}: Fix the login flow`);
		expect(calls[0]?.userMessage).toContain("Steps to repro...");
	});

	test("does not attach task context for an id-shaped substring inside a longer token", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const task = createTask({ title: "Should not be linked" });
		const calls: GenerateTitleRequest[] = [];

		const result = await generateSessionTitle(fakeBridge("Some Title", calls), {
			sessionId: "session-1",
			firstMessage: `See ${task.id}extra for details`,
		});

		expect(result).toBe("Some Title");
		expect(calls[0]?.userMessage).not.toContain("Linked kanban task");
	});

	test("returns undefined when the bridge returns null", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const calls: GenerateTitleRequest[] = [];

		const result = await generateSessionTitle(fakeBridge(null, calls), { sessionId: "session-1", firstMessage: "Hi" });

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	test("returns undefined when the bridge rejects the title request", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const calls: GenerateTitleRequest[] = [];

		const result = await generateSessionTitle(
			fakeBridge(null, calls, new Error("bridge unavailable")),
			{ sessionId: "session-1", firstMessage: "Hi" },
		);

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	for (const [name, response] of [
		["empty", ""],
		["whitespace-only", "   \n   "],
		["only markdown delimiters", "```"],
	] as const) {
		test(`returns undefined when the title response is ${name}`, async () => {
			setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
			const calls: GenerateTitleRequest[] = [];

			const result = await generateSessionTitle(fakeBridge(response, calls), { sessionId: "session-1", firstMessage: "Hi" });

			expect(result).toBeUndefined();
		});
	}
});

describe("maybeAutoTitleSession", () => {
	function fakeHandle(opts: { sessionName?: string } = {}): {
		handle: SessionHandle;
		setNameCalls: string[];
		snapshotCalls: number[];
		snapshotCalled: Promise<void>;
	} {
		const setNameCalls: string[] = [];
		const snapshotCalls: number[] = [];
		const snapshotCalled = Promise.withResolvers<void>();
		const handle = {
			sessionId: "session-42",
			snapshot() {
				snapshotCalls.push(snapshotCalls.length);
				snapshotCalled.resolve();
				return opts.sessionName ? { sessionName: opts.sessionName } : {};
			},
			async setName(name: string) {
				setNameCalls.push(name);
			},
		};
		return {
			handle: handle as unknown as SessionHandle,
			setNameCalls,
			snapshotCalls,
			snapshotCalled: snapshotCalled.promise,
		};
	}

	test("generates a title, renames the session, and broadcasts sessions_changed when unnamed", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const task = createTask({ title: "Fix the login flow", body: "Steps to repro..." });
		const calls: GenerateTitleRequest[] = [];
		const { handle, setNameCalls } = fakeHandle();

		const sessionsChanged = new Promise<void>((resolve) => {
			const stop = broadcastBus.subscribe((frame) => {
				if (frame.type === "sessions_changed") {
					stop();
					resolve();
				}
			});
		});

		maybeAutoTitleSession(
			fakeBridge('"Fix The Login Bug"', calls),
			handle,
			`Please look at GET /api/tasks/${task.id} and fix it`,
		);
		await sessionsChanged;

		expect(calls).toHaveLength(1);
		expect(calls[0]?.sessionId).toBe("session-42");
		expect(calls[0]?.userMessage).toContain(`GET /api/tasks/${task.id}`);
		expect(calls[0]?.userMessage).toContain(`Linked kanban task: T-${task.displayId}: Fix the login flow`);
		expect(setNameCalls).toEqual(["Fix The Login Bug"]);
	});

	test("deduplicates concurrent title requests for the same session", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const calls: GenerateTitleRequest[] = [];
		const titleRequested = Promise.withResolvers<void>();
		const titleResponse = Promise.withResolvers<string | null>();
		const { handle, setNameCalls, snapshotCalls } = fakeHandle();
		const sessionsChanged = new Promise<void>((resolve) => {
			const stop = broadcastBus.subscribe((frame) => {
				if (frame.type === "sessions_changed") {
					stop();
					resolve();
				}
			});
		});
		const bridge = {
			async generateTitle(request: GenerateTitleRequest) {
				calls.push(request);
				titleRequested.resolve();
				return titleResponse.promise;
			},
		} as unknown as AgentBridge;

		maybeAutoTitleSession(bridge, handle, "Fix the login bug");
		maybeAutoTitleSession(bridge, handle, "Fix the login bug");
		await titleRequested.promise;

		expect(snapshotCalls).toEqual([0]);
		expect(calls).toHaveLength(1);
		titleResponse.resolve("Fix the login bug");
		await sessionsChanged;
		expect(setNameCalls).toEqual(["Fix the login bug"]);
	});

	test("never renames a session that already has a sessionName", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		const calls: GenerateTitleRequest[] = [];
		const { handle, setNameCalls, snapshotCalled } = fakeHandle({ sessionName: "Already Named" });

		maybeAutoTitleSession(fakeBridge("unused", calls), handle, "Hello");
		await snapshotCalled;
		// Flush the microtask hops between `snapshot()` resolving and the
		// early `if (snapshot.sessionName) return` landing right after it.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(calls).toEqual([]);
		expect(setNameCalls).toEqual([]);
	});

	test("attempts no title generation at all when internalTaskModel is unset", () => {
		const calls: GenerateTitleRequest[] = [];
		const { handle, setNameCalls, snapshotCalls } = fakeHandle();

		maybeAutoTitleSession(fakeBridge("unused", calls), handle, "Hello");

		expect(snapshotCalls).toEqual([]);
		expect(calls).toEqual([]);
		expect(setNameCalls).toEqual([]);
	});
});
