/**
 * Auto-Work Monitor (feat/autowork-monitor-panel).
 *
 * Two-pane layout:
 *   Left  — run list sorted by startedAt desc; active runs pinned to the top.
 *   Right — detail pane for the selected run: task info, metrics,
 *            session link, and a live transcript preview for running sessions.
 *
 * Real-time updates: `autoWorkRunsChangeCounter` bumps on every lifecycle
 * event (start / complete / fail / timeout) via the `auto_work_runs_changed`
 * WS broadcast.  `tasksChangeCounter` is also watched since the engine moves
 * tasks between states as runs progress.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	Activity,
	AlertTriangle,
	ArrowUpRight,
	BotMessageSquare,
	CheckCircle2,
	CircleDashed,
	Clock,
	ExternalLink,
	GitPullRequest,
	Play,
	RefreshCw,
	XCircle,
	Zap,
} from "lucide-react";
import type { AutoWorkRun, AutoWorkRunStatus, AutoWorkScheduleStatus, Task } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatBriefTime } from "@/lib/time";
import { usePersistedViewState } from "@/lib/use-persisted-view-state";
import type { AssistantMsg, TextBlock } from "@/lib/types";

// ─── helpers ────────────────────────────────────────────────────────────────

const PRIORITY_COLOR: Record<string, string> = {
	P0: "bg-red-500/20 text-red-400",
	P1: "bg-orange-500/20 text-orange-400",
	P2: "bg-yellow-500/20 text-yellow-400",
	P3: "bg-blue-500/20 text-blue-400",
	P4: "bg-ink-3/20 text-ink-3",
	P5: "bg-ink-3/20 text-ink-3",
};

function StatusIcon({ status }: { status: AutoWorkRunStatus }) {
	switch (status) {
		case "running":
			return <Activity className="h-3.5 w-3.5 animate-pulse text-green-400" />;
		case "completed":
			return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
		case "completed_pending_merge":
			return <Clock className="h-3.5 w-3.5 animate-pulse text-blue-400" />;
		case "completed_pr_failed":
			return <AlertTriangle className="h-3.5 w-3.5 text-yellow-400" />;
		case "failed":
			return <XCircle className="h-3.5 w-3.5 text-red-400" />;
		case "timed_out":
			return <Clock className="h-3.5 w-3.5 text-yellow-400" />;
	}
}

function StatusBadge({ status }: { status: AutoWorkRunStatus }) {
	const variants: Record<AutoWorkRunStatus, string> = {
		running: "bg-green-500/15 text-green-400",
		completed: "bg-green-500/10 text-green-500",
		completed_pending_merge: "bg-blue-500/15 text-blue-400",
		completed_pr_failed: "bg-yellow-500/15 text-yellow-400",
		failed: "bg-red-500/15 text-red-400",
		timed_out: "bg-yellow-500/15 text-yellow-400",
	};
	const labels: Record<AutoWorkRunStatus, string> = {
		running: "Running",
		completed: "Completed",
		completed_pending_merge: "Merging",
		completed_pr_failed: "PR failed",
		failed: "Failed",
		timed_out: "Timed out",
	};
	return (
		<span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium", variants[status])}>
			<StatusIcon status={status} />
			{labels[status]}
		</span>
	);
}

function elapsed(startedAt: string, completedAt: string | null): string {
	const start = new Date(startedAt).getTime();
	const end = completedAt ? new Date(completedAt).getTime() : Date.now();
	const ms = end - start;
	if (ms < 0) return "—";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return `${m}m ${rem}s`;
}

function branchFromWorktree(worktreePath: string): string {
	// .worktrees/aw-T12-some-slug → aw-T12-some-slug
	const parts = worktreePath.split(/[\\/]/);
	return parts[parts.length - 1] ?? worktreePath;
}

// ─── Run row ────────────────────────────────────────────────────────────────

interface RunRowProps {
	run: AutoWorkRun;
	task: Task | undefined;
	selected: boolean;
	onSelect(): void;
}

function RunRow({ run, task, selected, onSelect }: RunRowProps) {
	const title = task ? `T-${task.displayId}: ${task.title}` : run.taskId;
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"w-full rounded-md px-3 py-2.5 text-left transition-colors",
				selected ? "bg-accent-soft/30 ring-1 ring-accent/30" : "hover:bg-paper-3",
			)}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<p className="truncate text-sm font-medium text-ink">{title}</p>
					<div className="mt-1 flex flex-wrap items-center gap-1.5">
						<StatusBadge status={run.status} />
						{task && (
							<span
								className={cn(
									"rounded px-1.5 py-0.5 text-xs font-medium",
									PRIORITY_COLOR[task.priority] ?? PRIORITY_COLOR["P5"],
								)}
							>
								{task.priority}
							</span>
						)}
					</div>
				</div>
				<div className="shrink-0 text-right">
					<p className="text-xs text-ink-3">{formatBriefTime(run.startedAt)}</p>
					{run.status === "running" && (
						<p className="mt-0.5 text-xs text-green-400 tabular-nums">
							{elapsed(run.startedAt, null)}
						</p>
					)}
				</div>
			</div>
		</button>
	);
}

// ─── Detail pane ────────────────────────────────────────────────────────────

interface DetailPaneProps {
	run: AutoWorkRun;
	task: Task | undefined;
	onRefresh: () => void;
}

function DetailPane({ run, task, onRefresh }: DetailPaneProps) {
	const navigate = useNavigate();
	const watchSession = useStore((s) => s.watchSession);
	const sessionData = useStore((s) => s.sessionsById[run.sessionId]);
	const [elapsedStr, setElapsedStr] = useState(() => elapsed(run.startedAt, run.completedAt));
	const [retrying, setRetrying] = useState(false);
	const [retryError, setRetryError] = useState<string | undefined>();
	const msgsEndRef = useRef<HTMLDivElement>(null);

	// Retain this live session only while its detail pane is mounted.
	useEffect(() => {
		if (run.status !== "running") return;
		return watchSession(run.sessionId);
	}, [run.sessionId, run.status, watchSession]);

	// Tick elapsed timer for running sessions
	useEffect(() => {
		if (run.status !== "running") return;
		const id = setInterval(() => {
			setElapsedStr(elapsed(run.startedAt, null));
		}, 1000);
		return () => clearInterval(id);
	}, [run.status, run.startedAt]);

	// Auto-scroll messages
	useEffect(() => {
		msgsEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [sessionData?.messages.length]);

	// Extract displayable text from the session message list
	const textMessages = useMemo(() => {
		if (!sessionData) return [];
		return sessionData.messages
			.filter((m): m is AssistantMsg => m.role === "assistant")
			.map((m) => ({
				id: m.id,
				text: m.blocks
					.filter((b): b is TextBlock => b.type === "text")
					.map((b) => b.text)
					.join(""),
				isStreaming: m.isStreaming,
			}))
			.filter((m) => m.text.trim().length > 0)
			.slice(-20); // last 20 text messages
	}, [sessionData]);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* Header */}
			<div className="border-b border-line px-4 py-3">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<p className="text-xs font-medium uppercase tracking-wide text-ink-3">
							{task ? `T-${task.displayId}` : run.taskId.slice(0, 8)}
						</p>
						<p className="mt-0.5 truncate text-sm font-semibold text-ink">
							{task?.title ?? run.taskId}
						</p>
					</div>
					<StatusBadge status={run.status} />
				</div>
			</div>

			{/* Metrics grid */}
			<div className="grid grid-cols-2 gap-px border-b border-line bg-line">
				{[
					{
						label: "Priority",
						value: task ? (
							<span className={cn("rounded px-1 py-0.5 text-xs font-medium", PRIORITY_COLOR[task.priority] ?? PRIORITY_COLOR["P5"])}>
								{task.priority}
							</span>
						) : "—",
					},
					{
						label: run.status === "running" ? "Elapsed" : "Duration",
						value: <span className="tabular-nums">{elapsedStr}</span>,
					},
					{
						label: "Cost",
						value: run.pctConsumed !== null
							? <span className="tabular-nums">{run.pctConsumed.toFixed(1)}%</span>
							: run.status === "running" ? <span className="text-ink-3">—</span> : "—",
					},
					{
						label: "Tokens",
						value: run.inputTokens !== null && run.outputTokens !== null
							? (
								<span className="tabular-nums text-xs">
									{(run.inputTokens / 1000).toFixed(0)}k in / {(run.outputTokens / 1000).toFixed(0)}k out
								</span>
							)
							: <span className="text-ink-3">—</span>,
					},
					{
						label: "Started",
						value: <span className="tabular-nums">{new Date(run.startedAt).toLocaleTimeString()}</span>,
					},
					{
						label: "Branch",
						value: (
							<span className="truncate font-mono text-xs text-ink-3" title={run.worktreePath}>
								{branchFromWorktree(run.worktreePath)}
							</span>
						),
					},
				].map(({ label, value }) => (
					<div key={label} className="bg-paper px-3 py-2">
						<p className="text-xs text-ink-3">{label}</p>
						<div className="mt-0.5 text-sm text-ink">{value}</div>
					</div>
				))}
			</div>

			{/* Failure reason */}
			{run.failureReason && (
				<div className="border-b border-line bg-red-500/5 px-4 py-2">
					<p className="text-xs font-medium text-red-400">Reason</p>
					<p className="mt-0.5 text-xs text-ink-2">{run.failureReason}</p>
				</div>
			)}

			{/* Session link */}
			<div className="border-b border-line px-4 py-2.5">
				<p className="text-xs text-ink-3">Session</p>
				<div className="mt-1 flex items-center justify-between gap-2">
					<span className="font-mono text-xs text-ink-3">{run.sessionId.slice(0, 8)}…</span>
					<button
						type="button"
						onClick={() => navigate(`/c/${run.sessionId}`)}
						className="inline-flex items-center gap-1.5 rounded bg-accent-soft/20 px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent-soft/40"
					>
						<ExternalLink className="h-3 w-3" />
						Open in chat
					</button>
				</div>
			</div>

			{/* PR retry — shown when the run's PR creation failed (T-85 distinct
			    status), or, for pre-T-85 historical rows, a completed run whose
			    task body still carries the old inline failure note. */}
			{(run.status === "completed_pr_failed" || (run.status === "completed" && task?.body?.includes("PR creation failed"))) && (
				<div className="border-b border-line px-4 py-2.5">
					<div className="flex items-center justify-between gap-2">
						<p className="text-xs text-ink-3">PR</p>
						<button
							type="button"
							disabled={retrying}
							onClick={() => {
								setRetrying(true);
								setRetryError(undefined);
								api.retryAutoWorkRunPr(run.id)
									.then(() => onRefresh())
									.catch((e: unknown) => setRetryError(e instanceof Error ? e.message : String(e)))
									.finally(() => setRetrying(false));
							}}
							className="inline-flex items-center gap-1.5 rounded bg-accent-soft/20 px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent-soft/40 disabled:pointer-events-none disabled:opacity-40"
						>
							{retrying
								? <RefreshCw className="h-3 w-3 animate-spin" />
								: <GitPullRequest className="h-3 w-3" />}
							{retrying ? "Creating PR…" : "Retry PR creation"}
						</button>
					</div>
					{retryError && (
						<p className="mt-1 text-xs text-red-400">{retryError}</p>
					)}
				</div>
			)}

			{/* Live session transcript */}
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex items-center gap-1.5 border-b border-line px-4 py-2">
					<BotMessageSquare className="h-3.5 w-3.5 text-ink-3" />
					<span className="text-xs font-medium text-ink-3">Session activity</span>
					{run.status === "running" && sessionData?.status === "streaming" && (
						<span className="ml-auto flex items-center gap-1 text-xs text-green-400">
							<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" />
							Live
						</span>
					)}
				</div>

				{run.status !== "running" && !sessionData ? (
					<div className="flex flex-1 items-center justify-center text-xs text-ink-3">
						<div className="text-center">
							<CircleDashed className="mx-auto mb-2 h-8 w-8 opacity-30" />
							<p>Session not loaded</p>
							<button
								type="button"
								onClick={() => navigate(`/c/${run.sessionId}`)}
								className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
							>
								<ArrowUpRight className="h-3 w-3" />
								Open in chat to view
							</button>
						</div>
					</div>
				) : textMessages.length === 0 && run.status === "running" ? (
					<div className="flex flex-1 items-center justify-center text-xs text-ink-3">
						<div className="text-center">
							<Activity className="mx-auto mb-2 h-6 w-6 animate-pulse opacity-50" />
							<p>Waiting for agent response…</p>
						</div>
					</div>
				) : (
					<div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
						{textMessages.map((m) => (
							<div key={m.id} className="text-sm text-ink-2">
								<p className={cn("whitespace-pre-wrap leading-relaxed", m.isStreaming && "after:inline-block after:h-3.5 after:w-0.5 after:animate-pulse after:bg-current after:align-middle after:content-['']")}>
									{m.text.slice(0, 800)}
									{m.text.length > 800 ? "…" : ""}
								</p>
							</div>
						))}
						<div ref={msgsEndRef} />
					</div>
				)}
			</div>
		</div>
	);
}

