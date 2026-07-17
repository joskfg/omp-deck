/**
 * Tests for the Auto Work execution engine (T-64).
 *
 * Two layers:
 *  - Pure decision logic (`checkAutoWorkPreflight`, `costFitsAutoWorkBudget`,
 *    `selectNextAutoWorkTask`, `resolveAutoWorkModel`,
 *    `resolveAutoWorkTimeoutMinutes`) — plain unit tests, no DB, no IO.
 *  - `runAutoWorkCycle` orchestrator — boots a real on-disk SQLite DB and a
 *    real git repo (so `git worktree add` actually runs) with a stub
 *    `AgentBridge` standing in for a live agent session. No real agent
 *    session is ever spun up.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AutoWorkConfig, AutoWorkGlobalConfig, ModelInfo, SessionSummary, Task, TaskDifficulty, TaskPriority } from "@omp-deck/protocol";

import type { AgentBridge, CreateSessionOpts, EventListener, SessionHandle } from "../bridge/types.ts";
import { broadcastBus } from "../broadcast-bus.ts";
import { DEFAULT_AUTO_WORK_VALUES, DEFAULT_MODEL_BY_DIFFICULTY, setAutoWorkConfig } from "../db/auto-work.ts";
import { DEFAULT_AUTO_WORK_GLOBAL } from "../db/auto-work-global.ts";
import { completeAutoWorkRun, getAutoWorkCostEstimate, listAutoWorkRuns, startAutoWorkRun } from "../db/auto-work-runs.ts";
import { closeDb, getDb, openDb } from "../db/index.ts";
import { setInternalTaskModel } from "../db/server-settings.ts";
import { createTask, getTask, moveTask } from "../db/tasks.ts";
import { AUTO_WORK_RULES_BODY, BRANCH_NAMING_RULES_BODY } from "../kb-templates.ts";
import type { AutoWorkNotificationEvent } from "./notify.ts";
import {
	appendAgentHistoryEntry,
	checkAutoWorkPreflight,
	classifyRunningAutoWorkRun,
	costFitsAutoWorkBudget,
	createPullRequestViaGh,
	decideSqueezeTiming,
	extractAgentHistory,
	generateBranchSlugWithModel,
	reconcileAutoMergedRuns,
	reconcileInactiveAutoWorkRuns,
	resolveAutoWorkModel,
	resolveAutoWorkTimeoutMinutes,
	runAutoWorkCycle,
	runGlobalAutoWorkCycle,
	sanitizeBranchSlug,
	selectNextAutoWorkTask,
	shouldConsiderSqueeze,
	waitForAutoWorkSessionTerminal,
} from "./engine.ts";
import type { SqueezeDecisionInput } from "./engine.ts";
import { SensitiveContentError } from "./pr-content-guard.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<AutoWorkConfig> = {}): AutoWorkConfig {
	return {
		workspaceCwd: "/tmp/ws",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...DEFAULT_AUTO_WORK_VALUES,
		enabled: true,
		sessionPctLimit: 30,
		weeklyPctLimit: 80,
		...overrides,
	};
}

let taskSeq = 0;
function baseTask(overrides: Partial<Task> = {}): Task {
	taskSeq += 1;
	return {
		id: `t_${taskSeq}`,
		displayId: taskSeq,
		title: `Task ${taskSeq}`,
		body: "",
		stateId: "s_backlog",
		orderInState: taskSeq * 1000,
		priority: "P5",
		difficulty: "medium" as TaskDifficulty,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		stateEnteredAt: "2026-01-01T00:00:00.000Z",
		dependsOn: [],
		autoWork: true,
		...overrides,
	};
}

// ─── Pure decision logic ────────────────────────────────────────────────────

describe("checkAutoWorkPreflight", () => {
	test("rejects when auto-work is disabled", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig({ enabled: false }),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 10,
			sessionPctUsed: null,
			activeRuns: [],
		});
		expect(result).toEqual({ ok: false, reason: expect.stringContaining("disabled") });
	});

	test("rejects outside the configured time window", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig({ timeWindows: [{ start: 9, end: 17 }] }),
			now: new Date("2026-01-01T20:00:00"),
			subscriptionPctUsed: 10,
			sessionPctUsed: null,
			activeRuns: [],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("outside the configured run window");
	});

	test("accepts at the window's opening hour and rejects at the closing hour (half-open interval)", () => {
		const config = baseConfig({ timeWindows: [{ start: 9, end: 17 }] });
		const atOpen = checkAutoWorkPreflight({
			config,
			now: new Date("2026-01-01T09:00:00"),
			subscriptionPctUsed: 10,
			sessionPctUsed: null,
			activeRuns: [],
		});
		const atClose = checkAutoWorkPreflight({
			config,
			now: new Date("2026-01-01T17:00:00"),
			subscriptionPctUsed: 10,
			sessionPctUsed: null,
			activeRuns: [],
		});
		expect(atOpen.ok).toBe(true);
		expect(atClose.ok).toBe(false);
	});

	test("rejects when subscription usage is unavailable", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig(),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: null,
			sessionPctUsed: null,
			activeRuns: [],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("unavailable");
	});

	test("rejects when subscription usage is at or above the weekly limit", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig({ weeklyPctLimit: 80 }),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 80,
			sessionPctUsed: null,
			activeRuns: [],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("weekly limit");
	});

	test("rejects when another run is already active for the workspace (mutex)", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig(),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 10,
			sessionPctUsed: null,
			activeRuns: [
				{
					id: "awrun_1",
					taskId: "t_1",
					taskPriority: "P0",
					sessionId: "s1",
					worktreePath: "/x",
					startedAt: "2026-01-01T11:00:00.000Z",
					completedAt: null,
					status: "running",
					inputTokens: null,
					outputTokens: null,
					pctConsumed: null,
					failureReason: null,
					prNumber: null,
				},
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("already active");
	});

	test("ignores non-running historical runs for the mutex check", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig(),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 10,
			sessionPctUsed: null,
			activeRuns: [
				{
					id: "awrun_1",
					taskId: "t_1",
					taskPriority: "P0",
					sessionId: "s1",
					worktreePath: "/x",
					startedAt: "2026-01-01T11:00:00.000Z",
					completedAt: "2026-01-01T11:30:00.000Z",
					status: "completed",
					inputTokens: 1,
					outputTokens: 1,
					pctConsumed: 5,
					failureReason: null,
					prNumber: null,
				},
			],
		});
		expect(result).toEqual({ ok: true });
	});

	test("passes every check", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig(),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 10,
			sessionPctUsed: 50,
			activeRuns: [],
		});
		expect(result).toEqual({ ok: true });
	});

	test("rejects when session budget is fully exhausted (100%)", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig({ weeklyPctLimit: 80 }),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 20,
			sessionPctUsed: 100,
			activeRuns: [],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("session budget is fully exhausted");
	});

	test("allows a non-exhausted session even when close to full", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig({ weeklyPctLimit: 80 }),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 20,
			sessionPctUsed: 99,
			activeRuns: [],
		});
		expect(result).toEqual({ ok: true });
	});

	test("ignores session exhaustion when sessionPctUsed is null (unavailable)", () => {
		const result = checkAutoWorkPreflight({
			config: baseConfig(),
			now: new Date("2026-01-01T12:00:00"),
			subscriptionPctUsed: 20,
			sessionPctUsed: null,
			activeRuns: [],
		});
		expect(result).toEqual({ ok: true });
	});
});

describe("costFitsAutoWorkBudget", () => {
	test("rejects an estimate that alone exceeds sessionPctLimit", () => {
		const config = baseConfig({ sessionPctLimit: 20, weeklyPctLimit: 100 });
		expect(costFitsAutoWorkBudget(25, 0, config)).toBe(false);
	});

	test("rejects when adding the estimate to current usage crosses weeklyPctLimit", () => {
		const config = baseConfig({ sessionPctLimit: 100, weeklyPctLimit: 50 });
		expect(costFitsAutoWorkBudget(20, 40, config)).toBe(false);
	});

	test("accepts when both caps have room", () => {
		const config = baseConfig({ sessionPctLimit: 30, weeklyPctLimit: 80 });
		expect(costFitsAutoWorkBudget(20, 40, config)).toBe(true);
	});

	test("accepts exactly at either boundary", () => {
		const config = baseConfig({ sessionPctLimit: 20, weeklyPctLimit: 60 });
		expect(costFitsAutoWorkBudget(20, 40, config)).toBe(true);
	});
});

describe("selectNextAutoWorkTask", () => {
	const estimatesByPriority: Record<TaskPriority, number> = {
		P0: 25,
		P1: 15,
		P2: 10,
		P3: 5,
		P4: 5,
		P5: 5,
	};
	const estimateCostPct = (p: TaskPriority) => estimatesByPriority[p];

	test("returns none_eligible when nothing has autoWork set", () => {
		const tasks = [baseTask({ autoWork: false })];
		const result = selectNextAutoWorkTask({
			tasks,
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result).toEqual({ kind: "none_eligible" });
	});

	test("excludes a task whose dependency is not done", () => {
		const dep = baseTask({ id: "dep", stateId: "s_active" });
		const task = baseTask({ dependsOn: ["dep"] });
		const result = selectNextAutoWorkTask({
			tasks: [dep, task],
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result).toEqual({ kind: "none_eligible" });
	});

	test("includes a task once its dependency is done", () => {
		const dep = baseTask({ id: "dep", stateId: "s_done" });
		const task = baseTask({ dependsOn: ["dep"] });
		const result = selectNextAutoWorkTask({
			tasks: [dep, task],
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result.kind).toBe("selected");
		if (result.kind === "selected") expect(result.task.id).toBe(task.id);
	});

	test("sorts P0 before P1 regardless of orderInState", () => {
		const p1 = baseTask({ id: "p1", priority: "P1", orderInState: 1 });
		const p0 = baseTask({ id: "p0", priority: "P0", orderInState: 2 });
		// P0's own estimate (25) fits within default 30/80 limits.
		const result = selectNextAutoWorkTask({
			tasks: [p1, p0],
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result.kind).toBe("selected");
		if (result.kind === "selected") expect(result.task.id).toBe("p0");
	});

	test("breaks priority ties by orderInState ascending", () => {
		const later = baseTask({ id: "later", priority: "P2", orderInState: 2000 });
		const earlier = baseTask({ id: "earlier", priority: "P2", orderInState: 1000 });
		const result = selectNextAutoWorkTask({
			tasks: [later, earlier],
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result.kind).toBe("selected");
		if (result.kind === "selected") expect(result.task.id).toBe("earlier");
	});

	test("skips a P0 task that doesn't fit the budget and selects a P3 that does", () => {
		// sessionPctLimit=20 rejects P0's 25% estimate outright but accepts P3's 5%.
		const config = baseConfig({ sessionPctLimit: 20, weeklyPctLimit: 80 });
		const p0 = baseTask({ id: "p0", priority: "P0" });
		const p3 = baseTask({ id: "p3", priority: "P3" });
		const result = selectNextAutoWorkTask({
			tasks: [p0, p3],
			config,
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result.kind).toBe("selected");
		if (result.kind === "selected") expect(result.task.id).toBe("p3");
	});

	test("returns none_fit with the considered count when every eligible task exceeds budget", () => {
		const config = baseConfig({ sessionPctLimit: 1, weeklyPctLimit: 80 });
		const tasks = [baseTask({ priority: "P0" }), baseTask({ priority: "P3" })];
		const result = selectNextAutoWorkTask({
			tasks,
			config,
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result).toEqual({ kind: "none_fit", consideredCount: 2 });
	});

	test("ignores tasks outside the backlog column", () => {
		const tasks = [baseTask({ stateId: "s_active" })];
		const result = selectNextAutoWorkTask({
			tasks,
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
		});
		expect(result).toEqual({ kind: "none_eligible" });
	});
	test("pinned: selects exactly the pinned task even when a higher-priority task exists", () => {
		const p0 = baseTask({ priority: "P0" });
		const pinned = baseTask({ priority: "P5" });
		const result = selectNextAutoWorkTask({
			tasks: [p0, pinned],
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
			pinnedTaskId: pinned.id,
		});
		expect(result).toEqual({ kind: "selected", task: pinned, estimatedCostPct: 5 });
	});

	test("pinned: returns pinned_unavailable when the pinned task left the backlog", () => {
		const eligible = baseTask();
		const pinned = baseTask({ stateId: "s_active" });
		const result = selectNextAutoWorkTask({
			tasks: [eligible, pinned],
			config: baseConfig(),
			currentPctUsed: 0,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
			pinnedTaskId: pinned.id,
		});
		expect(result).toEqual({ kind: "pinned_unavailable" });
	});

	test("pinned: returns pinned_unavailable when the pinned task no longer fits the budget", () => {
		const pinned = baseTask({ priority: "P0" });
		const result = selectNextAutoWorkTask({
			tasks: [pinned],
			config: baseConfig(),
			currentPctUsed: 60,
			backlogStateId: "s_backlog",
			doneStateId: "s_done",
			estimateCostPct,
			pinnedTaskId: pinned.id,
		});
		expect(result).toEqual({ kind: "pinned_unavailable" });
	});
});

describe("resolveAutoWorkModel", () => {
	const noGlobal: AutoWorkGlobalConfig = {
		...DEFAULT_AUTO_WORK_GLOBAL,
		updatedAt: "2026-01-01T00:00:00.000Z",
	};

	test("returns workspace difficulty mapping for exact match", () => {
		const config = baseConfig({
			modelByDifficulty: {
				...DEFAULT_MODEL_BY_DIFFICULTY,
				hard: { provider: "anthropic", id: "claude-hard" },
			},
		});
		expect(resolveAutoWorkModel("hard", config, noGlobal, null)).toEqual({
			provider: "anthropic",
			id: "claude-hard",
		});
	});

	test("cascades to lower difficulty within workspace (hard→medium)", () => {
		const config = baseConfig({
			modelByDifficulty: {
				...DEFAULT_MODEL_BY_DIFFICULTY,
				medium: { provider: "anthropic", id: "claude-medium" },
			},
		});
		expect(resolveAutoWorkModel("hard", config, noGlobal, null)).toEqual({
			provider: "anthropic",
			id: "claude-medium",
		});
	});

	test("easy task does not cascade upward", () => {
		const config = baseConfig({
			modelByDifficulty: {
				...DEFAULT_MODEL_BY_DIFFICULTY,
				medium: { provider: "anthropic", id: "claude-medium" },
				hard: { provider: "anthropic", id: "claude-hard" },
			},
		});
		// easy has no mapping; hard/medium are above it — must not be used
		expect(resolveAutoWorkModel("easy", config, noGlobal, { provider: "anthropic", id: "ws-default" })).toEqual({
			provider: "anthropic",
			id: "ws-default",
		});
	});

	test("falls through to global mapping after exhausting workspace", () => {
		const config = baseConfig();
		const global: AutoWorkGlobalConfig = {
			...noGlobal,
			modelByDifficulty: {
				...DEFAULT_MODEL_BY_DIFFICULTY,
				medium: { provider: "openai", id: "gpt-global-medium" },
			},
		};
		expect(resolveAutoWorkModel("hard", config, global, null)).toEqual({
			provider: "openai",
			id: "gpt-global-medium",
		});
	});

	test("global cascade respects lower-difficulty-only direction", () => {
		const config = baseConfig();
		const global: AutoWorkGlobalConfig = {
			...noGlobal,
			modelByDifficulty: {
				...DEFAULT_MODEL_BY_DIFFICULTY,
				easy: { provider: "openai", id: "gpt-global-easy" },
			},
		};
		// hard task cascades to medium then easy in global
		expect(resolveAutoWorkModel("hard", config, global, null)).toEqual({
			provider: "openai",
			id: "gpt-global-easy",
		});
	});

	test("falls back to workspace default model when all maps are null", () => {
		expect(resolveAutoWorkModel("medium", baseConfig(), noGlobal, { provider: "anthropic", id: "ws-default" })).toEqual({
			provider: "anthropic",
			id: "ws-default",
		});
	});

	test("returns undefined when all maps null and no workspace default", () => {
		expect(resolveAutoWorkModel("easy", baseConfig(), noGlobal, null)).toBeUndefined();
	});
});

describe("resolveAutoWorkTimeoutMinutes", () => {
	test("reads the configured per-priority value", () => {
		const config = baseConfig({
			timeoutMinutesByPriority: { P0: 200, P1: 90, P2: 60, P3: 45, P4: 45, P5: 45 },
		});
		expect(resolveAutoWorkTimeoutMinutes("P0", config)).toBe(200);
		expect(resolveAutoWorkTimeoutMinutes("P3", config)).toBe(45);
	});
});

describe("classifyRunningAutoWorkRun", () => {
	const baseRun = {
		id: "awrun_1",
		taskId: "t_1",
		taskPriority: "P0" as const,
		sessionId: "sess_1",
		worktreePath: "/tmp/wt",
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: null,
		status: "running" as const,
		inputTokens: null,
		outputTokens: null,
		pctConsumed: null,
		failureReason: null,
		prNumber: null,
	};

	test("resumes when the session and its worktree both still exist", () => {
		expect(classifyRunningAutoWorkRun(baseRun, true, true)).toBe("resume");
	});

	test("reconnects when the session exists but the worktree is gone", () => {
		expect(classifyRunningAutoWorkRun(baseRun, true, false)).toBe("reconnect");
	});

	test("is stale when the session is gone, regardless of the worktree", () => {
		expect(classifyRunningAutoWorkRun(baseRun, false, true)).toBe("stale");
		expect(classifyRunningAutoWorkRun(baseRun, false, false)).toBe("stale");
	});
});

describe("shouldConsiderSqueeze", () => {
	const now = new Date("2026-01-01T00:00:00.000Z");

	test("true on the happy path: low usage, reset well within the 2-tick horizon, eligible work waiting", () => {
		expect(
			shouldConsiderSqueeze({
				now,
				scheduleIntervalMinutes: 15,
				sessionPct: 20,
				sessionResetAt: "2026-01-01T00:10:00.000Z", // 10 min out, horizon is 30 min
				eligibleWorkspaceCount: 2,
			}),
		).toBe(true);
	});

	for (const eligibleWorkspaceCount of [0, -1]) {
		test(`false when there is no eligible backlog work (eligibleWorkspaceCount=${eligibleWorkspaceCount}), even with every other condition favorable`, () => {
			expect(
				shouldConsiderSqueeze({
					now,
					scheduleIntervalMinutes: 15,
					sessionPct: 10,
					sessionResetAt: "2026-01-01T00:05:00.000Z",
					eligibleWorkspaceCount,
				}),
			).toBe(false);
		});
	}

	test("false when sessionPct is exactly at the ceiling (70)", () => {
		expect(
			shouldConsiderSqueeze({
				now,
				scheduleIntervalMinutes: 15,
				sessionPct: 70,
				sessionResetAt: "2026-01-01T00:10:00.000Z",
				eligibleWorkspaceCount: 2,
			}),
		).toBe(false);
	});

	test("true when sessionPct is just under the ceiling (69.9)", () => {
		expect(
			shouldConsiderSqueeze({
				now,
				scheduleIntervalMinutes: 15,
				sessionPct: 69.9,
				sessionResetAt: "2026-01-01T00:10:00.000Z",
				eligibleWorkspaceCount: 2,
			}),
		).toBe(true);
	});

	test("false when sessionResetAt has already passed", () => {
		expect(
			shouldConsiderSqueeze({
				now,
				scheduleIntervalMinutes: 15,
				sessionPct: 10,
				sessionResetAt: "2025-12-31T23:59:00.000Z",
				eligibleWorkspaceCount: 2,
			}),
		).toBe(false);
	});

	test("false when sessionResetAt equals now exactly (zero runway)", () => {
		expect(
			shouldConsiderSqueeze({
				now,
				scheduleIntervalMinutes: 15,
				sessionPct: 10,
				sessionResetAt: now.toISOString(),
				eligibleWorkspaceCount: 2,
			}),
		).toBe(false);
	});

	test("false when sessionResetAt is unparseable (Date.parse -> NaN)", () => {
		expect(
			shouldConsiderSqueeze({
				now,
				scheduleIntervalMinutes: 15,
				sessionPct: 10,
				sessionResetAt: "not-a-date",
				eligibleWorkspaceCount: 2,
			}),
		).toBe(false);
	});

	test("false exactly at the 2-tick horizon boundary (minutesToReset === scheduleIntervalMinutes * 2)", () => {
		// interval=10 -> horizon is exactly 20 minutes; the gate is strictly "<", so landing precisely on it must fail.
		expect(
			shouldConsiderSqueeze({
				now,
				scheduleIntervalMinutes: 10,
				sessionPct: 10,
				sessionResetAt: "2026-01-01T00:20:00.000Z",
				eligibleWorkspaceCount: 2,
			}),
		).toBe(false);
	});

	test("true just inside the 2-tick horizon boundary", () => {
		expect(
			shouldConsiderSqueeze({
				now,
				scheduleIntervalMinutes: 10,
				sessionPct: 10,
				sessionResetAt: "2026-01-01T00:19:59.000Z",
				eligibleWorkspaceCount: 2,
			}),
		).toBe(true);
	});

	test("false when the reset is comfortably beyond the 2-tick horizon, even with low usage and eligible work", () => {
		expect(
			shouldConsiderSqueeze({
				now,
				scheduleIntervalMinutes: 15,
				sessionPct: 5,
				sessionResetAt: "2026-01-01T02:00:00.000Z", // 120 min out, horizon is only 30
				eligibleWorkspaceCount: 3,
			}),
		).toBe(false);
	});

	for (const scheduleIntervalMinutes of [0, -5]) {
		test(`clamps a non-positive scheduleIntervalMinutes (${scheduleIntervalMinutes}) to a 1-minute floor instead of collapsing the horizon to zero`, () => {
			// Without the Math.max(1, …) clamp, a horizon of 0 (or negative) would
			// make this always false regardless of how soon the window resets.
			expect(
				shouldConsiderSqueeze({
					now,
					scheduleIntervalMinutes,
					sessionPct: 10,
					sessionResetAt: "2026-01-01T00:00:30.000Z", // 30s out, well under a clamped 2-minute horizon
					eligibleWorkspaceCount: 2,
				}),
			).toBe(true);
		});
	}
});

// ─── Orchestrator (real DB + real git worktree + stub bridge) ──────────────

const AVAILABLE_MODEL: ModelInfo = {
	provider: "anthropic",
	id: "claude-good",
	label: "Claude Good",
	isAvailable: true,
};

class FakeSessionHandle {
	readonly sessionId: string;
	private listeners = new Set<EventListener>();
	private readonly subscription = Promise.withResolvers<void>();
	readonly subscriptionStarted = this.subscription.promise;
	/** Resolves only the current turn, then resets for a subsequent internal or execution session. */
	private turnEnded = Promise.withResolvers<void>();
	/** Every prompt text sent through `prompt()`, in call order. */
	readonly prompts: string[] = [];
	/** Every title passed to `setName()`, in call order (T-94). */
	readonly setNameCalls: string[] = [];
	/** Number of `abort()` calls received. */
	abortCalls = 0;
	/** What `isStreamingNow()` reports — set true to model a resumed handle whose turn is still in flight. */
	streaming = false;
	/** Optional usage rollup to return from `snapshot()` — set before the cycle to simulate real token usage (T-80). */
	usageRollup?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };

	constructor(
		sessionId: string,
		private readonly terminalDelayMs: number | null,
		private readonly assistantResponse: string = "",
	) {
		this.sessionId = sessionId;
	}

	subscribe(listener: EventListener): () => void {
		this.listeners.add(listener);
		this.subscription.resolve();
		if (this.terminalDelayMs !== null) {
			setTimeout(() => this.emit({ type: "turn_end", message: { stopReason: "end_turn" } }), this.terminalDelayMs);
		}
		return () => this.listeners.delete(listener);
	}

	emit(event: Parameters<EventListener>[0]): void {
		for (const listener of this.listeners) listener(event);
		// A terminal event ends the current turn. Reset after resolving so the
		// same fake can model the selector/slug session followed by execution.
		if (event.type === "turn_end" || event.type === "agent_end") {
			this.turnEnded.resolve();
			this.turnEnded = Promise.withResolvers<void>();
		}
	}

	/** Resolves only once the turn ends — a never-terminal fake's prompt never resolves, exactly like the real bridge. */
	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		await this.turnEnded.promise;
	}

	async isStreamingNow(): Promise<boolean> {
		return this.streaming;
	}

	async abort(): Promise<void> {
		this.abortCalls += 1;
		this.turnEnded.resolve();
		this.turnEnded = Promise.withResolvers<void>();
	}

	/** T-100: the engine releases failed sessions — count calls so tests can assert cleanup. */
	disposeCalls = 0;

	async dispose(): Promise<void> {
		this.disposeCalls += 1;
	}

	/** T-94: records the title `maybeAutoTitleSession` applies via the shared session-title helper. */
	async setName(name: string): Promise<void> {
		this.setNameCalls.push(name);
	}

	/** Minimal snapshot stand-in — enough for `latestAssistantText` to read the configured response and for usage capture. */
	async snapshot(): Promise<{ messages: Array<{ role: string; content: unknown }>; usageRollup?: FakeSessionHandle["usageRollup"] }> {
		return { messages: [{ role: "assistant", content: this.assistantResponse }], usageRollup: this.usageRollup };
	}
}

