/**
 * Global Auto Work scheduler — one `setInterval` for the whole server.
 * Reads `AutoWorkGlobalConfig` (`schedule_enabled`, `schedule_interval_minutes`)
 * and fires `runGlobalAutoWorkCycle` on each tick, which itself iterates all
 * enabled workspaces and picks the best task to run.
 *
 * State (lastTriggeredAt, lastOutcome) is in-process memory only.
 * Call `initScheduler` at server boot and `disposeScheduler` on shutdown.
 * Call `updateGlobalSchedule` whenever the global config changes.
 */

import type { AutoWorkCycleResult, AutoWorkGlobalConfig, AutoWorkScheduleStatus } from "@omp-deck/protocol";

import type { AgentBridge } from "../bridge/types.ts";
import { getAutoWorkGlobalConfig } from "../db/auto-work-global.ts";
import { listAutoWorkConfigs } from "../db/auto-work.ts";
import { getSubscriptionUsage } from "../usage-subscription.ts";
import { broadcastBus } from "../broadcast-bus.ts";
import { runGlobalAutoWorkCycle, countEligibleWorkspaces, shouldConsiderSqueeze, decideSqueezeTiming, reconcileAutoMergedRuns } from "./engine.ts";
import type { RunAutoWorkCycleOptions } from "./engine.ts";
import { logger } from "../log.ts";

const log = logger("auto-work:scheduler");

// ─── In-process state ────────────────────────────────────────────────────────

/** Mutable state shared between scheduler ticks and the status endpoint. */
export interface GlobalScheduleState {
	lastTriggeredAt: string | null;
	lastOutcome: AutoWorkCycleResult | null;
}

interface InternalState extends GlobalScheduleState {
	timer: NodeJS.Timeout | null;
}

// Single instance — the scheduler is a process singleton.
const state: InternalState = { timer: null, lastTriggeredAt: null, lastOutcome: null };

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the current global schedule status for the REST endpoint.
 * Reads the global config for `scheduleEnabled`, `scheduleIntervalMinutes`,
 * `taskSelectionModel`, and `squeezeEnabled`; the rest comes from in-process state.
 */
export function getScheduleStatus(): AutoWorkScheduleStatus {
	const config = getAutoWorkGlobalConfig();
	return {
		scheduleEnabled: config.scheduleEnabled,
		scheduleIntervalMinutes: config.scheduleIntervalMinutes,
		taskSelectionModel: config.taskSelectionModel,
		squeezeEnabled: config.squeezeEnabled,
		lastTriggeredAt: state.lastTriggeredAt,
		lastOutcome: state.lastOutcome,
		eligibleWorkspaceCount: countEligibleWorkspaces(),
	};
}

/** Safety cap on consecutive extra cycles a single squeeze follow-up chain may start. */
const MAX_SQUEEZE_ITERATIONS = 10;

/**
 * After a scheduled cycle settles, squeeze mode (T-75) decides whether to
 * chain another cycle immediately rather than waiting for the next tick.
 * Loops (bounded) as long as: there is still eligible backlog work, the
 * pure `shouldConsiderSqueeze` gate sees real unused-capacity risk, the
 * assigned model agrees, and the resulting cycle actually ran something
 * (a `"skipped"` outcome means nothing fits right now — further asking is
 * pointless until state changes, so the loop stops there too).
 */
