import { describe, expect, test } from "bun:test";
import type { Task } from "@omp-deck/protocol";

import { DEPENDENCY_ELIGIBLE_STATE_IDS, candidateDependencyTasks, resolveDependencyTasks, resolveDependentTasks } from "./task-dependencies";

function task(overrides: Partial<Task> & { id: string }): Task {
	return {
		id: overrides.id,
		displayId: Number(overrides.id.replace(/\D/g, "")) || 0,
		title: overrides.id,
		body: "",
		stateId: "s_backlog",
		orderInState: 1000,
		priority: "P5",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		stateEnteredAt: "2026-01-01T00:00:00.000Z",
		dependsOn: [],
		...overrides,
	};
}

describe("resolveDependencyTasks", () => {
	test("resolves dependsOn ids to full Task objects, preserving order", () => {
		const a = task({ id: "a" });
		const b = task({ id: "b" });
		const t = task({ id: "t", dependsOn: [b.id, a.id] });
		expect(resolveDependencyTasks(t, [a, b, t])).toEqual([b, a]);
	});

	test("drops ids that no longer resolve to a task", () => {
		const a = task({ id: "a" });
		const t = task({ id: "t", dependsOn: ["missing", a.id] });
		expect(resolveDependencyTasks(t, [a, t])).toEqual([a]);
	});

	test("returns an empty array when dependsOn is empty", () => {
		const t = task({ id: "t" });
		expect(resolveDependencyTasks(t, [t])).toEqual([]);
	});
});

describe("candidateDependencyTasks", () => {
	test("excludes self, existing dependencies, and archived tasks", () => {
		const a = task({ id: "a" });
		const b = task({ id: "b" });
		const archived = task({ id: "c", archivedAt: "2026-01-02T00:00:00.000Z" });
		const t = task({ id: "t", dependsOn: [a.id] });
		const candidates = candidateDependencyTasks(t, [a, b, archived, t]);
		expect(candidates.map((c) => c.id)).toEqual([b.id]);
	});

	test("sorts candidates by displayId ascending", () => {
		const a = task({ id: "a", displayId: 5 });
		const b = task({ id: "b", displayId: 1 });
		const c = task({ id: "c", displayId: 3 });
		const t = task({ id: "t" });
		const candidates = candidateDependencyTasks(t, [a, b, c, t]);
		expect(candidates.map((x) => x.id)).toEqual(["b", "c", "a"]);
	});
});

describe("resolveDependentTasks", () => {
	test("returns tasks whose dependsOn includes task.id", () => {
		const a = task({ id: "a" });
		const b = task({ id: "b", dependsOn: ["a"] });
		const c = task({ id: "c", dependsOn: ["a"] });
		const other = task({ id: "d" });
		const result = resolveDependentTasks(a, [a, b, c, other]);
		expect(result.map((t) => t.id)).toEqual(["b", "c"]);
	});

	test("returns an empty array when no task depends on it", () => {
		const a = task({ id: "a" });
		const b = task({ id: "b" });
		expect(resolveDependentTasks(a, [a, b])).toEqual([]);
	});

	test("sorts dependents by displayId ascending", () => {
		const a = task({ id: "a" });
		const b = task({ id: "b", displayId: 10, dependsOn: ["a"] });
		const c = task({ id: "c", displayId: 2, dependsOn: ["a"] });
		const result = resolveDependentTasks(a, [a, b, c]);
		expect(result.map((t) => t.id)).toEqual(["c", "b"]);
	});

	test("includes archived dependents (informational, not filtered)", () => {
		const a = task({ id: "a" });
		const b = task({ id: "b", dependsOn: ["a"], archivedAt: "2026-01-02T00:00:00.000Z" });
		const result = resolveDependentTasks(a, [a, b]);
		expect(result.map((t) => t.id)).toEqual(["b"]);
	});

	test("does not include the task itself", () => {
		// Self-dependency is rejected at DB level; guard against stale data.
		const a = task({ id: "a", dependsOn: ["a"] });
		expect(resolveDependentTasks(a, [a])).toEqual([]);
	});
});

describe("candidateDependencyTasks — state + project filters (T-126)", () => {
	test("excludes tasks in a non-eligible state (done)", () => {
		const done = task({ id: "done1", stateId: "s_done" });
		const active = task({ id: "active1", stateId: "s_active" });
		const t = task({ id: "t" });
		const candidates = candidateDependencyTasks(t, [done, active, t]);
		expect(candidates.map((c) => c.id)).toEqual(["active1"]);
	});

	test("includes tasks in all four eligible states", () => {
		const bl = task({ id: "bl", displayId: 1, stateId: "s_backlog" });
		const ac = task({ id: "ac", displayId: 2, stateId: "s_active" });
		const bk = task({ id: "bk", displayId: 3, stateId: "s_blocked" });
		const vl = task({ id: "vl", displayId: 4, stateId: "s_validate" });
		const t = task({ id: "t" });
		const candidates = candidateDependencyTasks(t, [bl, ac, bk, vl, t]);
		expect(candidates.map((c) => c.id)).toEqual(["bl", "ac", "bk", "vl"]);
	});

	test("excludes tasks with a different cwd", () => {
		const sameProject = task({ id: "same", cwd: "/project/a" });
		const otherProject = task({ id: "other", cwd: "/project/b" });
		const t = task({ id: "t", cwd: "/project/a" });
		const candidates = candidateDependencyTasks(t, [sameProject, otherProject, t]);
		expect(candidates.map((c) => c.id)).toEqual(["same"]);
	});

	test("excludes tasks with a cwd when caller has none (both must be null)", () => {
		const withCwd = task({ id: "cwded", cwd: "/project/a" });
		const noCwd = task({ id: "nocwd" });
		const t = task({ id: "t" }); // no cwd
		const candidates = candidateDependencyTasks(t, [withCwd, noCwd, t]);
		expect(candidates.map((c) => c.id)).toEqual(["nocwd"]);
	});

	test("matches when both task and candidate have the same cwd", () => {
		const a = task({ id: "a", displayId: 1, cwd: "/repo" });
		const b = task({ id: "b", displayId: 2, cwd: "/repo" });
		const t = task({ id: "t", cwd: "/repo" });
		const candidates = candidateDependencyTasks(t, [a, b, t]);
		expect(candidates.map((c) => c.id)).toEqual(["a", "b"]);
	});

	test("DEPENDENCY_ELIGIBLE_STATE_IDS contains exactly the four system states", () => {
		expect(Object.keys(DEPENDENCY_ELIGIBLE_STATE_IDS).sort()).toEqual(
			["s_active", "s_backlog", "s_blocked", "s_validate"],
		);
	});
});