function fakeBridge(
	handle: FakeSessionHandle,
	opts: {
		models?: ModelInfo[];
		createSessionCalls?: CreateSessionOpts[];
		/** Forces `createSession` to throw instead of returning `handle`, simulating a bridge/session-creation failure. */
		createSessionError?: Error;
		/** Records every `sessionId` passed to `deleteSession`, in call order. */
		deleteSessionCalls?: string[];
		/** Live in-process handles, keyed by sessionId — what `bridge.getSession` finds without a restart. */
		liveSessions?: Map<string, FakeSessionHandle>;
		/** Persisted (on-disk) session summaries `bridge.listSessions`/`resumeSession` can see across a restart. */
		persistedSessions?: SessionSummary[];
		/** T-94: response `bridge.generateTitle` resolves with — omit to leave it returning `null`, as if the model produced nothing usable. */
		titleResponse?: string;
		/** Every `generateTitle` request, in call order. */
		generateTitleCalls?: Parameters<AgentBridge["generateTitle"]>[0][];
	} = {},
): AgentBridge {
	const models = opts.models ?? [AVAILABLE_MODEL];
	return {
		async listModels() {
			return models;
		},
		async createSession(createOpts: CreateSessionOpts) {
			if (opts.createSessionError) throw opts.createSessionError;
			opts.createSessionCalls?.push(createOpts);
			return handle as unknown as SessionHandle;
		},
		getSession(sessionId: string) {
			return opts.liveSessions?.get(sessionId) as unknown as SessionHandle | undefined;
		},
		async listSessions(listOpts: { cwd?: string }) {
			const all = opts.persistedSessions ?? [];
			return listOpts.cwd ? all.filter((s) => s.cwd === listOpts.cwd) : all;
		},
		async resumeSession(resumeOpts: { sessionPath: string }) {
			const match = opts.persistedSessions?.find((s) => s.path === resumeOpts.sessionPath);
			if (!match) throw new Error(`no persisted session at ${resumeOpts.sessionPath}`);
			const resumedHandle = opts.liveSessions?.get(match.id);
			if (!resumedHandle) throw new Error(`no fake handle registered for persisted session ${match.id}`);
			return resumedHandle as unknown as SessionHandle;
		},
		async deleteSession(sessionId: string) {
			opts.deleteSessionCalls?.push(sessionId);
			return { deleted: true };
		},
		async generateTitle(request: Parameters<AgentBridge["generateTitle"]>[0]) {
			opts.generateTitleCalls?.push(request);
			return opts.titleResponse ?? null;
		},
	} as unknown as AgentBridge;
}

describe("waitForAutoWorkSessionTerminal", () => {
	for (const stopReason of ["aborted", "error", "max_tokens", "length", "refusal"]) {
		test(`classifies a turn ending with stopReason ${stopReason} as failed`, async () => {
			const handle = new FakeSessionHandle("sess_terminal", null);
			const terminal = waitForAutoWorkSessionTerminal(handle as unknown as SessionHandle, 60_000);

			handle.emit({ type: "turn_end", message: { stopReason } });

			expect(await terminal).toBe("failed");
		});
	}

	test("startTurn rejection settles the wait as failed", async () => {
		const handle = new FakeSessionHandle("sess_prompt_reject", null);
		const terminal = await waitForAutoWorkSessionTerminal(handle as unknown as SessionHandle, 60_000, () =>
			Promise.reject(new Error("prompt transport died")),
		);
		expect(terminal).toBe("failed");
	});

	test("startTurn resolution with no terminal event settles the wait as failed", async () => {
		const handle = new FakeSessionHandle("sess_prompt_resolves", null);
		const terminal = await waitForAutoWorkSessionTerminal(handle as unknown as SessionHandle, 60_000, async () => {});
		expect(terminal).toBe("failed");
	});

	test("a stopReason error event emitted just before the prompt resolves wins the race — failed, not completed", async () => {
		const handle = new FakeSessionHandle("sess_error_wins", null);
		const terminal = waitForAutoWorkSessionTerminal(handle as unknown as SessionHandle, 60_000, () => handle.prompt("go"));
		// Emitting the terminal event also resolves the in-flight prompt() (the
		// real contract); the event's precise stopReason must still win.
		handle.emit({ type: "turn_end", message: { stopReason: "error" } });
		expect(await terminal).toBe("failed");
	});

	test("turn_end arriving before prompt() resolves — the real-world ordering — settles as completed, not timed_out", async () => {
		const handle = new FakeSessionHandle("sess_event_first", null);
		// Short timeout on purpose: the pre-fix code (await prompt, then
		// subscribe) missed this event and could only ever time out here.
		const terminal = waitForAutoWorkSessionTerminal(handle as unknown as SessionHandle, 250, () => handle.prompt("go"));
		handle.emit({ type: "turn_end", message: { stopReason: "end_turn" } });
		expect(await terminal).toBe("completed");
	});

	test.each(["toolUse", "tool_use"])("ignores an intermediate %s turn_end until the terminal turn completes", async (stopReason) => {
		const handle = new FakeSessionHandle("sess_tool_continuation", null);
		const terminal = waitForAutoWorkSessionTerminal(handle as unknown as SessionHandle, 60_000, () => handle.prompt("go"));

		handle.emit({ type: "turn_end", message: { stopReason } });
		handle.emit({ type: "turn_end", message: { stopReason: "end_turn" } });

		expect(await terminal).toBe("completed");
	});

	test("ignores TTSR advisories until the turn ends successfully", async () => {
		const handle = new FakeSessionHandle("sess_ttsr_advisory", null);
		const terminal = waitForAutoWorkSessionTerminal(handle as unknown as SessionHandle, 60_000, () => handle.prompt("go"));

		handle.emit({ type: "notice", level: "error", message: "TTSR matched rules: tool policy" });
		handle.emit({
			type: "turn_end",
			message: { stopReason: "aborted", errorMessage: "TTSR matched rules: tool policy" },
		});
		handle.emit({ type: "ttsr_triggered", rules: [{ name: "tool policy" }] });
		handle.emit({ type: "turn_end", message: { stopReason: "end_turn" } });

		expect(await terminal).toBe("completed");
	});

	test("preserves a real terminal failure after an intermediate tool-use round", async () => {
		const handle = new FakeSessionHandle("sess_tool_then_failure", null);
		const terminal = waitForAutoWorkSessionTerminal(handle as unknown as SessionHandle, 60_000, () => handle.prompt("go"));

		handle.emit({ type: "turn_end", message: { stopReason: "toolUse" } });
		handle.emit({ type: "turn_end", message: { stopReason: "error" } });

		expect(await terminal).toBe("failed");
	});

	test("uses the final agent_end message to classify the complete agent loop", async () => {
		const handle = new FakeSessionHandle("sess_agent_end", null);
		const terminal = waitForAutoWorkSessionTerminal(handle as unknown as SessionHandle, 60_000);

		handle.emit({
			type: "agent_end",
			messages: [{ stopReason: "toolUse" }, { stopReason: "end_turn" }],
		});

		expect(await terminal).toBe("completed");
	});
});

describe("decideSqueezeTiming", () => {
	function baseInput(overrides: Partial<SqueezeDecisionInput> = {}): SqueezeDecisionInput {
		return {
			workspaceCwd: "/tmp/squeeze-ws",
			sessionPct: 20,
			sessionResetAt: "2026-01-01T00:10:00.000Z",
			weeklyPct: 30,
			weeklyResetAt: "2026-01-08T00:00:00.000Z",
			eligibleWorkspaceCount: 2,
			scheduleIntervalMinutes: 15,
			...overrides,
		};
	}

	test("resolves true on an assistant response of exactly YES, and cleans up the session", async () => {
		const handle = new FakeSessionHandle("sess_squeeze_yes", 10, "YES");
		const deleteSessionCalls: string[] = [];
		const result = await decideSqueezeTiming(fakeBridge(handle, { deleteSessionCalls }), baseInput(), null);
		expect(result).toBe(true);
		expect(deleteSessionCalls).toEqual(["sess_squeeze_yes"]);
	});

	test("resolves true when the response is YES followed by trailing prose", async () => {
		const handle = new FakeSessionHandle("sess_squeeze_yes_prose", 10, "YES, there's clear runway left.");
		const result = await decideSqueezeTiming(fakeBridge(handle), baseInput(), null);
		expect(result).toBe(true);
	});

	test("resolves false on an assistant response of NO, and cleans up the session", async () => {
		const handle = new FakeSessionHandle("sess_squeeze_no", 10, "NO");
		const deleteSessionCalls: string[] = [];
		const result = await decideSqueezeTiming(fakeBridge(handle, { deleteSessionCalls }), baseInput(), null);
		expect(result).toBe(false);
		expect(deleteSessionCalls).toEqual(["sess_squeeze_no"]);
	});

	test("resolves false without throwing on an ambiguous response, and still cleans up the session", async () => {
		const handle = new FakeSessionHandle("sess_squeeze_maybe", 10, "MAYBE");
		const deleteSessionCalls: string[] = [];
		const result = await decideSqueezeTiming(fakeBridge(handle, { deleteSessionCalls }), baseInput(), null);
		expect(result).toBe(false);
		expect(deleteSessionCalls).toEqual(["sess_squeeze_maybe"]);
	});

	test("resolves false without throwing on an empty response", async () => {
		const handle = new FakeSessionHandle("sess_squeeze_empty", 10, "");
		const result = await decideSqueezeTiming(fakeBridge(handle), baseInput(), null);
		expect(result).toBe(false);
	});

	test("resolves false and still cleans up the session when it never reaches a terminal state before the internal timeout", async () => {
		jest.useFakeTimers();
		try {
			const handle = new FakeSessionHandle("sess_squeeze_timeout", null); // never emits turn_end
			const deleteSessionCalls: string[] = [];
			const resultPromise = decideSqueezeTiming(fakeBridge(handle, { deleteSessionCalls }), baseInput(), null);
			// `resolveIntegrationPrompt` performs async KB I/O before the session is
			// created. The fake resolves this only after waitForAutoWorkSessionTerminal
			// has subscribed and armed its timer, so advancing time cannot race setup.
			await handle.subscriptionStarted;
			jest.advanceTimersByTime(30_000);
			const result = await resultPromise;
			expect(result).toBe(false);
			expect(deleteSessionCalls).toEqual(["sess_squeeze_timeout"]);
		} finally {
			jest.useRealTimers();
		}
	});

	test("resolves false without throwing when bridge.createSession itself fails, and skips cleanup (nothing was created)", async () => {
		const handle = new FakeSessionHandle("sess_squeeze_unused", 10, "YES");
		const deleteSessionCalls: string[] = [];
		const result = await decideSqueezeTiming(
			fakeBridge(handle, { createSessionError: new Error("bridge unavailable"), deleteSessionCalls }),
			baseInput(),
			null,
		);
		expect(result).toBe(false);
		expect(deleteSessionCalls).toEqual([]);
	});

	test("omits the model key entirely from createSession opts when model is null", async () => {
		const handle = new FakeSessionHandle("sess_squeeze_model_null", 10, "YES");
		const createSessionCalls: CreateSessionOpts[] = [];
		await decideSqueezeTiming(
			fakeBridge(handle, { createSessionCalls }),
			baseInput({ workspaceCwd: "/tmp/squeeze-null" }),
			null,
		);
		expect(createSessionCalls).toHaveLength(1);
		expect(createSessionCalls[0]).toMatchObject({ cwd: "/tmp/squeeze-null", internal: true });
		expect(createSessionCalls[0]?.systemPromptOverride).toEqual(expect.any(String));
	});

	test("passes the model through verbatim in createSession opts when non-null", async () => {
		const handle = new FakeSessionHandle("sess_squeeze_model_set", 10, "YES");
		const createSessionCalls: CreateSessionOpts[] = [];
		await decideSqueezeTiming(
			fakeBridge(handle, { createSessionCalls }),
			baseInput({ workspaceCwd: "/tmp/squeeze-model" }),
			{ provider: "anthropic", id: "claude-good" },
		);
		expect(createSessionCalls).toHaveLength(1);
		expect(createSessionCalls[0]).toMatchObject({
			cwd: "/tmp/squeeze-model",
			internal: true,
			model: { provider: "anthropic", id: "claude-good" },
		});
		expect(createSessionCalls[0]?.systemPromptOverride).toEqual(expect.any(String));
	});
});

