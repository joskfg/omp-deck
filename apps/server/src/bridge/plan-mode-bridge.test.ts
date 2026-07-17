/**
 * PlanModeBridge tests — Slice A of T-105 (plan mode in deck).
 *
 * Exercises the per-session plan-mode state machine end-to-end without
 * spinning up a real `AgentSession`. The session-facing surface is small
 * enough that a hand-rolled stub captures it cleanly; the SDK helpers we
 * compose (`resolvePlanTitle`, `renameApprovedPlanFile`,
 * `runResolveInvocation`, `local://` resolver) run against a real
 * temporary artifacts directory so the rename + file-read paths exercise
 * actual filesystem behavior.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import type { ModelRef, ServerFrame } from "@omp-deck/protocol";

import {
	PlanModeBridge,
	type PlanModeFrame,
	type PlanModelConfig,
	type PlanModelController,
	type PlanModeSessionSurface,
} from "./plan-mode-bridge.ts";

type PromptCall = {
	text: string;
	options?: { synthetic?: boolean; streamingBehavior?: "steer" | "followUp" };
};

type PlanExecutionFrame = Extract<PlanModeFrame, { type: "plan_execution_changed" }>;
type PlanProposedFrame = Extract<PlanModeFrame, { type: "plan_proposed" }>;

class StubSession implements PlanModeSessionSurface {
	private activeTools: string[];
	planModeStateCalls: Array<
		{ enabled: boolean; planFilePath: string; workflow: "parallel" | "iterative" } | undefined
	> = [];
	standingHandlerCalls: Array<((input: unknown) => Promise<unknown> | unknown) | null> = [];
	standingHandler: ((input: unknown) => Promise<unknown> | unknown) | null = null;
	markPlanReferenceSentCount = 0;
	setPlanReferencePathCalls: Array<string | undefined> = [];
	markPlanInternalAbortPendingCount = 0;
	clearPlanInternalAbortPendingCount = 0;
	compactCalls = 0;
	promptCalls: PromptCall[] = [];
	nextPromptError: Error | undefined;
	setActiveToolsCalls: string[][] = [];
	isStreaming = true;
	#compactGate: Promise<void> = Promise.resolve();
	#compactionStarted = Promise.withResolvers<void>();
	#promptGate: Promise<void> = Promise.resolve();
	#promptStarted = Promise.withResolvers<void>();

	constructor(initialTools: string[] = ["read", "search", "find", "lsp", "web_search", "edit", "write"]) {
		this.activeTools = [...initialTools];
	}

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		this.activeTools = [...toolNames];
		this.setActiveToolsCalls.push([...toolNames]);
	}

	setPlanModeState(
		state: { enabled: boolean; planFilePath: string; workflow: "parallel" | "iterative" } | undefined,
	): void {
		this.planModeStateCalls.push(state);
	}

	setStandingResolveHandler(
		handler: ((input: unknown) => Promise<unknown> | unknown) | null,
	): void {
		this.standingHandlerCalls.push(handler);
		this.standingHandler = handler;
	}

	setPlanReferencePath(planFilePath: string | undefined): void {
		this.setPlanReferencePathCalls.push(planFilePath);
	}

	markPlanInternalAbortPending(): void {
		this.markPlanInternalAbortPendingCount += 1;
	}

	clearPlanInternalAbortPending(): void {
		this.clearPlanInternalAbortPendingCount += 1;
	}

	compact(): Promise<void> {
		this.compactCalls += 1;
		this.#compactionStarted.resolve();
		return this.#compactGate;
	}

	deferCompaction() {
		const gate = Promise.withResolvers<void>();
		this.#compactGate = gate.promise;
		this.#compactionStarted = Promise.withResolvers<void>();
		return gate;
	}

	waitForCompaction(): Promise<void> {
		return this.#compactionStarted.promise;
	}

	waitForPrompt(): Promise<void> {
		return this.#promptStarted.promise;
	}

	deferPrompt() {
		const gate = Promise.withResolvers<void>();
		this.#promptGate = gate.promise;
		this.#promptStarted = Promise.withResolvers<void>();
		return gate;
	}

	markPlanReferenceSent(): void {
		this.markPlanReferenceSentCount += 1;
	}

	async prompt(
		text: string,
		options?: { synthetic?: boolean; streamingBehavior?: "steer" | "followUp" },
	): Promise<void> {
		this.promptCalls.push({ text, ...(options ? { options } : {}) });
		this.#promptStarted.resolve();
		const error = this.nextPromptError;
		this.nextPromptError = undefined;
		if (error) throw error;
		await this.#promptGate;
	}
}

type FakePlanModelOptions = {
	config: PlanModelConfig | null;
	current?: ModelRef;
	currentThinking?: string;
	streaming?: boolean;
	/** Make setModelTemporary reject to exercise the failure-isolation path. */
	rejectSwitch?: boolean;
};

/**
 * Hand-rolled PlanModelController that behaves like the real controller: a
 * successful setModelTemporary actually flips the "active" model (so the
 * exit-restore path sees a changed current model and restores it), and
 * setThinkingLevel adjusts the thinking level without touching the model.
 * Records each switch/thinking call so tests assert the observable override
 * behavior rather than restating the bridge's internals.
 */
class FakePlanModel implements PlanModelController {
	readonly setModelTemporaryCalls: Array<{ model: ModelRef; thinking?: string }> = [];
	readonly setThinkingLevelCalls: Array<string | undefined> = [];
	private readonly config: PlanModelConfig | null;
	private current: ModelRef | undefined;
	private thinking: string | undefined;
	private streaming: boolean;
	private readonly rejectSwitch: boolean;

	constructor(opts: FakePlanModelOptions) {
		this.config = opts.config;
		this.current = opts.current;
		this.thinking = opts.currentThinking;
		this.streaming = opts.streaming ?? false;
		this.rejectSwitch = opts.rejectSwitch ?? false;
	}

	getConfig(): PlanModelConfig | null {
		return this.config;
	}

	currentModel(): ModelRef | undefined {
		return this.current;
	}

	currentThinking(): string | undefined {
		return this.thinking;
	}

	isStreaming(): boolean {
		return this.streaming;
	}

	async setModelTemporary(model: ModelRef, thinking?: string): Promise<void> {
		this.setModelTemporaryCalls.push({ model, ...(thinking !== undefined ? { thinking } : {}) });
		if (this.rejectSwitch) {
			throw new Error("simulated model switch failure");
		}
		this.current = model;
		this.thinking = thinking;
	}

