/**
 * T-32 regression test: reopening a handoff's ORIGIN file must NEVER kill
 * the still-live continuation's worker process, even though a fresh
 * `bridge.resumeSession` for that origin file resolves to the SAME on-disk
 * session id the live continuation's `active` map key is still pinned to
 * (see `process.ts`'s `spawnSession` collision-disambiguation doc comment
 * — mirrors the in-process bridge's `attach-handoff-collision.test.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { WorkerOutboundFrame, WorkerRequestFrame } from "./worker-protocol.ts";
import { ProcessAgentBridge } from "./process.ts";
import type { AgentWorkerProcess } from "./process.ts";

/** Minimal fake worker: `bridge.resumeSession` deterministically returns
 *  `sessionId === sessionFile === request.sessionPath`, matching the real
 *  worker's contract closely enough to exercise the id-collision path. */
class FakeWorker implements AgentWorkerProcess {
	readonly exited: Promise<number>;
	private readonly onMessage: (message: unknown) => void;
	private resolveExit!: (code: number) => void;
	private closed = false;
	killCalls = 0;

	constructor(onMessage: (message: unknown) => void) {
		this.onMessage = onMessage;
		this.exited = new Promise<number>((resolve) => {
			this.resolveExit = resolve;
		});
	}

	send(message: WorkerRequestFrame): void {
		queueMicrotask(() => {
			if (this.closed) return;
			if (message.method === "bridge.resumeSession") {
				const [request] = message.args as [{ sessionPath: string }];
				this.onMessage({
					type: "response",
					id: message.id,
					ok: true,
					result: { sessionId: request.sessionPath, sessionFile: request.sessionPath, cwd: "/wt" },
				} satisfies WorkerOutboundFrame);
				return;
			}
			this.onMessage({ type: "response", id: message.id, ok: true, result: undefined } satisfies WorkerOutboundFrame);
		});
	}

	kill(): void {
		this.killCalls += 1;
		this.crash(0);
	}

	crash(code: number): void {
		if (this.closed) return;
		this.closed = true;
		this.resolveExit(code);
	}

	/** Test-only: simulate a `session_handoff` event flowing from this worker. */
	emitHandoff(newSessionFile: string): void {
		this.onMessage({
			type: "event",
			channel: "session",
			event: { type: "session_handoff", newSessionFile, previousSessionId: "x", newSessionId: "y", reason: "threshold", timestamp: Date.now() },
		} satisfies WorkerOutboundFrame);
	}
}

const bridges: ProcessAgentBridge[] = [];
afterEach(async () => {
	await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()));
});

function createBridge(): { bridge: ProcessAgentBridge; workers: FakeWorker[] } {
	const workers: FakeWorker[] = [];
	const bridge = new ProcessAgentBridge({
		workerEntryPath: "/never-executed/agent-worker.ts",
		idleTimeoutMs: 0,
		spawnWorker: (onMessage) => {
			const worker = new FakeWorker(onMessage);
			workers.push(worker);
			return worker;
		},
	});
	bridges.push(bridge);
	return { bridge, workers };
}

describe("ProcessAgentBridge.spawnSession handoff-origin collision (T-32)", () => {
	test("reopening the origin file after its worker handed off spawns an independent handle, never killing the live worker", async () => {
		const { bridge, workers } = createBridge();

		const continuation = await bridge.resumeSession({ sessionPath: "/sessions/origin.jsonl" });
		expect(continuation.sessionId).toBe("/sessions/origin.jsonl");
		const liveWorker = workers[0]!;

		// Simulate the SDK's in-place auto-handoff: the worker's session file
		// moves on while its `active` map key (== its natural on-disk id, the
		// origin path in this fixture) stays pinned.
		liveWorker.emitHandoff("/sessions/continuation.jsonl");
		// Let the emitted event's microtask settle before proceeding.
		await Promise.resolve();
		expect(continuation.sessionFile).toBe("/sessions/continuation.jsonl");

		// Now reopen the ORIGIN file directly (e.g. the handoff banner's
		// "origin" link) — its own on-disk id is unchanged, so the fresh
		// resume resolves to the SAME id the live continuation is still
		// registered under.
		const origin = await bridge.resumeSession({ sessionPath: "/sessions/origin.jsonl" });

		expect(liveWorker.killCalls).toBe(0);
		expect(bridge.getSession(continuation.sessionId)).toBe(continuation);
		expect(origin.sessionId).not.toBe(continuation.sessionId);
		expect(bridge.getSession(origin.sessionId)).toBe(origin);
		expect(workers).toHaveLength(2);
	});
});
