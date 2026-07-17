import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentBridge } from "./bridge/types.ts";
import type { BridgeSupervisor } from "./bridge-supervisor.ts";
import type { Config } from "./config.ts";
import type { KbService } from "./kb-service.ts";
import type { MarketplaceService } from "./marketplace-service.ts";
import { buildRouter } from "./routes.ts";
import type { RoutinesRunner } from "./routines-runner.ts";
import type { SkillsService } from "./skills-service.ts";

function config(defaultCwd: string): Config {
	return {
		host: "127.0.0.1",
		port: 8787,
		defaultCwd,
		extraWorkspaces: [],
		title: "omp-deck",
		devMode: true,
		idleTimeoutMs: 0,
		dbPath: path.join(defaultCwd, "deck.db"),
		uploadsRoot: path.join(defaultCwd, "uploads"),
	};
}

describe("PUT /workspace-preferences", () => {
	let originalHome: string | undefined;
	let home: string;
	let project: string;

	beforeEach(() => {
		home = mkdtempSync(path.join(os.tmpdir(), "omp-deck-workspace-preferences-home-"));
		project = path.join(home, "project");
		mkdirSync(project);
		originalHome = process.env.HOME;
		process.env.HOME = home;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		rmSync(home, { recursive: true, force: true });
	});

	test("returns 400 when model is missing instead of dereferencing it", async () => {
		const bridge = { listModels: async () => [] } as unknown as AgentBridge;
		const app = buildRouter(
			bridge,
			config(project),
			{} as RoutinesRunner,
			{} as BridgeSupervisor,
			{} as MarketplaceService,
			{} as SkillsService,
			{} as KbService,
		);

		const response = await app.request(`/workspace-preferences?cwd=${encodeURIComponent(project)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: "{}",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "model is required" });
	});
});
