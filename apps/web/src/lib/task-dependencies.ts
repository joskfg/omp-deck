/**
 * Pure helpers backing the TaskModal dependency picker (T-57). Extracted out
 * of the component so the id-resolution/filtering logic has plain unit tests
 * instead of needing a hook-rendering harness (same rationale as
 * `model-catalog.ts`'s `groupModels()`).
 */
import type { Task } from "@omp-deck/protocol";

/**
 * Stable state ids seeded by migrations 001-init.sql and 015-validate-state.sql.
 * Mirrors the server-side SYSTEM_STATE_IDS constant in db/tasks.ts.
 * A task must be in one of these states to appear as a dependency candidate.
 */
export const DEPENDENCY_ELIGIBLE_STATE_IDS: Record<string, true> = {
	s_backlog: true,
	s_active: true,
	s_blocked: true,
	s_validate: true,
};

/**
 * Resolve `task.dependsOn` ids to their full `Task` objects, in the order
 * they were added. Silently drops ids that no longer resolve — e.g. a stale
 * in-memory snapshot racing a dependency's deletion (the DB cascade already
 * cleaned up the edge server-side).
 */
export function resolveDependencyTasks(task: Task, allTasks: Task[]): Task[] {
	const byId = new Map(allTasks.map((t) => [t.id, t]));
	const resolved: Task[] = [];
	for (const depId of task.dependsOn) {
		const dep = byId.get(depId);
		if (dep) resolved.push(dep);
	}
	return resolved;
}

/**
 * Tasks eligible to be added as a new dependency of `task`:
 * - not self, not already listed in `task.dependsOn`, not archived
 * - in one of the four dependency-eligible states (backlog / active /
 *   blocked / validate) — tasks in done or other states are excluded
 * - same project (`cwd`) as `task`; both null means no project, which matches
 *
 * Sorted by display id for a stable picker order.
 */
export function candidateDependencyTasks(task: Task, allTasks: Task[]): Task[] {
	const existing = new Set(task.dependsOn);
	const thisCwd = task.cwd ?? null;
	return allTasks
		.filter(
			(t) =>
				t.id !== task.id &&
				!existing.has(t.id) &&
				!t.archivedAt &&
				Object.hasOwn(DEPENDENCY_ELIGIBLE_STATE_IDS, t.stateId) &&
				(t.cwd ?? null) === thisCwd,
		)
		.sort((a, b) => a.displayId - b.displayId);
}

/**
 * Tasks that list `task.id` in their own `dependsOn` — i.e. tasks that cannot
 * run until `task` is done. Sorted by display id for a stable render order.
 * Includes archived tasks so the caller can see the full picture; filter at
 * the call-site if needed.
 */
export function resolveDependentTasks(task: Task, allTasks: Task[]): Task[] {
	return allTasks
		.filter((t) => t.id !== task.id && t.dependsOn.includes(task.id))
		.sort((a, b) => a.displayId - b.displayId);
}
