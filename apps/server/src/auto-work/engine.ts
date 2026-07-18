/**
 * Auto Work execution engine (T-64) — the core loop that selects the next
 * eligible task, checks budgets and the time window, creates a worktree,
 * launches an agent session, and waits for it to reach a terminal state.
 *
 * Design: the decision logic (`checkAutoWorkPreflight`, `selectNextAutoWorkTask`,
 * `costFitsAutoWorkBudget`) is pure — it takes already-fetched data as plain
 * arguments and never touches the DB, the filesystem, or the bridge. This
 * makes it unit-testable without a live database or agent session. The only
 * side-effecting piece is the `runAutoWorkCycle` orchestrator, which fetches
 * the data, calls the pure functions, and — only once they agree a task
 * should run — creates the worktree, calls `bridge.createSession()`, and
 * drives the DB writes (`moveTask`, `startAutoWorkRun`, `completeAutoWorkRun`).
 *
 * "Terminal state" detection reuses the exact mechanism the idle-session
 * reaper uses internally (see `bridge/in-process.ts`): subscribe to the
 * session's event stream and watch for a `turn_start` → `turn_end`/`agent_end`
 * pair. There is no separate "auto-work done" event type — turn completion
 * *is* terminal state for a one-shot session.
 *
 * On a successful run, `settleAutoWorkRun` opens a PR from the worktree
 * branch, appends a session-link + PR-reference note to the task body, and
 * moves the task to `validate` (never `done` — every auto-work result is
 * human-reviewed) before closing the run row `status: "completed"`. If the
 * validate state is unavailable, it safely parks the task in `blocked` with
 * an actionable reason. When `gh pr create` itself fails, the implementation
 * is still complete and the run closes as `status: "completed_pr_failed"`
 * with an actionable `failureReason` instead — distinct from a real success
 * (T-85).
 *
 * Explicitly out of scope here (later tickets in the stack):
 *  - T-67: notifications. Lifecycle transitions are logged at info/warn so a
 *    notifier can hook the log stream later.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Subprocess } from "bun";

import type {
	AutoWorkConfig,
	AutoWorkCycleResult,
	AutoWorkGlobalConfig,
	AutoWorkRun,
	ModelRef,
	Task,
	TaskDifficulty,
	TaskPriority,
} from "@omp-deck/protocol";

import type { AgentBridge, SessionHandle } from "../bridge/types.ts";
import { loadConfig } from "../config.ts";
import { buildSessionUrl } from "../deck-links.ts";
import { getAutoWorkConfig } from "../db/auto-work.ts";
import { getAutoWorkGlobalConfig } from "../db/auto-work-global.ts";
import { resolveIntegrationPrompt, type IntegrationPromptName } from "../integration-prompts.ts";
import { KB_TEMPLATES } from "../kb-templates.ts";
import { KbService, resolveKbRoot, resolveProjectBranchPolicy } from "../kb-service.ts";
import { completeAutoWorkRun, countConsecutiveAutoWorkFailures, listAutoWorkRuns, startAutoWorkRun } from "../db/auto-work-runs.ts";
import { getDeckBaseUrl as getServerDeckBaseUrl } from "../db/server-settings.ts";
import { findStateByName, getTask, listTasks, moveTask, updateTask } from "../db/tasks.ts";
import { getWorkspacePreference } from "../db/workspace-preferences.ts";
import { logger } from "../log.ts";
import { notify as sendAutoWorkNotification } from "./notify.ts";
import { maybeAutoTitleSession } from "../session-title.ts";
import type { AutoWorkNotificationEvent } from "./notify.ts";
import { getSubscriptionUsage } from "../usage-subscription.ts";
import { estimateTaskCostPct } from "./estimate.ts";
import { broadcastBus } from "../broadcast-bus.ts";
import { getModelCatalogOverlay } from "../model-catalog-overlay.ts";
import { assertNoSecretsInDiff, assertNoSensitiveContent } from "./pr-content-guard.ts";

const log = logger("auto-work:engine");

const PRIORITY_ORDER: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

/** Ordered from highest to lowest effort — cascade walks downward only. */
const DIFFICULTY_CASCADE: TaskDifficulty[] = ["hard", "medium", "easy"];


/** Run ids with a live engine finalizer. They are never stale, even between terminal event delivery and DB completion. */
const activeRunIds = new Set<string>();
const STALE_RUN_GRACE_MS = 60_000;

/**
 * True when this process has a live `finalizeAutoWorkRun` awaiting `runId`'s
 * terminal event — the authoritative "is a running row genuinely in flight
 * here" signal (T-106). A truthy `bridge.getSession(run.sessionId)` is NOT
 * sufficient: after a restart it can resurrect a persisted handle from disk
 * even though nothing in this process is watching it finish.
 */
export function hasActiveAutoWorkRunFinalizer(runId: string): boolean {
	return activeRunIds.has(runId);
}

/** Run ids explicitly stopped by the user or operator, preventing within-run abort retries for those runs. */
const intentionallyStoppedRunIds = new Set<string>();

/**
 * Called by the stop route before `handle.abort()` so the live finalizer
 * knows the abort was intentional and skips the within-run retry path for
 * `aborted` terminal events.
 */
export function markRunIntentionallyStopped(runId: string): void {
	intentionallyStoppedRunIds.add(runId);
}

// ─── Pure decision logic ────────────────────────────────────────────────────

export interface AutoWorkPreflightInput {
	config: AutoWorkConfig;
	/** Wall-clock time to evaluate the time window against (server-local hour). */
	now: Date;
	/** Subscription usage % consumed so far this week, or `null` when unavailable. */
	subscriptionPctUsed: number | null;
	/** Subscription usage % consumed in the shortest (session) window, or `null` when unavailable. */
	sessionPctUsed: number | null;
	/** Auto-work runs already scoped to this workspace (any status — the check filters for `running`). */
	activeRuns: AutoWorkRun[];
}

export type AutoWorkPreflightResult = { ok: true } | { ok: false; reason: string };

/**
 * Pre-flight checks, in order: workspace enabled, within the configured time
 * window, subscription usage below `weeklyPctLimit`, and no other run
 * currently active for this workspace (mutex via `auto_work_runs`).
 */
export function checkAutoWorkPreflight(input: AutoWorkPreflightInput): AutoWorkPreflightResult {
	const { config, now, subscriptionPctUsed, sessionPctUsed, activeRuns } = input;

	if (!config.enabled) {
		return { ok: false, reason: "auto-work is disabled for this workspace" };
	}

	const hour = now.getHours();
	const inWindow = config.timeWindows.some((w) => hour >= w.start && hour < w.end);
	if (!inWindow) {
		const windows = config.timeWindows.map((w) => `${w.start}-${w.end}`).join(", ");
		return {
			ok: false,
			reason: `current hour (${hour}) is outside the configured run window(s) ${windows}`,
		};
	}

	if (subscriptionPctUsed === null) {
		return { ok: false, reason: "subscription usage is unavailable — refusing to run blind" };
	}
	if (subscriptionPctUsed >= config.weeklyPctLimit) {
		return {
			ok: false,
			reason: `subscription usage (${subscriptionPctUsed.toFixed(1)}%) is at or above the weekly limit (${config.weeklyPctLimit}%)`,
		};
	}

	if (sessionPctUsed !== null && sessionPctUsed >= 100) {
		return {
			ok: false,
			reason: `session budget is fully exhausted (${sessionPctUsed.toFixed(1)}%) — waiting for session window to reset`,
		};
	}

	if (activeRuns.some((r) => r.status === "running")) {
		return { ok: false, reason: "another auto-work run is already active for this workspace" };
	}

	return { ok: true };
}

/**
 * Does an estimated cost fit the remaining budget? Two independent caps:
 * the estimate alone must not exceed the per-run `sessionPctLimit`, and
 * adding it to what's already been consumed this week must not cross
 * `weeklyPctLimit`.
 */
export function costFitsAutoWorkBudget(
	estimatedPct: number,
	currentPctUsed: number,
	config: AutoWorkConfig,
): boolean {
	return estimatedPct <= config.sessionPctLimit && currentPctUsed + estimatedPct <= config.weeklyPctLimit;
}

export interface TaskSelectionInput {
	/** Tasks already scoped to the workspace being considered. */
	tasks: Task[];
	config: AutoWorkConfig;
	/** Subscription usage % consumed so far this week (0 when unavailable — preflight already gates that case). */
	currentPctUsed: number;
	backlogStateId: string;
	doneStateId: string;
	/** Injected rather than calling `estimateTaskCostPct` directly, so this stays DB-free and pure. */
	estimateCostPct: (priority: TaskPriority) => number;
	/**
	 * Pin selection to this exact task id. Set by `runGlobalAutoWorkCycle`
	 * so the winner it announced is exactly the task the inner cycle runs.
	 * A pinned task that is no longer eligible or affordable yields
	 * `pinned_unavailable` — never a silently different task.
	 */
	pinnedTaskId?: string;
}

export type TaskSelectionResult =
	| { kind: "selected"; task: Task; estimatedCostPct: number }
	| { kind: "none_eligible" }
	| { kind: "none_fit"; consideredCount: number }
	| { kind: "pinned_unavailable" };

/**
 * `autoWork=true` AND `stateId=backlog` AND every `dependsOn` task is
 * `done` → sorted by priority (P0 first) then `orderInState`. Walks the
 * sorted list and returns the first task whose estimated cost fits the
 * budget; skips (does not just stop at) tasks that don't fit, since a lower
 * priority task further down the list may still be affordable.
 */
export function selectNextAutoWorkTask(input: TaskSelectionInput): TaskSelectionResult {
	const { tasks, config, currentPctUsed, backlogStateId, doneStateId, estimateCostPct, pinnedTaskId } = input;
	const tasksById = new Map(tasks.map((t) => [t.id, t]));

	const eligible = tasks
		.filter((t) => t.autoWork && t.stateId === backlogStateId)
		.filter((t) => t.dependsOn.every((depId) => tasksById.get(depId)?.stateId === doneStateId))
		.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.orderInState - b.orderInState);

	if (pinnedTaskId !== undefined) {
		const pinned = eligible.find((t) => t.id === pinnedTaskId);
		if (!pinned) return { kind: "pinned_unavailable" };
		const estimatedCostPct = estimateCostPct(pinned.priority);
		if (!costFitsAutoWorkBudget(estimatedCostPct, currentPctUsed, config)) {
			return { kind: "pinned_unavailable" };
		}
		return { kind: "selected", task: pinned, estimatedCostPct };
	}

	if (eligible.length === 0) return { kind: "none_eligible" };

	for (const task of eligible) {
		const estimatedCostPct = estimateCostPct(task.priority);
		if (costFitsAutoWorkBudget(estimatedCostPct, currentPctUsed, config)) {
			return { kind: "selected", task, estimatedCostPct };
		}
	}

	return { kind: "none_fit", consideredCount: eligible.length };
}

/** Per-priority timeout lookup (minutes), configurable via `AutoWorkConfig.timeoutMinutesByPriority`. */
export function resolveAutoWorkTimeoutMinutes(priority: TaskPriority, config: AutoWorkConfig): number {
	return config.timeoutMinutesByPriority[priority];
}

/**
 * Model resolution (T-109): tries the task's difficulty in each config tier
 * (workspace, then global), cascading to lower difficulties only
 * (hard→medium→easy) before falling back to the workspace default model.
 */
export function resolveAutoWorkModel(
	difficulty: TaskDifficulty,
	config: AutoWorkConfig,
	globalConfig: AutoWorkGlobalConfig,
	workspaceDefaultModel: ModelRef | null,
): ModelRef | undefined {
	const startIdx = DIFFICULTY_CASCADE.indexOf(difficulty);
	// Walk workspace mapping from task difficulty downward.
	for (let i = startIdx; i < DIFFICULTY_CASCADE.length; i++) {
		const m = config.modelByDifficulty[DIFFICULTY_CASCADE[i]!];
		if (m !== null) return m;
	}
	// Walk global mapping from task difficulty downward.
	for (let i = startIdx; i < DIFFICULTY_CASCADE.length; i++) {
		const m = globalConfig.modelByDifficulty[DIFFICULTY_CASCADE[i]!];
		if (m !== null) return m;
	}
	return workspaceDefaultModel ?? undefined;
}

export type RunningAutoWorkRunClassification = "resume" | "reconnect" | "stale";

/**
 * Classifies a `status: "running"` `auto_work_runs` row found at the start
 * of a cycle (T-65). `sessionExists`/`worktreeExists` are resolved by the
 * caller — this stays pure so the three outcomes are unit-testable without
 * a bridge or filesystem:
 *
 *  - session alive, worktree present → `"resume"`: pick the run back up and
 *    wait for it to reach a terminal state; skip task selection entirely.
 *  - session alive, worktree gone → `"reconnect"`: same as resume, but the
 *    directory the agent was writing to disappeared out from under it (e.g.
 *    manual cleanup). Let the agent finish in whatever state it's in.
 *  - session gone (no live handle and nothing persisted to `resumeSession`
 *    from) → `"stale"`: unrecoverable. Caller fails the run, returns the
 *    task to backlog, and removes the worktree before falling through to
 *    normal task selection.
 */
export function classifyRunningAutoWorkRun(
	_run: AutoWorkRun,
	sessionExists: boolean,
	worktreeExists: boolean,
): RunningAutoWorkRunClassification {
	if (!sessionExists) return "stale";
	return worktreeExists ? "resume" : "reconnect";
}

export interface SqueezeGateInput {
	/** Wall-clock time to evaluate against. */
	now: Date;
	/** The normal polling cadence (minutes) — the horizon squeeze mode measures against. */
	scheduleIntervalMinutes: number;
	/** % consumed so far in the shortest (session) usage window, 0-100. */
	sessionPct: number;
	/** ISO-8601 reset time for the session window. */
	sessionResetAt: string;
	/** Workspaces with at least one eligible backlog task right now. */
	eligibleWorkspaceCount: number;
}

