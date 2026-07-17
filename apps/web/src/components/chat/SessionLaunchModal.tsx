import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, FolderOpen, Loader2, Search } from "lucide-react";
import type { ModelInfo, ModelRef } from "@omp-deck/protocol";

import { DirBrowserModal } from "@/components/DirBrowserModal";
import { Modal } from "@/components/ui/Modal";
import { useModelCatalog } from "@/lib/model-catalog";
import { useStore } from "@/lib/store";
import { cn, shortPath } from "@/lib/utils";
import { formatContext } from "./ModelPickerModal";

export interface SessionLaunchOpts {
	cwd: string;
	model?: ModelRef;
	planMode: boolean;
	/** Trimmed, non-empty initial prompt, or `undefined` when left blank. */
	initialPrompt?: string;
	/** Thinking level selected at launch time (T-73). Only set when the model supports it. */
	thinking?: string;
}

/** Sentinel `<select>` value that switches the workspace picker into
 * free-text mode for a path that isn't a known workspace yet. Mirrors
 * `SessionPicker`/`Sidebar`'s `CUSTOM_CWD_VALUE`. */
const CUSTOM_CWD_VALUE = "__custom__";

interface Props {
	open: boolean;
	/** Heading shown in the modal titlebar, e.g. "New session" or "Send to agent — T-44". */
	title?: string;
	confirmLabel?: string;
	initialCwd: string;
	/** When false, the workspace is fixed to `initialCwd` (still shown, read-only). */
	allowWorkspaceChange?: boolean;
	/**
	 * Pre-selected model suggestion (T-109). When set, the model picker opens
	 * with this model already chosen (modelTouched=true so the workspace default
	 * doesn't override it). The user can still pick any other model.
	 */
	initialModel?: ModelRef;
	onCancel: () => void;
	/**
	 * Creates the session. Throwing keeps the modal open with the error
	 * surfaced inline and every field (workspace/model/plan mode) intact so
	 * the user can retry without re-entering anything (T-41).
	 */
	onConfirm: (opts: SessionLaunchOpts) => Promise<void>;
	/**
	 * Show the optional "Initial prompt" textarea. Off for Tasks/Inbox launches
	 * (T-41/T-44), which already build their own contextual draft from the
	 * task/inbox item — showing a second free-form field there would be
	 * redundant and confusing. On (default) for plain "New session" entry
	 * points, where it lets the user hand the agent an instruction up front
	 * without needing Plan Mode just to avoid an empty first turn.
	 */
	showInitialPrompt?: boolean;
}

/**
 * Shared "how should this session start" panel (T-40). Presents workspace,
 * model, and Plan Mode as one atomic choice consumed by `POST /sessions`
 * (T-39) so every "New session" entry point — Sidebar, SessionPicker, chat
 * header, and Tasks/Inbox "Open in chat" / "Send to agent" (T-41/T-44) —
 * produces the same request shape for equivalent choices.
 */