async function runSqueezeFollowUps(
	config: AutoWorkGlobalConfig,
	bridge: AgentBridge,
	cycleOptions: RunAutoWorkCycleOptions,
): Promise<void> {
	if (!config.squeezeEnabled) return;

	for (let iteration = 0; iteration < MAX_SQUEEZE_ITERATIONS; iteration++) {
		const usage = await getSubscriptionUsage();
		if (!usage.available) break;

		const eligibleWorkspaceCount = countEligibleWorkspaces();
		const gate = shouldConsiderSqueeze({
			now: new Date(),
			scheduleIntervalMinutes: config.scheduleIntervalMinutes,
			sessionPct: usage.sessionPct,
			sessionResetAt: usage.sessionResetAt,
			eligibleWorkspaceCount,
		});
		if (!gate) break;

		const enabledWorkspace = listAutoWorkConfigs().find((c) => c.enabled);
		if (!enabledWorkspace) break;

		const shouldRunNow = await decideSqueezeTiming(
			bridge,
			{
				workspaceCwd: enabledWorkspace.workspaceCwd,
				sessionPct: usage.sessionPct,
				sessionResetAt: usage.sessionResetAt,
				weeklyPct: usage.weeklyPct,
				weeklyResetAt: usage.weeklyResetAt,
				eligibleWorkspaceCount,
				scheduleIntervalMinutes: config.scheduleIntervalMinutes,
			},
			config.taskSelectionModel,
		);
		if (!shouldRunNow) break;

		log.info(`squeeze mode: starting an extra cycle (${iteration + 1}/${MAX_SQUEEZE_ITERATIONS})`);
		state.lastTriggeredAt = new Date().toISOString();
		const outcome = await runGlobalAutoWorkCycle(bridge, { ...cycleOptions, taskSelectionModel: config.taskSelectionModel });
		state.lastOutcome = outcome;
		broadcastBus.broadcast({ type: "auto_work_runs_changed" });
		if (outcome.outcome === "skipped") break;
	}
}

/**
 * Start, restart, or stop the global polling timer based on the config.
 * Safe to call repeatedly — always clears the previous timer first.
 */
export function updateGlobalSchedule(
	config: AutoWorkGlobalConfig,
	bridge: AgentBridge,
	cycleOptions: RunAutoWorkCycleOptions = {},
): void {
	if (state.timer !== null) {
		clearInterval(state.timer);
		state.timer = null;
	}

	if (!config.scheduleEnabled) {
		log.info(`global schedule disabled`);
		return;
	}

	const intervalMs = Math.max(1, config.scheduleIntervalMinutes) * 60_000;
	log.info(`global schedule: every ${config.scheduleIntervalMinutes} min`);
	const tick = (): void => {
		state.lastTriggeredAt = new Date().toISOString();
		// Advance any auto-merge runs whose PR merged since the last tick
		// (fully-autonomous mode). Best-effort — never blocks the cycle below.
		reconcileAutoMergedRuns().catch((err: unknown) => log.warn(`auto-merge reconcile failed`, err));
		runGlobalAutoWorkCycle(bridge, { ...cycleOptions, taskSelectionModel: config.taskSelectionModel })
			.then(async (outcome) => {
				state.lastOutcome = outcome;
				await runSqueezeFollowUps(config, bridge, cycleOptions);
			})
			.catch((err: unknown) => {
				log.error(`scheduled global cycle error`, err);
				state.lastOutcome = { outcome: "skipped", reason: String(err) };
			})
			.finally(() => {
				broadcastBus.broadcast({ type: "auto_work_runs_changed" });
			});
	};

	state.timer = setInterval(tick, intervalMs);
}

/**
 * Called once at server boot — reads the persisted global config and starts
 * the timer if `scheduleEnabled` is true.
 */
export function initScheduler(bridge: AgentBridge, cycleOptions: RunAutoWorkCycleOptions = {}): void {
	const config = getAutoWorkGlobalConfig();
	if (!config.scheduleEnabled) {
		log.info(`no global schedule at boot (disabled)`);
		return;
	}
	log.info(`restoring global schedule from boot`);
	updateGlobalSchedule(config, bridge, cycleOptions);
}

/** Clears the timer — call in the server's shutdown handler. */
export function disposeScheduler(): void {
	if (state.timer !== null) {
		clearInterval(state.timer);
		state.timer = null;
		log.info(`global schedule cleared`);
	}
}

/**
 * Records a manual trigger (called by the POST /auto-work/trigger route)
 * so `lastTriggeredAt`/`lastOutcome` stay in sync with manual runs too.
 */
export function recordManualTrigger(outcome: AutoWorkCycleResult): void {
	state.lastTriggeredAt = new Date().toISOString();
	state.lastOutcome = outcome;
}
