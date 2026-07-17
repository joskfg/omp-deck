import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentBridge } from "./bridge/types.ts";
import type { BridgeSupervisor } from "./bridge-supervisor.ts";
import type { Config } from "./config.ts";
import type { KbService } from "./kb-service.ts";
import type { MarketplaceService } from "./marketplace-service.ts";
import { buildRouter } from "./routes.ts";
import {
	CodebaseMemoryMcpDisabledError,
	CodebaseMemoryMcpUnavailableError,
} from "./codebase-memory-explorer.ts";
import { buildCodebaseMemoryRouter } from "./routes-codebase-memory.ts";
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

function makeApp(project: string) {
	return buildRouter(
		{ listModels: async () => [] } as unknown as AgentBridge,
		config(project),
		{} as RoutinesRunner,
		{} as BridgeSupervisor,
		{} as MarketplaceService,
		{} as SkillsService,
		{} as KbService,
	);
}

describe("codebase-memory-mcp project toggle (T-111)", () => {
	let originalHome: string | undefined;
	let home: string;
	let project: string;

	beforeEach(() => {
		home = mkdtempSync(path.join(os.tmpdir(), "omp-deck-codebase-memory-home-"));
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

	test("defaults to enabled without creating a project override", async () => {
		const response = await makeApp(project).request(`/workspace-mcp/codebase-memory?cwd=${encodeURIComponent(project)}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ cwd: project, enabled: true, configured: false });
	});

	test("persists disabled state and preserves other project MCP servers", async () => {
		mkdirSync(path.join(project, ".omp"));
		writeFileSync(
			path.join(project, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { filesystem: { command: "filesystem", args: [] } } }),
		);
		const app = makeApp(project);
		const response = await app.request(`/workspace-mcp/codebase-memory?cwd=${encodeURIComponent(project)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ cwd: project, enabled: false, configured: true });

		const configPath = path.join(project, ".omp", "mcp.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as {
			mcpServers: Record<string, Record<string, unknown>>;
		};
		expect(config.mcpServers.filesystem).toEqual({ command: "filesystem", args: [] });
		expect(config.mcpServers["codebase-memory-mcp"]).toEqual({
			command: "codebase-memory-mcp",
			args: [],
			enabled: false,
		});

		const enabled = await app.request(`/workspace-mcp/codebase-memory?cwd=${encodeURIComponent(project)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
		expect(await enabled.json()).toEqual({ cwd: project, enabled: true, configured: true });
	});

	test("rejects non-boolean toggle payloads", async () => {
		const response = await makeApp(project).request(`/workspace-mcp/codebase-memory?cwd=${encodeURIComponent(project)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: "false" }),
		});
		expect(response.status).toBe(400);
	});
});