	setThinkingLevel(thinking: string | undefined): void {
		this.setThinkingLevelCalls.push(thinking);
		this.thinking = thinking;
	}

	/** Flip the streaming flag to simulate a stream starting/ending. */
	setStreaming(value: boolean): void {
		this.streaming = value;
	}
}

function collect(bridge: PlanModeBridge): {
	frames: PlanModeFrame[];
	nextExecution: (status: PlanExecutionFrame["status"]) => Promise<PlanExecutionFrame>;
	nextProposal: () => Promise<PlanProposedFrame>;
	unsub: () => void;
} {
	const frames: PlanModeFrame[] = [];
	const proposalWaiters = new Set<(frame: PlanProposedFrame) => void>();
	const executionWaiters = new Set<{
		status: PlanExecutionFrame["status"];
		resolve: (frame: PlanExecutionFrame) => void;
	}>();
	const unsub = bridge.subscribeFrames((frame) => {
		frames.push(frame);
		if (frame.type === "plan_proposed") {
			for (const resolve of proposalWaiters) resolve(frame);
			proposalWaiters.clear();
			return;
		}
		if (frame.type !== "plan_execution_changed") return;
		for (const waiter of executionWaiters) {
			if (waiter.status !== frame.status) continue;
			waiter.resolve(frame);
			executionWaiters.delete(waiter);
		}
	});
	return {
		frames,
		async nextExecution(status) {
			const existing = frames.find(
				(frame): frame is PlanExecutionFrame => frame.type === "plan_execution_changed" && frame.status === status,
			);
			if (existing) return existing;
			const { promise, resolve } = Promise.withResolvers<PlanExecutionFrame>();
			executionWaiters.add({ status, resolve });
			return promise;
		},
		async nextProposal() {
			const existing = frames.find((frame): frame is PlanProposedFrame => frame.type === "plan_proposed");
			if (existing) return existing;
			const { promise, resolve } = Promise.withResolvers<PlanProposedFrame>();
			proposalWaiters.add(resolve);
			return promise;
		},
		unsub,
	};
}

type ResolveAgentResult = {
	content: Array<{ type: "text"; text: string }>;
	details: {
		action: "apply" | "discard";
		reason: string;
		sourceToolName?: string;
		sourceResultDetails?: {
			planFilePath: string;
			finalPlanFilePath: string;
			title: string;
			planExists: boolean;
		};
	};
};

interface Harness {
	dir: string;
	planFile: string;
	session: StubSession;
	bridge: PlanModeBridge;
	frames: PlanModeFrame[];
	nextExecution: (status: PlanExecutionFrame["status"]) => Promise<PlanExecutionFrame>;
	nextProposal: () => Promise<PlanProposedFrame>;
	openFrames: ServerFrame[]; // for assertions on the wire-level types
	cleanup: () => Promise<void>;
}

