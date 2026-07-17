/**
 * Tests for T-35 governance: rule/extension bucket & disable-state
 * classification (pure, no I/O), plus integration coverage of
 * `listRules`/`setRuleEnabled`, `listExtensions`/`setExtensionEnabled`, and
 * `listTtsrHistory` against real on-disk SDK discovery + an isolated
 * `Settings` instance (never the real `~/.omp` config) + a temp SQLite db.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import type { Rule } from "@oh-my-pi/pi-coding-agent/discovery";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { SessionSummary } from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import { closeDb, openDb } from "./db/index.ts";
import { listGovernanceAuditEvents } from "./db/governance-audit.ts";
import {
	classifyExtensionState,
	classifyRuleBucket,
	GovernanceNotFoundError,
	listExtensions,
	listRules,
	listTtsrHistory,
	recordExtensionLoadErrors,
	setExtensionEnabled,
	setRuleEnabled,
} from "./governance-service.ts";

// ─────────────────────────────────────────────────────────────────────────
// Pure classification — no filesystem, no settings, no db.
// ─────────────────────────────────────────────────────────────────────────

const SOURCE: SourceMeta = { provider: "native", providerName: "OMP", path: "/rules/x.md", level: "project" };

function fakeRule(overrides: Partial<Rule> = {}): Rule {
	return { name: "x", path: "/rules/x.md", content: "body", _source: SOURCE, ...overrides };
}

describe("classifyRuleBucket", () => {
	test("condition + ttsr enabled -> ttsr bucket", () => {
		expect(classifyRuleBucket(fakeRule({ condition: ["TODO"] }), true)).toBe("ttsr");
	});

	test("astCondition alone is enough to qualify for ttsr", () => {
		expect(classifyRuleBucket(fakeRule({ astCondition: ["console.log($$$)"] }), true)).toBe("ttsr");
	});

	test("condition present but ttsr globally disabled falls through to the next bucket", () => {
		expect(classifyRuleBucket(fakeRule({ condition: ["TODO"], alwaysApply: true }), false)).toBe("always-apply");
	});

	test("alwaysApply wins over description when there is no condition", () => {
		expect(classifyRuleBucket(fakeRule({ alwaysApply: true, description: "d" }), true)).toBe("always-apply");
	});

	test("description alone -> rulebook", () => {
		expect(classifyRuleBucket(fakeRule({ description: "d" }), true)).toBe("rulebook");
	});

	test("nothing qualifies -> inactive", () => {
		expect(classifyRuleBucket(fakeRule(), true)).toBe("inactive");
	});
});

describe("classifyExtensionState", () => {
	test("item-disabled takes precedence over shadowed and provider-disabled", () => {
		const result = classifyExtensionState(
			"hook:pre:edit:x",
			"native",
			true,
			new Set(["hook:pre:edit:x"]),
			new Set(["native"]),
		);
		expect(result).toEqual({ state: "disabled", disabledReason: "item-disabled" });
	});

	test("shadowed takes precedence over provider-disabled", () => {
		const result = classifyExtensionState("hook:pre:edit:x", "native", true, new Set(), new Set(["native"]));
		expect(result).toEqual({ state: "shadowed", disabledReason: "shadowed" });
	});

	test("provider-disabled when neither item-disabled nor shadowed", () => {
		const result = classifyExtensionState("hook:pre:edit:x", "native", false, new Set(), new Set(["native"]));
		expect(result).toEqual({ state: "disabled", disabledReason: "provider-disabled" });
	});

	test("active when nothing disables it", () => {
		const result = classifyExtensionState("hook:pre:edit:x", "native", false, new Set(), new Set());
		expect(result).toEqual({ state: "active" });
	});
});

// ─────────────────────────────────────────────────────────────────────────
// Integration — real SDK capability discovery + isolated Settings + temp db.
// ─────────────────────────────────────────────────────────────────────────

let tmpCwd: string;
let dbDir: string;
let settings: Settings;
let initSpy: ReturnType<typeof spyOn<typeof Settings, "init">>;

beforeEach(() => {
	tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-governance-cwd-"));
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-governance-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });

	settings = Settings.isolated();
	initSpy = spyOn(Settings, "init").mockResolvedValue(settings);
});

afterEach(() => {
	initSpy.mockRestore();
	closeDb();
	fs.rmSync(tmpCwd, { recursive: true, force: true });
	fs.rmSync(dbDir, { recursive: true, force: true });
});

function writeCursorRule(cwd: string, fileName: string, frontmatter: string, body: string): void {
	const dir = path.join(cwd, ".cursor", "rules");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, fileName), `---\n${frontmatter}\n---\n${body}\n`);
}

describe("listRules / setRuleEnabled (integration)", () => {
	beforeEach(() => {
		writeCursorRule(tmpCwd, "ts-conditional.mdc", 'description: "no bare condition"\ncondition: "no-shortcuts"', "Body text.");
		writeCursorRule(tmpCwd, "always-rule.mdc", 'description: "always applies"\nalwaysApply: true', "Always body.");
	});

	test("discovers cursor rules and buckets them from real SDK discovery", async () => {
		const resp = await listRules(tmpCwd);
		const conditional = resp.rules.find((r) => r.name === "ts-conditional");
		const always = resp.rules.find((r) => r.name === "always-rule");

		expect(conditional).toBeDefined();
		expect(conditional?.bucket).toBe("ttsr");
		expect(conditional?.condition).toEqual(["no-shortcuts"]);
		expect(conditional?.enabled).toBe(true);
		expect(conditional?.source.provider).toBe("cursor");
		expect(conditional?.source.level).toBe("project");

		expect(always?.bucket).toBe("always-apply");
		expect(resp.ttsr.enabled).toBe(true); // SDK default
	});

	test("setRuleEnabled(false) disables via disabledExtensions and writes an ok audit row", async () => {
		const resp = await setRuleEnabled("ts-conditional", false, tmpCwd);

		expect(resp.rule.enabled).toBe(false);
		expect(resp.rule.disabledReason).toBe("rule-disabled");
		expect(settings.get("disabledExtensions")).toContain("rule:ts-conditional");
		expect(resp.audit.action).toBe("disable");
		expect(resp.audit.result).toBe("ok");
		expect(resp.audit.kind).toBe("rule");

		const relisted = await listRules(tmpCwd);
		expect(relisted.rules.find((r) => r.name === "ts-conditional")?.enabled).toBe(false);

		const [auditRow] = listGovernanceAuditEvents({ kind: "rule" });
		expect(auditRow?.targetId).toBe("rule:ts-conditional");
	});

	test("setRuleEnabled(true) re-enables and clears the legacy ttsr.disabledRules lever too", async () => {
		settings.set("disabledExtensions", ["rule:ts-conditional"]);
		settings.set("ttsr.disabledRules", ["ts-conditional"]);

		const resp = await setRuleEnabled("ts-conditional", true, tmpCwd);

		expect(resp.rule.enabled).toBe(true);
		expect(settings.get("disabledExtensions")).not.toContain("rule:ts-conditional");
		expect(settings.get("ttsr.disabledRules")).not.toContain("ts-conditional");
	});

	test("setRuleEnabled rejects an unknown rule name without writing settings or an audit row", async () => {
		await expect(setRuleEnabled("does-not-exist", false, tmpCwd)).rejects.toThrow(GovernanceNotFoundError);
		expect(settings.isConfigured("disabledExtensions")).toBe(false);
		expect(listGovernanceAuditEvents()).toHaveLength(0);
	});
});

function writeHook(cwd: string, type: "pre" | "post", tool: string): void {
	const dir = path.join(cwd, ".omp", "hooks", type);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${tool}.sh`), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

describe("listExtensions / setExtensionEnabled (integration)", () => {
	beforeEach(() => {
		writeHook(tmpCwd, "pre", "edit");
	});

	test("discovers a project-level hook", async () => {
		const resp = await listExtensions(tmpCwd);
		const hook = resp.extensions.find((e) => e.kind === "hook");
		expect(hook).toBeDefined();
		expect(hook?.id).toBe("hook:pre:edit:edit.sh");
		expect(hook?.trigger).toBe("pre:edit");
		expect(hook?.state).toBe("active");
		expect(hook?.source.level).toBe("project");
	});

	test("setExtensionEnabled toggles a hook off and back on", async () => {
		const list = await listExtensions(tmpCwd);
		const hookId = list.extensions.find((e) => e.kind === "hook")!.id;

		const disabled = await setExtensionEnabled(hookId, false, tmpCwd);
		expect(disabled.extension.state).toBe("disabled");
		expect(disabled.extension.disabledReason).toBe("item-disabled");
		expect(disabled.audit.kind).toBe("extension");
		expect(disabled.audit.action).toBe("disable");

		const enabled = await setExtensionEnabled(hookId, true, tmpCwd);
		expect(enabled.extension.state).toBe("active");
		expect(enabled.extension.disabledReason).toBeUndefined();
	});

	test("setExtensionEnabled rejects an id outside the governed kind prefixes", async () => {
		await expect(setExtensionEnabled("skill:some-skill", true, tmpCwd)).rejects.toThrow(GovernanceNotFoundError);
	});

	test("setExtensionEnabled rejects an unknown but well-formed id", async () => {
		await expect(setExtensionEnabled("hook:pre:edit:does-not-exist.sh", true, tmpCwd)).rejects.toThrow(
			GovernanceNotFoundError,
		);
	});
});

describe("recordExtensionLoadErrors", () => {
	test("writes one audit row per error", () => {
		recordExtensionLoadErrors("/proj", "sess-1", [
			{ path: "/proj/.omp/extensions/broken/index.ts", error: "SyntaxError: unexpected token" },
			{ path: "/proj/.omp/extensions/other/index.ts", error: "ReferenceError: x is not defined" },
		]);
		const rows = listGovernanceAuditEvents({ kind: "extension_load_error" });
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.sessionId === "sess-1" && r.result === "error")).toBe(true);
	});
});

describe("listTtsrHistory", () => {
	test("explains a persisted TTSR injection against the current rule inventory", async () => {
		writeCursorRule(tmpCwd, "ts-conditional.mdc", 'description: "no bare condition"\ncondition: "no-shortcuts"', "Body.");

		const sessionDir = path.join(tmpCwd, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const manager = SessionManager.create(tmpCwd, sessionDir);
		await manager.ensureOnDisk();
		manager.appendTtsrInjection(["ts-conditional"]);
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		const summary: SessionSummary = {
			id: "sess-1",
			path: sessionFile,
			cwd: tmpCwd,
			title: "Test session",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			messageCount: 0,
		};
		const bridge: Pick<AgentBridge, "listSessions"> = {
			listSessions: async () => [summary],
		};

		const resp = await listTtsrHistory(bridge as AgentBridge, tmpCwd);

		expect(resp.entries).toHaveLength(1);
		const [entry] = resp.entries;
		expect(entry?.ruleNames).toEqual(["ts-conditional"]);
		expect(entry?.rules).toEqual([
			{
				name: "ts-conditional",
				found: true,
				description: "no bare condition",
				condition: ["no-shortcuts"],
				astCondition: undefined,
				scope: undefined,
				interruptMode: "always",
			},
		]);
	});

	test("marks a rule not found when it's no longer in the inventory", async () => {
		const sessionDir = path.join(tmpCwd, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const manager = SessionManager.create(tmpCwd, sessionDir);
		await manager.ensureOnDisk();
		manager.appendTtsrInjection(["long-gone-rule"]);
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		const bridge: Pick<AgentBridge, "listSessions"> = {
			listSessions: async () => [
				{
					id: "sess-2",
					path: sessionFile,
					cwd: tmpCwd,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					messageCount: 0,
				},
			],
		};

		const resp = await listTtsrHistory(bridge as AgentBridge, tmpCwd);
		expect(resp.entries[0]?.rules).toEqual([{ name: "long-gone-rule", found: false }]);
	});
});
