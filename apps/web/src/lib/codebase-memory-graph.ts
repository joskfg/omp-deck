/**
 * Codebase Memory graph explorer (T-133).
 *
 * Thin client over the *existing* generic `/workspace-mcp/codebase-memory`
 * overview + query endpoints (T-118). No new backend routes: every call here
 * invokes one of the already-allowlisted read-only MCP tools
 * (`list_projects`, `get_graph_schema`, `search_graph`, `get_code_snippet`,
 * `trace_path`) through `api.queryCodebaseMemory`, and decodes the JSON text
 * content block the MCP returns.
 *
 * The UI never lets a user type a tool name or a raw query — every function
 * here takes structured, typed arguments. That's what makes this "guided
 * navigation" rather than the old manual tool+JSON-arguments explorer.
 *
 * Node id scheme (must stay consistent — the graph pane links edges to nodes
 * purely by id): the synthetic project root is `ROOT_NODE_ID`, folders are
 * `folderNodeId(path)`, files are `fileNodeId(path)`, and symbols (functions,
 * classes, routes, ...) use their MCP `qualified_name` directly as the id.
 */
import type { CodebaseMemoryOverview } from "@omp-deck/protocol";

import { api } from "@/lib/api";

// ─── Raw MCP shapes (as returned by codebase-memory-mcp's JSON tool output) ─

interface CatalogProjectGit {
	branch: string | null;
	canonical_root: string | null;
	worktree_root: string | null;
}

export interface CatalogProject {
	name: string;
	root_path: string;
	git: CatalogProjectGit;
	nodes: number;
	edges: number;
	size_bytes: number;
}

interface SearchGraphResult {
	name: string;
	qualified_name: string;
	label: string;
	file_path: string;
	start_line?: number;
	end_line?: number;
	in_degree?: number;
	out_degree?: number;
	complexity?: number;
	lines?: number;
	is_exported?: boolean;
	is_test?: boolean;
	is_entry_point?: boolean;
	rank?: number;
}

interface SearchGraphResponse {
	results: SearchGraphResult[];
	total: number;
	has_more?: boolean;
}

interface GraphSchemaResponse {
	node_labels: { label: string; count: number }[];
	edge_types: { type: string; count: number }[];
}

interface CodeSnippetResponse {
	name: string;
	qualified_name: string;
	label: string;
	file_path: string;
	start_line?: number;
	end_line?: number;
	source?: string;
}

interface TraceHop {
	name: string;
	qualified_name: string;
	hop: number;
}

interface TracePathResponse {
	function: string;
	direction: string;
	callers: TraceHop[];
	callees: TraceHop[];
}

// ─── Public node/edge model consumed by the graph pane ─────────────────────

export type CmNodeKind = "root" | "folder" | "file" | "symbol";

export interface CmNode {
	id: string;
	kind: CmNodeKind;
	label: string; // "Project" | "Folder" | "File" | schema label (Function, Class, Route, ...)
	name: string;
	path?: string; // relative file/folder path
	qualifiedName?: string; // present for symbol + file/folder nodes
	inDegree?: number;
	outDegree?: number;
	isExported?: boolean;
	isTest?: boolean;
	isEntryPoint?: boolean;
	expandable: boolean;
}

export interface CmEdge {
	id: string;
	source: string;
	target: string;
	kind: "contains" | "defines" | "calls";
	hop?: number;
}

export interface CmSchema {
	totalNodes: number;
	totalEdges: number;
	nodeLabels: { label: string; count: number }[];
}

export interface CmProjectRef {
	cwd: string;
	indexed: boolean;
	project?: string;
	nodes?: number;
	edges?: number;
	branch?: string;
}

export interface CmLevel {
	nodes: CmNode[];
	edges: CmEdge[];
	truncated: boolean;
}

export const TRACE_ELIGIBLE_LABELS = new Set(["Function", "Method"]);

export const ROOT_NODE_ID = "__root__";

export function rootNode(projectName: string): CmNode {
	return { id: ROOT_NODE_ID, kind: "root", label: "Project", name: projectName, expandable: false };
}

export function folderNodeId(path: string): string {
	return `folder:${path}`;
}

export function fileNodeId(path: string): string {
	return `file:${path}`;
}

/** True when `itemPath`'s immediate parent directory is exactly `parent` ("" = repo root). */
function isDirectChild(itemPath: string, parent: string): boolean {
	const idx = itemPath.lastIndexOf("/");
	const itemParent = idx === -1 ? "" : itemPath.slice(0, idx);
	return itemParent === parent;
}

