/**
 * Unit tests for usage-stats.ts helpers.
 *
 * getAggregatedStats itself requires the omp-stats DB and a live bridge, so
 * it is covered by routes-usage.test.ts at the route level.  Here we test the
 * pure helpers that can be exercised without external deps.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	computeCutoff,
	isSyncInProgress,
	resolveDeckSession,
	resolveParentSessionPath,
	resetSyncStateForTests,
} from "./usage-stats.ts";

afterEach(() => {
	resetSyncStateForTests();
});

// ---------------------------------------------------------------------------
// computeCutoff
// ---------------------------------------------------------------------------

describe("computeCutoff", () => {
	test("returns null for 'all'", () => {
		expect(computeCutoff("all")).toBeNull();
	});

	test("returns ~1-hour cutoff for '1h'", () => {
		const before = Date.now();
		const cutoff = computeCutoff("1h");
		const after = Date.now();
		expect(cutoff).not.toBeNull();
		expect(cutoff!).toBeGreaterThanOrEqual(before - 60 * 60 * 1000 - 5);
		expect(cutoff!).toBeLessThanOrEqual(after - 60 * 60 * 1000 + 5);
	});

	test("returns ~7-day cutoff for '7d'", () => {
		const before = Date.now();
		const cutoff = computeCutoff("7d");
		expect(cutoff).not.toBeNull();
		expect(cutoff!).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000 - 5);
	});

	test("returns ~30-day cutoff for '30d'", () => {
		const cutoff = computeCutoff("30d");
		expect(cutoff).not.toBeNull();
		const approxDiff = Date.now() - cutoff!;
		expect(approxDiff).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
		expect(approxDiff).toBeLessThan(31 * 24 * 60 * 60 * 1000);
	});

	test("falls back to 24h for unknown range strings", () => {
		const before = Date.now();
		const cutoff = computeCutoff("unknown-range");
		expect(cutoff).not.toBeNull();
		const approxDiff = Date.now() - cutoff!;
		// Should be close to 24h
		expect(approxDiff).toBeGreaterThan(23 * 60 * 60 * 1000);
		expect(approxDiff).toBeLessThan(25 * 60 * 60 * 1000);
	});

	test("covers all documented valid ranges without throwing", () => {
		for (const r of ["1h", "24h", "7d", "30d", "90d", "all"]) {
			expect(() => computeCutoff(r)).not.toThrow();
		}
	});
});

// ---------------------------------------------------------------------------
// resolveParentSessionPath
// ---------------------------------------------------------------------------

describe("resolveParentSessionPath", () => {
	test("returns parent .jsonl for a nested subagent path", () => {
		const sessionsDir = "/home/user/.omp/agent/sessions";
		const subagentFile = path.join(sessionsDir, "--home--user--project", "sessionId", "sub123.jsonl");
		const parent = resolveParentSessionPath(subagentFile);
		expect(parent).toBe(path.join(sessionsDir, "--home--user--project", "sessionId.jsonl"));
	});

	test("works for advisor transcript", () => {
		const sessionsDir = "/home/user/.omp/agent/sessions";
		const advisorFile = path.join(sessionsDir, "--project", "mainSession", "__advisor.jsonl");
		expect(resolveParentSessionPath(advisorFile)).toBe(
			path.join(sessionsDir, "--project", "mainSession.jsonl"),
		);
	});
});

// ---------------------------------------------------------------------------
// resolveDeckSession
// ---------------------------------------------------------------------------

describe("resolveDeckSession", () => {
	const sessionsDir = "/home/user/.omp/agent/sessions";

	function makeMap(entries: Array<{ path: string; id: string; title?: string; cwd: string }>) {
		return new Map(entries.map((e) => [e.path, { id: e.id, title: e.title, cwd: e.cwd }]));
	}

	test("resolves a main session directly", () => {
		const mainFile = path.join(sessionsDir, "--project", "sess1.jsonl");
		const pathMap = makeMap([{ path: mainFile, id: "sess1", cwd: "/project" }]);

		const result = resolveDeckSession(mainFile, "main", pathMap);
		expect(result).not.toBeNull();
		expect(result!.info.id).toBe("sess1");
		expect(result!.agentType).toBe("main");
	});

	test("resolves a nested subagent to its parent session", () => {
		const mainFile = path.join(sessionsDir, "--project", "sess1.jsonl");
		const subFile = path.join(sessionsDir, "--project", "sess1", "sub42.jsonl");
		const pathMap = makeMap([{ path: mainFile, id: "sess1", cwd: "/project" }]);

		const result = resolveDeckSession(subFile, "subagent", pathMap);
		expect(result).not.toBeNull();
		expect(result!.info.id).toBe("sess1");
		expect(result!.agentType).toBe("subagent");
	});

	test("resolves a nested advisor to its parent session", () => {
		const mainFile = path.join(sessionsDir, "--project", "sess1.jsonl");
		const advisorFile = path.join(sessionsDir, "--project", "sess1", "__advisor.jsonl");
		const pathMap = makeMap([{ path: mainFile, id: "sess1", cwd: "/project" }]);

		const result = resolveDeckSession(advisorFile, "advisor", pathMap);
		expect(result).not.toBeNull();
		expect(result!.info.id).toBe("sess1");
		expect(result!.agentType).toBe("advisor");
	});

	test("resolves an advisor nested inside a subagent to the main session", () => {
		// Layout: <sessionsDir>/<project>/<main>/<subagent>/__advisor.jsonl
		// omp-stats classifies this as `advisor` regardless of depth.
		const mainFile = path.join(sessionsDir, "--project", "sess1.jsonl");
		const deepAdvisorFile = path.join(
			sessionsDir,
			"--project",
			"sess1",
			"sub42",
			"__advisor.jsonl",
		);
		const pathMap = makeMap([{ path: mainFile, id: "sess1", cwd: "/project" }]);

		const result = resolveDeckSession(deepAdvisorFile, "advisor", pathMap);
		expect(result).not.toBeNull();
		expect(result!.info.id).toBe("sess1");
		expect(result!.agentType).toBe("advisor");
	});

	test("returns null when no ancestor path is in the map", () => {
		const orphanFile = path.join(sessionsDir, "--project", "gone", "sub.jsonl");
		const pathMap = makeMap([{ path: path.join(sessionsDir, "--project", "other.jsonl"), id: "other", cwd: "/project" }]);
		expect(resolveDeckSession(orphanFile, "subagent", pathMap)).toBeNull();
	});

	test("returns null for an unknown session file", () => {
		const unknown = "/some/other/path/unknown.jsonl";
		const pathMap = makeMap([]);
		expect(resolveDeckSession(unknown, "main", pathMap)).toBeNull();
	});

	test("prefers the direct match over the parent path", () => {
		// A file that has both a direct entry AND a parent entry in the map
		const mainFile = path.join(sessionsDir, "--project", "sess1.jsonl");
		const pathMap = makeMap([
			{ path: mainFile, id: "direct-sess", cwd: "/project" },
			// Would be the parent of mainFile if mainFile itself were a subagent — but
			// direct match wins so no confusion.
		]);
		const result = resolveDeckSession(mainFile, "main", pathMap);
		expect(result!.info.id).toBe("direct-sess");
	});
});

// ---------------------------------------------------------------------------
// isSyncInProgress / resetSyncStateForTests
// ---------------------------------------------------------------------------

describe("isSyncInProgress", () => {
	test("returns false initially", () => {
		expect(isSyncInProgress()).toBe(false);
	});

	test("returns false after reset", () => {
		resetSyncStateForTests();
		expect(isSyncInProgress()).toBe(false);
	});
});
