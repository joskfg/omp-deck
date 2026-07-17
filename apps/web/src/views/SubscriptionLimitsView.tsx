import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, FolderGit2, RefreshCw } from "lucide-react";
import type {
	AggregatedStatsResponse,
	HistoricalModelStats,
	OmpStatsRange,
	SessionDrillDownLink,
	SessionUsageSummary,
	SpendSummaryResponse,
	SubscriptionUsageResponse,
} from "@omp-deck/protocol";
import { useNavigate } from "react-router-dom";

import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { api } from "@/lib/api";
import { cn, formatCost } from "@/lib/utils";
import { usePersistedViewState } from "@/lib/use-persisted-view-state";

type SpendGranularity = "day" | "week" | "month";

const GRANULARITY_LABEL: Record<SpendGranularity, string> = {
	day: "Today",
	week: "This week",
	month: "This month",
};

/**
 * Dedicated view for the provider subscription windows used by Auto Work,
 * plus per-account (workspace) spend aggregated from session cost reports
 * (T-98). "Account" maps to a workspace `cwd` — the deck has no separate
 * account/tenant concept.
 */
export function SubscriptionLimitsView() {
	const [usage, setUsage] = useState<SubscriptionUsageResponse | null>(null);
	const [usageError, setUsageError] = useState<string | undefined>();
	const [spend, setSpend] = useState<SpendSummaryResponse | null>(null);
	const [spendError, setSpendError] = useState<string | undefined>();
	const [sessions, setSessions] = useState<SessionUsageSummary[] | null>(null);
	const [sessionsError, setSessionsError] = useState<string | undefined>();
	const [loading, setLoading] = useState(true);
	const [granularity, setGranularity] = usePersistedViewState<SpendGranularity>("subscriptions.spendGranularity", "day");

	const refresh = useCallback(async (): Promise<void> => {
		setLoading(true);
		const [usageResult, spendResult, sessionsResult] = await Promise.allSettled([
			api.getSubscriptionUsage(),
			api.getAccountSpendSummary(),
			api.listSessionUsage(50),
		]);
		if (usageResult.status === "fulfilled") {
			setUsage(usageResult.value);
			setUsageError(undefined);
		} else {
			setUsageError(usageResult.reason instanceof Error ? usageResult.reason.message : String(usageResult.reason));
		}
		if (spendResult.status === "fulfilled") {
			setSpend(spendResult.value);
			setSpendError(undefined);
		} else {
			setSpendError(spendResult.reason instanceof Error ? spendResult.reason.message : String(spendResult.reason));
		}
		if (sessionsResult.status === "fulfilled") {
			setSessions(sessionsResult.value.sessions);
			setSessionsError(undefined);
		} else {
			setSessionsError(sessionsResult.reason instanceof Error ? sessionsResult.reason.message : String(sessionsResult.reason));
		}
		setLoading(false);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return (
		<Layout
			sidebar={<Sidebar />}
			main={
				<div className="flex h-full min-h-0 flex-col overflow-hidden">
					<header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-paper px-3">
						<div>
							<h1 className="text-sm font-semibold text-ink">Subscription limits</h1>
							<p className="text-2xs text-ink-3">Provider usage windows, reset times, and per-account spend</p>
						</div>
						<button
							type="button"
							onClick={() => void refresh()}
							disabled={loading}
							className="btn-ghost inline-flex h-7 items-center gap-1.5 px-2 text-xs"
							title="Refresh subscription limits"
						>
							<RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
							Refresh
						</button>
					</header>
					<div className="flex-1 overflow-y-auto p-4">
						<div className="mx-auto max-w-3xl space-y-6">
							<SubscriptionLimitsContent usage={usage} loading={loading} error={usageError} onRetry={refresh} />
							<AccountSpendSection
								spend={spend}
								loading={loading}
								error={spendError}
								granularity={granularity}
								onGranularityChange={setGranularity}
							/>
							<SessionListSection sessions={sessions} loading={loading} error={sessionsError} />
							<AggregatedStatsSection />
						</div>
					</div>
				</div>
			}
			inspector={null}
			topBar={null}
		/>
	);
}

/** Per-account spend table with an instant day/week/month toggle — all three
 *  bucket totals arrive in one fetch, so switching granularity never refetches. */
function AccountSpendSection({
	spend,
	loading,
	error,
	granularity,
	onGranularityChange,
}: {
	spend: SpendSummaryResponse | null;
	loading: boolean;
	error: string | undefined;
	granularity: SpendGranularity;
	onGranularityChange: (next: SpendGranularity) => void;
}) {
	return (
		<section className="rounded-md border border-line bg-paper-2 p-4">
			<div className="mb-3 flex items-center justify-between gap-3">
				<div>
					<h2 className="text-sm font-medium text-ink">Spend by account</h2>
					<p className="text-2xs text-ink-3">
						{GRANULARITY_LABEL[granularity]} · session-reported cost, UTC calendar {granularity}
					</p>
				</div>
				<div className="flex items-center gap-0.5 rounded-md border border-line bg-paper p-0.5">
					{(Object.keys(GRANULARITY_LABEL) as SpendGranularity[]).map((g) => (
						<button
							key={g}
							type="button"
							onClick={() => onGranularityChange(g)}
							className={cn(
								"rounded px-2 py-1 text-2xs font-medium capitalize transition-colors",
								granularity === g ? "bg-accent text-white" : "text-ink-3 hover:text-ink",
							)}
						>
							{g}
						</button>
					))}
				</div>
			</div>
			{loading && spend === null ? (
				<div className="py-6 text-center text-xs text-ink-3">Loading spend…</div>
			) : error ? (
				<p className="py-6 text-center text-xs text-ink-3">Could not load account spend: {error}</p>
			) : !spend || spend.accounts.length === 0 ? (
				<p className="py-6 text-center text-xs text-ink-3">No sessions have reported cost yet.</p>
			) : (
				<table className="w-full text-xs">
					<tbody>
						{spend.accounts.map((account) => (
							<tr key={account.cwd} className="border-t border-line/60 first:border-t-0">
								<td className="py-1.5 pr-3 text-ink-2" title={account.cwd}>
									{account.label}
								</td>
								<td className="py-1.5 text-right font-mono tabular-nums text-ink">{formatCost(account[granularity])}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}

function SubscriptionLimitsContent({
	usage,
	loading,
	error,
	onRetry,
}: {
	usage: SubscriptionUsageResponse | null;
	loading: boolean;
	error: string | undefined;
	onRetry: () => Promise<void>;
}) {
	if (loading && usage === null) {
		return <div className="py-10 text-center text-xs text-ink-3">Loading subscription usage…</div>;
	}

	if (error) {
		return (
			<EmptyState
				icon={<AlertCircle className="h-10 w-10 opacity-30" />}
				title="Could not load subscription limits"
				detail={error}
				onRetry={onRetry}
			/>
		);
	}

	if (!usage || !usage.available) {
		return (
			<EmptyState
				icon={<FolderGit2 className="h-10 w-10 opacity-30" />}
				title="Subscription usage unavailable"
				detail={usage?.reason ?? "The provider did not return subscription usage."}
				onRetry={onRetry}
			/>
		);
	}

	return (
		<div className="space-y-3">
		{usage.limits.map((limit) => {
			const pct = Math.min(100, Math.max(0, limit.pctUsed));
			const resetDate = new Date(limit.resetAt);
			const resetLabel = Number.isNaN(resetDate.getTime())
				? limit.resetAt
				: resetDate.toLocaleString(undefined, {
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
				});
			// Always show account context. Fall back to "–" for pre-T128 payloads
			// that lack the field, so no bar is ever silently missing the line.
			const accountLabel = limit.account ?? "–";
			const providerLabel = limit.provider ?? "–";
			// Composite key: same window label can appear for different accounts.
			const cardKey = `${providerLabel}:${accountLabel}:${limit.label}`;
			return (
				<section key={cardKey} className="rounded-md border border-line bg-paper-2 p-4">
					<div className="mb-3 flex items-start justify-between gap-3">
						<div className="min-w-0">
							<h2 className="text-sm font-medium text-ink">{limit.label}</h2>
							<p className="mt-0.5 text-2xs text-ink-3 truncate" title={`${providerLabel} · ${accountLabel}`}>
								{providerLabel} · {accountLabel}
							</p>
						</div>
						<span
							className={cn(
								"shrink-0 text-lg font-semibold tabular-nums",
								pct >= 90 ? "text-red-400" : pct >= 75 ? "text-yellow-400" : "text-ink",
							)}
						>
							{pct.toFixed(0)}%
						</span>
					</div>
					<div className="h-2 w-full overflow-hidden rounded-full bg-paper-3">
						<div
							className={cn(
								"h-full rounded-full transition-all",
								pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-yellow-500" : "bg-accent",
							)}
							style={{ width: `${pct}%` }}
						/>
					</div>
					<p className="mt-2 text-xs text-ink-3">Resets {resetLabel}</p>
				</section>
			);
		})}
		</div>
	);
}

function EmptyState({
	icon,
	title,
	detail,
	onRetry,
}: {
	icon: ReactNode;
	title: string;
	detail: string;
	onRetry: () => Promise<void>;
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center text-ink-3">
			{icon}
			<p className="text-sm text-ink-2">{title}</p>
			<p className="max-w-lg text-xs">{detail}</p>
			<button type="button" onClick={() => void onRetry()} className="btn-ghost h-7 px-2 text-xs">
				Try again
			</button>
		</div>
	);
}

/** Per-session table grouped by provider (subscription), showing account and provider on each row.
 *  Within each group sessions are ordered most-recently-updated first. */
function SessionListSection({
	sessions,
	loading,
	error,
}: {
	sessions: SessionUsageSummary[] | null;
	loading: boolean;
	error: string | undefined;
}) {
	// Group sessions by provider, preserving within-group recency order (API already sorts desc).
	const groups: Array<{ provider: string; sessions: SessionUsageSummary[] }> = [];
	if (sessions) {
		const seen = new Map<string, SessionUsageSummary[]>();
		for (const s of sessions) {
			const key = s.provider ?? "Unknown";
			const bucket = seen.get(key);
			if (bucket) {
				bucket.push(s);
			} else {
				seen.set(key, [s]);
			}
		}
		// Unknown last, then alphabetical.
		for (const [provider, list] of [...seen.entries()].sort(([a], [b]) =>
			a === "Unknown" ? 1 : b === "Unknown" ? -1 : a.localeCompare(b),
		)) {
			groups.push({ provider, sessions: list });
		}
	}

	return (
		<section className="rounded-md border border-line bg-paper-2 p-4">
			<div className="mb-3">
				<h2 className="text-sm font-medium text-ink">Sessions by subscription</h2>
				<p className="text-2xs text-ink-3">Last 50 sessions grouped by provider · account and provider per session</p>
			</div>
			{loading && sessions === null ? (
				<div className="py-6 text-center text-xs text-ink-3">Loading sessions…</div>
			) : error ? (
				<p className="py-6 text-center text-xs text-ink-3">Could not load sessions: {error}</p>
			) : !sessions || sessions.length === 0 ? (
				<p className="py-6 text-center text-xs text-ink-3">No sessions found.</p>
			) : (
				<div className="space-y-4">
					{groups.map(({ provider, sessions: groupSessions }) => (
						<div key={provider}>
							<div className="mb-1 flex items-center gap-2">
								<span className="text-2xs font-semibold uppercase tracking-wide text-ink-3">{provider}</span>
								<span className="text-2xs text-ink-4">{groupSessions.length} session{groupSessions.length !== 1 ? "s" : ""}</span>
							</div>
							<table className="w-full text-xs">
								<thead>
									<tr className="border-b border-line/60">
										<th className="pb-1 pr-3 text-left font-medium text-ink-3">Session</th>
										<th className="pb-1 pr-3 text-left font-medium text-ink-3">Account</th>
										<th className="pb-1 pr-3 text-left font-medium text-ink-3">Provider</th>
										<th className="pb-1 pr-3 text-right font-medium text-ink-3">Cost</th>
										<th className="pb-1 text-right font-medium text-ink-3">Tokens</th>
									</tr>
								</thead>
								<tbody>
									{groupSessions.map((s) => (
										<tr key={s.id} className="border-t border-line/60 first:border-t-0">
											<td className="py-1.5 pr-3 text-ink-2" title={s.id}>
												<span className="block max-w-[200px] truncate">{s.title ?? s.id}</span>
											</td>
											<td className="py-1.5 pr-3 text-ink-2" title={s.cwd}>
												{s.accountLabel}
											</td>
											<td className="py-1.5 pr-3 text-ink-2">
												{s.provider ?? <span className="text-ink-4">—</span>}
											</td>
											<td className="py-1.5 pr-3 text-right font-mono tabular-nums text-ink">
												{s.costUsd > 0 ? formatCost(s.costUsd) : <span className="text-ink-4">—</span>}
											</td>
											<td className="py-1.5 text-right font-mono tabular-nums text-ink">
												{s.totalTokens > 0 ? s.totalTokens.toLocaleString() : <span className="text-ink-4">—</span>}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

// ---------------------------------------------------------------------------
// T-37: Aggregated historical stats section (omp-stats backed)
// ---------------------------------------------------------------------------

const RANGE_LABELS: Record<OmpStatsRange, string> = {
	"1h": "1 hour",
	"24h": "24 hours",
	"7d": "7 days",
	"30d": "30 days",
	"90d": "90 days",
	all: "All time",
};

const AGENT_TYPE_LABEL: Record<string, string> = {
	main: "Main",
	subagent: "Subagent",
	advisor: "Advisor",
};

/** Filterable aggregated stats from the omp-stats SQLite DB (session data only). */
function AggregatedStatsSection() {
	const navigate = useNavigate();
	const [range, setRange] = usePersistedViewState<OmpStatsRange>("stats.range", "7d");
	const [filterCwd, setFilterCwd] = usePersistedViewState<string>("stats.filterCwd", "");
	const [filterModel, setFilterModel] = usePersistedViewState<string>("stats.filterModel", "");
	const [filterAgentType, setFilterAgentType] = usePersistedViewState<string>("stats.filterAgentType", "");
	const [expandedModel, setExpandedModel] = useState<string | null>(null);
	const [data, setData] = useState<AggregatedStatsResponse | null>(null);
	const [statsError, setStatsError] = useState<string | undefined>();
	const [statsLoading, setStatsLoading] = useState(true);
	// Track in-flight request to avoid stale updates on rapid filter changes.
	const fetchSeq = useRef(0);

	const load = useCallback(async (r: OmpStatsRange, cwd: string, model: string, agentType: string) => {
		const seq = ++fetchSeq.current;
		setStatsLoading(true);
		try {
			const result = await api.getAggregatedStats({
				range: r,
				...(cwd ? { cwd } : {}),
				...(model ? { model } : {}),
				...(agentType ? { agentType: agentType as "main" | "subagent" | "advisor" } : {}),
			});
			if (seq !== fetchSeq.current) return;
			setData(result);
			setStatsError(undefined);
		} catch (err) {
			if (seq !== fetchSeq.current) return;
			setStatsError(err instanceof Error ? err.message : String(err));
		} finally {
			if (seq === fetchSeq.current) setStatsLoading(false);
		}
	}, []);

	useEffect(() => {
		void load(range, filterCwd, filterModel, filterAgentType);
	}, [load, range, filterCwd, filterModel, filterAgentType]);

	// Workspace and model lists come from the unfiltered dimension.
	const workspaces = data?.byWorkspace ?? [];
	const models = data?.byModel ?? [];

	return (
		<section className="rounded-md border border-line bg-paper-2 p-4">
			{/* Header */}
			<div className="mb-3 flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="text-sm font-medium text-ink">Historical stats</h2>
					<p className="text-2xs text-ink-3">
						Agent-session data · source: omp-stats
						{data?.syncInProgress && (
							<span className="ml-2 rounded bg-accent/10 px-1 py-0.5 text-2xs text-accent">syncing…</span>
						)}
					</p>
				</div>
				{/* Range picker */}
				<div className="flex items-center gap-0.5 rounded-md border border-line bg-paper p-0.5">
					{(Object.keys(RANGE_LABELS) as OmpStatsRange[]).map((r) => (
						<button
							key={r}
							type="button"
							onClick={() => setRange(r)}
							className={cn(
								"rounded px-2 py-1 text-2xs font-medium transition-colors",
								range === r ? "bg-accent text-white" : "text-ink-3 hover:text-ink",
							)}
						>
							{r}
						</button>
					))}
				</div>
			</div>

			{/* Filters */}
			<div className="mb-3 flex flex-wrap gap-2">
				<select
					value={filterCwd}
					onChange={(e) => { setFilterCwd(e.target.value); setExpandedModel(null); }}
					className="h-6 rounded border border-line bg-paper px-1.5 text-2xs text-ink"
				>
					<option value="">All workspaces</option>
					{workspaces.map((ws) => (
						<option key={ws.cwd} value={ws.cwd}>{ws.label}</option>
					))}
				</select>
				<select
					value={filterModel}
					onChange={(e) => { setFilterModel(e.target.value); setExpandedModel(null); }}
					className="h-6 rounded border border-line bg-paper px-1.5 text-2xs text-ink"
				>
					<option value="">All models</option>
					{models.map((m) => (
						<option key={`${m.provider}/${m.model}`} value={m.model}>{m.model}</option>
					))}
				</select>
				<select
					value={filterAgentType}
					onChange={(e) => { setFilterAgentType(e.target.value); setExpandedModel(null); }}
					className="h-6 rounded border border-line bg-paper px-1.5 text-2xs text-ink"
				>
					<option value="">All agent types</option>
					<option value="main">Main</option>
					<option value="subagent">Subagent</option>
					<option value="advisor">Advisor</option>
				</select>
				{(filterCwd || filterModel || filterAgentType) && (
					<button
						type="button"
						onClick={() => { setFilterCwd(""); setFilterModel(""); setFilterAgentType(""); setExpandedModel(null); }}
						className="h-6 rounded border border-line bg-paper px-1.5 text-2xs text-ink-3 hover:text-ink"
					>
						Clear filters
					</button>
				)}
			</div>

			{statsLoading && data === null ? (
				<div className="py-6 text-center text-xs text-ink-3">Loading stats…</div>
			) : statsError ? (
				<p className="py-6 text-center text-xs text-ink-3">Could not load stats: {statsError}</p>
			) : !data || (data.byModel.length === 0 && data.byWorkspace.length === 0) ? (
				<p className="py-6 text-center text-xs text-ink-3">
					No data yet. Stats populate after the first omp-stats sync completes.
				</p>
			) : (
				<div className="space-y-4">
					{/* Total summary */}
					<div className="flex gap-4 text-xs text-ink-2">
						<span>{data.total.requests.toLocaleString()} requests</span>
						<span>{data.total.totalTokens.toLocaleString()} tokens</span>
						{data.total.costUsd > 0 && <span className="font-mono tabular-nums">{formatCost(data.total.costUsd)}</span>}
					</div>

					{/* By model */}
					{data.byModel.length > 0 && (
						<div>
							<p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-3">By model</p>
							<table className="w-full text-xs">
								<thead>
									<tr className="border-b border-line/60">
										<th className="pb-1 pr-3 text-left font-medium text-ink-3">Model</th>
										<th className="pb-1 pr-3 text-left font-medium text-ink-3">Provider</th>
										<th className="pb-1 pr-3 text-right font-medium text-ink-3">Reqs</th>
										<th className="pb-1 pr-3 text-right font-medium text-ink-3">Tokens</th>
										<th className="pb-1 text-right font-medium text-ink-3">Cost</th>
									</tr>
								</thead>
								<tbody>
									{data.byModel.map((row) => (
										<ModelRow
											key={`${row.provider}/${row.model}`}
											row={row}
											expanded={expandedModel === `${row.provider}/${row.model}`}
											onToggle={() =>
												setExpandedModel(
													expandedModel === `${row.provider}/${row.model}`
														? null
														: `${row.provider}/${row.model}`,
												)
											}
											onNavigate={(id) => navigate(`/c/${id}`)}
										/>
									))}
								</tbody>
							</table>
						</div>
					)}

					{/* By workspace */}
					{data.byWorkspace.length > 0 && (
						<div>
							<p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-3">By workspace</p>
							<table className="w-full text-xs">
								<thead>
									<tr className="border-b border-line/60">
										<th className="pb-1 pr-3 text-left font-medium text-ink-3">Workspace</th>
										<th className="pb-1 pr-3 text-right font-medium text-ink-3">Reqs</th>
										<th className="pb-1 pr-3 text-right font-medium text-ink-3">Tokens</th>
										<th className="pb-1 text-right font-medium text-ink-3">Cost</th>
									</tr>
								</thead>
								<tbody>
									{data.byWorkspace.map((ws) => (
										<tr key={ws.cwd} className="border-t border-line/60 first:border-t-0">
											<td className="py-1.5 pr-3 text-ink-2" title={ws.cwd}>{ws.label}</td>
											<td className="py-1.5 pr-3 text-right tabular-nums text-ink">{ws.requests.toLocaleString()}</td>
											<td className="py-1.5 pr-3 text-right tabular-nums text-ink">{ws.totalTokens.toLocaleString()}</td>
											<td className="py-1.5 text-right font-mono tabular-nums text-ink">
												{ws.costUsd > 0 ? formatCost(ws.costUsd) : <span className="text-ink-4">—</span>}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}

					{/* By agent type — explicit session/routine separation label */}
					{data.byAgentType.length > 0 && (
						<div>
							<p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-3">
								By agent role <span className="normal-case font-normal text-ink-4">(session data only — routine costs not included)</span>
							</p>
							<table className="w-full text-xs">
								<tbody>
									{data.byAgentType.map((entry) => (
										<tr key={entry.agentType} className="border-t border-line/60 first:border-t-0">
											<td className="py-1.5 pr-3 text-ink-2">
												{AGENT_TYPE_LABEL[entry.agentType] ?? entry.agentType}
											</td>
											<td className="py-1.5 pr-3 text-right tabular-nums text-ink">{entry.requests.toLocaleString()} reqs</td>
											<td className="py-1.5 pr-3 text-right tabular-nums text-ink">{entry.totalTokens.toLocaleString()} tok</td>
											<td className="py-1.5 text-right font-mono tabular-nums text-ink">
												{entry.costUsd > 0 ? formatCost(entry.costUsd) : <span className="text-ink-4">—</span>}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			)}
		</section>
	);
}

/** One model row, expandable to show session drill-down links. */
function ModelRow({
	row,
	expanded,
	onToggle,
	onNavigate,
}: {
	row: HistoricalModelStats;
	expanded: boolean;
	onToggle: () => void;
	onNavigate: (sessionId: string) => void;
}) {
	return (
		<>
			<tr
				className={cn(
					"border-t border-line/60 first:border-t-0",
					row.sessionLinks.length > 0 && "cursor-pointer hover:bg-paper-3/40",
				)}
				onClick={row.sessionLinks.length > 0 ? onToggle : undefined}
			>
				<td className="py-1.5 pr-3 text-ink-2">
					<span className="flex items-center gap-1">
						{row.model}
						{row.sessionLinks.length > 0 && (
							<span className="text-2xs text-ink-4">{expanded ? "▲" : "▼"} {row.sessionLinks.length}</span>
						)}
					</span>
				</td>
				<td className="py-1.5 pr-3 text-ink-3">{row.provider}</td>
				<td className="py-1.5 pr-3 text-right tabular-nums text-ink">{row.requests.toLocaleString()}</td>
				<td className="py-1.5 pr-3 text-right tabular-nums text-ink">{row.totalTokens.toLocaleString()}</td>
				<td className="py-1.5 text-right font-mono tabular-nums text-ink">
					{row.costUsd > 0 ? formatCost(row.costUsd) : <span className="text-ink-4">—</span>}
				</td>
			</tr>
			{expanded && (
				<tr className="border-t border-line/60">
					<td colSpan={5} className="pb-2 pt-1 pl-3">
						<div className="flex flex-wrap gap-1.5">
							{row.sessionLinks.map((link) => (
								<SessionLinkChip key={link.sessionId} link={link} onNavigate={onNavigate} />
							))}
						</div>
					</td>
				</tr>
			)}
		</>
	);
}

/** Clickable chip for one resolved Deck session link. */
function SessionLinkChip({
	link,
	onNavigate,
}: {
	link: SessionDrillDownLink;
	onNavigate: (sessionId: string) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onNavigate(link.sessionId)}
			title={`${link.cwd} · ${AGENT_TYPE_LABEL[link.agentType] ?? link.agentType}`}
			className="inline-flex items-center gap-1 rounded border border-line bg-paper px-1.5 py-0.5 text-2xs text-ink-2 hover:border-accent hover:text-ink"
		>
			<span className="max-w-[160px] truncate">{link.title ?? link.sessionId.slice(0, 12)}</span>
			{link.agentType !== "main" && (
				<span className="text-ink-4">{AGENT_TYPE_LABEL[link.agentType] ?? link.agentType}</span>
			)}
		</button>
	);
}
