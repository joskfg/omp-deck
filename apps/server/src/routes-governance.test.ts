/**
 * HTTP-level tests for `/api/governance/*` (T-35): cwd validation, request
 * body validation, and status codes. Real SDK discovery + isolated Settings
 * + temp SQLite db, same fixtures as `governance-service.test.ts` — this
 * file focuses on the router's own contract (status codes, error bodies),
 * not re-deriving the underlying discovery/classification behavior.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { ListExtensionsResponse, ListRulesResponse, ListTtsrHistoryResponse } from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import { closeDb, openDb } from "./db/index.ts";
import { buildGovernanceRouter } from "./routes-governance.ts";

let fakeHome: string;
let tmpCwd: string;
let dbDir: string;
let settings: Settings;
let initSpy: ReturnType<typeof spyOn<typeof Settings, "init">>;
let originalHome: string | undefined;

const bridge: Pick<AgentBridge, "listSessions"> = {
	listSessions: async () => [],
};

function app() {
	return buildGovernanceRouter(bridge as AgentBridge);
}

beforeEach(() => {
	fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-governance-home-"));
	tmpCwd = path.join(fakeHome, "project");
	fs.mkdirSync(path.join(tmpCwd, ".cursor", "rules"), { recursive: true });
	fs.writeFileSync(
		path.join(tmpCwd, ".cursor", "rules", "test-rule.mdc"),
		'---\ndescription: "test rule"\nalwaysApply: true\n---\nBody.\n',
	);

	originalHome = process.env.HOME;
	process.env.HOME = fakeHome;

	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-governance-routes-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });

	settings = Settings.isolated();
	initSpy = spyOn(Settings, "init").mockResolvedValue(settings);
});

afterEach(() => {
	initSpy.mockRestore();
	closeDb();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	fs.rmSync(fakeHome, { recursive: true, force: true });
	fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("GET /governance/rules", () => {
	test("200 with the discovered rule for an allowed cwd", async () => {
		const res = await app().request(`/governance/rules?cwd=${encodeURIComponent(tmpCwd)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListRulesResponse;
		expect(body.rules.map((r) => r.name)).toContain("test-rule");
	});

	test("403 for a cwd outside the allowed workspace roots", async () => {
		const res = await app().request(`/governance/rules?cwd=${encodeURIComponent("/etc")}`);
		expect(res.status).toBe(403);
	});
});

describe("PUT /governance/rules/:name", () => {
	test("200 toggles the rule and returns the updated state + audit entry", async () => {
		const res = await app().request(`/governance/rules/test-rule?cwd=${encodeURIComponent(tmpCwd)}`, {
			method: "PUT",
			body: JSON.stringify({ enabled: false }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { rule: { enabled: boolean }; audit: { result: string } };
		expect(body.rule.enabled).toBe(false);
		expect(body.audit.result).toBe("ok");
	});

	test("400 on a non-boolean enabled value", async () => {
		const res = await app().request(`/governance/rules/test-rule?cwd=${encodeURIComponent(tmpCwd)}`, {
			method: "PUT",
			body: JSON.stringify({ enabled: "nope" }),
		});
		expect(res.status).toBe(400);
	});

	test("400 on malformed JSON", async () => {
		const res = await app().request(`/governance/rules/test-rule?cwd=${encodeURIComponent(tmpCwd)}`, {
			method: "PUT",
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	test("404 for an unknown rule name", async () => {
		const res = await app().request(`/governance/rules/does-not-exist?cwd=${encodeURIComponent(tmpCwd)}`, {
			method: "PUT",
			body: JSON.stringify({ enabled: false }),
		});
		expect(res.status).toBe(404);
	});
});

describe("GET /governance/extensions", () => {
	test("200 with the discovered project-level hook", async () => {
		fs.mkdirSync(path.join(tmpCwd, ".omp", "hooks", "pre"), { recursive: true });
		fs.writeFileSync(path.join(tmpCwd, ".omp", "hooks", "pre", "edit.sh"), "#!/bin/sh\nexit 0\n");

		const res = await app().request(`/governance/extensions?cwd=${encodeURIComponent(tmpCwd)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListExtensionsResponse;
		expect(body.extensions.find((e) => e.id === "hook:pre:edit:edit.sh")).toBeDefined();
		expect(body.loadErrors).toEqual([]);
	});
});

describe("PUT /governance/extensions/:id", () => {
	test("404 for an unknown extension id", async () => {
		const res = await app().request(`/governance/extensions/${encodeURIComponent("hook:pre:edit:nope.sh")}?cwd=${encodeURIComponent(tmpCwd)}`, {
			method: "PUT",
			body: JSON.stringify({ enabled: false }),
		});
		expect(res.status).toBe(404);
	});
});

describe("GET /governance/ttsr/history", () => {
	test("200 with an empty history when the bridge has no sessions", async () => {
		const res = await app().request(`/governance/ttsr/history?cwd=${encodeURIComponent(tmpCwd)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListTtsrHistoryResponse;
		expect(body.entries).toEqual([]);
		expect(body.truncated).toBe(false);
	});
});

describe("GET /governance/audit", () => {
	test("200 with an empty list before any change was made", async () => {
		const res = await app().request("/governance/audit");
		expect(res.status).toBe(200);
		expect((await res.json()) as { entries: unknown[] }).toEqual({ entries: [] });
	});

	test("reflects a rule toggle", async () => {
		await app().request(`/governance/rules/test-rule?cwd=${encodeURIComponent(tmpCwd)}`, {
			method: "PUT",
			body: JSON.stringify({ enabled: false }),
		});
		const res = await app().request("/governance/audit?kind=rule");
		const body = (await res.json()) as { entries: Array<{ kind: string; targetId: string }> };
		expect(body.entries).toEqual([{ ...body.entries[0], kind: "rule", targetId: "rule:test-rule" }]);
	});
});
