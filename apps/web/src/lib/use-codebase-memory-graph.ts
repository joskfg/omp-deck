import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CodebaseMemoryOverview } from "@omp-deck/protocol";

import {
	ROOT_NODE_ID,
	TRACE_ELIGIBLE_LABELS,
	fetchAllFolders,
	fetchFileSymbols,
	fetchFolderChildren,
	fetchProjectRoot,
	fetchSchema,
	fetchSnippet,
	resolveProject,
	rootNode,
	searchByLabel,
	searchByQuery,
	traceCalls,
	type CmEdge,
	type CmNode,
	type CmNodeDetail,
	type CmProjectRef,
	type CmSchema,
} from "./codebase-memory-graph";

const FILE_CAP = 300;
const FILE_SYMBOL_LIMIT = 150;
const TYPE_FILTER_LIMIT = 80;
const SEARCH_LIMIT = 40;

/**
 * Owns all graph/detail/search state for the Codebase Memory explorer view
 * (T-133). One instance per selected workspace — `CodebaseMemoryView` resets
 * it (via the `cwd` key) whenever the user switches projects.
 *
 * Nodes/edges accumulate as the user expands folders/files or traces calls —
 * `Map`/`Set` because membership grows and shrinks at runtime (project
 * switch clears everything; "reset to project map" prunes back to level 0).
 */