/** Below this session-window usage, unused capacity is still worth squeezing. */
const SQUEEZE_SESSION_PCT_CEILING = 70;
/** Ask only when the session window resets within this many normal polling ticks. */
const SQUEEZE_TICK_HORIZON = 2;

/**
 * Pure pre-filter for squeeze mode (T-75): is it even worth the cost of an
 * LLM call to ask whether Auto Work should start another cycle right now
 * instead of waiting for the next scheduled tick? Only true when the
 * session usage window is close enough to reset that the normal cadence
 * risks leaving real unused capacity on the table — resetting within under
 * `SQUEEZE_TICK_HORIZON` ticks while still under `SQUEEZE_SESSION_PCT_CEILING`%
 * consumed — AND there is eligible backlog work to spend it on.
 */
export function shouldConsiderSqueeze(input: SqueezeGateInput): boolean {
	if (input.eligibleWorkspaceCount <= 0) return false;
	if (input.sessionPct >= SQUEEZE_SESSION_PCT_CEILING) return false;
	const minutesToReset = (Date.parse(input.sessionResetAt) - input.now.getTime()) / 60_000;
	if (!Number.isFinite(minutesToReset) || minutesToReset <= 0) return false;
	const intervalMinutes = Math.max(1, input.scheduleIntervalMinutes);
	return minutesToReset < intervalMinutes * SQUEEZE_TICK_HORIZON;
}

// ─── Agent History helpers (T-83) ───────────────────────────────────────────

const AGENT_HISTORY_HEADING = "## Agent History";

/**
 * Extracts the raw text of the `## Agent History` section (heading excluded)
 * from a task body. Returns `null` when the section is absent or empty.
 *
 * The section boundary ends at the next same-level `## ` heading or at the
 * end of the string, whichever comes first.
 */
export function extractAgentHistory(body: string): string | null {
	const idx = body.indexOf(AGENT_HISTORY_HEADING);
	if (idx === -1) return null;
	const afterHeading = body.slice(idx + AGENT_HISTORY_HEADING.length);
	// Stop at the next same-level heading.
	const nextSection = afterHeading.search(/\n## /);
	const raw = nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);
	const content = raw.trim();
	return content || null;
}

/**
 * Appends a new timestamped entry to the `## Agent History` section of
 * `body`. When the section is absent it is created at the end. All other
 * sections are left intact.
 *
 * Entry format:
 * ```
 * ### <timestamp> — run <runId>
 * <summary>
 * ```
 */
export function appendAgentHistoryEntry(
	body: string,
	runId: string,
	timestamp: string,
	summary: string,
): string {
	const entry = `\n\n### ${timestamp} — run ${runId}\n${summary}`;
	const trimmed = body.trimEnd();
	if (!trimmed.includes(AGENT_HISTORY_HEADING)) {
		return `${trimmed}\n\n${AGENT_HISTORY_HEADING}${entry}`;
	}
	return `${trimmed}${entry}`;
}

// ─── Orchestrator (IO) ──────────────────────────────────────────────────────

export interface RunAutoWorkCycleOptions {
	/**
	 * Sends a lifecycle/budget notification (T-67). Defaults to the real
	 * Telegram-backed `notify()` in `./notify.ts`. Injectable for tests so
	 * they can assert calls without a bot token or real Telegram API calls.
	 */
	notify?: (event: AutoWorkNotificationEvent) => Promise<void>;
	/** Injectable for tests — defaults to the real cached subscription-usage lookup. */
	getSubscriptionUsage?: () => Promise<{ available: boolean; weeklyPct?: number; sessionPct?: number }>;
	/** Injectable clock for tests — defaults to `new Date()`. */
	now?: () => Date;
	/**
	 * Resolves the deck base URL used to build the session link appended to a
	 * completed task's body (T-66). Defaults to the real T-61 setting via
	 * `getDeckBaseUrl(loadConfig())`. Injectable for tests so they don't need
	 * a real `Config`/on-disk `server_settings` row.
	 */
	getDeckBaseUrl?: () => string;
	/**
	 * Opens the PR for a successfully completed run (T-66). Defaults to a
	 * real `gh pr create` invocation via `Bun.spawn`. Injectable for tests —
	 * a test must NEVER let the real default run, since that would shell out
	 * to `gh` and attempt to open an actual GitHub PR.
	 */
	createPullRequest?: (params: CreatePullRequestParams) => Promise<CreatePullRequestResult>;
	/**
	 * Arms GitHub auto-merge on a run's PR when the workspace has `autoMerge`
	 * on (fully-autonomous mode). Defaults to a real `gh pr merge --auto
	 * --squash --delete-branch`. Injectable for tests — the real default must
	 * NEVER run in a test since it would arm a merge on a live GitHub PR.
	 */
	armAutoMerge?: (params: ArmAutoMergeParams) => Promise<void>;
	/**
	 * Global auto-work model — reused for task selection, squeeze timing, and
	 * branch-name slug generation (T-77). `null`/unset = bridge/server default.
	 */
	taskSelectionModel?: ModelRef | null;
	/**
	 * Injectable seam for the branch-name slug generator (T-77). Defaults to
	 * the real LLM-backed `generateBranchSlugWithModel`, which spends an
	 * extra `bridge.createSession` call. Tests inject a deterministic stub
	 * to skip that call and keep worktree/branch names predictable.
	 */
	generateBranchSlug?: (task: Task) => Promise<string>;
	/**
	 * Pin the inner cycle's selection to one task id — see
	 * `TaskSelectionInput.pinnedTaskId`. Production sets this from the
	 * global cycle's winner; a plain per-workspace cycle leaves it unset.
	 */
	pinnedTaskId?: string;
}

/** Candidate supplied to the optional cross-workspace task selector. */
export interface GlobalAutoWorkCandidate {
	workspaceCwd: string;
	task: Task;
	estimatedCostPct: number;
}

/** Injectable decision seam for tests or a future non-LLM policy. */
export type GlobalTaskSelector = (candidates: GlobalAutoWorkCandidate[]) => Promise<string | undefined>;

/** Options specific to global scheduling; extends the ordinary per-workspace cycle options. */
export interface RunGlobalAutoWorkCycleOptions extends RunAutoWorkCycleOptions {
	/** Test seam or alternate policy. Return a candidate task ID, or undefined to use priority order. */
	selectTask?: GlobalTaskSelector;
}

let integrationKb: KbService | undefined;
let integrationKbRoot: string | undefined;

async function resolveAutoWorkIntegrationPrompt(name: IntegrationPromptName): Promise<string> {
	const root = resolveKbRoot();
	if (!integrationKb || integrationKbRoot !== root) {
		integrationKb = new KbService({ root });
		integrationKbRoot = root;
	}
	// T-105: a broken KB (unreadable root, index failure) must never abort an
	// auto-work cycle — fall back to the bundled template so the session still
	// gets its core instructions, and log loudly so the KB problem is visible.
	try {
		return await resolveIntegrationPrompt(integrationKb, name);
	} catch (err) {
		log.error(`integration prompt "${name}" failed to resolve from the KB, using the bundled template`, err);
		return KB_TEMPLATES.find((t) => t.dir === "integrations" && t.name === `${name}.md`)?.body ?? "";
	}
}


/**
 * Runs exactly one auto-work cycle for `cwd`: pre-flight checks, task
 * selection, worktree + session creation, and waiting for the session to
 * reach a terminal state (or the per-priority timeout to fire). Safe to call
 * repeatedly/concurrently for the same workspace — the mutex pre-flight
 * check refuses to start a second run while one is `status: "running"`.
 */
