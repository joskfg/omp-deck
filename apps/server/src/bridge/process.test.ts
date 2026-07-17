import { afterEach, describe, expect, test } from "bun:test";

import type { AgentSessionEventJson, QueuedPromptWire } from "@omp-deck/protocol";
import { broadcastBus } from "../broadcast-bus.ts";
import type { BroadcastFrame } from "../broadcast-bus.ts";

import { createWorkerRequestHandler } from "./agent-worker.ts";
import { ProcessAgentBridge } from "./process.ts";
import type { AgentWorkerProcess } from "./process.ts";
import type {
	WorkerMethod,
	WorkerOutboundFrame,
	WorkerPlanFrame,
	WorkerRequestFrame,
	WorkerUiFrame,
} from "./worker-protocol.ts";

class FakeAgentWorker implements AgentWorkerProcess {
	readonly exited: Promise<number>;
	readonly sessionId: string;
	killCalls = 0;

	private readonly onMessage: (message: unknown) => void;
	private readonly queued: QueuedPromptWire[] = [];
	readonly receivedRequests: WorkerRequestFrame[] = [];
	private readonly heldRequestCounts = new Map<WorkerMethod, number>();
	private readonly heldRequests: WorkerRequestFrame[] = [];
	private resolveExit!: (code: number) => void;
	private closed = false;
	private queuedAt = 0;

	constructor(index: number, onMessage: (message: unknown) => void) {
		this.sessionId = `root-${index}`;
		this.onMessage = onMessage;
		this.exited = new Promise<number>((resolve) => {
			this.resolveExit = resolve;
		});
	}