describe("sanitizeBranchSlug", () => {
	test("lowercases, kebab-cases, and strips punctuation from a mixed-case response", () => {
		expect(sanitizeBranchSlug("Fix Login Bug!!")).toBe("fix-login-bug");
	});

	test("trims leading and trailing separator-derived dashes", () => {
		expect(sanitizeBranchSlug("  --Deploy Now--  ")).toBe("deploy-now");
	});

	test("collapses consecutive non-alphanumeric runs into a single dash", () => {
		expect(sanitizeBranchSlug("foo___bar   baz")).toBe("foo-bar-baz");
	});

	test("uses only the first line of a multi-line response", () => {
		expect(sanitizeBranchSlug("First line\nSecond line ignored")).toBe("first-line");
	});

	test("caps at exactly 40 characters when the cut doesn't land on a separator", () => {
		const long = "thisisaveryveryverylongsentencewithoutanyseparatorsatallwhichkeepsgoingandgoing";
		const result = sanitizeBranchSlug(long);
		expect(result).toBe(long.slice(0, 40));
		expect(result).toHaveLength(40);
	});

	test("trims a dangling trailing dash left over from the 40-char cap", () => {
		const input = `${"a".repeat(39)} b-word-that-continues-long-past-the-cap`;
		const result = sanitizeBranchSlug(input);
		expect(result).toBe("a".repeat(39));
		expect(result.endsWith("-")).toBe(false);
	});

	test("returns an empty string for empty input", () => {
		expect(sanitizeBranchSlug("")).toBe("");
	});

	test("returns an empty string for input that is entirely non-alphanumeric", () => {
		expect(sanitizeBranchSlug("!!!???...")).toBe("");
	});
});

describe("generateBranchSlugWithModel", () => {
	// Sandboxes OMP_DECK_KB_ROOT to an empty temp dir per test so
	// `resolveKbRoot()` never touches the real user's `~/kb`. With no
	// `integrations/branch-naming.md`, the resolver must use its raw template
	// fallback, letting these tests assert the full system-prompt override.
	let savedKbRoot: string | undefined;
	let kbRootDir: string;

	beforeEach(() => {
		savedKbRoot = process.env.OMP_DECK_KB_ROOT;
		kbRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-branch-slug-kb-"));
		process.env.OMP_DECK_KB_ROOT = kbRootDir;
	});

	afterEach(() => {
		if (savedKbRoot === undefined) delete process.env.OMP_DECK_KB_ROOT;
		else process.env.OMP_DECK_KB_ROOT = savedKbRoot;
		fs.rmSync(kbRootDir, { recursive: true, force: true });
	});

	test("returns the sanitized slug from the model response with the isolated branch-naming integration", async () => {
		const task = baseTask({ title: "Arreglar el error de inicio de sesión" });
		const handle = new FakeSessionHandle("sess_branch_happy", 10, "Fix Login Bug!!");
		const createSessionCalls: CreateSessionOpts[] = [];
		const deleteSessionCalls: string[] = [];

		const result = await generateBranchSlugWithModel(
			fakeBridge(handle, { createSessionCalls, deleteSessionCalls }),
			"/tmp/branch-slug-ws",
			task,
			null,
		);

		expect(result).toBe("fix-login-bug");
		expect(createSessionCalls).toEqual([
			{ cwd: "/tmp/branch-slug-ws", systemPromptOverride: BRANCH_NAMING_RULES_BODY, internal: true },
		]);
		expect(deleteSessionCalls).toEqual(["sess_branch_happy"]);
	});

	test("reads kb/integrations/branch-naming.md from the sandboxed KB root when present", async () => {
		const customRules = "# Custom branch naming rules\n\nAlways return `custom-slug`.\n";
		fs.mkdirSync(path.join(kbRootDir, "integrations"), { recursive: true });
		fs.writeFileSync(path.join(kbRootDir, "integrations", "branch-naming.md"), customRules, "utf8");

		const task = baseTask({ title: "Whatever" });
		const handle = new FakeSessionHandle("sess_branch_custom_rules", 10, "custom-slug");
		const createSessionCalls: CreateSessionOpts[] = [];

		await generateBranchSlugWithModel(fakeBridge(handle, { createSessionCalls }), "/tmp/branch-slug-ws", task, null);

		expect(createSessionCalls).toEqual([
			{ cwd: "/tmp/branch-slug-ws", systemPromptOverride: customRules, internal: true },
		]);
	});

	test("omits the model key entirely from createSession opts when model is null", async () => {
		const task = baseTask({ title: "Model passthrough null" });
		const handle = new FakeSessionHandle("sess_branch_model_null", 10, "Some Slug");
		const createSessionCalls: CreateSessionOpts[] = [];

		await generateBranchSlugWithModel(
			fakeBridge(handle, { createSessionCalls }),
			"/tmp/branch-slug-model-null",
			task,
			null,
		);

		expect(createSessionCalls).toEqual([
			{ cwd: "/tmp/branch-slug-model-null", systemPromptOverride: BRANCH_NAMING_RULES_BODY, internal: true },
		]);
	});

	test("passes the model through verbatim in createSession opts when non-null", async () => {
		const task = baseTask({ title: "Model passthrough set" });
		const handle = new FakeSessionHandle("sess_branch_model_set", 10, "Some Slug");
		const createSessionCalls: CreateSessionOpts[] = [];

		await generateBranchSlugWithModel(
			fakeBridge(handle, { createSessionCalls }),
			"/tmp/branch-slug-model-set",
			task,
			{ provider: "anthropic", id: "claude-good" },
		);

		expect(createSessionCalls).toEqual([
			{
				cwd: "/tmp/branch-slug-model-set",
				systemPromptOverride: BRANCH_NAMING_RULES_BODY,
				internal: true,
				model: { provider: "anthropic", id: "claude-good" },
			},
		]);
	});

	test("falls back to the deterministic naive slug and still cleans up the session when it never reaches a terminal state before the internal 20s timeout", async () => {
		jest.useFakeTimers();
		try {
			const task = baseTask({ title: "Slow Model Response Never Arrives" });
			const expectedFallback = task.title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 40);
			const handle = new FakeSessionHandle("sess_branch_timeout", null); // never emits turn_end
			const deleteSessionCalls: string[] = [];
			const resultPromise = generateBranchSlugWithModel(
				fakeBridge(handle, { deleteSessionCalls }),
				"/tmp/branch-slug-timeout",
				task,
				null,
			);
			// Wait for the fake's subscription signal, which occurs only after the
			// asynchronous integration lookup and timeout setup are complete.
			await handle.subscriptionStarted;
			jest.advanceTimersByTime(20_000);
			const result = await resultPromise;
			expect(result).toBe(expectedFallback);
			expect(deleteSessionCalls).toEqual(["sess_branch_timeout"]);
		} finally {
			jest.useRealTimers();
		}
	});

	test("falls back to the deterministic naive slug without throwing when bridge.createSession itself fails, and skips cleanup (nothing was created)", async () => {
		const task = baseTask({ title: "Bridge Unavailable" });
		const expectedFallback = task.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40);
		const handle = new FakeSessionHandle("sess_branch_unused", 10, "Fix Login Bug!!");
		const deleteSessionCalls: string[] = [];

		const result = await generateBranchSlugWithModel(
			fakeBridge(handle, { createSessionError: new Error("bridge unavailable"), deleteSessionCalls }),
			"/tmp/branch-slug-error",
			task,
			null,
		);

		expect(result).toBe(expectedFallback);
		expect(deleteSessionCalls).toEqual([]);
	});

	test("falls back to the deterministic naive slug when the assistant response is empty", async () => {
		const task = baseTask({ title: "Empty Model Response" });
		const expectedFallback = task.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40);
		const handle = new FakeSessionHandle("sess_branch_empty", 10, "");
		const deleteSessionCalls: string[] = [];

		const result = await generateBranchSlugWithModel(
			fakeBridge(handle, { deleteSessionCalls }),
			"/tmp/branch-slug-empty",
			task,
			null,
		);

		expect(result).toBe(expectedFallback);
		expect(deleteSessionCalls).toEqual(["sess_branch_empty"]);
	});

	test("falls back to the deterministic naive slug when the assistant response sanitizes to nothing (entirely punctuation)", async () => {
		const task = baseTask({ title: "Punctuation Only Response" });
		const expectedFallback = task.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40);
		const handle = new FakeSessionHandle("sess_branch_punct", 10, "!!!");
		const deleteSessionCalls: string[] = [];

		const result = await generateBranchSlugWithModel(
			fakeBridge(handle, { deleteSessionCalls }),
			"/tmp/branch-slug-punct",
			task,
			null,
		);

		expect(result).toBe(expectedFallback);
		expect(deleteSessionCalls).toEqual(["sess_branch_punct"]);
	});

	test("swallows a deleteSession failure without throwing out of generateBranchSlugWithModel", async () => {
		const task = baseTask({ title: "Delete Cleanup Fails" });
		const handle = new FakeSessionHandle("sess_branch_delete_fail", 10, "Fix Login Bug!!");
		const bridge: AgentBridge = {
			...fakeBridge(handle),
			deleteSession: async () => {
				throw new Error("delete failed");
			},
		};

		const result = await generateBranchSlugWithModel(bridge, "/tmp/branch-slug-delete-fail", task, null);

		expect(result).toBe("fix-login-bug");
	});
});

describe("extractAgentHistory", () => {
	test("returns null when body has no Agent History section", () => {
		expect(extractAgentHistory("## Why\nsome body")).toBeNull();
		expect(extractAgentHistory("")).toBeNull();
	});

	test("returns null when section is present but empty", () => {
		expect(extractAgentHistory("## Agent History\n\n")).toBeNull();
		expect(extractAgentHistory("## Agent History")).toBeNull();
	});

	test("extracts content below the Agent History heading", () => {
		const body = "## Why\nbody\n\n## Agent History\n\n### 2026-01-01T00:00:00.000Z — run r1\nDid X.";
		expect(extractAgentHistory(body)).toBe("### 2026-01-01T00:00:00.000Z — run r1\nDid X.");
	});

	test("stops extraction at the next same-level heading", () => {
		const body = "## Agent History\n\n### entry\nwork\n\n## After Section\ncontent";
		const result = extractAgentHistory(body);
		expect(result).toContain("### entry");
		expect(result).not.toContain("## After Section");
	});

	test("returns multiple entries when they are all present", () => {
		const body = "## Agent History\n\n### ts1 — run r1\nFirst.\n\n### ts2 — run r2\nSecond.";
		const result = extractAgentHistory(body);
		expect(result).toContain("### ts1 — run r1");
		expect(result).toContain("### ts2 — run r2");
	});
});

describe("appendAgentHistoryEntry", () => {
	test("creates the Agent History section at the end when absent", () => {
		const result = appendAgentHistoryEntry("## Why\nbody", "run_1", "2026-01-01T00:00:00.000Z", "Done.");
		expect(result).toContain("## Agent History");
		expect(result).toContain("### 2026-01-01T00:00:00.000Z — run run_1\nDone.");
		// Original body intact
		expect(result).toContain("## Why\nbody");
	});

	test("appends a new entry when Agent History section already exists", () => {
		const base = "## Why\nbody\n\n## Agent History\n\n### ts1 — run r1\nFirst.";
		const result = appendAgentHistoryEntry(base, "r2", "ts2", "Second.");
		expect(result).toContain("### ts1 — run r1\nFirst.");
		expect(result).toContain("### ts2 — run r2\nSecond.");
		// Original human-written sections are untouched
		expect(result).toContain("## Why\nbody");
	});

	test("preserves all other sections unchanged", () => {
		const body = "## Why\nreason\n\n## Acceptance\ncriteria";
		const result = appendAgentHistoryEntry(body, "r1", "ts", "Summary.");
		expect(result).toContain("## Why\nreason");
		expect(result).toContain("## Acceptance\ncriteria");
	});

	test("does not duplicate the heading when appending to an existing section", () => {
		const base = "## Why\nbody\n\n## Agent History\n\n### ts1 — run r1\nFirst.";
		const result = appendAgentHistoryEntry(base, "r2", "ts2", "Second.");
		const headingCount = result.split("## Agent History").length - 1;
		expect(headingCount).toBe(1);
	});
});

// Stubs `gh pr create` for every `runAutoWorkCycle` test that reaches the
// success path (T-66) — a test must NEVER let the real default run, since
// that would shell out to `gh` and attempt to open an actual GitHub PR.
async function stubCreatePullRequest(): Promise<{ url: string; number: number; prStatus: "opened" | "already_open" }> {
	return { url: "https://github.com/jaesbit/omp-deck/pull/321", number: 321, prStatus: "opened" };
}

let dbDir: string;
let homeDir: string;
let repoCwd: string;
let originalHome: string | undefined;

function runGit(args: string[], cwd: string): void {
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
}

async function withProjectBasePolicy<T>(baseBranch: string, run: () => Promise<T>): Promise<T> {
	const savedKbRoot = process.env.OMP_DECK_KB_ROOT;
	const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-policy-kb-"));
	const policyPath = path.join(kbRoot, "projects", "workspace.md");
	fs.mkdirSync(path.dirname(policyPath), { recursive: true });
	fs.writeFileSync(policyPath, `---\nprojectRoot: ${repoCwd}\nbaseBranch: ${baseBranch}\n---\n# Workspace policy\n`, "utf8");
	process.env.OMP_DECK_KB_ROOT = kbRoot;
	try {
		return await run();
	} finally {
		if (savedKbRoot === undefined) delete process.env.OMP_DECK_KB_ROOT;
		else process.env.OMP_DECK_KB_ROOT = savedKbRoot;
		fs.rmSync(kbRoot, { recursive: true, force: true });
	}
}

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-engine-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });

	originalHome = process.env.HOME;
	homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-engine-home-"));
	process.env.HOME = homeDir;

	repoCwd = path.join(homeDir, "workspace");
	fs.mkdirSync(repoCwd, { recursive: true });
	runGit(["init", "-q"], repoCwd);
	runGit(["config", "user.email", "test@example.com"], repoCwd);
	runGit(["config", "user.name", "Test"], repoCwd);
	fs.writeFileSync(path.join(repoCwd, "README.md"), "hello\n");
	runGit(["add", "."], repoCwd);
	runGit(["commit", "-q", "-m", "init"], repoCwd);

	// Set up a bare remote so `git worktree add … origin/main` works in tests.
	// PR #44 introduced `origin/main` in the worktree command but the test fixture
	// had no remote, causing those tests to fail with "invalid reference: origin/main".
	const originDir = path.join(homeDir, "origin.git");
	fs.mkdirSync(originDir);
	runGit(["init", "--bare", "-q"], originDir);
	runGit(["remote", "add", "origin", originDir], repoCwd);
	runGit(["push", "origin", "HEAD:main"], repoCwd);
	runGit(["symbolic-ref", "HEAD", "refs/heads/main"], originDir);
	runGit(["fetch", "-q", "origin"], repoCwd);
	runGit(["remote", "set-head", "origin", "-a"], repoCwd);
});

