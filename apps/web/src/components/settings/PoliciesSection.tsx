import { useEffect, useMemo, useState } from "react";
import type {
	GetPolicySettingsResponse,
	PolicySettingEntry,
	PolicySettingKey,
	PolicySettingValue,
} from "@omp-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { api } from "@/lib/api";

const RETRY_KEYS = new Set<PolicySettingKey>([
	"retry.enabled",
	"retry.maxRetries",
	"retry.baseDelayMs",
	"retry.maxDelayMs",
	"retry.modelFallback",
	"retry.fallbackRevertPolicy",
]);

const COMPACTION_KEYS = new Set<PolicySettingKey>([
	"compaction.enabled",
	"compaction.midTurnEnabled",
	"compaction.strategy",
	"compaction.thresholdPercent",
	"compaction.thresholdTokens",
	"compaction.handoffSaveToDisk",
	"compaction.autoContinue",
]);

export function PoliciesSection() {
	const [data, setData] = useState<GetPolicySettingsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [savingKey, setSavingKey] = useState<PolicySettingKey | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void api
			.getPolicySettings()
			.then((response) => {
				if (!cancelled) setData(response);
			})
			.catch((cause) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	async function update(key: PolicySettingKey, value: PolicySettingValue): Promise<void> {
		setSavingKey(key);
		setError(null);
		try {
			setData(await api.patchPolicySettings({ updates: { [key]: value } }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSavingKey(null);
		}
	}

	if (loading) return <div className="text-sm text-ink-3">Loading OMP policies…</div>;
	if (!data) {
		return <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error ?? "OMP policies are unavailable."}</div>;
	}

	const modelRoles = data.settings.find((entry) => entry.key === "modelRoles");
	const thinking = data.settings.find((entry) => entry.key === "defaultThinkingLevel");
	const fallbackChains = data.settings.find((entry) => entry.key === "retry.fallbackChains");
	const retry = data.settings.filter((entry) => RETRY_KEYS.has(entry.key));
	const compaction = data.settings.filter((entry) => COMPACTION_KEYS.has(entry.key));
	const disabled = savingKey !== null;

	return (
		<div className="mx-auto max-w-3xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Operational policies</h1>
				<p className="mt-1 text-sm text-ink-3">Control OMP model roles, retries, fallbacks, and automatic context compaction.</p>
			</div>
			{error ? <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error}</div> : null}
			{modelRoles ? <ModelRolesCard entry={modelRoles} roles={data.roles} disabled={disabled} onUpdate={update} /> : null}
			{thinking ? <SettingsCard title="Thinking" entries={[thinking]} disabled={disabled} onUpdate={update} /> : null}
			{fallbackChains ? <FallbackChainsCard entry={fallbackChains} roles={data.roles} disabled={disabled} onUpdate={update} /> : null}
			<SettingsCard title="Retry behavior" entries={retry} disabled={disabled} onUpdate={update} />
			<SettingsCard title="Auto-compaction" entries={compaction} disabled={disabled} onUpdate={update} />
			<div className="border-t border-line pt-3 text-xs text-ink-3">
				Source of truth: OMP settings — <span className="font-mono text-2xs text-ink-2">{data.configPath}</span>. Values marked <Badge tone="muted">schema default</Badge> are effective defaults, values marked <Badge tone="accent">OMP config</Badge> are explicitly configured in OMP.
			</div>
		</div>
	);
}

function ModelRolesCard({
	entry,
	roles,
	disabled,
	onUpdate,
}: {
	entry: PolicySettingEntry;
	roles: GetPolicySettingsResponse["roles"];
	disabled: boolean;
	onUpdate: (key: PolicySettingKey, value: PolicySettingValue) => Promise<void>;
}) {
	const assignments = entry.value as Record<string, string>;
	return (
		<SettingsCardFrame title="Model roles" entry={entry}>
			<div className="divide-y divide-line">
				{roles.map((role) => (
					<div key={role.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
						<div className="min-w-0">
							<div className="text-sm font-medium text-ink">{role.name}</div>
							<div className="mt-0.5 font-mono text-xs text-ink-3">{role.id}{role.tag ? ` · ${role.tag}` : ""}</div>
						</div>
						<input
							type="text"
							defaultValue={assignments[role.id] ?? ""}
							placeholder="OMP model selector"
							disabled={disabled}
							onBlur={(event) => {
								const model = event.target.value.trim();
								if ((assignments[role.id] ?? "") === model) return;
								const next = { ...assignments };
								if (model) next[role.id] = model;
								else delete next[role.id];
								void onUpdate(entry.key, next);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
							className="h-8 min-w-52 rounded-md border border-line bg-paper-2 px-2 font-mono text-sm text-ink outline-none focus:border-ink disabled:opacity-50"
						/>
					</div>
				))}
			</div>
		</SettingsCardFrame>
	);
}

function FallbackChainsCard({
	entry,
	roles,
	disabled,
	onUpdate,
}: {
	entry: PolicySettingEntry;
	roles: GetPolicySettingsResponse["roles"];
	disabled: boolean;
	onUpdate: (key: PolicySettingKey, value: PolicySettingValue) => Promise<void>;
}) {
	const chains = entry.value as Record<string, string[]>;
	const roleIds = useMemo(() => {
		const known = roles.map((role) => role.id);
		return [...known, ...Object.keys(chains).filter((role) => !known.includes(role))];
	}, [chains, roles]);

	return (
		<SettingsCardFrame title="Fallback chains" entry={entry}>
			<div className="border-b border-line px-4 py-2 text-xs text-ink-3">Ordered model selectors tried after retryable failures. Leave a row blank to inherit no explicit chain.</div>
			<div className="divide-y divide-line">
				{roleIds.map((role) => (
					<div key={role} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
						<label className="font-mono text-sm text-ink">{role}</label>
						<input
							type="text"
							defaultValue={(chains[role] ?? []).join(", ")}
							placeholder="model-one, model-two"
							disabled={disabled}
							onBlur={(event) => {
								const nextChain = event.target.value.split(",").map((model) => model.trim()).filter(Boolean);
								if (nextChain.join("\u0000") === (chains[role] ?? []).join("\u0000")) return;
								const next = { ...chains };
								if (nextChain.length > 0) next[role] = nextChain;
								else delete next[role];
								void onUpdate(entry.key, next);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
							className="h-8 min-w-52 rounded-md border border-line bg-paper-2 px-2 font-mono text-sm text-ink outline-none focus:border-ink disabled:opacity-50"
						/>
					</div>
				))}
			</div>
		</SettingsCardFrame>
	);
}

function SettingsCard({
	title,
	entries,
	disabled,
	onUpdate,
}: {
	title: string;
	entries: PolicySettingEntry[];
	disabled: boolean;
	onUpdate: (key: PolicySettingKey, value: PolicySettingValue) => Promise<void>;
}) {
	return (
		<SettingsCardFrame title={title}>
			<div className="divide-y divide-line">
				{entries.map((entry) => <PolicyControl key={entry.key} entry={entry} disabled={disabled} onUpdate={onUpdate} />)}
			</div>
		</SettingsCardFrame>
	);
}

function SettingsCardFrame({ title, entry, children }: { title: string; entry?: PolicySettingEntry; children: React.ReactNode }) {
	return (
		<div className="overflow-hidden rounded-lg border border-line bg-paper">
			<div className="flex items-center justify-between gap-3 border-b border-line bg-paper-2/50 px-4 py-2">
				<h2 className="font-mono text-xs font-medium uppercase tracking-meta text-ink-2">{title}</h2>
				{entry ? <Origin entry={entry} /> : null}
			</div>
			{children}
		</div>
	);
}

function PolicyControl({
	entry,
	disabled,
	onUpdate,
}: {
	entry: PolicySettingEntry;
	disabled: boolean;
	onUpdate: (key: PolicySettingKey, value: PolicySettingValue) => Promise<void>;
}) {
	return (
		<div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<div className="text-sm font-medium text-ink">{entry.label}</div>
					<Origin entry={entry} />
				</div>
				{entry.description ? <div className="mt-1 max-w-xl text-xs text-ink-3">{entry.description}</div> : null}
				<div className="mt-1 font-mono text-2xs text-ink-3">Effective: {formatValue(entry.value)} · schema default: {formatValue(entry.defaultValue)}</div>
			</div>
			{entry.type === "boolean" ? (
				<input
					type="checkbox"
					checked={Boolean(entry.value)}
					disabled={disabled}
					onChange={(event) => void onUpdate(entry.key, event.target.checked)}
					className="h-4 w-4 accent-ink disabled:opacity-50"
				/>
			) : entry.type === "enum" ? (
				<select
					value={String(entry.value)}
					disabled={disabled}
					onChange={(event) => void onUpdate(entry.key, event.target.value)}
					className="h-8 min-w-44 rounded-md border border-line bg-paper-2 px-2 text-sm text-ink outline-none focus:border-ink disabled:opacity-50"
				>
					{entry.options?.map((option) => <option key={option.value} value={option.value} title={option.description}>{option.label}</option>)}
				</select>
			) : (
				<input
					type="number"
					defaultValue={String(entry.value)}
					disabled={disabled}
					onBlur={(event) => {
						const value = Number(event.target.value);
						if (Number.isFinite(value) && value !== entry.value) void onUpdate(entry.key, value);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
					}}
					className="h-8 w-32 rounded-md border border-line bg-paper-2 px-2 text-sm text-ink outline-none focus:border-ink disabled:opacity-50"
				/>
			)}
		</div>
	);
}

function Origin({ entry }: { entry: PolicySettingEntry }) {
	return entry.origin === "omp-config" ? <Badge tone="accent">OMP config</Badge> : <Badge tone="muted">schema default</Badge>;
}

function formatValue(value: PolicySettingValue | null): string {
	if (typeof value === "object" && value !== null) return JSON.stringify(value);
	return String(value);
}
