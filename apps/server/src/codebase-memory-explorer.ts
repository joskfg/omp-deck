import { callTool, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConnection, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type {
	CodebaseMemoryIndexResult,
	CodebaseMemoryOverview,
	CodebaseMemoryQueryResult,
	CodebaseMemoryTool,
	QueryCodebaseMemoryRequest,
} from "@omp-deck/protocol";

import {
	CODEBASE_MEMORY_MCP_NAME,
	isCodebaseMemoryReadToolName,
	prepareCodebaseMemoryMcpRuntime,
	toCodebaseMemoryContent,
	toCodebaseMemoryTools,
} from "./codebase-memory-mcp.ts";

const MCP_REQUEST_TIMEOUT_MS = 15_000;
const MCP_INDEX_TIMEOUT_MS = 5 * 60_000;

export class CodebaseMemoryMcpDisabledError extends Error {
	constructor() {
		super("Codebase Memory MCP is disabled for this project");
	}
}

export class CodebaseMemoryMcpUnavailableError extends Error {}

export class CodebaseMemoryExplorer {
	async getOverview(cwd: string): Promise<CodebaseMemoryOverview> {
		return this.#withConnection(cwd, async (connection, tools) => {
			const catalogTool = tools.find((tool) => tool.name === "list_projects");
			const catalog = catalogTool
				? toCodebaseMemoryContent(
						(await callTool(connection, catalogTool.name, {}, { signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS) })).content,
					)
				: [];
			return { cwd, state: "ready", tools: toCodebaseMemoryTools(tools), catalog };
		});
	}

	async query(cwd: string, request: QueryCodebaseMemoryRequest): Promise<CodebaseMemoryQueryResult> {
		return this.#withConnection(cwd, async (connection, tools) => {
			if (!isCodebaseMemoryReadToolName(request.tool)) {
				throw new Error(`Unsupported Codebase Memory read tool: ${request.tool}`);
			}
			if (!tools.some((tool) => tool.name === request.tool)) {
				throw new Error(`Codebase Memory does not expose tool: ${request.tool}`);
			}
			const result = await callTool(connection, request.tool, request.arguments, {
				signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
			});
			return { content: toCodebaseMemoryContent(result.content), isError: result.isError === true };
		});
	}

	async index(cwd: string): Promise<CodebaseMemoryIndexResult> {
		return this.#withConnection(cwd, async (connection, tools) => {
			const indexTool = tools.find((tool) => tool.name === "index_repository");
			if (!indexTool) throw new Error("Codebase Memory does not expose tool: index_repository");
			const result = await callTool(connection, indexTool.name, { repo_path: cwd }, {
				signal: AbortSignal.timeout(MCP_INDEX_TIMEOUT_MS),
			});
			return { content: toCodebaseMemoryContent(result.content), isError: result.isError === true };
		});
	}

	async #withConnection<T>(
		cwd: string,
		visit: (connection: MCPServerConnection, tools: MCPToolDefinition[]) => Promise<T>,
	): Promise<T> {
		prepareCodebaseMemoryMcpRuntime();
		const loaded = await loadAllMCPConfigs(cwd, { filterExa: false });
		const config = loaded.configs[CODEBASE_MEMORY_MCP_NAME];
		const source = loaded.sources[CODEBASE_MEMORY_MCP_NAME];
		if (!config || !source) throw new CodebaseMemoryMcpDisabledError();

		const manager = new MCPManager(cwd);
		try {
			const connectionResult = await manager.connectServers(
				{ [CODEBASE_MEMORY_MCP_NAME]: config },
				{ [CODEBASE_MEMORY_MCP_NAME]: source },
			);
			const connectionError = connectionResult.errors.get(CODEBASE_MEMORY_MCP_NAME);
			if (connectionError) throw new CodebaseMemoryMcpUnavailableError(connectionError);

			let connection: MCPServerConnection;
			try {
				connection = await manager.waitForConnection(CODEBASE_MEMORY_MCP_NAME);
			} catch (error) {
				throw new CodebaseMemoryMcpUnavailableError(String(error));
			}
			return await visit(
				connection,
				await listTools(connection, { signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS) }),
			);
		} finally {
			await manager.disconnectAll();
		}
	}
}