afterEach(() => {
	closeDb();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	for (const dir of [dbDir, homeDir]) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("reconcileInactiveAutoWorkRuns", () => {
	test("retires an expired persisted run without a live session and returns its task to backlog", async () => {
		const task = createTask({ title: "Expired Auto Work run", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(task.id, "s_active", 0);
		expect(getTask(task.id)?.stateId).toBe("s_active");
		const runId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P5",
			sessionId: "sess_not_running",
			worktreePath: path.join(repoCwd, ".worktrees", "aw-expired"),
		});
		const startedAt = listAutoWorkRuns({ taskId: task.id })[0]?.startedAt;
		if (!startedAt) throw new Error("expected persisted Auto Work run");

		const reconciled = await reconcileInactiveAutoWorkRuns(
			fakeBridge(new FakeSessionHandle("sess_unused", null)),
			Date.parse(startedAt) + 60_001,
		);

		expect(reconciled).toBe(1);
		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs).toHaveLength(1);
		expect(runs[0]).toEqual(expect.objectContaining({ id: runId, status: "failed", failureReason: "session_not_running" }));
		expect(getTask(task.id)?.stateId).toBe("s_backlog");
	});

	test("leaves a running row alone when its session still exists persisted — resumable, owned by the scheduler", async () => {
		const task = createTask({ title: "Resumable Auto Work run", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(task.id, "s_active", 0);
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-resumable");
		const runId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P5",
			sessionId: "sess_persisted",
			worktreePath,
		});
		const startedAt = listAutoWorkRuns({ taskId: task.id })[0]?.startedAt;
		if (!startedAt) throw new Error("expected persisted Auto Work run");

		const persisted: SessionSummary = {
			id: "sess_persisted",
			path: "/tmp/sessions/sess_persisted.jsonl",
			cwd: worktreePath,
			createdAt: startedAt,
			updatedAt: startedAt,
			messageCount: 2,
		};
		const reconciled = await reconcileInactiveAutoWorkRuns(
			fakeBridge(new FakeSessionHandle("sess_unused", null), { persistedSessions: [persisted] }),
			Date.parse(startedAt) + 60_001,
		);

		expect(reconciled).toBe(0);
		expect(listAutoWorkRuns({ taskId: task.id })[0]).toEqual(expect.objectContaining({ id: runId, status: "running" }));
		expect(getTask(task.id)?.stateId).toBe("s_active");
	});

	test("keeps an expired running row when a transient bridge liveness check throws", async () => {
		const task = createTask({ title: "Transient liveness error", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(task.id, "s_active", 0);
		const runId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P5",
			sessionId: "sess_sync_error",
			worktreePath: path.join(repoCwd, ".worktrees", "aw-sync-error"),
		});
		const startedAt = listAutoWorkRuns({ taskId: task.id })[0]?.startedAt;
		if (!startedAt) throw new Error("expected persisted Auto Work run");

		const bridge = {
			...fakeBridge(new FakeSessionHandle("sess_unused", null)),
			getSession() {
				throw new Error("temporary worker RPC failure");
			},
		} as AgentBridge;
		const reconciled = await reconcileInactiveAutoWorkRuns(bridge, Date.parse(startedAt) + 60_001);

		expect(reconciled).toBe(0);
		expect(listAutoWorkRuns({ taskId: task.id })[0]).toEqual(expect.objectContaining({ id: runId, status: "running" }));
		expect(getTask(task.id)?.stateId).toBe("s_active");
	});
});

// ─── createPullRequestViaGh / describeGhFailure (T-85) ─────────────────────
//
// `describeGhFailure` isn't exported, so its stderr-pattern mapping is
// exercised here through `createPullRequestViaGh`'s thrown error text
// instead. A naive "prepend a fake `gh` script to PATH" approach does not
// work against Bun: mutating `process.env.PATH` from inside a running Bun
// process does not change what a default (no explicit `env`) `Bun.spawn`
// call resolves — Bun snapshots the process environment for child-process
// resolution once at startup, so a live PATH mutation is invisible to it
// (verified experimentally, not an assumption). These tests instead
// monkeypatch the global `Bun.spawn` for the duration of one test,
// intercepting only `["gh", …]` commands — every other command (notably
// the real `git ls-remote` call inside `resolveDefaultBranch`) passes
// straight through to the real `Bun.spawn`, unaffected.
type FakeGhSubprocess = {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
};

function fakeGhFailure(stderrText: string, exitCode = 1): FakeGhSubprocess {
	return {
		stdout: new Blob([""]).stream(),
		stderr: new Blob([stderrText]).stream(),
		exited: Promise.resolve(exitCode),
	};
}

function fakeGhSuccess(stdoutText: string): FakeGhSubprocess {
	return {
		stdout: new Blob([stdoutText]).stream(),
		stderr: new Blob([""]).stream(),
		exited: Promise.resolve(0),
	};
}


function withFakeGhSpawn(handler: (cmd: string[]) => FakeGhSubprocess): () => void {
	const realSpawn = Bun.spawn;
	// @ts-expect-error test-only monkeypatch — narrower signature than Bun.spawn's real overloads
	Bun.spawn = (cmd: string[], opts: unknown) =>
		Array.isArray(cmd) && cmd[0] === "gh" ? handler(cmd) : realSpawn(cmd as never, opts as never);
	return () => {
		Bun.spawn = realSpawn;
	};
}

describe("createPullRequestViaGh", () => {
	test("maps expired/missing gh auth stderr to a `gh auth login` hint", async () => {
		const restore = withFakeGhSpawn(() =>
			fakeGhFailure("gh: To use GitHub CLI, please run: gh auth login\nerror: not logged into any GitHub hosts"),
		);
		try {
			await expect(createPullRequestViaGh({ cwd: repoCwd, title: "T", body: "B" })).rejects.toThrow(
				/GitHub authentication expired or missing.*gh auth login/s,
			);
		} finally {
			restore();
		}
	});

	test("maps a GitHub API rate-limit stderr to a retry hint", async () => {
		const restore = withFakeGhSpawn(() => fakeGhFailure("API rate limit exceeded for user ID 123."));
		try {
			await expect(createPullRequestViaGh({ cwd: repoCwd, title: "T", body: "B" })).rejects.toThrow(
				/GitHub API rate limit exceeded — retry once the limit resets/,
			);
		} finally {
			restore();
		}
	});

	test("maps a missing-remote stderr to a no-remote-configured hint", async () => {
		const restore = withFakeGhSpawn(() => fakeGhFailure("no git remotes found"));
		try {
			await expect(createPullRequestViaGh({ cwd: repoCwd, title: "T", body: "B" })).rejects.toThrow(
				/no GitHub remote configured for this repository/,
			);
		} finally {
			restore();
		}
	});

	test("falls back to a generic message for an unrecognized gh failure, still keeping the raw stderr", async () => {
		const restore = withFakeGhSpawn(() => fakeGhFailure("gh: some totally unexpected internal error", 1));
		try {
			await expect(createPullRequestViaGh({ cwd: repoCwd, title: "T", body: "B" })).rejects.toThrow(
				/gh pr create failed \(gh pr create exited 1\): gh: some totally unexpected internal error/,
			);
		} finally {
			restore();
		}
	});

	test("throws an actionable message when the gh binary itself is missing (ENOENT)", async () => {
		const restore = withFakeGhSpawn(() => {
			const err = new Error('Executable not found in $PATH: "gh" ENOENT') as Error & { code?: string };
			err.code = "ENOENT";
			throw err;
		});
		try {
			await expect(createPullRequestViaGh({ cwd: repoCwd, title: "T", body: "B" })).rejects.toThrow(
				/gh CLI not found on the deck host — install it and run "gh auth login"/,
			);
		} finally {
			restore();
		}
	});

	test("opens a pull request against the matching KB policy instead of origin/HEAD", async () => {
		const restore = withFakeGhSpawn((cmd) => {
			const baseIndex = cmd.indexOf("--base");
			if (cmd[baseIndex + 1] === "devel") {
				return {
					stdout: new Blob(["https://github.com/jaesbit/omp-deck/pull/808\n"]).stream(),
					stderr: new Blob([""]).stream(),
					exited: Promise.resolve(0),
				};
			}
			return fakeGhFailure(`unexpected PR base ${cmd[baseIndex + 1]}`);
		});
		// The diff guard needs `origin/devel` fetched locally to diff against —
		// mirror how a real worktree is always created FROM `origin/<base>`
		// (so the ref necessarily exists by the time PR creation runs).
		runGit(["push", "origin", "HEAD:devel"], repoCwd);
		runGit(["fetch", "-q", "origin", "devel"], repoCwd);
		try {
			const result = await withProjectBasePolicy("devel", () =>
				createPullRequestViaGh({ cwd: repoCwd, title: "Policy branch", body: "Uses the configured branch." }),
			);

			expect(result).toEqual({ url: "https://github.com/jaesbit/omp-deck/pull/808", number: 808, prStatus: "opened" });
		} finally {
			restore();
		}
	});

	test("returns the existing PR with prStatus 'already_open' when gh pr create reports the PR already exists (case-insensitive)", async () => {
		const restore = withFakeGhSpawn((cmd) => {
			if (cmd[2] === "create") {
				// Simulate the gh output when the agent already opened a PR.
				// Use uppercase "A pull request" to exercise the case-insensitive check.
				return fakeGhFailure("A pull request for branch 'auto-work/t5-ship-it' already exists: https://github.com/jaesbit/omp-deck/pull/77");
			}
			// gh pr view --json number,url — recovery lookup
			return fakeGhSuccess('{"number":77,"url":"https://github.com/jaesbit/omp-deck/pull/77"}');
		});
		try {
			const result = await createPullRequestViaGh({ cwd: repoCwd, title: "T", body: "B" });
			expect(result).toEqual({ url: "https://github.com/jaesbit/omp-deck/pull/77", number: 77, prStatus: "already_open" });
		} finally {
			restore();
		}
	});

	// ─── T-119: sensitive-content guard ────────────────────────────────────

	test("rejects and never calls gh when the PR title contains an absolute URL", async () => {
		let ghCalled = false;
		const restore = withFakeGhSpawn(() => {
			ghCalled = true;
			return fakeGhSuccess("https://github.com/jaesbit/omp-deck/pull/1\n");
		});
		try {
			await expect(
				createPullRequestViaGh({ cwd: repoCwd, title: `feat: T-1 see ${"http" + "://localhost:8787/c/abc"}`, body: "B" }),
			).rejects.toThrow(SensitiveContentError);
		} finally {
			restore();
		}
		expect(ghCalled).toBe(false);
	});

	test("rejects and never calls gh when the PR body embeds credentials in a URL", async () => {
		let ghCalled = false;
		const restore = withFakeGhSpawn(() => {
			ghCalled = true;
			return fakeGhSuccess("https://github.com/jaesbit/omp-deck/pull/1\n");
		});
		// String-concatenated so this test file's own source diff never
		// contains a contiguous credential-shaped match (see pr-content-guard.ts).
		const sneaky = ["https://user", "s3cr3t@example.com/callback"].join(":");
		try {
			await expect(createPullRequestViaGh({ cwd: repoCwd, title: "T", body: `Auto Work — ${sneaky}` })).rejects.toThrow(
				SensitiveContentError,
			);
		} finally {
			restore();
		}
		expect(ghCalled).toBe(false);
	});

	test("rejects a branch whose diff adds a realistic-looking secret, and never pushes or calls gh", async () => {
		const fakeKey = ["sk-ant", `api03-${"A".repeat(60)}`].join("-");
		fs.writeFileSync(path.join(repoCwd, "leaked.txt"), `${fakeKey}\n`);
		runGit(["add", "."], repoCwd);
		runGit(["commit", "-q", "-m", "oops"], repoCwd);

		const originDir = path.join(homeDir, "origin.git");
		const shaBefore = Bun.spawnSync({ cmd: ["git", "rev-parse", "refs/heads/main"], cwd: originDir, stdout: "pipe" }).stdout
			.toString()
			.trim();

		let ghCalled = false;
		const restore = withFakeGhSpawn(() => {
			ghCalled = true;
			return fakeGhSuccess("https://github.com/jaesbit/omp-deck/pull/1\n");
		});
		try {
			await expect(createPullRequestViaGh({ cwd: repoCwd, title: "T", body: "B" })).rejects.toThrow(SensitiveContentError);
		} finally {
			restore();
		}
		expect(ghCalled).toBe(false);

		const shaAfter = Bun.spawnSync({ cmd: ["git", "rev-parse", "refs/heads/main"], cwd: originDir, stdout: "pipe" }).stdout
			.toString()
			.trim();
		expect(shaAfter).toBe(shaBefore); // never pushed — the secret never reached origin
	});

	test("pushes the unpushed task branch to origin before gh pr create", async () => {
		runGit(["checkout", "-q", "-b", "auto-work/t1-demo"], repoCwd);
		fs.writeFileSync(path.join(repoCwd, "work.txt"), "done\n");
		runGit(["add", "."], repoCwd);
		runGit(["commit", "-q", "-m", "work"], repoCwd);

		const restore = withFakeGhSpawn(() => ({
			stdout: new Blob(["https://github.com/o/r/pull/12\n"]).stream(),
			stderr: new Blob([""]).stream(),
			exited: Promise.resolve(0),
		}));
		try {
			const result = await createPullRequestViaGh({ cwd: repoCwd, title: "T", body: "B" });
			expect(result.number).toBe(12);
		} finally {
			restore();
		}

		const lsRemote = Bun.spawnSync({
			cmd: ["git", "ls-remote", "--heads", "origin", "auto-work/t1-demo"],
			cwd: repoCwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(lsRemote.stdout.toString()).toContain("auto-work/t1-demo");
	});

});


describe("runAutoWorkCycle", () => {
	test("selects the task, creates a worktree, starts a session, and closes the run as completed", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Ship the thing", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_1", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			getDeckBaseUrl: () => "https://deck.example.com",
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(task.id);
		expect(result.sessionId).toBe("sess_1");
		expect(fs.existsSync(result.worktreePath)).toBe(true);
		expect(result.worktreePath).toContain(`aw-T${task.displayId}`);
		expect(result.prNumber).toBe(321);
		expect(result.prStatus).toBe("opened");

		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_validate");
		expect(updated?.body).toContain("**Auto Work**");
		expect(updated?.body).toContain("[session sess_1](https://deck.example.com/c/sess_1)");
		expect(updated?.body).toContain("PR #321");
		expect(handle.prompts).toHaveLength(1);
		expect(handle.prompts[0]).not.toContain(AUTO_WORK_RULES_BODY);

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("completed");
		expect(runs[0]?.sessionId).toBe("sess_1");
		expect(runs[0]?.worktreePath).toBe(result.worktreePath);
	});

	test("moves a completed task to blocked with a visible reason when validate state is missing", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Needs manual validation routing", cwd: repoCwd, priority: "P5", autoWork: true });
		getDb().prepare("DELETE FROM task_states WHERE id = ?").run("s_validate");

		const result = await runAutoWorkCycle(repoCwd, fakeBridge(new FakeSessionHandle("sess_missing_validate", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		expect(getTask(task.id)?.stateId).toBe("s_blocked");
		expect(getTask(task.id)?.body).toContain('validate task state not found, task moved to blocked for manual review');
		const run = listAutoWorkRuns({ taskId: task.id })[0];
		expect(run).toEqual(expect.objectContaining({ status: "completed", failureReason: expect.stringContaining("validate task state not found") }));
	});

	test("autoMerge arms GitHub auto-merge and parks the run as completed_pending_merge", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true, autoMerge: true });
		const task = createTask({ title: "Autonomous ship", cwd: repoCwd, priority: "P5", autoWork: true });

		const armed: { cwd: string; prNumber: number }[] = [];
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(new FakeSessionHandle("sess_am", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
			armAutoMerge: async (p) => {
				armed.push(p);
			},
		});

		expect(result.outcome).toBe("completed");
		expect(armed).toHaveLength(1);
		expect(armed[0]?.prNumber).toBe(321);

		// Stays in validate as a holding pen; the reconciler promotes it to done once merged.
		expect(getTask(task.id)?.stateId).toBe("s_validate");
		expect(getTask(task.id)?.body).toContain("auto-merge armed");

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs[0]?.status).toBe("completed_pending_merge");
		expect(runs[0]?.prNumber).toBe(321);
	});

	test("autoMerge still parks the run as completed_pending_merge when native arming fails", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true, autoMerge: true });
		const task = createTask({ title: "Arming fails", cwd: repoCwd, priority: "P5", autoWork: true });

		const result = await runAutoWorkCycle(repoCwd, fakeBridge(new FakeSessionHandle("sess_amfail", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
			armAutoMerge: async () => {
				throw new Error("auto-merge is not allowed for this repository");
			},
		});

		// Native arming is a best-effort bonus — the reconciler merges the PR
		// itself once CI is green, so the run stays pending either way.
		expect(result.outcome).toBe("completed");
		expect(getTask(task.id)?.stateId).toBe("s_validate");
		expect(getTask(task.id)?.body).toContain("Waiting for CI");

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs[0]?.status).toBe("completed_pending_merge");
		expect(runs[0]?.prNumber).toBe(321);
	});

	test("creates an Auto Work worktree from the matching KB branch rather than origin/HEAD", async () => {
		runGit(["checkout", "-q", "-b", "devel"], repoCwd);
		fs.writeFileSync(path.join(repoCwd, "devel-only.txt"), "from devel\n");
		runGit(["add", "devel-only.txt"], repoCwd);
		runGit(["commit", "-q", "-m", "devel base"], repoCwd);
		runGit(["push", "-q", "--set-upstream", "origin", "devel"], repoCwd);

		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Use configured base", cwd: repoCwd, priority: "P5", autoWork: true });

		const result = await withProjectBasePolicy("devel", () =>
			runAutoWorkCycle(repoCwd, fakeBridge(new FakeSessionHandle("sess_policy_base", 10)), {
				getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
				createPullRequest: stubCreatePullRequest,
			}),
		);

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(fs.readFileSync(path.join(result.worktreePath, "devel-only.txt"), "utf8")).toBe("from devel\n");
	});

	test("creates Auto Work sessions without legacy startup options", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		createTask({ title: "Runs one task session", cwd: repoCwd, priority: "P5", autoWork: true });
		const createSessionCalls: CreateSessionOpts[] = [];

		const result = await runAutoWorkCycle(repoCwd, fakeBridge(new FakeSessionHandle("sess_no_autostart", 10), { createSessionCalls }), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(createSessionCalls).toHaveLength(1);
		expect(createSessionCalls[0]).toMatchObject({ cwd: repoCwd });
		expect(createSessionCalls[0]?.systemPromptAppend).toEqual(expect.any(String));
	});
    test("reads auto-work instructions from integrations and ignores the legacy rules path", async () => {
        const savedKbRoot = process.env.OMP_DECK_KB_ROOT;
        const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-rules-kb-"));
        const customRules = "---\ntype: integration\n---\n# Custom auto-work instructions\n";
        fs.mkdirSync(path.join(kbRoot, "integrations"), { recursive: true });
        fs.mkdirSync(path.join(kbRoot, "rules"), { recursive: true });
        fs.writeFileSync(path.join(kbRoot, "integrations", "auto-work.md"), customRules);
        fs.writeFileSync(path.join(kbRoot, "rules", "auto-work.md"), "legacy rules content\n");
        process.env.OMP_DECK_KB_ROOT = kbRoot;
        try {
            setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
            createTask({ title: "Reads integration rules", cwd: repoCwd, priority: "P5", autoWork: true });
            const createSessionCalls: CreateSessionOpts[] = [];
            const result = await runAutoWorkCycle(
                repoCwd,
                fakeBridge(new FakeSessionHandle("sess_integration_rules", 10), { createSessionCalls }),
                {
                    getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
                    createPullRequest: stubCreatePullRequest,
                },
            );

            expect(result.outcome).toBe("completed");
            expect(createSessionCalls).toEqual([{ cwd: repoCwd, systemPromptAppend: customRules }]);
        } finally {
            if (savedKbRoot === undefined) delete process.env.OMP_DECK_KB_ROOT;
            else process.env.OMP_DECK_KB_ROOT = savedKbRoot;
            fs.rmSync(kbRoot, { recursive: true, force: true });
        }
    });

	/** Yields microtasks until `handle.prompts` reaches `count`, then returns.
	 *  Throws after 50 iterations so a regression produces a clear error rather
	 *  than an infinite hang. */
	async function waitForPromptCount(handle: FakeSessionHandle, count: number): Promise<void> {
		for (let i = 0; i < 50; i++) {
			if (handle.prompts.length >= count) return;
			await Promise.resolve();
		}
		throw new Error(
			`waitForPromptCount: expected ${count} prompt(s) but got ${handle.prompts.length} after 50 microtask yields`,
		);
	}

	describe("same-run abort retry", () => {
		test("first aborted → continuation prompt sent → end_turn on retry → run completes", async () => {
			setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
			const task = createTask({ title: "Retry succeeds", cwd: repoCwd, priority: "P5", autoWork: true });
			const handle = new FakeSessionHandle("sess_abort_retry_ok", null);
			const cycle = runAutoWorkCycle(repoCwd, fakeBridge(handle), {
				getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
				createPullRequest: stubCreatePullRequest,
			});
			await handle.subscriptionStarted;
			handle.emit({ type: "turn_end", message: { stopReason: "aborted" } });
			// Wait until the engine's retry loop has enqueued the continuation prompt.
			await waitForPromptCount(handle, 2);
			// Continuation turn completes successfully.
			handle.emit({ type: "turn_end", message: { stopReason: "end_turn" } });
			const result = await cycle;

			expect(result.outcome).toBe("completed");
			expect(handle.prompts.length).toBe(2); // initial + continuation
			const run = listAutoWorkRuns({ taskId: task.id })[0];
			expect(run?.status).toBe("completed");
		});

		test("two consecutive aborts exhaust retry budget: run fails and task routes to backlog", async () => {
			setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
			const task = createTask({ title: "Retry exhausted", cwd: repoCwd, priority: "P5", autoWork: true });
			const handle = new FakeSessionHandle("sess_abort_retry_fail", null);
			const cycle = runAutoWorkCycle(repoCwd, fakeBridge(handle), {
				getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
				createPullRequest: async () => { throw new Error("no PR on failed run"); },
			});
			await handle.subscriptionStarted;
			handle.emit({ type: "turn_end", message: { stopReason: "aborted" } });
			await waitForPromptCount(handle, 2);
			handle.emit({ type: "turn_end", message: { stopReason: "aborted" } });
			const result = await cycle;

			expect(result.outcome).toBe("failed");
			expect(handle.prompts.length).toBe(2); // initial + one retry
			const run = listAutoWorkRuns({ taskId: task.id })[0];
			expect(run?.status).toBe("failed");
			// Task returns to backlog (retry budget not yet exhausted at the cross-cycle level).
			expect(getTask(task.id)?.stateId).toBe("s_backlog");
		});
	});

	test("fails a max_tokens terminal turn, preserving its stop reason without creating a PR", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Token-limited agent turn", cwd: repoCwd, priority: "P5", autoWork: true });
		const handle = new FakeSessionHandle("sess_max_tokens", null);
		const { notify, calls } = recordingNotify();
		let prCreateCalls = 0;
		const cycle = runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			notify,
			createPullRequest: async () => {
				prCreateCalls++;
				return stubCreatePullRequest();
			},
		});
		await handle.subscriptionStarted;
		handle.emit({ type: "turn_end", message: { stopReason: "max_tokens" } });
		const result = await cycle;

		expect(result.outcome).toBe("failed");
		expect(prCreateCalls).toBe(0);
		expect(getTask(task.id)?.stateId).toBe("s_backlog");
		const run = listAutoWorkRuns({ taskId: task.id })[0];
		expect(run?.status).toBe("failed");
		expect(run?.failureReason).toContain("agent turn ended with stop reason: max_tokens");
		expect(getTask(task.id)?.body).toContain("agent turn ended with stop reason: max_tokens");
		expect(calls).toContainEqual(
			expect.objectContaining({ kind: "task_failed", reason: "agent turn ended with stop reason: max_tokens" }),
		);
	});

	test("fails a terminal event without a stop reason instead of creating a PR", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Abrupt agent turn", cwd: repoCwd, priority: "P5", autoWork: true });
		const handle = new FakeSessionHandle("sess_missing_stop_reason", null);
		let prCreateCalls = 0;
		const cycle = runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: async () => {
				prCreateCalls++;
				return stubCreatePullRequest();
			},
		});
		await handle.subscriptionStarted;
		handle.emit({ type: "turn_end" });
		const result = await cycle;

		expect(result.outcome).toBe("failed");
		expect(prCreateCalls).toBe(0);
		expect(getTask(task.id)?.stateId).toBe("s_backlog");
		const run = listAutoWorkRuns({ taskId: task.id })[0];
		expect(run?.status).toBe("failed");
		expect(run?.failureReason).toContain("agent turn ended without a stop reason");
		expect(getTask(task.id)?.body).toContain("agent turn ended without a stop reason");
	});

	test("settles the run as completed when turn_end is emitted before prompt() resolves (the real-world ordering)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Event lands before prompt resolution", cwd: repoCwd, priority: "P5", autoWork: true });
		const handle = new FakeSessionHandle("sess_event_ordering", null); // terminal only via explicit emit
		const cycle = runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});
		await handle.subscriptionStarted;
		// The engine subscribed before starting the turn, so this terminal event
		// — delivered while prompt() is still pending, as in production — must
		// settle the run as completed instead of leaking into the timeout (the
		// production bug: every successful run was recorded timed_out).
		expect(handle.prompts).toHaveLength(1);
		handle.emit({ type: "turn_end", message: { stopReason: "end_turn" } });
		const result = await cycle;

		expect(result.outcome).toBe("completed");
		expect(getTask(task.id)?.stateId).toBe("s_validate");
		expect(listAutoWorkRuns({ taskId: task.id })[0]?.status).toBe("completed");
	});

	test("keeps the run mutex through an intermediate tool round and rejects a concurrent global cycle", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Multi-tool task", cwd: repoCwd, priority: "P5", autoWork: true });
		const handle = new FakeSessionHandle("sess_multi_tool", null);
		const bridge = fakeBridge(handle);
		const cycle = runAutoWorkCycle(repoCwd, bridge, {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});
		await handle.subscriptionStarted;

		handle.emit({ type: "turn_end", message: { stopReason: "toolUse" } });
		expect(listAutoWorkRuns({ taskId: task.id })[0]?.status).toBe("running");
		expect(getTask(task.id)?.stateId).toBe("s_active");

		const concurrent = await runGlobalAutoWorkCycle(bridge, {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});
		expect(concurrent).toEqual({ outcome: "skipped", reason: "another auto-work run is already active" });
		expect(listAutoWorkRuns({ taskId: task.id })).toHaveLength(1);

		handle.emit({ type: "turn_end", message: { stopReason: "end_turn" } });
		expect((await cycle).outcome).toBe("completed");
		expect(listAutoWorkRuns({ taskId: task.id })[0]?.status).toBe("completed");
	});

	test("moves the task to blocked with a reason and closes the run as timed_out on timeout", async () => {
		setAutoWorkConfig(repoCwd, {
			...DEFAULT_AUTO_WORK_VALUES,
			enabled: true,
			timeoutMinutesByPriority: { P0: 120, P1: 90, P2: 60, P3: 45, P4: 45, P5: 0.0005 }, // 30ms
		});
		const task = createTask({ title: "Slow task", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_timeout", null); // never emits turn_end
		let prCreateCalls = 0;
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: async () => {
				prCreateCalls += 1;
				return stubCreatePullRequest();
			},
		});

		expect(result.outcome).toBe("timed_out");
		if (result.outcome !== "timed_out") throw new Error("expected timed_out");

		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_blocked");
		expect(updated?.body).toContain("Auto Work timeout");
		expect(updated?.body).toContain(result.runId);

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs[0]?.status).toBe("timed_out");
		expect(runs[0]?.failureReason).toContain("timeout");

		// A timed-out/failed run never opens a PR — nothing to review (T-66).
		expect(prCreateCalls).toBe(0);

		// The still-running session must actually be stopped when the run is
		// written off — otherwise the agent keeps working past the timeout.
		expect(handle.abortCalls).toBe(1);
		expect(handle.disposeCalls).toBeGreaterThanOrEqual(1);
	});

	test("on PR creation failure, still moves the completed task to validate with a fallback note (T-66)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "PR step fails", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_pr_fail", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			getDeckBaseUrl: () => "https://deck.example.com",
			createPullRequest: async () => {
				throw new Error("gh pr create failed (exit 1): no git remotes found");
			},
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");

		// The agent's work did complete — losing the PR step shouldn't silently
		// discard that behind an unrelated `gh` error, so the task still moves
		// to validate with a note that the PR needs to be opened by hand.
		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_validate");
		expect(updated?.body).toContain("[session sess_pr_](https://deck.example.com/c/sess_pr_fail)");
		expect(updated?.body).toContain("**Auto Work — implementation complete, PR creation failed**");
		expect(updated?.body).toContain("PR creation failed");

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs[0]?.status).toBe("completed_pr_failed");
		expect(runs[0]?.failureReason).toBe("gh pr create failed (exit 1): no git remotes found");
		expect(result.prStatus).toBe("failed");
		expect(result.prFailureReason).toBe("gh pr create failed (exit 1): no git remotes found");
	});

	test("completed result carries prStatus 'already_open' when createPullRequest reports an existing PR", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Agent pre-opened PR", cwd: repoCwd, priority: "P5", autoWork: true });
		const handle = new FakeSessionHandle("sess_pr_existing", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: async () => ({ url: "https://github.com/jaesbit/omp-deck/pull/42", number: 42, prStatus: "already_open" as const }),
		});
		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.prNumber).toBe(42);
		expect(result.prStatus).toBe("already_open");
		expect(result.prFailureReason).toBeUndefined();
		expect(getTask(task.id)?.stateId).toBe("s_validate");
		expect(getTask(task.id)?.body).toContain("PR #42");
	});

	test("records the completed_pr_failed run's failureReason and the fallback-note body when gh pr create fails with a non-no-commits error (T-85)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Auth failure on PR step", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_pr_auth_fail", 10);
		const authFailureMessage =
			'GitHub authentication expired or missing — run `gh auth login` (gh pr create exited 1): 401 Unauthorized';
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			getDeckBaseUrl: () => "https://deck.example.com",
			createPullRequest: async () => {
				throw new Error(authFailureMessage);
			},
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");

		// Unlike the no-commits safety net, an auth/network/rate-limit style
		// `gh` failure never touches `branchHasAgentCommits` — the task still
		// completed its real work, so it still lands in validate with the
		// exact error surfaced for a human to retry or fix manually.
		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_validate");
		expect(updated?.body).toContain("**Auto Work — implementation complete, PR creation failed**");
		expect(updated?.body).toContain(`**Error:** ${authFailureMessage}`);
		expect(updated?.body).toContain(`Retry with \`POST /auto-work/runs/${result.runId}/create-pr\``);

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs[0]?.status).toBe("completed_pr_failed");
		expect(runs[0]?.failureReason).toBe(authFailureMessage);
	});

	test("a completed turn whose gh pr create fails with a no-commits error on a branch with zero agent commits is reclassified as failed, not completed (T-85)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Agent produced no commits", cwd: repoCwd, priority: "P5", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_no_commits", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			getDeckBaseUrl: () => "https://deck.example.com",
			notify,
			createPullRequest: async () => {
				throw new Error("gh pr create failed (exit 1): No commits between main and main");
			},
		});

		// The worktree genuinely has zero commits beyond origin/main — the "no
		// commits" gh error reflects reality, not a fluke — so the run must be
		// reclassified as failed instead of parking an empty task in validate.
		expect(result.outcome).toBe("failed");

		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_backlog");
		expect(updated?.body).toContain("Auto Work aborted");
		expect(updated?.body).toContain("produced no commits");

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs[0]?.status).toBe("failed");
		expect(runs[0]?.failureReason).toContain("produced no commits");

		expect(calls).toContainEqual(
			expect.objectContaining({ kind: "task_failed", displayId: task.displayId, reason: expect.stringContaining("produced no commits") }),
		);
	});

	test("settles the normal PR-failed lifecycle when no-commits verification cannot resolve a base branch", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "No-commits resolver unavailable", cwd: repoCwd, priority: "P5", autoWork: true });
		const prFailureMessage = "gh pr create failed (exit 1): No commits between main and main";

		const result = await runAutoWorkCycle(repoCwd, fakeBridge(new FakeSessionHandle("sess_no_base_branch", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			getDeckBaseUrl: () => "https://deck.example.com",
			createPullRequest: async () => {
				// Worktree creation has already used origin/main. Remove every base
				// resolver source before the no-commits safety check runs.
				runGit(["remote", "remove", "origin"], repoCwd);
				runGit(["update-ref", "-d", "refs/remotes/origin/HEAD"], repoCwd);
				throw new Error(prFailureMessage);
			},
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");

		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_validate");
		expect(updated?.body).toContain("**Auto Work — implementation complete, PR creation failed**");
		expect(updated?.body).toContain(`**Error:** ${prFailureMessage}`);

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs[0]).toEqual(
			expect.objectContaining({ status: "completed_pr_failed", failureReason: prFailureMessage }),
		);
	});

	test("a no-commits gh pr create error on a branch that DOES have agent commits still falls through to the completed+fallback-note path (T-85)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Branch has real commits", cwd: repoCwd, priority: "P5", autoWork: true });

		// Pre-create the worktree exactly like a previous run would have left
		// it (same pattern as "reuses an existing registered worktree" above),
		// then give it a genuine commit beyond origin/main.
		const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
		const dirName = `aw-T${task.displayId}-${slug}`;
		const worktreePath = path.join(repoCwd, ".worktrees", dirName);
		runGit(["worktree", "add", "-b", `auto-work/t${task.displayId}-${slug}`, worktreePath], repoCwd);
		fs.writeFileSync(path.join(worktreePath, "agent-work.txt"), "agent output\n");
		runGit(["add", "."], worktreePath);
		runGit(["commit", "-q", "-m", "agent commit"], worktreePath);

		const handle = new FakeSessionHandle("sess_has_commits", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			getDeckBaseUrl: () => "https://deck.example.com",
			createPullRequest: async () => {
				throw new Error("gh pr create failed (exit 1): No commits between main and main");
			},
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.worktreePath).toBe(worktreePath);

		// branchHasAgentCommits correctly saw the real commit — the safety net
		// must NOT fire, so this still falls through to the pre-existing
		// implementation-complete-but-PR-creation-failed fallback (T-66), not
		// the new failed path.
		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_validate");
		expect(updated?.body).toContain("**Auto Work — implementation complete, PR creation failed**");
		expect(updated?.body).toContain("PR creation failed");
		expect(updated?.body).not.toContain("Auto Work aborted");

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs[0]?.status).toBe("completed_pr_failed");
		expect(runs[0]?.failureReason).toBe("gh pr create failed (exit 1): No commits between main and main");
	});

	test("resumes the active run instead of starting new work when another run is already active for the workspace (mutex)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const activeTask = createTask({ title: "Already running", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(activeTask.id, "s_active", 0);
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-mutex");
		fs.mkdirSync(worktreePath, { recursive: true });
		const priorRunId = startAutoWorkRun({
			taskId: activeTask.id,
			taskPriority: "P5",
			sessionId: "already-running",
			worktreePath,
		});

		// A second, unrelated backlog task that must NOT be picked up while the
		// first run is still (genuinely) active.
		const queuedTask = createTask({ title: "Queued", cwd: repoCwd, priority: "P5", autoWork: true });

		const liveHandle = new FakeSessionHandle("already-running", 10);
		const decoyHandle = new FakeSessionHandle("sess_2", 10);
		const result = await runAutoWorkCycle(
			repoCwd,
			fakeBridge(decoyHandle, { liveSessions: new Map([["already-running", liveHandle]]) }),
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(activeTask.id);
		expect(result.runId).toBe(priorRunId);
		expect(result.sessionId).toBe("already-running");

		// The resumed handle was idle (not streaming), so the engine must kick
		// it with a continuation prompt naming the worktree to resume in.
		expect(liveHandle.prompts).toHaveLength(1);
		expect(liveHandle.prompts[0]).toMatch(/reinici/);
		expect(liveHandle.prompts[0]).toContain(worktreePath);

		// The unrelated queued task must not have been touched or started —
		// the mutex still holds for a genuinely live running row.
		expect(getTask(queuedTask.id)?.stateId).toBe("s_backlog");
		expect(listAutoWorkRuns({ taskId: queuedTask.id })).toHaveLength(0);
	});

	test("skips when auto-work is disabled for the workspace", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: false });
		createTask({ title: "Disabled workspace", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_3", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result).toEqual({ outcome: "skipped", reason: expect.stringContaining("disabled") });
	});

	test("skips when no eligible task exists (unmet dependency)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const dep = createTask({ title: "Dependency", cwd: repoCwd, priority: "P5" });
		createTask({ title: "Blocked by dep", cwd: repoCwd, priority: "P5", autoWork: true, dependsOn: [dep.id] });

		const handle = new FakeSessionHandle("sess_4", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result.outcome).toBe("skipped");
		if (result.outcome !== "skipped") throw new Error("expected skipped");
		expect(result.reason).toContain("no eligible");
	});

	test("skips when the estimated cost doesn't fit even after the run-history sample builds up", async () => {
		setAutoWorkConfig(repoCwd, {
			...DEFAULT_AUTO_WORK_VALUES,
			enabled: true,
			sessionPctLimit: 1,
			weeklyPctLimit: 100,
		});
		createTask({ title: "Too expensive", cwd: repoCwd, priority: "P0", autoWork: true });
		expect(getAutoWorkCostEstimate("P0").sampleSize).toBe(0);

		const handle = new FakeSessionHandle("sess_5", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result.outcome).toBe("skipped");
		if (result.outcome !== "skipped") throw new Error("expected skipped");
		expect(result.reason).toContain("none fit");
	});

	test("skips when session budget is fully exhausted (100%) and does not start a session or run record", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Session exhausted task", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_session_exhausted", null);
		let prCreateCalls = 0;
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 20, sessionPct: 100 }),
			createPullRequest: async () => {
				prCreateCalls++;
				return stubCreatePullRequest();
			},
		});

		expect(result.outcome).toBe("skipped");
		if (result.outcome !== "skipped") throw new Error("expected skipped");
		expect(result.reason).toContain("session budget is fully exhausted");
		// Task must remain in backlog — no session started, no run record created.
		expect(getTask(task.id)?.stateId).toBe("s_backlog");
		expect(listAutoWorkRuns({ taskId: task.id })).toHaveLength(0);
		expect(prCreateCalls).toBe(0);
	});
	test("reuses an existing registered worktree instead of re-running git worktree add", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Retry after crash", cwd: repoCwd, priority: "P5", autoWork: true });

		// Simulate the worktree that a previous (crashed) run would have left behind.
		const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
		const dirName = `aw-T${task.displayId}-${slug}`;
		const worktreePath = path.join(repoCwd, ".worktrees", dirName);
		runGit(["worktree", "add", "-b", `auto-work/t${task.displayId}-${slug}`, worktreePath], repoCwd);
		expect(fs.existsSync(worktreePath)).toBe(true);

		const handle = new FakeSessionHandle("sess_retry", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		// The engine must reuse the existing worktree — same path, no error.
		expect(result.worktreePath).toBe(worktreePath);
		expect(fs.existsSync(worktreePath)).toBe(true);
	});

	test("strips a repo-local git identity override so commits fall back to the global config", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Identity leak guard", cwd: repoCwd, priority: "P5", autoWork: true });

		// Simulate the exact poisoned state found in production: a repo-local
		// override shared by every worktree (extensions.worktreeConfig is not
		// enabled), masking the real committer identity.
		runGit(["config", "--local", "user.name", "agent"], repoCwd);
		runGit(["config", "--local", "user.email", "agent@omp-deck.local"], repoCwd);

		const handle = new FakeSessionHandle("sess_identity_guard", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");

		const nameCheck = Bun.spawnSync({ cmd: ["git", "config", "--local", "--get", "user.name"], cwd: repoCwd });
		const emailCheck = Bun.spawnSync({ cmd: ["git", "config", "--local", "--get", "user.email"], cwd: repoCwd });
		expect(nameCheck.exitCode).not.toBe(0);
		expect(emailCheck.exitCode).not.toBe(0);
	});

	test("uses the injected generateBranchSlug for the worktree/branch name, without an extra bridge.createSession call for it", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Arreglar el login roto", cwd: repoCwd, priority: "P5", autoWork: true });
		const createSessionCalls: CreateSessionOpts[] = [];
		const generateBranchSlugCalls: Task[] = [];

		const handle = new FakeSessionHandle("sess_injected_slug", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle, { createSessionCalls }), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
			generateBranchSlug: async (t) => {
				generateBranchSlugCalls.push(t);
				return "fix-broken-login";
			},
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.worktreePath).toContain(`aw-T${task.displayId}-fix-broken-login`);
		expect(generateBranchSlugCalls).toEqual([expect.objectContaining({ id: task.id })]);
		// Only the one real task session — the injected fn stands in for the LLM
		// call `generateBranchSlugWithModel` would otherwise make, so there's no
		// extra bridge.createSession beyond it.
		expect(createSessionCalls).toHaveLength(1);
		expect(createSessionCalls[0]).toMatchObject({ cwd: repoCwd });
		expect(createSessionCalls[0]?.systemPromptAppend).toEqual(expect.any(String));
	});


	test("appends an Agent History entry to the task body after a completed run", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "History on completion", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_hist_complete", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			getDeckBaseUrl: () => "https://deck.example.com",
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		const updated = getTask(task.id);
		expect(updated?.body).toContain("## Agent History");
		expect(updated?.body).toContain(result.runId);
		expect(updated?.body).toContain("Session completed.");
		// Human-visible run note must still be present
		expect(updated?.body).toContain("**Auto Work**");
	});

	test("appends an Agent History entry to the task body after a failed run", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "History on failure", cwd: repoCwd, priority: "P5", autoWork: true });
		const handle = new FakeSessionHandle("sess_hist_fail", null);
		const cycle = runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: async () => { throw new Error("should not be called"); },
		});
		await handle.subscriptionStarted;
		handle.emit({ type: "turn_end", message: { stopReason: "error" } });
		const result = await cycle;

		expect(result.outcome).toBe("failed");
		if (result.outcome !== "failed") throw new Error("expected failed");
		const updated = getTask(task.id);
		expect(updated?.body).toContain("## Agent History");
		expect(updated?.body).toContain(result.runId);
		expect(updated?.body).toContain("Failed:");
	});

	test("injects prior Agent History into the opening session prompt", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		createTask({
			title: "Task with prior history",
			cwd: repoCwd,
			priority: "P5",
			autoWork: true,
			body: "## Why\nThis needs doing.\n\n## Agent History\n\n### 2026-01-01T00:00:00.000Z — run awrun_prior\nPrevious run did X.",
		});

		const handle = new FakeSessionHandle("sess_inject_hist", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		expect(handle.prompts).toHaveLength(1);
		expect(handle.prompts[0]).toContain("Agent history");
		expect(handle.prompts[0]).toContain("Previous run did X.");
	});

	test("does not inject a history block when the task has no prior Agent History", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		createTask({
			title: "Fresh task no history",
			cwd: repoCwd,
			priority: "P5",
			autoWork: true,
			body: "## Why\nNeeds fresh work.",
		});

		const handle = new FakeSessionHandle("sess_no_hist", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		expect(handle.prompts).toHaveLength(1);
		expect(handle.prompts[0]).not.toContain("Agent history");
		expect(handle.prompts[0]).not.toContain("Agent History");
	});
});

