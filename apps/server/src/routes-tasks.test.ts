/**
 * Focused tests for the task-state (kanban column) mutation routes in
 * `routes-tasks.ts` (T-50): POST /task-states, PATCH /task-states/:id and
 * DELETE /task-states/:id must each emit a `tasks_changed` broadcast so
 * connected clients refresh the board, matching the task mutation handlers.
 *
 * Exercises the real Hono router via `app.request()` against a temp SQLite
 * db, capturing frames straight off the broadcast bus (same pattern as
 * `routes-sessions.test.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { broadcastBus, type BroadcastFrame } from "./broadcast-bus.ts";
import { closeDb, openDb } from "./db/index.ts";
import { createState, createTask } from "./db/tasks.ts";
import { buildTasksRouter } from "./routes-tasks.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
		dbDir = null;
	}
});

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-tasks-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

function captureFrames(): { frames: BroadcastFrame[]; unsub: () => void } {
	const frames: BroadcastFrame[] = [];
	const unsub = broadcastBus.subscribe((f) => frames.push(f));
	return { frames, unsub };
}

function tasksChangedCount(frames: BroadcastFrame[]): number {
	return frames.filter((f) => f.type === "tasks_changed").length;
}

function jsonRequest(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

describe("task-state routes broadcast tasks_changed", () => {
	test("POST /task-states emits tasks_changed on create", async () => {
		bootDb();
		const app = buildTasksRouter();
		const { frames, unsub } = captureFrames();
		try {
			const res = await app.request("/task-states", jsonRequest("POST", { name: "Doing" }));
			expect(res.status).toBe(201);
			expect(tasksChangedCount(frames)).toBe(1);
		} finally {
			unsub();
		}
	});

	test("POST /task-states does not broadcast on validation failure", async () => {
		bootDb();
		const app = buildTasksRouter();
		const { frames, unsub } = captureFrames();
		try {
			const res = await app.request("/task-states", jsonRequest("POST", {}));
			expect(res.status).toBe(400);
			expect(tasksChangedCount(frames)).toBe(0);
		} finally {
			unsub();
		}
	});

	test("PATCH /task-states/:id emits tasks_changed on update", async () => {
		bootDb();
		const state = createState({ name: "Review" });
		const app = buildTasksRouter();
		const { frames, unsub } = captureFrames();
		try {
			const res = await app.request(
				`/task-states/${state.id}`,
				jsonRequest("PATCH", { name: "In Review" }),
			);
			expect(res.status).toBe(200);
			expect(tasksChangedCount(frames)).toBe(1);
		} finally {
			unsub();
		}
	});

	test("PATCH /task-states/:id does not broadcast on missing state", async () => {
		bootDb();
		const app = buildTasksRouter();
		const { frames, unsub } = captureFrames();
		try {
			const res = await app.request("/task-states/nope", jsonRequest("PATCH", { name: "X" }));
			expect(res.status).toBe(404);
			expect(tasksChangedCount(frames)).toBe(0);
		} finally {
			unsub();
		}
	});

	test("DELETE /task-states/:id emits tasks_changed on delete", async () => {
		bootDb();
		const state = createState({ name: "Doomed" });
		const app = buildTasksRouter();
		const { frames, unsub } = captureFrames();
		try {
			const res = await app.request(`/task-states/${state.id}`, { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(tasksChangedCount(frames)).toBe(1);
		} finally {
			unsub();
		}
	});

	test("DELETE /task-states/:id does not broadcast when deletion is rejected", async () => {
		bootDb();
		const app = buildTasksRouter();
		// The seeded default state cannot be deleted; find it via the router.
		const listRes = await app.request("/task-states");
		const { states } = (await listRes.json()) as { states: Array<{ id: string; isDefault?: boolean }> };
		const defaultState = states.find((s) => s.isDefault);
		expect(defaultState).toBeDefined();
		const { frames, unsub } = captureFrames();
		try {
			const res = await app.request(`/task-states/${defaultState!.id}`, { method: "DELETE" });
			expect(res.status).toBe(400);
			expect(tasksChangedCount(frames)).toBe(0);
		} finally {
			unsub();
		}
	});
});
describe("auto-work workspace invariant (autoWork requires cwd)", () => {
	test("POST /tasks rejects autoWork without a cwd", async () => {
		bootDb();
		const app = buildTasksRouter();
		const res = await app.request("/tasks", jsonRequest("POST", { title: "orphan", autoWork: true }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("workspace");
	});

	test("POST /tasks accepts autoWork with a cwd", async () => {
		bootDb();
		const app = buildTasksRouter();
		const res = await app.request("/tasks", jsonRequest("POST", { title: "ok", autoWork: true, cwd: "/tmp/repo" }));
		expect(res.status).toBe(201);
	});

	test("PATCH /tasks/:id rejects enabling autoWork on a cwd-less task", async () => {
		bootDb();
		const app = buildTasksRouter();
		const task = createTask({ title: "no cwd" });
		const res = await app.request(`/tasks/${task.id}`, jsonRequest("PATCH", { autoWork: true }));
		expect(res.status).toBe(400);
	});

	test("PATCH /tasks/:id accepts enabling autoWork when the same patch sets cwd", async () => {
		bootDb();
		const app = buildTasksRouter();
		const task = createTask({ title: "no cwd yet" });
		const res = await app.request(`/tasks/${task.id}`, jsonRequest("PATCH", { autoWork: true, cwd: "/tmp/repo" }));
		expect(res.status).toBe(200);
	});

	test("PATCH /tasks/:id rejects blanking the cwd of an auto-work task", async () => {
		bootDb();
		const app = buildTasksRouter();
		const task = createTask({ title: "eligible", cwd: "/tmp/repo", autoWork: true });
		const res = await app.request(`/tasks/${task.id}`, jsonRequest("PATCH", { cwd: "  " }));
		expect(res.status).toBe(400);
	});

	test("PATCH /tasks/:id still allows disabling autoWork on a legacy cwd-less row", async () => {
		bootDb();
		const app = buildTasksRouter();
		// The db layer bypasses route validation, mirroring rows created
		// before the invariant existed.
		const task = createTask({ title: "legacy orphan", autoWork: true });
		const res = await app.request(`/tasks/${task.id}`, jsonRequest("PATCH", { autoWork: false }));
		expect(res.status).toBe(200);
	});
});

describe("system-state protection routes (T-126)", () => {
	test("DELETE /task-states/s_backlog returns 400 with a clear error", async () => {
		bootDb();
		const app = buildTasksRouter();
		const res = await app.request("/task-states/s_backlog", { method: "DELETE" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/required by the dependency system/);
	});

	test("PATCH /task-states/s_active with a name change returns 400 not 500", async () => {
		bootDb();
		const app = buildTasksRouter();
		const res = await app.request(
			"/task-states/s_active",
			jsonRequest("PATCH", { name: "in-progress" }),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/required by the dependency system/);
	});

	test("PATCH /task-states/s_validate with a color change succeeds", async () => {
		bootDb();
		const app = buildTasksRouter();
		const res = await app.request(
			"/task-states/s_validate",
			jsonRequest("PATCH", { color: "#123456" }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { color: string };
		expect(body.color).toBe("#123456");
	});

	test("DELETE /task-states/:id still rejects the broadcast when a system state is targeted", async () => {
		bootDb();
		const app = buildTasksRouter();
		const { frames, unsub } = captureFrames();
		try {
			const res = await app.request("/task-states/s_blocked", { method: "DELETE" });
			expect(res.status).toBe(400);
			expect(tasksChangedCount(frames)).toBe(0);
		} finally {
			unsub();
		}
	});

	test("PATCH /task-states/:id does not broadcast when rename of system state is rejected", async () => {
		bootDb();
		const app = buildTasksRouter();
		const { frames, unsub } = captureFrames();
		try {
			const res = await app.request(
				"/task-states/s_backlog",
				jsonRequest("PATCH", { name: "queue" }),
			);
			expect(res.status).toBe(400);
			expect(tasksChangedCount(frames)).toBe(0);
		} finally {
			unsub();
		}
	});
});
