import { useState } from "react";
import type { ToolRendererProps } from "./ToolCallCard";
import { extractResultDetails, extractResultText } from "./shared";
import { MaybeJsonBlock } from "@/lib/code";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { formatBytes, formatCost, formatDurationMs, formatTokens, truncate, cn, extractSubagentCost } from "@/lib/utils";
import { Modal } from "@/components/ui/Modal";

const STATUS_TONE: Record<string, string> = {
	pending: "text-ink-4",
	queued: "text-ink-4",
	running: "text-accent",
	completed: "text-success",
	complete: "text-success",
	failed: "text-danger",
	error: "text-danger",
	aborted: "text-warn",
};

type Progress = {
	id?: string;
	agent?: string;
	status?: string;
	task?: string;
	lastIntent?: string;
	currentTool?: string;
	toolCount?: number;
	tokens?: number;
	cost?: number;
	durationMs?: number;
	resolvedModel?: string;
	retryState?: { attempt?: number; maxAttempts?: number };
	retryFailure?: { errorMessage?: string };
};

type SubagentResult = {
	id?: string;
	agent?: string;
	exitCode?: number;
	output?: string;
	error?: string;
	aborted?: boolean;
	abortReason?: string;
	durationMs?: number;
	tokens?: number;
	usage?: { cost?: unknown };
	patchPath?: string;
	branchName?: string;
	branchBaseSha?: string;
	outputPath?: string;
};

type TaskDetails = { progress?: Progress[]; results?: SubagentResult[] };

