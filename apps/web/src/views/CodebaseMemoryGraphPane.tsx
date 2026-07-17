import { memo, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { ForceGraphMethods } from "react-force-graph-2d";
import { AlertTriangle, Loader2 } from "lucide-react";

import type { CmEdge, CmNode } from "@/lib/codebase-memory-graph";
import { cn } from "@/lib/utils";

interface DisplayNode {
	id: string;
	kind: CmNode["kind"];
	label: string;
	name: string;
	expandable: boolean;
	expanded: boolean;
}

interface DisplayLink {
	source: string;
	target: string;
	kind: CmEdge["kind"];
}

/**
 * Force-directed canvas for the Codebase Memory project map (T-133). Renders
 * whatever `nodes`/`edges` the parent hook currently has loaded — folders and
 * files expand in place as the user clicks them; call-trace hops merge in
 * the same way. Search/type-filter results live in a separate DOM list (see
 * `CodebaseMemoryResultsList`) rather than this canvas, so free-text lookups
 * stay keyboard/screen-reader reachable without canvas hit-testing.
 */
export const CodebaseMemoryGraphPane = memo(function CodebaseMemoryGraphPane({
	nodes,
	edges,
	selectedId,
	expandedIds,
	expandingId,
	loading,
	truncated,
	onNodeClick,
}: {
	nodes: CmNode[];
	edges: CmEdge[];
	selectedId: string | undefined;
	expandedIds: Set<string>;
	expandingId: string | undefined;
	loading: boolean;
	truncated: boolean;
	onNodeClick: (node: CmNode) => void;
}) {
	const displayNodes = useMemo<DisplayNode[]>(
		() =>
			nodes.map((n) => ({
				id: n.id,
				kind: n.kind,
				label: n.label,
				name: n.name,
				expandable: n.expandable,
				expanded: expandedIds.has(n.id),
			})),
		[nodes, expandedIds],
	);
	const displayLinks = useMemo<DisplayLink[]>(() => edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind })), [edges]);

	const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

	const containerRef = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState<{ width: number; height: number }>({ width: 800, height: 600 });
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
	useEffect(() => {
		fgRef.current?.zoomToFit(300, 60);
	}, [displayNodes.length]);

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
				<div className="meta">Graph</div>
				<div className="text-xs text-ink-3">
					{loading ? "loading…" : `${displayNodes.length} nodes · ${displayLinks.length} edges`}
				</div>
				{truncated ? (
					<span
						className="inline-flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 font-mono text-2xs text-warn"
						title="Some directories have more files than shown here — narrow with search to see the rest."
					>
						<AlertTriangle className="h-3 w-3" /> truncated
					</span>
				) : null}
			</div>
			<div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-paper" data-testid="cm-graph-canvas">
				{loading && displayNodes.length === 0 ? (
					<div className="absolute inset-0 flex items-center justify-center text-sm text-ink-3">
						<Loader2 className="mr-2 h-4 w-4 animate-spin" /> loading project map…
					</div>
				) : null}
				{displayNodes.length > 0 ? (
					<ForceGraph2D
						ref={fgRef}
						graphData={{ nodes: displayNodes, links: displayLinks }}
						width={size.width}
						height={size.height}
						nodeId="id"
						nodeLabel={(n) => {
							const node = n as DisplayNode;
							const hint = node.expandable ? (node.expanded ? "click to select" : "click to expand") : "click to select";
							return `${node.label}: ${node.name}\n${hint}`;
						}}
						nodeColor={(n) => {
							const node = n as DisplayNode;
							if (node.id === selectedId) return "#f97316"; // orange-500 — matches selection accent elsewhere
							return colorForLabel(node.kind === "root" ? "Project" : node.label);
						}}
						nodeRelSize={2.4}
						nodeVal={(n) => {
							const node = n as DisplayNode;
							if (node.kind === "root") return 10;
							if (node.kind === "folder") return 5;
							if (node.kind === "file") return 3.5;
							return node.expanded ? 3 : 1.6;
						}}
						linkColor={(l) => ((l as DisplayLink).kind === "calls" ? "rgba(249,115,22,0.45)" : "rgba(160,160,160,0.28)")}
						linkWidth={(l) => ((l as DisplayLink).kind === "calls" ? 1.2 : 0.6)}
						linkDirectionalArrowLength={4}
						linkDirectionalArrowRelPos={1}
						cooldownTicks={120}
						warmupTicks={40}
						onNodeClick={(n) => {
							const node = byId.get((n as DisplayNode).id);
							if (node) onNodeClick(node);
						}}
						enableNodeDrag={false}
					/>
				) : !loading ? (
					<div className="absolute inset-0 flex items-center justify-center text-sm text-ink-3">Nothing indexed to show yet.</div>
				) : null}
				{expandingId ? (
					<div className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-md border border-line bg-paper/95 px-2 py-1 text-2xs text-ink-3 shadow-sm">
						<Loader2 className="h-3 w-3 animate-spin" /> expanding…
					</div>
				) : null}
			</div>
			<nav className="max-h-24 shrink-0 overflow-y-auto border-t border-line bg-paper-2 p-1.5" aria-label="Graph nodes">
				<ul className="flex flex-wrap gap-1">
					{nodes.map((node) => (
						<li key={node.id}>
							<button
								type="button"
								onClick={() => onNodeClick(node)}
								data-node-id={node.id}
								aria-pressed={node.id === selectedId}
								aria-expanded={node.expandable ? expandedIds.has(node.id) : undefined}
								className={cn(
									"rounded px-1.5 py-1 text-left font-mono text-2xs transition-colors",
									node.id === selectedId ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-paper-3 hover:text-ink",
								)}
							>
								{node.label}: {node.name}
							</button>
						</li>
					))}
				</ul>
			</nav>
		</div>
	);
});

