import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { injectOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import type {
	CodebaseMemoryContentBlock,
	CodebaseMemoryMcpStatus,
	CodebaseMemoryTool,
} from "@omp-deck/protocol";

export const CODEBASE_MEMORY_MCP_NAME = "codebase-memory-mcp";
export const CODEBASE_MEMORY_MCP_COMMAND = "codebase-memory-mcp";

export const CODEBASE_MEMORY_READ_TOOL_NAMES = [
	"list_projects",
	"index_status",
	"search_graph",
	"trace_call_path",
	"trace_path",
	"query_graph",
	"get_architecture",
	"get_graph_schema",
	"get_code_snippet",
	"search_code",
] as const;

export type CodebaseMemoryReadToolName = (typeof CODEBASE_MEMORY_READ_TOOL_NAMES)[number];

let runtimePrepared = false;

/**
 * The bundled extension makes the codebase-memory MCP definition discoverable
 * to the SDK. Its executable is installed with omp-deck, so its bin directory
 * must also be present when a route starts the server outside an agent session.
 */
export function prepareCodebaseMemoryMcpRuntime(): void {
	if (runtimePrepared) return;
	runtimePrepared = true;

	injectOmpExtensionCliRoots([getCodebaseMemoryMcpExtensionPath()], os.homedir(), process.cwd());

	const binDirs = [
		path.resolve(import.meta.dir, "../node_modules/.bin"),
		path.resolve(import.meta.dir, "../../node_modules/.bin"),
		path.resolve(import.meta.dir, "../../../node_modules/.bin"),
		path.resolve(import.meta.dir, "../../../../node_modules/.bin"),
	].filter(existsSync);
	if (binDirs.length > 0) {
		const currentPath = process.env.PATH ?? "";
		process.env.PATH = [...binDirs, currentPath].filter(Boolean).join(path.delimiter);
	}
}

export function isCodebaseMemoryReadToolName(value: string): value is CodebaseMemoryReadToolName {
	return (CODEBASE_MEMORY_READ_TOOL_NAMES as readonly string[]).includes(value);
}

export function toCodebaseMemoryTools(
	tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>,
): CodebaseMemoryTool[] {
	return tools
		.filter((tool) => isCodebaseMemoryReadToolName(tool.name))
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
		}));
}

export function toCodebaseMemoryContent(
	content: Array<
		| { type: "text"; text: string }
		| { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } }
		| { type: string }
	>,
	maxTextChars = 64_000,
): CodebaseMemoryContentBlock[] {
	let remaining = maxTextChars;
	const blocks: CodebaseMemoryContentBlock[] = [];

	for (const block of content) {
		if (remaining <= 0) break;
		if (block.type === "text" && "text" in block) {
			const text = block.text.slice(0, remaining);
			remaining -= text.length;
			blocks.push({ type: "text", text });
		} else if (block.type === "resource" && "resource" in block) {
			const text = block.resource.text?.slice(0, remaining);
			if (text) remaining -= text.length;
			blocks.push({
				type: "resource",
				uri: block.resource.uri,
				mimeType: block.resource.mimeType,
				...(text ? { text } : {}),
			});
		}
	}

	return blocks;
}

export interface ProjectMcpConfig {
	mcpServers?: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
}


export function getCodebaseMemoryMcpExtensionPath(): string {
	return path.resolve(import.meta.dir, "mcp", "codebase-memory-mcp");
}

export function getProjectMcpConfigPath(cwd: string): string {
	return path.join(cwd, ".omp", "mcp.json");
}

export function getDefaultCodebaseMemoryMcpConfig(): Record<string, unknown> {
	return {
		command: CODEBASE_MEMORY_MCP_COMMAND,
		args: [],
	};
}

export function getCodebaseMemoryMcpStatus(cwd: string, config: ProjectMcpConfig): CodebaseMemoryMcpStatus {
	const entry = config.mcpServers?.[CODEBASE_MEMORY_MCP_NAME];
	return {
		cwd,
		enabled: entry?.enabled !== false,
		configured: entry !== undefined,
	};
}

export function setCodebaseMemoryMcpEnabled(config: ProjectMcpConfig, enabled: boolean): ProjectMcpConfig {
	return {
		...config,
		mcpServers: {
			...(config.mcpServers ?? {}),
			[CODEBASE_MEMORY_MCP_NAME]: {
				...getDefaultCodebaseMemoryMcpConfig(),
				...(config.mcpServers?.[CODEBASE_MEMORY_MCP_NAME] ?? {}),
				enabled,
			},
		},
	};
}
