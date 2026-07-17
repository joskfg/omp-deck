import { Hono } from "hono";
import type {
	CreateInboxItemRequest,
	InboxKind,
	ListInboxResponse,
	PromoteInboxItemRequest,
	PromoteInboxItemResponse,
	UpdateInboxItemRequest,
} from "@omp-deck/protocol";

import { broadcastBus } from "./broadcast-bus.ts";
import { getDb } from "./db/index.ts";
import { createInbox, deleteInbox, getInbox, listInbox, updateInbox } from "./db/inbox.ts";
import { createTaskInTransaction, getDefaultState, getState } from "./db/tasks.ts";

const KINDS: ReadonlySet<InboxKind> = new Set([
	"email",
	"ticket",
	"idea",
	"decision",
	"investigation",
	"capture",
]);

export function buildInboxRouter(): Hono {
	const app = new Hono();

	app.get("/inbox", (c) => {
		const kindParam = c.req.query("kind");
		const includeProcessed = c.req.query("includeProcessed") === "1";
		const kind = kindParam && KINDS.has(kindParam as InboxKind) ? (kindParam as InboxKind) : undefined;
		const opts: { kind?: InboxKind; includeProcessed?: boolean } = { includeProcessed };
		if (kind) opts.kind = kind;
		const body: ListInboxResponse = { items: listInbox(opts) };
		return c.json(body);
	});

	app.post("/inbox", async (c) => {
		let body: CreateInboxItemRequest;
		try {
			body = (await c.req.json()) as CreateInboxItemRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.title || !body.kind) return c.json({ error: "title and kind required" }, 400);
		try {
			const item = createInbox(body);
			return c.json(item, 201);
		} catch (err) {
			return c.json({ error: String(err) }, 400);
		}
	});

	app.get("/inbox/:id", (c) => {
		const i = getInbox(c.req.param("id"));
		if (!i) return c.json({ error: "not found" }, 404);
		return c.json(i);
	});

	app.patch("/inbox/:id", async (c) => {
		let body: UpdateInboxItemRequest;
		try {
			body = (await c.req.json()) as UpdateInboxItemRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			const updated = updateInbox(c.req.param("id"), body);
			if (!updated) return c.json({ error: "not found" }, 404);
			return c.json(updated);
		} catch (err) {
			return c.json({ error: String(err) }, 400);
		}
	});

	app.delete("/inbox/:id", (c) => {
		const ok = deleteInbox(c.req.param("id"));
		return c.json({ ok });
	});

	app.post("/inbox/:id/promote", async (c) => {
		const itemId = c.req.param("id");
		const item = getInbox(itemId);
		if (!item) return c.json({ error: "not found" }, 404);

		let body: PromoteInboxItemRequest = {};
		// Body is optional — accept missing/empty JSON without bouncing the request.
		try {
			const raw = await c.req.text();
			if (raw.trim().length > 0) body = JSON.parse(raw) as PromoteInboxItemRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}

		// Validate stateId up front so a typo doesn't half-promote (task created,
		// inbox marked processed) before the createTask path fails.
		if (body.stateId && !getState(body.stateId)) {
			return c.json({ error: `unknown stateId: ${body.stateId}` }, 400);
		}
		const stateId = body.stateId ?? getDefaultState().id;

		// Provenance footer keeps the link back to the inbox item so the user can
		// trace where the task originated even after the inbox is cleared out.
		const stamp = new Date(item.createdAt).toISOString().slice(0, 10);
		const provenance = `_Promoted from inbox · ${item.kind} · ${stamp} · ${item.id}_`;
		const taskBody = item.body.trim().length > 0
			? `${item.body}\n\n---\n${provenance}`
			: provenance;

		try {
			const out = getDb().transaction((): PromoteInboxItemResponse => {
				const task = createTaskInTransaction({ title: item.title, body: taskBody, stateId });
				// markProcessed defaults to true. Caller passing `false` keeps the item
				// in the unprocessed list (useful when promoting a recurring template).
				const shouldMark = body.markProcessed !== false;
				const inbox = shouldMark
					? updateInbox(item.id, { processed: true }) ?? item
					: item;
				return { task, inbox };
			})();
			broadcastBus.broadcast({ type: "tasks_changed" });
			return c.json(out, 201);
		} catch (err) {
			return c.json({ error: String(err) }, 400);
		}
	});

	return app;
}