async function makeHarness(planModel?: PlanModelController): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-mode-bridge-test-"));
	// The SDK's `local://` resolver scopes paths to `<artifactsDir>/local/`.
	const localDir = path.join(dir, "local");
	await fs.mkdir(localDir, { recursive: true });
	const session = new StubSession();
	const bridge = new PlanModeBridge({
		sessionId: "s_test",
		session,
		getArtifactsDir: () => dir,
		getSessionId: () => "s_test",
		...(planModel ? { planModel } : {}),
	});
	const { frames, nextExecution, nextProposal } = collect(bridge);
	return {
		dir,
		planFile: path.join(localDir, "PLAN.md"),
		session,
		bridge,
		frames,
		nextProposal,
		nextExecution,
		openFrames: frames as unknown as ServerFrame[],
		async cleanup() {
			// Await the exit so the bridge's internal awaits drain before the
			// next test starts — `dispose()` fires `void exit()` which is fine
			// for real shutdown but leaks microtasks under bun's fast loop.
			await bridge.exit("session_disposed");
			bridge.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

async function invokeApply(h: Harness, input: { reason?: string; extra?: Record<string, unknown> } = {}): Promise<{
	resultPromise: Promise<ResolveAgentResult>;
}> {
	expect(h.session.standingHandler).not.toBeNull();
	const handler = h.session.standingHandler!;
	const params = {
		action: "apply" as const,
		reason: input.reason ?? "plan ready",
		...(input.extra ? { extra: input.extra } : {}),
	};
	const resultPromise = handler(params) as Promise<ResolveAgentResult>;
	// Don't let bun flag this as an unhandled rejection while the caller is
	// still chaining off it — the test attaches its own assertions later.
	resultPromise.catch(() => {});
	await h.nextProposal();
	return { resultPromise };
}

describe("PlanModeBridge", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await makeHarness();
	});

	afterEach(async () => {
		await harness.cleanup();
	});

	it("enter() snapshots tools, splices in resolve, and broadcasts plan_mode_changed", async () => {
		const previousTools = harness.session.getActiveToolNames();
		expect(previousTools.includes("resolve")).toBe(false);

		await harness.bridge.enter();

		expect(harness.session.getActiveToolNames()).toEqual([...previousTools, "resolve"]);
		expect(harness.session.planModeStateCalls).toEqual([
			{ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" },
		]);
		expect(harness.session.standingHandler).toBeTypeOf("function");
		expect(harness.frames).toEqual([
			{
				type: "plan_mode_changed",
				sessionId: "s_test",
				enabled: true,
				planFilePath: "local://PLAN.md",
			},
		]);
		expect(harness.bridge.isEnabled()).toBe(true);
		expect(harness.bridge.getPlanModeContext()).toEqual({
			enabled: true,
			planFilePath: "local://PLAN.md",
		});
	});

	it("enter() is idempotent — second call is a no-op", async () => {
		await harness.bridge.enter();
		const framesAfterFirst = harness.frames.length;
		const stateCallsAfterFirst = harness.session.planModeStateCalls.length;

		await harness.bridge.enter();

		expect(harness.frames.length).toBe(framesAfterFirst);
		expect(harness.session.planModeStateCalls.length).toBe(stateCallsAfterFirst);
	});

	it("does not duplicate resolve when it is already in the active tool set", async () => {
		const session = new StubSession(["read", "resolve"]);
		const bridge = new PlanModeBridge({
			sessionId: "s_with_resolve",
			session,
			getArtifactsDir: () => harness.dir,
			getSessionId: () => "s_with_resolve",
		});
		await bridge.enter();
		expect(session.getActiveToolNames()).toEqual(["read", "resolve"]);
		bridge.dispose();
	});

	it("exit() restores tools, clears SDK state, broadcasts off, and is idempotent", async () => {
		await harness.bridge.enter();
		const previousTools = harness.session
			.getActiveToolNames()
			.filter((t) => t !== "resolve");
		await harness.bridge.exit("user_cancelled");

		expect(harness.session.getActiveToolNames()).toEqual(previousTools);
		expect(harness.session.standingHandler).toBeNull();
		// First non-undefined state was the enter state; second was undefined on exit.
		expect(harness.session.planModeStateCalls.at(-1)).toBeUndefined();
		expect(harness.frames.at(-1)).toEqual({
			type: "plan_mode_changed",
			sessionId: "s_test",
			enabled: false,
		});
		expect(harness.bridge.isEnabled()).toBe(false);

		// Second exit is a no-op.
		const framesAfter = harness.frames.length;
		await harness.bridge.exit("user_cancelled");
		expect(harness.frames.length).toBe(framesAfter);
	});

	it("apply throws a ToolError when plan-mode is no longer active", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Title\n");
		// Toggle off the SDK-tracked state directly to simulate a race
		// (the bridge `enabled` flag was set by enter() above).
		harness.session.planModeStateCalls.push(undefined);
		await harness.bridge.exit("user_cancelled");

		const handler = harness.session.standingHandlerCalls.find((h) => h !== null) ?? null;
		expect(handler).not.toBeNull();
		await expect(handler!({ action: "apply", reason: "ready" })).rejects.toThrow(/plan mode/i);
	});

	it("apply throws a ToolError when the plan file is missing", async () => {
		await harness.bridge.enter();
		// No PLAN.md written.
		const handler = harness.session.standingHandler!;
		await expect(handler({ action: "apply", reason: "ready" })).rejects.toThrow(/Plan file not found/i);
	});

	it("approve without executionStrategy preserves the keep-context handoff", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# My feature\n\nDo a thing.\n");

		const initialFrameCount = harness.frames.length;
		const { resultPromise } = await invokeApply(harness, {
			extra: { title: "My feature" },
		});

		// Proposal broadcast should have arrived synchronously inside the apply.
		const proposedFrame = harness.frames.find((f) => f.type === "plan_proposed");
		expect(proposedFrame).toBeDefined();
		const proposed = proposedFrame as Extract<PlanModeFrame, { type: "plan_proposed" }>;
		expect(proposed.suggestedTitle).toBe("My-feature");
		expect(proposed.suggestedFinalPath).toBe("local://My-feature.md");
		expect(proposed.planContent).toMatch(/Do a thing/);

		// Pending approval is exposed for snapshot replay.
		const pending = harness.bridge.getPendingPlanApproval();
		expect(pending?.proposalId).toBe(proposed.proposalId);
		const replay = harness.bridge.getReplayFrames();
		expect(replay.map((f) => f.type as string).sort()).toEqual(
			["plan_mode_changed", "plan_proposed"].sort(),
		);

		// User clicks Approve.
		const outcome = harness.bridge.respond(proposed.proposalId, { approved: true });
		expect(outcome).toBe("settled");

		const result = await resultPromise;
		expect(harness.session.compactCalls).toBe(0);
		expect(result.details.action).toBe("apply");
		expect(result.details.sourceToolName).toBe("plan_approval");
		expect(result.details.sourceResultDetails?.planFilePath).toBe("local://PLAN.md");
		expect(result.details.sourceResultDetails?.planExists).toBe(true);

		// Plan file stays at original path — the SDK no longer renames on approval.
		await expect(fs.access(harness.planFile)).resolves.toBeNull();

		// Tools restored.
		const lastSet = harness.session.setActiveToolsCalls.at(-1);
		expect(lastSet?.includes("resolve")).toBe(false);

		// Standing handler cleared.
		expect(harness.session.standingHandler).toBeNull();

		// Plan mode exited.
		expect(harness.bridge.isEnabled()).toBe(false);
		expect(harness.bridge.hasPendingApproval()).toBe(false);

		// Synthetic execute-prompt queued as followUp.
		expect(harness.session.promptCalls.length).toBe(1);
		const queued = harness.session.promptCalls[0]!;
		expect(queued.text).toMatch(/Plan approved\. You MUST execute it now\./);
		expect(queued.text).toMatch(/local:\/\/PLAN\.md/);
		expect(queued.options?.streamingBehavior).toBe("followUp");

		// Marker for the SDK that the post-approval reference has been emitted.
		expect(harness.session.markPlanReferenceSentCount).toBe(1);

		// The mode exit precedes the direct handoff's dispatched event.
		expect(harness.frames).toContainEqual({
			type: "plan_mode_changed",
			sessionId: "s_test",
			enabled: false,
		});
		const resolvedFrame = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposal_resolved" }> =>
				f.type === "plan_proposal_resolved",
		);
		expect(resolvedFrame?.outcome).toBe("approved");
		// And there were strictly more frames after approval than before.
		expect(harness.frames.length).toBeGreaterThan(initialFrameCount);
	});

	it("compact_context compacts before directly dispatching execution when the session is idle", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Compact me\n\nExecute after compaction.\n");
		const compaction = harness.session.deferCompaction();
		const { resultPromise } = await invokeApply(harness);
		const proposed = await harness.nextProposal();

		const executionPrompt = harness.session.waitForPrompt();
		expect(
			harness.bridge.respond(proposed.proposalId, { approved: true, executionStrategy: "compact_context" }),
		).toBe("settled");
		await harness.session.waitForCompaction();
		await resultPromise;

		expect(harness.session.compactCalls).toBe(1);
		expect(harness.session.promptCalls).toHaveLength(0);
		expect(harness.session.setPlanReferencePathCalls).toEqual(["local://PLAN.md"]);
		expect(harness.session.markPlanInternalAbortPendingCount).toBe(1);
		expect(harness.frames).toContainEqual({
			type: "plan_execution_changed",
			sessionId: "s_test",
			proposalId: proposed.proposalId,
			planFilePath: "local://PLAN.md",
			status: "compacting",
		});

		harness.session.isStreaming = false;
		const dispatched = harness.nextExecution("dispatched");
		compaction.resolve();
		await executionPrompt;
		await dispatched;

		expect(harness.session.promptCalls).toHaveLength(1);
		expect(harness.session.promptCalls[0]).toEqual({
			text: expect.stringContaining("Plan approved. You MUST execute it now."),
		});
		expect(harness.bridge.getPendingPlanExecution()).toBeUndefined();
	});

	it("enter() remains blocked while a compacted execution prompt is dispatching", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Compact me\n\nExecute after compaction.\n");
		const compaction = harness.session.deferCompaction();
		const prompt = harness.session.deferPrompt();
		const { resultPromise } = await invokeApply(harness);
		const proposed = await harness.nextProposal();
		const dispatched = harness.nextExecution("dispatched");

		expect(
			harness.bridge.respond(proposed.proposalId, { approved: true, executionStrategy: "compact_context" }),
		).toBe("settled");
		await harness.session.waitForCompaction();
		await resultPromise;

		harness.session.isStreaming = false;
		compaction.resolve();
		await harness.session.waitForPrompt();

		expect(harness.bridge.getPendingPlanExecution()?.status).toBe("dispatching");
		await expect(harness.bridge.enter()).rejects.toThrow(
			"Finish or recover the approved plan execution before entering Plan Mode again.",
		);

		prompt.resolve();
		await dispatched;
		expect(harness.bridge.getPendingPlanExecution()).toBeUndefined();

		await harness.bridge.enter();
		expect(harness.bridge.isEnabled()).toBe(true);
	});

	it("enter() refuses to restore restricted Plan Mode tools while compaction is in progress", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Compact me\n");
		const compaction = harness.session.deferCompaction();
		const { resultPromise } = await invokeApply(harness);
		const proposed = await harness.nextProposal();

		expect(
			harness.bridge.respond(proposed.proposalId, { approved: true, executionStrategy: "compact_context" }),
		).toBe("settled");
		await harness.session.waitForCompaction();
		await resultPromise;

		expect(harness.session.getActiveToolNames()).not.toContain("resolve");
		await expect(harness.bridge.enter()).rejects.toThrow(
			"Finish or recover the approved plan execution before entering Plan Mode again.",
		);
		expect(harness.session.getActiveToolNames()).not.toContain("resolve");

		harness.session.isStreaming = false;
		compaction.resolve();
		await harness.session.waitForPrompt();
	});

	it("enter() refuses to restore restricted Plan Mode tools while compaction recovery is pending", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Compact me\n");
		const compaction = harness.session.deferCompaction();
		const { resultPromise } = await invokeApply(harness);
		const proposed = await harness.nextProposal();
		const failed = harness.nextExecution("compact_failed");

		harness.bridge.respond(proposed.proposalId, { approved: true, executionStrategy: "compact_context" });
		await harness.session.waitForCompaction();
		await resultPromise;
		compaction.reject(new Error("compaction backend failed"));
		await failed;

		expect(harness.session.getActiveToolNames()).not.toContain("resolve");
		await expect(harness.bridge.enter()).rejects.toThrow(
			"Finish or recover the approved plan execution before entering Plan Mode again.",
		);
		expect(harness.session.getActiveToolNames()).not.toContain("resolve");

		harness.session.isStreaming = false;
		await expect(harness.bridge.actOnPendingPlanExecution(proposed.proposalId)).resolves.toBe("settled");
	});

	it("cancelled compaction does not enqueue execution and leaves one atomic recovery action", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Compact me\n");
		const compaction = harness.session.deferCompaction();
		const { resultPromise } = await invokeApply(harness);
		const proposed = await harness.nextProposal();

		const recoveryPrompt = harness.session.waitForPrompt();
		harness.bridge.respond(proposed.proposalId, { approved: true, executionStrategy: "compact_context" });
		await harness.session.waitForCompaction();
		await resultPromise;
		const cancelled = harness.nextExecution("compact_cancelled");
		const cancellationError = new Error("compaction cancelled");
		cancellationError.name = "CompactionCancelledError";
		compaction.reject(cancellationError);
		await cancelled;

		expect(harness.session.promptCalls).toHaveLength(0);
		expect(harness.frames).toContainEqual({
			type: "plan_execution_changed",
			sessionId: "s_test",
			proposalId: proposed.proposalId,
			planFilePath: "local://PLAN.md",
			status: "compact_cancelled",
		});
		expect(harness.bridge.getPendingPlanExecution()?.proposalId).toBe(proposed.proposalId);

		harness.session.isStreaming = false;
		await Promise.all([
			harness.bridge.actOnPendingPlanExecution(proposed.proposalId),
			harness.bridge.actOnPendingPlanExecution(proposed.proposalId),
		]);
		await recoveryPrompt;
		expect(harness.session.compactCalls).toBe(1);
		expect(harness.session.promptCalls).toHaveLength(1);
		expect(harness.bridge.getPendingPlanExecution()).toBeUndefined();
	});

	it("failed compaction does not enqueue execution and retains a recoverable pending execution", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Compact me\n");
		const compaction = harness.session.deferCompaction();
		const { resultPromise } = await invokeApply(harness);
		const proposed = await harness.nextProposal();

		const recoveryPrompt = harness.session.waitForPrompt();
		harness.bridge.respond(proposed.proposalId, { approved: true, executionStrategy: "compact_context" });
		await harness.session.waitForCompaction();
		await resultPromise;
		const failed = harness.nextExecution("compact_failed");
		compaction.reject(new Error("compaction backend failed"));
		await failed;

		expect(harness.session.promptCalls).toHaveLength(0);
		expect(harness.frames).toContainEqual({
			type: "plan_execution_changed",
			sessionId: "s_test",
			proposalId: proposed.proposalId,
			planFilePath: "local://PLAN.md",
			status: "compact_failed",
			error: "compaction backend failed",
		});
		expect(harness.bridge.getPendingPlanExecution()?.proposalId).toBe(proposed.proposalId);

		harness.session.isStreaming = false;
		await harness.bridge.actOnPendingPlanExecution(proposed.proposalId);
		await recoveryPrompt;
		expect(harness.session.promptCalls).toHaveLength(1);
		expect(harness.bridge.getPendingPlanExecution()).toBeUndefined();
	});

	it("retries a prompt failure after compaction with compacted-context guidance", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Compact me\n\nExecute after compaction.\n");
		const compaction = harness.session.deferCompaction();
		const { resultPromise } = await invokeApply(harness);
		const proposed = await harness.nextProposal();
		const failed = harness.nextExecution("compact_failed");

		harness.bridge.respond(proposed.proposalId, { approved: true, executionStrategy: "compact_context" });
		await harness.session.waitForCompaction();
		await resultPromise;
		harness.session.nextPromptError = new Error("follow-up queue unavailable");
		harness.session.isStreaming = false;
		compaction.resolve();
		await failed;

		expect(harness.bridge.getPendingPlanExecution()?.proposalId).toBe(proposed.proposalId);
		await expect(harness.bridge.actOnPendingPlanExecution(proposed.proposalId)).resolves.toBe("settled");
		expect(harness.session.promptCalls).toHaveLength(2);
		expect(harness.session.promptCalls[1]?.text).toContain("Context was compacted.");
		expect(harness.session.promptCalls[1]?.text).not.toContain("Context preserved.");
	});

	it("two tabs approving compact_context start only one compaction and one execution", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Compact me\n");
		const compaction = harness.session.deferCompaction();
		const { resultPromise } = await invokeApply(harness);
		const proposed = await harness.nextProposal();
		const response = { approved: true as const, executionStrategy: "compact_context" as const };

		const executionPrompt = harness.session.waitForPrompt();
		expect(harness.bridge.respond(proposed.proposalId, response)).toBe("settled");
		expect(harness.bridge.respond(proposed.proposalId, response)).toBe("unknown");
		await harness.session.waitForCompaction();
		expect(harness.session.compactCalls).toBe(1);
		await resultPromise;

		harness.session.isStreaming = false;
		compaction.resolve();
		await executionPrompt;
		expect(harness.session.promptCalls).toHaveLength(1);
	});

	it("approve with edited content writes back to plan file", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Orig\n");

		const { resultPromise } = await invokeApply(harness, {
			extra: { title: "Edited plan" },
		});
		const proposed = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed",
		)!;
		harness.bridge.respond(proposed.proposalId, {
			approved: true,
			editedContent: "# Replaced\n\nNew body.\n",
		});
		await resultPromise;

		// Plan file stays at original path — the SDK no longer renames on approval.
		const updated = await fs.readFile(harness.planFile, "utf-8");
		expect(updated).toBe("# Replaced\n\nNew body.\n");
		expect(harness.session.promptCalls[0]!.text).toMatch(/New body\./);
	});

	it("approve ignores client-supplied finalPath (SDK no longer renames)", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Whatever\n");

		const { resultPromise } = await invokeApply(harness);
		const proposed = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed",
		)!;
		harness.bridge.respond(proposed.proposalId, {
			approved: true,
			finalPath: "local://custom_name.md",
		});
		const result = await resultPromise;
		// Plan file stays at original path; finalPath is no longer honored.
		expect(result.details.sourceResultDetails?.planFilePath).toBe("local://PLAN.md");
		await expect(fs.access(harness.planFile)).resolves.toBeNull();
	});

	it("reject path exits plan mode, broadcasts rejected resolution, and surfaces a rejection result", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Foo\n");

		const { resultPromise } = await invokeApply(harness);
		const proposed = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed",
		)!;
		harness.bridge.respond(proposed.proposalId, { approved: false });
		const result = await resultPromise;

		expect(result.content[0]!.text).toMatch(/User rejected the plan/i);
		expect(harness.bridge.isEnabled()).toBe(false);
		expect(harness.session.promptCalls.length).toBe(0);
		expect(harness.session.markPlanReferenceSentCount).toBe(0);
		const resolvedFrame = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposal_resolved" }> =>
				f.type === "plan_proposal_resolved",
		);
		expect(resolvedFrame?.outcome).toBe("rejected");
		// PLAN.md still exists (no rename on reject).
		await expect(fs.access(harness.planFile)).resolves.toBeNull();
	});

	it("respond() returns 'unknown' for stale / mismatched proposalIds (double-click safety)", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Hi\n");

		const { resultPromise } = await invokeApply(harness);
		const proposed = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed",
		)!;

		// Wrong id.
		expect(harness.bridge.respond("pa_bogus_99", { approved: true })).toBe("unknown");

		// Correct id wins.
		expect(harness.bridge.respond(proposed.proposalId, { approved: true })).toBe("settled");
		await resultPromise;

		// Second click on the same (now-resolved) id is unknown.
		expect(harness.bridge.respond(proposed.proposalId, { approved: true })).toBe("unknown");
	});

	it("exit() mid-approval rejects the pending promise so the standing handler fails cleanly", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Hi\n");

		const { resultPromise } = await invokeApply(harness);
		expect(harness.bridge.hasPendingApproval()).toBe(true);

		await harness.bridge.exit("user_cancelled");

		await expect(resultPromise).rejects.toThrow(/cancelled|user/i);
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.bridge.isEnabled()).toBe(false);
		const resolvedFrame = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposal_resolved" }> =>
				f.type === "plan_proposal_resolved",
		);
		expect(resolvedFrame?.outcome).toBe("rejected");
	});

	it("dispose() while approval is pending rejects the promise and clears state", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Hi\n");
		const { resultPromise } = await invokeApply(harness);

		harness.bridge.dispose();
		await expect(resultPromise).rejects.toThrow(/abandoned|disposed/i);
		expect(harness.bridge.hasPendingApproval()).toBe(false);
	});

	it("dispose() catches and logs an asynchronous exit failure", async () => {
		await harness.bridge.enter();
		const originalSetStandingResolveHandler = harness.session.setStandingResolveHandler;
		const failure = new Error("standing handler cleanup failed");
		harness.session.setStandingResolveHandler = () => {
			throw failure;
		};
		const logged = Promise.withResolvers<void>();
		const logSpy = spyOn(console, "log").mockImplementation((message: unknown, error: unknown) => {
			if (typeof message === "string" && message.includes("plan mode disposal failed for s_test")) {
				expect(error).toBe(failure);
				logged.resolve();
			}
		});

		try {
			harness.bridge.dispose();
			await logged.promise;
		} finally {
			logSpy.mockRestore();
			harness.session.setStandingResolveHandler = originalSetStandingResolveHandler;
		}
	});

	it("snapshot replay frames cover both mode-changed and pending proposal", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Yo\n");

		// Before any proposal: only the mode-changed replay.
		expect(harness.bridge.getReplayFrames().map((f) => f.type)).toEqual(["plan_mode_changed"]);

		const { resultPromise } = await invokeApply(harness);
		const replay = harness.bridge.getReplayFrames();
		expect(replay.map((f) => f.type as string).sort()).toEqual(
			["plan_mode_changed", "plan_proposed"].sort(),
		);

		// Tear down without resolving so the test exits cleanly.
		harness.bridge.dispose();
		await expect(resultPromise).rejects.toThrow();
	});
});

