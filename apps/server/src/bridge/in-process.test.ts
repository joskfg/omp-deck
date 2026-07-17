/**
 * Tests for summarizeSession() — the normaliser extracted from
 * bridge/in-process.ts as part of T-99.
 *
 * Root cause: the original summarize() read `raw.timestamp` / `raw.modifiedAt`
 * which do not exist on the SDK's SessionInfo shape.  The real fields are
 * `created: Date` and `modified: Date`, so createdAt/updatedAt were always ""
 * and durationMs was always undefined.
 *
 * We import session-normalizer.ts directly (pure module, only `import type`
 * for SDK/protocol dependencies) so the test carries no SDK runtime
 * dependency and avoids the @oh-my-pi/pi-tui resolution issue that makes
 * full in-process.ts imports fail in this worktree environment.
 */
import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent";

import { summarizeSession } from "./session-normalizer.ts";

/** Minimal SessionInfo fixture — only the fields summarizeSession() reads. */
function makeSessionInfo(created: Date, modified: Date): SessionInfo {
	return {
		id: "sess-fixture",
		path: "/home/user/.omp/sessions/sess-fixture.jsonl",
		cwd: "/home/user/project",
		title: "Fixture session",
		created,
		modified,
		messageCount: 6,
		size: 2048,
		firstMessage: "Hello",
		allMessagesText: "Hello",
	};
}

describe("summarizeSession — timestamp normalisation (T-99)", () => {
	test("createdAt is a real ISO-8601 string from SessionInfo.created (not empty)", () => {
		const created = new Date("2025-01-15T08:00:00.000Z");
		const modified = new Date("2025-01-15T08:03:00.000Z");

		const s = summarizeSession(makeSessionInfo(created, modified));

		expect(s.createdAt).toBe("2025-01-15T08:00:00.000Z");
	});

	test("updatedAt is a real ISO-8601 string from SessionInfo.modified (not empty)", () => {
		const created = new Date("2025-01-15T08:00:00.000Z");
		const modified = new Date("2025-01-15T08:03:00.000Z");

		const s = summarizeSession(makeSessionInfo(created, modified));

		expect(s.updatedAt).toBe("2025-01-15T08:03:00.000Z");
	});

	test("durationMs reflects the gap between created and modified", () => {
		const created = new Date("2025-06-01T10:00:00.000Z");
		const modified = new Date("2025-06-01T10:02:30.000Z");

		const s = summarizeSession(makeSessionInfo(created, modified));

		expect(s.durationMs).toBe(150_000); // 2 m 30 s
	});

	test("legacy string fallback: timestamp field is used when created is absent", () => {
		const ts = "2024-11-20T09:30:00.000Z";
		// Simulate a legacy record shape via the extended RawSessionRecord fields.
		const raw = {
			id: "legacy-1",
			path: "/sessions/legacy-1.jsonl",
			cwd: "/project",
			created: new Date(NaN),
			modified: new Date(NaN),
			messageCount: 2,
			size: 512,
			firstMessage: "",
			allMessagesText: "",
			timestamp: ts,
			modifiedAt: ts,
		};

		const s = summarizeSession(raw);

		expect(s.createdAt).toBe(ts);
		expect(s.updatedAt).toBe(ts);
	});
});
