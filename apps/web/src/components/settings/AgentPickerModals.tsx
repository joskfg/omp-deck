import { useEffect, useState } from "react";
import type { ModelInfo, ModelRef } from "@omp-deck/protocol";

import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";
import { useModelCatalog } from "@/lib/model-catalog";
import { cn } from "@/lib/utils";

/** Last path segment of a workspace cwd, for compact labels in modal titles. */
export function shortWorkspacePath(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}

/**
 * Generic `ModelRef` picker — no thinking-level step, just a searchable list
 * grouped by provider. Backs every "pick an agent for this slot" flow that
 * doesn't touch a workspace's own default model (auto-work per-priority and
 * per-difficulty maps, both per-workspace and global). Reuses `useModelCatalog`
 * (the fetch/filter/group hook behind `ModelPickerModal`) rather than that
 * component directly — `ModelPickerModal` is hardwired to PATCH the active
 * session's model on pick, which doesn't apply here.
 */
export function AgentPickerModal({
	open,
	onClose,
	onPicked,
}: {
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
				<div className="meta">Pick a model</div>
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

/**
 * Default agent (model + thinking level) for one workspace, backing
 * `WorkspacePreference` (`PUT /workspace-preferences?cwd=`). Session creation
 * resolves model precedence as: explicit per-session choice > this override >
 * SDK/OMP_MODEL global default (see `routes.ts` `POST /sessions`).
 */
export function WorkspaceDefaultAgentModal({
	cwd,
	onClose,
	onPicked,
}: {
	cwd: string | undefined;
	onClose: () => void;
	onPicked: () => void;
}) {
	const open = cwd !== undefined;
	const { loading, error: catalogError, query, setQuery, grouped } = useModelCatalog(undefined, open);
	const [selectedModel, setSelectedModel] = useState<ModelInfo | undefined>();
	const [selectedThinking, setSelectedThinking] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setSelectedModel(undefined);
		setSelectedThinking(undefined);
		setError(undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// When the selected model changes, clear thinking if the new model doesn't support it.
	useEffect(() => {
		if (!selectedModel?.thinkingLevels?.length) {
			setSelectedThinking(undefined);
		}
	}, [selectedModel]);

	async function save(): Promise<void> {
		if (!cwd || !selectedModel) return;
		setBusy(true);
		setError(undefined);
		try {
			await api.setWorkspacePreference(
				cwd,
				{ provider: selectedModel.provider, id: selectedModel.id },
				selectedThinking ?? null,
			);
			onPicked();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	const thinkingLevels = selectedModel?.thinkingLevels;

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-xl">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="meta">Default agent — {cwd ? shortWorkspacePath(cwd) : ""}</div>
			</div>
			<div className="border-b border-line px-3 py-2">
				<input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Filter by name, id, or provider"
					className="field h-8 w-full px-2 text-sm"
				/>
			</div>
			{error ?? catalogError ? (
				<div className="mx-3 my-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error ?? catalogError}
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
							const active = selectedModel?.provider === m.provider && selectedModel?.id === m.id;
							return (
								<button
									key={`${m.provider}/${m.id}`}
									type="button"
									onClick={() => setSelectedModel(active ? undefined : m)}
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
				<button type="button" onClick={onClose} className="btn-ghost h-8 px-3 text-xs" disabled={busy}>
					Cancel
				</button>
				<button
					type="button"
					onClick={() => void save()}
					disabled={busy || !selectedModel}
					className={cn("btn-primary h-8 px-3 text-xs", (busy || !selectedModel) && "opacity-60")}
				>
					{busy ? "Saving…" : "Save"}
				</button>
			</div>
		</Modal>
	);
}
