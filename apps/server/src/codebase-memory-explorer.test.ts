import { describe, expect, test } from "bun:test";

import { CodebaseMemoryExplorer } from "./codebase-memory-explorer.ts";

describe("CodebaseMemoryExplorer (T-118)", () => {
	test("connects only to the bundled MCP and reads its project catalog", async () => {
		const overview = await new CodebaseMemoryExplorer().getOverview(process.cwd());

		expect(overview).toMatchObject({ cwd: process.cwd(), state: "ready" });
		expect(overview.tools.some((tool) => tool.name === "list_projects")).toBeTrue();
		expect(Array.isArray(overview.catalog)).toBeTrue();
	}, 30_000);
});