/** Deterministic color per schema label — stable across reloads, distinct from KB's per-directory palette. */
function colorForLabel(label: string): string {
	switch (label) {
		case "Project":
			return "#94a3b8"; // slate
		case "Folder":
			return "#eab308"; // amber
		case "File":
			return "#3b82f6"; // blue
		case "Function":
		case "Method":
			return "#10b981"; // emerald
		case "Class":
		case "Interface":
			return "#a855f7"; // violet
		case "Route":
			return "#ec4899"; // pink
		case "Type":
			return "#06b6d4"; // cyan
		default: {
			let h = 0;
			for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
			return `hsl(${h % 360},60%,55%)`;
		}
	}
}

export function CodebaseMemoryResultsList({
	title,
	loading,
	error,
	results,
	selectedId,
	onSelect,
}: {
	title: string;
	loading: boolean;
	error: string | undefined;
	results: CmNode[];
	selectedId: string | undefined;
	onSelect: (node: CmNode) => void;
}) {
	return (
		<div className="border-t border-line bg-paper-2">
			<div className="flex items-center gap-2 px-3 py-1.5">
				<div className="meta">{title}</div>
				{loading ? <Loader2 className="h-3 w-3 animate-spin text-ink-3" /> : null}
			</div>
			{error ? <p className="px-3 pb-2 font-mono text-2xs text-danger">{error}</p> : null}
			{!loading && !error && results.length === 0 ? <p className="px-3 pb-2 text-2xs text-ink-3">No matches.</p> : null}
			<ul className="max-h-40 overflow-y-auto px-1 pb-1">
				{results.map((r, idx) => (
					<li key={r.id}>
						<button
							type="button"
							data-testid={`cm-result-${idx}`}
							onClick={() => onSelect(r)}
							className={cn(
								"flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
								r.id === selectedId ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-paper-3",
							)}
						>
							<span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colorForLabel(r.label) }} />
							<span className="truncate font-medium">{r.name}</span>
							<span className="ml-auto shrink-0 font-mono text-2xs text-ink-3">{r.label}</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