describe("PlanModeBridge plan-role model", () => {
	const CURRENT: ModelRef = { provider: "anthropic", id: "claude-sonnet" };
	const PLAN: ModelRef = { provider: "openai", id: "gpt-plan" };

	let harness: Harness | undefined;

	afterEach(async () => {
		if (harness) await harness.cleanup();
		harness = undefined;
	});

	it("enter switches to the plan model and reports the override + persistent model", async () => {
		const fake = new FakePlanModel({
			config: { provider: PLAN.provider, id: PLAN.id, thinking: "high" },
			current: CURRENT,
			currentThinking: "medium",
			streaming: false,
		});
		harness = await makeHarness(fake);

		await harness.bridge.enter();

		// Switched once to the plan model + its thinking; no thinking-only path.
		expect(fake.setModelTemporaryCalls).toEqual([{ model: PLAN, thinking: "high" }]);
		expect(fake.setThinkingLevelCalls).toEqual([]);
		// Effective override is live (pending:false).
		expect(harness.bridge.getPlanModeContext()).toEqual({
			enabled: true,
			planFilePath: "local://PLAN.md",
			modelOverride: { model: PLAN, thinking: "high", pending: false },
		});
		// The broadcast frame advertises the same override.
		expect(harness.frames.at(-1)).toEqual({
			type: "plan_mode_changed",
			sessionId: "s_test",
			enabled: true,
			planFilePath: "local://PLAN.md",
			modelOverride: { model: PLAN, thinking: "high", pending: false },
		});
		// Snapshot keeps reporting the user's pre-plan model.
		expect(harness.bridge.getPersistentModelState()).toEqual({
			model: CURRENT,
			thinking: "medium",
		});
	});

	it("defers the switch while streaming, then flush applies it and broadcasts the override", async () => {
		const fake = new FakePlanModel({
			config: { provider: PLAN.provider, id: PLAN.id, thinking: "high" },
			current: CURRENT,
			currentThinking: "medium",
			streaming: true,
		});
		harness = await makeHarness(fake);

		await harness.bridge.enter();

		// Streaming on enter: the switch is queued, not applied.
		expect(fake.setModelTemporaryCalls).toEqual([]);
		expect(harness.bridge.getPlanModeContext()?.modelOverride).toEqual({
			model: PLAN,
			thinking: "high",
			pending: true,
		});
		expect(harness.frames.at(-1)).toEqual({
			type: "plan_mode_changed",
			sessionId: "s_test",
			enabled: true,
			planFilePath: "local://PLAN.md",
			modelOverride: { model: PLAN, thinking: "high", pending: true },
		});

		const framesBeforeFlush = harness.frames.length;
		fake.setStreaming(false); // stream ended -> host calls flush on agent_end
		await harness.bridge.flushPendingModelSwitch();

		// Deferred switch is now applied exactly once and flipped to live.
		expect(fake.setModelTemporaryCalls).toEqual([{ model: PLAN, thinking: "high" }]);
		expect(harness.bridge.getPlanModeContext()?.modelOverride).toEqual({
			model: PLAN,
			thinking: "high",
			pending: false,
		});
		// Flush broadcasts a fresh frame flipping pending -> false.
		expect(harness.frames.length).toBe(framesBeforeFlush + 1);
		expect(harness.frames.at(-1)).toEqual({
			type: "plan_mode_changed",
			sessionId: "s_test",
			enabled: true,
			planFilePath: "local://PLAN.md",
			modelOverride: { model: PLAN, thinking: "high", pending: false },
		});
	});

	it("exit restores the persistent model when not streaming", async () => {
		const fake = new FakePlanModel({
			config: { provider: PLAN.provider, id: PLAN.id, thinking: "high" },
			current: CURRENT,
			currentThinking: "medium",
			streaming: false,
		});
		harness = await makeHarness(fake);

		await harness.bridge.enter();
		expect(fake.setModelTemporaryCalls).toEqual([{ model: PLAN, thinking: "high" }]);

		await harness.bridge.exit("user_cancelled");

		// Second call restores the ORIGINAL model + thinking.
		expect(fake.setModelTemporaryCalls).toEqual([
			{ model: PLAN, thinking: "high" },
			{ model: CURRENT, thinking: "medium" },
		]);
		expect(harness.bridge.getPlanModeContext()).toBeUndefined();
		expect(harness.bridge.getPersistentModelState()).toBeUndefined();
	});

	it("defers the restore while streaming and keeps showing the user's model until flush", async () => {
		const fake = new FakePlanModel({
			config: { provider: PLAN.provider, id: PLAN.id, thinking: "high" },
			current: CURRENT,
			currentThinking: "medium",
			streaming: false,
		});
		harness = await makeHarness(fake);

		await harness.bridge.enter(); // applied immediately (not streaming)
		expect(fake.setModelTemporaryCalls).toEqual([{ model: PLAN, thinking: "high" }]);

		fake.setStreaming(true); // a new stream is running when the user exits
		await harness.bridge.exit("user_cancelled");

		// Restore deferred: no restore call yet, snapshot still shows user's model.
		expect(fake.setModelTemporaryCalls).toEqual([{ model: PLAN, thinking: "high" }]);
		expect(harness.bridge.getPersistentModelState()).toEqual({
			model: CURRENT,
			thinking: "medium",
		});

		fake.setStreaming(false);
		await harness.bridge.flushPendingModelSwitch();

		// Now the restore is applied and the persistent snapshot is cleared.
		expect(fake.setModelTemporaryCalls).toEqual([
			{ model: PLAN, thinking: "high" },
			{ model: CURRENT, thinking: "medium" },
		]);
		expect(harness.bridge.getPersistentModelState()).toBeUndefined();
	});

	it("does not break plan mode when the model switch fails on enter", async () => {
		const fake = new FakePlanModel({
			config: { provider: PLAN.provider, id: PLAN.id, thinking: "high" },
			current: CURRENT,
			currentThinking: "medium",
			streaming: false,
			rejectSwitch: true,
		});
		harness = await makeHarness(fake);

		// A switch failure MUST NOT throw out of enter.
		await expect(harness.bridge.enter()).resolves.toBeUndefined();

		// Plan mode is still active, but nothing was applied -> no override.
		expect(harness.bridge.isEnabled()).toBe(true);
		expect(harness.bridge.getPlanModeContext()?.modelOverride).toBeUndefined();
		const callsAfterEnter = fake.setModelTemporaryCalls.length;
		expect(callsAfterEnter).toBe(1); // the one attempt that rejected

		// Exit has nothing to restore: no extra switch call, and it must not throw.
		await expect(harness.bridge.exit("user_cancelled")).resolves.toBeUndefined();
		expect(fake.setModelTemporaryCalls.length).toBe(callsAfterEnter);
	});

	it("restores the persistent model at most once across repeated exits", async () => {
		const fake = new FakePlanModel({
			config: { provider: PLAN.provider, id: PLAN.id, thinking: "high" },
			current: CURRENT,
			currentThinking: "medium",
			streaming: false,
		});
		harness = await makeHarness(fake);

		await harness.bridge.enter();
		await harness.bridge.exit("user_cancelled");
		await harness.bridge.exit("user_cancelled");

		const restoreCalls = fake.setModelTemporaryCalls.filter(
			(c) => c.model.provider === CURRENT.provider && c.model.id === CURRENT.id,
		);
		expect(restoreCalls).toHaveLength(1);
		expect(fake.setModelTemporaryCalls).toHaveLength(2); // 1 switch + 1 restore
	});

	it("adjusts thinking only when the plan model equals the current model", async () => {
		const fake = new FakePlanModel({
			config: { provider: CURRENT.provider, id: CURRENT.id, thinking: "high" },
			current: CURRENT,
			currentThinking: "medium",
			streaming: false,
		});
		harness = await makeHarness(fake);

		await harness.bridge.enter();

		// Same model, different thinking -> thinking-only change, never setModelTemporary.
		expect(fake.setThinkingLevelCalls).toEqual(["high"]);
		expect(fake.setModelTemporaryCalls).toEqual([]);
		expect(harness.bridge.getPlanModeContext()?.modelOverride).toEqual({
			model: CURRENT,
			thinking: "high",
			pending: false,
		});

		await harness.bridge.exit("user_cancelled");

		// Exit restores the original thinking level, still never touching the model.
		expect(fake.setThinkingLevelCalls).toEqual(["high", "medium"]);
		expect(fake.setModelTemporaryCalls).toEqual([]);
	});

	it("is inert (no override, no model calls) when no controller is supplied", async () => {
		harness = await makeHarness(); // no planModel

		await harness.bridge.enter();

		// Non-model plan behavior is unchanged.
		expect(harness.session.getActiveToolNames().includes("resolve")).toBe(true);
		expect(harness.session.standingHandler).toBeTypeOf("function");
		// Context and frame carry no modelOverride.
		expect(harness.bridge.getPlanModeContext()).toEqual({
			enabled: true,
			planFilePath: "local://PLAN.md",
		});
		expect(harness.frames.at(-1)).toEqual({
			type: "plan_mode_changed",
			sessionId: "s_test",
			enabled: true,
			planFilePath: "local://PLAN.md",
		});
		expect(harness.bridge.getPersistentModelState()).toBeUndefined();

		await harness.bridge.exit("user_cancelled");
		expect(harness.bridge.getPlanModeContext()).toBeUndefined();
	});

	it("is inert when the controller reports no configured plan model", async () => {
		const fake = new FakePlanModel({
			config: null,
			current: CURRENT,
			currentThinking: "medium",
			streaming: false,
		});
		harness = await makeHarness(fake);

		await harness.bridge.enter();

		// getConfig() === null -> feature off: no model calls at all.
		expect(fake.setModelTemporaryCalls).toEqual([]);
		expect(fake.setThinkingLevelCalls).toEqual([]);
		expect(harness.session.getActiveToolNames().includes("resolve")).toBe(true);
		expect(harness.bridge.getPlanModeContext()).toEqual({
			enabled: true,
			planFilePath: "local://PLAN.md",
		});
		expect(harness.bridge.getPersistentModelState()).toBeUndefined();

		await harness.bridge.exit("user_cancelled");
		expect(fake.setModelTemporaryCalls).toEqual([]);
		expect(fake.setThinkingLevelCalls).toEqual([]);
		expect(harness.bridge.getPlanModeContext()).toBeUndefined();
	});
});

