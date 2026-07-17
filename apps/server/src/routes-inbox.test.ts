import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { broadcastBus, type BroadcastFrame } from "./broadcast-bus.ts";
import { createInbox, getInbox } from "./db/inbox.ts";
import { closeDb, getDb, openDb } from "./db/index.ts";
import { listTasks } from "./db/tasks.ts";
import { buildInboxRouter } from "./routes-inbox.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// Best effort cleanup for delayed SQLite handles.
		}
		dbDir = null;
	}
});

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-inbox-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

function captureFrames(): { frames: BroadcastFrame[]; unsub: () => void } {
	const frames: BroadcastFrame[] = [];
	const unsub = broadcastBus.subscribe((frame) => frames.push(frame));
	return { frames, unsub };
}

function tasksChangedCount(frames: BroadcastFrame[]): number {
	return frames.filter((frame) => frame.type === "tasks_changed").length;
}

describe("inbox promotion", () => {
	test("creates and processes atomically, then notifies task listeners", async () => {
		bootDb();
		const item = createInbox({ kind: "capture", title: "Promote atomically", body: "details" });
		const app = buildInboxRouter();
		const { frames, unsub } = captureFrames();
		try {
			const response = await app.request(`/inbox/${item.id}/promote`, { method: "POST" });
			expect(response.status).toBe(201);
			expect(getInbox(item.id)?.processedAt).toBeDefined();
			expect(listTasks().some((task) => task.title === item.title)).toBe(true);
			expect(tasksChangedCount(frames)).toBe(1);
		} finally {
			unsub();
		}
	});

	test("rolls back task creation when marking the inbox item processed fails", async () => {
		bootDb();
		const item = createInbox({ kind: "capture", title: "Do not partially promote" });
		getDb().exec(`
			CREATE TRIGGER fail_inbox_processing
			BEFORE UPDATE OF processed_at ON inbox_items
			WHEN NEW.processed_at IS NOT NULL
			BEGIN
				SELECT RAISE(ABORT, 'inbox processing failed');
			END
		`);
		const app = buildInboxRouter();
		const { frames, unsub } = captureFrames();
		try {
			const response = await app.request(`/inbox/${item.id}/promote`, { method: "POST" });
			expect(response.status).toBe(400);
			expect(getInbox(item.id)?.processedAt).toBeUndefined();
			expect(listTasks().some((task) => task.title === item.title)).toBe(false);
			expect(tasksChangedCount(frames)).toBe(0);
		} finally {
			unsub();
		}
	});
});
