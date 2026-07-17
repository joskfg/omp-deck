/**
 * Tasks + task-states REST surface.
 *
 * Mounted on the main router at `/api/tasks` and `/api/task-states`. All
 * payloads use the protocol types verbatim. Validation is intentionally light
 * — the schema enforces shape (FK, CHECK constraints), we surface DB errors
 * back as 400/500.
 */

import { Hono } from "hono";
import type {
	CreateTaskRequest,
	CreateTaskStateRequest,
	ListTasksResponse,
	MoveTaskRequest,
	UpdateTaskRequest,
	UpdateTaskStateRequest,
} from "@omp-deck/protocol";

import { logger } from "./log.ts";
import { broadcastBus } from "./broadcast-bus.ts";
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
} from "./db/tasks.ts";

const log = logger("routes:tasks");

const TASK_PRIORITIES = new Set(["P0", "P1", "P2", "P3", "P4", "P5"]);
const TASK_DIFFICULTIES: Record<string, true> = { easy: true, medium: true, hard: true };

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function notifyTasksChanged(): void {
	broadcastBus.broadcast({ type: "tasks_changed" });
}

export function buildTasksRouter(): Hono {
	const app = new Hono();

	// ─── Tasks ─────────────────────────────────────────────────────────────

	app.get("/tasks", (c) => {
		const includeArchived = c.req.query("includeArchived") === "1";
		const tasks = listTasks({ includeArchived });
		const states = listStates();
		const body: ListTasksResponse = { tasks, states };
		return c.json(body);
	});

	app.post("/tasks", async (c) => {
		let body: CreateTaskRequest;
		try {
			body = (await c.req.json()) as CreateTaskRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.title || typeof body.title !== "string") {
			return c.json({ error: "title is required" }, 400);
		}
		if (body.priority !== undefined && !TASK_PRIORITIES.has(body.priority)) {
			return c.json({ error: `invalid priority: ${body.priority}` }, 400);
		}
		if (body.dependsOn !== undefined && !isStringArray(body.dependsOn)) {
			return c.json({ error: "dependsOn must be string[]" }, 400);
		}
		if (body.cwd !== undefined && typeof body.cwd !== "string") {
			return c.json({ error: "cwd must be a string" }, 400);
		}
		if (body.autoWork !== undefined && typeof body.autoWork !== "boolean") {
			return c.json({ error: "autoWork must be boolean" }, 400);
		}
		if (body.autoWork === true && !body.cwd?.trim()) {
			return c.json({ error: "auto-work tasks require a workspace: set cwd when enabling autoWork" }, 400);
		}
		if (body.difficulty !== undefined && !Object.hasOwn(TASK_DIFFICULTIES, body.difficulty as string)) {
			return c.json({ error: `invalid difficulty: ${body.difficulty}` }, 400);
		}
		try {
			const task = createTask(body);
			notifyTasksChanged();
			return c.json(task, 201);
		} catch (err) {
			log.error(`createTask failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.get("/tasks/:id", (c) => {
		const task = getTask(c.req.param("id"));
		if (!task) return c.json({ error: "not found" }, 404);
		return c.json(task);
	});

	app.patch("/tasks/:id", async (c) => {
		let body: UpdateTaskRequest;
		try {
			body = (await c.req.json()) as UpdateTaskRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (body.priority !== undefined && !TASK_PRIORITIES.has(body.priority)) {
			return c.json({ error: `invalid priority: ${body.priority}` }, 400);
		}
		if (body.dependsOn !== undefined && !isStringArray(body.dependsOn)) {
			return c.json({ error: "dependsOn must be string[]" }, 400);
		}
		if (body.cwd !== undefined && typeof body.cwd !== "string") {
			return c.json({ error: "cwd must be a string" }, 400);
		}
		if (body.autoWork !== undefined && typeof body.autoWork !== "boolean") {
			return c.json({ error: "autoWork must be boolean" }, 400);
		}
		const existing = getTask(c.req.param("id"));
		if (!existing) return c.json({ error: "not found" }, 404);
		// Invariant (auto-work): an eligible task always names its workspace.
		// Covers both enabling autoWork on a cwd-less task and clearing the
		// cwd of an already-eligible one — the engine cannot run either.
		const nextAutoWork = body.autoWork ?? existing.autoWork;
		const nextCwd = body.cwd !== undefined ? body.cwd : existing.cwd;
		if (nextAutoWork && !nextCwd?.trim()) {
			return c.json({ error: "auto-work tasks require a workspace: set cwd or disable autoWork first" }, 400);
		}
		if (body.difficulty !== undefined && !Object.hasOwn(TASK_DIFFICULTIES, body.difficulty as string)) {
			return c.json({ error: `invalid difficulty: ${body.difficulty}` }, 400);
		}
		try {
			const updated = updateTask(c.req.param("id"), body);
			if (!updated) return c.json({ error: "not found" }, 404);
			notifyTasksChanged();
			return c.json(updated);
		} catch (err) {
			log.error(`updateTask failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.delete("/tasks/:id", (c) => {
		const ok = deleteTask(c.req.param("id"));
		if (ok) notifyTasksChanged();
		return c.json({ ok });
	});

	app.post("/tasks/:id/move", async (c) => {
		let body: MoveTaskRequest;
		try {
			body = (await c.req.json()) as MoveTaskRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.stateId || typeof body.index !== "number") {
			return c.json({ error: "stateId and numeric index required" }, 400);
		}
		try {
			const moved = moveTask(c.req.param("id"), body.stateId, body.index);
			if (!moved) return c.json({ error: "task not found" }, 404);
			notifyTasksChanged();
			return c.json(moved);
		} catch (err) {
			log.error(`moveTask failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	// ─── States ────────────────────────────────────────────────────────────

	app.get("/task-states", (c) => c.json({ states: listStates() }));

	app.post("/task-states", async (c) => {
		let body: CreateTaskStateRequest;
		try {
			body = (await c.req.json()) as CreateTaskStateRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.name) return c.json({ error: "name required" }, 400);
		try {
			const state = createState(body);
			notifyTasksChanged();
			return c.json(state, 201);
		} catch (err) {
			log.error(`createState failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.post("/task-states/reorder", async (c) => {
		let body: { orderedIds?: unknown };
		try {
			body = (await c.req.json()) as { orderedIds?: unknown };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!Array.isArray(body.orderedIds) || body.orderedIds.some((x) => typeof x !== "string")) {
			return c.json({ error: "orderedIds must be string[]" }, 400);
		}
		try {
			const states = reorderStates(body.orderedIds as string[]);
			notifyTasksChanged();
			return c.json({ states });
		} catch (err) {
			log.error(`reorderStates failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.patch("/task-states/:id", async (c) => {
		let body: UpdateTaskStateRequest;
		try {
			body = (await c.req.json()) as UpdateTaskStateRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			const updated = updateState(c.req.param("id"), body);
			if (!updated) return c.json({ error: "not found" }, 404);
			notifyTasksChanged();
			return c.json(updated);
		} catch (err) {
			log.error("updateState failed", err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.delete("/task-states/:id", (c) => {
		try {
			const result = deleteState(c.req.param("id"));
			notifyTasksChanged();
			return c.json(result);
		} catch (err) {
			return c.json({ error: String(err) }, 400);
		}
	});

	app.get("/task-states/:id", (c) => {
		const state = getState(c.req.param("id"));
		if (!state) return c.json({ error: "not found" }, 404);
		return c.json(state);
	});

	return app;
}
