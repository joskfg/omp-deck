/**
 * `listSessionUsage` aggregates `usage.totalTokens` / `usage.cost.total`
 * across assistant messages in each session's `.jsonl` transcript, sourcing
 * the session list from `AgentBridge.listSessions` (same call the sessions
 * list endpoint uses) rather than re-walking the filesystem.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentBridge } from "./bridge/types.ts";
import type { SessionSummary } from "@omp-deck/protocol";
import { listSessionUsage } from "./usage-sessions.ts";

function fakeBridge(sessions: SessionSummary[]): AgentBridge {
	return {
		async createSession() {
			throw new Error("not exercised");
		},
		async resumeSession() {
			throw new Error("not exercised");
		},
		getSession() {
			return undefined;
		},
		async listSessions() {
			return sessions;
		},
		async deleteSession() {
			return { deleted: false };
		},
		trackSubscriberAdded() {},
		trackSubscriberRemoved() {},
		bumpActivity() {},
		async listModels() {
			return [];
		},
	} as unknown as AgentBridge;
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-usage-sessions-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(fileName: string, lines: unknown[]): string {
	const filePath = path.join(dir, fileName);
	writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return filePath;
}

describe("listSessionUsage", () => {
	test("sums totalTokens and cost across assistant messages, ignoring other event types", async () => {
		const filePath = writeTranscript("s1.jsonl", [
			{ type: "session", id: "s1" },
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "assistant", usage: { totalTokens: 100, cost: { total: 0.01 } } } },
			{ type: "message", message: { role: "assistant", usage: { totalTokens: 50, cost: { total: 0.005 } } } },
			{ type: "custom", id: "x" },
		]);
		const summary: SessionSummary = {
			id: "s1",
			path: filePath,
			cwd: "/home/user/project",
			title: "Session 1",
			createdAt: "2026-07-01T00:00:00Z",
			updatedAt: "2026-07-01T01:00:00Z",
			messageCount: 5,
		};
		const [result] = await listSessionUsage(fakeBridge([summary]), 20);
		expect(result?.totalTokens).toBe(150);
		expect(result?.costUsd).toBeCloseTo(0.015, 6);
		expect(result?.id).toBe("s1");
		expect(result?.messageCount).toBe(5);
	});

	test("sorts by updatedAt desc and respects the limit", async () => {
		const older = writeTranscript("older.jsonl", []);
		const newer = writeTranscript("newer.jsonl", []);
		const sessions: SessionSummary[] = [
			{
				id: "older",
				path: older,
				cwd: "/x",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
				messageCount: 1,
			},
			{
				id: "newer",
				path: newer,
				cwd: "/x",
				createdAt: "2026-02-01T00:00:00Z",
				updatedAt: "2026-02-01T00:00:00Z",
				messageCount: 1,
			},
		];
		const result = await listSessionUsage(fakeBridge(sessions), 1);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("newer");
	});

	test("tolerates a missing/unreadable transcript file without throwing", async () => {
		const summary: SessionSummary = {
			id: "gone",
			path: path.join(dir, "does-not-exist.jsonl"),
			cwd: "/x",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			messageCount: 0,
		};
		const [result] = await listSessionUsage(fakeBridge([summary]), 20);
		expect(result?.totalTokens).toBe(0);
		expect(result?.costUsd).toBe(0);
	});

	test("derives accountLabel from the cwd path's final segment", async () => {
		const filePath = writeTranscript("label.jsonl", []);
		const summary: SessionSummary = {
			id: "label",
			path: filePath,
			cwd: "/home/user/my-project",
			createdAt: "2026-07-01T00:00:00Z",
			updatedAt: "2026-07-01T00:00:00Z",
			messageCount: 0,
		};
		const [result] = await listSessionUsage(fakeBridge([summary]), 20);
		expect(result?.accountLabel).toBe("my-project");
	});

	test("extracts provider from first model_change entry (provider/modelId format)", async () => {
		const filePath = writeTranscript("provider-mc.jsonl", [
			{ type: "session", id: "p1" },
			{ type: "model_change", id: "mc1", parentId: null, model: "anthropic/claude-opus-4-5" },
			{ type: "message", message: { role: "assistant", usage: { totalTokens: 10, cost: { total: 0.001 } } } },
		]);
		const summary: SessionSummary = {
			id: "p1",
			path: filePath,
			cwd: "/x",
			createdAt: "2026-07-01T00:00:00Z",
			updatedAt: "2026-07-01T00:00:00Z",
			messageCount: 1,
		};
		const [result] = await listSessionUsage(fakeBridge([summary]), 20);
		expect(result?.provider).toBe("anthropic");
	});

	test("falls back to provider field on first assistant message when no model_change present", async () => {
		const filePath = writeTranscript("provider-fallback.jsonl", [
			{ type: "session", id: "p2" },
			{ type: "message", message: { role: "user", content: "hello" } },
			{ type: "message", message: { role: "assistant", provider: "openai-codex", usage: { totalTokens: 5 } } },
		]);
		const summary: SessionSummary = {
			id: "p2",
			path: filePath,
			cwd: "/x",
			createdAt: "2026-07-01T00:00:00Z",
			updatedAt: "2026-07-01T00:00:00Z",
			messageCount: 1,
		};
		const [result] = await listSessionUsage(fakeBridge([summary]), 20);
		expect(result?.provider).toBe("openai-codex");
	});

	test("omits provider when transcript has neither model_change nor provider on assistant message", async () => {
		const filePath = writeTranscript("no-provider.jsonl", [
			{ type: "session", id: "p3" },
			{ type: "message", message: { role: "assistant", usage: { totalTokens: 1 } } },
		]);
		const summary: SessionSummary = {
			id: "p3",
			path: filePath,
			cwd: "/x",
			createdAt: "2026-07-01T00:00:00Z",
			updatedAt: "2026-07-01T00:00:00Z",
			messageCount: 1,
		};
		const [result] = await listSessionUsage(fakeBridge([summary]), 20);
		expect(result?.provider).toBeUndefined();
	});
});