export function SessionLaunchModal({
	open,
	title = "New session",
	confirmLabel = "Start session",
	initialCwd,
	initialModel,
	allowWorkspaceChange = true,
	onCancel,
	onConfirm,
	showInitialPrompt = true,
}: Props) {
	const workspaces = useStore((s) => s.workspaces);
	const defaultCwd = useStore((s) => s.defaultCwd);

	const [selectedCwd, setSelectedCwd] = useState<string>(initialCwd);
	const [customCwd, setCustomCwd] = useState<string>("");
	const [browsing, setBrowsing] = useState(false);
	const [planMode, setPlanMode] = useState(false);
	const [model, setModel] = useState<ModelRef | undefined>(undefined);
	const [modelTouched, setModelTouched] = useState(false);
	const [thinking, setThinking] = useState<string | undefined>(undefined);
	const [thinkingTouched, setThinkingTouched] = useState(false);
	const [initialPrompt, setInitialPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const isCustomCwd = selectedCwd === CUSTOM_CWD_VALUE;
	const cwd = isCustomCwd ? customCwd.trim() : selectedCwd || defaultCwd;

	// Reset transient UI state fresh on every open — but NOT on error, so a
	// failed create (T-41 retry requirement) keeps the user's choices intact.
	useEffect(() => {
		if (!open) return;
		setSelectedCwd(initialCwd || defaultCwd);
		setCustomCwd("");
		setPlanMode(false);
		setModel(initialModel ?? undefined);
		setModelTouched(initialModel !== undefined);
		setThinking(undefined);
		setThinkingTouched(false);
		setInitialPrompt("");
		setError(undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const workspaceDefaultModel = useMemo(
		() => workspaces.find((w) => w.cwd === cwd)?.defaultModel,
		[workspaces, cwd],
	);
	const workspaceDefaultThinking = useMemo(
		() => workspaces.find((w) => w.cwd === cwd)?.defaultThinking,
		[workspaces, cwd],
	);

	// Preselect the workspace's effective default model (T-42) the first time
	// it becomes known for the chosen cwd, unless the user already picked one.
	useEffect(() => {
		if (modelTouched) return;
		if (workspaceDefaultModel) setModel(workspaceDefaultModel);
	}, [workspaceDefaultModel, modelTouched]);

	// Preselect the workspace's effective default thinking level (T-73).
	useEffect(() => {
		if (thinkingTouched) return;
		if (workspaceDefaultThinking) setThinking(workspaceDefaultThinking);
	}, [workspaceDefaultThinking, thinkingTouched]);

	const {
		loading: modelsLoading,
		error: modelsError,
		query,
		setQuery,
		availableCount,
		grouped,
	} = useModelCatalog(undefined, open);

	async function confirm(): Promise<void> {
		if (isCustomCwd && !cwd) return;
		setBusy(true);
		setError(undefined);
		try {
			const trimmedPrompt = initialPrompt.trim();
			await onConfirm({ cwd, model, planMode, initialPrompt: trimmedPrompt || undefined, thinking });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	// Flat, keyboard-navigable ordering of the model list: the leading "Use
	// default" entry followed by every model across every provider group, in
	// display order. Mirrors `SlashCommandPicker`'s selectedIndex idiom.
	type ModelEntry = { kind: "default" } | { kind: "model"; model: (typeof grouped)[number]["items"][number] };
	const flatEntries = useMemo<ModelEntry[]>(
		() => [{ kind: "default" }, ...grouped.flatMap((g) => g.items.map((m) => ({ kind: "model" as const, model: m })))],
		[grouped],
	);
	const flatIndexByKey = useMemo(() => {
		const map = new Map<string, number>();
		flatEntries.forEach((entry, i) => {
			if (entry.kind === "model") map.set(`${entry.model.provider}/${entry.model.id}`, i);
		});
		return map;
	}, [flatEntries]);

	// -1 = nothing keyboard-highlighted yet (fall back to the `active`/selected
	// styling). Reset on every fresh search and whenever the modal closes so a
	// stale highlight doesn't survive into the next open.
	const [highlightedIndex, setHighlightedIndex] = useState(-1);
	useEffect(() => {
		setHighlightedIndex(-1);
	}, [query, open]);

	const modelItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
	useEffect(() => {
		if (highlightedIndex < 0) return;
		modelItemRefs.current[highlightedIndex]?.scrollIntoView({ block: "nearest" });
	}, [highlightedIndex]);

	// Derive the full ModelInfo for the currently selected model — needed to
	// check whether it supports thinking (T-73). The catalog is already loaded.
	const selectedModelInfo = useMemo<ModelInfo | undefined>(() => {
		if (!model) return undefined;
		for (const g of grouped) {
			const found = g.items.find((m) => m.provider === model.provider && m.id === model.id);
			if (found) return found;
		}
		return undefined;
	}, [model, grouped]);

	const selectedThinkingLevels = selectedModelInfo?.thinkingLevels;

	function selectEntry(entry: ModelEntry): void {
		if (entry.kind === "default") {
			setModel(undefined);
			// "Use default" model — can't know thinking support, so clear selection.
			setThinking(undefined);
			setThinkingTouched(false);
		} else {
			setModel({ provider: entry.model.provider, id: entry.model.id });
			// If the new model doesn't support thinking (or its levels don't include
			// the current choice), reset thinking so the workspace default can apply.
			const newLevels = entry.model.thinkingLevels;
			if (!newLevels || newLevels.length === 0) {
				setThinking(undefined);
				setThinkingTouched(false);
			} else if (thinking && !newLevels.includes(thinking) && thinking !== "off") {
				setThinking(undefined);
				setThinkingTouched(false);
			}
		}
		setModelTouched(true);
	}

	// Ctrl/Cmd+Enter starts the session from anywhere inside the modal
	// (workspace input, model search, initial prompt) — mirrors the desktop
	// convention of "submit the form" without swallowing plain Enter, which
	// textareas/the model search still need for newlines/entry-selection.
	function handleContentKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
		if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
		e.preventDefault();
		if (busy) return;
		void confirm();
	}

	function handleModelSearchKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
		if (e.ctrlKey || e.metaKey) return; // let Change 1's handler above handle Ctrl/Cmd+Enter
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setHighlightedIndex((i) => Math.min(i + 1, flatEntries.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setHighlightedIndex((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter" && highlightedIndex >= 0) {
			e.preventDefault();
			const entry = flatEntries[highlightedIndex];
			if (entry) selectEntry(entry);
		}
	}

	return (
		<Modal open={open} onClose={onCancel} widthClass="max-w-2xl">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="meta">{title}</div>
			</div>

			<div className="max-h-[70vh] overflow-y-auto px-4 py-3" onKeyDown={handleContentKeyDown}>
				<div className="mb-3">
					<div className="meta mb-1.5">Workspace</div>
					{allowWorkspaceChange ? (
						<>
							<select
								value={selectedCwd}
								onChange={(e) => setSelectedCwd(e.target.value)}
								className="field h-8 w-full px-2 font-mono text-xs"
							>
								<option value="">{`(default) ${defaultCwd}`}</option>
								<option value={CUSTOM_CWD_VALUE}>+ New path…</option>
								{workspaces
									.filter((w) => w.cwd !== defaultCwd)
									.map((w) => (
										<option key={w.cwd} value={w.cwd}>
											{w.label} · {w.cwd}
										</option>
									))}
							</select>
							{isCustomCwd ? (
								<div className="mt-2 flex gap-1.5">
									<input
										type="text"
										autoFocus
										value={customCwd}
										onChange={(e) => setCustomCwd(e.target.value)}
										placeholder="/absolute/path/to/project"
										spellCheck={false}
										className="field h-8 flex-1 px-2 font-mono text-xs"
									/>
									<button
										type="button"
										onClick={() => setBrowsing(true)}
										className="h-8 shrink-0 rounded border border-line bg-paper-2 px-2 text-ink-2 hover:bg-paper-3/60"
										title="Browse for a folder"
									>
										<FolderOpen className="h-3.5 w-3.5" />
									</button>
								</div>
							) : (
								<div className="mt-1.5 truncate font-mono text-2xs text-ink-3" title={cwd}>
									{shortPath(cwd, 80)}
								</div>
							)}
						</>
					) : (
						<div className="truncate rounded border border-line bg-paper-2 px-2 py-1.5 font-mono text-xs text-ink-2" title={cwd}>
							{cwd}
						</div>
					)}
				</div>

				<div className="mb-3">
					<div className="mb-1.5 flex items-center gap-2">
						<div className="meta">Model</div>
						{workspaceDefaultModel ? (
							<span className="font-mono text-2xs text-ink-4">
								workspace default: {workspaceDefaultModel.provider}/{workspaceDefaultModel.id}
							</span>
						) : (
							<span className="font-mono text-2xs text-ink-4">falls back to the global/SDK default</span>
						)}
					</div>
					<div className="flex items-center gap-2 rounded-md border border-line bg-paper-2 px-2 py-1.5">
						<Search className="h-3.5 w-3.5 shrink-0 text-ink-3" />
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={handleModelSearchKeyDown}
							placeholder="Filter by name, id, or provider — leave empty to use the default"
							className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-4 focus:outline-none"
						/>
						{modelsLoading ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-3" /> : null}
					</div>
					<div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-line">
						<button
							ref={(el) => {
								modelItemRefs.current[0] = el;
							}}
							type="button"
							onClick={() => {
								setModel(undefined);
								setModelTouched(true);
							}}
							onMouseEnter={() => setHighlightedIndex(0)}
							className={cn(
								"flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-sm transition-colors",
								!model ? "bg-accent-soft/40 text-accent" : "text-ink-2 hover:bg-paper-3/60",
								highlightedIndex === 0 && "ring-1 ring-inset ring-accent/50",
							)}
						>
							<span className="flex-1">Use default{workspaceDefaultModel ? " (workspace override above)" : ""}</span>
							{!model ? <Check className="h-4 w-4 shrink-0" /> : null}
						</button>
						{modelsError ? (
							<div className="px-3 py-3 font-mono text-2xs text-danger">{modelsError}</div>
						) : (
							grouped.map((g) => (
								<div key={g.provider}>
									<div className="border-b border-line bg-paper-2 px-3 py-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
										{g.provider}
									</div>
									{g.items.map((m) => {
										const active = model?.provider === m.provider && model?.id === m.id;
										const idx = flatIndexByKey.get(`${m.provider}/${m.id}`) ?? -1;
										return (
											<button
												key={`${m.provider}/${m.id}`}
												ref={(el) => {
													if (idx >= 0) modelItemRefs.current[idx] = el;
												}}
												type="button"
												onClick={() => {
													setModel({ provider: m.provider, id: m.id });
													setModelTouched(true);
												}}
												onMouseEnter={() => {
													if (idx >= 0) setHighlightedIndex(idx);
												}}
												className={cn(
													"flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-sm last:border-b-0 transition-colors",
													active ? "bg-accent-soft/40 text-accent" : "text-ink hover:bg-paper-3/60",
													idx >= 0 && idx === highlightedIndex && "ring-1 ring-inset ring-accent/50",
												)}
											>
												<span className="min-w-0 flex-1 truncate">{m.label}</span>
												{m.contextWindow ? (
													<span className="shrink-0 font-mono text-2xs text-ink-3">
														ctx {formatContext(m.contextWindow)}
													</span>
												) : null}
												{active ? <Check className="h-4 w-4 shrink-0" /> : null}
											</button>
										);
									})}
								</div>
							))
						)}
						{!modelsLoading && !modelsError && grouped.length === 0 ? (
							<div className="px-3 py-3 text-center text-xs text-ink-3">
								No matching models with configured auth ({availableCount} available total).
							</div>
						) : null}
					</div>
					<div className="mt-1 font-mono text-2xs text-ink-4">
						↑↓ navigate · enter pick · ctrl+enter start session
					</div>
				</div>

				{selectedThinkingLevels && selectedThinkingLevels.length > 0 ? (
					<div className="mb-3">
						<div className="mb-1.5 flex items-center gap-2">
							<div className="meta">Thinking</div>
							{workspaceDefaultThinking ? (
								<span className="font-mono text-2xs text-ink-4">
									workspace default: {workspaceDefaultThinking}
								</span>
							) : (
								<span className="font-mono text-2xs text-ink-4">use model default</span>
							)}
						</div>
						<div className="flex flex-wrap gap-1">
							<button
								type="button"
								onClick={() => { setThinking(undefined); setThinkingTouched(true); }}
								className={cn(
									"rounded border px-2 py-0.5 font-mono text-2xs transition-colors",
									thinking === undefined
										? "border-accent bg-accent-soft text-accent"
										: "border-line text-ink-3 hover:border-line-strong hover:text-ink-2",
								)}
							>
								default
							</button>
							<button
								type="button"
								onClick={() => { setThinking("off"); setThinkingTouched(true); }}
								className={cn(
									"rounded border px-2 py-0.5 font-mono text-2xs transition-colors",
									thinking === "off"
										? "border-accent bg-accent-soft text-accent"
										: "border-line text-ink-3 hover:border-line-strong hover:text-ink-2",
								)}
							>
								off
							</button>
							{selectedThinkingLevels.map((level) => (
								<button
									key={level}
									type="button"
									onClick={() => { setThinking(level); setThinkingTouched(true); }}
									className={cn(
										"rounded border px-2 py-0.5 font-mono text-2xs transition-colors",
										thinking === level
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

				<label className="flex items-center gap-2 text-sm text-ink-2">
					<input
						type="checkbox"
						checked={planMode}
						onChange={(e) => setPlanMode(e.target.checked)}
						className="h-3.5 w-3.5"
					/>
					Start in Plan Mode
				</label>

				{showInitialPrompt ? (
					<div className="mt-3">
						<div className="meta mb-1.5">Initial prompt (optional)</div>
						<textarea
							value={initialPrompt}
							onChange={(e) => setInitialPrompt(e.target.value)}
							rows={3}
							placeholder="Give the agent an instruction to start with — sent once as the first turn."
							className="field w-full resize-none px-2 py-1.5 text-sm"
						/>
					</div>
				) : null}

				{error ? (
					<div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
			</div>

			<div className="flex items-center justify-end gap-2 border-t border-line bg-paper-2/60 px-3 py-2">
				<button type="button" onClick={onCancel} className="btn-ghost h-8 px-3 text-xs" disabled={busy}>
					Cancel
				</button>
				<button
					type="button"
					onClick={() => void confirm()}
					disabled={busy || (isCustomCwd && !cwd)}
					className={cn("btn-primary h-8 px-3 text-xs", busy && "opacity-60")}
				>
					{busy ? "Starting…" : confirmLabel}
				</button>
			</div>

			<DirBrowserModal
				open={browsing}
				initialPath={customCwd || defaultCwd}
				onClose={() => setBrowsing(false)}
				onSelect={(path) => {
					setCustomCwd(path);
					setBrowsing(false);
				}}
			/>
		</Modal>
	);
}