export function useCodebaseMemoryGraph(cwd: string | undefined, overview: CodebaseMemoryOverview | undefined) {
	const [project, setProject] = useState<CmProjectRef>();
	const [schema, setSchema] = useState<CmSchema>();
	const [nodes, setNodes] = useState<Map<string, CmNode>>(new Map());
	const [edges, setEdges] = useState<Map<string, CmEdge>>(new Map());
	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
	const [rootLoading, setRootLoading] = useState(false);
	const [rootError, setRootError] = useState<string>();
	const [truncated, setTruncated] = useState(false);
	const [expandingId, setExpandingId] = useState<string>();

	const [selectedId, setSelectedId] = useState<string>();
	const [detail, setDetail] = useState<CmNodeDetail>();
	const [detailLoading, setDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState<string>();
	const [tracing, setTracing] = useState(false);
	const [traceError, setTraceError] = useState<string>();

	const [resultLabel, setResultLabel] = useState<string>();
	const [searchQuery, setSearchQuery] = useState("");
	const [results, setResults] = useState<CmNode[]>([]);
	const [resultsLoading, setResultsLoading] = useState(false);
	const [resultsError, setResultsError] = useState<string>();

	const allFoldersRef = useRef<CmNode[]>([]);
	const detailVersionRef = useRef(0);
	const resultsVersionRef = useRef(0);

	const mergeLevel = useCallback((level: { nodes: CmNode[]; edges: CmEdge[]; truncated: boolean }) => {
		setNodes((prev) => {
			const next = new Map(prev);
			for (const n of level.nodes) next.set(n.id, n);
			return next;
		});
		setEdges((prev) => {
			const next = new Map(prev);
			for (const e of level.edges) next.set(e.id, e);
			return next;
		});
		if (level.truncated) setTruncated(true);
	}, []);

	const resetGraph = useCallback((projectName: string) => {
		detailVersionRef.current++;
		resultsVersionRef.current++;
		const root = rootNode(projectName);
		setNodes(new Map([[root.id, root]]));
		setEdges(new Map());
		setExpandedIds(new Set());
		setTruncated(false);
		setSelectedId(undefined);
		setDetail(undefined);
		setDetailLoading(false);
		setDetailError(undefined);
		setResults([]);
		setResultsLoading(false);
		setResultsError(undefined);
		setResultLabel(undefined);
		setSearchQuery("");
	}, []);
	// Project resolution + the level-0 project map. Re-runs whenever the
	// selected workspace or its MCP overview changes (cwd switch, index run).
	useEffect(() => {
		if (!cwd) return;
		const ref = resolveProject(overview, cwd);
		setProject(ref);
		setSchema(undefined);
		if (!ref.indexed || !ref.project) {
			setNodes(new Map());
			setEdges(new Map());
			return;
		}
		let cancelled = false;
		const projectName = ref.project;
		resetGraph(projectName);
		setRootLoading(true);
		setRootError(undefined);
		(async () => {
			const [schemaRes, folders] = await Promise.all([fetchSchema(cwd, projectName), fetchAllFolders(cwd, projectName)]);
			if (cancelled) return;
			allFoldersRef.current = folders;
			setSchema(schemaRes);
			const level = await fetchProjectRoot(cwd, projectName, folders, FILE_CAP);
			if (cancelled) return;
			mergeLevel(level);
			setExpandedIds(new Set([ROOT_NODE_ID]));
		})()
			.catch((cause) => {
				if (!cancelled) setRootError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!cancelled) setRootLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [cwd, overview, mergeLevel, resetGraph]);

	const expand = useCallback(
		async (node: CmNode) => {
			if (!cwd || !project?.project || expandedIds.has(node.id) || !node.expandable) return;
			setExpandingId(node.id);
			try {
				if (node.kind === "folder" && node.path !== undefined) {
					const level = await fetchFolderChildren(cwd, project.project, node.path, allFoldersRef.current, FILE_CAP);
					mergeLevel(level);
				} else if (node.kind === "file" && node.path !== undefined) {
					const level = await fetchFileSymbols(cwd, project.project, node.path, FILE_SYMBOL_LIMIT);
					mergeLevel(level);
				}
				setExpandedIds((prev) => new Set(prev).add(node.id));
			} catch (cause) {
				setRootError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setExpandingId(undefined);
			}
		},
		[cwd, project, expandedIds, mergeLevel],
	);

	const select = useCallback(
		(node: CmNode) => {
			const detailVersion = ++detailVersionRef.current;
			setNodes((prev) => (prev.has(node.id) ? prev : new Map(prev).set(node.id, node)));
			setSelectedId(node.id);
			setDetail(undefined);
			setDetailLoading(false);
			setDetailError(undefined);
			setTraceError(undefined);
			if (node.kind !== "symbol" || !cwd || !project?.project || !node.qualifiedName) return;
			setDetailLoading(true);
			fetchSnippet(cwd, project.project, node.qualifiedName)
				.then((nextDetail) => {
					if (detailVersion === detailVersionRef.current) setDetail(nextDetail);
				})
				.catch((cause) => {
					if (detailVersion === detailVersionRef.current) setDetailError(cause instanceof Error ? cause.message : String(cause));
				})
				.finally(() => {
					if (detailVersion === detailVersionRef.current) setDetailLoading(false);
				});
		},
		[cwd, project],
	);

	const filterByType = useCallback(
		async (label: string) => {
			if (!cwd || !project?.project) return;
			const resultsVersion = ++resultsVersionRef.current;
			setResultLabel(label);
			setSearchQuery("");
			setResultsLoading(true);
			setResultsError(undefined);
			try {
				const nextResults = await searchByLabel(cwd, project.project, label, TYPE_FILTER_LIMIT);
				if (resultsVersion === resultsVersionRef.current) setResults(nextResults);
			} catch (cause) {
				if (resultsVersion === resultsVersionRef.current) setResultsError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (resultsVersion === resultsVersionRef.current) setResultsLoading(false);
			}
		},
		[cwd, project],
	);

	const clearResults = useCallback(() => {
		resultsVersionRef.current++;
		setResultLabel(undefined);
		setSearchQuery("");
		setResults([]);
		setResultsLoading(false);
		setResultsError(undefined);
	}, []);

	const search = useCallback(
		async (query: string) => {
			if (!cwd || !project?.project) return;
			const resultsVersion = ++resultsVersionRef.current;
			setSearchQuery(query);
			setResultLabel(undefined);
			if (!query.trim()) {
				setResults([]);
				setResultsLoading(false);
				setResultsError(undefined);
				return;
			}
			setResultsLoading(true);
			setResultsError(undefined);
			try {
				const nextResults = await searchByQuery(cwd, project.project, query, SEARCH_LIMIT);
				if (resultsVersion === resultsVersionRef.current) setResults(nextResults);
			} catch (cause) {
				if (resultsVersion === resultsVersionRef.current) setResultsError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (resultsVersion === resultsVersionRef.current) setResultsLoading(false);
			}
		},
		[cwd, project],
	);

	const traceDepth = useCallback(
		async (node: CmNode, depth: number) => {
			if (!cwd || !project?.project || !TRACE_ELIGIBLE_LABELS.has(node.label)) return;
			setTracing(true);
			setTraceError(undefined);
			try {
				const trace = await traceCalls(cwd, project.project, node.name, node.id, depth);
				mergeLevel({ nodes: [node, ...trace.nodes], edges: trace.edges, truncated: false });
			} catch (cause) {
				setTraceError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setTracing(false);
			}
		},
		[cwd, project, mergeLevel],
	);

	const resetToProjectMap = useCallback(() => {
		if (!cwd || !project?.project) return;
		resetGraph(project.project);
		setRootLoading(true);
		setRootError(undefined);
		fetchProjectRoot(cwd, project.project, allFoldersRef.current, FILE_CAP)
			.then((level) => {
				mergeLevel(level);
				setExpandedIds(new Set([ROOT_NODE_ID]));
			})
			.catch((cause) => setRootError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setRootLoading(false));
	}, [cwd, project, mergeLevel, resetGraph]);

	const selectedNode = selectedId ? nodes.get(selectedId) : undefined;
	const nodeList = useMemo(() => Array.from(nodes.values()), [nodes]);
	const edgeList = useMemo(() => Array.from(edges.values()), [edges]);

	return {
		project,
		schema,
		nodes: nodeList,
		edges: edgeList,
		expandedIds,
		expandingId,
		rootLoading,
		rootError,
		truncated,
		expand,
		select,
		selectedNode,
		detail,
		detailLoading,
		detailError,
		tracing,
		traceError,
		traceDepth,
		resultLabel,
		searchQuery,
		results,
		resultsLoading,
		resultsError,
		filterByType,
		clearResults,
		search,
		resetToProjectMap,
	};
}
