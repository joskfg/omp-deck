/**
 * Auto Work run history and cost tracking (T-62) — persistence layer only.
 *
 * A row is inserted in status='running' the moment a run starts
 * (`startAutoWorkRun`) and closed out with tokens/pct/status when it
 * finishes (`completeAutoWorkRun`). This module does not decide *when*
 * those happen — the engine that calls these at the right lifecycle
 * moments is T-64; here we just make the calls callable and testable in
 * isolation, plus expose the two read paths (`listAutoWorkRuns`,
 * `getAutoWorkCostEstimate`) that `routes-auto-work.ts` serves.
 */

import type { AutoWorkRun, AutoWorkRunStatus, TaskPriority } from "@omp-deck/protocol";

import { getDb, id, nowIso } from "./index.ts";

const DEFAULT_LIST_LIMIT = 50;
const COST_ESTIMATE_SAMPLE_SIZE = 10;

interface RunRow {
	id: string;
	task_id: string;
	task_priority: string;
	session_id: string;
	worktree_path: string;
	started_at: string;
	completed_at: string | null;
	status: string;
	input_tokens: number | null;
	output_tokens: number | null;
	pct_consumed: number | null;
	failure_reason: string | null;
	pr_number: number | null;
}

function rowToRun(r: RunRow): AutoWorkRun {
	return {
		id: r.id,
		taskId: r.task_id,
		taskPriority: r.task_priority as TaskPriority,
		sessionId: r.session_id,
		worktreePath: r.worktree_path,
		startedAt: r.started_at,
		completedAt: r.completed_at,
		status: r.status as AutoWorkRunStatus,
		inputTokens: r.input_tokens,
		outputTokens: r.output_tokens,
		pctConsumed: r.pct_consumed,
		failureReason: r.failure_reason,
		prNumber: r.pr_number,
	};
}

const RUN_COLUMNS = `id, task_id, task_priority, session_id, worktree_path, started_at, completed_at,
		        status, input_tokens, output_tokens, pct_consumed, failure_reason, pr_number`;

/** Record an open (status='running') run row. Returns the new row's id. */
export function startAutoWorkRun(input: {
	taskId: string;
	taskPriority: TaskPriority;
	sessionId: string;
	worktreePath: string;
}): string {
	const runId = `awrun_${id().toLowerCase().slice(0, 18)}`;
	getDb()
		.prepare<unknown, [string, string, string, string, string, string]>(
			`INSERT INTO auto_work_runs (id, task_id, task_priority, session_id, worktree_path, started_at, status)
			 VALUES (?, ?, ?, ?, ?, ?, 'running')`,
		)
		.run(runId, input.taskId, input.taskPriority, input.sessionId, input.worktreePath, nowIso());
	return runId;
}

/** Close out a run: sets completedAt, status, tokens, pct, and failure reason. */
export function completeAutoWorkRun(
	runId: string,
	patch: {
		status: Exclude<AutoWorkRunStatus, "running">;
		inputTokens?: number | null;
		outputTokens?: number | null;
		pctConsumed?: number | null;
		failureReason?: string | null;
		/** PR opened by this run. `undefined`/omitted preserves any previously-set value (COALESCE). */
		prNumber?: number | null;
	},
): void {
	getDb()
		.prepare<unknown, [string, string, number | null, number | null, number | null, string | null, number | null, string]>(
			`UPDATE auto_work_runs
			   SET completed_at = ?, status = ?, input_tokens = ?, output_tokens = ?,
			       pct_consumed = ?, failure_reason = ?, pr_number = COALESCE(?, pr_number)
			 WHERE id = ?`,
		)
		.run(
			nowIso(),
			patch.status,
			patch.inputTokens ?? null,
			patch.outputTokens ?? null,
			patch.pctConsumed ?? null,
			patch.failureReason ?? null,
			patch.prNumber ?? null,
			runId,
		);
}

/** Look up a single run by its id. Returns undefined when not found. */
export function getAutoWorkRun(runId: string): AutoWorkRun | undefined {
	const row = getDb()
		.query<RunRow, [string]>(
			`SELECT ${RUN_COLUMNS}
			 FROM auto_work_runs WHERE id = ?`,
		)
		.get(runId) as RunRow | null;
	return row ? rowToRun(row) : undefined;
}

/** List runs, most recent first, with optional filters. */
export function listAutoWorkRuns(filter: {
	limit?: number;
	taskId?: string;
	priority?: TaskPriority;
	status?: AutoWorkRunStatus;
}): AutoWorkRun[] {
	const clauses: string[] = [];
	const params: (string | number)[] = [];

	if (filter.taskId) {
		clauses.push("task_id = ?");
		params.push(filter.taskId);
	}
	if (filter.priority) {
		clauses.push("task_priority = ?");
		params.push(filter.priority);
	}
	if (filter.status) {
		clauses.push("status = ?");
		params.push(filter.status);
	}

	const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	const limit = filter.limit && filter.limit > 0 ? Math.floor(filter.limit) : DEFAULT_LIST_LIMIT;
	params.push(limit);

	const rows = getDb()
		.query<RunRow, (string | number)[]>(
			`SELECT ${RUN_COLUMNS}
			 FROM auto_work_runs
			 ${where}
			 ORDER BY started_at DESC, rowid DESC
			 LIMIT ?`,
		)
		.all(...params) as RunRow[];
	return rows.map(rowToRun);
}

/**
 * Rolling average of `pctConsumed` over the last `COST_ESTIMATE_SAMPLE_SIZE`
 * completed runs at `priority`. Returns `{ avgPctConsumed: null, sampleSize: 0 }`
 * when no completed history exists yet for that priority.
 */
export function getAutoWorkCostEstimate(priority: TaskPriority): {
	avgPctConsumed: number | null;
	sampleSize: number;
} {
	const rows = getDb()
		.query<{ pct_consumed: number | null }, [string, number]>(
			`SELECT pct_consumed FROM auto_work_runs
			 WHERE task_priority = ? AND status IN ('completed', 'completed_pr_failed') AND pct_consumed IS NOT NULL
			 ORDER BY started_at DESC, rowid DESC
			 LIMIT ?`,
		)
		.all(priority, COST_ESTIMATE_SAMPLE_SIZE) as { pct_consumed: number | null }[];

	if (rows.length === 0) return { avgPctConsumed: null, sampleSize: 0 };

	const sum = rows.reduce((acc, r) => acc + (r.pct_consumed ?? 0), 0);
	return { avgPctConsumed: sum / rows.length, sampleSize: rows.length };
}
