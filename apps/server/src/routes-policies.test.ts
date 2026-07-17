import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GetPolicySettingsResponse } from "@omp-deck/protocol";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

import { buildPoliciesRouter } from "./routes-policies.ts";

let originalHome: string | undefined;
let fakeHome: string;
let settings: Settings;
let initSpy: ReturnType<typeof spyOn<typeof Settings, "init">>;
let setSpy: ReturnType<typeof spyOn<Settings, "set">>;
let flushSpy: ReturnType<typeof spyOn<Settings, "flush">>;

beforeEach(() => {
	originalHome = process.env.HOME;
	fakeHome = mkdtempSync(path.join(os.tmpdir(), "omp-deck-policies-home-"));
	process.env.HOME = fakeHome;

	settings = Settings.isolated();
	initSpy = spyOn(Settings, "init").mockResolvedValue(settings);
	setSpy = spyOn(settings, "set");
	flushSpy = spyOn(settings, "flush");
});

afterEach(() => {
	initSpy.mockRestore();
	setSpy.mockRestore();
	flushSpy.mockRestore();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(fakeHome, { recursive: true, force: true });
});

describe("policy governance routes", () => {
	test("GET exposes effective schema defaults, their origin, and the required role policies", async () => {
		const app = buildPoliciesRouter();
		const res = await app.request("/policies/settings");

		expect(res.status).toBe(200);
		const body = (await res.json()) as GetPolicySettingsResponse;
		expect(body.settings).toHaveLength(16);
		expect(body.settings.map((entry) => entry.key)).toEqual([
			"modelRoles",
			"defaultThinkingLevel",
			"retry.enabled",
			"retry.maxRetries",
			"retry.baseDelayMs",
			"retry.maxDelayMs",
			"retry.modelFallback",
			"retry.fallbackChains",
			"retry.fallbackRevertPolicy",
			"compaction.enabled",
			"compaction.midTurnEnabled",
			"compaction.strategy",
			"compaction.thresholdPercent",
			"compaction.thresholdTokens",
			"compaction.handoffSaveToDisk",
			"compaction.autoContinue",
		]);
		expect(body.settings.find((entry) => entry.key === "defaultThinkingLevel")).toMatchObject({
			value: "high",
			defaultValue: "high",
			configured: false,
			origin: "schema-default",
			type: "enum",
		});
		expect(body.settings.find((entry) => entry.key === "retry.maxRetries")).toMatchObject({
			value: 10,
			defaultValue: 10,
			configured: false,
			type: "number",
		});
		expect(body.settings.find((entry) => entry.key === "compaction.strategy")).toMatchObject({
			value: "snapcompact",
			defaultValue: "snapcompact",
			configured: false,
		});
		expect(body.roles.map((role) => role.id)).toEqual(expect.arrayContaining(["default", "smol", "slow", "plan"]));
		expect(body.configPath).toBe(path.join(fakeHome, ".omp", "agent", "config.yml"));
	});

	test("PATCH persists a scalar policy and returns its effective configured value", async () => {
		const app = buildPoliciesRouter();
		const res = await app.request("/policies/settings", {
			method: "PATCH",
			body: JSON.stringify({ updates: { "compaction.strategy": "handoff", "retry.maxRetries": 4 } }),
		});

		expect(res.status).toBe(200);
		expect(setSpy).toHaveBeenCalledWith("compaction.strategy", "handoff");
		expect(setSpy).toHaveBeenCalledWith("retry.maxRetries", 4);
		expect(flushSpy).toHaveBeenCalledTimes(1);
		const body = (await res.json()) as GetPolicySettingsResponse;
		expect(body.settings.find((entry) => entry.key === "compaction.strategy")).toMatchObject({
			value: "handoff",
			configured: true,
			origin: "omp-config",
		});
	});

	test("PATCH validates model role and fallback chain record shapes before mutating OMP settings", async () => {
		const app = buildPoliciesRouter();
		for (const [updates, error] of [
			[{ modelRoles: { default: ["provider/model"] } }, "modelRoles must be an object mapping role ids to model selector strings"],
			[
				{ "retry.fallbackChains": { default: ["provider/model", 3] } },
				"retry.fallbackChains must be an object mapping role ids to arrays of model selector strings",
			],
		] as const) {
			const res = await app.request("/policies/settings", { method: "PATCH", body: JSON.stringify({ updates }) });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error });
		}
		expect(setSpy).not.toHaveBeenCalled();
		expect(flushSpy).not.toHaveBeenCalled();
	});

	test("PATCH persists complete model role and fallback-chain records without constraining OMP selectors", async () => {
		const app = buildPoliciesRouter();
		const roles = { default: "gpt-5.6", smol: "openai/gpt-5.6-mini", plan: "custom planner" };
		const chains = { default: ["gpt-5.6", "anthropic/claude-opus-4"], slow: ["openai/gpt-5.6"] };
		const res = await app.request("/policies/settings", {
			method: "PATCH",
			body: JSON.stringify({ updates: { modelRoles: roles, "retry.fallbackChains": chains } }),
		});

		expect(res.status).toBe(200);
		expect(setSpy).toHaveBeenCalledWith("modelRoles", roles);
		expect(setSpy).toHaveBeenCalledWith("retry.fallbackChains", chains);
		const body = (await res.json()) as GetPolicySettingsResponse;
		expect(body.settings.find((entry) => entry.key === "modelRoles")?.value).toEqual(roles);
		expect(body.settings.find((entry) => entry.key === "retry.fallbackChains")?.value).toEqual(chains);
		expect(body.roles.find((role) => role.id === "default")?.assignedModel).toBe("gpt-5.6");
	});
});
