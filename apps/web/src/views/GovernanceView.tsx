/**
 * Rules, TTSR & Extensions governance cockpit (T-35).
 *
 * Turns rules/hooks/extensions the omp SDK already discovers and executes
 * into an auditable, governable surface:
 * - Rules tab: every discovered rule, its scope/condition/interrupt mode,
 *   which bucket it lands in (TTSR / always-apply / rulebook / inactive),
 *   and an enable/disable toggle.
 * - Extensions & Hooks tab: extension modules and pre/post hooks, origin,
 *   load state, recent runtime errors, and an enable/disable toggle.
 * - TTSR History tab: persisted TTSR interruptions explained against the
 *   current rule inventory — answers "why did this turn get interrupted".
 * - Audit Log tab: every enable/disable change and every extension load
 *   error, so config changes stay auditable.
 *
 * Every toggle writes to the SDK's own `disabledExtensions` setting, so it
 * applies to new/resumed sessions — not to one already running.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import type {
	ExtensionInfo,
	GovernanceAuditEntry,
	RuleInfo,
	TtsrHistoryEntry,
	WorkspaceEntry,
} from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { governanceApi } from "@/lib/governance-api";
import { usePersistedViewState } from "@/lib/use-persisted-view-state";
import { cn, formatTimestamp, shortPath } from "@/lib/utils";

type Tab = "rules" | "extensions" | "ttsr" | "audit";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
	{ id: "rules", label: "Rules" },
	{ id: "extensions", label: "Extensions & Hooks" },
	{ id: "ttsr", label: "TTSR History" },
	{ id: "audit", label: "Audit Log" },
];

export function GovernanceView() {
	const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
	const [selectedCwd, setSelectedCwd] = usePersistedViewState("governance.workspace", "");
	const [tab, setTab] = usePersistedViewState<Tab>("governance.tab", "rules");

	useEffect(() => {
		void api.listWorkspaces().then((resp) => setWorkspaces(resp.workspaces));
	}, []);

	useEffect(() => {
		if (!selectedCwd && workspaces.length > 0) setSelectedCwd(workspaces[0]!.cwd);
	}, [workspaces, selectedCwd, setSelectedCwd]);

	const content = (
		<div className="flex h-full overflow-hidden">
			<div className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-line">
				<div className="flex items-center gap-2 border-b border-line px-4 py-3">
					<ShieldCheck className="h-4 w-4 text-ink-3" />
					<h1 className="text-sm font-semibold tracking-tight">Governance</h1>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto py-1">
					{workspaces.map((w) => (
						<button
							key={w.cwd}
							type="button"
							onClick={() => setSelectedCwd(w.cwd)}
							className={cn(
								"flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left text-sm transition-colors",
								w.cwd === selectedCwd ? "bg-accent-soft/40 text-accent" : "text-ink hover:bg-paper-3",
							)}
						>
							<span className="truncate font-medium">{w.label}</span>
							<span className="truncate font-mono text-2xs text-ink-3">{shortPath(w.cwd, 40)}</span>
						</button>
					))}
					{workspaces.length === 0 ? <div className="px-4 py-3 text-xs text-ink-3">No workspaces yet.</div> : null}
				</div>
			</div>

			<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-3">
					{TABS.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => setTab(t.id)}
							className={cn(
								"rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
								tab === t.id ? "bg-paper-3 text-ink" : "text-ink-3 hover:text-ink",
							)}
						>
							{t.label}
						</button>
					))}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{tab === "rules" ? <RulesTab cwd={selectedCwd} /> : null}
					{tab === "extensions" ? <ExtensionsTab cwd={selectedCwd} /> : null}
					{tab === "ttsr" ? <TtsrHistoryTab cwd={selectedCwd} /> : null}
					{tab === "audit" ? <AuditTab /> : null}
				</div>
			</div>
		</div>
	);

	return <Layout sidebar={<Sidebar />} main={content} inspector={<div />} />;
}

// ─────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────

function ErrorBanner({ error }: { error: string }) {
	return <div className="m-3 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</div>;
}

function RefreshButton({ onClick, spinning }: { onClick: () => void; spinning: boolean }) {
	return (
		<Button variant="ghost" size="sm" onClick={onClick} disabled={spinning} aria-label="Refresh">
			<RefreshCw className={cn("h-3.5 w-3.5", spinning && "animate-spin")} />
			Refresh
		</Button>
	);
}

function stateTone(state: "active" | "disabled" | "shadowed"): "success" | "muted" | "warn" {
	if (state === "active") return "success";
	if (state === "shadowed") return "warn";
	return "muted";
}

// ─────────────────────────────────────────────────────────────────────────
// Rules tab
// ─────────────────────────────────────────────────────────────────────────

const BUCKET_LABEL: Record<RuleInfo["bucket"], string> = {
	ttsr: "TTSR",
	"always-apply": "Always-apply",
	rulebook: "Rulebook",
	inactive: "Inactive",
};

function RulesTab({ cwd }: { cwd: string }) {
	const [rules, setRules] = useState<RuleInfo[]>([]);
	const [ttsr, setTtsr] = useState<{ enabled: boolean; interruptMode: string; builtinRules: boolean } | undefined>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [pending, setPending] = useState<string | undefined>();

	const refresh = useCallback(async (): Promise<void> => {
		setLoading(true);
		try {
			const resp = await governanceApi.listRules(cwd || undefined);
			setRules(resp.rules);
			setTtsr(resp.ttsr);
			setError(undefined);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [cwd]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function toggle(rule: RuleInfo): Promise<void> {
		setPending(rule.name);
		try {
			const resp = await governanceApi.setRuleEnabled(rule.name, !rule.enabled, cwd || undefined);
			setRules((prev) => prev.map((r) => (r.name === rule.name ? resp.rule : r)));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setPending(undefined);
		}
	}

	return (
		<div className="p-3">
			<div className="mb-2 flex items-center justify-between">
				<div className="flex items-center gap-2 text-xs text-ink-3">
					{ttsr ? (
						<>
							<Badge tone={ttsr.enabled ? "success" : "muted"}>TTSR {ttsr.enabled ? "on" : "off"}</Badge>
							<Badge tone="default">default interrupt: {ttsr.interruptMode}</Badge>
							<Badge tone={ttsr.builtinRules ? "default" : "muted"}>
								builtin rules {ttsr.builtinRules ? "included" : "excluded"}
							</Badge>
						</>
					) : null}
				</div>
				<RefreshButton onClick={() => void refresh()} spinning={loading} />
			</div>
			{error ? <ErrorBanner error={error} /> : null}
			<div className="overflow-hidden rounded-md border border-line">
				<table className="w-full text-left text-xs">
					<thead className="bg-paper-2 text-2xs uppercase tracking-meta text-ink-3">
						<tr>
							<th className="px-3 py-2 font-medium">Rule</th>
							<th className="px-3 py-2 font-medium">Source</th>
							<th className="px-3 py-2 font-medium">Bucket</th>
							<th className="px-3 py-2 font-medium">Scope / condition</th>
							<th className="px-3 py-2 font-medium">Interrupt</th>
							<th className="px-3 py-2 font-medium">Enabled</th>
						</tr>
					</thead>
					<tbody>
						{rules.map((r) => (
							<tr key={r.name} className="border-t border-line align-top">
								<td className="px-3 py-2">
									<div className="font-medium text-ink">{r.name}</div>
									{r.description ? <div className="mt-0.5 text-ink-3">{r.description}</div> : null}
									<div className="mt-0.5 font-mono text-2xs text-ink-4">{shortPath(r.path, 56)}</div>
								</td>
								<td className="px-3 py-2 text-ink-3">
									{r.source.providerName}
									<div className="text-2xs text-ink-4">{r.source.level}</div>
								</td>
								<td className="px-3 py-2">
									<Badge tone={r.bucket === "ttsr" ? "accent" : r.bucket === "inactive" ? "muted" : "default"}>
										{BUCKET_LABEL[r.bucket]}
									</Badge>
								</td>
								<td className="px-3 py-2 text-ink-3">
									{r.scope?.length ? <div>scope: {r.scope.join(", ")}</div> : null}
									{r.condition?.length ? <div>condition: {r.condition.join(", ")}</div> : null}
									{r.astCondition?.length ? <div>ast: {r.astCondition.join(", ")}</div> : null}
									{!r.scope?.length && !r.condition?.length && !r.astCondition?.length ? (
										<span className="text-ink-4">—</span>
									) : null}
								</td>
								<td className="px-3 py-2 text-ink-3">
									{r.interruptMode}
									{r.interruptModeOverridden ? null : <div className="text-2xs text-ink-4">(default)</div>}
								</td>
								<td className="px-3 py-2">
									<label className="flex items-center gap-2">
										<input
											type="checkbox"
											checked={r.enabled}
											disabled={pending === r.name || r.disabledReason === "provider-disabled" || r.disabledReason === "shadowed"}
											onChange={() => void toggle(r)}
											className="h-3.5 w-3.5 accent-ink disabled:opacity-50"
											aria-label={`Toggle rule ${r.name}`}
										/>
										{r.disabledReason ? <span className="text-2xs text-ink-4">{r.disabledReason}</span> : null}
									</label>
								</td>
							</tr>
						))}
						{!loading && rules.length === 0 ? (
							<tr>
								<td colSpan={6} className="px-3 py-6 text-center text-ink-3">
									No rules discovered{cwd ? ` for ${shortPath(cwd, 40)}` : ""}.
								</td>
							</tr>
						) : null}
					</tbody>
				</table>
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────
// Extensions & hooks tab
// ─────────────────────────────────────────────────────────────────────────

function ExtensionsTab({ cwd }: { cwd: string }) {
	const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
	const [loadErrors, setLoadErrors] = useState<Array<{ id: string; occurredAt: string; path: string; message: string; sessionId?: string }>>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [pending, setPending] = useState<string | undefined>();

	const refresh = useCallback(async (): Promise<void> => {
		setLoading(true);
		try {
			const resp = await governanceApi.listExtensions(cwd || undefined);
			setExtensions(resp.extensions);
			setLoadErrors(resp.loadErrors);
			setError(undefined);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [cwd]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function toggle(ext: ExtensionInfo): Promise<void> {
		setPending(ext.id);
		try {
			const resp = await governanceApi.setExtensionEnabled(ext.id, ext.state !== "active", cwd || undefined);
			setExtensions((prev) => prev.map((e) => (e.id === ext.id ? resp.extension : e)));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setPending(undefined);
		}
	}

	return (
		<div className="p-3">
			<div className="mb-2 flex items-center justify-end">
				<RefreshButton onClick={() => void refresh()} spinning={loading} />
			</div>
			{error ? <ErrorBanner error={error} /> : null}
			<div className="overflow-hidden rounded-md border border-line">
				<table className="w-full text-left text-xs">
					<thead className="bg-paper-2 text-2xs uppercase tracking-meta text-ink-3">
						<tr>
							<th className="px-3 py-2 font-medium">Kind</th>
							<th className="px-3 py-2 font-medium">Name</th>
							<th className="px-3 py-2 font-medium">Trigger</th>
							<th className="px-3 py-2 font-medium">Source</th>
							<th className="px-3 py-2 font-medium">State</th>
							<th className="px-3 py-2 font-medium">Enabled</th>
						</tr>
					</thead>
					<tbody>
						{extensions.map((e) => (
							<tr key={e.id} className="border-t border-line align-top">
								<td className="px-3 py-2 text-ink-3">{e.kind}</td>
								<td className="px-3 py-2">
									<div className="font-medium text-ink">{e.name}</div>
									<div className="mt-0.5 font-mono text-2xs text-ink-4">{shortPath(e.path, 56)}</div>
								</td>
								<td className="px-3 py-2 text-ink-3">{e.trigger ?? <span className="text-ink-4">—</span>}</td>
								<td className="px-3 py-2 text-ink-3">
									{e.source.providerName}
									<div className="text-2xs text-ink-4">{e.source.level}</div>
								</td>
								<td className="px-3 py-2">
									<Badge tone={stateTone(e.state)}>{e.state}</Badge>
									{e.disabledReason ? <div className="mt-0.5 text-2xs text-ink-4">{e.disabledReason}</div> : null}
								</td>
								<td className="px-3 py-2">
									<input
										type="checkbox"
										checked={e.state === "active"}
										disabled={pending === e.id || e.disabledReason === "provider-disabled" || e.state === "shadowed"}
										onChange={() => void toggle(e)}
										className="h-3.5 w-3.5 accent-ink disabled:opacity-50"
										aria-label={`Toggle extension ${e.name}`}
									/>
								</td>
							</tr>
						))}
						{!loading && extensions.length === 0 ? (
							<tr>
								<td colSpan={6} className="px-3 py-6 text-center text-ink-3">
									No extension modules or hooks discovered{cwd ? ` for ${shortPath(cwd, 40)}` : ""}.
								</td>
							</tr>
						) : null}
					</tbody>
				</table>
			</div>

			{loadErrors.length > 0 ? (
				<div className="mt-4">
					<h2 className="mb-1.5 text-2xs font-medium uppercase tracking-meta text-ink-3">Recent load errors</h2>
					<div className="space-y-1.5">
						{loadErrors.map((le) => (
							<div key={le.id} className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs">
								<div className="flex items-center justify-between gap-2">
									<span className="font-mono text-2xs text-ink-3">{shortPath(le.path, 60)}</span>
									<span className="text-2xs text-ink-4">{formatTimestamp(le.occurredAt)}</span>
								</div>
								<div className="mt-0.5 text-danger">{le.message}</div>
							</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────
// TTSR history tab
// ─────────────────────────────────────────────────────────────────────────

function TtsrHistoryTab({ cwd }: { cwd: string }) {
	const [entries, setEntries] = useState<TtsrHistoryEntry[]>([]);
	const [truncated, setTruncated] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();

	const refresh = useCallback(async (): Promise<void> => {
		setLoading(true);
		try {
			const resp = await governanceApi.listTtsrHistory(cwd || undefined);
			setEntries(resp.entries);
			setTruncated(resp.truncated);
			setError(undefined);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [cwd]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return (
		<div className="p-3">
			<div className="mb-2 flex items-center justify-between">
				<p className="text-xs text-ink-3">
					Scanned the most recently updated sessions{cwd ? ` for ${shortPath(cwd, 40)}` : ""}.
					{truncated ? " Older sessions weren't checked." : ""}
				</p>
				<RefreshButton onClick={() => void refresh()} spinning={loading} />
			</div>
			{error ? <ErrorBanner error={error} /> : null}
			<div className="space-y-2">
				{entries.map((entry) => (
					<div key={entry.entryId} className="rounded-md border border-line bg-paper p-3 text-xs">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="min-w-0 truncate font-medium text-ink">{entry.sessionTitle ?? entry.sessionId}</div>
							<div className="text-2xs text-ink-4">{formatTimestamp(entry.occurredAt)}</div>
						</div>
						<div className="mt-0.5 font-mono text-2xs text-ink-4">{shortPath(entry.cwd, 56)}</div>
						<div className="mt-2 space-y-1.5">
							{entry.rules.map((rule) => (
								<div key={rule.name} className="rounded border border-line-strong/40 bg-paper-2 px-2 py-1.5">
									<div className="flex items-center gap-1.5">
										<span className="font-medium text-ink">{rule.name}</span>
										{!rule.found ? <Badge tone="warn">no longer in inventory</Badge> : null}
										{rule.interruptMode ? <Badge tone="default">{rule.interruptMode}</Badge> : null}
									</div>
									{rule.description ? <div className="mt-0.5 text-ink-3">{rule.description}</div> : null}
									{rule.condition?.length ? (
										<div className="mt-0.5 text-ink-3">condition: {rule.condition.join(", ")}</div>
									) : null}
									{rule.astCondition?.length ? (
										<div className="mt-0.5 text-ink-3">ast condition: {rule.astCondition.join(", ")}</div>
									) : null}
									{rule.scope?.length ? <div className="mt-0.5 text-ink-3">scope: {rule.scope.join(", ")}</div> : null}
								</div>
							))}
						</div>
					</div>
				))}
				{!loading && entries.length === 0 ? (
					<div className="rounded-md border border-line px-3 py-6 text-center text-ink-3">
						No TTSR interruptions found in the scanned sessions.
					</div>
				) : null}
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────
// Audit log tab
// ─────────────────────────────────────────────────────────────────────────

function AuditTab() {
	const [entries, setEntries] = useState<GovernanceAuditEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();

	const refresh = useCallback(async (): Promise<void> => {
		setLoading(true);
		try {
			const resp = await governanceApi.listAudit();
			setEntries(resp.entries);
			setError(undefined);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return (
		<div className="p-3">
			<div className="mb-2 flex items-center justify-end">
				<RefreshButton onClick={() => void refresh()} spinning={loading} />
			</div>
			{error ? <ErrorBanner error={error} /> : null}
			<div className="overflow-hidden rounded-md border border-line">
				<table className="w-full text-left text-xs">
					<thead className="bg-paper-2 text-2xs uppercase tracking-meta text-ink-3">
						<tr>
							<th className="px-3 py-2 font-medium">When</th>
							<th className="px-3 py-2 font-medium">Kind</th>
							<th className="px-3 py-2 font-medium">Target</th>
							<th className="px-3 py-2 font-medium">Action</th>
							<th className="px-3 py-2 font-medium">Actor</th>
							<th className="px-3 py-2 font-medium">Result</th>
						</tr>
					</thead>
					<tbody>
						{entries.map((entry) => (
							<tr key={entry.id} className="border-t border-line align-top">
								<td className="px-3 py-2 text-2xs text-ink-4">{formatTimestamp(entry.occurredAt)}</td>
								<td className="px-3 py-2 text-ink-3">{entry.kind}</td>
								<td className="px-3 py-2">
									<div className="font-mono text-2xs text-ink">{entry.targetId}</div>
									{entry.cwd ? <div className="font-mono text-2xs text-ink-4">{shortPath(entry.cwd, 48)}</div> : null}
								</td>
								<td className="px-3 py-2 text-ink-3">{entry.action}</td>
								<td className="px-3 py-2 text-ink-3">{entry.actor}</td>
								<td className="px-3 py-2">
									<Badge tone={entry.result === "ok" ? "success" : "danger"}>{entry.result}</Badge>
									{entry.error ? <div className="mt-0.5 max-w-xs text-2xs text-danger">{entry.error}</div> : null}
								</td>
							</tr>
						))}
						{!loading && entries.length === 0 ? (
							<tr>
								<td colSpan={6} className="px-3 py-6 text-center text-ink-3">
									No governance changes recorded yet.
								</td>
							</tr>
						) : null}
					</tbody>
				</table>
			</div>
		</div>
	);
}
