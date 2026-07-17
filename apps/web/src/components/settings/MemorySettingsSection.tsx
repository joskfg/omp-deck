import { useEffect, useState } from "react";
import type { GetMemorySettingsResponse, MemorySettingEntry, MemorySettingKey } from "@omp-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { api } from "@/lib/api";

const MNEMOPI_KEYS = new Set<MemorySettingKey>(["mnemopi.scoping", "mnemopi.autoRecall", "mnemopi.autoRetain"]);
const HINDSIGHT_KEYS = new Set<MemorySettingKey>([
	"hindsight.apiUrl",
	"hindsight.bankId",
	"hindsight.scoping",
	"hindsight.autoRecall",
	"hindsight.autoRetain",
	"hindsight.mentalModelsEnabled",
]);

/**
 * Governance for OMP's own session-memory subsystem — separate from the
 * deck's KB (hand-tended long-term knowledge, `/kb`). Same projection
 * pattern as `DelegationSection`: values live in OMP's settings store, this
 * only reads/writes the curated, credential-free `MemorySettingKey` subset
 * (`GET`/`PATCH /api/memory/settings`).
 */
export function MemorySettingsSection({ onChanged }: { onChanged?: () => void }) {
	const [data, setData] = useState<GetMemorySettingsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [savingKey, setSavingKey] = useState<MemorySettingKey | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void api
			.getMemorySettings()
			.then((response) => {
				if (!cancelled) setData(response);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	async function update(entry: MemorySettingEntry, value: number | string | boolean): Promise<void> {
		setSavingKey(entry.key);
		setError(null);
		try {
			setData(await api.patchMemorySettings({ updates: { [entry.key]: value } }));
			onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingKey(null);
		}
	}

	if (loading) return <div className="text-sm text-ink-3">Loading memory settings…</div>;
	if (!data) {
		return <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error ?? "Memory settings are unavailable."}</div>;
	}

	const backend = data.settings.find((entry) => entry.key === "memory.backend");
	const activeBackend = String(backend?.value ?? "off");
	const general = data.settings.filter((entry) => !MNEMOPI_KEYS.has(entry.key) && !HINDSIGHT_KEYS.has(entry.key));
	const mnemopi = data.settings.filter((entry) => MNEMOPI_KEYS.has(entry.key));
	const hindsight = data.settings.filter((entry) => HINDSIGHT_KEYS.has(entry.key));

	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-base font-semibold text-ink">Memory settings</h2>
				<p className="mt-1 text-sm text-ink-3">
					Governs OMP's own session-memory subsystem (recall/retain, not the KB). Applies to the next agent turn, including live
					sessions.
				</p>
			</div>
			{error ? <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error}</div> : null}
			<MemorySettingGroup title="General" entries={general} savingKey={savingKey} onUpdate={update} />
			{activeBackend === "mnemopi" ? (
				<MemorySettingGroup title="Mnemopi (local SQLite)" entries={mnemopi} savingKey={savingKey} onUpdate={update} />
			) : null}
			{activeBackend === "hindsight" ? (
				<MemorySettingGroup title="Hindsight (remote)" entries={hindsight} savingKey={savingKey} onUpdate={update} />
			) : null}
			<div className="border-t border-line pt-3 text-xs text-ink-3">
				Source of truth: OMP settings — <span className="font-mono text-2xs text-ink-2">{data.configPath}</span>. Credentials
				(API tokens/keys) are never read or written here — configure those via the OMP CLI.
			</div>
		</div>
	);
}

function MemorySettingGroup({
	title,
	entries,
	savingKey,
	onUpdate,
}: {
	title: string;
	entries: MemorySettingEntry[];
	savingKey: MemorySettingKey | null;
	onUpdate: (entry: MemorySettingEntry, value: number | string | boolean) => Promise<void>;
}) {
	if (entries.length === 0) return null;
	return (
		<div className="overflow-hidden rounded-lg border border-line bg-paper">
			<div className="border-b border-line bg-paper-2/50 px-4 py-2">
				<h3 className="font-mono text-xs font-medium uppercase tracking-meta text-ink-2">{title}</h3>
			</div>
			<div className="divide-y divide-line">
				{entries.map((entry) => (
					<div key={entry.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<div className="text-sm font-medium text-ink">{entry.label}</div>
								{!entry.configured ? <Badge tone="muted">default</Badge> : null}
							</div>
							<div className="mt-1 max-w-xl text-xs text-ink-3">{entry.description}</div>
						</div>
						<MemorySettingControl entry={entry} disabled={savingKey !== null} onUpdate={onUpdate} />
					</div>
				))}
			</div>
		</div>
	);
}

function MemorySettingControl({
	entry,
	disabled,
	onUpdate,
}: {
	entry: MemorySettingEntry;
	disabled: boolean;
	onUpdate: (entry: MemorySettingEntry, value: number | string | boolean) => Promise<void>;
}) {
	if (entry.type === "boolean") {
		return (
			<input
				type="checkbox"
				checked={Boolean(entry.value)}
				disabled={disabled}
				onChange={(event) => void onUpdate(entry, event.target.checked)}
				className="h-4 w-4 accent-ink disabled:opacity-50"
			/>
		);
	}
	if (entry.options?.length) {
		const value = String(entry.value);
		const hasCurrent = entry.options.some((option) => option.value === value);
		return (
			<select
				value={value}
				disabled={disabled}
				onChange={(event) => void onUpdate(entry, event.target.value)}
				className="h-8 min-w-44 rounded-md border border-line bg-paper-2 px-2 text-sm text-ink outline-none focus:border-ink disabled:opacity-50"
			>
				{!hasCurrent ? <option value={value}>{value}</option> : null}
				{entry.options.map((option) => (
					<option key={option.value} value={option.value} title={option.description}>
						{option.label}
					</option>
				))}
			</select>
		);
	}
	return (
		<input
			type="text"
			defaultValue={String(entry.value)}
			disabled={disabled}
			onBlur={(event) => {
				const value = event.target.value.trim();
				if (value !== String(entry.value)) void onUpdate(entry, value);
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
			}}
			className="h-8 w-56 rounded-md border border-line bg-paper-2 px-2 font-mono text-xs text-ink outline-none focus:border-ink disabled:opacity-50"
		/>
	);
}
