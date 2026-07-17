import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Database, ExternalLink, RefreshCw, Search } from "lucide-react";
import type { CodebaseMemoryMcpStatus, CodebaseMemoryOverview, WorkspaceEntry } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { usePersistedViewState } from "@/lib/use-persisted-view-state";
import { useCodebaseMemoryGraph } from "@/lib/use-codebase-memory-graph";
import { CodebaseMemoryDetailPanel } from "./CodebaseMemoryDetailPanel";
import { CodebaseMemoryGraphPane, CodebaseMemoryResultsList } from "./CodebaseMemoryGraphPane";

/**
 * Guided Codebase Memory explorer (T-133). Replaces the old manual
 * tool+JSON-arguments query form (T-118) with a navigable project map: click
 * folders/files to expand them, filter by node type, search free text, and
 * trace call depth from a selected function — all through the *existing*
 * `/workspace-mcp/codebase-memory` overview + query endpoints, no new
 * backend routes. See `lib/codebase-memory-graph.ts` for the guided-action
 * to MCP-tool mapping.
 */
export function CodebaseMemoryView() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
	const [selectedCwd, setSelectedCwd] = usePersistedViewState("codebase-memory.workspace", "");
	const [status, setStatus] = useState<CodebaseMemoryMcpStatus>();
	const [overview, setOverview] = useState<CodebaseMemoryOverview>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	const [indexing, setIndexing] = useState(false);
	const [searchInput, setSearchInput] = useState("");
	const loadVersionRef = useRef(0);

	const refreshWorkspaces = useCallback(async (): Promise<void> => {
		try {
			const response = await api.listWorkspaces();
			setWorkspaces(response.workspaces);
			setError(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	const loadMemory = useCallback(async (cwd: string): Promise<void> => {
		if (!cwd) return;
		const loadVersion = ++loadVersionRef.current;
		setLoading(true);
		try {
			const nextStatus = await api.getCodebaseMemoryMcpStatus(cwd);
			if (loadVersion !== loadVersionRef.current) return;
			setStatus(nextStatus);
			if (!nextStatus.enabled) {
				setOverview(undefined);
				setError(undefined);
				return;
			}
			const nextOverview = await api.getCodebaseMemoryOverview(cwd);
			if (loadVersion !== loadVersionRef.current) return;
			setOverview(nextOverview);
			setError(undefined);
		} catch (cause) {
			if (loadVersion !== loadVersionRef.current) return;
			setOverview(undefined);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (loadVersion === loadVersionRef.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refreshWorkspaces();
	}, [refreshWorkspaces]);

	useEffect(() => {
		const cwd = searchParams.get("cwd");
		if (cwd) setSelectedCwd(cwd);
		// The deep link should only update the persisted selection when it changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchParams]);

	useEffect(() => {
		if (!selectedCwd && workspaces.length > 0) setSelectedCwd(workspaces[0]!.cwd);
	}, [selectedCwd, setSelectedCwd, workspaces]);
	useEffect(() => {
		// Invalidate pending responses before starting the next project's load.
		// A slow previous workspace must never overwrite this selection's view.
		loadVersionRef.current++;
		setStatus(undefined);
		setOverview(undefined);
		if (selectedCwd) void loadMemory(selectedCwd);
	}, [loadMemory, selectedCwd]);

	// A deep link (`?cwd=...`, e.g. from Project Configuration's "Explore
	// indexed memory" button) may point at a cwd the sidebar hasn't listed
	// yet. Fall back to a synthetic entry so the view still opens directly.
	const selectedWorkspace: WorkspaceEntry | undefined = useMemo(() => {
		const known = workspaces.find((w) => w.cwd === selectedCwd);
		if (known) return known;
		if (!selectedCwd) return undefined;
		return { cwd: selectedCwd, label: selectedCwd.split("/").filter(Boolean).pop() ?? selectedCwd, sessionCount: 0 };
	}, [workspaces, selectedCwd]);

	const memoryDisabled = status && !status.enabled;
	const overviewUnavailable = overview?.state === "disabled" || overview?.state === "unavailable";

	const graph = useCodebaseMemoryGraph(selectedCwd || undefined, overview);
	const nodesById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

	async function indexProject(): Promise<void> {
		if (!selectedCwd) return;
		setIndexing(true);
		try {
			await api.indexCodebaseMemory(selectedCwd);
			await loadMemory(selectedCwd);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setIndexing(false);
		}
	}

	return (
		<Layout
			sidebar={<Sidebar />}
			inspector={<div />}
			main={
				<div className="flex h-full flex-col overflow-hidden md:flex-row">
					<div className="flex max-h-36 w-full shrink-0 flex-col overflow-hidden border-b border-line md:max-h-none md:w-72 md:border-b-0 md:border-r">
						<div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
							<div className="flex items-center gap-2">
								<Database className="h-4 w-4 text-ink-3" />
								<h1 className="text-sm font-semibold text-ink">Codebase Memory</h1>
							</div>
							<button
								type="button"
								onClick={() => {
									void refreshWorkspaces();
									if (selectedCwd) void loadMemory(selectedCwd);
								}}
								className="rounded p-1 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"
								title="Refresh"
							>
								<RefreshCw className="h-3.5 w-3.5" />
							</button>
						</div>
						<div className="flex min-h-0 flex-1 flex-row overflow-x-auto overflow-y-hidden p-2 md:flex-col md:overflow-x-hidden md:overflow-y-auto">
							{workspaces.map((workspace) => (
								<button
									key={workspace.cwd}
									type="button"
									onClick={() => setSelectedCwd(workspace.cwd)}
									className={cn(
										"min-w-36 rounded-md px-2.5 py-2 text-left transition-colors md:w-full",
										workspace.cwd === selectedCwd ? "bg-accent-soft text-accent" : "hover:bg-paper-3",
									)}
								>
									<div className="truncate text-sm font-medium">{workspace.label}</div>
									<div className="truncate font-mono text-2xs text-ink-3" title={workspace.cwd}>
										{workspace.cwd}
									</div>
								</button>
							))}
							{workspaces.length === 0 ? <p className="py-8 text-center text-xs text-ink-3">No known workspaces yet.</p> : null}
						</div>
					</div>

					<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
						{error ? (
							<div className="mx-4 mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</div>
						) : null}
						{!selectedWorkspace ? (
							<p className="py-12 text-center text-sm text-ink-3">Select a project to explore its indexed memory.</p>
						) : loading ? (
							<p className="py-12 text-center text-sm text-ink-3">Loading Codebase Memory…</p>
						) : memoryDisabled || overviewUnavailable ? (
							<div className="m-4 rounded-md border border-line bg-paper-2 p-4">
								<h2 className="text-sm font-semibold text-ink">Codebase Memory is disabled</h2>
								<p className="mt-1 text-xs text-ink-3">
									{overview?.message ?? "Enable this project's MCP integration before inspecting indexed content."}
								</p>
								<Button className="mt-3" variant="ghost" size="sm" onClick={() => navigate(`/project-config?cwd=${encodeURIComponent(selectedWorkspace.cwd)}`)}>
									Open Project Configuration <ExternalLink className="ml-1 h-3.5 w-3.5" />
								</Button>
							</div>
						) : !graph.project?.indexed ? (
							<div className="m-4 rounded-md border border-line bg-paper-2 p-4">
								<h2 className="text-sm font-semibold text-ink">Not indexed yet</h2>
								<p className="mt-1 text-xs text-ink-3">
									{selectedWorkspace.label} hasn't been indexed by Codebase Memory. Index it once to explore its graph here.
								</p>
								<Button className="mt-3" size="sm" disabled={indexing} onClick={() => void indexProject()}>
									{indexing ? "Indexing…" : "Index this project"}
								</Button>
							</div>
						) : (
							<>
								<div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
									<div className="min-w-0">
										<h2 className="truncate text-sm font-semibold text-ink">{selectedWorkspace.label}</h2>
										<p className="truncate font-mono text-2xs text-ink-3">
											{graph.project.branch ? `${graph.project.branch} · ` : ""}
											{graph.schema ? `${graph.schema.totalNodes} nodes · ${graph.schema.totalEdges} edges` : "…"}
										</p>
									</div>
									<div className="ml-auto flex flex-wrap items-center gap-2">
										<select
											value={graph.resultLabel ?? ""}
											onChange={(e) => {
												if (e.target.value) {
													void graph.filterByType(e.target.value);
												} else {
													graph.clearResults();
												}
											}}
											className="rounded-md border border-line bg-paper px-2 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
											aria-label="Filter by node type"
										>
											<option value="">Filter by type…</option>
											{graph.schema?.nodeLabels.map((n) => (
												<option key={n.label} value={n.label}>
													{n.label} ({n.count})
												</option>
											))}
										</select>
										<div className="flex items-center gap-1.5 rounded-md border border-line bg-paper px-2 py-1 text-xs">
											<Search className="h-3.5 w-3.5 text-ink-3" />
											<input
												value={searchInput}
												onChange={(e) => {
													setSearchInput(e.target.value);
													void graph.search(e.target.value);
												}}
												placeholder="Search symbols…"
												className="w-40 bg-transparent text-ink placeholder:text-ink-4 focus:outline-none"
												aria-label="Search symbols"
											/>
										</div>
										<Button variant="ghost" size="sm" onClick={() => graph.resetToProjectMap()}>
											Reset map
										</Button>
									</div>
								</div>

								<div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:grid-rows-1">
									<div className="flex min-h-0 flex-col border-line lg:border-r">
										<div className="min-h-0 flex-1">
											<CodebaseMemoryGraphPane
												nodes={graph.nodes}
												edges={graph.edges}
												selectedId={graph.selectedNode?.id}
												expandedIds={graph.expandedIds}
												expandingId={graph.expandingId}
												loading={graph.rootLoading}
												truncated={graph.truncated}
												onNodeClick={(node) => {
													graph.select(node);
													if (node.expandable && !graph.expandedIds.has(node.id)) void graph.expand(node);
												}}
											/>
										</div>
										{graph.rootError ? <p className="border-t border-line px-3 py-1.5 font-mono text-2xs text-danger">{graph.rootError}</p> : null}
										{graph.resultLabel || graph.searchQuery ? (
											<CodebaseMemoryResultsList
												title={graph.resultLabel ? `Type: ${graph.resultLabel}` : `Search: "${graph.searchQuery}"`}
												loading={graph.resultsLoading}
												error={graph.resultsError}
												results={graph.results}
												selectedId={graph.selectedNode?.id}
												onSelect={(node) => graph.select(node)}
											/>
										) : null}
									</div>
									<div className="min-h-0 overflow-y-auto">
										<CodebaseMemoryDetailPanel
											node={graph.selectedNode}
											detail={graph.detail}
											detailLoading={graph.detailLoading}
											detailError={graph.detailError}
											edges={graph.edges}
											nodesById={nodesById}
											onPivot={(node) => graph.select(node)}
											tracing={graph.tracing}
											traceError={graph.traceError}
											onTrace={(node, depth) => void graph.traceDepth(node, depth)}
										/>
									</div>
								</div>
							</>
						)}
					</div>
				</div>
			}
		/>
	);
}