// ─── T-94: auto-title on first turn (shared session-title helper, T-78) ────

describe("T-94: auto-title on first turn", () => {
	test("titles a fresh worker session from its first-turn prompt when internalTaskModel is configured", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Fix the broken login", cwd: repoCwd, priority: "P5", autoWork: true });

		const generateTitleCalls: Parameters<AgentBridge["generateTitle"]>[0][] = [];
		const handle = new FakeSessionHandle("sess_auto_title", 10);
		const bridge = fakeBridge(handle, { titleResponse: "Fix The Login Bug", generateTitleCalls });

		const sessionsChanged = new Promise<void>((resolve) => {
			const stop = broadcastBus.subscribe((frame) => {
				if (frame.type === "sessions_changed") {
					stop();
					resolve();
				}
			});
		});

		const result = await runAutoWorkCycle(repoCwd, bridge, {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});
		await sessionsChanged;

		expect(result.outcome).toBe("completed");
		expect(generateTitleCalls).toHaveLength(1);
		// Same first-turn text handed to `session.prompt()`, embedding the
		// GET /api/tasks/<id> reference `generateSessionTitle` regexes out.
		expect(generateTitleCalls[0]?.userMessage).toContain(handle.prompts[0]);
		expect(generateTitleCalls[0]?.userMessage).toContain(`GET /api/tasks/${task.id}`);
		expect(handle.setNameCalls).toEqual(["Fix The Login Bug"]);
	});

	test("never generates or sets a title when internalTaskModel is unset — the default for every other runAutoWorkCycle test", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		createTask({ title: "Ship the thing", cwd: repoCwd, priority: "P5", autoWork: true });

		const generateTitleCalls: Parameters<AgentBridge["generateTitle"]>[0][] = [];
		const handle = new FakeSessionHandle("sess_no_title_model", 10);
		const bridge = fakeBridge(handle, { titleResponse: "Should Never Be Used", generateTitleCalls });

		const result = await runAutoWorkCycle(repoCwd, bridge, {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		expect(generateTitleCalls).toEqual([]);
		expect(handle.setNameCalls).toEqual([]);
	});

	test("does not trigger title generation from the internal task-selector or branch-naming one-shot sessions — only the real task session titles", async () => {
		setInternalTaskModel({ provider: "anthropic", id: "claude-good" });
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		createTask({ title: "Arreglar error de inicio de sesión", cwd: repoCwd, priority: "P5", autoWork: true });

		const generateTitleCalls: Parameters<AgentBridge["generateTitle"]>[0][] = [];
		const createSessionCalls: CreateSessionOpts[] = [];
		const handle = new FakeSessionHandle("sess_global_title", 10, "Fix Login Error!!");
		const bridge = fakeBridge(handle, { createSessionCalls, titleResponse: "Fix The Login Error", generateTitleCalls });

		const sessionsChanged = new Promise<void>((resolve) => {
			const stop = broadcastBus.subscribe((frame) => {
				if (frame.type === "sessions_changed") {
					stop();
					resolve();
				}
			});
		});

		// `runGlobalAutoWorkCycle`'s default wiring (T-77) runs a task-selector
		// AND a branch-naming internal one-shot session (`internal: true`,
		// unrelated scratch sessions) before the real task session — see
		// "wires in the real LLM-backed branch slug generator by default"
		// above, which asserts the same 3 `createSession` calls.
		const result = await runGlobalAutoWorkCycle(bridge, {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});
		await sessionsChanged;

		expect(result.outcome).toBe("completed");
		expect(createSessionCalls).toHaveLength(3);
		expect(generateTitleCalls).toHaveLength(1);
		expect(handle.setNameCalls).toEqual(["Fix The Login Error"]);
	});
});