export async function runAutoWorkCycle(
	cwd: string,
	bridge: AgentBridge,
	options: RunAutoWorkCycleOptions = {},
): Promise<AutoWorkCycleResult> {
	const config = getAutoWorkConfig(cwd);
	const now = (options.now ?? (() => new Date()))();
	const usageLookup = options.getSubscriptionUsage ?? (() => getSubscriptionUsage());
	const usage = await usageLookup();
	const subscriptionPctUsed = usage.available && typeof usage.weeklyPct === "number" ? usage.weeklyPct : null;
	const sessionPctUsed = usage.available && typeof usage.sessionPct === "number" ? usage.sessionPct : null;
	const resolveDeckBaseUrl = options.getDeckBaseUrl ?? (() => getServerDeckBaseUrl(loadConfig()).deckBaseUrl);
	const createPullRequest = options.createPullRequest ?? createPullRequestViaGh;
	const armAutoMerge = options.armAutoMerge ?? armAutoMergeViaGh;
	const notify = options.notify ?? sendAutoWorkNotification;

	// Weekly-usage budget warning (T-67) — a softer heads-up than
	// `weeklyPctLimit`'s hard block, so it can fire even on a cycle that goes
	// on to select and start a task. Evaluated once per cycle, independent of
	// the preflight/selection outcome below; `notify()` itself dedupes to at
	// most once per calendar day.
	const weeklyThresholdHit = subscriptionPctUsed !== null && subscriptionPctUsed >= config.weeklyPctThreshold;
	if (subscriptionPctUsed !== null && weeklyThresholdHit) {
		await notify({ kind: "weekly_threshold", cwd, pctUsed: subscriptionPctUsed, thresholdPct: config.weeklyPctThreshold });
	}

	const allTasks = listTasks();
	let workspaceTasks = allTasks.filter((t) => t.cwd === cwd);
	const workspaceTaskIds = new Set(workspaceTasks.map((t) => t.id));
	let activeRuns = listAutoWorkRuns({ status: "running" }).filter((r) => workspaceTaskIds.has(r.taskId));

	// A `running`-status row that survived a server restart needs to be
	// resumed (or retired), not silently treated as a mutex block — see
	// `classifyRunningAutoWorkRun` (T-65).
	const runningRun = activeRuns.find((r) => r.status === "running");
	if (runningRun) {
		const resumed = await resumeOrRetireAutoWorkRun(cwd, bridge, runningRun, config, {
			resolveDeckBaseUrl,
			createPullRequest,
			armAutoMerge,
			notify,
			usageLookup,
		});
		if (resumed) return resumed;
		activeRuns = activeRuns.filter((r) => r.id !== runningRun.id);
		// The retire path just closed the run and re-routed its task
		// (backlog/blocked) — refresh the snapshot taken above so this same
		// cycle can already see and select the re-routed task instead of
		// idling until the next tick.
		workspaceTasks = listTasks().filter((t) => t.cwd === cwd);
	}

	const preflight = checkAutoWorkPreflight({ config, now, subscriptionPctUsed, sessionPctUsed, activeRuns });
	if (!preflight.ok) {
		log.info(`cycle skipped for ${cwd}: ${preflight.reason}`);
		return { outcome: "skipped", reason: preflight.reason };
	}

	const backlogState = findStateByName("backlog");
	const doneState = findStateByName("done");
	const activeState = findStateByName("active");
	const blockedState = findStateByName("blocked");
	if (!backlogState || !doneState || !activeState || !blockedState) {
		const reason = "backlog/done/active/blocked task states are missing — cannot run auto-work";
		log.error(reason);
		return { outcome: "skipped", reason };
	}

	const selection = selectNextAutoWorkTask({
		tasks: workspaceTasks,
		config,
		currentPctUsed: subscriptionPctUsed ?? 0,
		backlogStateId: backlogState.id,
		doneStateId: doneState.id,
		estimateCostPct: (priority) => estimateTaskCostPct(priority, config),
		pinnedTaskId: options.pinnedTaskId,
	});

	if (selection.kind !== "selected") {
		const reason =
			selection.kind === "none_eligible"
				? "no eligible auto-work tasks in backlog (autoWork flag, dependencies, or state)"
				: selection.kind === "pinned_unavailable"
					? "the globally selected task is no longer eligible or affordable — reselecting on the next cycle"
					: `${selection.consideredCount} eligible task(s) considered but none fit the current cost/budget limits`;
		log.info(`cycle for ${cwd}: ${reason}`);
		// Session-limit notification (T-67) — only for the "considered but none
		// fit" case (a genuine budget-driven pause), and only when the weekly
		// threshold warning above didn't already fire this cycle: sending both
		// for the same skipped cycle would be redundant noise, so the weekly
		// warning takes precedence (it is the broader, workspace-wide signal).
		if (selection.kind === "none_fit" && !weeklyThresholdHit) {
			await notify({
				kind: "session_limit",
				sessionPctUsed: subscriptionPctUsed ?? 0,
				sessionPctLimit: config.sessionPctLimit,
			});
		}
		return { outcome: "skipped", reason };
	}

	const { task, estimatedCostPct } = selection;
	log.info(
		`selected T-${task.displayId} "${task.title}" (${task.priority}), estimated cost ${estimatedCostPct.toFixed(1)}%`,
	);

	const workspacePreference = getWorkspacePreference(cwd);
	const globalConfig = getAutoWorkGlobalConfig();
	const model = resolveAutoWorkModel(task.difficulty, config, globalConfig, workspacePreference?.model ?? null);
	if (model) {
		const invalid = await validateModelRef(bridge, model);
		if (invalid) {
			const reason = `configured model for difficulty=${task.difficulty} is invalid: ${invalid}`;
			log.error(reason);
			return { outcome: "skipped", reason };
		}
	}

	// T-104: a retry of a task whose previous attempt failed resumes that
	// attempt's session — full prior context, same worktree — instead of
	// starting from scratch. Falls back to a fresh session when the prior
	// session or worktree no longer exists.
	const retry = await resumePriorFailedRunSession(bridge, task);

	const agentHistory = extractAgentHistory(task.body);
	const historyBlock = agentHistory ? `\n\n## Agent history for this task\n${agentHistory}` : "";

	let session: SessionHandle;
	let worktreePath: string;
	let prompt: string;
	if (retry) {
		session = retry.session;
		worktreePath = retry.priorRun.worktreePath;
		const failureNote = retry.priorRun.failureReason ? ` Motivo: ${retry.priorRun.failureReason}.` : "";
		prompt =
			`Reintento de Auto Work para T-${task.displayId}: ${task.title}\n\n` +
			`Tu intento anterior (run \`${retry.priorRun.id}\`) terminó en estado ${retry.priorRun.status}.${failureNote} ` +
			`Continúa el trabajo donde lo dejaste en el worktree \`${worktreePath}\` (misma rama). ` +
			`Revisa primero el estado real (commits, tests) y completa lo que falte.\n\n` +
			`(contexto completo disponible via GET /api/tasks/${task.id})${historyBlock}`;
		log.info(`T-${task.displayId}: resuming prior session ${session.sessionId} for retry of run ${retry.priorRun.id}`);
	} else {
		// Default here is the plain synchronous slug (no model call): this keeps
		// `runAutoWorkCycle`'s own unit tests fast and deterministic without a
		// second `bridge.createSession` call. `runGlobalAutoWorkCycle` — the real
		// production entry point — injects the LLM-backed generator by default.
		const branchSlug = options.generateBranchSlug ? await options.generateBranchSlug(task) : slugifyTaskTitle(task.title);
		worktreePath = await createAutoWorkWorktree(cwd, task, branchSlug);

		try {
			session = await bridge.createSession({
				cwd,
				systemPromptAppend: await resolveAutoWorkIntegrationPrompt("auto-work"),
				...(model ? { model } : {}),
			});
		} catch (err) {
			// T-105: a session that cannot even launch must not abort the cycle
			// with an exception — the scheduler would re-select this same task
			// every tick, starving everything behind it. Park the task in
			// blocked with a visible note, moving it back to backlog explicitly
			// grants another attempt.
			const msg = ((err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "").trim().slice(0, 160);
			const reason = `agent session launch failed: ${msg}`;
			log.error(`T-${task.displayId}: ${reason}`, err);
			updateTask(task.id, {
				body: `${task.body}\n\n---\n**Auto Work launch failed** — ${reason}. Task parked in blocked, move it back to backlog to retry. Worktree: \`${worktreePath}\`.`,
			});
			moveTask(task.id, blockedState.id, 0);
			broadcastBus.broadcast({ type: "tasks_changed" });
			await notify({ kind: "task_failed", displayId: task.displayId, reason });
			return { outcome: "skipped", reason };
		}
		prompt = `Trabaja en T-${task.displayId}: ${task.title}\n\n(contexto completo disponible via GET /api/tasks/${task.id})\n\nEl worktree para esta tarea ya está configurado en \`${worktreePath}\` (rama \`auto-work/t${task.displayId}-${branchSlug}\`). Usa ese directorio para todos los commits y cambios de fichero.${historyBlock}`;
	}

	moveTask(task.id, activeState.id, 0);
	const runId = startAutoWorkRun({
		taskId: task.id,
		taskPriority: task.priority,
		sessionId: session.sessionId,
		worktreePath,
	});
	log.info(
		`run ${runId} started for T-${task.displayId}, session ${session.sessionId}, worktree ${worktreePath}${retry ? " (resumed prior session)" : ""}`,
	);
	broadcastBus.broadcast({ type: "auto_work_runs_changed" });
	await notify({
		kind: "task_started",
		displayId: task.displayId,
		title: task.title,
		model: model ? `${model.provider}/${model.id}` : "default",
	});

	// T-94: title the session from its first-turn prompt, matching the
	// regular-chat auto-title behavior (T-78). Fire-and-forget — never
	// delays the actual agent turn below. Only a fresh session needs a
	// title; a resumed one keeps the title it already has.
	if (!retry) maybeAutoTitleSession(bridge, session, prompt);
	const timeoutMinutes = resolveAutoWorkTimeoutMinutes(task.priority, config);
	return await finalizeAutoWorkRun({
		runId,
		task,
		session,
		worktreePath,
		timeoutMinutes,
		startTurn: () => session.prompt(prompt),
		resolveDeckBaseUrl,
		createPullRequest,
		autoMerge: config.autoMerge,
		armAutoMerge,
		notify,
		usageLookup,
		startPct: subscriptionPctUsed,
	});
}

/**
 * T-104: when the engine re-selects a task whose most recent run ended
 * failed/timed_out, resume that run's persisted session (the transcript
 * survives `dispose()`) so the retry keeps the full prior context and
 * reuses the same worktree/branch. Returns undefined — the retry starts a
 * fresh session — when the prior worktree or persisted session is gone,
 * or when resuming fails for any reason. Never throws.
 */
async function resumePriorFailedRunSession(
	bridge: AgentBridge,
	task: Task,
): Promise<{ session: SessionHandle; priorRun: AutoWorkRun } | undefined> {
	const [prior] = listAutoWorkRuns({ taskId: task.id, limit: 1 });
	if (!prior || (prior.status !== "failed" && prior.status !== "timed_out")) return undefined;
	if (!fs.existsSync(prior.worktreePath)) return undefined;
	try {
		const live = bridge.getSession(prior.sessionId);
		if (live) return { session: live, priorRun: prior };
		const persisted = await findPersistedAutoWorkSession(bridge, prior);
		if (!persisted) return undefined;
		const session = await bridge.resumeSession({
			sessionPath: persisted.path,
			systemPromptAppend: await resolveAutoWorkIntegrationPrompt("auto-work"),
		});
		return { session, priorRun: prior };
	} catch (err) {
		log.warn(
			`T-${task.displayId}: could not resume prior session ${prior.sessionId} for the retry, starting a fresh session`,
			err,
		);
		return undefined;
	}
}

// ─── Small IO helpers ───────────────────────────────────────────────────────

/**
 * Max consecutive failed/timed-out runs (first attempt included) before Auto
 * Work stops re-queuing a task (T-100). A successful run resets the streak.
 * Once exhausted the task parks in `blocked` with a MAX_RETRIES_EXCEEDED
 * marker; a human moving it back to `backlog` explicitly grants one more
 * attempt — the engine itself never returns an exhausted task to `backlog`.
 */
export const MAX_AUTO_WORK_TASK_ATTEMPTS = 3;

/**
 * How many times a live run may resend a continuation prompt to the same
 * session after an unexpected `aborted` terminal event before the run is
 * written off as failed. Intentional stops (`markRunIntentionallyStopped`)
 * bypass this limit and never retry.
 */
export const MAX_SAME_RUN_ABORT_RETRIES = 1;

interface FailedRunRouting {
	/** Consecutive failures including the run just closed. */
	attempts: number;
	exhausted: boolean;
	targetStateName: "backlog" | "blocked";
}

/**
 * Post-failure task routing (T-100). Call AFTER `completeAutoWorkRun` marked
 * the run failed so the streak includes it: back to `backlog` (auto-retry on
 * a later tick) while under `MAX_AUTO_WORK_TASK_ATTEMPTS`, otherwise parked
 * in `blocked` so the next cycle deterministically moves on to another task
 * instead of re-running this one forever.
 */
function routeTaskAfterFailedRun(taskId: string): FailedRunRouting {
	const attempts = countConsecutiveAutoWorkFailures(taskId);
	const exhausted = attempts >= MAX_AUTO_WORK_TASK_ATTEMPTS;
	const targetStateName = exhausted ? "blocked" : "backlog";
	const targetState = findStateByName(targetStateName);
	if (targetState) moveTask(taskId, targetState.id, 0);
	return { attempts, exhausted, targetStateName };
}

/** Human-readable retry decision for task notes, history entries, and logs. */
function describeRetryDecision(routing: FailedRunRouting): string {
	return routing.exhausted
		? `MAX_RETRIES_EXCEEDED (${routing.attempts} consecutive failed runs, limit ${MAX_AUTO_WORK_TASK_ATTEMPTS}) — Auto Work parked the task in blocked; move it back to backlog to grant one more attempt`
		: `${MAX_AUTO_WORK_TASK_ATTEMPTS - routing.attempts} automatic retry attempt(s) remaining`;
}

export function failAutoWorkRun(runId: string, taskId: string, failureReason: string): FailedRunRouting {
	completeAutoWorkRun(runId, { status: "failed", failureReason });
	const routing = routeTaskAfterFailedRun(taskId);
	broadcastBus.broadcast({ type: "tasks_changed" });
	broadcastBus.broadcast({ type: "auto_work_runs_changed" });
	return routing;
}

/**
 * Shared tail of the "a session is actively running" path — waits for
 * terminal state (or timeout) and closes out the DB rows accordingly. Used
 * by both a freshly-started run and a `"resume"`/`"reconnect"` pickup of a
 * pre-existing one (T-65), so a resumed run gets exactly the same
 * timeout/blocked/completed handling a fresh one does.
 *
 * The success branch (T-66) opens a PR from the worktree branch, appends a
 * session-link + PR-reference note to the task body, and moves the task to
 * `validate` (never `done` — every auto-work result is human-reviewed). If
 * validate is unavailable, it moves the task to `blocked` with a visible
 * reason rather than leaving it active. A PR creation failure does not fail
 * the run: the agent's work did complete, so the task still moves to validate
 * with a note that the PR needs to be opened by hand — surfacing that loudly
 * in the body and the logs beats silently discarding a completed session
 * behind an unrelated `gh` error.
 */
function finalizeAutoWorkRun(params: {
	runId: string;
	task: Task;
	session: SessionHandle;
	worktreePath: string;
	timeoutMinutes: number;
	/** Starts the agent turn (e.g. `session.prompt(...)`) AFTER the terminal
	 *  listener is subscribed. Omitted when reattaching to an already-streaming
	 *  session (T-65 resume of a live turn). */
	startTurn?: () => Promise<unknown>;
	resolveDeckBaseUrl: () => string;
	createPullRequest: (params: CreatePullRequestParams) => Promise<CreatePullRequestResult>;
	/** Whether this workspace runs fully autonomous (arm auto-merge instead of parking in validate). */
	autoMerge: boolean;
	armAutoMerge: (params: ArmAutoMergeParams) => Promise<void>;
	notify: (event: AutoWorkNotificationEvent) => Promise<void>;
	/** T-80: used to compute pctConsumed delta after the run closes. */
	usageLookup: () => Promise<{ available: boolean; weeklyPct?: number }>;
	/** T-80: subscription weeklyPct at the moment the run started; null when unavailable. */
	startPct: number | null;
}): Promise<AutoWorkCycleResult> {
	activeRunIds.add(params.runId);
	return settleAutoWorkRun(params).finally(() => {
		activeRunIds.delete(params.runId);
		intentionallyStoppedRunIds.delete(params.runId);
	});
}

async function settleAutoWorkRun(params: {
	runId: string;
	task: Task;
	session: SessionHandle;
	worktreePath: string;
	timeoutMinutes: number;
	startTurn?: () => Promise<unknown>;
	resolveDeckBaseUrl: () => string;
	createPullRequest: (params: CreatePullRequestParams) => Promise<CreatePullRequestResult>;
	autoMerge: boolean;
	armAutoMerge: (params: ArmAutoMergeParams) => Promise<void>;
	notify: (event: AutoWorkNotificationEvent) => Promise<void>;
	usageLookup: () => Promise<{ available: boolean; weeklyPct?: number }>;
	startPct: number | null;
}): Promise<AutoWorkCycleResult> {
	const { runId, task, session, worktreePath, timeoutMinutes, startTurn, resolveDeckBaseUrl, createPullRequest, autoMerge, armAutoMerge, notify, usageLookup, startPct } =
		params;
	// Same-run abort retry: an unexpected `aborted` terminal event is retried
	// once within the same run by sending a continuation prompt to the same
	// session. Intentional stops (via `markRunIntentionallyStopped`) bypass this
	// so the user's explicit stop is always respected. Non-abort failures
	// (`max_tokens`, `length`, `refusal`, `error`) are never retried in-run.
	let currentStartTurn: (() => Promise<unknown>) | undefined = startTurn;
	let terminal!: AutoWorkTerminalResult;
	let sameRunAborts = 0;
	do {
		terminal = await waitForAutoWorkSessionTerminalResult(session, timeoutMinutes * 60_000, currentStartTurn);
		currentStartTurn = undefined;
		if (
			terminal.outcome === "failed" &&
			terminal.failureReason === "agent turn ended with stop reason: aborted" &&
			!intentionallyStoppedRunIds.has(runId) &&
			sameRunAborts < MAX_SAME_RUN_ABORT_RETRIES
		) {
			sameRunAborts++;
			log.warn(
				`run ${runId}: turn aborted unexpectedly — sending continuation prompt (same-run retry ${sameRunAborts}/${MAX_SAME_RUN_ABORT_RETRIES})`,
			);
			currentStartTurn = () =>
				session.prompt(
					`El turno anterior fue interrumpido inesperadamente. Revisa el estado del worktree y continúa el trabajo desde donde lo dejaste.`,
				);
		}
	} while (currentStartTurn !== undefined);

	// Capture real token usage for this run (T-80). Both calls run concurrently;
	// failures are logged and default to null — missing usage is never fatal.
	const [snapshotResult, endUsageResult] = await Promise.allSettled([
		Promise.resolve(session.snapshot()),
		usageLookup(),
	]);
	if (snapshotResult.status === "rejected")
		log.warn(`run ${runId}: snapshot() failed, tokens will be null`, snapshotResult.reason);
	if (endUsageResult.status === "rejected")
		log.warn(`run ${runId}: usageLookup() failed, pctConsumed will be null`, endUsageResult.reason);
	const usageRollup = snapshotResult.status === "fulfilled" ? snapshotResult.value.usageRollup : undefined;
	const inputTokens: number | null = usageRollup?.input ?? null;
	const outputTokens: number | null = usageRollup?.output ?? null;
	const endPct =
		endUsageResult.status === "fulfilled" &&
		endUsageResult.value.available &&
		typeof endUsageResult.value.weeklyPct === "number"
			? endUsageResult.value.weeklyPct
			: null;
	const pctConsumed: number | null = startPct !== null && endPct !== null ? Math.max(0, endPct - startPct) : null;

	if (terminal.outcome !== "completed") {
		const timedOut = terminal.outcome === "timed_out";
		const failureReason =
			terminal.outcome === "timed_out"
				? `exceeded ${timeoutMinutes}min timeout for priority ${task.priority}`
				: terminal.failureReason;
		if (timedOut) {
			// Abort the still-running session so reality matches the record —
			// otherwise the agent keeps working (and spending) after the run
			// was already written off, and may even finish the task.
			await session.abort().catch((err) => log.warn(`run ${runId}: abort after timeout failed`, err));
		}
		completeAutoWorkRun(runId, {
			status: timedOut ? "timed_out" : "failed",
			failureReason,
			inputTokens,
			outputTokens,
			pctConsumed,
		});
		broadcastBus.broadcast({ type: "auto_work_runs_changed" });
		// T-100: a failed turn can leave the session alive (queued prompts, a
		// turn that errored mid-stream). Abort defensively, then release the
		// live handle so a written-off run cannot keep spending. The session
		// transcript persists on disk — still inspectable and resumable.
		if (!timedOut) {
			try {
				if (await session.isStreamingNow()) await session.abort();
			} catch (err) {
				log.warn(`run ${runId}: abort of failed session failed`, err);
			}
		}
		try {
			await session.dispose();
		} catch (err) {
			log.warn(`run ${runId}: dispose of terminal session failed`, err);
		}
		// T-100: deterministic next-tick decision. A timed-out task parks in
		// `blocked` (unchanged); a failed one returns to `backlog` while its
		// consecutive-failure budget lasts, else parks in `blocked` with a
		// MAX_RETRIES_EXCEEDED marker so the next cycle picks another task.
		let movedTo: "backlog" | "blocked";
		let decision = "";
		if (timedOut) {
			const blockedState = findStateByName("blocked");
			if (blockedState) moveTask(task.id, blockedState.id, 0);
			movedTo = "blocked";
		} else {
			const routing = routeTaskAfterFailedRun(task.id);
			movedTo = routing.targetStateName;
			decision = ` ${describeRetryDecision(routing)}.`;
		}
		const failRunNote = `\n\n---\n**Auto Work ${timedOut ? "timeout" : "aborted"}** — run \`${runId}\` ${failureReason}.${decision} Session: \`${session.sessionId}\`, worktree: \`${worktreePath}\`.`;
		const failHistorySummary = `${timedOut ? "Timed out" : "Failed"}: ${failureReason}.${decision}`;
		updateTask(task.id, {
			body: appendAgentHistoryEntry(task.body + failRunNote, runId, new Date().toISOString(), failHistorySummary),
		});
		broadcastBus.broadcast({ type: "tasks_changed" });
		log.warn(`run ${runId} ${timedOut ? "timed out" : "failed"}; T-${task.displayId} moved to ${movedTo} (${failureReason})`);
		await notify({ kind: "task_failed", displayId: task.displayId, reason: failureReason });
		if (timedOut) return { outcome: "timed_out", taskId: task.id, runId, sessionId: session.sessionId, worktreePath };
		return { outcome: "failed", taskId: task.id, runId, sessionId: session.sessionId, worktreePath, failureReason };
	}
	const deckBaseUrl = resolveDeckBaseUrl();
	const sessionUrl = buildSessionUrl(deckBaseUrl, session.sessionId);
	const shortSessionId = session.sessionId.slice(0, 8);

	let prNumber: number | undefined;
	let prStatus: "opened" | "already_open" | "failed" | undefined;
	let prFailureReason: string | undefined;
	try {
		const pr = await createPullRequest({
			cwd: worktreePath,
			...buildAutoWorkPrMessage(task, session.sessionId),
		});
		prNumber = pr.number;
		prStatus = pr.prStatus;
		log.info(`run ${runId}: ${pr.prStatus === "already_open" ? "found existing" : "opened"} PR #${pr.number} (${pr.url}) for T-${task.displayId}`);
	} catch (err) {
		const errMsg = ((err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "").trim().slice(0, 120);
		prFailureReason = errMsg;
		prStatus = "failed";
		log.error(`run ${runId}: gh pr create failed for T-${task.displayId}`, err);

		// When gh pr create fails with a "no commits" pattern, the agent
		// likely produced no work — verify and treat as failure, not completed.
		// Other errors (auth, rate limit, network, no remote, etc.) fall
		// through: the task still moves to validate since the implementation
		// genuinely finished, but the run closes with a distinct
		// "completed_pr_failed" status (not "completed") and this reason, so
		// the failure is clearly visible instead of looking like a real
		// success (T-85).
		if (/no commit|must be on a branch|empty (range|commit)/i.test(errMsg)) {
			const hasCommits = await branchHasAgentCommits(worktreePath);
			if (!hasCommits) {
				const failureReason = `agent produced no commits (PR: ${errMsg})`;
				completeAutoWorkRun(runId, { status: "failed", failureReason, inputTokens, outputTokens, pctConsumed });
				const routing = routeTaskAfterFailedRun(task.id);
				broadcastBus.broadcast({ type: "tasks_changed" });
				broadcastBus.broadcast({ type: "auto_work_runs_changed" });
				// T-100: release the live handle — this run is written off.
				try {
					await session.dispose();
				} catch (disposeErr) {
					log.warn(`run ${runId}: dispose of failed session failed`, disposeErr);
				}
				updateTask(task.id, {
					body: `${task.body}\n\n---\n**Auto Work aborted** — run \`${runId}\` ${failureReason}. ${describeRetryDecision(routing)}. Session: \`${session.sessionId}\`, worktree: \`${worktreePath}\`.`,
				});
				broadcastBus.broadcast({ type: "tasks_changed" });
				log.warn(`run ${runId} failed (no agent commits); T-${task.displayId} moved to ${routing.targetStateName} (${failureReason})`);
				await notify({ kind: "task_failed", displayId: task.displayId, reason: failureReason });
				return { outcome: "failed", taskId: task.id, runId, sessionId: session.sessionId, worktreePath, failureReason };
			}
		}
	}

	// Fully-autonomous mode (autoMerge): park the run as
	// `completed_pending_merge` and let `reconcileAutoMergedRuns` close the
	// loop — it merges the PR itself once CI is green and promotes the task to
	// `done`, so the CI gate holds without requiring GitHub's native
	// auto-merge (unavailable on private free-plan repos: no required checks).
	// Arming native auto-merge is a best-effort bonus: when the repo supports
	// it, GitHub merges faster than our poll.
	if (autoMerge && prNumber !== undefined) {
		let autoMergeArmed = false;
		try {
			await armAutoMerge({ cwd: worktreePath, prNumber });
			autoMergeArmed = true;
		} catch (err) {
			log.info(`run ${runId}: native auto-merge unavailable for T-${task.displayId} PR #${prNumber} — reconciler will merge when CI passes`, err);
		}
		const note = `\n\n---\n**Auto Work — auto-merge${autoMergeArmed ? " armed" : ""}** · [session ${shortSessionId}](${sessionUrl}) · PR #${prNumber}\nWaiting for CI; the task moves to \`done\` once the PR merges.`;
		updateTask(task.id, {
			body: appendAgentHistoryEntry(task.body + note, runId, new Date().toISOString(), `Session completed. PR #${prNumber} pending auto-merge.`),
		});
		const pendingValidateState = findStateByName("validate");
		if (pendingValidateState) moveTask(task.id, pendingValidateState.id, 0);
		completeAutoWorkRun(runId, { status: "completed_pending_merge", inputTokens, outputTokens, pctConsumed, prNumber });
		broadcastBus.broadcast({ type: "tasks_changed" });
		broadcastBus.broadcast({ type: "auto_work_runs_changed" });
		log.info(`run ${runId}: T-${task.displayId} PR #${prNumber} pending auto-merge (native arm: ${autoMergeArmed})`);
		await notify({ kind: "task_auto_merging", displayId: task.displayId, prNumber });
		return { outcome: "completed", taskId: task.id, runId, sessionId: session.sessionId, worktreePath, prNumber, prStatus: prStatus ?? "opened" };
	}

	const validateState = findStateByName("validate");
	const validationRoutingReason = validateState ? undefined : "validate task state not found, task moved to blocked for manual review";
	if (validateState) {
		moveTask(task.id, validateState.id, 0);
	} else {
		const blockedState = findStateByName("blocked");
		if (blockedState) moveTask(task.id, blockedState.id, 0);
		else log.error(`run ${runId}: "validate" and "blocked" task states not found — T-${task.displayId} left in its current state`);
	}

	const completeRunNoteBase =
		prNumber !== undefined
			? `\n\n---\n**Auto Work** — [session ${shortSessionId}](${sessionUrl}) · PR #${prNumber}`
			: `\n\n---\n**Auto Work — implementation complete, PR creation failed**\n[session ${shortSessionId}](${sessionUrl}) · run \`${runId}\`\n\n**Error:** ${prFailureReason}\n\nRetry with \`POST /auto-work/runs/${runId}/create-pr\`, or run \`gh pr create\` manually from \`${worktreePath}\`.`;
	const completeRunNote = validationRoutingReason
		? `${completeRunNoteBase}\n\n**Auto Work routing:** ${validationRoutingReason}.`
		: completeRunNoteBase;
	const completeHistorySummaryBase =
		prNumber !== undefined
			? `Session completed. PR #${prNumber}.`
			: `Session completed. PR creation failed: ${prFailureReason}.`;
	const completeHistorySummary = validationRoutingReason
		? `${completeHistorySummaryBase} ${validationRoutingReason}.`
		: completeHistorySummaryBase;
	updateTask(task.id, {
		body: appendAgentHistoryEntry(task.body + completeRunNote, runId, new Date().toISOString(), completeHistorySummary),
	});

	const completionFailureReason = `${prFailureReason ? `${prFailureReason} ` : ""}${validationRoutingReason ?? ""}`.trim() || null;
	completeAutoWorkRun(runId, {
		status: prNumber !== undefined ? "completed" : "completed_pr_failed",
		inputTokens,
		outputTokens,
		pctConsumed,
		failureReason: completionFailureReason,
		prNumber: prNumber ?? null,
	});
	broadcastBus.broadcast({ type: "tasks_changed" });
	broadcastBus.broadcast({ type: "auto_work_runs_changed" });
	log.info(
		`run ${runId} completed for T-${task.displayId} — moved to ${validateState ? "validate" : "blocked"}${prNumber === undefined ? " (PR creation failed)" : ""}`,
	);
	// A real PR announces success; a PR-creation failure still gets its own
	// (quieter) notification kind so it's visible without being confused
	// with a genuine completion (T-85) — unlike the no-commits case above,
	// this task DID complete, it just needs a manual/retried PR.
	if (prNumber !== undefined) {
		await notify({ kind: "task_completed", displayId: task.displayId, prNumber });
	} else if (prFailureReason !== undefined) {
		await notify({ kind: "task_completed_pr_failed", displayId: task.displayId, reason: prFailureReason });
	}
	return { outcome: "completed", taskId: task.id, runId, sessionId: session.sessionId, worktreePath, prNumber, prStatus: prStatus ?? "failed", ...(prFailureReason !== undefined ? { prFailureReason } : {}) };
}

/**
 * Retires persisted runs whose session is truly gone. The monitor calls this
 * before displaying history, so a killed session cannot look live forever.
 * A short grace avoids racing a just-created session before its first turn
 * starts. A run whose session still exists as a persisted `.jsonl` is left
 * alone — it is resumable, and the scheduler's next cycle owns picking it up
 * (`resumeOrRetireAutoWorkRun`); failing it here would race that resume, which
 * is exactly how completed runs used to end up `failed: session_not_running`.
 */
export async function reconcileInactiveAutoWorkRuns(bridge: AgentBridge, now = Date.now()): Promise<number> {
	let reconciled = 0;
	for (const run of listAutoWorkRuns({ status: "running" })) {
		if (activeRunIds.has(run.id) || now - Date.parse(run.startedAt) < STALE_RUN_GRACE_MS) continue;
		let stillLive: boolean;
		try {
			const handle = bridge.getSession(run.sessionId);
			stillLive = (handle !== undefined && (await handle.isStreamingNow())) || (await findPersistedAutoWorkSession(bridge, run)) !== undefined;
		} catch (err) {
			// A transient bridge/filesystem error is not proof the session is
			// gone — declaring it stale here would fail (and reopen the mutex
			// for) a run that is still genuinely alive. Leave it untouched;
			// the next reconcile pass re-evaluates from scratch.
			log.warn(`run ${run.id}: liveness check failed, leaving status untouched this pass`, err);
			continue;
		}
		if (stillLive) continue;
		const routing = failAutoWorkRun(run.id, run.taskId, "session_not_running");
		log.warn(
			`run ${run.id} (session ${run.sessionId}) is no longer running; task moved to ${routing.targetStateName}${routing.exhausted ? " (MAX_RETRIES_EXCEEDED)" : ""}`,
		);
		reconciled += 1;
	}
	return reconciled;
}

/**
 * Resolves a live handle for `run.sessionId`: the in-process bridge may
 * still hold it (nothing was interrupted, or the same process is calling
 * `runAutoWorkCycle` again while the prior call's session is still going),
 * or it may only exist as a persisted `.jsonl` the bridge can
 * `resumeSession()` from (server restarted since the run started, dropping
 * every in-memory handle). Returns `undefined` when neither exists — that
 * is the "stale" case `classifyRunningAutoWorkRun` fails the run on.
 */
async function resolveRunningSessionHandle(
	bridge: AgentBridge,
	run: AutoWorkRun,
): Promise<SessionHandle | undefined> {
	const live = bridge.getSession(run.sessionId);
	if (live) return live;

	const persisted = await findPersistedAutoWorkSession(bridge, run);
	if (!persisted) return undefined;
	return bridge.resumeSession({ sessionPath: persisted.path, systemPromptAppend: await resolveAutoWorkIntegrationPrompt("auto-work") });
}

/**
 * Looks up `run.sessionId` in the bridge's persisted-session listing.
 * Scoped to `run.worktreePath` first (the common case, and cheap for
 * implementations that index by cwd); falls back to the unscoped listing
 * because the worktree directory itself may be gone (T-65's "reconnect"
 * case) even though the underlying `.jsonl` still exists under
 * `~/.omp/agent/sessions`.
 */
async function findPersistedAutoWorkSession(bridge: AgentBridge, run: AutoWorkRun) {
	const scoped = await bridge.listSessions({ cwd: run.worktreePath });
	const inScope = scoped.find((s) => s.id === run.sessionId);
	if (inScope) return inScope;
	const all = await bridge.listSessions({});
	return all.find((s) => s.id === run.sessionId);
}

/**
 * `git worktree remove --force`, run from `repoCwd`. Idempotent: a
 * worktree directory that's already gone is a no-op, not an error — this
 * is called from the "stale run" cleanup path where the directory's
 * presence is exactly what's in question.
 */
async function removeAutoWorkWorktree(repoCwd: string, worktreePath: string): Promise<void> {
	if (!fs.existsSync(worktreePath)) return;
	const proc = Bun.spawn(["git", "worktree", "remove", "--force", worktreePath], {
		cwd: repoCwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) {
		log.warn(`git worktree remove --force ${worktreePath} failed (exit ${exitCode}): ${stderr.trim()}`);
	}
}

/**
 * Returns `true` when the worktree branch has at least one commit beyond the
 * remote base branch — i.e. the agent produced work. Used as a safety gate
 * when PR creation fails: if there are no unique commits on the branch, the
 * run is a failure, not a successful completion with a PR glitch.
 */
async function branchHasAgentCommits(worktreePath: string): Promise<boolean> {
	try {
		const baseBranch = await resolveBaseBranch(worktreePath);
		const proc = Bun.spawn(
			["git", "rev-list", "--count", `origin/${baseBranch}..HEAD`],
			{ cwd: worktreePath, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
		);
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return exitCode === 0 && Number(stdout.trim()) > 0;
	} catch {
		// A rev-list failure after a base was resolved must not turn a real
		// implementation into an empty-branch failure.
		return true;
	}
}


/**
 * The pre-flight step that distinguishes "another run is genuinely active"
 * from "a running-status row is stale because the process that owned it
 * died or restarted" (T-65). Called once per cycle, before the mutex check,
 * for a workspace's sole `status: "running"` row (there is at most one —
 * the mutex enforces that on the way in).
 *
 * Returns the finished `AutoWorkCycleResult` when the run was resumed or
 * reconnected (caller should return it as-is, skipping task selection).
 * Returns `undefined` when the run turned out to be stale — the caller
 * falls through to normal pre-flight + task selection in that case, since
 * `resumeOrRetireAutoWorkRun` has already closed the row, moved the task
 * back to backlog, and removed the worktree.
 */
async function resumeOrRetireAutoWorkRun(
	cwd: string,
	bridge: AgentBridge,
	run: AutoWorkRun,
	config: AutoWorkConfig,
	completion: {
		resolveDeckBaseUrl: () => string;
		createPullRequest: (params: CreatePullRequestParams) => Promise<CreatePullRequestResult>;
		armAutoMerge: (params: ArmAutoMergeParams) => Promise<void>;
		notify: (event: AutoWorkNotificationEvent) => Promise<void>;
		usageLookup: () => Promise<{ available: boolean; weeklyPct?: number }>;
	},
): Promise<AutoWorkCycleResult | undefined> {
	let handle: SessionHandle | undefined;
	try {
		handle = await resolveRunningSessionHandle(bridge, run);
	} catch (err) {
		// T-105: a resume failure (corrupt transcript, bridge error) must not
		// leave the row `running` — that wedges the workspace mutex and stops
		// Auto Work entirely. Close the run as failed (the normal retry budget
		// applies) and let this cycle fall through to fresh task selection.
		const msg = ((err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "").trim().slice(0, 160);
		const routing = failAutoWorkRun(run.id, run.taskId, `session_resume_failed: ${msg}`);
		log.warn(
			`run ${run.id}: resuming session ${run.sessionId} failed (${msg}) — run marked failed, task moved to ${routing.targetStateName}${routing.exhausted ? " (MAX_RETRIES_EXCEEDED)" : ""}`,
		);
		return undefined;
	}
	const worktreeExists = fs.existsSync(run.worktreePath);
	const classification = classifyRunningAutoWorkRun(run, handle !== undefined, worktreeExists);

	if (classification === "stale" || !handle) {
		const routing = failAutoWorkRun(run.id, run.taskId, "session_lost");
		log.warn(
			`run ${run.id} (session ${run.sessionId}) has no live or persisted session to resume — marked failed, task moved to ${routing.targetStateName}${routing.exhausted ? " (MAX_RETRIES_EXCEEDED)" : ""}`,
		);
		await removeAutoWorkWorktree(cwd, run.worktreePath);
		return undefined;
	}

	const task = getTask(run.taskId);
	if (!task) {
		log.warn(`run ${run.id}: task ${run.taskId} no longer exists — closing the run as failed`);
		completeAutoWorkRun(run.id, { status: "failed", failureReason: "session_lost" });
		broadcastBus.broadcast({ type: "auto_work_runs_changed" });
		await removeAutoWorkWorktree(cwd, run.worktreePath);
		return undefined;
	}

	log.info(
		`${classification === "resume" ? "resuming" : "reconnecting to"} run ${run.id} for T-${task.displayId}, ` +
			`session ${run.sessionId}${worktreeExists ? "" : " (worktree missing)"}`,
	);

	// A resumed handle whose turn died with the previous server process is
	// idle: no event will ever arrive, so waiting alone would always end in a
	// bogus timeout. Kick it with a continuation prompt; if the work was in
	// fact already finished, the agent verifies and ends the turn quickly.
	const streaming = await handle.isStreamingNow();
	const continuationPrompt =
		`La sesión de Auto Work para T-${task.displayId} ("${task.title}") se interrumpió (reinicio del servidor). ` +
		`Continúa el trabajo en el worktree \`${run.worktreePath}\`. Si la tarea ya estaba terminada, verifica el estado (commits, tests) y concluye. ` +
		`(contexto completo via GET /api/tasks/${task.id})`;
	const timeoutMinutes = resolveAutoWorkTimeoutMinutes(run.taskPriority, config);
	return finalizeAutoWorkRun({
		runId: run.id,
		task,
		session: handle,
		worktreePath: run.worktreePath,
		timeoutMinutes,
		...(streaming ? {} : { startTurn: () => handle.prompt(continuationPrompt) }),
		resolveDeckBaseUrl: completion.resolveDeckBaseUrl,
		createPullRequest: completion.createPullRequest,
		autoMerge: config.autoMerge,
		armAutoMerge: completion.armAutoMerge,
		notify: completion.notify,
		usageLookup: completion.usageLookup,
		startPct: null, // resumed run: no meaningful pre-session baseline available
	});
}

type AutoWorkTerminalResult =
	| { outcome: "completed" }
	| { outcome: "failed"; failureReason: string }
	| { outcome: "timed_out" };

/**
 * `stopReason` values meaning the model paused mid-task to invoke a tool,
 * not that the agent turn actually ended. The SDK emits one `turn_end` per
 * internal LLM round of a multi-tool-call task — every round but the last
 * carries one of these. Only the FINAL `turn_end` (or the `agent_end` that
 * follows the whole loop) reflects the real outcome. Treating an
 * intermediate `turn_end` as terminal marked a still-running task "failed"
 * right after its first tool call (regression fixed by T-96), closing the
 * DB row and clearing the mutex while the agent kept working underneath.
 */
const TOOL_CONTINUATION_STOP_REASONS: Record<string, true> = { toolUse: true, tool_use: true };

/**
 * Extracts the stop reason regardless of event shape: `turn_end` carries a
 * single `message`, `agent_end` carries the full `messages` array (the
 * outcome lives on its last entry).
 */
function stopReasonFromEvent(event: { message?: unknown; messages?: unknown; stopReason?: unknown }): string | undefined {
	if (typeof event.stopReason === "string") return event.stopReason;
	const single = event.message && typeof event.message === "object" ? (event.message as Record<string, unknown>) : undefined;
	if (single && typeof single.stopReason === "string") return single.stopReason;
	if (Array.isArray(event.messages)) {
		const last = event.messages[event.messages.length - 1] as Record<string, unknown> | undefined;
		if (last && typeof last.stopReason === "string") return last.stopReason;
	}
	return undefined;
}


function terminalOutcomeFromEvent(event: unknown): AutoWorkTerminalResult | undefined {
	if (!event || typeof event !== "object" || !("type" in event)) return undefined;
	if (event.type !== "turn_end" && event.type !== "agent_end") return undefined;

	const stopReason = stopReasonFromEvent(event as { message?: unknown; messages?: unknown; stopReason?: unknown });

	// An intermediate `turn_end` inside a multi-tool-call task — the agent is
	// still working towards `agent_end`, not actually done yet.
	if (event.type === "turn_end" && stopReason && TOOL_CONTINUATION_STOP_REASONS[stopReason]) return undefined;
	if (stopReason === "aborted") {
		// TTSR deliberately aborts a stream, injects the matched rule, and retries
		// it within the same agent turn. Its local abort reason is propagated as
		// `errorMessage`, so wait for the retry's actual terminal outcome.
		const candidates = [
			event,
			"message" in event ? event.message : undefined,
			...("messages" in event && Array.isArray(event.messages) ? event.messages : []),
		];
		const ttsrInterruption = candidates.some((candidate) => {
			if (!candidate || typeof candidate !== "object" || !("errorMessage" in candidate)) return false;
			return typeof candidate.errorMessage === "string" && candidate.errorMessage.startsWith("TTSR matched rule");
		});
		if (ttsrInterruption) return undefined;
	}


	if (!stopReason) return { outcome: "failed", failureReason: "agent turn ended without a stop reason" };
	if (stopReason === "end_turn" || stopReason === "stop") return { outcome: "completed" };
	return { outcome: "failed", failureReason: `agent turn ended with stop reason: ${stopReason}` };
}


/**
 * Wait for a terminal event while retaining the exact failure condition for
 * the run record. A resolved prompt alone is not evidence of completion: the
 * T-83 session stopped mid-tool-call after exhausting its execution budget,
 * resolved its prompt, and was incorrectly marked completed.
 */
function waitForAutoWorkSessionTerminalResult(
	handle: SessionHandle,
	timeoutMs: number,
	startTurn?: () => Promise<unknown>,
): Promise<AutoWorkTerminalResult> {
	const { promise, resolve } = Promise.withResolvers<AutoWorkTerminalResult>();
	let settled = false;
	let unsubscribe: (() => void) | undefined;
	const finish = (result: AutoWorkTerminalResult) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		unsubscribe?.();
		resolve(result);
	};
	const timer = setTimeout(() => finish({ outcome: "timed_out" }), timeoutMs);
	// Bun timers expose `unref`, unlike browser numeric timer ids.
	const unrefTimer = timer as typeof timer & { unref?: () => void };
	unrefTimer.unref?.();
	unsubscribe = handle.subscribe((event) => {
		const result = terminalOutcomeFromEvent(event);
		if (result) finish(result);
	});
	if (startTurn) {
		startTurn().then(
			// Defer one tick so a terminal event emitted just before the prompt
			// promise settles (it carries the precise stopReason) wins the race.
			() => setTimeout(() => finish({ outcome: "failed", failureReason: "agent turn ended without a terminal event" }), 0),
			(err) => {
				log.warn("auto-work turn prompt failed", err);
				const message = err instanceof Error ? err.message : String(err);
				setTimeout(() => finish({ outcome: "failed", failureReason: `agent prompt failed: ${message}` }), 0);
			},
		);
	}
	return promise;
}

/**
 * Waits for the terminal result used by the pre-existing decision helpers.
 * The detailed variant above is reserved for run persistence, which needs the
 * original reason rather than the coarse status.
 */
export async function waitForAutoWorkSessionTerminal(
	handle: SessionHandle,
	timeoutMs: number,
	startTurn?: () => Promise<unknown>,
): Promise<AutoWorkTerminalResult["outcome"]> {
	return (await waitForAutoWorkSessionTerminalResult(handle, timeoutMs, startTurn)).outcome;
}

/**
 * `git worktree add -b auto-work/T<displayId>-<slug> .worktrees/aw-T<displayId>-<slug>
 * origin/<base-branch>`, run from `repoCwd`. The start-point is resolved from
 * the matching project policy before the remote default, never from the
 * currently checked-out branch in the main worktree. This keeps every
 * auto-work branch on the configured clean base regardless of local checkout.
 *
 * Every linked worktree shares the main checkout's `.git/config` (this repo
 * does not opt into `extensions.worktreeConfig`), so a stray repo-local
 * `user.name`/`user.email` silently overrides the real committer identity
 * for EVERY worktree, not just the one it was set from. `stripLocalGitIdentityOverride`
 * runs on every call — including the reused-worktree fast path — so commit
 * authorship always falls through to whatever is configured globally.
 */
async function createAutoWorkWorktree(repoCwd: string, task: Task, slug: string): Promise<string> {
	const dirName = `aw-T${task.displayId}-${slug}`;
	const worktreePath = path.join(repoCwd, ".worktrees", dirName);
	const branch = `auto-work/t${task.displayId}-${slug}`;

	await stripLocalGitIdentityOverride(repoCwd);

	// Reuse an existing registered worktree rather than failing with exit 255
	// when a previous run left the branch/path in place (retry or crashed session).
	const existing = await findExistingWorktreePath(repoCwd, worktreePath);
	if (existing) {
		log.info(`reusing existing worktree at ${worktreePath} (branch ${branch})`);
		return existing;
	}

	const baseBranch = await resolveBaseBranch(repoCwd);

	// Refresh origin/<base> before branching from it — merges can land between
	// scheduler ticks (native auto-merge, humans) without the reconciler's
	// post-merge fetch, and a stale tracking ref would base this run one merge
	// behind. Best-effort: offline, the stale ref is still a usable base.
	const fetch = Bun.spawn(["git", "fetch", "origin", baseBranch], {
		cwd: repoCwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const fetchExit = await fetch.exited;
	if (fetchExit !== 0) log.warn(`git fetch origin ${baseBranch} in ${repoCwd} failed (exit ${fetchExit}) — using the existing tracking ref`);

	const proc = Bun.spawn(["git", "worktree", "add", "-b", branch, worktreePath, `origin/${baseBranch}`], {
		cwd: repoCwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) {
		throw new Error(`git worktree add failed (exit ${exitCode}) for T-${task.displayId}: ${stderr.trim()}`);
	}
	return worktreePath;
}

/**
 * Removes any repo-local `user.name`/`user.email` override so commit
 * authorship always resolves to the global git identity. A local override
 * here is never intentional: it silently attributes every future commit,
 * in every worktree (including the user's own main checkout), to whatever
 * it was set to instead of the real committer — this is exactly what
 * happened when a repo-local `agent <agent@omp-deck.local>` identity ended
 * up in `.git/config`. `git config --unset-all` exits 5 when the key is
 * already absent, which is the common case and not an error here.
 */
async function stripLocalGitIdentityOverride(repoCwd: string): Promise<void> {
	for (const key of ["user.name", "user.email"]) {
		const proc = Bun.spawn(["git", "config", "--local", "--unset-all", key], {
			cwd: repoCwd,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			windowsHide: true,
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		// Exit 0 = removed, 5 = key was already absent (the common case) —
		// both are fine. Anything else (lock contention, a malformed config)
		// means the override may still be sitting there, so surface it instead
		// of silently proceeding with a possibly-still-poisoned identity.
		if (exitCode !== 0 && exitCode !== 5) {
			log.warn(`failed to strip local git ${key} override in ${repoCwd} (exit ${exitCode}): ${stderr.trim()}`);
		}
	}
}

/**
 * Returns `worktreePath` when it is already registered in `git worktree list`,
 * otherwise returns `undefined`. Used by `createAutoWorkWorktree` to detect
 * a leftover worktree from a previous (possibly crashed) run so it can be
 * reused instead of calling `git worktree add` again (which would fail with
 * exit 255 if the branch or directory already exists).
 */
async function findExistingWorktreePath(repoCwd: string, worktreePath: string): Promise<string | undefined> {
	if (!fs.existsSync(worktreePath)) return undefined;
	const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
		cwd: repoCwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) return undefined;
	// Each entry starts with "worktree <path>\n"; entries separated by blank lines.
	return stdout.split("\n").some((line) => line === `worktree ${worktreePath}`) ? worktreePath : undefined;
}

function slugifyTaskTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "task";
}

/**
 * Ask a short-lived internal session for an English kebab-case branch-name slug.
 * Its system prompt is the `branch-naming` integration, not the normal
 * `kb/system` prelude. Any model/session failure or unusable response falls
 * back to `slugifyTaskTitle(task.title)`, preserving the deterministic behavior
 * that existed before model-backed naming.
 */
export async function generateBranchSlugWithModel(
	bridge: AgentBridge,
	cwd: string,
	task: Task,
	model: ModelRef | null,
): Promise<string> {
	const fallback = () => slugifyTaskTitle(task.title);
	const prompt = [`Task: T-${task.displayId} — ${task.title}`, "Reply with ONLY the slug, nothing else."].join("\n");

	let session: SessionHandle | undefined;
	try {
		session = await bridge.createSession({
			cwd,
			systemPromptOverride: await resolveAutoWorkIntegrationPrompt("branch-naming"),
			internal: true,
			...(model ? { model } : {}),
		});
		const s = session;
		const outcome = await waitForAutoWorkSessionTerminal(s, 20_000, () => s.prompt(prompt));
		if (outcome !== "completed") {
			log.warn(`branch slug generation timed out for T-${task.displayId}; using deterministic fallback`);
			return fallback();
		}
		const response = latestAssistantText((await session.snapshot()).messages);
		const slug = sanitizeBranchSlug(response);
		return slug || fallback();
	} catch (err) {
		log.warn(`branch slug generation failed for T-${task.displayId}; using deterministic fallback`, err);
		return fallback();
	} finally {
		if (session) {
			try {
				await bridge.deleteSession(session.sessionId);
			} catch (err) {
				log.warn("branch slug generation cleanup failed", err);
			}
		}
	}
}

/** Lowercase kebab-case ASCII, first line only, capped at 40 chars. */
export function sanitizeBranchSlug(text: string): string {
	const firstLine = text.trim().split("\n")[0] ?? "";
	return firstLine
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
}

/**
 * Validate a `ModelRef` against the bridge's live model catalog. Mirrors
 * `routes.ts`'s and `routes-auto-work.ts`'s private `validateModelRef` —
 * duplicated rather than imported since neither is exported and this module
 * owns its own small set of private helpers per the repo's convention.
 */
async function validateModelRef(bridge: AgentBridge, ref: ModelRef): Promise<string | undefined> {
	const models = await bridge.listModels();
	const match = models.find((m) => m.provider === ref.provider && m.id === ref.id);
	if (match) {
		if (!match.isAvailable) return `no auth configured for ${ref.provider}/${ref.id}`;
		return undefined;
	}
	const shadowed = getModelCatalogOverlay()
		.listShadowed()
		.some((s) => s.provider === ref.provider && s.id === ref.id);
	if (shadowed) {
		return `unavailable: ${ref.provider}/${ref.id} (shadowed by catalog overlay)`;
	}
	return `unknown model: ${ref.provider}/${ref.id}`;
}

export interface CreatePullRequestParams {
	/** The worktree directory the PR is opened from — its checked-out branch becomes the PR head. */
	cwd: string;
	title: string;
	body: string;
}

export interface CreatePullRequestResult {
	url: string;
	number: number;
	/** Whether the engine opened a fresh PR or found one the agent had already created. */
	prStatus: "opened" | "already_open";
}

/**
 * Builds the PR title/body Auto Work sends to `gh pr create` (T-119).
 * Deliberately does NOT embed the deck session URL (or any other link) — a
 * public GitHub PR description is not the place for a link into the deck's
 * own (often `localhost`, or otherwise internal) UI. The session stays
 * traceable through its short id instead; the full clickable link lives
 * only in the task's kanban-card note (`completeRunNote` below), which
 * never leaves the deck.
 */
export function buildAutoWorkPrMessage(task: Pick<Task, "displayId" | "title">, sessionId: string): { title: string; body: string } {
	return {
		title: `feat: T-${task.displayId} ${task.title}`,
		body: `Auto Work completed T-${task.displayId}: ${task.title}\n\nSession: ${sessionId.slice(0, 8)}`,
	};
}

export interface ArmAutoMergeParams {
	/** The worktree the PR's head branch is checked out in — `gh` infers the repo/PR from it. */
	cwd: string;
	prNumber: number;
}

/** PR state as the auto-merge reconciler needs it. `"unknown"` = `gh pr view` could not resolve it this pass. */
export type PullRequestMergeState = "merged" | "closed" | "open" | "unknown";

/**
 * Resolves Auto Work's base branch consistently for worktree creation, commit
 * detection, and PR creation. A valid matching `kb://projects/` policy wins.
 * Without one, use the remote symbolic HEAD, then the local origin/HEAD ref.
 * There is deliberately no literal branch-name fallback.
 */
async function resolveBaseBranch(repoCwd: string): Promise<string> {
	const projectPolicy = await resolveProjectBranchPolicy(repoCwd);
	if (projectPolicy) {
		log.info(`using project base branch ${projectPolicy.baseBranch} from ${projectPolicy.sourcePath}`);
		return projectPolicy.baseBranch;
	}

	const remoteDefaultBranch = await resolveRemoteDefaultBranch(repoCwd);
	if (remoteDefaultBranch) return remoteDefaultBranch;

	const localOriginHeadBranch = await resolveLocalOriginHeadBranch(repoCwd);
	if (localOriginHeadBranch) return localOriginHeadBranch;

	throw new Error(
		`unable to resolve Auto Work base branch for ${path.resolve(repoCwd)}: no matching valid project policy, origin HEAD did not identify a branch, and refs/remotes/origin/HEAD is unavailable. Add projectRoot and baseBranch frontmatter under kb://projects/ or configure origin/HEAD.`,
	);
}

/** Reads the authoritative default branch advertised by the remote. */
async function resolveRemoteDefaultBranch(repoCwd: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(["git", "ls-remote", "--symref", "origin", "HEAD"], {
			cwd: repoCwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exitCode !== 0) return undefined;
		for (const line of stdout.split("\n")) {
			const match = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/);
			if (match?.[1]) return match[1];
		}
	} catch {
		// Local refs/remotes/origin/HEAD remains a useful offline fallback.
	}
	return undefined;
}

/** Reads the cached remote HEAD for clones that cannot query the remote. */
async function resolveLocalOriginHeadBranch(repoCwd: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
			cwd: repoCwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exitCode !== 0) return undefined;
		const match = stdout.trim().match(/^origin\/(\S+)$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

/**
 * Maps common `gh pr create` stderr patterns to a short, actionable
 * description (T-85) — raw `gh` stderr for auth expiry, a missing remote,
 * or a rate limit is cryptic on its own. Always falls back to a generic
 * description when nothing recognized matches; the caller still appends
 * the raw stderr so no detail is lost, and the "no commits" case keeps the
 * exact substring `branchHasAgentCommits`'s caller regex-matches on.
 */
function describeGhFailure(stderr: string): string {
	const s = stderr.toLowerCase();
	if (s.includes("gh auth login") || s.includes("not logged into") || s.includes("bad credentials") || s.includes("401"))
		return "GitHub authentication expired or missing — run `gh auth login` (or `gh auth refresh`) on the deck host";
	if (s.includes("rate limit")) return "GitHub API rate limit exceeded — retry once the limit resets";
	if (s.includes("no such remote") || s.includes("no git remotes") || s.includes("not a git repository"))
		return "no GitHub remote configured for this repository";
	if (s.includes("already exists") && s.includes("pull request")) return "a pull request for this branch already exists";
	if (/no commit|must be on a branch|empty (range|commit)/.test(s)) return "branch has no commits ahead of the base branch";
	return "gh pr create failed";
}

/**
 * Pushes the current branch to `origin` and sets the upstream tracking ref.
 * Idempotent — "Everything up-to-date" is success. Must run before
 * `gh pr create` so the head ref exists on GitHub even when the agent
 * didn't push during its own turn.
 */
async function gitPushSetUpstream(cwd: string): Promise<void> {
	let proc: Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(
			["git", "push", "--set-upstream", "origin", "HEAD"],
			{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
		);
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		throw new Error(`git push --set-upstream origin HEAD failed to spawn: ${cause}`);
	}
	const [, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git push --set-upstream origin HEAD failed (exit ${exitCode}): ${stderr.trim()}`);
	}
}

/**
 * Finds an open PR for the current branch via `gh pr view`. Used to recover
 * gracefully when the agent already opened the PR during its turn and
 * `gh pr create` would fail with "already exists".
 * Returns `undefined` when `gh pr view` fails for any reason (no PR, no auth,
 * network error) so the caller can fall through to the normal error path.
 */
async function findExistingPullRequest(cwd: string): Promise<{ url: string; number: number } | undefined> {
	try {
		const proc = Bun.spawn(
			["gh", "pr", "view", "--json", "number,url"],
			{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
		);
		const [stdout, , exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) return undefined;
		const parsed = JSON.parse(stdout) as { number: number; url: string };
		if (typeof parsed.number !== "number" || typeof parsed.url !== "string") return undefined;
		return { number: parsed.number, url: parsed.url };
	} catch {
		return undefined;
	}
}

/**
 * The diff the branch would introduce against its resolved base — the same
 * input a GitHub PR review would show. Scoped to `assertNoSecretsInDiff`
 * (T-119): scanned for credential-shaped ADDED content before the branch is
 * pushed or a PR is opened.
 */
async function diffAgainstBase(cwd: string, baseBranch: string): Promise<string> {
	const proc = Bun.spawn(
		["git", "diff", `origin/${baseBranch}...HEAD`],
		{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		// Fails closed — an unreadable diff must not silently skip the secret
		// scan, so this surfaces as an actionable PR-creation failure instead.
		throw new Error(`git diff origin/${baseBranch}...HEAD failed (exit ${exitCode}): ${stderr.trim()}`);
	}
	return stdout;
}

/**
 * `gh pr create --base <base-branch> --title <title> --body <body>`, run from
 * the worktree directory so `gh` infers the PR head from the checked-out task
 * branch. The same project-aware base resolver used by worktree creation and
 * commit detection also covers explicit PR retries through this function.
 */
export async function createPullRequestViaGh(params: CreatePullRequestParams): Promise<CreatePullRequestResult> {
	// Message guard first — cheap, synchronous, and 100% engine-controlled
	// input, so there's no reason to pay for a diff/push before catching it.
	assertNoSensitiveContent("PR title", params.title);
	assertNoSensitiveContent("PR body", params.body);

	const baseBranch = await resolveBaseBranch(params.cwd);
	// Diff guard before the push below — nothing the branch adds reaches
	// `origin` (or a public PR) once this rejects (T-119).
	assertNoSecretsInDiff(await diffAgainstBase(params.cwd, baseBranch));

	// Push only after both guards pass. Idempotent — "Everything up-to-date"
	// is success — so this stays safe to call twice on retry.
	await gitPushSetUpstream(params.cwd);

	let proc: Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(
			["gh", "pr", "create", "--base", baseBranch, "--title", params.title, "--body", params.body],
			{ cwd: params.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
		);
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		throw new Error(`gh CLI not found on the deck host — install it and run "gh auth login" (${cause})`);
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		// Idempotent recovery: if the agent already opened a PR during its turn,
		// find and return it instead of failing. `gh pr view` looks up the open
		// PR for the current branch without creating a duplicate.
		// Case-insensitive to match both "pull request already exists" and
		// "A pull request ... already exists" forms from different gh versions.
		const stderrLower = stderr.toLowerCase();
		if (stderrLower.includes("already exists") && stderrLower.includes("pull request")) {
			const existing = await findExistingPullRequest(params.cwd);
			if (existing) return { ...existing, prStatus: "already_open" };
		}
		throw new Error(`${describeGhFailure(stderr)} (gh pr create exited ${exitCode}): ${stderr.trim()}`);
	}
	const url = stdout.trim().split("\n").pop() ?? "";
	const match = url.match(/\/pull\/(\d+)\/?$/);
	if (!match) {
		throw new Error(`gh pr create succeeded but its output didn't contain a PR URL: ${stdout.trim()}`);
	}
	return { url, number: Number(match[1]), prStatus: "opened" };
}

// ─── Auto-merge (fully-autonomous mode) ──────────────────────────────────────

/**
 * `gh pr merge <n> --auto --squash`, run from the worktree. `--auto` arms
 * GitHub's native auto-merge (PR merges itself once required checks pass).
 * Only works when the repo has auto-merge enabled AND a required check —
 * both need branch protection, which private free-plan repos lack. Throwing
 * is fine: the caller parks the run pending anyway and the reconciler merges
 * once CI is green. NO `--delete-branch`: it tries a local checkout of the
 * base branch, which is fatal when that branch is checked out in another
 * worktree (the main clone). Remote branch cleanup is the reconciler's job.
 */
async function armAutoMergeViaGh(params: ArmAutoMergeParams): Promise<void> {
	const proc = Bun.spawn(
		["gh", "pr", "merge", String(params.prNumber), "--auto", "--squash"],
		{ cwd: params.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) throw new Error(`gh pr merge --auto exited ${exitCode}: ${stderr.trim()}`);
}

/** Everything the reconciler needs from one `gh pr view` call. */
export interface PullRequestInspection {
	state: PullRequestMergeState;
	/** CI verdict from statusCheckRollup. Empty rollup = "pending" — the checks may simply not have been reported yet. */
	checks: "pending" | "passing" | "failing";
	headRefName?: string;
}

interface RollupEntry {
	// CheckRun rows carry status/conclusion; StatusContext rows carry state.
	status?: string;
	conclusion?: string;
	state?: string;
}

/** `gh pr view <n> --json state,headRefName,statusCheckRollup` → merge state + CI verdict. */
async function inspectPullRequestViaGh(cwd: string, prNumber: number): Promise<PullRequestInspection> {
	const proc = Bun.spawn(["gh", "pr", "view", String(prNumber), "--json", "state,headRefName,statusCheckRollup"], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) return { state: "unknown", checks: "pending" };
	try {
		const parsed = JSON.parse(stdout) as { state?: string; headRefName?: string; statusCheckRollup?: RollupEntry[] };
		let state: PullRequestMergeState;
		switch ((parsed.state ?? "").toUpperCase()) {
			case "MERGED":
				state = "merged";
				break;
			case "CLOSED":
				state = "closed";
				break;
			case "OPEN":
				state = "open";
				break;
			default:
				state = "unknown";
		}
		const rollup = parsed.statusCheckRollup ?? [];
		const isDone = (e: RollupEntry) => (e.state !== undefined ? e.state !== "PENDING" && e.state !== "EXPECTED" : e.status === "COMPLETED");
		const isOk = (e: RollupEntry) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(e.conclusion ?? e.state ?? "");
		// ponytail: empty rollup stays "pending" forever on a repo with no CI —
		// this mode assumes CI exists ("CI is the reviewer"); merging with zero
		// checks would remove the gate entirely.
		let checks: PullRequestInspection["checks"];
		if (rollup.length === 0) checks = "pending";
		else if (rollup.some((e) => isDone(e) && !isOk(e))) checks = "failing";
		else if (rollup.every(isDone)) checks = "passing";
		else checks = "pending";
		return { state, checks, headRefName: parsed.headRefName };
	} catch {
		return { state: "unknown", checks: "pending" };
	}
}

/** `gh pr merge <n> --squash` — immediate merge, used by the reconciler once CI is green. */
async function mergePullRequestViaGh(cwd: string, prNumber: number): Promise<void> {
	const proc = Bun.spawn(["gh", "pr", "merge", String(prNumber), "--squash"], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) throw new Error(`gh pr merge --squash exited ${exitCode}: ${stderr.trim()}`);
}

/** `git push origin --delete <branch>` — remote cleanup after a merge. Throws on failure; callers treat it as best-effort. */
async function deleteRemoteBranchViaGit(cwd: string, branch: string): Promise<void> {
	const proc = Bun.spawn(["git", "push", "origin", "--delete", branch], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) throw new Error(`git push origin --delete ${branch} exited ${exitCode}: ${stderr.trim()}`);
}

/**
 * Pull a just-merged PR into the main clone's local base branch:
 * `git fetch origin`, then a best-effort `git pull --ff-only`. The pull is
 * deliberately allowed to fail silently — if the main worktree has another
 * branch checked out or a dirty tree, the fetch alone already makes the merge
 * commit available locally, and clobbering the user's checkout is never worth
 * it.
 */
async function updateLocalBaseRepo(cwd: string): Promise<void> {
	const fetch = Bun.spawn(["git", "fetch", "origin"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
	const [fetchStderr, fetchExit] = await Promise.all([new Response(fetch.stderr).text(), fetch.exited]);
	if (fetchExit !== 0) {
		log.warn(`git fetch origin in ${cwd} failed (exit ${fetchExit}): ${fetchStderr.trim()}`);
		return;
	}
	const pull = Bun.spawn(["git", "pull", "--ff-only"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
	const pullExit = await pull.exited;
	if (pullExit !== 0) log.debug(`git pull --ff-only in ${cwd} skipped (exit ${pullExit}) — fetch already updated remote refs`);
}

/** Injectable seams for `reconcileAutoMergedRuns` — real `gh`/`git` by default, stubbed in tests. */
export interface ReconcileAutoMergedRunsOptions {
	inspectPullRequest?: (cwd: string, prNumber: number) => Promise<PullRequestInspection>;
	mergePullRequest?: (cwd: string, prNumber: number) => Promise<void>;
	deleteRemoteBranch?: (cwd: string, branch: string) => Promise<void>;
	updateLocalRepo?: (cwd: string) => Promise<void>;
	removeWorktree?: (repoCwd: string, worktreePath: string) => Promise<void>;
	notify?: (event: AutoWorkNotificationEvent) => Promise<void>;
}

/**
 * Second half of fully-autonomous mode: closes the loop on
 * `completed_pending_merge` runs. Called every scheduler tick and whenever
 * run history is listed, so it survives server restarts. For each pending run:
 *  - PR open + CI green → the reconciler merges it itself (`gh pr merge
 *    --squash`) — this is what makes the mode work on repos where GitHub's
 *    native auto-merge is unavailable (private free plan: no required checks).
 *  - PR merged (by us, native auto-merge, or a human) → task to `done`,
 *    delete the remote branch, fetch the merge into the local base repo,
 *    remove the worktree, run → `completed`.
 *  - PR open + CI failed → task to `blocked`, run → `failed`. The worktree is
 *    kept so a human can fix and push from it.
 *  - PR closed unmerged → task to `blocked`, remove the worktree, run →
 *    `failed`.
 *  - CI still pending (or state unresolved this pass) → left untouched.
 * Returns how many runs it advanced.
 */
export async function reconcileAutoMergedRuns(options: ReconcileAutoMergedRunsOptions = {}): Promise<number> {
	const inspectPullRequest = options.inspectPullRequest ?? inspectPullRequestViaGh;
	const mergePullRequest = options.mergePullRequest ?? mergePullRequestViaGh;
	const deleteRemoteBranch = options.deleteRemoteBranch ?? deleteRemoteBranchViaGit;
	const updateLocalRepo = options.updateLocalRepo ?? updateLocalBaseRepo;
	const removeWorktree = options.removeWorktree ?? removeAutoWorkWorktree;
	const notify = options.notify ?? sendAutoWorkNotification;

	let reconciled = 0;
	for (const run of listAutoWorkRuns({ status: "completed_pending_merge" })) {
		if (run.prNumber === null) {
			// Arming always persists the PR number, so this is defensive: a row
			// with no PR can never be reconciled, so close it instead of looping.
			log.warn(`run ${run.id}: completed_pending_merge without a pr_number — marking failed`);
			completeAutoWorkRun(run.id, { status: "failed", failureReason: "pending merge without a pr_number" });
			broadcastBus.broadcast({ type: "auto_work_runs_changed" });
			continue;
		}
		const task = getTask(run.taskId);
		if (!task) {
			completeAutoWorkRun(run.id, { status: "failed", failureReason: "task no longer exists" });
			broadcastBus.broadcast({ type: "auto_work_runs_changed" });
			continue;
		}
		const repoCwd = task.cwd;
		if (!repoCwd) {
			log.warn(`run ${run.id}: task T-${task.displayId} has no cwd — cannot reconcile its merge, leaving pending`);
			continue;
		}
		let pr: PullRequestInspection;
		try {
			pr = await inspectPullRequest(repoCwd, run.prNumber);
		} catch (err) {
			log.warn(`run ${run.id}: PR #${run.prNumber} state lookup failed, leaving pending`, err);
			continue;
		}
		if (pr.state === "unknown") continue;
		if (pr.state === "open" && pr.checks === "pending") continue;

		if (pr.state === "open" && pr.checks === "passing") {
			try {
				await mergePullRequest(repoCwd, run.prNumber);
				pr.state = "merged";
			} catch (err) {
				// A merge conflict with the base, a race with native auto-merge,
				// a gh hiccup — retry next pass rather than failing the run.
				log.warn(`run ${run.id}: CI green but merge of PR #${run.prNumber} failed, retrying next pass`, err);
				continue;
			}
		}

		if (pr.state === "merged") {
			const doneState = findStateByName("done");
			if (doneState) moveTask(task.id, doneState.id, 0);
			if (pr.headRefName) {
				await deleteRemoteBranch(repoCwd, pr.headRefName).catch((err) =>
					log.debug(`run ${run.id}: remote branch ${pr.headRefName} cleanup skipped`, err),
				);
			}
			await updateLocalRepo(repoCwd).catch((err) => log.warn(`run ${run.id}: local repo update failed`, err));
			await removeWorktree(repoCwd, run.worktreePath).catch((err) => log.warn(`run ${run.id}: worktree removal failed`, err));
			completeAutoWorkRun(run.id, { status: "completed" });
			updateTask(task.id, {
				body: appendAgentHistoryEntry(task.body, run.id, new Date().toISOString(), `PR #${run.prNumber} merged — task done.`),
			});
			broadcastBus.broadcast({ type: "tasks_changed" });
			broadcastBus.broadcast({ type: "auto_work_runs_changed" });
			log.info(`run ${run.id}: PR #${run.prNumber} merged — T-${task.displayId} moved to done`);
			await notify({ kind: "task_auto_merged", displayId: task.displayId, prNumber: run.prNumber });
			reconciled += 1;
		} else {
			// PR closed without merging, or open with CI failed. Keep the
			// worktree in the CI-failed case — a human can fix and push from it.
			const closed = pr.state === "closed";
			const reason = closed ? `PR #${run.prNumber} closed without merging` : `CI failed on PR #${run.prNumber}`;
			const blockedState = findStateByName("blocked");
			if (blockedState) moveTask(task.id, blockedState.id, 0);
			if (closed) await removeWorktree(repoCwd, run.worktreePath).catch((err) => log.warn(`run ${run.id}: worktree removal failed`, err));
			completeAutoWorkRun(run.id, { status: "failed", failureReason: reason });
			updateTask(task.id, {
				body: appendAgentHistoryEntry(task.body, run.id, new Date().toISOString(), `${reason} — task blocked.`),
			});
			broadcastBus.broadcast({ type: "tasks_changed" });
			broadcastBus.broadcast({ type: "auto_work_runs_changed" });
			log.warn(`run ${run.id}: ${reason} — T-${task.displayId} moved to blocked`);
			await notify({ kind: "task_failed", displayId: task.displayId, reason });
			reconciled += 1;
		}
	}
	return reconciled;
}


// ─── Global cycle (multi-workspace) ─────────────────────────────────────────

/**
 * How many auto-work–enabled workspaces currently have at least one eligible
 * task (autoWork flag, backlog state, dependencies met). Used by the
 * schedule-status endpoint so the UI can show whether there's work to do.
 * Pure DB read — does NOT run preflight, budget, or mutex checks.
 */
export function countEligibleWorkspaces(): number {
	const allTasks = listTasks();
	const backlogState = findStateByName("backlog");
	const doneState = findStateByName("done");
	if (!backlogState || !doneState) return 0;

	const tasksByCwd = new Map<string, Task[]>();
	for (const t of allTasks) {
		if (!t.cwd) continue;
		const list = tasksByCwd.get(t.cwd) ?? [];
		list.push(t);
		tasksByCwd.set(t.cwd, list);
	}

	const tasksById = new Map(allTasks.map((t) => [t.id, t]));
	let count = 0;
	for (const [cwd, cwdTasks] of tasksByCwd) {
		const config = getAutoWorkConfig(cwd);
		if (!config.enabled) continue;
		const hasEligible = cwdTasks.some(
			(t) =>
				t.autoWork &&
				t.stateId === backlogState.id &&
				t.dependsOn.every((depId) => tasksById.get(depId)?.stateId === doneState.id),
		);
		if (hasEligible) count++;
	}
	return count;
}

/**
 * Global auto-work cycle: selects the highest-priority eligible task across
 * ALL enabled workspaces and runs it. Called by the global scheduler and the
 * manual trigger endpoint.
 *
 * Algorithm (priority-based, LLM selection deferred to a future iteration):
 * 1. Fetch subscription usage once (shared across workspace checks).
 * 2. For each workspace with `enabled: true`, run preflight + task selection.
 * 3. Collect all candidates (workspace, task, estimatedCostPct).
 * 4. Pick the candidate whose task has the highest priority (lowest PRIORITY_ORDER).
 * 5. Run `runAutoWorkCycle` for the winning workspace, passing the already-
 *    fetched subscription usage so it isn't re-fetched.
 *
 * Returns `{ outcome: "skipped" }` when no workspace passes preflight or no
 * task fits the budget. Returns the inner `AutoWorkCycleResult` otherwise.
 */
export async function runGlobalAutoWorkCycle(
	bridge: AgentBridge,
	options: RunGlobalAutoWorkCycleOptions = {},
): Promise<AutoWorkCycleResult> {
	const now = (options.now ?? (() => new Date()))();
	const usageLookup = options.getSubscriptionUsage ?? (() => getSubscriptionUsage());
	const usage = await usageLookup();
	const subscriptionPctUsed = usage.available && typeof usage.weeklyPct === "number" ? usage.weeklyPct : null;
	const sessionPctUsed = usage.available && typeof usage.sessionPct === "number" ? usage.sessionPct : null;
	const resolveDeckBaseUrl = options.getDeckBaseUrl ?? (() => getServerDeckBaseUrl(loadConfig()).deckBaseUrl);
	const createPullRequest = options.createPullRequest ?? createPullRequestViaGh;
	const notify = options.notify ?? sendAutoWorkNotification;

	const backlogState = findStateByName("backlog");
	const doneState = findStateByName("done");
	if (!backlogState || !doneState) {
		return { outcome: "skipped", reason: "backlog/done task states missing — cannot run auto-work" };
	}

	// A `running` row surviving a restart (T-106): `activeRunIds` is this
	// process's authoritative "a finalizer is actually watching this run"
	// signal, so any running row missing from it is orphaned rather than
	// genuinely in flight. Route it through the owning workspace's
	// resume/retire path instead of wedging the global mutex forever.
	const orphanRun = listAutoWorkRuns({ status: "running" }).find((r) => !activeRunIds.has(r.id));
	if (orphanRun) {
		const orphanTask = getTask(orphanRun.taskId);
		if (orphanTask?.cwd) {
			const resumed = await resumeOrRetireAutoWorkRun(
				orphanTask.cwd,
				bridge,
				orphanRun,
				getAutoWorkConfig(orphanTask.cwd),
				{ resolveDeckBaseUrl, createPullRequest, armAutoMerge: options.armAutoMerge ?? armAutoMergeViaGh, notify, usageLookup },
			);
			if (resumed) return resumed;
		} else {
			const routing = failAutoWorkRun(orphanRun.id, orphanRun.taskId, "session_lost");
			log.warn(
				`global cycle: run ${orphanRun.id} has no resolvable task/cwd — marked failed${routing.exhausted ? " (MAX_RETRIES_EXCEEDED)" : ""}`,
			);
		}
	}

	// Global Auto Work is deliberately sequential: a genuinely live run
	// anywhere still defers this cycle, rather than starting work elsewhere.
	if (listAutoWorkRuns({ status: "running" }).length > 0) {
		return { outcome: "skipped", reason: "another auto-work run is already active" };
	}

	const allTasks = listTasks();

	// Collect distinct enabled cwds from all auto-work–flagged tasks.
	const enabledCwds = new Set<string>();
	for (const t of allTasks) {
		if (!t.autoWork || !t.cwd) continue;
		const config = getAutoWorkConfig(t.cwd);
		if (config.enabled) enabledCwds.add(t.cwd);
	}

	// Auto-work backlog tasks without a workspace can never run — the task
	// write paths reject that state now, but pre-existing rows (or direct DB
	// edits) must be loudly visible instead of silently ignored.
	const orphaned = allTasks.filter((t) => t.autoWork && t.stateId === backlogState.id && !t.cwd?.trim());
	const orphanNote =
		orphaned.length > 0
			? `${orphaned.length} auto-work task(s) have no workspace (cwd) and were ignored: ${orphaned
					.map((t) => `T-${t.displayId}`)
					.join(", ")} — set a cwd on the task card`
			: undefined;
	if (orphanNote) log.warn(`global cycle: ${orphanNote}`);

	if (enabledCwds.size === 0) {
		const reason = orphanNote
			? `no workspace has auto-work enabled — ${orphanNote}`
			: "no workspace has auto-work enabled";
		log.info(`global cycle skipped: ${reason}`);
		return { outcome: "skipped", reason };
	}

	// Per-workspace: preflight + task selection.
	const tasksById = new Map(allTasks.map((t) => [t.id, t]));

	const candidates: GlobalAutoWorkCandidate[] = [];
	const workspaceSkips: string[] = [];

	for (const cwd of enabledCwds) {
		const config = getAutoWorkConfig(cwd);
		const activeRuns = listAutoWorkRuns({ status: "running" }).filter((r) => {
			const task = tasksById.get(r.taskId);
			return task?.cwd === cwd;
		});
		const preflight = checkAutoWorkPreflight({ config, now, subscriptionPctUsed, sessionPctUsed, activeRuns });
		if (!preflight.ok) {
			workspaceSkips.push(`${cwd}: ${preflight.reason}`);
			continue;
		}
		const cwdTasks = allTasks.filter((t) => t.cwd === cwd);
		const selection = selectNextAutoWorkTask({
			tasks: cwdTasks,
			config,
			currentPctUsed: subscriptionPctUsed ?? 0,
			backlogStateId: backlogState.id,
			doneStateId: doneState.id,
			estimateCostPct: (priority) => estimateTaskCostPct(priority, config),
		});
		if (selection.kind === "selected") {
			candidates.push({ workspaceCwd: cwd, task: selection.task, estimatedCostPct: selection.estimatedCostPct });
		} else if (selection.kind === "none_eligible") {
			workspaceSkips.push(`${cwd}: no eligible auto-work tasks in backlog`);
		} else if (selection.kind === "none_fit") {
			workspaceSkips.push(`${cwd}: ${selection.consideredCount} eligible task(s) exceed the current budget`);
		}
	}

	if (candidates.length === 0) {
		const details = [...workspaceSkips, ...(orphanNote ? [orphanNote] : [])].join(" / ");
		const reason = details
			? `no runnable auto-work task: ${details}`
			: "no eligible task fits the current budget across all workspaces";
		log.info(`global cycle skipped: ${reason}`);
		return { outcome: "skipped", reason };
	}

	// Priority remains the deterministic fallback. A selector only runs after
	// candidates exist, so the system never spends a model request on an empty queue.
	candidates.sort(
		(a, b) =>
			PRIORITY_ORDER[a.task.priority] - PRIORITY_ORDER[b.task.priority] ||
			a.task.orderInState - b.task.orderInState,
	);
	const selectedTaskId = options.selectTask
		? await options.selectTask(candidates)
		: await selectTaskWithModel(bridge, candidates, options.taskSelectionModel ?? null);
	const winner = candidates.find((candidate) => candidate.task.id === selectedTaskId) ?? candidates[0]!;
	log.info(
		`global cycle: selected T-${winner.task.displayId} "${winner.task.title}" (${winner.task.priority}) in ${winner.workspaceCwd}`,
	);

	// Run the cycle for the winning workspace, sharing the already-fetched usage.
	// This is the production entry point (scheduler + manual trigger), so unless
	// a caller already injected its own `generateBranchSlug` (e.g. a test), wire
	// in the real LLM-backed generator using the same global model.
	const cachedUsage = usage;
	return runAutoWorkCycle(winner.workspaceCwd, bridge, {
		...options,
		now: () => now,
		getSubscriptionUsage: () => Promise.resolve(cachedUsage),
		pinnedTaskId: winner.task.id,
		generateBranchSlug:
			options.generateBranchSlug ??
			((task) => generateBranchSlugWithModel(bridge, winner.workspaceCwd, task, options.taskSelectionModel ?? null)),
	});
}

/**
 * Ask a short-lived agent session to select one candidate task. The prompt
 * contains no task bodies or repository content, only the fields needed for
 * prioritization. The response must be one candidate task ID. Any malformed
 * response or model/session error returns undefined so priority order wins.
 */
async function selectTaskWithModel(
	bridge: AgentBridge,
	candidates: GlobalAutoWorkCandidate[],
	model: ModelRef | null,
): Promise<string | undefined> {
	const candidateList = candidates
		.map((candidate) =>
			[
				`id=${candidate.task.id}`,
				`display=T-${candidate.task.displayId}`,
				`priority=${candidate.task.priority}`,
				`workspace=${candidate.workspaceCwd}`,
				`estimatePct=${candidate.estimatedCostPct.toFixed(1)}`,
				`title=${JSON.stringify(candidate.task.title)}`,
			].join(" | "),
		)
		.join("\n");
	const prompt = [
		"Choose exactly one task ID from the candidate list for the next unattended engineering run.",
		"Prioritize urgency, small safe high-value work, and avoiding risky broad changes.",
		"Return ONLY the exact id= value, with no prose, punctuation, or markdown.",
		"Candidates:",
		candidateList,
	].join("\n");

	let session: SessionHandle | undefined;
	try {
		session = await bridge.createSession({
			cwd: candidates[0]!.workspaceCwd,
			systemPromptOverride: await resolveAutoWorkIntegrationPrompt("auto-work-task-selection"),
			internal: true,
			...(model ? { model } : {}),
		});
		const s = session;
		const outcome = await waitForAutoWorkSessionTerminal(s, 30_000, () => s.prompt(prompt));
		if (outcome !== "completed") {
			log.warn("global task selector timed out; using priority order");
			return undefined;
		}
		const response = latestAssistantText((await session.snapshot()).messages);
		const match = candidates.find((candidate) => response.trim() === candidate.task.id);
		if (!match) {
			log.warn(`global task selector returned an invalid task ID; using priority order`);
			return undefined;
		}
		return match.task.id;
	} catch (err) {
		log.warn("global task selector failed; using priority order", err);
		return undefined;
	} finally {
		if (session) {
			try {
				await bridge.deleteSession(session.sessionId);
			} catch (err) {
				log.warn("global task selector cleanup failed", err);
			}
		}
	}
}


export interface SqueezeDecisionInput {
	/** Any enabled workspace's cwd — only hosts the ephemeral decision session, no repo content is sent. */
	workspaceCwd: string;
	sessionPct: number;
	sessionResetAt: string;
	weeklyPct: number;
	weeklyResetAt: string;
	eligibleWorkspaceCount: number;
	scheduleIntervalMinutes: number;
}

/**
 * Ask a short-lived agent session — the global `taskSelectionModel` ("the
 * model assigned for decision-making") — whether Auto Work should start
 * another cycle immediately instead of waiting for the next scheduled tick
 * (T-75 "squeeze" mode). Only called after `shouldConsiderSqueeze` already
 * confirmed real unused-capacity risk; the model makes the nuanced call the
 * pure heuristic can't (how much runway is realistically left, whether it's
 * worth starting a task that might not finish before the window resets
 * anyway). Any model/session failure or ambiguous response defaults to
 * `false` — squeeze mode only ever shortens idle time between scheduled
 * cycles, it never forces work the normal cadence wouldn't otherwise reach.
 */
export async function decideSqueezeTiming(
	bridge: AgentBridge,
	input: SqueezeDecisionInput,
	model: ModelRef | null,
): Promise<boolean> {
	const prompt = [
		"Auto Work just finished a cycle. Decide whether to start the next eligible task right now,",
		"instead of waiting for the next scheduled poll, so unused subscription capacity isn't wasted",
		"when the usage window resets.",
		`Session usage window: ${input.sessionPct.toFixed(1)}% used, resets at ${input.sessionResetAt}.`,
		`Weekly usage window: ${input.weeklyPct.toFixed(1)}% used, resets at ${input.weeklyResetAt}.`,
		`Normal poll interval: ${input.scheduleIntervalMinutes} minute(s).`,
		`Workspaces with eligible backlog work right now: ${input.eligibleWorkspaceCount}.`,
		"Reply with exactly one word: YES to start another task now, or NO to wait for the next scheduled poll.",
	].join("\n");

	let session: SessionHandle | undefined;
	try {
		session = await bridge.createSession({
			cwd: input.workspaceCwd,
			systemPromptOverride: await resolveAutoWorkIntegrationPrompt("auto-work-squeeze"),
			internal: true,
			...(model ? { model } : {}),
		});
		const s = session;
		const outcome = await waitForAutoWorkSessionTerminal(s, 30_000, () => s.prompt(prompt));
		if (outcome !== "completed") {
			log.warn("squeeze timing decision timed out; deferring to the next scheduled tick");
			return false;
		}
		const response = latestAssistantText((await session.snapshot()).messages).trim().toUpperCase();
		if (response.startsWith("YES")) return true;
		if (response.startsWith("NO")) return false;
		log.warn(`squeeze timing decision returned an unexpected response ${JSON.stringify(response)}; deferring`);
		return false;
	} catch (err) {
		log.warn("squeeze timing decision failed; deferring to the next scheduled tick", err);
		return false;
	} finally {
		if (session) {
			try {
				await bridge.deleteSession(session.sessionId);
			} catch (err) {
				log.warn("squeeze timing decision cleanup failed", err);
			}
		}
	}
}

/** Extract text from the most recent assistant message without unchecked casts. */
export function latestAssistantText(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) continue;
		const text = message.content.flatMap((block) => {
			if (
				block &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
			) return [block.text];
			return [];
		}).join("");
		if (text) return text;
	}
	return "";
}