async function callTool<T>(cwd: string, tool: string, args: Record<string, unknown>): Promise<T> {
	const result = await api.queryCodebaseMemory(cwd, { tool, arguments: args });
	if (result.isError) {
		const message = result.content.find((b) => b.text)?.text ?? `${tool} reported an error`;
		throw new Error(message);
	}
	const text = result.content.find((b) => b.type === "text")?.text;
	if (!text) throw new Error(`${tool} returned no content`);
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${tool} returned non-JSON content`);
	}
}

/** Parses the `list_projects` catalog already fetched by the overview endpoint. */
export function parseCatalog(overview: CodebaseMemoryOverview | undefined): CatalogProject[] {
	const text = overview?.catalog.find((b) => b.type === "text")?.text;
	if (!text) return [];
	try {
		const parsed = JSON.parse(text) as { projects?: CatalogProject[] };
		return parsed.projects ?? [];
	} catch {
		return [];
	}
}

/** Resolves the indexed project (if any) matching this workspace's cwd. */
export function resolveProject(overview: CodebaseMemoryOverview | undefined, cwd: string): CmProjectRef {
	const catalog = parseCatalog(overview);
	const match = catalog.find((p) => p.root_path === cwd || p.git?.canonical_root === cwd || p.git?.worktree_root === cwd);
	if (!match) return { cwd, indexed: false };
	return { cwd, indexed: true, project: match.name, nodes: match.nodes, edges: match.edges, branch: match.git?.branch ?? undefined };
}

export async function fetchSchema(cwd: string, project: string): Promise<CmSchema> {
	const res = await callTool<GraphSchemaResponse>(cwd, "get_graph_schema", { project });
	const totalNodes = res.node_labels.reduce((sum, n) => sum + n.count, 0);
	const totalEdges = res.edge_types.reduce((sum, e) => sum + e.count, 0);
	return { totalNodes, totalEdges, nodeLabels: res.node_labels.filter((n) => n.label !== "Project" && n.label !== "Branch") };
}

function toFolderNode(r: SearchGraphResult): CmNode {
	return { id: folderNodeId(r.file_path), kind: "folder", label: "Folder", name: r.name, path: r.file_path, qualifiedName: r.qualified_name, expandable: true };
}

function toFileNode(r: SearchGraphResult): CmNode {
	return { id: fileNodeId(r.file_path), kind: "file", label: "File", name: r.name, path: r.file_path, qualifiedName: r.qualified_name, expandable: true };
}

function toSymbolNode(r: SearchGraphResult): CmNode {
	return {
		id: r.qualified_name,
		kind: "symbol",
		label: r.label,
		name: r.name,
		path: r.file_path,
		qualifiedName: r.qualified_name,
		inDegree: r.in_degree,
		outDegree: r.out_degree,
		isExported: r.is_exported,
		isTest: r.is_test,
		isEntryPoint: r.is_entry_point,
		expandable: TRACE_ELIGIBLE_LABELS.has(r.label),
	};
}

/**
 * Every folder in the project, fetched once (folders are typically dozens,
 * not thousands — cheap to keep fully resident) so folder-tree branching can
 * be computed client-side without a network round trip per click. Files are
 * NOT preloaded this way since a large project can have thousands of them;
 * those are fetched lazily per-directory in `fetchProjectRoot`/`fetchFolderChildren`.
 */
export async function fetchAllFolders(cwd: string, project: string, limit = 500): Promise<CmNode[]> {
	const res = await callTool<SearchGraphResponse>(cwd, "search_graph", { project, label: "Folder", limit });
	return res.results.map(toFolderNode);
}

function buildDirLevel(sourceId: string, scopePath: string, allFolders: CmNode[], files: SearchGraphResponse, fileCap: number): CmLevel {
	const nodes: CmNode[] = [];
	const edges: CmEdge[] = [];
	for (const folder of allFolders) {
		if (!folder.path || !isDirectChild(folder.path, scopePath)) continue;
		nodes.push(folder);
		edges.push({ id: `${sourceId}->${folder.id}`, source: sourceId, target: folder.id, kind: "contains" });
	}
	let fileCount = 0;
	for (const r of files.results) {
		if (!isDirectChild(r.file_path, scopePath)) continue;
		fileCount++;
		const fileNode = toFileNode(r);
		nodes.push(fileNode);
		edges.push({ id: `${sourceId}->${fileNode.id}`, source: sourceId, target: fileNode.id, kind: "contains" });
	}
	const truncated = files.has_more === true || (files.total > fileCap && fileCount < files.total);
	return { nodes, edges, truncated };
}

/** Root-level project map: the project root plus its direct folders/files. */
export async function fetchProjectRoot(cwd: string, project: string, allFolders: CmNode[], fileCap: number): Promise<CmLevel> {
	const files = await callTool<SearchGraphResponse>(cwd, "search_graph", { project, label: "File", limit: fileCap });
	return buildDirLevel(ROOT_NODE_ID, "", allFolders, files, fileCap);
}

/** Direct children (folders + files) of one folder — used to expand a Folder node. */
export async function fetchFolderChildren(cwd: string, project: string, folderPath: string, allFolders: CmNode[], fileCap: number): Promise<CmLevel> {
	const files = await callTool<SearchGraphResponse>(cwd, "search_graph", {
		project,
		label: "File",
		file_pattern: `${folderPath}/`,
		limit: fileCap,
	});
	return buildDirLevel(folderNodeId(folderPath), folderPath, allFolders, files, fileCap);
}

/** Symbols (functions, classes, routes, ...) defined in one file — expands a File node. */
export async function fetchFileSymbols(cwd: string, project: string, filePath: string, limit: number): Promise<CmLevel> {
	const res = await callTool<SearchGraphResponse>(cwd, "search_graph", { project, file_pattern: filePath, limit });
	const sourceId = fileNodeId(filePath);
	const nodes: CmNode[] = [];
	const edges: CmEdge[] = [];
	for (const r of res.results) {
		if (r.label === "File" || r.label === "Folder" || r.file_path !== filePath) continue;
		const symbol = toSymbolNode(r);
		nodes.push(symbol);
		edges.push({ id: `${sourceId}->${symbol.id}`, source: sourceId, target: symbol.id, kind: "defines" });
	}
	return { nodes, edges, truncated: res.has_more === true };
}

/** Nodes of one schema label (predefined "filter by type" action). */
export async function searchByLabel(cwd: string, project: string, label: string, limit: number): Promise<CmNode[]> {
	const res = await callTool<SearchGraphResponse>(cwd, "search_graph", { project, label, limit });
	return res.results.filter((r) => r.label !== "Folder" && r.label !== "File").map(toSymbolNode);
}

/** Free-text (BM25) symbol search — predefined "search" action with clickable results. */
export async function searchByQuery(cwd: string, project: string, query: string, limit: number): Promise<CmNode[]> {
	const res = await callTool<SearchGraphResponse>(cwd, "search_graph", { project, query, limit });
	return res.results.map(toSymbolNode);
}

export interface CmNodeDetail {
	name: string;
	qualifiedName: string;
	label: string;
	filePath?: string;
	startLine?: number;
	endLine?: number;
	source?: string;
}

export async function fetchSnippet(cwd: string, project: string, qualifiedName: string): Promise<CmNodeDetail> {
	const res = await callTool<CodeSnippetResponse>(cwd, "get_code_snippet", { project, qualified_name: qualifiedName });
	return {
		name: res.name,
		qualifiedName: res.qualified_name,
		label: res.label,
		filePath: res.file_path,
		startLine: res.start_line,
		endLine: res.end_line,
		source: res.source,
	};
}

/** Depth-bounded call trace (predefined "trace calls" action) — Function/Method nodes only. */
export async function traceCalls(cwd: string, project: string, functionName: string, focusId: string, depth: number): Promise<{ nodes: CmNode[]; edges: CmEdge[] }> {
	const res = await callTool<TracePathResponse>(cwd, "trace_path", { project, function_name: functionName, direction: "both", depth });
	const nodes: CmNode[] = [];
	const edges: CmEdge[] = [];
	for (const caller of res.callers) {
		nodes.push({ id: caller.qualified_name, kind: "symbol", label: "Function", name: caller.name, qualifiedName: caller.qualified_name, expandable: true });
		edges.push({ id: `${caller.qualified_name}=calls=>${focusId}`, source: caller.qualified_name, target: focusId, kind: "calls", hop: caller.hop });
	}
	for (const callee of res.callees) {
		nodes.push({ id: callee.qualified_name, kind: "symbol", label: "Function", name: callee.name, qualifiedName: callee.qualified_name, expandable: true });
		edges.push({ id: `${focusId}=calls=>${callee.qualified_name}`, source: focusId, target: callee.qualified_name, kind: "calls", hop: callee.hop });
	}
	return { nodes, edges };
}