describe("runGlobalAutoWorkCycle", () => {
	test("does not call the selector when no workspace has a candidate", async () => {
		let selectorCalls = 0;

		const result = await runGlobalAutoWorkCycle(fakeBridge(new FakeSessionHandle("unused", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			selectTask: async () => {
				selectorCalls += 1;
				return undefined;
			},
		});

		expect(result).toEqual({ outcome: "skipped", reason: "no workspace has auto-work enabled" });
		expect(selectorCalls).toBe(0);
	});

	test("retires an orphaned running run instead of deadlocking the global mutex", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const orphanTask = createTask({ title: "Orphaned by restart", cwd: repoCwd, priority: "P1", autoWork: true });
		moveTask(orphanTask.id, "s_active", 0);
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-orphan-global");
		runGit(["worktree", "add", "-b", "auto-work/orphan-global", worktreePath], repoCwd);
		startAutoWorkRun({ taskId: orphanTask.id, taskPriority: "P1", sessionId: "sess_gone_global", worktreePath });
		const startedAt = listAutoWorkRuns({ taskId: orphanTask.id })[0]?.startedAt;
		if (!startedAt) throw new Error("expected persisted Auto Work run");

		// Past the stale-run grace, with a session neither live nor persisted:
		// the pre-fix mutex skipped forever with "another auto-work run is
		// already active"; now the global cycle delegates to the workspace
		// cycle, which retires the orphan and proceeds.
		const result = await runGlobalAutoWorkCycle(fakeBridge(new FakeSessionHandle("sess_after_orphan", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
			now: () => new Date(Date.parse(startedAt) + 60_001),
		});

		expect(result).not.toEqual({ outcome: "skipped", reason: "another auto-work run is already active" });
		const orphanRuns = listAutoWorkRuns({ taskId: orphanTask.id });
		expect(orphanRuns.some((r) => r.status === "failed" && r.failureReason === "session_lost")).toBe(true);
	});

	test("uses the selector's candidate ID instead of deterministic priority", async () => {
		const otherRepoCwd = path.join(homeDir, "other-workspace");
		fs.mkdirSync(otherRepoCwd, { recursive: true });
		runGit(["init", "-q"], otherRepoCwd);
		runGit(["config", "user.email", "test@example.com"], otherRepoCwd);
		runGit(["config", "user.name", "Test"], otherRepoCwd);
		fs.writeFileSync(path.join(otherRepoCwd, "README.md"), "other\n");
		runGit(["add", "."], otherRepoCwd);
		runGit(["commit", "-q", "-m", "init"], otherRepoCwd);
		const otherOriginDir = path.join(homeDir, "other-origin.git");
		fs.mkdirSync(otherOriginDir);
		runGit(["init", "--bare", "-q"], otherOriginDir);
		runGit(["remote", "add", "origin", otherOriginDir], otherRepoCwd);
		runGit(["push", "origin", "HEAD:main"], otherRepoCwd);
		runGit(["symbolic-ref", "HEAD", "refs/heads/main"], otherOriginDir);
		runGit(["fetch", "-q", "origin"], otherRepoCwd);
		runGit(["remote", "set-head", "origin", "-a"], otherRepoCwd);

		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		setAutoWorkConfig(otherRepoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const deterministicWinner = createTask({ title: "P0 fallback", cwd: repoCwd, priority: "P0", autoWork: true });
		const selectorWinner = createTask({ title: "Selector winner", cwd: otherRepoCwd, priority: "P5", autoWork: true });
		let selectorCandidates: string[] | undefined;

		const result = await runGlobalAutoWorkCycle(fakeBridge(new FakeSessionHandle("global-selector", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
			selectTask: async (candidates) => {
				selectorCandidates = candidates.map((candidate) => candidate.task.id);
				return selectorWinner.id;
			},
		});

		expect(selectorCandidates).toEqual([deterministicWinner.id, selectorWinner.id]);
		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(selectorWinner.id);
		expect(getTask(selectorWinner.id)?.stateId).toBe("s_validate");
		expect(getTask(deterministicWinner.id)?.stateId).toBe("s_backlog");
	});

	test("wires in the real LLM-backed branch slug generator by default (T-77) — the resulting branch reflects the model's sanitized slug, not a naive slugify of the task title", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Arreglar error de inicio de sesión", cwd: repoCwd, priority: "P5", autoWork: true });
		const handle = new FakeSessionHandle("sess_global_branch_slug", 10, "Fix Login Error!!");
		const createSessionCalls: CreateSessionOpts[] = [];
		const result = await runGlobalAutoWorkCycle(fakeBridge(handle, { createSessionCalls }), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.worktreePath).toContain(`aw-T${task.displayId}-fix-login-error`);

		const naiveSlug = task.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40);
		expect(result.worktreePath).not.toContain(naiveSlug);
		expect(createSessionCalls).toHaveLength(3);
		for (const call of createSessionCalls.slice(0, 2)) {
			expect(call.internal).toBe(true);
			expect(call.systemPromptOverride).toEqual(expect.any(String));
		}
		expect(createSessionCalls[2]).toMatchObject({ cwd: repoCwd });
		expect(createSessionCalls[2]?.systemPromptAppend).toEqual(expect.any(String));
	});
	test("pinnedTaskId makes the inner cycle run exactly the global winner, not its own priority pick", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const priorityPick = createTask({ title: "P0 would win", cwd: repoCwd, priority: "P0", autoWork: true });
		const pinnedWinner = createTask({ title: "Pinned P5", cwd: repoCwd, priority: "P5", autoWork: true });

		const result = await runAutoWorkCycle(repoCwd, fakeBridge(new FakeSessionHandle("pinned-run", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
			generateBranchSlug: async () => "pinned-p5",
			pinnedTaskId: pinnedWinner.id,
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(pinnedWinner.id);
		expect(getTask(priorityPick.id)?.stateId).toBe("s_backlog");
	});

	test("pinnedTaskId that is no longer eligible skips the cycle instead of running another task", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const fallback = createTask({ title: "Would-be fallback", cwd: repoCwd, priority: "P0", autoWork: true });
		const gone = createTask({ title: "Moved away", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(gone.id, "s_active", 0);

		const result = await runAutoWorkCycle(repoCwd, fakeBridge(new FakeSessionHandle("pinned-gone", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			pinnedTaskId: gone.id,
		});

		expect(result.outcome).toBe("skipped");
		if (result.outcome !== "skipped") throw new Error("expected skipped");
		expect(result.reason).toContain("no longer eligible");
		expect(getTask(fallback.id)?.stateId).toBe("s_backlog");
	});

	test("skip reason names each enabled workspace's blocker instead of a generic line", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		// An autoWork task with a cwd keeps the workspace inside the global
		// scan while its done state leaves the backlog empty.
		const doneTask = createTask({ title: "Already done", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(doneTask.id, "s_done", 0);

		const result = await runGlobalAutoWorkCycle(fakeBridge(new FakeSessionHandle("unused", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result.outcome).toBe("skipped");
		if (result.outcome !== "skipped") throw new Error("expected skipped");
		expect(result.reason).toContain(repoCwd);
		expect(result.reason).toContain("no eligible auto-work tasks in backlog");
	});

	test("names orphaned cwd-less auto-work tasks in the skip reason", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const doneTask = createTask({ title: "Keeps workspace enabled", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(doneTask.id, "s_done", 0);
		const orphan = createTask({ title: "No workspace", priority: "P0", autoWork: true });

		const result = await runGlobalAutoWorkCycle(fakeBridge(new FakeSessionHandle("unused", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result.outcome).toBe("skipped");
		if (result.outcome !== "skipped") throw new Error("expected skipped");
		expect(result.reason).toContain(`T-${orphan.displayId}`);
		expect(result.reason).toContain("no workspace (cwd)");
	});

	test("reports orphaned tasks even when no workspace is enabled at all", async () => {
		const orphan = createTask({ title: "Orphan only", priority: "P0", autoWork: true });

		const result = await runGlobalAutoWorkCycle(fakeBridge(new FakeSessionHandle("unused", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result.outcome).toBe("skipped");
		if (result.outcome !== "skipped") throw new Error("expected skipped");
		expect(result.reason).toContain("no workspace has auto-work enabled");
		expect(result.reason).toContain(`T-${orphan.displayId}`);
	});
});

describe("runGlobalAutoWorkCycle orphan recovery (T-106)", () => {
	function persistedSummary(sessionId: string, cwd: string): SessionSummary {
		const now = new Date().toISOString();
		return { id: sessionId, path: `/tmp/sessions/${sessionId}.jsonl`, cwd, createdAt: now, updatedAt: now, messageCount: 4 };
	}

	test("a running row orphaned by a restart, with a resumable session, is resumed through the owning workspace instead of blocking the global cycle", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const orphanTask = createTask({ title: "Orphaned by restart", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(orphanTask.id, "s_active", 0);
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-orphan-resume");
		fs.mkdirSync(worktreePath, { recursive: true });
		const orphanRunId = startAutoWorkRun({ taskId: orphanTask.id, taskPriority: "P5", sessionId: "sess_orphan_resume", worktreePath });

		// A second, unrelated task sits ready in backlog — proves the tick that
		// recovers the orphan does not also start a fresh task.
		const otherTask = createTask({ title: "Would run next tick", cwd: repoCwd, priority: "P0", autoWork: true });

		const resumedHandle = new FakeSessionHandle("sess_orphan_resume", 10);
		const decoyHandle = new FakeSessionHandle("sess_decoy", 10);
		const createSessionCalls: CreateSessionOpts[] = [];
		const result = await runGlobalAutoWorkCycle(
			fakeBridge(decoyHandle, {
				createSessionCalls,
				persistedSessions: [persistedSummary("sess_orphan_resume", worktreePath)],
				liveSessions: new Map([["sess_orphan_resume", resumedHandle]]),
			}),
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(orphanTask.id);
		expect(result.runId).toBe(orphanRunId);
		expect(result.sessionId).toBe("sess_orphan_resume");
		expect(result.worktreePath).toBe(worktreePath);
		expect(createSessionCalls).toHaveLength(0); // resumed — no fresh session created
		expect(listAutoWorkRuns({ taskId: orphanTask.id })).toHaveLength(1); // no duplicate row
		expect(getTask(orphanTask.id)?.stateId).toBe("s_validate");
		expect(getTask(otherTask.id)?.stateId).toBe("s_backlog"); // untouched this tick
	});

	test("a running row orphaned by a restart, with no persisted session, is retired and the same tick selects another task", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const orphanTask = createTask({ title: "Orphaned, unrecoverable", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(orphanTask.id, "s_active", 0);
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-orphan-stale");
		runGit(["worktree", "add", "-b", "auto-work/orphan-stale-test", worktreePath], repoCwd);
		expect(fs.existsSync(worktreePath)).toBe(true);
		const orphanRunId = startAutoWorkRun({ taskId: orphanTask.id, taskPriority: "P5", sessionId: "sess_orphan_stale", worktreePath });

		// Higher priority than the retired task once it's back in backlog —
		// must win the re-selection, proving the cycle picks up fresh work
		// rather than merely retrying the task it just retired.
		const nextTask = createTask({ title: "Picked up same tick", cwd: repoCwd, priority: "P0", autoWork: true });

		const freshHandle = new FakeSessionHandle("sess_fresh_after_retire", 10);
		const result = await runGlobalAutoWorkCycle(
			fakeBridge(freshHandle), // no persistedSessions/liveSessions registered for sess_orphan_stale -> stale
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		const orphanRun = listAutoWorkRuns({ taskId: orphanTask.id }).find((r) => r.id === orphanRunId);
		expect(orphanRun?.status).toBe("failed");
		expect(orphanRun?.failureReason).toBe("session_lost");
		expect(getTask(orphanTask.id)?.stateId).toBe("s_backlog"); // first failure — auto-retry, not blocked
		expect(fs.existsSync(worktreePath)).toBe(false); // orphaned worktree was removed by the retire path

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(nextTask.id); // the cycle continued and picked the fresh candidate
		expect(result.sessionId).toBe("sess_fresh_after_retire");
	});

	test("a genuinely live run (this process's own finalizer) keeps the global mutex skip, unlike a restart orphan", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const liveTask = createTask({ title: "Genuinely in flight", cwd: repoCwd, priority: "P5", autoWork: true });

		// Never emits a terminal event on its own — stays "running" in this
		// same process until explicitly triggered below via `emit()`.
		const liveHandle = new FakeSessionHandle("sess_live_mutex", null);
		const cycle = runGlobalAutoWorkCycle(fakeBridge(liveHandle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
			selectTask: async (candidates) => candidates[0]?.task.id,
			generateBranchSlug: async () => "live-mutex",
		});
		// Waits until the real execution turn subscribes — by then
		// `finalizeAutoWorkRun` has already registered the run in `activeRunIds`.
		await liveHandle.subscriptionStarted;

		const otherTask = createTask({ title: "Must wait its turn", cwd: repoCwd, priority: "P0", autoWork: true });
		const secondTick = await runGlobalAutoWorkCycle(fakeBridge(new FakeSessionHandle("sess_unused", 10)), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});
		expect(secondTick).toEqual({ outcome: "skipped", reason: "another auto-work run is already active" });
		expect(getTask(otherTask.id)?.stateId).toBe("s_backlog");

		liveHandle.emit({ type: "turn_end", message: { stopReason: "end_turn" } });
		const result = await cycle;
		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(liveTask.id);
	});
});

describe("runAutoWorkCycle session continuation (T-65)", () => {
	test("resumes an interrupted run via its live session handle — no new worktree or session is created", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Interrupted mid-run", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(task.id, "s_active", 0);

		const worktreePath = path.join(repoCwd, ".worktrees", "aw-resume");
		fs.mkdirSync(worktreePath, { recursive: true });
		const priorRunId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P5",
			sessionId: "sess_prev",
			worktreePath,
		});

		const liveHandle = new FakeSessionHandle("sess_prev", 10);
		// A distinct decoy: if the engine wrongly restarted the task instead of
		// resuming, `createSession` would return this handle and the assertions
		// on sessionId/runId below would fail.
		const decoyHandle = new FakeSessionHandle("sess_fresh", 10);
		const result = await runAutoWorkCycle(
			repoCwd,
			fakeBridge(decoyHandle, { liveSessions: new Map([["sess_prev", liveHandle]]) }),
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.sessionId).toBe("sess_prev");
		expect(result.runId).toBe(priorRunId);
		expect(result.worktreePath).toBe(worktreePath);

		// The resumed handle was idle — its turn died with the old server
		// process — so the engine must send the continuation prompt.
		expect(liveHandle.prompts).toHaveLength(1);
		expect(liveHandle.prompts[0]).toMatch(/reinici/);
		expect(liveHandle.prompts[0]).toContain(worktreePath);

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("completed");

		// No duplicate worktree was created for the same task.
		const worktreeDirs = fs.readdirSync(path.join(repoCwd, ".worktrees"));
		expect(worktreeDirs).toEqual(["aw-resume"]);
	});

	test("reconnects to a live session when its worktree directory is gone, without creating a new worktree", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Reconnect target", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(task.id, "s_active", 0);

		// Never created on disk — simulates the worktree having been deleted
		// out from under a still-running session.
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-vanished");
		startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P5",
			sessionId: "sess_alive",
			worktreePath,
		});

		const liveHandle = new FakeSessionHandle("sess_alive", 10);
		const decoyHandle = new FakeSessionHandle("sess_fresh", 10);
		const result = await runAutoWorkCycle(
			repoCwd,
			fakeBridge(decoyHandle, { liveSessions: new Map([["sess_alive", liveHandle]]) }),
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.sessionId).toBe("sess_alive");
		expect(result.worktreePath).toBe(worktreePath);
		// Idle resumed handle → continuation prompt, still pointing at the
		// (now missing) worktree path recorded on the run.
		expect(liveHandle.prompts).toHaveLength(1);
		expect(liveHandle.prompts[0]).toMatch(/reinici/);
		expect(liveHandle.prompts[0]).toContain(worktreePath);
		// Nothing was ever created under .worktrees for this run.
		expect(fs.existsSync(path.join(repoCwd, ".worktrees"))).toBe(false);
	});

	test("reattaching to a still-streaming session sends no continuation prompt and settles on its own events", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Still streaming", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(task.id, "s_active", 0);
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-streaming");
		fs.mkdirSync(worktreePath, { recursive: true });
		const priorRunId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P5",
			sessionId: "sess_streaming",
			worktreePath,
		});

		const liveHandle = new FakeSessionHandle("sess_streaming", 10);
		liveHandle.streaming = true;
		const decoyHandle = new FakeSessionHandle("sess_fresh", 10);
		const result = await runAutoWorkCycle(
			repoCwd,
			fakeBridge(decoyHandle, { liveSessions: new Map([["sess_streaming", liveHandle]]) }),
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.runId).toBe(priorRunId);
		// A live, still-streaming turn is only observed — prompting it again
		// would inject a second instruction into the in-flight work.
		expect(liveHandle.prompts).toHaveLength(0);
	});

	test("marks a lost run stale: task returns to backlog, worktree is removed, run is failed", async () => {
		// enabled: false isolates the stale-cleanup path from a subsequent
		// task-selection cycle re-picking up the now-backlogged task.
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: false });
		const task = createTask({ title: "Orphaned", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(task.id, "s_active", 0);

		const worktreePath = path.join(repoCwd, ".worktrees", "aw-stale");
		runGit(["worktree", "add", "-b", "auto-work/stale-test", worktreePath], repoCwd);
		expect(fs.existsSync(worktreePath)).toBe(true);

		startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P5",
			sessionId: "sess_gone",
			worktreePath,
		});

		const handle = new FakeSessionHandle("sess_never_used", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});

		expect(result).toEqual({ outcome: "skipped", reason: expect.stringContaining("disabled") });

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("failed");
		expect(runs[0]?.failureReason).toBe("session_lost");

		expect(getTask(task.id)?.stateId).toBe("s_backlog");
		expect(fs.existsSync(worktreePath)).toBe(false);
	});

	test("does not treat a stale run as a mutex block — the retired task returns to backlog and is re-selected in the same cycle", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const staleTask = createTask({ title: "Was active, now orphaned", cwd: repoCwd, priority: "P1", autoWork: true });
		moveTask(staleTask.id, "s_active", 0);
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-stale-2");
		runGit(["worktree", "add", "-b", "auto-work/stale-test-2", worktreePath], repoCwd);
		startAutoWorkRun({
			taskId: staleTask.id,
			taskPriority: "P1",
			sessionId: "sess_gone_2",
			worktreePath,
		});

		// Lower priority than the stale task — must lose the re-selection.
		const freshTask = createTask({ title: "Fresh backlog task", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_new", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});

		// The stale row is retired, its task re-routed to backlog, and — since
		// the snapshot is refreshed — that same task (P1 beats the fresh P5)
		// is retried immediately with a fresh session in the same cycle.
		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(staleTask.id);
		expect(result.sessionId).toBe("sess_new");

		expect(getTask(staleTask.id)?.stateId).toBe("s_validate");
		expect(getTask(freshTask.id)?.stateId).toBe("s_backlog");
		// The orphaned worktree was removed by the retire path — the retry ran
		// in a newly created worktree, never the stale one.
		expect(fs.existsSync(worktreePath)).toBe(false);
		expect(result.worktreePath).not.toBe(worktreePath);
	});
});

// ─── Notifications (T-67) ───────────────────────────────────────────────────

function recordingNotify(): {
	notify: (event: AutoWorkNotificationEvent) => Promise<void>;
	calls: AutoWorkNotificationEvent[];
} {
	const calls: AutoWorkNotificationEvent[] = [];
	return {
		calls,
		notify: async (event) => {
			calls.push(event);
		},
	};
}

describe("runAutoWorkCycle notifications (T-67)", () => {
	test("notifies task_started then task_completed with the PR number on a fresh successful run", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Ship the thing", cwd: repoCwd, priority: "P5", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_notify_1", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
			notify,
		});

		expect(result.outcome).toBe("completed");
		expect(calls).toEqual([
			{ kind: "task_started", displayId: task.displayId, title: task.title, model: "default" },
			{ kind: "task_completed", displayId: task.displayId, prNumber: 321 },
		]);
	});

	test("notifies task_failed with the timeout reason when a run times out", async () => {
		setAutoWorkConfig(repoCwd, {
			...DEFAULT_AUTO_WORK_VALUES,
			enabled: true,
			timeoutMinutesByPriority: { P0: 120, P1: 90, P2: 60, P3: 45, P4: 45, P5: 0.0005 },
		});
		const task = createTask({ title: "Slow task", cwd: repoCwd, priority: "P5", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_notify_timeout", null);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			notify,
		});

		expect(result.outcome).toBe("timed_out");
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual({ kind: "task_started", displayId: task.displayId, title: task.title, model: "default" });
		expect(calls[1]?.kind).toBe("task_failed");
		if (calls[1]?.kind === "task_failed") {
			expect(calls[1].displayId).toBe(task.displayId);
			expect(calls[1].reason).toContain("timeout");
		}
	});

	test("notifies task_completed_pr_failed (not task_completed) when PR creation fails", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "PR step fails", cwd: repoCwd, priority: "P5", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_notify_pr_fail", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: async () => {
				throw new Error("gh pr create failed (exit 1): no git remotes found");
			},
			notify,
		});

		expect(result.outcome).toBe("completed");
		// A PR-creation failure still gets its own (quieter) notification kind
		// so it's visible without being confused with a genuine PR-backed
		// completion — never the silent "task_started only" of before T-85,
		// and never the success-shaped "task_completed" either.
		expect(calls).toEqual([
			{ kind: "task_started", displayId: task.displayId, title: task.title, model: "default" },
			{
				kind: "task_completed_pr_failed",
				displayId: task.displayId,
				reason: "gh pr create failed (exit 1): no git remotes found",
			},
		]);
	});

	test("notifies weekly_threshold once usage crosses the configured threshold, even on a cycle that still starts a task", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true, weeklyPctThreshold: 70 });
		createTask({ title: "Under the hard limit", cwd: repoCwd, priority: "P5", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_notify_weekly", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			// Below weeklyPctLimit (100, default) so the cycle proceeds, but above
			// the 70% weeklyPctThreshold configured above.
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 75 }),
			createPullRequest: stubCreatePullRequest,
			notify,
		});

		expect(result.outcome).toBe("completed");
		expect(calls[0]).toEqual({ kind: "weekly_threshold", cwd: repoCwd, pctUsed: 75, thresholdPct: 70 });
	});

	test("notifies session_limit when every eligible task is skipped for budget reasons", async () => {
		setAutoWorkConfig(repoCwd, {
			...DEFAULT_AUTO_WORK_VALUES,
			enabled: true,
			sessionPctLimit: 1,
			weeklyPctLimit: 100,
			weeklyPctThreshold: 100,
		});
		createTask({ title: "Too expensive", cwd: repoCwd, priority: "P0", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_notify_session_limit", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			notify,
		});

		expect(result.outcome).toBe("skipped");
		expect(calls).toEqual([{ kind: "session_limit", sessionPctUsed: 5, sessionPctLimit: 1 }]);
	});

	test("prefers the weekly_threshold notification over session_limit when both conditions are true in the same cycle", async () => {
		setAutoWorkConfig(repoCwd, {
			...DEFAULT_AUTO_WORK_VALUES,
			enabled: true,
			sessionPctLimit: 1,
			weeklyPctLimit: 100,
			weeklyPctThreshold: 70,
		});
		createTask({ title: "Too expensive", cwd: repoCwd, priority: "P0", autoWork: true });
		const { notify, calls } = recordingNotify();

		const handle = new FakeSessionHandle("sess_notify_precedence", 10);
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			// Above both the 70% weekly threshold and (given sessionPctLimit=1)
			// enough to also make every eligible task fail to fit the budget.
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 80 }),
			notify,
		});

		expect(result.outcome).toBe("skipped");
		// Exactly one notification for the cycle — the weekly warning — never both.
		expect(calls).toEqual([{ kind: "weekly_threshold", cwd: repoCwd, pctUsed: 80, thresholdPct: 70 }]);
	});
});

