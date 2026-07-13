/**
 * Auto Work REST surface. Mounted at `/api/auto-work/*`.
 *
 * Per-workspace:
 *   GET  /auto-work/config?cwd=          per-workspace config (defaults when unconfigured)
 *   PUT  /auto-work/config?cwd=          replace full workspace config
 *   GET  /auto-work/runs?…               run history, filterable
 *   GET  /auto-work/cost-estimate?priority=
 *   POST /auto-work/runs/:id/create-pr   retry PR creation for a completed run without one
 *
 * Global:
 *   GET  /auto-work/global-config        schedule interval, task-selection model
 *   PUT  /auto-work/global-config        replace global config; reconfigures the scheduler
 *   POST /auto-work/trigger              run the global cycle immediately
 *   GET  /auto-work/schedule-status      last trigger, last outcome, eligibleWorkspaceCount
 */

import * as path from "node:path";
import { Hono } from "hono";
import type {
	AutoWorkConfig,
	AutoWorkCostEstimateResponse,
	AutoWorkCycleResult,
	AutoWorkGlobalConfig,
	AutoWorkRunStatus,
	AutoWorkScheduleStatus,
	ListAutoWorkRunsResponse,
	ModelRef,
	SetAutoWorkConfigRequest,
	SetAutoWorkGlobalConfigRequest,
	TaskPriority,
} from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";
import { isCwdAllowed } from "./routes-fs.ts";
import { getAutoWorkConfig, setAutoWorkConfig } from "./db/auto-work.ts";
import { getAutoWorkGlobalConfig, setAutoWorkGlobalConfig } from "./db/auto-work-global.ts";
import { completeAutoWorkRun, getAutoWorkCostEstimate, getAutoWorkRun, listAutoWorkRuns } from "./db/auto-work-runs.ts";
import { getDeckBaseUrl as getServerDeckBaseUrl } from "./db/server-settings.ts";
import { getTask, updateTask } from "./db/tasks.ts";
import { appendAgentHistoryEntry, reconcileInactiveAutoWorkRuns, reconcileAutoMergedRuns, runGlobalAutoWorkCycle, createPullRequestViaGh } from "./auto-work/engine.ts";
import type { RunAutoWorkCycleOptions } from "./auto-work/engine.ts";
import { buildSessionUrl } from "./deck-links.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { getScheduleStatus, updateGlobalSchedule, recordManualTrigger } from "./auto-work/scheduler.ts";
import { logger } from "./log.ts";
import { getModelCatalogOverlay } from "./model-catalog-overlay.ts";

const log = logger("routes:auto-work");

const TASK_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4", "P5"];
const RUN_STATUSES: AutoWorkRunStatus[] = ["running", "completed", "completed_pr_failed", "failed", "timed_out"];