export function TaskTool({ args, stream }: ToolRendererProps) {
	const [artifact, setArtifact] = useState<{ path?: string; branchName?: string; branchBaseSha?: string } | null>(null);
	const [patchContent, setPatchContent] = useState<{ content: string; sizeBytes: number; truncated: boolean } | null>(null);
	const [inspectError, setInspectError] = useState<string | null>(null);
	const cwd = useStore((s) => (s.activeId ? s.sessionsById[s.activeId]?.cwd : undefined));
	const finalResult = stream?.result;
	const liveResult = stream?.partialResult;
	const details = (extractResultDetails(finalResult) ?? extractResultDetails(liveResult)) as TaskDetails | undefined;
	const resultText = extractResultText(finalResult ?? liveResult);
	const tasks = taskArguments(args);
	const progress = Array.isArray(details?.progress) ? details.progress : [];
	const results = Array.isArray(details?.results) ? details.results : [];
	const count = results.length || progress.length || tasks.length;
	const failedMerge = /Patches were not applied|Branch merge failed/i.test(resultText);
	const appliedMerge = /Applied patches: yes|Merged branch:/i.test(resultText);

	async function inspect(next: { path?: string; branchName?: string; branchBaseSha?: string }): Promise<void> {
		setArtifact(next);
		setPatchContent(null);
		setInspectError(null);
		if (!next.path) return;
		try {
			const response = await api.getDelegationArtifact(next.path);
			setPatchContent(response);
		} catch (err) {
			setInspectError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<div className="space-y-2">
			<div className="font-mono text-2xs">
				<span className="text-accent">{String(args.agent ?? "task")}</span>
				<span className="text-ink-3"> · {count} subagent{count === 1 ? "" : "s"}</span>
			</div>
			{failedMerge ? (
				<div className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-2xs text-warn">Not applied — manual resolution required. Isolation artifacts were preserved.</div>
			) : appliedMerge ? (
				<div className="text-2xs text-success">Changes applied to workspace</div>
			) : null}
			{progress.length > 0 && !finalResult ? <ProgressRows progress={progress} /> : null}
			{results.length > 0 ? (
				<div className="space-y-2">
					{results.map((result, index) => (
						<ResultRow key={result.id ?? `${result.agent ?? "subagent"}-${index}`} result={result} cwd={cwd} onInspect={inspect} />
					))}
				</div>
			) : progress.length === 0 ? <ArgumentRows tasks={tasks} /> : null}
			{resultText ? (
				<details>
					<summary className="cursor-pointer font-mono text-2xs uppercase tracking-meta text-ink-3 hover:text-ink">findings</summary>
					<div className="mt-1"><MaybeJsonBlock text={resultText} /></div>
				</details>
			) : null}
			<ArtifactModal artifact={artifact} patchContent={patchContent} error={inspectError} onClose={() => setArtifact(null)} />
		</div>
	);
}

function ProgressRows({ progress }: { progress: Progress[] }) {
	return (
		<div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
			{progress.map((subagent, index) => {
				const status = subagent.status ?? "pending";
				return (
					<div key={subagent.id ?? `${subagent.agent ?? "subagent"}-${index}`} className="border-l border-line pl-2">
						<div className="flex items-baseline justify-between gap-2 font-mono text-2xs"><span className="truncate font-medium text-ink">{subagent.id ?? subagent.agent ?? "subagent"}</span><span className={cn("shrink-0", STATUS_TONE[status] ?? "text-ink-4")}>{status}</span></div>
						{subagent.agent ? <div className="mt-0.5 text-2xs text-ink-3">{subagent.agent}</div> : null}
						{subagent.lastIntent || subagent.currentTool ? <div className="mt-0.5 text-2xs text-ink-3">{truncate(subagent.lastIntent ?? `tool: ${subagent.currentTool}`, 120)}</div> : null}
						<div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-2xs text-ink-4"><span>{subagent.toolCount ?? 0} tools</span>{typeof subagent.tokens === "number" ? <span>{formatTokens(subagent.tokens)} tokens</span> : null}{typeof subagent.cost === "number" ? <span>{formatCost(subagent.cost)}</span> : null}{typeof subagent.durationMs === "number" ? <span>{formatDurationMs(subagent.durationMs)}</span> : null}{subagent.resolvedModel ? <span>{truncate(subagent.resolvedModel, 32)}</span> : null}</div>
						{subagent.retryState ? <div className="mt-1 text-2xs text-warn">retrying (attempt {subagent.retryState.attempt ?? "?"}/{subagent.retryState.maxAttempts ?? "?"})</div> : null}
						{subagent.retryFailure?.errorMessage ? <div className="mt-1 text-2xs text-danger">rate-limited: {truncate(subagent.retryFailure.errorMessage, 120)}</div> : null}
					</div>
				);
			})}
		</div>
	);
}

function ResultRow({ result, cwd, onInspect }: { result: SubagentResult; cwd?: string; onInspect: (artifact: { path?: string; branchName?: string; branchBaseSha?: string }) => Promise<void> }) {
	const [confirm, setConfirm] = useState<"apply" | "discard" | null>(null);
	const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
	const status = result.aborted ? "aborted" : result.error || (result.exitCode ?? 0) !== 0 ? "failed" : "completed";
	const id = result.id ?? result.agent ?? "subagent";
	const artifact = result.patchPath ? { patchPath: result.patchPath } : result.branchName ? { branchName: result.branchName, branchBaseSha: result.branchBaseSha } : null;
	const resultCost = extractSubagentCost(result.usage?.cost);
	function clearConfirmSoon(action: "apply" | "discard"): void {
		setConfirm(action);
		window.setTimeout(() => setConfirm((current) => (current === action ? null : current)), 3000);
	}

	async function act(action: "apply" | "discard"): Promise<void> {
		if (!artifact || !cwd) return;
		if (confirm !== action) {
			clearConfirmSoon(action);
			return;
		}
		setConfirm(null);
		try {
			const response = action === "apply"
				? await api.applyDelegationArtifact({ cwd, ...artifact })
				: await api.discardDelegationArtifact({ cwd, ...artifact });
			setMessage({ ok: response.ok, text: response.message });
		} catch (err) {
			setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
		}
	}

	return (
		<div className="border-l border-line pl-2">
			<div className="flex items-baseline justify-between gap-2 font-mono text-2xs"><span className="truncate font-medium text-ink">{id}</span><span className={cn("shrink-0", STATUS_TONE[status])}>{status}</span></div>
			{result.agent ? <div className="mt-0.5 text-2xs text-ink-3">{result.agent}</div> : null}
		<div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-2xs text-ink-4">{typeof result.durationMs === "number" ? <span>{formatDurationMs(result.durationMs)}</span> : null}{typeof result.tokens === "number" ? <span>{formatTokens(result.tokens)} tokens</span> : null}{typeof resultCost === "number" ? <span>{formatCost(resultCost)}</span> : null}</div>
			{result.error || result.abortReason ? <details className="mt-1 text-2xs text-danger"><summary className="cursor-pointer">error details</summary><div className="mt-1 whitespace-pre-wrap">{truncate(result.error ?? result.abortReason ?? "", 200)}</div></details> : null}
			{result.output ? <details className="mt-1 text-2xs text-ink-3"><summary className="cursor-pointer">output</summary><div className="mt-1 whitespace-pre-wrap">{truncate(result.output, 800)}</div></details> : null}
			{artifact ? (
				<div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs">
					<span className="rounded bg-paper-3 px-1.5 py-0.5 font-mono text-ink-2" title={result.patchPath ?? result.branchName}>{result.patchPath ? `patch · ${result.patchPath.split("/").pop()}` : `branch · ${result.branchName}`}{result.branchBaseSha ? ` · ${result.branchBaseSha.slice(0, 8)}` : ""}</span>
					<button type="button" onClick={() => void onInspect(result.patchPath ? { path: result.patchPath } : { branchName: result.branchName, branchBaseSha: result.branchBaseSha })} className="text-accent hover:underline">Inspect</button>
					<button type="button" disabled={!cwd} onClick={() => void act("apply")} className="text-success hover:underline disabled:text-ink-4">{confirm === "apply" ? "Confirm apply?" : result.patchPath ? "Apply" : "Apply (merge)"}</button>
					<button type="button" disabled={!cwd} onClick={() => void act("discard")} className="text-danger hover:underline disabled:text-ink-4">{confirm === "discard" ? "Confirm discard?" : "Discard"}</button>
				</div>
			) : null}
			{message ? <div className={cn("mt-1 text-2xs", message.ok ? "text-success" : "text-danger")}>{message.text}</div> : null}
		</div>
	);
}

function ArgumentRows({ tasks }: { tasks: Array<Record<string, unknown>> }) {
	return (
		<div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
			{tasks.map((task, index) => <div key={String(task.id ?? `task-${index}`)} className="border-l border-line pl-2"><div className="flex items-baseline justify-between gap-2 font-mono text-2xs"><span className="truncate font-medium text-ink">{String(task.id ?? `task-${index}`)}</span><span className="text-ink-4">queued</span></div>{task.description ? <div className="mt-0.5 text-2xs text-ink-3">{truncate(String(task.description), 100)}</div> : null}</div>)}
		</div>
	);
}

function ArtifactModal({ artifact, patchContent, error, onClose }: { artifact: { path?: string; branchName?: string; branchBaseSha?: string } | null; patchContent: { content: string; sizeBytes: number; truncated: boolean } | null; error: string | null; onClose: () => void }) {
	return (
		<Modal open={artifact !== null} onClose={onClose} widthClass="max-w-4xl">
			<div className="flex items-center justify-between border-b border-line px-4 py-3"><div className="font-mono text-xs text-ink">{artifact?.path ? `Patch · ${artifact.path}` : `Branch · ${artifact?.branchName ?? ""}`}</div><button type="button" onClick={onClose} className="text-xs text-ink-3 hover:text-ink">Close</button></div>
			<div className="min-h-0 overflow-auto p-4">{artifact?.path ? error ? <div className="text-sm text-danger">{error}</div> : patchContent ? <><div className="mb-2 text-2xs text-ink-3">{formatBytes(patchContent.sizeBytes)}{patchContent.truncated ? " · showing first 512 KB" : ""}</div><pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-paper-2 p-3 font-mono text-2xs text-ink">{patchContent.content}</pre></> : <div className="text-sm text-ink-3">Loading patch…</div> : <div className="space-y-2 text-sm text-ink-2"><p>Branch artifact preserved for inspection and explicit merge.</p><dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-2xs"><dt className="text-ink-3">branch</dt><dd>{artifact?.branchName}</dd>{artifact?.branchBaseSha ? <><dt className="text-ink-3">base</dt><dd>{artifact.branchBaseSha}</dd></> : null}</dl></div>}</div>
		</Modal>
	);
}

function taskArguments(args: Record<string, unknown>): Array<Record<string, unknown>> {
	if (Array.isArray(args.tasks)) return args.tasks.filter((task): task is Record<string, unknown> => !!task && typeof task === "object");
	if (typeof args.assignment === "string") return [{ id: args.id, description: args.description, assignment: args.assignment }];
	return [];
}