describe("codebase-memory explorer routes (T-118)", () => {
	const cwd = "/workspaces/alpha";
	const overview = {
		cwd,
		state: "ready" as const,
		tools: [{ name: "search_graph", inputSchema: { type: "object" } }],
		catalog: [{ type: "text" as const, text: "alpha\n" }],
	};

	test("returns the bounded catalog supplied by the read-only explorer", async () => {
		const calls: string[] = [];
		const app = buildCodebaseMemoryRouter(
			(candidate) => candidate === cwd,
			{
				async getOverview(candidate) {
					calls.push(candidate);
					return overview;
				},
				async query() {
					throw new Error("not used");
				},
				async index() {
					throw new Error("not used");
				},
			},
		);

		const response = await app.request(`/workspace-mcp/codebase-memory/overview?cwd=${encodeURIComponent(cwd)}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(overview);
		expect(calls).toEqual([cwd]);
	});

	test("passes only a JSON-object query payload to the explorer", async () => {
		const queries: Array<{ cwd: string; tool: string; arguments: Record<string, unknown> }> = [];
		const app = buildCodebaseMemoryRouter(
			(candidate) => candidate === cwd,
			{
				async getOverview() {
					throw new Error("not used");
				},
				async query(queryCwd, request) {
					queries.push({ cwd: queryCwd, ...request });
					return { content: [{ type: "text", text: "match" }], isError: false };
				},
				async index() {
					throw new Error("not used");
				},
			},
		);

		const response = await app.request(`/workspace-mcp/codebase-memory/query?cwd=${encodeURIComponent(cwd)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ tool: "search_graph", arguments: { project: "alpha", name_pattern: "main" } }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ content: [{ type: "text", text: "match" }], isError: false });
		expect(queries).toEqual([{ cwd, tool: "search_graph", arguments: { project: "alpha", name_pattern: "main" } }]);

		const invalid = await app.request(`/workspace-mcp/codebase-memory/query?cwd=${encodeURIComponent(cwd)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ tool: "search_graph", arguments: [] }),
		});
		expect(invalid.status).toBe(400);
		expect(queries).toHaveLength(1);
	});

	test("indexes only the explicitly selected allowed workspace", async () => {
		const indexed: string[] = [];
		const app = buildCodebaseMemoryRouter(
			(candidate) => candidate === cwd,
			{
				async getOverview() {
					throw new Error("not used");
				},
				async query() {
					throw new Error("not used");
				},
				async index(candidate) {
					indexed.push(candidate);
					return { content: [{ type: "text", text: "indexed alpha" }], isError: false };
				},
			},
		);

		const response = await app.request(`/workspace-mcp/codebase-memory/index?cwd=${encodeURIComponent(cwd)}`, {
			method: "POST",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ content: [{ type: "text", text: "indexed alpha" }], isError: false });
		expect(indexed).toEqual([cwd]);

		const disallowed = await app.request("/workspace-mcp/codebase-memory/index?cwd=/outside", { method: "POST" });
		expect(disallowed.status).toBe(400);
		expect(await disallowed.json()).toEqual({
			error:
				"cwd is not an allowed workspace. It must be an existing directory under $HOME or a root in OMP_DECK_WORKSPACES. Configure additional workspace roots in Settings → Env → OMP_DECK_WORKSPACES.",
		});
		expect(indexed).toEqual([cwd]);
	});

	test("reports a disabled integration without invoking MCP tools", async () => {
		const app = buildCodebaseMemoryRouter(
			(candidate) => candidate === cwd,
			{
				async getOverview() {
					throw new CodebaseMemoryMcpDisabledError();
				},
				async query() {
					throw new CodebaseMemoryMcpDisabledError();
				},
				async index() {
					throw new CodebaseMemoryMcpDisabledError();
				},
			},
		);

		const overviewResponse = await app.request(`/workspace-mcp/codebase-memory/overview?cwd=${encodeURIComponent(cwd)}`);
		expect(overviewResponse.status).toBe(200);
		expect(await overviewResponse.json()).toEqual({
			cwd,
			state: "disabled",
			message: "Codebase Memory MCP is disabled for this project",
			tools: [],
			catalog: [],
		});

		const queryResponse = await app.request(`/workspace-mcp/codebase-memory/query?cwd=${encodeURIComponent(cwd)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ tool: "search_graph", arguments: {} }),
		});
		expect(queryResponse.status).toBe(409);

		const indexResponse = await app.request(`/workspace-mcp/codebase-memory/index?cwd=${encodeURIComponent(cwd)}`, {
			method: "POST",
		});
		expect(indexResponse.status).toBe(409);
	});

	test("reports an unavailable MCP without falling back to an unbounded response", async () => {
		const app = buildCodebaseMemoryRouter(
			(candidate) => candidate === cwd,
			{
				async getOverview() {
					throw new CodebaseMemoryMcpUnavailableError("MCP executable did not start");
				},
				async query() {
					throw new CodebaseMemoryMcpUnavailableError("MCP executable did not start");
				},
				async index() {
					throw new CodebaseMemoryMcpUnavailableError("MCP executable did not start");
				},
			},
		);

		const overviewResponse = await app.request(`/workspace-mcp/codebase-memory/overview?cwd=${encodeURIComponent(cwd)}`);
		expect(overviewResponse.status).toBe(200);
		expect(await overviewResponse.json()).toEqual({
			cwd,
			state: "unavailable",
			message: "MCP executable did not start",
			tools: [],
			catalog: [],
		});

		const indexResponse = await app.request(`/workspace-mcp/codebase-memory/index?cwd=${encodeURIComponent(cwd)}`, {
			method: "POST",
		});
		expect(indexResponse.status).toBe(503);
	});
});
