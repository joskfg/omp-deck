/**
 * In-memory concurrency controller for the V1 runner.
 *
 *   - skip            (default) drop new trigger when a run is in flight
 *   - queue           queue subsequent invocations, max depth 10
 *   - cancel-previous abort the in-flight run, start a new one
 *   - parallel        run them all (V1 only allows the keyword; the spec
 *                     extension for "parallel: N" is V1.5)
 *
 * The runner asks the controller whether to start; gets back an action
 * along with (for cancel-previous) the AbortController of the in-flight run.
 */

import type { RoutineConcurrency } from "@omp-deck/protocol";

interface ActiveRun {
	runId: string;
	abort: AbortController;
}

interface QueuedRun {
	runId: string;
	abort: AbortController;
	release: () => void;
}

interface RoutineEntry {
	active: ActiveRun[];
	queued: QueuedRun[];
}

const MAX_QUEUE_DEPTH = 10;

export type StartDecision =
	| { kind: "go"; abort: AbortController }
	| { kind: "skip"; reason: "concurrency_skipped" }
	| { kind: "cancel"; toCancel: AbortController; abort: AbortController }
	| { kind: "queue"; abort: AbortController; release: Promise<void> };

export class ConcurrencyController {
	private routines = new Map<string, RoutineEntry>();

	/** Decide what to do when a trigger fires. The caller MUST invoke `start()` after this returns 'go' (or 'cancel') to actually register the run. */
	decide(routineId: string, runId: string, policy: RoutineConcurrency): StartDecision {
		const entry = this.entry(routineId);
		if (entry.active.length === 0 || policy === "parallel") {
			const abort = new AbortController();
			entry.active.push({ runId, abort });
			return { kind: "go", abort };
		}
		switch (policy) {
			case "skip":
				return { kind: "skip", reason: "concurrency_skipped" };
			case "cancel-previous": {
				const prev = entry.active[entry.active.length - 1];
				if (!prev) {
					const abort = new AbortController();
					entry.active.push({ runId, abort });
					return { kind: "go", abort };
				}
				const abort = new AbortController();
				entry.active.push({ runId, abort });
				return { kind: "cancel", toCancel: prev.abort, abort };
			}
			case "queue": {
				if (entry.queued.length >= MAX_QUEUE_DEPTH) {
					return { kind: "skip", reason: "concurrency_skipped" };
				}
				const abort = new AbortController();
				let release!: () => void;
				const releasePromise = new Promise<void>((resolve) => {
					release = resolve;
				});
				const queued: QueuedRun = { runId, abort, release };
				entry.queued.push(queued);
				abort.signal.addEventListener(
					"abort",
					() => {
						const index = entry.queued.indexOf(queued);
						if (index >= 0) entry.queued.splice(index, 1);
						release();
					},
					{ once: true },
				);
				return { kind: "queue", abort, release: releasePromise };
			}
			default:
				return { kind: "skip", reason: "concurrency_skipped" };
		}
	}

	/** Caller invokes this after the run finishes (success or failure) to release the slot. */
	finish(routineId: string, runId: string): void {
		const entry = this.routines.get(routineId);
		if (!entry) return;
		const activeCount = entry.active.length;
		entry.active = entry.active.filter((r) => r.runId !== runId);
		if (entry.active.length === activeCount) return;
		// Only the final active run releases a queued slot.
		if (entry.active.length === 0) {
			while (entry.queued.length > 0) {
				const next = entry.queued.shift()!;
				if (next.abort.signal.aborted) {
					next.release();
					continue;
				}
				entry.active.push({ runId: next.runId, abort: next.abort });
				next.release();
				break;
			}
		}
		if (entry.active.length === 0 && entry.queued.length === 0) {
			this.routines.delete(routineId);
		}
	}

	/** Snapshot for /metrics endpoints + debugging. */
	snapshot(): Array<{ routineId: string; active: number; queued: number }> {
		return Array.from(this.routines.entries()).map(([routineId, entry]) => ({
			routineId,
			active: entry.active.length,
			queued: entry.queued.length,
		}));
	}

	private entry(routineId: string): RoutineEntry {
		let entry = this.routines.get(routineId);
		if (!entry) {
			entry = { active: [], queued: [] };
			this.routines.set(routineId, entry);
		}
		return entry;
	}
}
