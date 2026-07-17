import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearOmpExtensionCliRoots, injectOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";

import {
	isCodebaseMemoryReadToolName,
	getCodebaseMemoryMcpExtensionPath,
	toCodebaseMemoryContent,
	toCodebaseMemoryTools,
} from "./codebase-memory-mcp.ts";

beforeAll(() => {
	injectOmpExtensionCliRoots([getCodebaseMemoryMcpExtensionPath()], process.env.HOME ?? "/tmp", process.cwd());
});
afterAll(() => {
	clearOmpExtensionCliRoots();
});

describe("bundled codebase-memory-mcp discovery (T-111)", () => {
	test("loads the bundled server with the default enabled config", async () => {
		const result = await loadAllMCPConfigs(process.cwd(), { filterExa: false });
		expect(result.configs["codebase-memory-mcp"]).toMatchObject({
			type: "stdio",
			command: "codebase-memory-mcp",
			enabled: true,
		});
	});
	test("project disabled override removes only the bundled server", async () => {
		const project = mkdtempSync(path.join(os.tmpdir(), "omp-deck-mcp-project-"));
		try {
			mkdirSync(path.join(project, ".omp"));
			writeFileSync(
				path.join(project, ".omp", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						"codebase-memory-mcp": {
							command: "codebase-memory-mcp",
							args: [],
							enabled: false,
						},
					},
				}),
			);
			const result = await loadAllMCPConfigs(project, { filterExa: false });
			expect(result.configs["codebase-memory-mcp"]).toBeUndefined();
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});
});

describe("codebase-memory explorer safety (T-118)", () => {
	test("exposes only the explicit read-only tool allowlist", () => {
		const tools = toCodebaseMemoryTools([
			{ name: "search_graph", description: "Find symbols", inputSchema: { type: "object" } },
			{ name: "query_graph", description: "Read graph", inputSchema: { type: "object" } },
			{ name: "delete_project", description: "Delete memory", inputSchema: { type: "object" } },
			{ name: "index_repository", description: "Mutates memory", inputSchema: { type: "object" } },
		]);
		expect(tools).toEqual([
			{ name: "search_graph", description: "Find symbols", inputSchema: { type: "object" } },
			{ name: "query_graph", description: "Read graph", inputSchema: { type: "object" } },
		]);
		expect(isCodebaseMemoryReadToolName("query_graph")).toBeTrue();
		expect(isCodebaseMemoryReadToolName("delete_project")).toBeFalse();
		expect(isCodebaseMemoryReadToolName("index_repository")).toBeFalse();
	});

	test("bounds text emitted from an MCP tool response", () => {
		const content = toCodebaseMemoryContent(
			[
				{ type: "text", text: "first" },
				{ type: "resource", resource: { uri: "memory://alpha", text: "second" } },
				{ type: "image" },
			],
			7,
		);
		expect(content).toEqual([
			{ type: "text", text: "first" },
			{ type: "resource", uri: "memory://alpha", text: "se" },
		]);
	});
});
