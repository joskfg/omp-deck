/**
 * Auto Work configuration — per-workspace enable flag, per-priority model
 * overrides, execution time windows, and consumption limits (T-60). This is
 * the DB layer only; validation of incoming values lives in
 * `routes-auto-work.ts` so a bad request never reaches SQLite.
 *
 * Rows are optional: a workspace with no row is simply "unconfigured" and
 * `getAutoWorkConfig` returns `DEFAULT_AUTO_WORK_CONFIG` merged with its
 * `workspaceCwd`/`updatedAt` rather than inserting one eagerly. Later
 * tickets (T-62/63/64/66/67) that read this config for scheduling should
 * call `getAutoWorkConfig` too, never assume a row exists.
 */

import type { AutoWorkConfig, AutoWorkModelByPriority, AutoWorkTimeWindow, ModelRef, TaskPriority } from "@omp-deck/protocol";

import { getDb, nowIso } from "./index.ts";

const TASK_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4", "P5"];

/** Default per-priority cost estimate (% of a session budget), used when no run history exists yet (T-63). */
export const DEFAULT_ESTIMATE_PCT_BY_PRIORITY: Record<TaskPriority, number> = {
	P0: 20,
	P1: 15,
	P2: 10,
	P3: 8,
	P4: 5,
	P5: 3,
};

/** Default safety-buffer multiplier applied to every cost estimate (T-63) — 30% headroom. */
export const DEFAULT_ESTIMATION_BUFFER = 1.3;

/** Default per-priority execution timeout in minutes, used by the engine (T-64) while waiting for a session to finish. */
export const DEFAULT_TIMEOUT_MINUTES_BY_PRIORITY: Record<TaskPriority, number> = {
	P0: 120,
	P1: 90,
	P2: 60,
	P3: 45,
	P4: 45,
	P5: 45,
};

/** Default weekly-usage % at which the once-per-day Telegram budget warning fires (T-67). */
export const DEFAULT_WEEKLY_PCT_THRESHOLD = 80;

/** Disabled, no model overrides, full-day window, unrestricted spend, default cost estimates. */
export const DEFAULT_AUTO_WORK_VALUES: Omit<AutoWorkConfig, "workspaceCwd" | "updatedAt"> = {
	enabled: false,
	autoMerge: false,
	modelByPriority: Object.fromEntries(TASK_PRIORITIES.map((p) => [p, null])) as AutoWorkModelByPriority,
	timeWindows: [{ start: 0, end: 24 }],
	sessionPctLimit: 100,
	weeklyPctLimit: 100,
	weeklyPctThreshold: DEFAULT_WEEKLY_PCT_THRESHOLD,
	defaultEstimatePctByPriority: DEFAULT_ESTIMATE_PCT_BY_PRIORITY,
	estimationBuffer: DEFAULT_ESTIMATION_BUFFER,
	timeoutMinutesByPriority: DEFAULT_TIMEOUT_MINUTES_BY_PRIORITY,
};

interface Row {
	workspace_cwd: string;
	enabled: number;
	auto_merge: number;
	model_by_priority: string;
	time_windows: string; // JSON: AutoWorkTimeWindow[]
	session_pct_limit: number;
	weekly_pct_limit: number;
	weekly_pct_threshold: number;
	default_estimate_pct_by_priority: string;
	estimation_buffer: number;
	timeout_minutes_by_priority: string;
	updated_at: string;
}

function parseTimeWindows(raw: string): AutoWorkTimeWindow[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return DEFAULT_AUTO_WORK_VALUES.timeWindows;
		const windows: AutoWorkTimeWindow[] = [];
		for (const item of parsed) {
			if (
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).start === "number" &&
				typeof (item as Record<string, unknown>).end === "number"
			) {
				windows.push({ start: (item as AutoWorkTimeWindow).start, end: (item as AutoWorkTimeWindow).end });
			}
		}
		return windows.length > 0 ? windows : DEFAULT_AUTO_WORK_VALUES.timeWindows;
	} catch {
		return DEFAULT_AUTO_WORK_VALUES.timeWindows;
	}
}

