/**
 * Unit tests for the kanban tasks/state DB layer. Boots a fresh on-disk
 * SQLite database under `os.tmpdir()` per test so the migrations run end-to-end.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, getDb, openDb } from "./index.ts";
import {
	createState,
	createTask,
	deleteState,
	deleteTask,
	getState,
	getTask,
	listStates,
	listTasks,
	moveTask,
	reorderStates,
	updateState,
	updateTask,
} from "./tasks.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// Windows SQLite handles can lag past close(); leaking a temp dir is
			// fine, failing the suite is not.
		}
		dbDir = null;
	}
});

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-tasks-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

describe("reorderStates", () => {
	test("renumbers positions in the supplied order with 100-unit gaps", () => {
		bootDb();
		// Add a sixth column on top of the five seeded by 001-init.sql/014-validate-state.sql.
		const upNext = createState({ name: "up-next", color: "#888888" });
		const before = listStates().map((s) => s.id);
		expect(before).toEqual(["s_backlog", "s_active", "s_validate", "s_blocked", "s_done", upNext.id]);

		const after = reorderStates(["s_done", "s_blocked", "s_validate", "s_active", "s_backlog", upNext.id]);
		expect(after.map((s) => s.id)).toEqual([
			"s_done",
			"s_blocked",
			"s_validate",
			"s_active",
			"s_backlog",
			upNext.id,
		]);
		expect(after.map((s) => s.position)).toEqual([100, 200, 300, 400, 500, 600]);
	});

	test("rejects a missing id without mutating task_states", () => {
		bootDb();
		const original = listStates();
		expect(() => reorderStates(["s_done", "s_blocked", "s_active"])).toThrow(/expected 5 ids/);
		expect(listStates()).toEqual(original);
	});

	test("rejects an unknown id", () => {
		bootDb();
		const original = listStates();
		expect(() =>
			reorderStates(["s_done", "s_blocked", "s_active", "s_validate", "s_does_not_exist"]),
		).toThrow(/unknown state id/);
		expect(listStates()).toEqual(original);
	});

	test("rejects a duplicate id", () => {
		bootDb();
		const original = listStates();
		expect(() => reorderStates(["s_done", "s_done", "s_blocked", "s_active", "s_validate"])).toThrow(
			/duplicate state id/,
		);
		expect(listStates()).toEqual(original);
	});
});
describe("state_entered_at + recency sort", () => {
	test("createTask stamps state_entered_at to the creation timestamp", () => {
		bootDb();
		const t = createTask({ title: "first", stateId: "s_backlog" });
		expect(typeof t.stateEnteredAt).toBe("string");
		expect(t.stateEnteredAt.length).toBeGreaterThan(0);
		// On fresh insert, state_entered_at equals updated_at.
		expect(t.stateEnteredAt).toBe(t.updatedAt);
	});

	test("cross-column moveTask bumps state_entered_at; same-column does not", async () => {
		bootDb();
		const t = createTask({ title: "drift-victim", stateId: "s_backlog" });
		const original = t.stateEnteredAt;
		await new Promise((r) => setTimeout(r, 10));

		// Same-column move keeps state_entered_at.
		const sameCol = moveTask(t.id, "s_backlog", 0)!;
		expect(sameCol.stateEnteredAt).toBe(original);

		await new Promise((r) => setTimeout(r, 10));
		const crossCol = moveTask(t.id, "s_active", 0)!;
		expect(crossCol.stateEnteredAt).not.toBe(original);
		expect(new Date(crossCol.stateEnteredAt).getTime()).toBeGreaterThan(
			new Date(original).getTime(),
		);
	});

	test("moveTask preserves peers' state_entered_at when the moving card crosses columns", async () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_done" });
		await new Promise((r) => setTimeout(r, 5));
		const aEntered = a.stateEnteredAt;

		await new Promise((r) => setTimeout(r, 5));
		const b = createTask({ title: "b", stateId: "s_backlog" });

		await new Promise((r) => setTimeout(r, 10));
		// Move b into done — a should still carry its earlier state_entered_at.
		moveTask(b.id, "s_done", 0);
		const done = listTasks().filter((t) => t.stateId === "s_done");
		const aRow = done.find((t) => t.id === a.id)!;
		expect(aRow.stateEnteredAt).toBe(aEntered);
	});

	test("body edits via updateTask do not bump state_entered_at", async () => {
		bootDb();
		const t = createTask({ title: "edit-me", stateId: "s_backlog" });
		const before = t.stateEnteredAt;
		await new Promise((r) => setTimeout(r, 10));
		const updated = updateTask(t.id, { body: "new body" })!;
		expect(updated.stateEnteredAt).toBe(before);
	});

	test("listTasks orders each column by state_entered_at DESC", async () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_backlog" });
		await new Promise((r) => setTimeout(r, 5));
		const b = createTask({ title: "b", stateId: "s_backlog" });
		await new Promise((r) => setTimeout(r, 5));
		const c = createTask({ title: "c", stateId: "s_backlog" });

		// Backlog also holds the seeded welcome task, so filter to the rows
		// this test explicitly created and assert their relative ordering.
		const ids = new Set([a.id, b.id, c.id]);
		const ordered = listTasks()
			.filter((t) => ids.has(t.id))
			.map((t) => t.id);
		// Most recent first.
		expect(ordered).toEqual([c.id, b.id, a.id]);
	});

	test("re-entering a column puts the card back on top", async () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_done" });
		await new Promise((r) => setTimeout(r, 5));
		const b = createTask({ title: "b", stateId: "s_done" });
		await new Promise((r) => setTimeout(r, 10));
		// Bounce `a` through backlog and back to done — it should now surface
		// at the top because state_entered_at re-stamps on cross-column.
		moveTask(a.id, "s_backlog", 0);
		await new Promise((r) => setTimeout(r, 5));
		moveTask(a.id, "s_done", 0);

		const done = listTasks().filter((t) => t.stateId === "s_done");
		expect(done.map((t) => t.id)).toEqual([a.id, b.id]);
	});
});

describe("priority (T-38)", () => {
	test("createTask defaults priority to P5 when unset", () => {
		bootDb();
		const t = createTask({ title: "no priority given", stateId: "s_backlog" });
		expect(t.priority).toBe("P5");
	});

	test("createTask accepts an explicit priority", () => {
		bootDb();
		const t = createTask({ title: "urgent", stateId: "s_backlog", priority: "P0" });
		expect(t.priority).toBe("P0");
	});

	test("updateTask can change priority independently of other fields", () => {
		bootDb();
		const t = createTask({ title: "reprioritize me", stateId: "s_backlog" });
		expect(t.priority).toBe("P5");
		const updated = updateTask(t.id, { priority: "P1" })!;
		expect(updated.priority).toBe("P1");
		expect(updated.title).toBe(t.title);
	});

	test("listTasks and getTask round-trip priority", () => {
		bootDb();
		const t = createTask({ title: "roundtrip", stateId: "s_backlog", priority: "P2" });
		expect(getTask(t.id)?.priority).toBe("P2");
		expect(listTasks().find((x) => x.id === t.id)?.priority).toBe("P2");
	});
});

describe("dependencies (T-57)", () => {
	test("createTask defaults dependsOn to an empty array", () => {
		bootDb();
		const t = createTask({ title: "no deps", stateId: "s_backlog" });
		expect(t.dependsOn).toEqual([]);
	});

	test("createTask accepts an explicit dependsOn set", () => {
		bootDb();
		const blocker = createTask({ title: "blocker", stateId: "s_backlog" });
		const t = createTask({ title: "blocked", stateId: "s_backlog", dependsOn: [blocker.id] });
		expect(t.dependsOn).toEqual([blocker.id]);
	});

	test("updateTask replaces the full dependency set", () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_backlog" });
		const b = createTask({ title: "b", stateId: "s_backlog" });
		const t = createTask({ title: "t", stateId: "s_backlog", dependsOn: [a.id] });
		expect(t.dependsOn).toEqual([a.id]);

		const updated = updateTask(t.id, { dependsOn: [b.id] })!;
		expect(updated.dependsOn).toEqual([b.id]);
	});

	test("rolls back scalar changes when dependency replacement fails", () => {
		bootDb();
		const originalDependency = createTask({ title: "original dependency", stateId: "s_backlog" });
		const replacementDependency = createTask({ title: "replacement dependency", stateId: "s_backlog" });
		const task = createTask({
			title: "original title",
			stateId: "s_backlog",
			dependsOn: [originalDependency.id],
		});
		getDb().exec(`
			CREATE TRIGGER fail_dependency_insert
			BEFORE INSERT ON task_dependencies
			BEGIN
				SELECT RAISE(ABORT, 'dependency replacement failed');
			END
		`);

		expect(() =>
			updateTask(task.id, {
				title: "renamed title",
				dependsOn: [replacementDependency.id],
			}),
		).toThrow(/dependency replacement failed/);
		expect(getTask(task.id)).toMatchObject({
			title: "original title",
			dependsOn: [originalDependency.id],
		});
	});

	test("updateTask can clear dependencies with an empty array", () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_backlog" });
		const t = createTask({ title: "t", stateId: "s_backlog", dependsOn: [a.id] });
		const cleared = updateTask(t.id, { dependsOn: [] })!;
		expect(cleared.dependsOn).toEqual([]);
	});

	test("updateTask omitting dependsOn leaves the existing set untouched", () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_backlog" });
		const t = createTask({ title: "t", stateId: "s_backlog", dependsOn: [a.id] });
		const updated = updateTask(t.id, { title: "t renamed" })!;
		expect(updated.dependsOn).toEqual([a.id]);
	});

	test("rejects self-dependency", () => {
		bootDb();
		// The generated id isn't known ahead of time, so exercise the
		// self-reference guard via updateTask instead, which can target itself.
		const t = createTask({ title: "t", stateId: "s_backlog" });
		expect(() => updateTask(t.id, { dependsOn: [t.id] })).toThrow(/cannot depend on itself/);
	});

	test("rejects an unknown dependency id", () => {
		bootDb();
		const t = createTask({ title: "t", stateId: "s_backlog" });
		expect(() => updateTask(t.id, { dependsOn: ["t_does_not_exist"] })).toThrow(
			/unknown dependency task id/,
		);
		expect(getTask(t.id)!.dependsOn).toEqual([]);
	});

	test("rejects a dependency change that would create a cycle", () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_backlog" });
		const b = createTask({ title: "b", stateId: "s_backlog", dependsOn: [a.id] });
		// a -> depends on b would close the loop a -> b -> a.
		expect(() => updateTask(a.id, { dependsOn: [b.id] })).toThrow(/would create a cycle/);
		expect(getTask(a.id)!.dependsOn).toEqual([]);
	});

	test("rejects a transitive cycle across three tasks", () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_backlog" });
		const b = createTask({ title: "b", stateId: "s_backlog", dependsOn: [a.id] });
		const c = createTask({ title: "c", stateId: "s_backlog", dependsOn: [b.id] });
		// a -> depends on c would close a -> c -> b -> a.
		expect(() => updateTask(a.id, { dependsOn: [c.id] })).toThrow(/would create a cycle/);
	});

	test("listTasks and getTask round-trip dependsOn", () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_backlog" });
		const t = createTask({ title: "t", stateId: "s_backlog", dependsOn: [a.id] });
		expect(getTask(t.id)?.dependsOn).toEqual([a.id]);
		expect(listTasks().find((x) => x.id === t.id)?.dependsOn).toEqual([a.id]);
	});

	test("deleting a dependency task cascades out of dependents' dependsOn", () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_backlog" });
		const t = createTask({ title: "t", stateId: "s_backlog", dependsOn: [a.id] });
		deleteTask(a.id);
		expect(getTask(t.id)?.dependsOn).toEqual([]);
	});
});

describe("autoWork (T-58)", () => {
	test("createTask defaults autoWork to false", () => {
		bootDb();
		const t = createTask({ title: "no autowork", stateId: "s_backlog" });
		expect(t.autoWork).toBe(false);
	});

	test("createTask accepts an explicit autoWork: true", () => {
		bootDb();
		const t = createTask({ title: "eligible", stateId: "s_backlog", autoWork: true });
		expect(t.autoWork).toBe(true);
	});

	test("updateTask can flip autoWork on and off", () => {
		bootDb();
		const t = createTask({ title: "t", stateId: "s_backlog" });
		expect(t.autoWork).toBe(false);

		const flagged = updateTask(t.id, { autoWork: true })!;
		expect(flagged.autoWork).toBe(true);

		const unflagged = updateTask(t.id, { autoWork: false })!;
		expect(unflagged.autoWork).toBe(false);
	});

	test("updateTask omitting autoWork leaves the existing value untouched", () => {
		bootDb();
		const t = createTask({ title: "t", stateId: "s_backlog", autoWork: true });
		const updated = updateTask(t.id, { title: "t renamed" })!;
		expect(updated.autoWork).toBe(true);
	});

	test("listTasks and getTask round-trip autoWork", () => {
		bootDb();
		const t = createTask({ title: "t", stateId: "s_backlog", autoWork: true });
		expect(getTask(t.id)?.autoWork).toBe(true);
		expect(listTasks().find((x) => x.id === t.id)?.autoWork).toBe(true);
	});

	test("autoWork and dependsOn are independent — setting one leaves the other untouched", () => {
		bootDb();
		const dep = createTask({ title: "dep", stateId: "s_backlog" });
		const t = createTask({ title: "t", stateId: "s_backlog", dependsOn: [dep.id] });
		const updated = updateTask(t.id, { autoWork: true })!;
		expect(updated.autoWork).toBe(true);
		expect(updated.dependsOn).toEqual([dep.id]);
	});
});

describe("dependency eligibility (T-126)", () => {
	test("rejects a newly-added dep whose task is in a non-eligible state (done)", () => {
		bootDb();
		const blocker = createTask({ title: "done-task", stateId: "s_done" });
		const t = createTask({ title: "t", stateId: "s_backlog" });
		expect(() => updateTask(t.id, { dependsOn: [blocker.id] })).toThrow(
			/not eligible for dependencies/,
		);
		expect(getTask(t.id)!.dependsOn).toEqual([]);
	});

	test("retains an existing dep that has since moved to done when adding another dep", () => {
		bootDb();
		const was_active = createTask({ title: "was-active", stateId: "s_backlog" });
		const new_dep = createTask({ title: "new-dep", stateId: "s_backlog" });
		const t = createTask({ title: "t", stateId: "s_backlog", dependsOn: [was_active.id] });
		// Simulate the blocker finishing — move it to done.
		moveTask(was_active.id, "s_done", 0);
		// Adding a second dep must NOT reject because the first dep is now in done.
		const updated = updateTask(t.id, { dependsOn: [was_active.id, new_dep.id] })!;
		expect(updated.dependsOn).toContain(was_active.id);
		expect(updated.dependsOn).toContain(new_dep.id);
	});

	test("rejects a dep that belongs to a different project (different cwd)", () => {
		bootDb();
		const other = createTask({ title: "other-project", stateId: "s_backlog", cwd: "/project/b" });
		const t = createTask({ title: "t", stateId: "s_backlog", cwd: "/project/a" });
		expect(() => updateTask(t.id, { dependsOn: [other.id] })).toThrow(/different project/);
		expect(getTask(t.id)!.dependsOn).toEqual([]);
	});

	test("accepts a dep in the same project", () => {
		bootDb();
		const blocker = createTask({ title: "blocker", stateId: "s_backlog", cwd: "/project/a" });
		const t = createTask({ title: "t", stateId: "s_backlog", cwd: "/project/a" });
		const updated = updateTask(t.id, { dependsOn: [blocker.id] })!;
		expect(updated.dependsOn).toEqual([blocker.id]);
	});

	test("accepts a dep when both tasks have no project (cwd null)", () => {
		bootDb();
		const blocker = createTask({ title: "blocker", stateId: "s_backlog" });
		const t = createTask({ title: "t", stateId: "s_backlog" });
		const updated = updateTask(t.id, { dependsOn: [blocker.id] })!;
		expect(updated.dependsOn).toEqual([blocker.id]);
	});

	test("createTask rejects a dep in a non-eligible state", () => {
		bootDb();
		const done = createTask({ title: "done-task", stateId: "s_done" });
		expect(() => createTask({ title: "t", stateId: "s_backlog", dependsOn: [done.id] })).toThrow(
			/not eligible for dependencies/,
		);
	});

	test("createTask rejects a dep from a different project", () => {
		bootDb();
		const other = createTask({ title: "other", stateId: "s_backlog", cwd: "/project/b" });
		expect(() =>
			createTask({ title: "t", stateId: "s_backlog", cwd: "/project/a", dependsOn: [other.id] }),
		).toThrow(/different project/);
	});

	test("patching cwd is rejected when existing deps are cross-project under the new cwd", () => {
		bootDb();
		const dep = createTask({ title: "dep", stateId: "s_backlog", cwd: "/project/a" });
		const t = createTask({ title: "t", stateId: "s_backlog", cwd: "/project/a", dependsOn: [dep.id] });
		// Moving t to project/b would make dep cross-project.
		expect(() => updateTask(t.id, { cwd: "/project/b" })).toThrow(/different project/);
		// Task and its cwd are unchanged.
		const unchanged = getTask(t.id)!;
		expect(unchanged.cwd).toBe("/project/a");
		expect(unchanged.dependsOn).toEqual([dep.id]);
	});

	test("patching cwd is allowed when the task has no existing dependencies", () => {
		bootDb();
		const t = createTask({ title: "t", stateId: "s_backlog", cwd: "/project/a" });
		const updated = updateTask(t.id, { cwd: "/project/b" })!;
		expect(updated.cwd).toBe("/project/b");
	});
});

describe("system-state protection (T-126)", () => {
	test("deleteState rejects deleting s_backlog", () => {
		bootDb();
		expect(() => deleteState("s_backlog")).toThrow(/required by the dependency system/);
		expect(getState("s_backlog")).toBeDefined();
	});

	test("deleteState rejects deleting s_active", () => {
		bootDb();
		expect(() => deleteState("s_active")).toThrow(/required by the dependency system/);
	});

	test("deleteState rejects deleting s_blocked", () => {
		bootDb();
		expect(() => deleteState("s_blocked")).toThrow(/required by the dependency system/);
	});

	test("deleteState rejects deleting s_validate", () => {
		bootDb();
		expect(() => deleteState("s_validate")).toThrow(/required by the dependency system/);
	});

	test("deleteState allows deleting a non-system state", () => {
		bootDb();
		const custom = createState({ name: "custom-column" });
		const result = deleteState(custom.id);
		expect(result.reassigned).toBe(0);
		expect(getState(custom.id)).toBeUndefined();
	});

	test("updateState rejects renaming s_backlog", () => {
		bootDb();
		expect(() => updateState("s_backlog", { name: "queue" })).toThrow(/required by the dependency system/);
		expect(getState("s_backlog")!.name).toBe("backlog");
	});

	test("updateState rejects renaming s_active, s_blocked, s_validate", () => {
		bootDb();
		expect(() => updateState("s_active", { name: "in-progress" })).toThrow(/required by the dependency system/);
		expect(() => updateState("s_blocked", { name: "waiting" })).toThrow(/required by the dependency system/);
		expect(() => updateState("s_validate", { name: "review" })).toThrow(/required by the dependency system/);
	});

	test("updateState allows changing color of a system state", () => {
		bootDb();
		const updated = updateState("s_backlog", { color: "#ff0000" });
		expect(updated!.color).toBe("#ff0000");
		expect(updated!.name).toBe("backlog");
	});

	test("updateState allows renaming a non-system state", () => {
		bootDb();
		const custom = createState({ name: "staging" });
		const updated = updateState(custom.id, { name: "staging-v2" });
		expect(updated!.name).toBe("staging-v2");
	});
});