// ─── Token and pct recording (T-80) ─────────────────────────────────────────

describe("runAutoWorkCycle token and pct recording (T-80)", () => {
	test("persists inputTokens, outputTokens, and pctConsumed on a completed run", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		createTask({ title: "Token tracking task", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_tokens_completed", 10);
		handle.usageRollup = { input: 1500, output: 800, cacheRead: 0, cacheWrite: 0, totalTokens: 2300, cost: 0.005 };

		let usageCallCount = 0;
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => {
				usageCallCount++;
				return { available: true, weeklyPct: usageCallCount === 1 ? 10 : 15 };
			},
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		const run = listAutoWorkRuns({})[0];
		expect(run?.inputTokens).toBe(1500);
		expect(run?.outputTokens).toBe(800);
		expect(run?.pctConsumed).toBe(5); // 15 - 10
	});

	test("clamps pctConsumed to zero when the subscription week resets during a completed run", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		createTask({ title: "Subscription reset task", cwd: repoCwd, priority: "P5", autoWork: true });

		let usageCallCount = 0;
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(new FakeSessionHandle("sess_pct_reset", 10)), {
			getSubscriptionUsage: async () => {
				usageCallCount++;
				return { available: true, weeklyPct: usageCallCount === 1 ? 70 : 2 };
			},
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		expect(listAutoWorkRuns({})[0]?.pctConsumed).toBe(0);
	});

	test("persists inputTokens, outputTokens, and pctConsumed even on a failed run", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Failing token task", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_tokens_failed", null);
		handle.usageRollup = { input: 400, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 600, cost: 0.001 };

		let usageCallCount = 0;
		const cycle = runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => {
				usageCallCount++;
				return { available: true, weeklyPct: usageCallCount === 1 ? 20 : 23 };
			},
			createPullRequest: async () => {
				throw new Error("must not create PR on failed run");
			},
		});
		await handle.subscriptionStarted;
		handle.emit({ type: "turn_end", message: { stopReason: "error" } });
		const result = await cycle;

		expect(result.outcome).toBe("failed");
		const run = listAutoWorkRuns({ taskId: task.id })[0];
		expect(run?.inputTokens).toBe(400);
		expect(run?.outputTokens).toBe(200);
		expect(run?.pctConsumed).toBe(3); // 23 - 20
	});

	test("stores null pctConsumed when end-of-run subscription lookup is unavailable", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		createTask({ title: "No end sub task", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_tokens_no_end_sub", 10);
		handle.usageRollup = { input: 300, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 400, cost: 0 };

		// First call (preflight) returns available so the run starts; second call (post-settle)
		// returns unavailable so the delta cannot be computed → pctConsumed must be null.
		let callCount = 0;
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => {
				callCount++;
				if (callCount === 1) return { available: true, weeklyPct: 12 };
				return { available: false };
			},
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		const run = listAutoWorkRuns({})[0];
		expect(run?.inputTokens).toBe(300);
		expect(run?.outputTokens).toBe(100);
		expect(run?.pctConsumed).toBeNull(); // end lookup unavailable → delta unknown
	});

	test("stores null tokens when snapshot provides no usageRollup", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		createTask({ title: "No rollup task", cwd: repoCwd, priority: "P5", autoWork: true });

		const handle = new FakeSessionHandle("sess_no_rollup", 10);
		// usageRollup left undefined (default)

		const result = await runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		const run = listAutoWorkRuns({})[0];
		expect(run?.inputTokens).toBeNull();
		expect(run?.outputTokens).toBeNull();
		// pctConsumed is 0 because both start and end weeklyPct = 5 (same stub each call)
		expect(run?.pctConsumed).toBe(0);
	});
});
// ─── Retry budget and failed-session cleanup (T-100) ───────────────────────

