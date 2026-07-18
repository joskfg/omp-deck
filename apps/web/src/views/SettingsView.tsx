import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Play, RotateCcw, Save, Square, X } from "lucide-react";
import type {
	AutoWorkConfig,
	AutoWorkGlobalConfig,
	AutoWorkModelByDifficulty,
	BridgeInfo,
	BridgeName,
	DeckBaseUrlResponse,
	EnvEntry,
	GateKnob,
	ListEnvSettingsResponse,
	MaintenanceGateState,
	ModelInfo,
	ModelRef,
	PreludeResponse,
	PlanModelResponse,
	SetAutoWorkGlobalConfigRequest,
	NotificationLevel,
	TaskPriority,
	WorkspaceEntry,
} from "@omp-deck/protocol";
import type { ProviderInfo } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { OAuthFlowModal } from "@/components/settings/OAuthFlowModal";
import { DelegationSection } from "@/components/settings/DelegationSection";
import { PoliciesSection } from "@/components/settings/PoliciesSection";
import { AdvisorsSection } from "@/components/settings/AdvisorsSection";
import { AgentPickerModal, shortWorkspacePath } from "@/components/settings/AgentPickerModals";
import { api } from "@/lib/api";
import { autoWorkConfigToRequest } from "@/lib/auto-work-config";
import { bridgesApi } from "@/lib/bridges-api";
import { settingsApi } from "@/lib/settings-api";
import { orientationApi } from "@/lib/orientation-api";
import { authApi } from "@/lib/auth-api";
import { useModelCatalog } from "@/lib/model-catalog";
import { playNotificationTone } from "@/lib/audio";
import { useNotificationPermission } from "@/lib/notifications";
import { DEFAULT_ABORT_SHORTCUT_KEY, useStore, type NotificationItem } from "@/lib/store";
import { THEMES, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const SECTIONS = [
	{ id: "general", label: "General", description: "Deck base URL for session links" },
	{ id: "advisors", label: "Advisors", description: "Second-opinion review for new sessions" },
	{ id: "env", label: "Env", description: "Process and deck-managed variables" },
	{ id: "providers", label: "Providers", description: "OAuth sign-in and API-key state" },
	{ id: "messaging", label: "Messaging", description: "Telegram and future chat bridges" },
	{ id: "orientation", label: "Internal prompts", description: "System prompts and session lifecycle" },
	{ id: "appearance", label: "Appearance", description: "Themes, colors, fonts" },
	{ id: "delegation", label: "Delegation", description: "Subagent concurrency, isolation, integration" },
	{ id: "policies", label: "Policies", description: "Models, retries, fallbacks, context compaction" },
	{ id: "autowork", label: "Auto Work", description: "Unattended runs — enable, window, spend limits" },
	{ id: "notifications", label: "Notifications", description: "Idle alerts and quiet hours" },
	{ id: "about", label: "About", description: "Version, paths, diagnostics" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsView() {
	const [params, setParams] = useSearchParams();
	const selected = normalizeSection(params.get("section"));

	function setSection(section: SectionId): void {
		const next = new URLSearchParams(params);
		next.set("section", section);
		setParams(next, { replace: true });
	}

	return (
		<Layout
			sidebar={<SettingsSideRail />}
			inspector={<SettingsInspector />}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<div className="meta">Settings</div>
						<div className="text-xs text-ink-3">Configure this local deck instance</div>
					</div>
					<div className="grid min-h-0 flex-1 grid-cols-[220px_1fr] overflow-hidden">
						<nav className="border-r border-line bg-paper-2/40 p-2">
							{SECTIONS.map((section) => (
								<button
									key={section.id}
									type="button"
									onClick={() => setSection(section.id)}
									className={cn(
										"mb-1 block w-full rounded-md px-2 py-2 text-left transition-colors",
										selected === section.id ? "bg-accent-soft text-accent" : "hover:bg-paper-3",
									)}
								>
									<div className="font-mono text-xs font-medium uppercase tracking-meta">
										{section.label}
									</div>
									<div className="mt-0.5 text-xs text-ink-3">{section.description}</div>
								</button>
							))}
						</nav>
						<section className="min-h-0 overflow-auto p-4">
						{selected === "general" ? (
								<GeneralSection />
							) : selected === "advisors" ? (
								<AdvisorsSection />
							) : selected === "env" ? (
								<EnvSection />
							) : selected === "providers" ? (
								<ProvidersSection />
							) : selected === "messaging" ? (
								<MessagingSection />
							) : selected === "orientation" ? (
								<InternalPromptsSection />
							) : selected === "appearance" ? (
								<AppearanceSection />
							) : selected === "notifications" ? (
								<NotificationsSection />
							) : selected === "delegation" ? (
								<DelegationSection />
							) : selected === "policies" ? (
								<PoliciesSection />
							) : selected === "autowork" ? (
								<AutoWorkSection />
							) : (
								<StubSection section={selected} />
							)}
						</section>
					</div>
				</div>
			}
		/>
	);
}

function EnvSection() {
	const [data, setData] = useState<ListEnvSettingsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [editing, setEditing] = useState<EnvEntry | null>(null);
	const [restartMessage, setRestartMessage] = useState<string | undefined>();

	async function refresh(): Promise<void> {
		try {
			const next = await settingsApi.listEnv();
			setData(next);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	const grouped = useMemo(() => {
		const entries = data?.entries ?? [];
		const isDeckKey = (key: string) =>
			key.startsWith("OMP_DECK_") ||
			key === "OMP_AGENT_DIR" ||
			key === "LOG_LEVEL" ||
			key === "PI_NO_TITLE" ||
			key === "OMP_MODEL";
		const isMessagingKey = (key: string) => key.startsWith("TELEGRAM_") || key.startsWith("SLACK_");
		return {
			deck: entries.filter((e) => isDeckKey(e.key)),
			messaging: entries.filter((e) => isMessagingKey(e.key)),
			sdk: entries.filter((e) => !isDeckKey(e.key) && !isMessagingKey(e.key)),
		};
	}, [data]);

	async function restart(): Promise<void> {
		try {
			const resp = await settingsApi.restartServer();
			setRestartMessage(resp.message || "Restart scheduled");
		} catch (e) {
			setError(String(e));
		}
	}

	return (
		<div className="mx-auto max-w-6xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Environment variables</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					Edits write to the deck-managed env file only. Variables from the launching process stay
					higher priority until you remove them from that shell/profile.
				</p>
			</div>

			{data?.restartRequired ? (
				<div className="flex items-center gap-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
					<div className="min-w-0 flex-1">
						Restart server to apply one or more restart-required values from the managed .env.
					</div>
					<Button variant="outline" size="sm" onClick={() => void restart()}>
						<RotateCcw className="h-3.5 w-3.5" />
						Restart
					</Button>
				</div>
			) : null}
			{restartMessage ? (
				<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
					{restartMessage}
				</div>
			) : null}
			{error ? (
				<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}

			<div className="rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-3">
				<div>dataDir: {data?.dataDir ?? "..."}</div>
				<div>envFile: {data?.envFilePath ?? "..."}</div>
			</div>

			{loading ? <div className="text-sm text-ink-3">Loading...</div> : null}
			{data ? (
				<>
					<EnvTable title="omp-deck" entries={grouped.deck} onEdit={setEditing} />
					<EnvTable title="messaging bridges" entries={grouped.messaging} onEdit={setEditing} />
					<EnvTable title="omp SDK / providers" entries={grouped.sdk} onEdit={setEditing} />
				</>
			) : null}

			<EditEnvModal
				entry={editing}
				onClose={() => setEditing(null)}
				onSaved={(next) => {
					setData(next);
					setEditing(null);
				}}
			/>
		</div>
	);
}

function MessagingSection() {
	const [data, setData] = useState<ListEnvSettingsResponse | null>(null);
	const [bridges, setBridges] = useState<BridgeInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [editing, setEditing] = useState<EnvEntry | null>(null);

	async function refresh(): Promise<void> {
		try {
			const [envResp, bridgeResp] = await Promise.all([settingsApi.listEnv(), bridgesApi.list()]);
			setData(envResp);
			setBridges(bridgeResp.bridges);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
		const id = window.setInterval(() => {
			if (document.visibilityState === "visible") void refresh();
		}, 4000);
		return () => window.clearInterval(id);
	}, []);

	const entries = data?.entries ?? [];
	const telegramToken = entries.find((entry) => entry.key === "TELEGRAM_BOT_TOKEN");
	const telegramAllowed = entries.find((entry) => entry.key === "TELEGRAM_ALLOWED_USERS");
	const telegramDb = entries.find((entry) => entry.key === "TELEGRAM_BRIDGE_DB_PATH");
	const telegramInfo = bridges.find((b) => b.name === "telegram");

	function applyBridge(next: BridgeInfo): void {
		setBridges((prev) => {
			const idx = prev.findIndex((b) => b.name === next.name);
			if (idx === -1) return [...prev, next];
			const out = prev.slice();
			out[idx] = next;
			return out;
		});
	}

	return (
		<div className="mx-auto max-w-5xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Messaging bridges</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					Save credentials, then start the bridge. The deck supervises the process; saving a
					token alone does not bring the integration online.
				</p>
			</div>

			{error ? (
				<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}
			{loading ? <div className="text-sm text-ink-3">Loading...</div> : null}

			<BridgeCard
				title="Telegram"
				description="DM-only long-poll bridge to local omp-deck."
				info={telegramInfo}
				credentialRows={[
					{ label: "Bot token", entry: telegramToken },
					{ label: "Allowed users", entry: telegramAllowed },
					{ label: "Mapping DB path", entry: telegramDb },
				]}
				onEdit={setEditing}
				onApplyBridge={applyBridge}
				onError={setError}
			/>

			<div className="rounded-md border border-dashed border-line bg-paper-2 p-4">
				<div className="meta">Slack</div>
				<p className="mt-1 text-sm text-ink-3">
					Reserved for the same pattern: product-level setup here, shared managed-env storage underneath.
				</p>
			</div>

			<EditEnvModal
				entry={editing}
				onClose={() => setEditing(null)}
				onSaved={(next) => {
					setData(next);
					setEditing(null);
					void refresh();
				}}
			/>
		</div>
	);
}

function BridgeCard({
	title,
	description,
	info,
	credentialRows,
	onEdit,
	onApplyBridge,
	onError,
}: {
	title: string;
	description: string;
	info: BridgeInfo | undefined;
	credentialRows: Array<{ label: string; entry: EnvEntry | undefined }>;
	onEdit: (entry: EnvEntry) => void;
	onApplyBridge: (next: BridgeInfo) => void;
	onError: (message: string | undefined) => void;
}) {
	const [busy, setBusy] = useState<"start" | "stop" | "restart" | undefined>();

	async function run(action: "start" | "stop" | "restart", name: BridgeName): Promise<void> {
		setBusy(action);
		onError(undefined);
		try {
			const next = await bridgesApi[action](name);
			onApplyBridge(next);
		} catch (e) {
			onError(String((e as Error).message ?? e));
		} finally {
			setBusy(undefined);
		}
	}

	const status = info?.status ?? "stopped";
	const missing = info?.missingEnv ?? [];
	const canStart = status !== "running" && status !== "starting" && missing.length === 0;
	const canStop = status === "running" || status === "starting";
	const canRestart = status === "running";

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="flex items-center justify-between gap-3 border-b border-line bg-paper-2 px-3 py-2">
				<div>
					<div className="meta">{title}</div>
					<div className="mt-0.5 text-xs text-ink-3">{description}</div>
				</div>
				<div className="flex items-center gap-2">
					<Badge tone={bridgeStatusTone(status)}>{bridgeStatusLabel(status, info)}</Badge>
				</div>
			</div>
			<div className="space-y-3 p-3">
				{missing.length > 0 ? (
					<div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
						Missing required env: <span className="font-mono">{missing.join(", ")}</span>. Set
						these below before starting the bridge.
					</div>
				) : null}
				{info?.lastError ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{info.lastError}
					</div>
				) : null}
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="primary"
						size="sm"
						disabled={!canStart || busy !== undefined}
						onClick={() => info && void run("start", info.name)}
					>
						<Play className="h-3.5 w-3.5" />
						{busy === "start" ? "Starting..." : "Start"}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={!canStop || busy !== undefined}
						onClick={() => info && void run("stop", info.name)}
					>
						<Square className="h-3.5 w-3.5" />
						{busy === "stop" ? "Stopping..." : "Stop"}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={!canRestart || busy !== undefined}
						onClick={() => info && void run("restart", info.name)}
					>
						<RotateCcw className="h-3.5 w-3.5" />
						{busy === "restart" ? "Restarting..." : "Restart"}
					</Button>
					{info ? <BridgeMeta info={info} /> : null}
				</div>
				<div className="divide-y divide-line rounded-md border border-line">
					{credentialRows.map((row) => (
						<MessagingCredentialRow key={row.label} label={row.label} entry={row.entry} onEdit={onEdit} />
					))}
				</div>
				{info ? <BridgeLogsPanel name={info.name} /> : null}
			</div>
		</div>
	);
}

function BridgeMeta({ info }: { info: BridgeInfo }) {
	const parts: string[] = [];
	if (info.status === "running") {
		if (info.pid !== undefined) parts.push(`pid ${info.pid}`);
		if (info.startedAt) parts.push(`up ${formatUptime(info.startedAt)}`);
	} else if (info.exitCode !== undefined) {
		parts.push(`exit ${info.exitCode}`);
	}
	if (info.crashCount > 0) parts.push(`crashes ${info.crashCount}`);
	if (parts.length === 0) return null;
	return <div className="font-mono text-2xs text-ink-3">{parts.join(" · ")}</div>;
}

function BridgeLogsPanel({ name }: { name: BridgeName }) {
	const [open, setOpen] = useState(false);
	const [lines, setLines] = useState<Array<{ stream: string; text: string; timestamp: string }>>([]);
	const [fetching, setFetching] = useState(false);

	async function load(): Promise<void> {
		setFetching(true);
		try {
			const resp = await bridgesApi.logs(name);
			setLines(resp.lines);
		} catch (e) {
			setLines([{ stream: "stderr", text: String(e), timestamp: new Date().toISOString() }]);
		} finally {
			setFetching(false);
		}
	}

	useEffect(() => {
		if (!open) return;
		void load();
		const id = window.setInterval(() => {
			if (document.visibilityState === "visible") void load();
		}, 2500);
		return () => window.clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, name]);

	return (
		<div className="rounded-md border border-line bg-paper-2">
			<button
				type="button"
				className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-ink-2 hover:bg-paper-3"
				onClick={() => setOpen((v) => !v)}
			>
				<span>Bridge logs</span>
				<span className="font-mono text-2xs text-ink-3">{open ? "hide" : "show"}</span>
			</button>
			{open ? (
				<div className="max-h-64 overflow-auto border-t border-line bg-paper p-2 font-mono text-2xs">
					{fetching && lines.length === 0 ? <div className="text-ink-3">Loading...</div> : null}
					{!fetching && lines.length === 0 ? <div className="text-ink-3">No log lines yet.</div> : null}
					{lines.map((line, idx) => (
						<div
							key={`${line.timestamp}-${idx}`}
							className={cn("whitespace-pre-wrap", line.stream === "stderr" ? "text-danger" : "text-ink-2")}
						>
							{line.text}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

function MessagingCredentialRow({
	label,
	entry,
	onEdit,
}: {
	label: string;
	entry: EnvEntry | undefined;
	onEdit: (entry: EnvEntry) => void;
}) {
	return (
		<div className="grid grid-cols-[160px_1fr_120px] items-center gap-3 px-3 py-2 text-sm">
			<div>
				<div className="font-medium text-ink">{label}</div>
				<div className="font-mono text-2xs text-ink-4">{entry?.key ?? "missing schema"}</div>
			</div>
			<div className="min-w-0">
				<div className="truncate font-mono text-xs text-ink-2">{entry?.masked ?? "unavailable"}</div>
				<div className="mt-0.5 flex flex-wrap gap-1">
					{entry ? <Badge tone={sourceTone(entry.source)}>{sourceLabel(entry.source)}</Badge> : null}
					{entry ? envApplyBadge(entry) : null}
				</div>
			</div>
			<div className="flex justify-end">
				<Button variant="outline" size="sm" disabled={!entry} onClick={() => entry && onEdit(entry)}>
					Replace
				</Button>
			</div>
		</div>
	);
}

function EnvTable({
	title,
	entries,
	onEdit,
}: {
	title: string;
	entries: EnvEntry[];
	onEdit: (entry: EnvEntry) => void;
}) {
	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="meta">{title}</div>
			</div>
			<div className="divide-y divide-line">
				{entries.map((entry) => (
					<div key={entry.key} className="grid grid-cols-[220px_1fr_120px_100px] gap-3 px-3 py-2 text-sm">
						<div className="min-w-0">
							<div className="truncate font-mono text-xs font-medium text-ink">{entry.key}</div>
							<div className="mt-0.5 text-xs text-ink-4">{entry.valueType}</div>
						</div>
						<div className="min-w-0">
							<div className="truncate font-mono text-xs text-ink-2">{entry.masked}</div>
							<div className="mt-0.5 truncate text-xs text-ink-3">{entry.description}</div>
						</div>
						<div className="flex flex-col items-start gap-1">
							<Badge tone={sourceTone(entry.source)}>{sourceLabel(entry.source)}</Badge>
							{envApplyBadge(entry)}
						</div>
						<div className="flex justify-end">
							<Button variant="outline" size="sm" onClick={() => onEdit(entry)}>
								Replace
							</Button>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function EditEnvModal({
	entry,
	onClose,
	onSaved,
}: {
	entry: EnvEntry | null;
	onClose: () => void;
	onSaved: (next: ListEnvSettingsResponse) => void;
}) {
	const [value, setValue] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!entry) return;
		setValue(entry.sensitive ? "" : entry.source === "unset" ? "" : entry.masked);
		setError(undefined);
	}, [entry]);

	if (!entry) return null;

	async function save(nextValue: string | null): Promise<void> {
		if (!entry) return;
		setSaving(true);
		try {
			const next = await settingsApi.patchEnv({ [entry.key]: nextValue });
			onSaved(next);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Modal open={Boolean(entry)} onClose={onClose} widthClass="max-w-xl">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="min-w-0 flex-1">
					<div className="truncate font-mono text-xs font-semibold text-ink">{entry.key}</div>
					<div className="text-xs text-ink-3">Writes to managed .env only</div>
				</div>
				<Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
					<X className="h-4 w-4" />
				</Button>
			</div>
			<div className="space-y-3 overflow-auto p-4">
				<div className="flex flex-wrap gap-1.5">
					<Badge tone={sourceTone(entry.source)}>{sourceLabel(entry.source)}</Badge>
					{entry.sensitive ? <Badge tone="danger">secret</Badge> : null}
					{entry.restartRequired ? <Badge tone="warn">restart required</Badge> : <Badge tone="success">hot apply</Badge>}
				</div>
				<p className="text-sm text-ink-3">{entry.description}</p>
				{entry.source === "process-env" ? (
					<div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
						This key is currently supplied by the launching process. Replacing it here writes the
						managed env file, but process env remains higher priority until removed upstream.
					</div>
				) : null}
				<label className="block">
					<div className="meta mb-1">New value</div>
					<input
						className="field h-9 w-full px-2 font-mono text-sm"
						type={entry.sensitive ? "password" : "text"}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						placeholder={entry.sensitive ? "Paste replacement value" : entry.defaultValue ?? "Unset"}
					/>
				</label>
				{entry.options ? (
					<div className="text-xs text-ink-3">Allowed: {entry.options.join(", ")}</div>
				) : null}
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
			</div>
			<div className="flex items-center justify-between gap-2 border-t border-line px-3 py-3">
				<Button variant="danger" size="sm" disabled={saving} onClick={() => void save(null)}>
					Unset
				</Button>
				<div className="flex gap-2">
					<Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
						Cancel
					</Button>
					<Button variant="primary" size="sm" onClick={() => void save(value)} disabled={saving}>
						<Save className="h-3.5 w-3.5" />
						Save
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function AppearanceSection() {
	const theme = useTheme();
	return (
		<div className="mx-auto max-w-5xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Appearance</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					Themes swap the entire palette and font stack at runtime. Your choice is stored in this
					browser; clearing it falls back to the system color preference.
				</p>
			</div>

			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				{THEMES.map((def) => (
					<ThemeCard
						key={def.id}
						definition={def}
						isActive={theme.active === def.id}
						isPinned={theme.stored === def.id}
						onPick={() => theme.set(def.id)}
					/>
				))}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-paper-2 px-3 py-2 text-sm">
				<div className="min-w-0">
					<div className="meta">System preference</div>
					<div className="mt-0.5 text-xs text-ink-3">
						{theme.usingSystem
							? `Following the OS: ${theme.systemPreferred}.`
							: `Pinned to ${theme.stored}. The OS currently prefers ${theme.systemPreferred}.`}
					</div>
				</div>
				<Button
					variant="outline"
					size="sm"
					disabled={theme.usingSystem}
					onClick={() => theme.clear()}
				>
					Match system
				</Button>
			</div>

			<div className="overflow-hidden rounded-md border border-line bg-paper">
				<div className="border-b border-line bg-paper-2 px-3 py-2">
					<div className="meta">Font preview</div>
					<div className="mt-0.5 text-xs text-ink-3">Driven by the active theme. v1 ships one font set.</div>
				</div>
				<div className="space-y-3 p-4">
					<div>
						<div className="meta mb-1">Sans</div>
						<div className="font-sans text-base text-ink">
							The agent finished compaction and routed the next prompt back to the original session.
						</div>
					</div>
					<div>
						<div className="meta mb-1">Mono</div>
						<div className="rounded-md border border-line bg-paper-code px-3 py-2 font-mono text-xs text-ink-2">
							{"const status = await bridgesApi.start(\"telegram\");"}
						</div>
					</div>
				</div>
			</div>

			<div className="overflow-hidden rounded-md border border-line bg-paper">
				<div className="border-b border-line bg-paper-2 px-3 py-2">
					<div className="meta">Keyboard shortcuts</div>
					<div className="mt-0.5 text-xs text-ink-3">
						Stored in this browser, same as your theme choice.
					</div>
				</div>
				<div className="p-4">
					<AbortShortcutEditor />
				</div>
			</div>
		</div>
	);
}

/**
 * Lets the user rebind the "stop streaming" shortcut (Ctrl/Cmd + key). Exists
 * because the shipped default (`/`) or the previous default (`.`, ChatGPT/VS
 * Code's "stop generating" convention) can collide with IME bindings —
 * fcitx5's emoji picker grabs `Ctrl+.` before the browser ever sees it, and
 * there's no way to enumerate every IME's defaults in advance. Click
 * "Change", then press any single key (no modifiers) to rebind.
 */
function AbortShortcutEditor() {
	const shortcutKey = useStore((s) => s.abortShortcutKey);
	const setShortcutKey = useStore((s) => s.setAbortShortcutKey);
	const [listening, setListening] = useState(false);

	useEffect(() => {
		if (!listening) return;
		function onKey(e: KeyboardEvent): void {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setListening(false);
				return;
			}
			// Skip bare modifier keydowns — wait for the actual key that will
			// pair with Ctrl/Cmd.
			if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
			setShortcutKey(e.key);
			setListening(false);
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [listening, setShortcutKey]);

	return (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<div className="min-w-0">
				<div className="meta">Stop streaming</div>
				<div className="mt-0.5 font-mono text-sm text-ink">
					{listening ? "Press a key…" : `Ctrl / Cmd + ${shortcutKey}`}
				</div>
			</div>
			<div className="flex items-center gap-2">
				{shortcutKey !== DEFAULT_ABORT_SHORTCUT_KEY ? (
					<Button variant="outline" size="sm" onClick={() => setShortcutKey(DEFAULT_ABORT_SHORTCUT_KEY)}>
						Reset to default
					</Button>
				) : null}
				<Button variant="outline" size="sm" onClick={() => setListening((v) => !v)}>
					{listening ? "Cancel" : "Change"}
				</Button>
			</div>
		</div>
	);
}

/**
 * Notifications settings — surfaces the bits T-85 already plumbed:
 * browser-permission state with a request CTA, audio toggle, per-level tone
 * preview, a way to re-show the dismissed permission banner, server identity
 * pulled from the heartbeat frame, and a tail of the in-app notification log.
 */
function NotificationsSection() {
	const {
		permission,
		requestPermission,
		audioEnabled,
		setAudioEnabled,
		bannerDismissed,
	} = useNotificationPermission();
	const heartbeat = useStore((s) => s.heartbeat);
	const notifications = useStore((s) => s.notifications);
	const dismissNotification = useStore((s) => s.dismissNotification);

	// Show the freshest notifications first; cap to keep the panel tidy.
	// We don't filter by `dismissed` here on purpose — the user dismissed
	// the toast, not the historical record.
	const recent = useMemo(
		() => notifications.slice().reverse().slice(0, 20),
		[notifications],
	);

	// Heartbeat-age clock so "5s ago" updates without re-receiving a frame.
	// Ticks only while the panel is mounted; cheap.
	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		const handle = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(handle);
	}, []);

	return (
		<div className="mx-auto max-w-3xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
				<p className="mt-1 text-sm text-ink-3">
					Browser notifications and audio cues for routine failures, agent activity,
					and other server-emitted events. Settings live in this browser only.
				</p>
			</div>

			<PermissionCard
				permission={permission}
				onRequest={() => void requestPermission()}
			/>

			<AudioCard
				audioEnabled={audioEnabled}
				onToggle={setAudioEnabled}
			/>

			<BannerResetCard
				bannerDismissed={bannerDismissed}
				permission={permission}
				onReset={() => {
					try {
						localStorage.removeItem("omp-deck:notifications:banner-dismissed");
					} catch {
						/* quota / private */
					}
					// The banner component reads the flag from localStorage on mount;
					// a reload is the simplest way to re-evaluate it everywhere it's
					// rendered without threading an extra store action through.
					window.location.reload();
				}}
			/>

			<ServerIdentityCard heartbeat={heartbeat} nowMs={nowMs} />

			<RecentNotificationsCard
				items={recent}
				onDismiss={(id) => dismissNotification(id)}
			/>
		</div>
	);
}

/**
 * General section (T-61): the deck base URL used to build session deep
 * links (e.g. from the auto-work completion flow, T-66). Falls back to
 * `http://localhost:${OMP_DECK_PORT}` server-side when unset — the "Test"
 * button opens the current effective URL's root in a new tab so the user
 * can confirm it resolves before relying on generated links.
 */
function GeneralSection() {
	const [current, setCurrent] = useState<DeckBaseUrlResponse | undefined>();
	const [draft, setDraft] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void api
			.getDeckBaseUrl()
			.then((resp) => {
				if (cancelled) return;
				setCurrent(resp);
				setDraft(resp.isCustom ? resp.deckBaseUrl : "");
			})
			.catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
			.finally(() => !cancelled && setLoading(false));
		return () => {
			cancelled = true;
		};
	}, []);

	async function save(): Promise<void> {
		setSaving(true);
		setError(undefined);
		setSaved(false);
		try {
			const resp = await api.setDeckBaseUrl(draft.trim() === "" ? null : draft.trim());
			setCurrent(resp);
			setDraft(resp.isCustom ? resp.deckBaseUrl : "");
			setSaved(true);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="mx-auto max-w-3xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">General</h1>
				<p className="mt-1 text-sm text-ink-3">
					Deck-wide settings that aren't tied to a specific workspace.
				</p>
			</div>

			<div className="rounded-md border border-line bg-paper-2 p-4">
				<div className="meta mb-1">Deck base URL</div>
				<p className="mb-3 text-xs text-ink-3">
					Used to build clickable session links (e.g. from unattended Auto Work
					runs). The deck may be reachable via localhost, a LAN hostname, or a
					tunnel — set this to whatever URL actually resolves for you. Leave
					blank to use the default.
				</p>
				{error ? (
					<div className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{loading ? (
					<div className="py-4 text-center text-sm text-ink-3">Loading…</div>
				) : (
					<div className="flex items-center gap-2">
						<input
							value={draft}
							onChange={(e) => {
								setDraft(e.target.value);
								setSaved(false);
							}}
							placeholder={current?.deckBaseUrl ?? "http://localhost:8787"}
							className="field h-8 flex-1 px-2 text-sm"
						/>
						<Button size="sm" onClick={() => void save()} disabled={saving}>
							{saving ? "Saving…" : "Save"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => current && window.open(current.deckBaseUrl, "_blank", "noopener,noreferrer")}
							disabled={!current}
						>
							Test
						</Button>
					</div>
				)}
				{!loading && current ? (
					<div className="mt-2 font-mono text-2xs text-ink-3">
						Effective: {current.deckBaseUrl} {current.isCustom ? "(custom)" : "(default)"}
						{saved ? " · saved" : ""}
					</div>
				) : null}
			</div>

			<TaskRewriteModelCard />
			<InternalTaskModelCard />
			<PlanModelCard />
		</div>
	);
}

/**
 * Card within GeneralSection (T-76) — shows the configured model for AI task
 * rewrites and lets the user pick or clear it.
 */
function TaskRewriteModelCard() {
	const [model, setModel] = useState<ModelRef | null>(null);
	const [loading, setLoading] = useState(true);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let cancelled = false;
		void api.getTaskRewriteModel()
			.then((r) => { if (!cancelled) { setModel(r.model); setLoading(false); } })
			.catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
		return () => { cancelled = true; };
	}, []);

	async function clearModel(): Promise<void> {
		setError(undefined);
		try {
			const r = await api.setTaskRewriteModel(null);
			setModel(r.model);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	async function onPicked(picked: ModelRef): Promise<void> {
		setPickerOpen(false);
		setError(undefined);
		try {
			const r = await api.setTaskRewriteModel(picked);
			setModel(r.model);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	return (
		<>
			<div className="rounded-md border border-line bg-paper-2 p-4">
				<div className="meta mb-1">Task rewrite model</div>
				<p className="mb-3 text-xs text-ink-3">
					Model used when rewriting tasks via the <strong>Rewrite</strong> button on a
					task card. Runs a short one-off session — no full session overhead.
					Leave as SDK default unless you want a cheaper or faster model for this.
				</p>
				{error ? (
					<div className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{loading ? (
					<div className="py-2 text-sm text-ink-3">Loading…</div>
				) : (
					<div className="flex items-center gap-2">
						<span className="flex-1 font-mono text-xs text-ink-2">
							{model ? `${model.provider} / ${model.id}` : "(SDK default)"}
						</span>
						<Button size="sm" variant="ghost" onClick={() => setPickerOpen(true)}>
							Change
						</Button>
						{model ? (
							<Button size="sm" variant="ghost" onClick={() => void clearModel()}>
								Clear
							</Button>
						) : null}
					</div>
				)}
			</div>
			<SettingsModelPickerModal
				title="Task rewrite model"
				open={pickerOpen}
				onClose={() => setPickerOpen(false)}
				onPicked={(m) => void onPicked(m)}
			/>
		</>
	);
}

/**
 * Card within GeneralSection (T-78) — shows the configured model for
 * server-side session-title generation and lets the user pick or clear it.
 * `null` (the default) means the feature is off, while the base prelude
 * remains available to every session. Mirrors `TaskRewriteModelCard` above.
 */
function InternalTaskModelCard() {
	const [model, setModel] = useState<ModelRef | null>(null);
	const [loading, setLoading] = useState(true);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let cancelled = false;
		void api.getInternalTaskModel()
			.then((r) => { if (!cancelled) { setModel(r.model); setLoading(false); } })
			.catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
		return () => { cancelled = true; };
	}, []);

	async function clearModel(): Promise<void> {
		setError(undefined);
		try {
			const r = await api.setInternalTaskModel(null);
			setModel(r.model);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	async function onPicked(picked: ModelRef): Promise<void> {
		setPickerOpen(false);
		setError(undefined);
		try {
			const r = await api.setInternalTaskModel(picked);
			setModel(r.model);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	return (
		<>
			<div className="rounded-md border border-line bg-paper-2 p-4">
				<div className="meta mb-1">Internal task model</div>
				<p className="mb-3 text-xs text-ink-3">
					Model used for internal one-shot agent jobs you never see directly — first
					consumer is generating a session's title from its first message. Off by
					default: leave unset and the agent's own self-titling instruction keeps
					running as before.
				</p>
				{error ? (
					<div className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{loading ? (
					<div className="py-2 text-sm text-ink-3">Loading…</div>
				) : (
					<div className="flex items-center gap-2">
						<span className="flex-1 font-mono text-xs text-ink-2">
							{model ? `${model.provider} / ${model.id}` : "(off)"}
						</span>
						<Button size="sm" variant="ghost" onClick={() => setPickerOpen(true)}>
							Change
						</Button>
						{model ? (
							<Button size="sm" variant="ghost" onClick={() => void clearModel()}>
								Clear
							</Button>
						) : null}
					</div>
				)}
			</div>
			<SettingsModelPickerModal
				title="Internal task model"
				open={pickerOpen}
				onClose={() => setPickerOpen(false)}
				onPicked={(m) => void onPicked(m)}
			/>
		</>
	);
}

/**
 * Card within GeneralSection (T-30) — the plan-role model + thinking level the
 * deck temporarily switches to while a session is in Plan Mode, restoring the
 * session's own model on exit. Off by default: when unset, Plan Mode keeps the
 * session's current model. Mirrors the model cards above.
 */
function PlanModelCard() {
	const [data, setData] = useState<PlanModelResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let cancelled = false;
		void api.getPlanModel()
			.then((r) => { if (!cancelled) { setData(r); setLoading(false); } })
			.catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
		return () => { cancelled = true; };
	}, []);

	async function clearModel(): Promise<void> {
		setError(undefined);
		try {
			setData(await api.setPlanModel(null));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	async function onPicked(model: ModelRef, thinking: string | null): Promise<void> {
		setPickerOpen(false);
		setError(undefined);
		try {
			setData(await api.setPlanModel(model, thinking));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	const model = data?.model ?? null;
	return (
		<>
			<div className="rounded-md border border-line bg-paper-2 p-4">
				<div className="meta mb-1">Plan mode model</div>
				<p className="mb-3 text-xs text-ink-3">
					Model (and optional thinking level) the deck switches to while a session is
					in Plan Mode, restoring the session's own model on exit. Off by default:
					leave unset and Plan Mode keeps the current model.
				</p>
				{error ? (
					<div className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{loading ? (
					<div className="py-2 text-sm text-ink-3">Loading…</div>
				) : (
					<div className="flex items-center gap-2">
						<span className="flex-1 font-mono text-xs text-ink-2">
							{model
								? `${model.provider} / ${model.id}${data?.thinking ? ` · thinking ${data.thinking}` : ""}`
								: "(off)"}
						</span>
						<Button size="sm" variant="ghost" onClick={() => setPickerOpen(true)}>
							Change
						</Button>
						{model ? (
							<Button size="sm" variant="ghost" onClick={() => void clearModel()}>
								Clear
							</Button>
						) : null}
					</div>
				)}
			</div>
			<PlanModelPickerModal
				open={pickerOpen}
				current={model}
				onClose={() => setPickerOpen(false)}
				onPicked={(m, t) => void onPicked(m, t)}
			/>
		</>
	);
}

function PlanModelPickerModal({
	open,
	current,
	onClose,
	onPicked,
}: {
	open: boolean;
	current: ModelRef | null;
	onClose: () => void;
	onPicked: (model: ModelRef, thinking: string | null) => void;
}) {
	const { loading, error: catalogError, query, setQuery, grouped } = useModelCatalog(undefined, open);
	const [selectedModel, setSelectedModel] = useState<ModelInfo | undefined>();
	const [selectedThinking, setSelectedThinking] = useState<string | undefined>();

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setSelectedModel(undefined);
		setSelectedThinking(undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// When the selected model changes, clear thinking if it doesn't support it.
	useEffect(() => {
		if (!selectedModel?.thinkingLevels?.length) {
			setSelectedThinking(undefined);
		}
	}, [selectedModel]);

	const thinkingLevels = selectedModel?.thinkingLevels;

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-xl">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="meta">Plan mode model</div>
			</div>
			<div className="border-b border-line px-3 py-2">
				<input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Filter by name, id, or provider"
					className="field h-8 w-full px-2 text-sm"
				/>
			</div>
			{catalogError ? (
				<div className="mx-3 my-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{catalogError}
				</div>
			) : null}
			<div className="max-h-[40vh] overflow-y-auto">
				{loading ? <div className="px-3 py-6 text-center text-sm text-ink-3">Loading…</div> : null}
				{grouped.map((g) => (
					<div key={g.provider}>
						<div className="border-b border-line bg-paper-2 px-3 py-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
							{g.provider}
						</div>
						{g.items.map((m) => {
							const active = selectedModel
								? selectedModel.provider === m.provider && selectedModel.id === m.id
								: current?.provider === m.provider && current?.id === m.id;
							return (
								<button
									key={`${m.provider}/${m.id}`}
									type="button"
									onClick={() => setSelectedModel(active && selectedModel ? undefined : m)}
									className={cn(
										"flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-sm last:border-b-0 transition-colors",
										active ? "bg-accent-soft/40 text-accent" : "hover:bg-paper-3/60",
									)}
								>
									<span className="min-w-0 flex-1 truncate">{m.label}</span>
									{m.thinkingLevels?.length ? (
										<span className="shrink-0 font-mono text-2xs text-thinking/70">thinking</span>
									) : null}
									<span className="shrink-0 font-mono text-2xs text-ink-3">{m.id}</span>
								</button>
							);
						})}
					</div>
				))}
			</div>
			{thinkingLevels && thinkingLevels.length > 0 ? (
				<div className="border-t border-line px-3 py-2">
					<div className="mb-1.5 font-mono text-2xs text-ink-3 uppercase tracking-meta">
						Thinking level
					</div>
					<div className="flex flex-wrap gap-1">
						<button
							type="button"
							onClick={() => setSelectedThinking(undefined)}
							className={cn(
								"rounded border px-2 py-0.5 font-mono text-2xs transition-colors",
								selectedThinking === undefined
									? "border-accent bg-accent-soft text-accent"
									: "border-line text-ink-3 hover:border-line-strong hover:text-ink-2",
							)}
						>
							default
						</button>
						<button
							type="button"
							onClick={() => setSelectedThinking("off")}
							className={cn(
								"rounded border px-2 py-0.5 font-mono text-2xs transition-colors",
								selectedThinking === "off"
									? "border-accent bg-accent-soft text-accent"
									: "border-line text-ink-3 hover:border-line-strong hover:text-ink-2",
							)}
						>
							off
						</button>
						{thinkingLevels.map((level) => (
							<button
								key={level}
								type="button"
								onClick={() => setSelectedThinking(level)}
								className={cn(
									"rounded border px-2 py-0.5 font-mono text-2xs transition-colors",
									selectedThinking === level
										? "border-accent bg-accent-soft text-accent"
										: "border-line text-ink-3 hover:border-line-strong hover:text-ink-2",
								)}
							>
								{level}
							</button>
						))}
					</div>
				</div>
			) : null}
			<div className="flex items-center justify-end gap-2 border-t border-line bg-paper-2/60 px-3 py-2">
				<button type="button" onClick={onClose} className="btn-ghost h-8 px-3 text-xs">
					Cancel
				</button>
				<button
					type="button"
					onClick={() =>
						selectedModel &&
						onPicked({ provider: selectedModel.provider, id: selectedModel.id }, selectedThinking ?? null)
					}
					disabled={!selectedModel}
					className={cn("btn-primary h-8 px-3 text-xs", !selectedModel && "opacity-60")}
				>
					Save
				</button>
			</div>
		</Modal>
	);
}


function SettingsModelPickerModal({
	title,
	open,
	onClose,
	onPicked,
}: {
	title: string;
	open: boolean;
	onClose: () => void;
	onPicked: (model: ModelRef) => void;
}) {
	const { loading, error: catalogError, query, setQuery, grouped } = useModelCatalog(undefined, open);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-xl">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="meta">{title}</div>
			</div>
			<div className="border-b border-line px-3 py-2">
				<input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Filter by name, id, or provider"
					className="field h-8 w-full px-2 text-sm"
				/>
			</div>
			{catalogError ? (
				<div className="mx-3 my-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{catalogError}
				</div>
			) : null}
			<div className="max-h-[50vh] overflow-y-auto">
				{loading ? <div className="px-3 py-6 text-center text-sm text-ink-3">Loading…</div> : null}
				{grouped.map((g) => (
					<div key={g.provider}>
						<div className="border-b border-line bg-paper-2 px-3 py-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
							{g.provider}
						</div>
						{g.items.map((m) => (
							<button
								key={`${m.provider}/${m.id}`}
								type="button"
								onClick={() => onPicked({ provider: m.provider, id: m.id })}
								className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-sm last:border-b-0 hover:bg-paper-3/60"
							>
								<span className="min-w-0 flex-1 truncate">{m.label}</span>
								<span className="shrink-0 font-mono text-2xs text-ink-3">{m.id}</span>
							</button>
						))}
					</div>
				))}
			</div>
		</Modal>
	);
}

const TASK_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4", "P5"];

function GlobalScheduleCard({ onError }: { onError: (msg: string) => void }) {
	const [config, setConfig] = useState<AutoWorkGlobalConfig | null>(null);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [scheduleEnabled, setScheduleEnabled] = useState(false);
	const [intervalMinutes, setIntervalMinutes] = useState(5);
	const [taskSelectionModel, setTaskSelectionModel] = useState<ModelRef | null>(null);
	const [squeezeEnabled, setSqueezeEnabled] = useState(false);
	const [modelByDifficulty, setModelByDifficulty] = useState<AutoWorkModelByDifficulty>({ easy: null, medium: null, hard: null });
	const [pickerGlobalDifficulty, setPickerGlobalDifficulty] = useState<"easy" | "medium" | "hard" | undefined>();
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		Promise.all([api.getAutoWorkGlobalConfig(), api.listModels()])
			.then(([cfg, modelsResp]) => {
				setConfig(cfg);
				setScheduleEnabled(cfg.scheduleEnabled);
				setIntervalMinutes(cfg.scheduleIntervalMinutes);
				setTaskSelectionModel(cfg.taskSelectionModel);
				setSqueezeEnabled(cfg.squeezeEnabled);
				setModelByDifficulty(cfg.modelByDifficulty);
				setModels(modelsResp.models.filter((m) => m.isAvailable));
			})
			.catch((e: unknown) => onError(String(e)));
	}, [onError]);

	function save(): void {
		if (saving || !config) return;
		setSaving(true);
		const body: SetAutoWorkGlobalConfigRequest = {
			scheduleEnabled,
			scheduleIntervalMinutes: intervalMinutes,
			taskSelectionModel,
			squeezeEnabled,
			modelByDifficulty,
		};
		api.setAutoWorkGlobalConfig(body)
			.then((updated) => {
				setConfig(updated);
				setScheduleEnabled(updated.scheduleEnabled);
				setIntervalMinutes(updated.scheduleIntervalMinutes);
				setTaskSelectionModel(updated.taskSelectionModel);
				setSqueezeEnabled(updated.squeezeEnabled);
				setModelByDifficulty(updated.modelByDifficulty);
			})
			.catch((e: unknown) => onError(String(e)))
			.finally(() => { setSaving(false); });
	}

	const modelKey = (m: ModelRef) => `${m.provider}/${m.id}`;
	const selectedKey = taskSelectionModel ? modelKey(taskSelectionModel) : "";

	return (
		<>
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<h2 className="mb-3 text-sm font-semibold text-ink">Global schedule</h2>
			<div className="space-y-3">
				{/* Enabled toggle + interval */}
				<div className="flex items-center gap-3">
					<button
						type="button"
						role="switch"
						aria-checked={scheduleEnabled}
						onClick={() => setScheduleEnabled((v) => !v)}
						className={cn(
							"flex h-5 w-9 items-center rounded-full border border-line transition-colors",
							scheduleEnabled ? "bg-accent-soft" : "bg-paper-3",
						)}
					>
						<span className={cn(
							"h-3.5 w-3.5 rounded-full bg-ink-2 transition-transform",
							scheduleEnabled ? "translate-x-4" : "translate-x-0.5",
						)} />
					</button>
					<span className="text-sm text-ink-3">Run automatically every</span>
					<input
						type="number"
						min={1}
						max={120}
						value={intervalMinutes}
						onChange={(e) => setIntervalMinutes(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
						disabled={!scheduleEnabled}
						className="w-16 rounded border border-line bg-paper px-2 py-1 text-center text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent/50 disabled:opacity-40"
					/>
					<span className="text-sm text-ink-3">min</span>
				</div>

				{/* Task selection model */}
				<div className="flex items-center gap-3">
					<span className="w-36 shrink-0 text-sm text-ink-3">Task selection model</span>
					<select
						value={selectedKey}
						onChange={(e) => {
							if (e.target.value === "") {
								setTaskSelectionModel(null);
							} else {
								const found = models.find((m) => modelKey(m) === e.target.value);
								if (found) setTaskSelectionModel({ provider: found.provider, id: found.id });
							}
						}}
						className="flex-1 rounded border border-line bg-paper px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent/50"
					>
						<option value="">Default (server default model)</option>
						{models.map((m) => (
							<option key={modelKey(m)} value={modelKey(m)}>
								{m.label}
							</option>
						))}
					</select>
				</div>

				{/* Squeeze mode */}
				<div className="flex items-start gap-3">
					<button
						type="button"
						role="switch"
						aria-checked={squeezeEnabled}
						onClick={() => setSqueezeEnabled((v) => !v)}
						disabled={!scheduleEnabled}
						className={cn(
							"mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full border border-line transition-colors disabled:opacity-40",
							squeezeEnabled ? "bg-accent-soft" : "bg-paper-3",
						)}
					>
						<span className={cn(
							"h-3.5 w-3.5 rounded-full bg-ink-2 transition-transform",
							squeezeEnabled ? "translate-x-4" : "translate-x-0.5",
						)} />
					</button>
					<div className="text-sm">
						<p className="text-ink-3">Squeeze subscription</p>
						<p className="text-xs text-ink-4">
							When a usage window is close to resetting with capacity to spare, ask the task
							selection model whether to start another task immediately instead of waiting for
							the next scheduled poll.
						</p>
					</div>
				</div>

				<div>
					<div className="meta mb-1 text-xs">Global fallback agent per difficulty</div>
					<p className="mb-1 text-xs text-ink-4">
						Consulted when a workspace has no mapping for a difficulty level
						(hard→medium→easy cascade within this tier before workspace default).
					</p>
					<ul className="divide-y divide-line rounded-md border border-line">
						{(["hard", "medium", "easy"] as const).map((d) => {
							const ref = modelByDifficulty[d];
							return (
								<li key={d} className="flex items-center gap-2 px-2 py-1.5 text-sm">
									<span className="w-14 font-mono text-2xs text-ink-3">{d}</span>
									<span className="min-w-0 flex-1 truncate font-mono text-2xs">
										{ref ? `${ref.provider}/${ref.id}` : "not set"}
									</span>
									<Button variant="ghost" size="sm" onClick={() => setPickerGlobalDifficulty(d)}>
										Change
									</Button>
									{ref ? (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => setModelByDifficulty({ ...modelByDifficulty, [d]: null })}
										>
											Clear
										</Button>
									) : null}
								</li>
							);
						})}
					</ul>
				</div>

				<div className="flex justify-end">
					<Button variant="ghost" size="sm" disabled={saving || !config} onClick={save}>
						{saving ? "Saving…" : "Save"}
					</Button>
				</div>
			</div>
		</div>
		<AgentPickerModal
			open={pickerGlobalDifficulty !== undefined}
			onClose={() => setPickerGlobalDifficulty(undefined)}
			onPicked={(ref) => {
				if (pickerGlobalDifficulty) {
					setModelByDifficulty({ ...modelByDifficulty, [pickerGlobalDifficulty]: ref });
				}
				setPickerGlobalDifficulty(undefined);
			}}
		/>
		</>
	);
}

function AutoWorkSection() {
	const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
	const [configs, setConfigs] = useState<Record<string, AutoWorkConfig>>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [editingCwd, setEditingCwd] = useState<string | undefined>();
	const navigate = useNavigate();

	async function refresh(): Promise<void> {
		try {
			const resp = await api.listWorkspaces();
			setWorkspaces(resp.workspaces);
			// allSettled: a workspace on an unmounted NFS drive or a stale cwd
			// should not break the entire panel — show "unavailable" for it.
			const results = await Promise.allSettled(
				resp.workspaces.map(async (w) => [w.cwd, await api.getAutoWorkConfig(w.cwd)] as const),
			);
			const entries = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
			setConfigs(Object.fromEntries(entries));
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	async function toggleEnabled(cwd: string, enabled: boolean): Promise<void> {
		const current = configs[cwd];
		if (!current) return;
		try {
			const next = await api.setAutoWorkConfig(cwd, autoWorkConfigToRequest({ ...current, enabled }));
			setConfigs((prev) => ({ ...prev, [cwd]: next }));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	return (
		<div className="mx-auto max-w-3xl">
			<div className="mb-6">
				<h1 className="text-lg font-semibold text-ink">Auto Work</h1>
				<p className="mt-1 text-sm text-ink-3">
					Unattended task execution. Global schedule runs across all enabled workspaces.
					Per-workspace settings control eligibility and spend limits.
				</p>
			</div>
			{error ? (
				<div className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}
			<GlobalScheduleCard onError={setError} />
			<h2 className="mb-3 mt-6 text-sm font-semibold text-ink">Workspace settings</h2>
			{loading ? (
				<div className="py-6 text-center text-sm text-ink-3">Loading…</div>
			) : workspaces.length === 0 ? (
				<div className="py-6 text-center text-sm text-ink-3">No known workspaces yet.</div>
			) : (
				<ul className="divide-y divide-line rounded-md border border-line bg-paper-2">
					{workspaces.map((w) => {
						const config = configs[w.cwd];
						return (
							<li key={w.cwd} className="flex items-center gap-3 px-3 py-2.5">
								<div className="min-w-0 flex-1">
									<div className="truncate text-sm font-medium text-ink">{w.label}</div>
									<div className="truncate font-mono text-2xs text-ink-3" title={w.cwd}>{w.cwd}</div>
								</div>
								<div className="shrink-0 text-right font-mono text-2xs text-ink-3">
								{config
									? config.timeWindows.length === 0
										? `never · ${config.sessionPctLimit}%/${config.weeklyPctLimit}%`
										: `${config.timeWindows.map((w) => `${w.start}:00–${w.end}:00`).join(", ")} · ${config.sessionPctLimit}%/${config.weeklyPctLimit}%`
									: "…"}
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									<button
										type="button"
										role="switch"
										aria-checked={config?.enabled ?? false}
										disabled={!config}
										onClick={() => config && void toggleEnabled(w.cwd, !config.enabled)}
										className={cn(
											"flex h-5 w-9 items-center rounded-full border border-line transition-colors",
											config?.enabled ? "bg-accent-soft" : "bg-paper-3",
										)}
										title={config?.enabled ? "Auto Work enabled" : "Auto Work disabled"}
									>
										<span
											className={cn(
												"h-3.5 w-3.5 rounded-full bg-ink-2 transition-transform",
												config?.enabled ? "translate-x-4" : "translate-x-0.5",
											)}
										/>
									</button>
									<Button variant="ghost" size="sm" onClick={() => setEditingCwd(w.cwd)}>
										Configure
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => navigate(`/project-config?cwd=${encodeURIComponent(w.cwd)}`)}
									>
										Project
									</Button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			<AutoWorkConfigModal
				cwd={editingCwd}
				config={editingCwd ? configs[editingCwd] : undefined}
				onClose={() => setEditingCwd(undefined)}
				onSaved={(next) => {
					setConfigs((prev) => ({ ...prev, [next.workspaceCwd]: next }));
					setEditingCwd(undefined);
				}}
			/>
		</div>
	);
}

function AutoWorkConfigModal({
	cwd,
	config,
	onClose,
	onSaved,
}: {
	cwd: string | undefined;
	config: AutoWorkConfig | undefined;
	onClose: () => void;
	onSaved: (config: AutoWorkConfig) => void;
}) {
	const open = cwd !== undefined && config !== undefined;
	const navigate = useNavigate();
	const [draft, setDraft] = useState<AutoWorkConfig | undefined>(config);
	const [pickerPriority, setPickerPriority] = useState<TaskPriority | undefined>();
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (open) {
			setDraft(config);
			setError(undefined);
		}
		// Only re-sync the draft when the modal (re)opens or the underlying
		// config changes — not on every keystroke inside the draft itself.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, config]);

	if (!open || !draft || !cwd) {
		return null;
	}

	async function save(): Promise<void> {
		if (!cwd || !draft) return;
		const winError = draft.timeWindows.find((w) => w.start >= w.end);
		if (winError) {
			setError(`Window ${winError.start}:00–${winError.end}:00: start must be before end`);
			return;
		}
		setSaving(true);
		setError(undefined);
		try {
			const next = await api.setAutoWorkConfig(cwd, autoWorkConfigToRequest(draft));
			onSaved(next);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<Modal open={open} onClose={onClose} widthClass="max-w-xl">
				<div className="flex h-11 items-center gap-2 border-b border-line px-3">
					<div className="meta">Auto Work — {shortWorkspacePath(cwd)}</div>
				</div>
				<div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
					{error ? (
						<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
							{error}
						</div>
					) : null}

					<label className="flex items-center justify-between text-sm">
						<span>Enabled</span>
						<input
							type="checkbox"
							checked={draft.enabled}
							onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
						/>
					</label>

					<div>
						<label className="flex items-center justify-between text-sm">
							<span>Auto-merge PRs (no human in the loop)</span>
							<input
								type="checkbox"
								checked={draft.autoMerge}
								onChange={(e) => setDraft({ ...draft, autoMerge: e.target.checked })}
							/>
						</label>
						<div className="meta mt-1">
							Arms GitHub auto-merge (squash) on each PR and moves the task to <span className="font-mono">done</span> once
							CI passes — instead of parking it in <span className="font-mono">validate</span> for review. CI is the only
							gate; with no branch protection this merges agent work with no human review.
						</div>
					</div>

					<div>
						<div className="mb-1 flex items-center justify-between">
							<span className="meta">Execution windows (hour of day)</span>
							<Button
								variant="ghost"
								size="sm"
								onClick={() =>
									setDraft({ ...draft, timeWindows: [...draft.timeWindows, { start: 0, end: 24 }] })
								}
							>
								+ Add
							</Button>
						</div>
						{draft.timeWindows.length === 0 ? (
							<p className="text-xs text-ink-3">No windows — auto-work will never run.</p>
						) : (
							<ul className="space-y-1.5">
								{draft.timeWindows.map((w, i) => (
									// eslint-disable-next-line react/no-array-index-key
									<li key={i} className="flex items-center gap-2 text-sm">
										<input
											type="number"
											min={0}
											max={23}
											value={w.start}
											onChange={(e) => {
												const next = [...draft.timeWindows];
												next[i] = { ...w, start: Number(e.target.value) };
												setDraft({ ...draft, timeWindows: next });
											}}
											className="field h-8 w-16 px-2"
										/>
										<span className="text-ink-3">to</span>
										<input
											type="number"
											min={1}
											max={24}
											value={w.end}
											onChange={(e) => {
												const next = [...draft.timeWindows];
												next[i] = { ...w, end: Number(e.target.value) };
												setDraft({ ...draft, timeWindows: next });
											}}
											className="field h-8 w-16 px-2"
										/>
										<Button
											variant="ghost"
											size="sm"
											onClick={() =>
												setDraft({
													...draft,
													timeWindows: draft.timeWindows.filter((_, j) => j !== i),
												})
											}
										>
											Remove
										</Button>
									</li>
								))}
							</ul>
						)}
					</div>

					<div>
						<label className="mb-1 flex items-center justify-between text-sm">
							<span>Session spend limit</span>
							<span className="font-mono text-2xs text-ink-3">{draft.sessionPctLimit}%</span>
						</label>
						<input
							type="range"
							min={0}
							max={100}
							value={draft.sessionPctLimit}
							onChange={(e) => setDraft({ ...draft, sessionPctLimit: Number(e.target.value) })}
							className="w-full"
						/>
					</div>

					<div>
						<label className="mb-1 flex items-center justify-between text-sm">
							<span>Weekly spend limit</span>
							<span className="font-mono text-2xs text-ink-3">{draft.weeklyPctLimit}%</span>
						</label>
						<input
							type="range"
							min={0}
							max={100}
							value={draft.weeklyPctLimit}
							onChange={(e) => setDraft({ ...draft, weeklyPctLimit: Number(e.target.value) })}
							className="w-full"
						/>
					</div>

					<div>
						<label className="mb-1 flex items-center justify-between text-sm">
							<span>Weekly budget warning</span>
							<span className="font-mono text-2xs text-ink-3">{draft.weeklyPctThreshold}%</span>
						</label>
						<input
							type="range"
							min={0}
							max={100}
							value={draft.weeklyPctThreshold}
							onChange={(e) => setDraft({ ...draft, weeklyPctThreshold: Number(e.target.value) })}
							className="w-full"
						/>
						<div className="meta mt-1">Sends a Telegram heads-up (at most once/day) once weekly usage crosses this %.</div>
					</div>

					<div className="rounded-md border border-line bg-paper-2 px-3 py-2.5">
						<div className="meta mb-1">Agent model per difficulty</div>
						<p className="mb-2 text-2xs text-ink-3">
							Default agent and the per-difficulty agent mapping moved to Project
							Configuration, alongside the rest of this workspace's generic settings.
						</p>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								onClose();
								if (cwd) navigate(`/project-config?cwd=${encodeURIComponent(cwd)}`);
							}}
						>
							Open Project Configuration →
						</Button>
					</div>

					<div>
						<div className="meta mb-1">Model per priority (cost estimation only)</div>
						<ul className="divide-y divide-line rounded-md border border-line">
							{TASK_PRIORITIES.map((priority) => {
								const ref = draft.modelByPriority[priority];
								return (
									<li key={priority} className="flex items-center gap-2 px-2 py-1.5 text-sm">
										<span className="w-8 font-mono text-2xs text-ink-3">{priority}</span>
										<span className="min-w-0 flex-1 truncate font-mono text-2xs">
											{ref ? `${ref.provider}/${ref.id}` : "workspace default"}
										</span>
										<Button variant="ghost" size="sm" onClick={() => setPickerPriority(priority)}>
											Change
										</Button>
										{ref ? (
											<Button
												variant="ghost"
												size="sm"
												onClick={() =>
													setDraft({
														...draft,
														modelByPriority: { ...draft.modelByPriority, [priority]: null },
													})
												}
											>
												Clear
											</Button>
										) : null}
									</li>
								);
							})}
						</ul>
					</div>

					<div>
						<div className="meta mb-1">Default cost estimate per priority (% of session budget)</div>
						<p className="mb-1 text-2xs text-ink-3">
							Used to decide whether a task fits the remaining budget before history exists for that
							priority.
						</p>
						<ul className="divide-y divide-line rounded-md border border-line">
							{TASK_PRIORITIES.map((priority) => (
								<li key={priority} className="flex items-center gap-2 px-2 py-1.5 text-sm">
									<span className="w-8 font-mono text-2xs text-ink-3">{priority}</span>
									<input
										type="number"
										min={0}
										max={100}
										value={draft.defaultEstimatePctByPriority[priority]}
										onChange={(e) =>
											setDraft({
												...draft,
												defaultEstimatePctByPriority: {
													...draft.defaultEstimatePctByPriority,
													[priority]: Number(e.target.value),
												},
											})
										}
										className="field h-8 w-20 px-2"
									/>
									<span className="text-2xs text-ink-3">%</span>
								</li>
							))}
						</ul>
					</div>

					<div>
						<label className="mb-1 flex items-center justify-between text-sm">
							<span>Estimation safety buffer</span>
							<span className="font-mono text-2xs text-ink-3">{draft.estimationBuffer.toFixed(2)}x</span>
						</label>
						<input
							type="range"
							min={1}
							max={2}
							step={0.05}
							value={draft.estimationBuffer}
							onChange={(e) => setDraft({ ...draft, estimationBuffer: Number(e.target.value) })}
							className="w-full"
						/>
					</div>
				</div>
				<div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2">
					<Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
						Cancel
					</Button>
					<Button size="sm" onClick={() => void save()} disabled={saving}>
						{saving ? "Saving…" : "Save"}
					</Button>
				</div>
			</Modal>
			<AgentPickerModal
				open={pickerPriority !== undefined}
				onClose={() => setPickerPriority(undefined)}
				onPicked={(ref) => {
					if (pickerPriority) {
						setDraft({ ...draft, modelByPriority: { ...draft.modelByPriority, [pickerPriority]: ref } });
					}
					setPickerPriority(undefined);
				}}
			/>
		</>
	);
}

function PermissionCard({
	permission,
	onRequest,
}: {
	permission: ReturnType<typeof useNotificationPermission>["permission"];
	onRequest: () => void;
}) {
	const tone =
		permission === "granted"
			? "success"
			: permission === "denied"
				? "danger"
				: permission === "unsupported"
					? "muted"
					: "warn";
	const label =
		permission === "granted"
			? "Granted"
			: permission === "denied"
				? "Denied"
				: permission === "unsupported"
					? "Unsupported"
					: "Not requested";

	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="meta">Browser permission</div>
					<div className="mt-0.5 text-sm text-ink">
						OS-level notifications when the deck tab is in the background.
					</div>
				</div>
				<Badge tone={tone}>{label}</Badge>
			</div>
			<div className="mt-3 text-xs text-ink-3">
				{permission === "default" ? (
					<>
						Permission has not been requested yet. The deck will only emit OS notifications
						after you grant access.
					</>
				) : permission === "granted" ? (
					<>
						OS notifications will fire for items the server marks important
						(routine failures, long-running steps, agent task completions).
					</>
				) : permission === "denied" ? (
					<>
						The browser is blocking notifications for this site. Re-enable from the site
						settings — usually the lock icon next to the address bar — then reload.
					</>
				) : (
					<>This browser doesn't expose the Notifications API.</>
				)}
			</div>
			{permission === "default" ? (
				<div className="mt-3">
					<Button size="sm" variant="primary" onClick={onRequest}>
						Enable browser notifications
					</Button>
				</div>
			) : null}
		</div>
	);
}

function AudioCard({
	audioEnabled,
	onToggle,
}: {
	audioEnabled: boolean;
	onToggle: (enabled: boolean) => void;
}) {
	const levels: NotificationLevel[] = ["info", "warn", "error", "critical"];
	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="meta">Audio cues</div>
					<div className="mt-0.5 text-sm text-ink">
						Synthesized tones layered on top of OS notifications. Each level has
						a distinct sequence — info is short, critical is loud.
					</div>
				</div>
				<label className="flex items-center gap-2 text-xs text-ink-2">
					<input
						type="checkbox"
						checked={audioEnabled}
						onChange={(e) => onToggle(e.target.checked)}
					/>
					<span>{audioEnabled ? "Enabled" : "Muted"}</span>
				</label>
			</div>
			<div className="mt-3 flex flex-wrap gap-2">
				{levels.map((level) => (
					<Button
						key={level}
						size="sm"
						variant="outline"
						disabled={!audioEnabled}
						onClick={() => void playNotificationTone(level)}
					>
						<Play className="mr-1 h-3 w-3" />
						{level}
					</Button>
				))}
			</div>
			{!audioEnabled ? (
				<div className="mt-2 text-xs text-ink-3">Enable audio to preview tones.</div>
			) : null}
		</div>
	);
}

function BannerResetCard({
	bannerDismissed,
	permission,
	onReset,
}: {
	bannerDismissed: boolean;
	permission: ReturnType<typeof useNotificationPermission>["permission"];
	onReset: () => void;
}) {
	// Banner only ever shows when permission is "default" AND not dismissed,
	// so the reset is only meaningful in that combination.
	const canReset = bannerDismissed && permission === "default";
	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="meta">Permission banner</div>
					<div className="mt-0.5 text-sm text-ink">
						The top-of-page nudge that asks you to enable notifications.
					</div>
					<div className="mt-1 text-xs text-ink-3">
						{permission !== "default"
							? "Banner is suppressed because permission is already decided."
							: bannerDismissed
								? "You dismissed the banner. Reset to bring it back."
								: "Banner is currently visible."}
					</div>
				</div>
				<Button
					size="sm"
					variant="outline"
					disabled={!canReset}
					onClick={onReset}
				>
					<RotateCcw className="mr-1 h-3 w-3" />
					Reset banner
				</Button>
			</div>
		</div>
	);
}

function ServerIdentityCard({
	heartbeat,
	nowMs,
}: {
	heartbeat:
		| {
				lastReceivedAtMs: number;
				serverStartedAt: string;
				pid: number;
				uptimeSecs: number;
				buildSha: string | null;
				version: string;
		  }
		| null;
	nowMs: number;
}) {
	if (!heartbeat) {
		return (
			<div className="rounded-md border border-line bg-paper-2 p-4 text-xs text-ink-3">
				<div className="meta mb-1">Server identity</div>
				Waiting for the first heartbeat…
			</div>
		);
	}
	const ageMs = Math.max(0, nowMs - heartbeat.lastReceivedAtMs);
	const ageTone: "success" | "warn" | "danger" =
		ageMs < 10_000 ? "success" : ageMs < 30_000 ? "warn" : "danger";
	const ageLabel = ageMs < 1_000 ? "just now" : `${Math.round(ageMs / 1000)}s ago`;
	const shortSha = heartbeat.buildSha ? heartbeat.buildSha.slice(0, 7) : "unknown";
	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="meta">Server identity</div>
				<Badge tone={ageTone}>last heartbeat {ageLabel}</Badge>
			</div>
			<dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-xs text-ink-2">
				<dt className="text-ink-3">pid</dt>
				<dd>{heartbeat.pid}</dd>
				<dt className="text-ink-3">version</dt>
				<dd>{heartbeat.version}</dd>
				<dt className="text-ink-3">build</dt>
				<dd>{shortSha}</dd>
				<dt className="text-ink-3">started</dt>
				<dd>{new Date(heartbeat.serverStartedAt).toLocaleString()}</dd>
				<dt className="text-ink-3">uptime</dt>
				<dd>{formatUptime(heartbeat.serverStartedAt)}</dd>
			</dl>
		</div>
	);
}

function RecentNotificationsCard({
	items,
	onDismiss,
}: {
	items: ReadonlyArray<NotificationItem>;
	onDismiss: (id: string) => void;
}) {
	return (
		<div className="rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="meta">Recent activity</div>
				<div className="mt-0.5 text-xs text-ink-3">
					Latest server-emitted notifications. Capped at 50 in memory; this list
					shows the freshest 20.
				</div>
			</div>
			{items.length === 0 ? (
				<div className="px-3 py-6 text-center text-xs text-ink-3">
					No notifications yet.
				</div>
			) : (
				<ul className="divide-y divide-line">
					{items.map((item) => (
						<li
							key={item.id}
							className={cn(
								"flex items-start gap-3 px-3 py-2 text-sm",
								item.dismissed && "opacity-60",
							)}
						>
							<Badge tone={notificationLevelTone(item.level)}>{item.level}</Badge>
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium text-ink">{item.title}</div>
								{item.body ? (
									<div className="mt-0.5 text-xs text-ink-2">{item.body}</div>
								) : null}
								<div className="mt-1 font-mono text-2xs text-ink-3">
									{new Date(item.timestamp).toLocaleString()}
									{item.source ? ` · ${item.source}` : ""}
								</div>
							</div>
							{!item.dismissed ? (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => onDismiss(item.id)}
									aria-label="Dismiss"
									title="Dismiss"
								>
									<X className="h-3 w-3" />
								</Button>
							) : null}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function notificationLevelTone(
	level: NotificationLevel,
): "default" | "accent" | "warn" | "danger" | "success" | "muted" {
	switch (level) {
		case "info":
			return "accent";
		case "warn":
			return "warn";
		case "error":
			return "danger";
		case "critical":
			return "danger";
		default:
			return "default";
	}
}

function ThemeCard({
	definition,
	isActive,
	isPinned,
	onPick,
}: {
	definition: (typeof THEMES)[number];
	isActive: boolean;
	isPinned: boolean;
	onPick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onPick}
			data-theme-preview={definition.id}
			aria-pressed={isActive}
			className={cn(
				"group flex flex-col gap-3 rounded-md border bg-paper p-3 text-left transition-colors",
				isActive ? "border-accent ring-1 ring-accent/40" : "border-line hover:border-ink/30",
			)}
		>
			<div className="flex items-center justify-between gap-2">
				<div>
					<div className="text-sm font-semibold text-ink">{definition.label}</div>
					<div className="mt-0.5 text-xs text-ink-3">{definition.description}</div>
				</div>
				<div className="flex shrink-0 flex-col items-end gap-1">
					{isActive ? <Badge tone="accent">active</Badge> : null}
					{!isActive && isPinned ? <Badge tone="muted">pinned</Badge> : null}
				</div>
			</div>
			<ThemeSwatchStrip definition={definition} />
		</button>
	);
}

function ThemeSwatchStrip({ definition }: { definition: (typeof THEMES)[number] }) {
	// Render swatches inside an isolated `data-theme="..."` wrapper so each card
	// shows its OWN palette regardless of which theme the rest of the UI uses.
	return (
		<div
			data-theme={definition.id}
			className="grid grid-cols-4 gap-1.5 rounded-md border border-line/60 bg-paper p-1.5"
		>
			{definition.swatchTokens.map((s) => (
				<div key={s.token} className="flex flex-col items-stretch gap-1">
					<div
						className="h-8 w-full rounded"
						style={{ backgroundColor: `rgb(var(--${s.token}))` }}
					/>
					<div className="text-center font-mono text-2xs uppercase tracking-meta text-ink-3">
						{s.label}
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * Internal prompts and lifecycle controls that shape deck-created sessions.
 */
function InternalPromptsSection() {
	return (
		<div className="mx-auto max-w-5xl space-y-6">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Internal prompts</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					Configure the base prompt, automatic title prompt, and maintenance gate. Changes apply to new sessions or the next matching invocation.
				</p>
			</div>
			<PreludeCard />
			<MaintenanceGateCard />
		</div>
	);
}

function PreludeCard() {
	const [data, setData] = useState<PreludeResponse | null>(null);
	const [draft, setDraft] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<string | undefined>();

	async function refresh(): Promise<void> {
		try {
			const next = await orientationApi.getPrelude();
			setData(next);
			setDraft(next.override ?? next.default);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	const usingOverride = data ? data.override !== null : false;
	const dirty = data ? draft !== (data.override ?? data.default) : false;

	async function save(): Promise<void> {
		setSaving(true);
		try {
			const next = await orientationApi.putPrelude({ value: draft });
			setData(next);
			setDraft(next.override ?? next.default);
			setStatus("Saved. New sessions will use this prelude.");
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	async function resetToDefault(): Promise<void> {
		setSaving(true);
		try {
			const next = await orientationApi.putPrelude({ value: null });
			setData(next);
			setDraft(next.default);
			setStatus("Override cleared. New sessions will use the bundled default.");
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="meta">Prelude</div>
					{usingOverride ? <Badge tone="accent">override</Badge> : <Badge tone="muted">default</Badge>}
				</div>
				<p className="mt-1 text-xs text-ink-3">Prepended to every session&rsquo;s system prompt at <code className="font-mono">createAgentSession</code>. Operational instructions live here, so every new session can follow them.</p>
				<div className="mt-1 font-mono text-2xs text-ink-3">
					{data?.path ?? "..."}
				</div>
			</div>
			<div className="space-y-3 p-4">
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{status ? (
					<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
						{status}
					</div>
				) : null}
				{loading ? (
					<div className="text-sm text-ink-3">Loading...</div>
				) : (
					<>
						<textarea
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							spellCheck={false}
							className="block min-h-[320px] w-full resize-y rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-xs leading-relaxed text-ink"
						/>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
								<Save className="h-3.5 w-3.5" />
								Save
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => void resetToDefault()}
								disabled={saving || !usingOverride}
							>
								<RotateCcw className="h-3.5 w-3.5" />
								Reset to default
							</Button>
							{dirty ? (
								<span className="font-mono text-2xs text-warn">Unsaved changes</span>
							) : null}
						</div>
					</>
				)}
			</div>
		</div>
	);
}


function MaintenanceGateCard() {
	const [data, setData] = useState<MaintenanceGateState | null>(null);
	const [draft, setDraft] = useState<{
		enabled: boolean;
		minOpMsgs: string;
		minReleaseAgeMs: string;
		fireFloorMs: string;
	} | null>(null);
	const [previewMode, setPreviewMode] = useState<"deck" | "flat-file">("deck");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<string | undefined>();

	async function refresh(): Promise<void> {
		try {
			const next = await orientationApi.getMaintenanceGate();
			setData(next);
			setDraft({
				enabled: next.enabled,
				minOpMsgs: String(next.knobs.minOpMsgs.rawValue ?? ""),
				minReleaseAgeMs: String(next.knobs.minReleaseAgeMs.rawValue ?? ""),
				fireFloorMs: String(next.knobs.fireFloorMs.rawValue ?? ""),
			});
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	function parseKnob(value: string): number | null {
		const trimmed = value.trim();
		if (trimmed === "") return null;
		const n = Number.parseInt(trimmed, 10);
		return Number.isFinite(n) && n > 0 ? n : NaN;
	}

	async function save(): Promise<void> {
		if (!draft) return;
		const parsedOp = parseKnob(draft.minOpMsgs);
		const parsedRel = parseKnob(draft.minReleaseAgeMs);
		const parsedFire = parseKnob(draft.fireFloorMs);
		if (Number.isNaN(parsedOp) || Number.isNaN(parsedRel) || Number.isNaN(parsedFire)) {
			setError("Each knob must be a positive integer or empty (to clear override).");
			return;
		}
		setSaving(true);
		try {
			const next = await orientationApi.putMaintenanceGate({
				enabled: draft.enabled,
				minOpMsgs: parsedOp,
				minReleaseAgeMs: parsedRel,
				fireFloorMs: parsedFire,
			});
			setData(next);
			setDraft({
				enabled: next.enabled,
				minOpMsgs: String(next.knobs.minOpMsgs.rawValue ?? ""),
				minReleaseAgeMs: String(next.knobs.minReleaseAgeMs.rawValue ?? ""),
				fireFloorMs: String(next.knobs.fireFloorMs.rawValue ?? ""),
			});
			setStatus("Saved. Gate will use these values on the next evaluation.");
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	const profile: "deck" | "flat-file" | "inactive" = !data
		? "inactive"
		: !data.enabled
			? "inactive"
			: data.orgRoot
				? "deck"
				: "flat-file";

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="meta">Maintenance gate</div>
					{profile === "deck" ? <Badge tone="accent">deck profile</Badge> : null}
					{profile === "flat-file" ? <Badge tone="default">flat-file profile</Badge> : null}
					{profile === "inactive" ? <Badge tone="muted">inactive</Badge> : null}
				</div>
				<p className="mt-1 text-xs text-ink-3">
					Nudges the agent at <code className="font-mono">turn_end</code> to capture
					insights / decisions / tasks into the appropriate destination. Fires at
					most once per release segment, gated by three floors. Disabling here
					skips org-root detection so even an unaltered installed extension
					stays silent.
				</p>
				<div className="mt-1 space-y-0.5 font-mono text-2xs text-ink-3">
					<div>extension: {data?.installedExtensionPath ?? "..."}</div>
					<div>installed: {data ? (data.installedExtensionPresent ? "yes" : "missing") : "..."}</div>
					<div>OMP_DECK_ORG_ROOT: {data?.orgRoot ?? "(unset)"} ({data?.orgRootSource ?? ""})</div>
				</div>
			</div>
			<div className="space-y-4 p-4">
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{status ? (
					<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
						{status}
					</div>
				) : null}
				{loading || !draft || !data ? (
					<div className="text-sm text-ink-3">Loading...</div>
				) : (
					<>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={draft.enabled}
								onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
							/>
							<span>Enabled</span>
							<span className="ml-2 font-mono text-2xs text-ink-3">
								OMP_DECK_MAINTENANCE_GATE_DISABLED = {data.disabledRaw ?? "(unset)"} ({data.disabledSource})
							</span>
						</label>

						<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
							<GateKnobInput
								label="minOpMsgs"
								help="Operator messages since last release"
								knob={data.knobs.minOpMsgs}
								value={draft.minOpMsgs}
								onChange={(v) => setDraft({ ...draft, minOpMsgs: v })}
							/>
							<GateKnobInput
								label="minReleaseAgeMs"
								help="Wall-clock ms since last release"
								knob={data.knobs.minReleaseAgeMs}
								value={draft.minReleaseAgeMs}
								onChange={(v) => setDraft({ ...draft, minReleaseAgeMs: v })}
							/>
							<GateKnobInput
								label="fireFloorMs"
								help="Wall-clock ms between fires (cross-session)"
								knob={data.knobs.fireFloorMs}
								value={draft.fireFloorMs}
								onChange={(v) => setDraft({ ...draft, fireFloorMs: v })}
							/>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => void save()} disabled={saving}>
								<Save className="h-3.5 w-3.5" />
								Save
							</Button>
							<Button size="sm" variant="outline" onClick={() => void refresh()} disabled={saving}>
								<RotateCcw className="h-3.5 w-3.5" />
								Reload
							</Button>
							{!data.installedExtensionPresent ? (
								<span className="font-mono text-2xs text-warn">
									Extension not installed at expected path; knob changes won&rsquo;t take effect until
									it&rsquo;s restored.
								</span>
							) : null}
						</div>

						<div className="overflow-hidden rounded-md border border-line bg-paper-2">
							<div className="flex items-center gap-2 border-b border-line px-3 py-2">
								<div className="meta">Reminder preview</div>
								<div className="ml-auto flex items-center gap-1">
									<Button
										size="sm"
										variant={previewMode === "deck" ? "primary" : "outline"}
										onClick={() => setPreviewMode("deck")}
									>
										deck
									</Button>
									<Button
										size="sm"
										variant={previewMode === "flat-file" ? "primary" : "outline"}
										onClick={() => setPreviewMode("flat-file")}
									>
										flat-file
									</Button>
								</div>
							</div>
							<pre className="overflow-x-auto whitespace-pre-wrap px-3 py-2 font-mono text-2xs leading-relaxed text-ink-2">
								{previewMode === "deck" ? data.preview.deckMode : data.preview.flatFileMode}
							</pre>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function GateKnobInput({
	label,
	help,
	knob,
	value,
	onChange,
}: {
	label: string;
	help: string;
	knob: GateKnob;
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<label className="block space-y-1">
			<span className="meta">{label}</span>
			<input
				type="text"
				inputMode="numeric"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={String(knob.default)}
				className="block w-full rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
			/>
			<div className="font-mono text-2xs text-ink-3">
				{help}
			</div>
			<div className="font-mono text-2xs text-ink-3">
				effective {knob.value} · default {knob.default} · source {knob.source}
			</div>
		</label>
	);
}

function StubSection({ section }: { section: Exclude<SectionId, "env" | "messaging" | "appearance" | "notifications"> }) {
	const spec = SECTIONS.find((s) => s.id === section)!;
	return (
		<div className="mx-auto max-w-3xl rounded-md border border-dashed border-line bg-paper-2 p-6">
			<div className="meta">{spec.label}</div>
			<h1 className="mt-2 text-xl font-semibold">Not built yet</h1>
			<p className="mt-1 text-sm text-ink-3">This section is reserved so the settings layout is stable.</p>
		</div>
	);
}

function SettingsSideRail() {
	return <div className="p-3 text-xs text-ink-3">Settings</div>;
}

function SettingsInspector() {
	return (
		<div className="space-y-2 p-3 text-xs text-ink-3">
			<div className="meta">Settings notes</div>
			<p>Secrets are masked in list responses. Replace values here; do not reveal unless using the loopback API directly.</p>
		</div>
	);
}

function normalizeSection(raw: string | null): SectionId {
	return SECTIONS.some((s) => s.id === raw) ? (raw as SectionId) : "env";
}

function sourceLabel(source: EnvEntry["source"]): string {
	if (source === "process-env") return "process env";
	if (source === "env-file") return ".env file";
	return source;
}

function sourceTone(source: EnvEntry["source"]): "accent" | "default" | "muted" {
	if (source === "process-env") return "accent";
	if (source === "env-file") return "default";
	return "muted";
}

function envApplyBadge(entry: EnvEntry) {
	if (entry.hotApply) return <Badge tone="success">hot</Badge>;
	if (entry.restartTarget === "telegram-bridge") return <Badge tone="warn">bridge restart</Badge>;
	if (entry.restartRequired) return <Badge tone="warn">server restart</Badge>;
	return <Badge tone="muted">manual</Badge>;
}

function bridgeStatusTone(status: BridgeInfo["status"]): "success" | "muted" | "warn" | "danger" {
	if (status === "running") return "success";
	if (status === "starting") return "warn";
	if (status === "crashed") return "danger";
	return "muted";
}

function bridgeStatusLabel(status: BridgeInfo["status"], info: BridgeInfo | undefined): string {
	if (status === "running") return "running";
	if (status === "starting") return "starting";
	if (status === "crashed") return info?.exitSignal ? `crashed (${info.exitSignal})` : "crashed";
	if (info && info.missingEnv.length > 0) return "missing credentials";
	return "stopped";
}

function formatUptime(startedIso: string): string {
	const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedIso)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d${hours % 24}h`;
}

/**
 * Providers section — list every OAuth-capable provider with its current
 * auth state. Login opens OAuthFlowModal; Revoke clears credentials and
 * fires `models_changed` server-side so the picker re-empties without a
 * deck restart. See docs/oauth-deck-sdk-findings.md for the SDK contract.
 */
function ProvidersSection() {
	const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(true);
	const [activeFlow, setActiveFlow] = useState<{ id: string; name: string } | null>(null);
	const [confirmRevoke, setConfirmRevoke] = useState<{ id: string; name: string } | null>(null);
	const [revoking, setRevoking] = useState(false);

	async function refresh(): Promise<void> {
		try {
			const resp = await authApi.listProviders();
			setProviders(resp.providers);
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	async function revoke(): Promise<void> {
		if (!confirmRevoke) return;
		setRevoking(true);
		try {
			await authApi.revoke(confirmRevoke.id);
			setConfirmRevoke(null);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRevoking(false);
		}
	}

	if (loading) {
		return <div className="font-mono text-2xs text-ink-3">Loading providers…</div>;
	}
	if (error) {
		return (
			<div className="rounded border border-danger/40 bg-danger/5 p-3 text-xs text-danger">
				{error}
			</div>
		);
	}
	if (!providers) return null;

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="meta">Providers</h2>
				<p className="mt-1 text-xs text-ink-3">
					OAuth sign-in to subscription providers (Claude Pro/Max, ChatGPT Plus/Pro, etc.).
					API keys live under <strong>Env</strong> — this surface is for browser-flow auth.
				</p>
			</div>
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				{providers.map((p) => (
					<ProviderCard
						key={p.id}
						info={p}
						onLogin={() => setActiveFlow({ id: p.id, name: p.name })}
						onRevoke={() => setConfirmRevoke({ id: p.id, name: p.name })}
					/>
				))}
			</div>
			<OAuthFlowModal
				open={activeFlow !== null}
				provider={activeFlow?.id ?? null}
				providerName={activeFlow?.name ?? null}
				onClose={() => setActiveFlow(null)}
				onComplete={() => {
					setActiveFlow(null);
					void refresh();
				}}
			/>
			<Modal open={confirmRevoke !== null} onClose={() => setConfirmRevoke(null)} widthClass="max-w-md">
				<div className="flex flex-col gap-3 p-5">
					<h2 className="text-base font-semibold text-ink">
						Sign out of {confirmRevoke?.name}?
					</h2>
					<p className="text-xs text-ink-3">
						The stored credentials will be deleted from <code>auth.db</code>. Token refresh
						will fail until you log in again. Other deck instances sharing the same
						<code>OMP_AGENT_DIR</code> will lose access too.
					</p>
					<div className="flex justify-end gap-2 border-t border-line pt-3">
						<Button variant="ghost" onClick={() => setConfirmRevoke(null)} disabled={revoking}>
							Cancel
						</Button>
						<Button variant="danger" onClick={revoke} disabled={revoking}>
							{revoking ? "Signing out…" : "Sign out"}
						</Button>
					</div>
				</div>
			</Modal>
		</div>
	);
}

function ProviderCard({
	info,
	onLogin,
	onRevoke,
}: {
	info: ProviderInfo;
	onLogin: () => void;
	onRevoke: () => void;
}) {
	const tone =
		info.state === "oauth"
			? "border-success/40 bg-success/5"
			: info.state === "api-key"
				? "border-accent/30 bg-accent-soft/40"
				: "border-line bg-paper-2/30";
	const stateLabel =
		info.state === "oauth"
			? "OAuth (subscription)"
			: info.state === "api-key"
				? "API key configured"
				: "Not configured";
	const stateBadgeTone: "success" | "accent" | "default" =
		info.state === "oauth" ? "success" : info.state === "api-key" ? "accent" : "default";
	return (
		<div className={cn("flex flex-col gap-2 rounded border p-3", tone)}>
			<div className="flex items-baseline justify-between gap-2">
				<div className="truncate text-sm font-medium text-ink" title={info.name}>
					{info.name}
				</div>
				<Badge tone={stateBadgeTone}>{stateLabel}</Badge>
			</div>
			<div className="font-mono text-2xs text-ink-4">
				{info.id}
				{info.count > 1 ? <span className="ml-1.5">· {info.count} credentials</span> : null}
			</div>
			<div className="mt-1 flex gap-2">
				{info.state === "unconfigured" ? (
					<Button variant="primary" onClick={onLogin} className="flex-1">
						Login
					</Button>
				) : info.state === "oauth" ? (
					<>
						<Button variant="outline" onClick={onLogin} className="flex-1">
							Replace
						</Button>
						<Button variant="ghost" onClick={onRevoke}>
							Sign out
						</Button>
					</>
				) : (
					<Button variant="outline" onClick={onLogin} className="flex-1">
						Login (replaces API key)
					</Button>
				)}
			</div>
		</div>
	);
}
