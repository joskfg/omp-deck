import { useState } from "react";
import { Loader2, Route } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { TRACE_ELIGIBLE_LABELS, type CmEdge, type CmNode, type CmNodeDetail } from "@/lib/codebase-memory-graph";
import { cn } from "@/lib/utils";

/**
 * Right-hand detail panel for the Codebase Memory explorer (T-133). Shows
 * whatever the graph/results list selected: type, file origin, source
 * snippet (symbols only), and the edges currently touching that node in the
 * loaded graph — each relation is itself clickable, so browsing stays
 * click-driven end to end.
 */
export function CodebaseMemoryDetailPanel({
	node,
	detail,
	detailLoading,
	detailError,
	edges,
	nodesById,
	onPivot,
	tracing,
	traceError,
	onTrace,
}: {
	node: CmNode | undefined;
	detail: CmNodeDetail | undefined;
	detailLoading: boolean;
	detailError: string | undefined;
	edges: CmEdge[];
	nodesById: Map<string, CmNode>;
	onPivot: (node: CmNode) => void;
	tracing: boolean;
	traceError: string | undefined;
	onTrace: (node: CmNode, depth: number) => void;
}) {
	const [depth, setDepth] = useState(1);

	if (!node) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink-3">
				Select a node in the graph or a search result to see its detail here.
			</div>
		);
	}

	const relations = edges
		.filter((e) => e.source === node.id || e.target === node.id)
		.map((e) => {
			const neighborId = e.source === node.id ? e.target : e.source;
			const direction = e.source === node.id ? "out" : "in";
			return { edge: e, neighbor: nodesById.get(neighborId), direction };
		})
		.filter((r) => r.neighbor !== undefined);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
			<div className="mb-1 flex items-center gap-2">
				<span className="rounded bg-paper-3 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-ink-3">{node.label}</span>
				{node.isEntryPoint ? <span className="rounded bg-accent-soft px-1.5 py-0.5 text-2xs text-accent">entry point</span> : null}
				{node.isTest ? <span className="rounded bg-paper-3 px-1.5 py-0.5 text-2xs text-ink-3">test</span> : null}
			</div>
			<h2 className="break-words text-sm font-semibold text-ink">{node.name}</h2>
			{node.path ? <p className="mt-0.5 break-all font-mono text-2xs text-ink-3">{node.path}</p> : null}
			{(node.inDegree !== undefined || node.outDegree !== undefined) ? (
				<p className="mt-1 font-mono text-2xs text-ink-3">
					← {node.inDegree ?? 0} · {node.outDegree ?? 0} →
				</p>
			) : null}

			{node.kind === "symbol" && TRACE_ELIGIBLE_LABELS.has(node.label) ? (
				<div className="mt-3 flex items-center gap-2 rounded-md border border-line bg-paper-2 p-2">
					<Route className="h-3.5 w-3.5 shrink-0 text-ink-3" />
					<label className="text-2xs text-ink-3">
						Depth
						<input
							type="number"
							min={1}
							max={4}
							value={depth}
							onChange={(e) => setDepth(Math.min(4, Math.max(1, Number(e.target.value) || 1)))}
							className="ml-1.5 w-10 rounded border border-line bg-paper px-1 py-0.5 text-center font-mono text-2xs text-ink"
						/>
					</label>
					<Button size="sm" variant="outline" disabled={tracing} onClick={() => onTrace(node, depth)} className="ml-auto">
						{tracing ? <Loader2 className="h-3 w-3 animate-spin" /> : "Trace calls"}
					</Button>
				</div>
			) : null}
			{traceError ? <p className="mt-1 font-mono text-2xs text-danger">{traceError}</p> : null}

			{node.kind === "symbol" ? (
				<div className="mt-3">
					{detailLoading ? (
						<p className="flex items-center gap-1.5 text-xs text-ink-3">
							<Loader2 className="h-3.5 w-3.5 animate-spin" /> loading snippet…
						</p>
					) : detailError ? (
						<p className="font-mono text-2xs text-danger">{detailError}</p>
					) : detail?.source ? (
						<>
							{detail.startLine !== undefined ? (
								<p className="mb-1 font-mono text-2xs text-ink-3">
									{detail.filePath}:{detail.startLine}
									{detail.endLine !== undefined ? `-${detail.endLine}` : ""}
								</p>
							) : null}
							<pre className="max-h-72 overflow-auto whitespace-pre rounded-md border border-line bg-paper p-3 font-mono text-2xs leading-relaxed text-ink-2">
								{detail.source}
							</pre>
						</>
					) : null}
				</div>
			) : null}

			<div className="mt-4">
				<h3 className="meta mb-1.5">Relations ({relations.length})</h3>
				{relations.length === 0 ? (
					<p className="text-2xs text-ink-3">No connections currently loaded for this node.</p>
				) : (
					<ul className="space-y-0.5">
						{relations.map(({ edge, neighbor, direction }) => (
							<li key={edge.id}>
								<button
									type="button"
									onClick={() => neighbor && onPivot(neighbor)}
									className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-ink-2 transition-colors hover:bg-paper-3"
								>
									<span className={cn("font-mono text-2xs", direction === "out" ? "text-ink-3" : "text-accent")}>
										{direction === "out" ? "→" : "←"} {edge.kind}
									</span>
									<span className="truncate">{neighbor?.name}</span>
									{edge.hop !== undefined ? <span className="ml-auto shrink-0 font-mono text-2xs text-ink-4">hop {edge.hop}</span> : null}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