describe("runAutoWorkCycle retry budget and session cleanup (T-100)", () => {
	let seedSeq = 0;

	/**
	 * Seeds a closed run for `taskId` — prior history feeding the
	 * consecutive-failure streak. Each seed is backdated (minutes in the past,
	 * in insertion order) so ordering is deterministic without wall-clock
	 * sleeps: the cycle's own run always gets a strictly newer `started_at`
	 * than any seed, and `countConsecutiveAutoWorkFailures` orders by it.
	 */
	function seedClosedRun(taskId: string, status: "completed" | "failed"): void {
		seedSeq += 1;
		const runId = startAutoWorkRun({
			taskId,
			taskPriority: "P5",
			sessionId: `sess_seed_${seedSeq}`,
			worktreePath: `/tmp/aw-seed-${seedSeq}`,
		});
		completeAutoWorkRun(runId, { status, failureReason: status === "failed" ? "seeded failure" : undefined });
		const startedAt = new Date(Date.now() - 60_000 * (100 - seedSeq)).toISOString();
		getDb().prepare("UPDATE auto_work_runs SET started_at = ? WHERE id = ?").run(startedAt, runId);
	}

	/** Runs one cycle whose agent turn ends with a failing stop reason (same pattern as the aborted/max_tokens tests). */
	async function runFailingCycle(handle: FakeSessionHandle) {
		const cycle = runAutoWorkCycle(repoCwd, fakeBridge(handle), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: async () => {
				throw new Error("a failed run must not create a pull request");
			},
		});
		await handle.subscriptionStarted;
		handle.emit({ type: "turn_end", message: { stopReason: "error" } });
		return cycle;
	}

	test("a failure with retry budget left returns the task to backlog with the remaining-attempts note and disposes the session", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "One prior failure", cwd: repoCwd, priority: "P5", autoWork: true });
		seedClosedRun(task.id, "failed");

		const handle = new FakeSessionHandle("sess_budget_left", null);
		const result = await runFailingCycle(handle);

		expect(result.outcome).toBe("failed");
		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_backlog");
		expect(updated?.body).toContain("1 automatic retry attempt(s) remaining");
		expect(updated?.body).not.toContain("MAX_RETRIES_EXCEEDED");
		expect(listAutoWorkRuns({ taskId: task.id })[0]?.status).toBe("failed");
		// T-100: a written-off run must release its live session handle.
		expect(handle.disposeCalls).toBeGreaterThanOrEqual(1);
	});

	test("the third consecutive failure exhausts the budget: task parks in blocked with a MAX_RETRIES_EXCEEDED note", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Two prior failures", cwd: repoCwd, priority: "P5", autoWork: true });
		seedClosedRun(task.id, "failed");
		seedClosedRun(task.id, "failed");

		const handle = new FakeSessionHandle("sess_budget_exhausted", null);
		const result = await runFailingCycle(handle);

		expect(result.outcome).toBe("failed");
		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_blocked");
		expect(updated?.body).toContain("MAX_RETRIES_EXCEEDED");
		expect(updated?.body).not.toContain("automatic retry attempt(s) remaining");
		expect(listAutoWorkRuns({ taskId: task.id })[0]?.status).toBe("failed");
		expect(handle.disposeCalls).toBeGreaterThanOrEqual(1);
	});

	test("the next cycle selects another backlog task instead of re-running the exhausted one", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		// Created first, so if the exhausted task ever leaked back to backlog it
		// would sit at order 0 and win selection — making this test fail loudly.
		const exhausted = createTask({ title: "Exhausted task", cwd: repoCwd, priority: "P5", autoWork: true });
		seedClosedRun(exhausted.id, "failed");
		seedClosedRun(exhausted.id, "failed");
		await runFailingCycle(new FakeSessionHandle("sess_exhausting_run", null));
		expect(getTask(exhausted.id)?.stateId).toBe("s_blocked");
		const exhaustedRunCount = listAutoWorkRuns({ taskId: exhausted.id }).length;

		const other = createTask({ title: "Fresh backlog task", cwd: repoCwd, priority: "P5", autoWork: true });
		const okHandle = new FakeSessionHandle("sess_other_task", 10);
		const createSessionCalls: CreateSessionOpts[] = [];
		const result = await runAutoWorkCycle(repoCwd, fakeBridge(okHandle, { createSessionCalls }), {
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
			createPullRequest: stubCreatePullRequest,
		});

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(other.id);
		// The exhausted task stays parked: still blocked, no new session, no new run row.
		expect(getTask(exhausted.id)?.stateId).toBe("s_blocked");
		expect(createSessionCalls).toHaveLength(1);
		expect(listAutoWorkRuns({ taskId: exhausted.id })).toHaveLength(exhaustedRunCount);
	});

	test("a successful run resets the failure streak: the next failure returns to backlog instead of blocked", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Streak reset by success", cwd: repoCwd, priority: "P5", autoWork: true });
		seedClosedRun(task.id, "failed");
		seedClosedRun(task.id, "failed");
		seedClosedRun(task.id, "completed");

		const handle = new FakeSessionHandle("sess_streak_reset", null);
		const result = await runFailingCycle(handle);

		expect(result.outcome).toBe("failed");
		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_backlog");
		expect(updated?.body).toContain("2 automatic retry attempt(s) remaining");
		expect(updated?.body).not.toContain("MAX_RETRIES_EXCEEDED");
	});
});

describe("runAutoWorkCycle retry resume and launch resilience (T-104/T-105)", () => {
	/** Seeds a closed failed run whose session/worktree a retry may pick back up. */
	function seedFailedRun(taskId: string, sessionId: string, worktreePath: string, failureReason = "agent turn ended (stopReason: error)"): string {
		const runId = startAutoWorkRun({ taskId, taskPriority: "P5", sessionId, worktreePath });
		completeAutoWorkRun(runId, { status: "failed", failureReason });
		const startedAt = new Date(Date.now() - 60_000).toISOString();
		getDb().prepare("UPDATE auto_work_runs SET started_at = ? WHERE id = ?").run(startedAt, runId);
		return runId;
	}

	function persistedSummary(sessionId: string, cwd: string): SessionSummary {
		const now = new Date().toISOString();
		return {
			id: sessionId,
			path: `/tmp/sessions/${sessionId}.jsonl`,
			cwd,
			createdAt: now,
			updatedAt: now,
			messageCount: 4,
		};
	}

	test("a retry resumes the prior failed run's session in its worktree instead of creating a new session", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Retry resumes context", cwd: repoCwd, priority: "P5", autoWork: true });
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-prior-attempt");
		fs.mkdirSync(worktreePath, { recursive: true });
		const priorRunId = seedFailedRun(task.id, "sess_prior", worktreePath);

		const resumedHandle = new FakeSessionHandle("sess_prior", 10);
		const decoyHandle = new FakeSessionHandle("sess_decoy", 10);
		const createSessionCalls: CreateSessionOpts[] = [];
		const result = await runAutoWorkCycle(
			repoCwd,
			fakeBridge(decoyHandle, {
				createSessionCalls,
				persistedSessions: [persistedSummary("sess_prior", worktreePath)],
				liveSessions: new Map([["sess_prior", resumedHandle]]),
			}),
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		// Same session and worktree as the failed attempt — never a fresh session.
		expect(result.sessionId).toBe("sess_prior");
		expect(result.worktreePath).toBe(worktreePath);
		expect(createSessionCalls).toHaveLength(0);
		// The resumed session gets a continuation prompt naming the prior run
		// and its failure, not the fresh first-turn prompt.
		expect(resumedHandle.prompts).toHaveLength(1);
		expect(resumedHandle.prompts[0]).toContain("Reintento");
		expect(resumedHandle.prompts[0]).toContain(priorRunId);
		expect(resumedHandle.prompts[0]).toContain(worktreePath);
		expect(resumedHandle.prompts[0]).toContain("stopReason: error");
		// The retry is its own run row, pointing at the resumed session.
		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs).toHaveLength(2);
		expect(runs[0]).toEqual(expect.objectContaining({ status: "completed", sessionId: "sess_prior", worktreePath }));
	});

	test("a retry whose prior worktree is gone starts a fresh session", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Prior worktree removed", cwd: repoCwd, priority: "P5", autoWork: true });
		seedFailedRun(task.id, "sess_gone_worktree", path.join(repoCwd, ".worktrees", "aw-deleted"));

		const freshHandle = new FakeSessionHandle("sess_fresh_1", 10);
		const createSessionCalls: CreateSessionOpts[] = [];
		const result = await runAutoWorkCycle(
			repoCwd,
			fakeBridge(freshHandle, {
				createSessionCalls,
				persistedSessions: [persistedSummary("sess_gone_worktree", path.join(repoCwd, ".worktrees", "aw-deleted"))],
				liveSessions: new Map([["sess_gone_worktree", new FakeSessionHandle("sess_gone_worktree", 10)]]),
			}),
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.sessionId).toBe("sess_fresh_1");
		expect(createSessionCalls).toHaveLength(1);
		expect(freshHandle.prompts[0]).toContain("Trabaja en T-");
	});

	test("a retry whose prior session transcript is gone starts a fresh session", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Prior session purged", cwd: repoCwd, priority: "P5", autoWork: true });
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-still-here");
		fs.mkdirSync(worktreePath, { recursive: true });
		seedFailedRun(task.id, "sess_purged", worktreePath);

		const freshHandle = new FakeSessionHandle("sess_fresh_2", 10);
		const createSessionCalls: CreateSessionOpts[] = [];
		const result = await runAutoWorkCycle(
			repoCwd,
			fakeBridge(freshHandle, { createSessionCalls }),
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.sessionId).toBe("sess_fresh_2");
		expect(createSessionCalls).toHaveLength(1);
		expect(getTask(task.id)?.stateId).toBe("s_validate");
	});

	test("a session that fails to launch parks the task in blocked instead of aborting the cycle (T-105)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Launch failure", cwd: repoCwd, priority: "P5", autoWork: true });
		const events: AutoWorkNotificationEvent[] = [];

		const result = await runAutoWorkCycle(
			repoCwd,
			fakeBridge(new FakeSessionHandle("sess_never_used", 10), {
				createSessionError: new Error("spawn agent-worker ENOENT\nstack trace noise"),
			}),
			{
				getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
				notify: async (event) => {
					events.push(event);
				},
				createPullRequest: async () => {
					throw new Error("a failed launch must not create a pull request");
				},
			},
		);

		expect(result.outcome).toBe("skipped");
		if (result.outcome !== "skipped") throw new Error("expected skipped");
		expect(result.reason).toContain("agent session launch failed: spawn agent-worker ENOENT");
		const updated = getTask(task.id);
		expect(updated?.stateId).toBe("s_blocked");
		expect(updated?.body).toContain("**Auto Work launch failed**");
		// No run row exists — the session never started, so there is nothing to settle.
		expect(listAutoWorkRuns({ taskId: task.id })).toHaveLength(0);
		expect(events).toEqual([
			{ kind: "task_failed", displayId: task.displayId, reason: expect.stringContaining("agent session launch failed") },
		]);
	});

	test("a resume failure on a running row closes the run and the cycle continues instead of wedging the mutex (T-105)", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Wedged running row", cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(task.id, "s_active", 0);
		const worktreePath = path.join(repoCwd, ".worktrees", "aw-wedged");
		fs.mkdirSync(worktreePath, { recursive: true });
		const wedgedRunId = startAutoWorkRun({ taskId: task.id, taskPriority: "P5", sessionId: "sess_wedged", worktreePath });

		// The persisted summary exists but resuming it throws (fakeBridge has no
		// live handle registered for it) — the corrupt-transcript case.
		const freshHandle = new FakeSessionHandle("sess_recovered", 10);
		const createSessionCalls: CreateSessionOpts[] = [];
		const result = await runAutoWorkCycle(
			repoCwd,
			fakeBridge(freshHandle, {
				createSessionCalls,
				persistedSessions: [persistedSummary("sess_wedged", worktreePath)],
			}),
			{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
		);

		// The wedged run is closed as failed with the resume error preserved…
		const wedgedRun = listAutoWorkRuns({ taskId: task.id }).find((r) => r.id === wedgedRunId);
		expect(wedgedRun?.status).toBe("failed");
		expect(wedgedRun?.failureReason).toContain("session_resume_failed:");
		// …and the same cycle moves on: the task returns to backlog, is
		// re-selected, and (the retry resume also failing) runs fresh to completion.
		expect(result.outcome).toBe("completed");
		if (result.outcome !== "completed") throw new Error("expected completed");
		expect(result.taskId).toBe(task.id);
		expect(result.sessionId).toBe("sess_recovered");
		expect(createSessionCalls).toHaveLength(1);
	});

	test("a broken KB root still launches the session with the bundled auto-work prompt (T-105)", async () => {
		const savedKbRoot = process.env.OMP_DECK_KB_ROOT;
		// A regular file where a directory is expected — every KB read fails.
		const bogusRoot = path.join(os.tmpdir(), `omp-deck-broken-kb-${Date.now()}`);
		fs.writeFileSync(bogusRoot, "not a directory\n");
		process.env.OMP_DECK_KB_ROOT = bogusRoot;
		try {
			setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
			createTask({ title: "Broken KB root", cwd: repoCwd, priority: "P5", autoWork: true });
			const createSessionCalls: CreateSessionOpts[] = [];
			const result = await runAutoWorkCycle(
				repoCwd,
				fakeBridge(new FakeSessionHandle("sess_broken_kb", 10), { createSessionCalls }),
				{ getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }), createPullRequest: stubCreatePullRequest },
			);

			expect(result.outcome).toBe("completed");
			expect(createSessionCalls).toHaveLength(1);
			expect(createSessionCalls[0]?.systemPromptAppend).toBe(AUTO_WORK_RULES_BODY);
		} finally {
			if (savedKbRoot === undefined) delete process.env.OMP_DECK_KB_ROOT;
			else process.env.OMP_DECK_KB_ROOT = savedKbRoot;
			fs.rmSync(bogusRoot, { force: true });
		}
	});
});

describe("reconcileAutoMergedRuns (fully-autonomous mode)", () => {
	function seedPendingMergeRun(prNumber: number, worktreePath: string) {
		const task = createTask({ title: `pending #${prNumber}`, cwd: repoCwd, priority: "P5", autoWork: true });
		moveTask(task.id, "s_validate", 0);
		const runId = startAutoWorkRun({ taskId: task.id, taskPriority: "P5", sessionId: `sess_${prNumber}`, worktreePath });
		completeAutoWorkRun(runId, { status: "completed_pending_merge", prNumber });
		return { task, runId };
	}

	test("promotes a merged pending run to done, deletes the remote branch, updates the local repo, and removes the worktree", async () => {
		const { task } = seedPendingMergeRun(321, "/tmp/wt-merged");
		const updatedLocal: string[] = [];
		const removed: string[] = [];
		const deletedBranches: string[] = [];
		const { notify, calls } = recordingNotify();

		const n = await reconcileAutoMergedRuns({
			inspectPullRequest: async () => ({ state: "merged", checks: "passing", headRefName: "auto-work/t1-merged" }),
			mergePullRequest: async () => {
				throw new Error("must not merge an already-merged PR");
			},
			deleteRemoteBranch: async (_cwd, branch) => {
				deletedBranches.push(branch);
			},
			updateLocalRepo: async (cwd) => {
				updatedLocal.push(cwd);
			},
			removeWorktree: async (_repo, wt) => {
				removed.push(wt);
			},
			notify,
		});

		expect(n).toBe(1);
		expect(getTask(task.id)?.stateId).toBe("s_done");
		expect(updatedLocal).toEqual([repoCwd]);
		expect(removed).toEqual(["/tmp/wt-merged"]);
		expect(deletedBranches).toEqual(["auto-work/t1-merged"]);
		expect(listAutoWorkRuns({ taskId: task.id })[0]?.status).toBe("completed");
		expect(calls).toContainEqual({ kind: "task_auto_merged", displayId: task.displayId, prNumber: 321 });
	});

	test("merges an open pending run itself once CI is green", async () => {
		const { task } = seedPendingMergeRun(55, "/tmp/wt-green");
		const mergedPrs: number[] = [];
		const { notify, calls } = recordingNotify();

		const n = await reconcileAutoMergedRuns({
			inspectPullRequest: async () => ({ state: "open", checks: "passing", headRefName: "auto-work/t2-green" }),
			mergePullRequest: async (_cwd, prNumber) => {
				mergedPrs.push(prNumber);
			},
			deleteRemoteBranch: async () => {},
			updateLocalRepo: async () => {},
			removeWorktree: async () => {},
			notify,
		});

		expect(n).toBe(1);
		expect(mergedPrs).toEqual([55]);
		expect(getTask(task.id)?.stateId).toBe("s_done");
		expect(listAutoWorkRuns({ taskId: task.id })[0]?.status).toBe("completed");
		expect(calls).toContainEqual({ kind: "task_auto_merged", displayId: task.displayId, prNumber: 55 });
	});

	test("leaves the run pending when CI is green but the merge itself fails", async () => {
		const { task } = seedPendingMergeRun(56, "/tmp/wt-merge-fail");
		const { notify, calls } = recordingNotify();

		const n = await reconcileAutoMergedRuns({
			inspectPullRequest: async () => ({ state: "open", checks: "passing" }),
			mergePullRequest: async () => {
				throw new Error("merge conflict with base");
			},
			deleteRemoteBranch: async () => {},
			updateLocalRepo: async () => {},
			removeWorktree: async () => {},
			notify,
		});

		expect(n).toBe(0);
		expect(getTask(task.id)?.stateId).toBe("s_validate");
		expect(listAutoWorkRuns({ taskId: task.id })[0]?.status).toBe("completed_pending_merge");
		expect(calls).toHaveLength(0);
	});

	test("moves the task to blocked when CI fails, keeping the worktree for a human fix", async () => {
		const { task } = seedPendingMergeRun(57, "/tmp/wt-red");
		const removed: string[] = [];
		const { notify, calls } = recordingNotify();

		const n = await reconcileAutoMergedRuns({
			inspectPullRequest: async () => ({ state: "open", checks: "failing" }),
			mergePullRequest: async () => {
				throw new Error("must not merge a red PR");
			},
			deleteRemoteBranch: async () => {},
			updateLocalRepo: async () => {},
			removeWorktree: async (_repo, wt) => {
				removed.push(wt);
			},
			notify,
		});

		expect(n).toBe(1);
		expect(getTask(task.id)?.stateId).toBe("s_blocked");
		expect(removed).toEqual([]);
		const run = listAutoWorkRuns({ taskId: task.id })[0];
		expect(run?.status).toBe("failed");
		expect(run?.failureReason).toContain("CI failed");
		expect(calls[0]?.kind).toBe("task_failed");
	});

	test("moves a closed-unmerged pending run's task to blocked and fails the run", async () => {
		const { task } = seedPendingMergeRun(99, "/tmp/wt-closed");
		const removed: string[] = [];
		const { notify, calls } = recordingNotify();

		const n = await reconcileAutoMergedRuns({
			inspectPullRequest: async () => ({ state: "closed", checks: "pending" }),
			mergePullRequest: async () => {},
			deleteRemoteBranch: async () => {},
			updateLocalRepo: async () => {},
			removeWorktree: async (_repo, wt) => {
				removed.push(wt);
			},
			notify,
		});

		expect(n).toBe(1);
		expect(getTask(task.id)?.stateId).toBe("s_blocked");
		expect(removed).toEqual(["/tmp/wt-closed"]);
		expect(listAutoWorkRuns({ taskId: task.id })[0]?.status).toBe("failed");
		expect(calls[0]?.kind).toBe("task_failed");
	});

	test("leaves a still-open pending run untouched while CI is pending", async () => {
		const { task } = seedPendingMergeRun(7, "/tmp/wt-open");
		const { notify, calls } = recordingNotify();

		const n = await reconcileAutoMergedRuns({
			inspectPullRequest: async () => ({ state: "open", checks: "pending" }),
			mergePullRequest: async () => {},
			deleteRemoteBranch: async () => {},
			updateLocalRepo: async () => {},
			removeWorktree: async () => {},
			notify,
		});

		expect(n).toBe(0);
		expect(getTask(task.id)?.stateId).toBe("s_validate");
		expect(listAutoWorkRuns({ taskId: task.id })[0]?.status).toBe("completed_pending_merge");
		expect(calls).toHaveLength(0);
	});
});