// ─── Main view ──────────────────────────────────────────────────────────────

export function AutoWorkView() {
	const autoWorkRunsChangeCounter = useStore((s) => s.autoWorkRunsChangeCounter);
	const workspaces = useStore((s) => s.workspaces);

	// Workspace filter — controls which runs are visible in the left panel.
	const [selectedCwd, setSelectedCwd] = usePersistedViewState("autowork.workspace", "");
	// All runs + full task map (fetched globally, then filtered per workspace).
	const [allRuns, setAllRuns] = useState<AutoWorkRun[]>([]);
	const [taskMap, setTaskMap] = useState<Record<string, Task>>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
	// Global schedule state.
	const [scheduleStatus, setScheduleStatus] = useState<AutoWorkScheduleStatus | null>(null);
	const [triggering, setTriggering] = useState(false);


	const refreshScheduleStatus = useCallback(async (): Promise<void> => {
		try {
			const status = await api.getAutoWorkScheduleStatus();
			setScheduleStatus(status);
		} catch { /* non-critical */ }
	}, []);


	const refresh = useCallback(async (): Promise<void> => {
		try {
			const [runsRes, tasksRes] = await Promise.all([
				api.listAutoWorkRuns({ limit: 200 }),
				api.listTasks(),
			]);
			const sorted = runsRes.runs.slice().sort((a, b) => {
				if (a.status === "running" && b.status !== "running") return -1;
				if (a.status !== "running" && b.status === "running") return 1;
				return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
			});
			setAllRuns(sorted);
			const map: Record<string, Task> = {};
			for (const t of tasksRes.tasks) map[t.id] = t;
			setTaskMap(map);
			setError(undefined);
			setSelectedRunId((prev) => prev ?? sorted[0]?.id);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => { void refresh(); }, [refresh, autoWorkRunsChangeCounter]);
	useEffect(() => { void refreshScheduleStatus(); }, [refreshScheduleStatus, autoWorkRunsChangeCounter]);

	// Runs visible in the left panel: filtered by selected workspace.
	const visibleRuns = useMemo(
		() => allRuns.filter((r) => !selectedCwd || taskMap[r.taskId]?.cwd === selectedCwd),
		[allRuns, taskMap, selectedCwd],
	);

	const activeRuns = visibleRuns.filter((r) => r.status === "running");
	const historyRuns = visibleRuns.filter((r) => r.status !== "running");
	const anyRunning = allRuns.some((r) => r.status === "running");

	const selectedRun = useMemo(
		() => visibleRuns.find((r) => r.id === selectedRunId),
		[visibleRuns, selectedRunId],
	);

	const handleTrigger = (): void => {
		if (triggering) return;
		setTriggering(true);
		api.triggerAutoWork()
			.then(() => Promise.all([refreshScheduleStatus(), refresh()]))
			.catch(() => { /* errors visible via status */ })
			.finally(() => { setTriggering(false); });
	};


	const lastTriggerLabel = scheduleStatus?.lastTriggeredAt
		? formatBriefTime(scheduleStatus.lastTriggeredAt)
		: "Never";
	const lastOutcomeLabel = scheduleStatus?.lastOutcome
		? scheduleStatus.lastOutcome.outcome === "skipped"
			? `Skipped — ${scheduleStatus.lastOutcome.reason.slice(0, 70)}`
			: scheduleStatus.lastOutcome.outcome
		: null;

	const content = (
		<div className="flex h-full overflow-hidden">

			{/* Left: global controls + filtered run list */}
			<div className="flex w-80 shrink-0 flex-col overflow-hidden border-r border-line">

				<div className="flex items-center justify-between border-b border-line px-4 py-3">
					<div className="flex items-center gap-2">
						<BotMessageSquare className="h-4 w-4 text-ink-3" />
						<h2 className="text-sm font-semibold text-ink">Auto Work</h2>
					</div>
					<button
						type="button"
						onClick={() => void refresh()}
						className="rounded p-1 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"
						title="Refresh"
					>
						<RefreshCw className="h-3.5 w-3.5" />
					</button>
				</div>

				{/* Global controls */}
				<div className="space-y-2 border-b border-line bg-paper-2 px-3 py-3">
					{/* Workspace filter (only when multiple workspaces) */}
					{workspaces.length > 1 && (
						<select
							value={selectedCwd}
							onChange={(e) => setSelectedCwd(e.target.value)}
							className="w-full rounded border border-line bg-paper px-2 py-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent/50"
						>
							<option value="">All workspaces</option>
							{workspaces.map((ws) => (
								<option key={ws.cwd} value={ws.cwd}>
									{ws.cwd.split("/").pop() ?? ws.cwd}
								</option>
							))}
						</select>
					)}

					{/* Status + trigger */}
					<div className="flex items-center justify-between gap-2">
						<div className="min-w-0 text-xs">
							{anyRunning ? (
								<span className="flex items-center gap-1 text-green-400">
									<Activity className="h-3 w-3 animate-pulse" />
									Running
								</span>
							) : (
								<span className="text-ink-3">
									Last: <span className="text-ink-2">{lastTriggerLabel}</span>
								</span>
							)}
						</div>
						<button
							type="button"
							disabled={triggering || anyRunning}
							onClick={handleTrigger}
							className="inline-flex items-center gap-1.5 rounded bg-accent/15 px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/25 disabled:pointer-events-none disabled:opacity-40"
						>
							{triggering ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
							Trigger
						</button>
					</div>

					{/* Last outcome */}
					{lastOutcomeLabel && !anyRunning && (
						<p className="truncate text-xs text-ink-3" title={lastOutcomeLabel}>
							{lastOutcomeLabel}
						</p>
					)}


					{/* Eligible workspaces hint */}
					{scheduleStatus !== null && scheduleStatus.eligibleWorkspaceCount > 0 && (
						<p className="flex items-center gap-1.5 text-xs text-ink-3">
							{scheduleStatus.eligibleWorkspaceCount} workspace{scheduleStatus.eligibleWorkspaceCount > 1 ? "s" : ""} with eligible tasks
							{scheduleStatus.squeezeEnabled && (
								<span className="inline-flex items-center gap-0.5 rounded bg-accent/15 px-1 py-0.5 text-2xs font-medium text-accent" title="Squeeze mode is active">
									<Zap className="h-2.5 w-2.5" />
									squeeze
								</span>
							)}
						</p>
					)}
				</div>

				{/* Run list (filtered by selectedCwd) */}
				<div className="flex-1 space-y-4 overflow-y-auto p-2">
					{loading && (
						<div className="flex items-center justify-center py-8 text-xs text-ink-3">Loading…</div>
					)}
					{!loading && error && (
						<div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
					)}
					{!loading && !error && visibleRuns.length === 0 && (
						<div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
							<CircleDashed className="h-8 w-8 text-ink-3 opacity-40" />
							<p className="text-xs text-ink-3">No runs yet</p>
							<p className="text-xs text-ink-3 opacity-70">Trigger manually or enable the schedule</p>
						</div>
					)}
					{activeRuns.length > 0 && (
						<div>
							<p className="mb-1.5 px-1 text-xs font-medium uppercase tracking-wide text-green-400">
								Active ({activeRuns.length})
							</p>
							<div className="space-y-1">
								{activeRuns.map((run) => (
									<RunRow key={run.id} run={run} task={taskMap[run.taskId]} selected={selectedRunId === run.id} onSelect={() => setSelectedRunId(run.id)} />
								))}
							</div>
						</div>
					)}
					{historyRuns.length > 0 && (
						<div>
							<p className="mb-1.5 px-1 text-xs font-medium uppercase tracking-wide text-ink-3">
								History ({historyRuns.length})
							</p>
							<div className="space-y-1">
								{historyRuns.map((run) => (
									<RunRow key={run.id} run={run} task={taskMap[run.taskId]} selected={selectedRunId === run.id} onSelect={() => setSelectedRunId(run.id)} />
								))}
							</div>
						</div>
					)}
				</div>
			</div>

			{/* Right: selected run detail. */}
			<div className="min-w-0 flex-1 overflow-hidden">
				{selectedRun ? (
				<DetailPane run={selectedRun} task={taskMap[selectedRun.taskId]} onRefresh={refresh} />
				) : (
					<EmptyDetailPane />
				)}
			</div>
		</div>
	);

	return <Layout sidebar={<Sidebar />} main={content} inspector={<div />} />;
}

function EmptyDetailPane() {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 text-center text-ink-3">
			<BotMessageSquare className="h-10 w-10 opacity-30" />
			<p className="text-sm">Select an Auto Work run</p>
			<p className="text-xs opacity-60">Choose a run to inspect its task, session, and lifecycle details.</p>
		</div>
	);
}