export function buildAutoWorkRouter(bridge: AgentBridge, config: Config, cycleOptions: RunAutoWorkCycleOptions = {}): Hono {
	const app = new Hono();

	// ─── Per-workspace config ─────────────────────────────────────────────────

	app.get("/auto-work/config", (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		// No cwd existence check: the cwd is a pure DB key. Workspaces may be on
		// NFS or temporarily inaccessible — their config must still be readable.
		const autoWorkConfig: AutoWorkConfig = getAutoWorkConfig(cwd);
		return c.json(autoWorkConfig);
	});

	app.put("/auto-work/config", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		if (!path.isAbsolute(cwd)) return c.json({ error: "cwd must be an absolute path" }, 400);

		let body: SetAutoWorkConfigRequest;
		try {
			body = (await c.req.json()) as SetAutoWorkConfigRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		const shapeError = validateWorkspaceShape(body);
		if (shapeError) return c.json({ error: shapeError }, 400);

		for (const priority of TASK_PRIORITIES) {
			const ref = body.modelByPriority[priority];
			if (ref === null) continue;
			const invalid = await validateModelRef(bridge, ref);
			if (invalid) return c.json({ error: `${priority}: ${invalid}` }, 400);
		}

		try {
			const saved = setAutoWorkConfig(cwd, {
				enabled: body.enabled,
				autoMerge: body.autoMerge,
				modelByPriority: body.modelByPriority,
				timeWindows: body.timeWindows,
				sessionPctLimit: body.sessionPctLimit,
				weeklyPctLimit: body.weeklyPctLimit,
				weeklyPctThreshold: body.weeklyPctThreshold,
				defaultEstimatePctByPriority: body.defaultEstimatePctByPriority,
				estimationBuffer: body.estimationBuffer,
				timeoutMinutesByPriority: body.timeoutMinutesByPriority,
			});
			return c.json(saved);
		} catch (err) {
			log.error("setAutoWorkConfig failed", err);
			return c.json({ error: String(err) }, 500);
		}
	});

	// ─── Run history ─────────────────────────────────────────────────────────

	app.get("/auto-work/runs", async (c) => {
		const limitParam = c.req.query("limit");
		let limit: number | undefined;
		if (limitParam !== undefined) {
			limit = Number(limitParam);
			if (!Number.isInteger(limit) || limit <= 0) {
				return c.json({ error: "limit must be a positive integer" }, 400);
			}
		}

		const taskId = c.req.query("taskId")?.trim() || undefined;

		const priorityParam = c.req.query("priority")?.trim();
		let priority: TaskPriority | undefined;
		if (priorityParam !== undefined) {
			if (!TASK_PRIORITIES.includes(priorityParam as TaskPriority)) {
				return c.json({ error: `priority must be one of ${TASK_PRIORITIES.join(", ")}` }, 400);
			}
			priority = priorityParam as TaskPriority;
		}

		const statusParam = c.req.query("status")?.trim();
		let status: AutoWorkRunStatus | undefined;
		if (statusParam !== undefined) {
			if (!RUN_STATUSES.includes(statusParam as AutoWorkRunStatus)) {
				return c.json({ error: `status must be one of ${RUN_STATUSES.join(", ")}` }, 400);
			}
			status = statusParam as AutoWorkRunStatus;
		}

		await reconcileInactiveAutoWorkRuns(bridge);
		await reconcileAutoMergedRuns().catch((err) => log.warn("auto-merge reconcile failed", err));
		const response: ListAutoWorkRunsResponse = { runs: listAutoWorkRuns({ limit, taskId, priority, status }) };
		return c.json(response);
	});

	// ─── PR retry ─────────────────────────────────────────────────────────────

	// Retries `gh pr create` for a run whose implementation completed but PR
	// creation failed (`status: "completed_pr_failed"`) — also accepts a
	// plain `"completed"` run for pre-T-85 historical rows, since `gh` fails
	// harmlessly if a PR already exists, so this stays safe to call twice.
	// Success flips the run back to `status: "completed"`, clears
	// `failureReason`, and appends the outcome to the task's Agent History
	// section rather than rewriting the original failure note in place, so
	// the failed attempt stays in the record (T-85).
	app.post("/auto-work/runs/:id/create-pr", async (c) => {
		const runId = c.req.param("id");
		const run = getAutoWorkRun(runId);
		if (!run) return c.json({ error: "run not found" }, 404);
		if (run.status !== "completed" && run.status !== "completed_pr_failed")
			return c.json({ error: `run is not completed (status: ${run.status})` }, 400);

		const task = getTask(run.taskId);
		if (!task) return c.json({ error: "task not found for run" }, 404);

		const deckBaseUrl = getServerDeckBaseUrl(config).deckBaseUrl;
		const sessionUrl = buildSessionUrl(deckBaseUrl, run.sessionId);

		try {
			const createPr = cycleOptions.createPullRequest ?? createPullRequestViaGh;
			const pr = await createPr({
				cwd: run.worktreePath,
				title: `feat: T-${task.displayId} ${task.title}`,
				body: `Auto Work completed T-${task.displayId}: ${task.title}\n\nSession: ${sessionUrl}`,
			});

			completeAutoWorkRun(runId, {
				status: "completed",
				inputTokens: run.inputTokens,
				outputTokens: run.outputTokens,
				pctConsumed: run.pctConsumed,
				failureReason: null,
			});
			updateTask(task.id, {
				body: appendAgentHistoryEntry(task.body, runId, new Date().toISOString(), `PR retry succeeded: PR #${pr.number}.`),
			});

			broadcastBus.broadcast({ type: "tasks_changed" });
			broadcastBus.broadcast({ type: "auto_work_runs_changed" });

			log.info(`run ${runId}: PR retry opened PR #${pr.number} (${pr.url}) for T-${task.displayId}`);
			return c.json({ number: pr.number, url: pr.url });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.error(`run ${runId}: PR retry failed for T-${task.displayId}`, err);
			return c.json({ error: message }, 500);
		}
	});

	// ─── Cost estimate ────────────────────────────────────────────────────────

	app.get("/auto-work/cost-estimate", (c) => {
		const priorityParam = c.req.query("priority")?.trim();
		if (!priorityParam || !TASK_PRIORITIES.includes(priorityParam as TaskPriority)) {
			return c.json({ error: `priority query param must be one of ${TASK_PRIORITIES.join(", ")}` }, 400);
		}
		const response: AutoWorkCostEstimateResponse = getAutoWorkCostEstimate(priorityParam as TaskPriority);
		return c.json(response);
	});

	// ─── Global config ────────────────────────────────────────────────────────

	app.get("/auto-work/global-config", (_c) => {
		return _c.json(getAutoWorkGlobalConfig());
	});

	app.put("/auto-work/global-config", async (c) => {
		let body: SetAutoWorkGlobalConfigRequest;
		try {
			body = (await c.req.json()) as SetAutoWorkGlobalConfigRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		const shapeError = validateGlobalShape(body);
		if (shapeError) return c.json({ error: shapeError }, 400);

		if (body.taskSelectionModel !== null) {
			const invalid = await validateModelRef(bridge, body.taskSelectionModel);
			if (invalid) return c.json({ error: `taskSelectionModel: ${invalid}` }, 400);
		}

		try {
			const saved: AutoWorkGlobalConfig = setAutoWorkGlobalConfig({
				scheduleEnabled: body.scheduleEnabled,
				scheduleIntervalMinutes: body.scheduleIntervalMinutes,
				taskSelectionModel: body.taskSelectionModel,
				squeezeEnabled: body.squeezeEnabled,
			});
			// Reconfigure the in-process scheduler immediately.
			updateGlobalSchedule(saved, bridge, {
				getDeckBaseUrl: () => getServerDeckBaseUrl(config).deckBaseUrl,
				...cycleOptions,
			});
			return c.json(saved);
		} catch (err) {
			log.error("setAutoWorkGlobalConfig failed", err);
			return c.json({ error: String(err) }, 500);
		}
	});

	// Fires one global auto-work cycle immediately. The engine iterates all
	// enabled workspaces and picks the highest-priority eligible task to run.
	// The per-workspace mutex still prevents double-running a workspace that
	// already has an active run.
	app.post("/auto-work/trigger", async (c) => {
		try {
			const globalConfig = getAutoWorkGlobalConfig();
			const result: AutoWorkCycleResult = await runGlobalAutoWorkCycle(bridge, {
				getDeckBaseUrl: () => getServerDeckBaseUrl(config).deckBaseUrl,
				taskSelectionModel: globalConfig.taskSelectionModel,
				...cycleOptions,
			});
			recordManualTrigger(result);
			return c.json(result);
		} catch (err) {
			log.error("auto-work global trigger failed", err);
			return c.json({ error: String(err) }, 500);
		}
	});

	// ─── Schedule status ──────────────────────────────────────────────────────

	// Global: last trigger time/outcome and how many workspaces have eligible work.
	app.get("/auto-work/schedule-status", (_c) => {
		const status: AutoWorkScheduleStatus = getScheduleStatus();
		return _c.json(status);
	});

	return app;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateWorkspaceShape(body: SetAutoWorkConfigRequest): string | undefined {
	if (typeof body.enabled !== "boolean") return "enabled must be a boolean";
	if (typeof body.autoMerge !== "boolean") return "autoMerge must be a boolean";

	if (typeof body.modelByPriority !== "object" || body.modelByPriority === null) {
		return "modelByPriority must be an object";
	}
	for (const priority of TASK_PRIORITIES) {
		const ref = body.modelByPriority[priority];
		if (ref === undefined) return `modelByPriority.${priority} is required (use null for no override)`;
		if (ref === null) continue;
		if (typeof ref !== "object" || typeof ref.provider !== "string" || typeof ref.id !== "string") {
			return `modelByPriority.${priority} must be null or {provider, id}`;
		}
	}

	if (!Array.isArray(body.timeWindows)) return "timeWindows must be an array";
	const sortedWindows = [...body.timeWindows].sort((a, b) => a.start - b.start);
	for (let i = 0; i < sortedWindows.length; i++) {
		const w = sortedWindows[i]!;
		if (!Number.isInteger(w.start) || w.start < 0 || w.start > 23)
			return `timeWindows[${i}].start must be an integer 0–23`;
		if (!Number.isInteger(w.end) || w.end < 1 || w.end > 24)
			return `timeWindows[${i}].end must be an integer 1–24`;
		if (w.start >= w.end)
			return `timeWindows[${i}]: start must be less than end`;
		if (i > 0 && w.start < sortedWindows[i - 1]!.end)
			return `timeWindows: windows must not overlap (${sortedWindows[i - 1]!.start}–${sortedWindows[i - 1]!.end} overlaps ${w.start}–${w.end})`;
	}

	if (typeof body.sessionPctLimit !== "number" || body.sessionPctLimit < 0 || body.sessionPctLimit > 100)
		return "sessionPctLimit must be a number between 0 and 100";
	if (typeof body.weeklyPctLimit !== "number" || body.weeklyPctLimit < 0 || body.weeklyPctLimit > 100)
		return "weeklyPctLimit must be a number between 0 and 100";
	if (typeof body.weeklyPctThreshold !== "number" || body.weeklyPctThreshold < 0 || body.weeklyPctThreshold > 100)
		return "weeklyPctThreshold must be a number between 0 and 100";

	if (typeof body.defaultEstimatePctByPriority !== "object" || body.defaultEstimatePctByPriority === null)
		return "defaultEstimatePctByPriority must be an object";
	for (const priority of TASK_PRIORITIES) {
		const pct = body.defaultEstimatePctByPriority[priority];
		if (typeof pct !== "number" || pct < 0 || pct > 100)
			return `defaultEstimatePctByPriority.${priority} must be a number between 0 and 100`;
	}

	if (typeof body.estimationBuffer !== "number" || body.estimationBuffer < 1 || body.estimationBuffer > 5)
		return "estimationBuffer must be a number between 1 and 5";

	if (typeof body.timeoutMinutesByPriority !== "object" || body.timeoutMinutesByPriority === null)
		return "timeoutMinutesByPriority must be an object";
	for (const priority of TASK_PRIORITIES) {
		const minutes = body.timeoutMinutesByPriority[priority];
		if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0)
			return `timeoutMinutesByPriority.${priority} must be a positive number`;
	}

	return undefined;
}

function validateGlobalShape(body: SetAutoWorkGlobalConfigRequest): string | undefined {
	if (typeof body.scheduleEnabled !== "boolean") return "scheduleEnabled must be a boolean";
	if (
		typeof body.scheduleIntervalMinutes !== "number" ||
		!Number.isInteger(body.scheduleIntervalMinutes) ||
		body.scheduleIntervalMinutes < 1
	) return "scheduleIntervalMinutes must be a positive integer";
	if (body.taskSelectionModel !== null) {
		if (
			typeof body.taskSelectionModel !== "object" ||
			typeof body.taskSelectionModel.provider !== "string" ||
			typeof body.taskSelectionModel.id !== "string"
		) return "taskSelectionModel must be null or {provider, id}";
	}
	if (typeof body.squeezeEnabled !== "boolean") return "squeezeEnabled must be a boolean";
	return undefined;
}
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