function rowToConfig(r: Row): AutoWorkConfig {
	let modelByPriority: AutoWorkModelByPriority;
	try {
		const parsed = JSON.parse(r.model_by_priority) as Partial<Record<TaskPriority, ModelRef | null>>;
		modelByPriority = Object.fromEntries(
			TASK_PRIORITIES.map((p) => [p, parsed[p] ?? null]),
		) as AutoWorkModelByPriority;
	} catch {
		modelByPriority = DEFAULT_AUTO_WORK_VALUES.modelByPriority;
	}
	let defaultEstimatePctByPriority: Record<TaskPriority, number>;
	try {
		const parsed = JSON.parse(r.default_estimate_pct_by_priority) as Partial<Record<TaskPriority, number>>;
		defaultEstimatePctByPriority = Object.fromEntries(
			TASK_PRIORITIES.map((p) => [p, parsed[p] ?? DEFAULT_ESTIMATE_PCT_BY_PRIORITY[p]]),
		) as Record<TaskPriority, number>;
	} catch {
		defaultEstimatePctByPriority = DEFAULT_ESTIMATE_PCT_BY_PRIORITY;
	}
	let timeoutMinutesByPriority: Record<TaskPriority, number>;
	try {
		const parsed = JSON.parse(r.timeout_minutes_by_priority) as Partial<Record<TaskPriority, number>>;
		timeoutMinutesByPriority = Object.fromEntries(
			TASK_PRIORITIES.map((p) => [p, parsed[p] ?? DEFAULT_TIMEOUT_MINUTES_BY_PRIORITY[p]]),
		) as Record<TaskPriority, number>;
	} catch {
		timeoutMinutesByPriority = DEFAULT_TIMEOUT_MINUTES_BY_PRIORITY;
	}
	return {
		workspaceCwd: r.workspace_cwd,
		enabled: r.enabled !== 0,
		autoMerge: r.auto_merge !== 0,
		modelByPriority,
		timeWindows: parseTimeWindows(r.time_windows),
		sessionPctLimit: r.session_pct_limit,
		weeklyPctLimit: r.weekly_pct_limit,
		weeklyPctThreshold: r.weekly_pct_threshold,
		defaultEstimatePctByPriority,
		estimationBuffer: r.estimation_buffer,
		timeoutMinutesByPriority,
		updatedAt: r.updated_at,
	};
}

/** Always resolvable — returns computed defaults when no row exists for `cwd`. */
export function getAutoWorkConfig(cwd: string): AutoWorkConfig {
	const row = getDb()
		.query<Row, [string]>(
			`SELECT workspace_cwd, enabled, auto_merge, model_by_priority, time_windows,
			        session_pct_limit, weekly_pct_limit, weekly_pct_threshold, default_estimate_pct_by_priority,
			        estimation_buffer, timeout_minutes_by_priority, updated_at
			 FROM auto_work_config WHERE workspace_cwd = ?`,
		)
		.get(cwd) as Row | null;
	if (row) return rowToConfig(row);
	return { workspaceCwd: cwd, updatedAt: nowIso(), ...DEFAULT_AUTO_WORK_VALUES };
}

/** Upserts the full config for `cwd`. Caller (`routes-auto-work.ts`) validates first. */
export function setAutoWorkConfig(
	cwd: string,
	values: Omit<AutoWorkConfig, "workspaceCwd" | "updatedAt">,
): AutoWorkConfig {
	const db = getDb();
	const now = nowIso();
	db.prepare<unknown, [string, number, number, string, string, number, number, number, string, number, string, string]>(
		`INSERT INTO auto_work_config
		   (workspace_cwd, enabled, auto_merge, model_by_priority, time_windows,
		    session_pct_limit, weekly_pct_limit, weekly_pct_threshold, default_estimate_pct_by_priority,
		    estimation_buffer, timeout_minutes_by_priority, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(workspace_cwd) DO UPDATE SET
		   enabled = excluded.enabled,
		   auto_merge = excluded.auto_merge,
		   model_by_priority = excluded.model_by_priority,
		   time_windows = excluded.time_windows,
		   session_pct_limit = excluded.session_pct_limit,
		   weekly_pct_limit = excluded.weekly_pct_limit,
		   weekly_pct_threshold = excluded.weekly_pct_threshold,
		   default_estimate_pct_by_priority = excluded.default_estimate_pct_by_priority,
		   estimation_buffer = excluded.estimation_buffer,
		   timeout_minutes_by_priority = excluded.timeout_minutes_by_priority,
		   updated_at = excluded.updated_at`,
	).run(
		cwd,
		values.enabled ? 1 : 0,
		values.autoMerge ? 1 : 0,
		JSON.stringify(values.modelByPriority),
		JSON.stringify(values.timeWindows),
		values.sessionPctLimit,
		values.weeklyPctLimit,
		values.weeklyPctThreshold,
		JSON.stringify(values.defaultEstimatePctByPriority),
		values.estimationBuffer,
		JSON.stringify(values.timeoutMinutesByPriority),
		now,
	);
	return getAutoWorkConfig(cwd);
}

/** Returns all workspaces with a persisted config row — used by the global scheduler to find enabled workspaces. */
export function listAutoWorkConfigs(): AutoWorkConfig[] {
	const rows = getDb()
		.query<Row, []>(
			`SELECT workspace_cwd, enabled, auto_merge, model_by_priority, time_windows,
			        session_pct_limit, weekly_pct_limit, weekly_pct_threshold, default_estimate_pct_by_priority,
			        estimation_buffer, timeout_minutes_by_priority, updated_at
			 FROM auto_work_config`,
		)
		.all() as Row[];
	return rows.map(rowToConfig);
}
