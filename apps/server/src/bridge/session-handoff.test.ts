import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@oh-my-pi/pi-coding-agent";

import { findHandoffSuccessor } from "./session-handoff.ts";

let tmpDir: string;
let cwd: string;
let sessionDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-session-handoff-"));
	cwd = tmpDir;
	sessionDir = path.join(tmpDir, "sessions");
	fs.mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createOriginWithOneEntry(): Promise<{ manager: SessionManager; id: string; file: string; leafId: string }> {
	const manager = SessionManager.create(cwd, sessionDir);
	const leafId = manager.appendCustomEntry("note", { note: "hello" });
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("expected a session file after ensureOnDisk()");
	return { manager, id: manager.getSessionId(), file, leafId };
}

/** Simulates `AgentSession.handoff()`'s own sequence: pivot `manager` onto a
 *  brand-new session file with `parentSession` set, then append the SDK's
 *  handoff marker as its first entry. */
async function performHandoff(
	manager: SessionManager,
	parentFile: string,
	document = "the transferred summary",
): Promise<{ id: string; file: string }> {
	await manager.newSession({ parentSession: parentFile });
	manager.appendCustomMessageEntry("handoff", document, true, undefined, "agent");
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("expected a session file after handoff ensureOnDisk()");
	return { id: manager.getSessionId(), file };
}

describe("findHandoffSuccessor (T-32)", () => {
	test("returns undefined when the session has no children at all", async () => {
		const origin = await createOriginWithOneEntry();

		const result = await findHandoffSuccessor(cwd, origin.file, sessionDir);

		expect(result).toBeUndefined();
	});

	test("finds a genuine auto-handoff successor", async () => {
		const origin = await createOriginWithOneEntry();
		const successor = await performHandoff(origin.manager, origin.file, "carried-over context");

		const result = await findHandoffSuccessor(cwd, origin.file, sessionDir);

		expect(result).toBeDefined();
		expect(result?.sessionId).toBe(successor.id);
		expect(result?.sessionFile).toBe(successor.file);
	});

	test("ignores a manual fork that never went through an auto-handoff", async () => {
		const origin = await createOriginWithOneEntry();
		const forked = origin.manager.createBranchedSession(origin.leafId);
		expect(forked && fs.existsSync(forked)).toBeTrue();

		const result = await findHandoffSuccessor(cwd, origin.file, sessionDir);

		expect(result).toBeUndefined();
	});

	test("ignores a fork of a handoff-continuation session that inherited the (stale-timestamped) handoff marker", async () => {
		const origin = await createOriginWithOneEntry();
		const successor = await performHandoff(origin.manager, origin.file);
		// Backdate the marker entry ON DISK, well outside the freshness window —
		// simulates real elapsed conversation time between the original handoff
		// and a much-later fork (a same-millisecond test run can't otherwise
		// produce that gap naturally).
		const backdated = new Date(Date.now() - 10 * 60_000).toISOString();
		const rewritten = fs
			.readFileSync(successor.file, "utf8")
			.split("\n")
			.map((line) => {
				if (!line.includes('"customType":"handoff"')) return line;
				const entry = JSON.parse(line) as { timestamp: string };
				entry.timestamp = backdated;
				return JSON.stringify(entry);
			})
			.join("\n");
		fs.writeFileSync(successor.file, rewritten);
		// Reload from the (now backdated) disk state before appending/forking —
		// `origin.manager` (pivoted onto the successor by performHandoff) still
		// holds the pre-edit in-memory entry otherwise.
		const reloaded = await SessionManager.open(successor.file, sessionDir);
		// Give the successor a later entry to fork from, past the inherited
		// handoff marker (entry 0) — mirrors a real "fork this later point in
		// the conversation" user action.
		const laterLeafId = reloaded.appendCustomEntry("note", { note: "later" });
		await reloaded.ensureOnDisk();

		// Fork the SUCCESSOR (not the origin) — the fork's first entry will be
		// the INHERITED handoff marker, now carrying the backdated timestamp
		// rather than the fork's own fresh `created` time.
		const forkedSessionFile = reloaded.createBranchedSession(laterLeafId);
		expect(forkedSessionFile && fs.existsSync(forkedSessionFile)).toBeTrue();

		// From the SUCCESSOR's perspective: does it have a genuine handoff
		// successor of its own? It should NOT — the fork is a manual branch,
		// not an auto-handoff continuation.
		const result = await findHandoffSuccessor(cwd, successor.file, sessionDir);

		expect(result).toBeUndefined();
	});

	test("prefers a genuine handoff successor over an unrelated sibling fork of the same origin", async () => {
		const origin = await createOriginWithOneEntry();
		const forked = origin.manager.createBranchedSession(origin.leafId);
		expect(forked && fs.existsSync(forked)).toBeTrue();

		// A second manager instance so the fork above doesn't get overwritten
		// by the handoff pivot below (both would otherwise share one
		// in-memory SessionManager whose `newSession()` call discards state).
		const secondManager = await SessionManager.open(origin.file, sessionDir);
		const successor = await performHandoff(secondManager, origin.file);

		const result = await findHandoffSuccessor(cwd, origin.file, sessionDir);

		expect(result?.sessionFile).toBe(successor.file);
	});
});