describe("T-29: plan mode persistence and restore", () => {
	interface RestoreHarness {
		dir: string;
		planFile: string;
		session: StubSession;
		bridge: PlanModeBridge;
		frames: PlanModeFrame[];
		modeChanges: Array<{ mode: string; data?: Record<string, unknown> }>;
		cleanup: () => Promise<void>;
	}

	async function makeRestoreHarness(): Promise<RestoreHarness> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-mode-restore-test-"));
		const localDir = path.join(dir, "local");
		await fs.mkdir(localDir, { recursive: true });
		const session = new StubSession();
		const modeChanges: Array<{ mode: string; data?: Record<string, unknown> }> = [];
		const bridge = new PlanModeBridge({
			sessionId: "s_test",
			session,
			getArtifactsDir: () => dir,
			getSessionId: () => "s_test",
			persistModeChange: (mode, data) => {
				modeChanges.push({ mode, ...(data ? { data } : {}) });
			},
		});
		const { frames } = collect(bridge);
		return {
			dir,
			planFile: path.join(localDir, "PLAN.md"),
			session,
			bridge,
			frames,
			modeChanges,
			async cleanup() {
				await bridge.exit("session_disposed");
				bridge.dispose();
				await fs.rm(dir, { recursive: true, force: true });
			},
		};
	}

	/** Awaits the next broadcast frame of `type` — no wall-clock waits. */
	function nextFrameOfType<T extends PlanModeFrame["type"]>(
		bridge: PlanModeBridge,
		type: T,
	): Promise<Extract<PlanModeFrame, { type: T }>> {
		const { promise, resolve } = Promise.withResolvers<Extract<PlanModeFrame, { type: T }>>();
		const unsub = bridge.subscribeFrames((frame) => {
			if (frame.type !== type) return;
			unsub();
			resolve(frame as Extract<PlanModeFrame, { type: T }>);
		});
		return promise;
	}

	let h: RestoreHarness;

	beforeEach(async () => {
		h = await makeRestoreHarness();
	});

	afterEach(async () => {
		await h.cleanup();
	});

	it("enter() persists mode 'plan' and a user exit persists 'none'", async () => {
		await h.bridge.enter();
		expect(h.modeChanges).toEqual([{ mode: "plan", data: { planFilePath: "local://PLAN.md" } }]);

		await h.bridge.exit("user_cancelled");
		expect(h.modeChanges).toHaveLength(2);
		expect(h.modeChanges[1]).toEqual({ mode: "none" });
	});

	it("dispose() keeps the persisted plan mode so a later resume can restore it", async () => {
		await h.bridge.enter();
		await h.bridge.exit("session_disposed");
		h.bridge.dispose();

		expect(h.modeChanges).toEqual([{ mode: "plan", data: { planFilePath: "local://PLAN.md" } }]);
	});

	it("a live proposal writes a durable marker, and settling it clears the mode", async () => {
		await h.bridge.enter();
		await fs.writeFile(h.planFile, "# The plan\n\nDo the thing.\n", "utf-8");

		const proposed = nextFrameOfType(h.bridge, "plan_proposed");
		const resultPromise = h.session.standingHandler!({ action: "apply", reason: "plan ready" }) as Promise<unknown>;
		const frame = await proposed;

		const marker = h.modeChanges.at(-1);
		expect(marker?.mode).toBe("plan");
		expect(marker?.data).toEqual({
			planFilePath: "local://PLAN.md",
			proposal: {
				proposalId: frame.proposalId,
				suggestedTitle: frame.suggestedTitle,
				suggestedFinalPath: frame.suggestedFinalPath,
			},
		});

		expect(h.bridge.respond(frame.proposalId, { approved: false })).toBe("settled");
		await resultPromise;
		expect(h.modeChanges.at(-1)).toEqual({ mode: "none" });
	});

	it("restore() re-activates plan mode (tools, SDK state, handler, frame) without re-persisting", async () => {
		await h.bridge.restore({ planFilePath: "local://PLAN.md" });

		expect(h.bridge.isEnabled()).toBe(true);
		expect(h.session.getActiveToolNames()).toContain("resolve");
		expect(h.session.planModeStateCalls).toEqual([
			{ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" },
		]);
		expect(h.session.standingHandler).toBeTypeOf("function");
		expect(h.frames).toEqual([
			expect.objectContaining({ type: "plan_mode_changed", enabled: true, planFilePath: "local://PLAN.md" }),
		]);
		// Restore replays persisted state — it must not write a new entry.
		expect(h.modeChanges).toEqual([]);
	});

	it("restore() re-emits a pending proposal from the durable plan file", async () => {
		const planContent = "# Recovered plan\n\nSteps.\n";
		await fs.writeFile(h.planFile, planContent, "utf-8");

		await h.bridge.restore({
			planFilePath: "local://PLAN.md",
			proposal: { proposalId: "pa_s_test_3", suggestedTitle: "Recovered plan", suggestedFinalPath: "local://recovered-plan.md" },
		});

		expect(h.bridge.hasPendingApproval()).toBe(true);
		const proposed = h.frames.find((f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed");
		expect(proposed).toEqual({
			type: "plan_proposed",
			sessionId: "s_test",
			proposalId: "pa_s_test_3",
			planFilePath: "local://PLAN.md",
			planContent,
			suggestedTitle: "Recovered plan",
			suggestedFinalPath: "local://recovered-plan.md",
		});
		// The replay surface must carry the recovered proposal for late subscribers.
		expect(h.bridge.getReplayFrames()).toContainEqual(proposed!);
	});

	it("rejecting a recovered proposal resolves it and exits plan mode", async () => {
		await fs.writeFile(h.planFile, "# Plan\n", "utf-8");
		await h.bridge.restore({
			planFilePath: "local://PLAN.md",
			proposal: { proposalId: "pa_s_test_1", suggestedTitle: "Plan", suggestedFinalPath: "local://plan.md" },
		});

		const resolved = nextFrameOfType(h.bridge, "plan_proposal_resolved");
		const modeChanged = nextFrameOfType(h.bridge, "plan_mode_changed");
		expect(h.bridge.respond("pa_s_test_1", { approved: false })).toBe("settled");

		expect(await resolved).toEqual(
			expect.objectContaining({ proposalId: "pa_s_test_1", outcome: "rejected" }),
		);
		expect(await modeChanged).toEqual(expect.objectContaining({ enabled: false }));
		expect(h.bridge.isEnabled()).toBe(false);
		expect(h.modeChanges.at(-1)).toEqual({ mode: "none" });
	});

	it("approving a recovered proposal dispatches the execution prompt directly", async () => {
		const planContent = "# Plan\n\nShip it.\n";
		await fs.writeFile(h.planFile, planContent, "utf-8");
		await h.bridge.restore({
			planFilePath: "local://PLAN.md",
			proposal: { proposalId: "pa_s_test_2", suggestedTitle: "Plan", suggestedFinalPath: "local://plan.md" },
		});

		const dispatched = nextFrameOfType(h.bridge, "plan_execution_changed");
		expect(h.bridge.respond("pa_s_test_2", { approved: true })).toBe("settled");

		expect(await dispatched).toEqual(
			expect.objectContaining({ proposalId: "pa_s_test_2", status: "dispatched" }),
		);
		// The dead resolve-tool turn cannot dispatch — the bridge prompts directly.
		expect(h.session.promptCalls).toHaveLength(1);
		expect(h.session.promptCalls[0]?.text).toContain(planContent.trim());
		expect(h.bridge.isEnabled()).toBe(false);
		expect(h.modeChanges.at(-1)).toEqual({ mode: "none" });
	});

	it("restore() with the plan file gone keeps plan mode but drops and clears the orphan marker", async () => {
		await h.bridge.restore({
			planFilePath: "local://PLAN.md",
			proposal: { proposalId: "pa_s_test_9", suggestedTitle: "Gone", suggestedFinalPath: "local://gone.md" },
		});

		expect(h.bridge.isEnabled()).toBe(true);
		expect(h.bridge.hasPendingApproval()).toBe(false);
		expect(h.frames.some((f) => f.type === "plan_proposed")).toBe(false);
		// Marker cleared so the next resume doesn't re-drop the same orphan.
		expect(h.modeChanges).toEqual([{ mode: "plan", data: { planFilePath: "local://PLAN.md" } }]);
	});

	it("a failing restore falls back to normal mode and clears the persisted state", async () => {
		h.session.setActiveToolsByName = async () => {
			throw new Error("SDK tool wiring exploded");
		};

		await h.bridge.restore({ planFilePath: "local://PLAN.md" });

		expect(h.bridge.isEnabled()).toBe(false);
		expect(h.modeChanges).toEqual([{ mode: "none" }]);
	});
});
