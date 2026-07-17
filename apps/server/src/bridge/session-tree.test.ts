/**
 * Tests for `readSessionTree` / `forkSessionFile` (T-31) against real
 * on-disk `SessionManager` files under a temp dir (never the real home
 * directory — same pattern as `delete-session.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { Message } from "@oh-my-pi/pi-ai";

import { forkSessionFile, readSessionTree } from "./session-tree.ts";

let tmpDir: string;
let sessionDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-session-tree-"));
	sessionDir = path.join(tmpDir, "sessions");
	fs.mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A real on-disk session with one user turn followed by one assistant reply. */
async function buildSessionWithTurns(): Promise<{ filePath: string; userId: string; assistantId: string }> {
	const manager = SessionManager.create(tmpDir, sessionDir);
	await manager.ensureOnDisk();
	const userId = manager.appendMessage({
		role: "user",
		content: "hello",
		timestamp: Date.now(),
	} as unknown as Message);
	const assistantId = manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi there" }],
		timestamp: Date.now(),
	} as unknown as Message);
	await manager.flush();
	const filePath = manager.getSessionFile();
	if (!filePath) throw new Error("expected a session file after appendMessage()");
	return { filePath, userId, assistantId };
}

describe("readSessionTree", () => {
	test("returns the root->leaf chain with a per-role preview", async () => {
		const { filePath, userId, assistantId } = await buildSessionWithTurns();

		const tree = await readSessionTree(filePath);

		expect(tree.sessionFile).toBe(filePath);
		expect(tree.leafId).toBe(assistantId);
		expect(tree.parentSessionPath).toBeUndefined();
		expect(tree.roots).toHaveLength(1);
		const root = tree.roots[0];
		expect(root?.entry.id).toBe(userId);
		expect(root?.entry.kind).toBe("user_message");
		expect(root?.entry.preview).toBe("hello");
		expect(root?.children).toHaveLength(1);
		const child = root?.children[0];
		expect(child?.entry.id).toBe(assistantId);
		expect(child?.entry.kind).toBe("assistant_message");
		expect(child?.entry.preview).toBe("hi there");
	});

	test("never writes back to the source file", async () => {
		const { filePath } = await buildSessionWithTurns();
		const before = fs.readFileSync(filePath, "utf8");

		await readSessionTree(filePath);

		expect(fs.readFileSync(filePath, "utf8")).toBe(before);
	});
});

describe("forkSessionFile", () => {
	test("creates a new file rooted at entryId, leaving the source untouched", async () => {
		const { filePath, userId } = await buildSessionWithTurns();
		const before = fs.readFileSync(filePath, "utf8");

		const forked = await forkSessionFile(filePath, userId);

		expect(forked.sessionFile).not.toBe(filePath);
		expect(fs.existsSync(forked.sessionFile)).toBe(true);
		expect(fs.readFileSync(filePath, "utf8")).toBe(before);

		const forkedTree = await readSessionTree(forked.sessionFile);
		expect(forkedTree.parentSessionPath).toBe(filePath);
		expect(forkedTree.roots).toHaveLength(1);
		expect(forkedTree.roots[0]?.entry.id).toBe(userId);
		// Only the root->userId path is carried over — the assistant reply
		// that came after it in the source session is not.
		expect(forkedTree.roots[0]?.children).toHaveLength(0);
	});

	test("rejects an entryId that doesn't exist on the source session", async () => {
		const { filePath } = await buildSessionWithTurns();

		await expect(forkSessionFile(filePath, "does-not-exist")).rejects.toThrow();
	});
});