	send(message: WorkerRequestFrame): void {
		this.receivedRequests.push(message);
		if (this.closed) throw new Error(`worker ${this.sessionId} is closed`);
		const heldCount = this.heldRequestCounts.get(message.method) ?? 0;
		if (heldCount > 0) {
			if (heldCount === 1) this.heldRequestCounts.delete(message.method);
			else this.heldRequestCounts.set(message.method, heldCount - 1);
			this.heldRequests.push(message);
			return;
		}

		queueMicrotask(() => {
			if (this.closed) return;
			try {
				this.respond(message, this.dispatch(message));
			} catch (error) {
				this.onMessage({
					type: "response",
					id: message.id,
					ok: false,
					error: {
						name: error instanceof Error ? error.name : "Error",
						message: error instanceof Error ? error.message : String(error),
					},
				} satisfies WorkerOutboundFrame);
			}
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

	holdNext(method: WorkerMethod, count = 1): void {
		this.heldRequestCounts.set(method, (this.heldRequestCounts.get(method) ?? 0) + count);
	}

	releaseHeldInReverse(method: WorkerMethod, resultsInRequestOrder: unknown[]): void {
		const requests = this.heldRequests.filter((request) => request.method === method);
		if (requests.length !== resultsInRequestOrder.length) {
			throw new Error(
				`expected ${resultsInRequestOrder.length} held ${method} requests, found ${requests.length}`,
			);
		}
		for (const request of requests) {
			this.heldRequests.splice(this.heldRequests.indexOf(request), 1);
		}
		for (let index = requests.length - 1; index >= 0; index -= 1) {
			this.respond(requests[index]!, resultsInRequestOrder[index]);
		}
	}

	emit(frame: WorkerOutboundFrame): void {
		if (this.closed) throw new Error(`worker ${this.sessionId} is closed`);
		this.onMessage(frame);
	}

	private dispatch(message: WorkerRequestFrame): unknown {
		switch (message.method) {
			case "bridge.createSession": {
				const [request] = message.args;
				return { sessionId: this.sessionId, sessionFile: undefined, cwd: request.cwd };
			}
			case "bridge.resumeSession": {
				const [request] = message.args;
				return {
					sessionId: request.sessionPath,
					sessionFile: request.sessionPath,
					cwd: "/resumed-workspace",
				};
			}
			case "session.prompt": {
				const [text, options] = message.args;
				this.queuedAt += 1;
				this.queued.push({
					// Each worker deliberately uses the same process-local child id. Isolation
					// must come from the worker boundary, not globally unique agent names.
					id: "local-child",
					text,
					behavior: options?.streamingBehavior ?? "followUp",
					queuedAt: this.queuedAt,
				});
				return undefined;
			}
			case "session.getQueueSnapshot":
				return this.queued.map((entry) => ({ ...entry }));
			default:
				return undefined;
		}
	}

	private respond(request: WorkerRequestFrame, result: unknown): void {
		this.onMessage({ type: "response", id: request.id, ok: true, result });
	}
}

interface Harness {
	bridge: ProcessAgentBridge;
	workers: FakeAgentWorker[];
}

const bridges: ProcessAgentBridge[] = [];

afterEach(async () => {
	await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()));
});

function createHarness(holdOnSpawn?: WorkerMethod): Harness {
	const workers: FakeAgentWorker[] = [];
	const bridge = new ProcessAgentBridge({
		workerEntryPath: "/never-executed/agent-worker.ts",
		idleTimeoutMs: 0,
		spawnWorker: (onMessage) => {
			const worker = new FakeAgentWorker(workers.length + 1, onMessage);
			if (holdOnSpawn) worker.holdNext(holdOnSpawn);
			workers.push(worker);
			return worker;
		},
	});
	bridges.push(bridge);
	return { bridge, workers };
}

async function createTwoSessions(harness: Harness) {
	return Promise.all([
		harness.bridge.createSession({ cwd: "/same-workspace" }),
		harness.bridge.createSession({ cwd: "/same-workspace" }),
	]);
}
describe("ProcessAgentBridge worker isolation", () => {
	test("simultaneous root sessions use distinct workers even when process-local child ids collide", async () => {
		const harness = createHarness();
		const [first, second] = await createTwoSessions(harness);

		expect(harness.workers).toHaveLength(2);

		await Promise.all([first.prompt("owned by first"), second.prompt("owned by second")]);

		expect(await first.getQueueSnapshot()).toEqual([
			{
				id: "local-child",
				text: "owned by first",
				behavior: "followUp",
				queuedAt: 1,
			},
		]);
		expect(await second.getQueueSnapshot()).toEqual([
			{
				id: "local-child",
				text: "owned by second",
				behavior: "followUp",
				queuedAt: 1,
			},
		]);
	});

	test("forwards thinking level changes through the owning worker RPC", async () => {
		const harness = createHarness();
		const handle = await harness.bridge.createSession({ cwd: "/same-workspace" });
		const worker = harness.workers[0]!;
		worker.holdNext("session.setThinkingLevel");

		const change = handle.setThinkingLevel("low");
		expect(worker.receivedRequests).toContainEqual(
			expect.objectContaining({ method: "session.setThinkingLevel", args: ["low"] }),
		);
		worker.releaseHeldInReverse("session.setThinkingLevel", [undefined]);
		await expect(change).resolves.toBeUndefined();
	});

	test("out-of-order worker responses stay correlated with their originating calls", async () => {
		const harness = createHarness();
		const handle = await harness.bridge.createSession({
			cwd: "/same-workspace",
		});
		const worker = harness.workers[0]!;
		worker.holdNext("session.cancelQueuedById", 2);

		const firstCall = handle.cancelQueuedById("local-child");
		const secondCall = handle.cancelQueuedById("other-local-child");
		worker.releaseHeldInReverse("session.cancelQueuedById", [true, false]);

		expect(await Promise.all([firstCall, secondCall])).toEqual([true, false]);
	});

	test("session, UI, and plan events reach only the handle that owns the emitting worker", async () => {
		const harness = createHarness();
		const [first, second] = await createTwoSessions(harness);
		const firstSessionEvents: AgentSessionEventJson[] = [];
		const secondSessionEvents: AgentSessionEventJson[] = [];
		const firstUiFrames: WorkerUiFrame[] = [];
		const secondUiFrames: WorkerUiFrame[] = [];
		const firstPlanFrames: WorkerPlanFrame[] = [];
		const secondPlanFrames: WorkerPlanFrame[] = [];

		first.subscribe((event) => firstSessionEvents.push(event));
		second.subscribe((event) => secondSessionEvents.push(event));
		harness.bridge.subscribeUiFrames(first.sessionId, (frame) => firstUiFrames.push(frame));
		harness.bridge.subscribeUiFrames(second.sessionId, (frame) => secondUiFrames.push(frame));
		harness.bridge.subscribePlanModeFrames(first.sessionId, (frame) => firstPlanFrames.push(frame));
		harness.bridge.subscribePlanModeFrames(second.sessionId, (frame) => secondPlanFrames.push(frame));

		const firstEvent: AgentSessionEventJson = { type: "message_start", source: "first" };
		const firstUi: WorkerUiFrame = {
			type: "ext_ui_dialog_open",
			sessionId: first.sessionId,
			dialogId: "first-dialog",
			kind: "confirm",
			prompt: "first only",
		};
		const firstPlan: WorkerPlanFrame = {
			type: "plan_mode_changed",
			sessionId: first.sessionId,
			enabled: true,
			planFilePath: "local://PLAN.md",
		};
		harness.workers[0]!.emit({ type: "event", channel: "session", event: firstEvent });
		harness.workers[0]!.emit({ type: "event", channel: "ui", frame: firstUi });
		harness.workers[0]!.emit({ type: "event", channel: "plan", frame: firstPlan });

		expect(firstSessionEvents).toEqual([firstEvent]);
		expect(firstUiFrames).toEqual([firstUi]);
		expect(firstPlanFrames).toEqual([firstPlan]);
		expect(secondSessionEvents).toEqual([]);
		expect(secondUiFrames).toEqual([]);
		expect(secondPlanFrames).toEqual([]);

		const secondEvent: AgentSessionEventJson = { type: "message_start", source: "second" };
		const secondUi: WorkerUiFrame = {
			type: "ext_ui_dialog_open",
			sessionId: second.sessionId,
			dialogId: "second-dialog",
			kind: "confirm",
			prompt: "second only",
		};
		const secondPlan: WorkerPlanFrame = {
			type: "plan_mode_changed",
			sessionId: second.sessionId,
			enabled: true,
			planFilePath: "local://PLAN.md",
		};
		harness.workers[1]!.emit({ type: "event", channel: "session", event: secondEvent });
		harness.workers[1]!.emit({ type: "event", channel: "ui", frame: secondUi });
		harness.workers[1]!.emit({ type: "event", channel: "plan", frame: secondPlan });

		expect(firstSessionEvents).toEqual([firstEvent]);
		expect(firstUiFrames).toEqual([firstUi]);
		expect(firstPlanFrames).toEqual([firstPlan]);
		expect(secondSessionEvents).toEqual([secondEvent]);
		expect(secondUiFrames).toEqual([secondUi]);
		expect(secondPlanFrames).toEqual([secondPlan]);
	});

	test("worker broadcasts are forwarded exactly once without entering the session event stream", async () => {
		const harness = createHarness();
		const handle = await harness.bridge.createSession({
			cwd: "/same-workspace",
		});
		const broadcastFrames: BroadcastFrame[] = [];
		const sessionEvents: AgentSessionEventJson[] = [];
		const unsubscribeBroadcast = broadcastBus.subscribe((frame) => broadcastFrames.push(frame));
		const unsubscribeSession = handle.subscribe((event) => sessionEvents.push(event));

		try {
			const frame: BroadcastFrame = {
				type: "notification",
				id: "child-notification",
				level: "error",
				title: "Child worker failed",
				body: "Failure details",
				sound: true,
				source: "agent:root-1",
				actionUrl: "/sessions/root-1",
				timestamp: "2026-07-06T12:00:00.000Z",
			};

			harness.workers[0]!.emit({ type: "event", channel: "broadcast", frame });

			expect(broadcastFrames).toEqual([frame]);
			expect(sessionEvents).toEqual([]);
		} finally {
			unsubscribeSession();
			unsubscribeBroadcast();
		}
	});

	test("a worker crash rejects its pending request and evicts only its own session", async () => {
		const harness = createHarness();
		const [first, second] = await createTwoSessions(harness);
		const failedWorker = harness.workers[0]!;
		failedWorker.holdNext("session.snapshot");
		const pendingSnapshot = first.snapshot();

		failedWorker.crash(23);

		await expect(pendingSnapshot).rejects.toThrow("agent worker exited with code 23");
		expect(harness.bridge.getSession(first.sessionId)).toBeUndefined();
		expect(harness.bridge.getSession(second.sessionId)).toBe(second);

		await second.prompt("survives sibling crash");
		expect(await second.getQueueSnapshot()).toEqual([
			{
				id: "local-child",
				text: "survives sibling crash",
				behavior: "followUp",
				queuedAt: 1,
			},
		]);
	});

	test("session cleanup is idempotent and terminates only its worker once", async () => {
		const harness = createHarness();
		const handle = await harness.bridge.createSession({
			cwd: "/same-workspace",
		});
		const worker = harness.workers[0]!;

		await Promise.all([handle.dispose(), handle.dispose()]);
		await handle.dispose();
		await Promise.all([harness.bridge.dispose(), harness.bridge.dispose()]);

		expect(worker.killCalls).toBe(1);
		expect(harness.bridge.getSession(handle.sessionId)).toBeUndefined();
	});

	test("resuming an active session path reuses its handle and worker", async () => {
		const harness = createHarness();
		const sessionPath = "/sessions/already-active.jsonl";
		const original = await harness.bridge.resumeSession({ sessionPath });
		const originalWorker = harness.workers[0]!;

		const resumed = await harness.bridge.resumeSession({ sessionPath });

		expect(harness.workers).toHaveLength(1);
		expect(resumed).toBe(original);
		expect(originalWorker.killCalls).toBe(0);
	});

	test("concurrent resumes of one inactive path share initialization", async () => {
		const harness = createHarness("bridge.resumeSession");
		const sessionPath = "/sessions/concurrent-resume.jsonl";

		const firstResume = harness.bridge.resumeSession({ sessionPath });
		const secondResume = harness.bridge.resumeSession({ sessionPath });
		const workersSpawnedDuringInitialization = harness.workers.length;

		for (const worker of harness.workers) {
			worker.releaseHeldInReverse("bridge.resumeSession", [
				{
					sessionId: sessionPath,
					sessionFile: sessionPath,
					cwd: "/resumed-workspace",
				},
			]);
		}
		const [first, second] = await Promise.all([firstResume, secondResume]);

		expect(workersSpawnedDuringInitialization).toBe(1);
		expect(second).toBe(first);
	});
});

describe("agent worker request dispatch", () => {
	test("abort settles while a prompt request remains pending", async () => {
		let resolvePrompt!: () => void;
		const pendingPrompt = new Promise<void>((resolve) => {
			resolvePrompt = resolve;
		});
		const entered: WorkerMethod[] = [];
		const outbound: WorkerOutboundFrame[] = [];
		const handlerErrors: unknown[] = [];
		let confirmPromptResponse!: () => void;
		const promptResponded = new Promise<void>((resolve) => {
			confirmPromptResponse = resolve;
		});
		const handleMessage = createWorkerRequestHandler(
			async (frame) => {
				entered.push(frame.method);
				if (frame.method === "session.prompt") return pendingPrompt;
				if (frame.method === "session.abort") return undefined;
				throw new Error(`unexpected worker method: ${frame.method}`);
			},
			(frame) => {
				outbound.push(frame);
				if (frame.type === "response" && frame.id === "prompt") confirmPromptResponse();
			},
			(error) => handlerErrors.push(error),
		);
		const promptFrame = {
			type: "request",
			id: "prompt",
			method: "session.prompt",
			args: ["keep running"],
		} satisfies WorkerRequestFrame;
		const abortFrame = {
			type: "request",
			id: "abort",
			method: "session.abort",
			args: [],
		} satisfies WorkerRequestFrame;

		handleMessage(promptFrame);
		handleMessage(abortFrame);

		// Dispatch begins synchronously. A single chained request queue would leave
		// abort blocked behind the unresolved prompt at this assertion.
		expect(entered).toEqual(["session.prompt", "session.abort"]);
		await Promise.resolve();
		expect(outbound).toEqual([{ type: "response", id: "abort", ok: true, result: undefined }]);

		resolvePrompt();
		await promptResponded;
		expect(outbound).toEqual([
			{ type: "response", id: "abort", ok: true, result: undefined },
			{ type: "response", id: "prompt", ok: true, result: undefined },
		]);
		expect(handlerErrors).toEqual([]);
	});
});
