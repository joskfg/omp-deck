import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import { Hono } from "hono";
import type {
	CodebaseMemoryIndexResult,
	CodebaseMemoryOverview,
	CodebaseMemoryQueryResult,
	CodebaseMemoryMcpStatus,
	QueryCodebaseMemoryRequest,
	SetCodebaseMemoryMcpRequest,
} from "@omp-deck/protocol";

import {
	getCodebaseMemoryMcpStatus,
	getProjectMcpConfigPath,
	setCodebaseMemoryMcpEnabled,
	type ProjectMcpConfig,
} from "./codebase-memory-mcp.ts";

import {
	CodebaseMemoryExplorer,
	CodebaseMemoryMcpDisabledError,
	CodebaseMemoryMcpUnavailableError,
} from "./codebase-memory-explorer.ts";
import { cwdNotAllowedMessage } from "./routes-fs.ts";


export interface CodebaseMemoryExplorerApi {
	getOverview(cwd: string): Promise<CodebaseMemoryOverview>;
	query(cwd: string, request: QueryCodebaseMemoryRequest): Promise<CodebaseMemoryQueryResult>;
	index(cwd: string): Promise<CodebaseMemoryIndexResult>;
}

export function buildCodebaseMemoryRouter(
	isCwdAllowed: (cwd: string) => boolean,
	explorer: CodebaseMemoryExplorerApi = new CodebaseMemoryExplorer(),
): Hono {
	const app = new Hono();

	app.get("/workspace-mcp/codebase-memory", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		if (!isCwdAllowed(cwd)) return c.json({ error: cwdNotAllowedMessage() }, 400);

		try {
			const config = await readProjectMcpConfig(cwd);
			const status: CodebaseMemoryMcpStatus = getCodebaseMemoryMcpStatus(cwd, config);
			return c.json(status);
		} catch (error) {
			return c.json({ error: `invalid project MCP config: ${String(error)}` }, 500);
		}
	});

	app.get("/workspace-mcp/codebase-memory/overview", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		if (!isCwdAllowed(cwd)) return c.json({ error: cwdNotAllowedMessage() }, 400);

		try {
			return c.json(await explorer.getOverview(cwd));
		} catch (error) {
			if (error instanceof CodebaseMemoryMcpDisabledError || error instanceof CodebaseMemoryMcpUnavailableError) {
				const overview: CodebaseMemoryOverview = {
					cwd,
					state: error instanceof CodebaseMemoryMcpDisabledError ? "disabled" : "unavailable",
					message: error.message,
					tools: [],
					catalog: [],
				};
				return c.json(overview);
			}
			return c.json({ error: `could not read Codebase Memory: ${String(error)}` }, 502);
		}
	});

	app.post("/workspace-mcp/codebase-memory/index", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		if (!isCwdAllowed(cwd)) return c.json({ error: cwdNotAllowedMessage() }, 400);

		try {
			const result = await explorer.index(cwd);
			return c.json(result);
		} catch (error) {
			if (error instanceof CodebaseMemoryMcpDisabledError) {
				return c.json({ error: error.message }, 409);
			}
			if (error instanceof CodebaseMemoryMcpUnavailableError) {
				return c.json({ error: error.message }, 503);
			}
			return c.json({ error: `could not index Codebase Memory: ${String(error)}` }, 502);
		}
	});

	app.post("/workspace-mcp/codebase-memory/query", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		if (!isCwdAllowed(cwd)) return c.json({ error: cwdNotAllowedMessage() }, 400);

		let body: QueryCodebaseMemoryRequest;
		try {
			body = (await c.req.json()) as QueryCodebaseMemoryRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (
			typeof body.tool !== "string" ||
			!body.arguments ||
			typeof body.arguments !== "object" ||
			Array.isArray(body.arguments)
		) {
			return c.json({ error: "tool must be a string and arguments must be an object" }, 400);
		}

		try {
			const result: CodebaseMemoryQueryResult = await explorer.query(cwd, body);
			return c.json(result);
		} catch (error) {
			if (error instanceof CodebaseMemoryMcpDisabledError) {
				return c.json({ error: error.message }, 409);
			}
			if (error instanceof CodebaseMemoryMcpUnavailableError) {
				return c.json({ error: error.message }, 503);
			}
			return c.json({ error: `could not query Codebase Memory: ${String(error)}` }, 502);
		}
	});

	app.put("/workspace-mcp/codebase-memory", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		if (!isCwdAllowed(cwd)) return c.json({ error: cwdNotAllowedMessage() }, 400);

		let body: SetCodebaseMemoryMcpRequest;
		try {
			body = (await c.req.json()) as SetCodebaseMemoryMcpRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);

		try {
			const config = await readProjectMcpConfig(cwd);
			const next = setCodebaseMemoryMcpEnabled(config, body.enabled);
			const configPath = getProjectMcpConfigPath(cwd);
			await mkdir(path.dirname(configPath), { recursive: true });
			await Bun.write(configPath, `${JSON.stringify(next, null, 2)}\n`);
			return c.json(getCodebaseMemoryMcpStatus(cwd, next));
		} catch (error) {
			return c.json({ error: `could not write project MCP config: ${String(error)}` }, 500);
		}
	});

	return app;
}

async function readProjectMcpConfig(cwd: string): Promise<ProjectMcpConfig> {
	const file = Bun.file(getProjectMcpConfigPath(cwd));
	if (!(await file.exists())) return {};
	const parsed: unknown = JSON.parse(await file.text());
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("config must be a JSON object");
	}
	return parsed as ProjectMcpConfig;
}
