import { useEffect, useRef, useState } from "react";
import { ChevronDown, CornerLeftUp, CornerRightDown, GitBranch, Plus, X } from "lucide-react";
import type { SessionUi } from "@/lib/types";
import { selectActiveSession, useStore } from "@/lib/store";
import { launchSession } from "@/lib/first-prompt";
import { cn, shortPath } from "@/lib/utils";
import { ContextIndicator } from "./ContextIndicator";
import { ModelPickerModal } from "./ModelPickerModal";
import { SessionLaunchModal, type SessionLaunchOpts } from "./SessionLaunchModal";
import { SessionTreeModal } from "./SessionTreeModal";
import type { ModelInfo, SessionHandoffSuccessor } from "@omp-deck/protocol";
import { api } from "@/lib/api";

/**
 * Sticky header row above the chat scroll area when a session is selected.
 * Shows the session name (click to rename) + a small dropdown listing other
 * live sessions for quick switching and a "+ new" affordance.
 *
 * Renders inline above the chat so the user never needs the sidebar to
 * orient themselves to the current session.
 */
export function ChatHeader() {
	const session = useStore(selectActiveSession);
	if (!session) return null;
	return <Inner session={session} />;
}

/** Fetches the selected session model's full ModelInfo for its thinking levels. */
function useCurrentModelInfo(
	sessionId: string,
	provider: string | undefined,
	modelId: string | undefined,
): ModelInfo | undefined {
	const [info, setInfo] = useState<ModelInfo | undefined>();
	useEffect(() => {
		let cancelled = false;
		setInfo(undefined);
		api.listModels(sessionId).then((res) => {
			if (!cancelled) setInfo(res.models.find((model) => model.provider === provider && model.id === modelId));
		}).catch(() => {});
		return () => { cancelled = true; };
	}, [sessionId, provider, modelId]);
	return info;
}

/**
 * T-32: best-effort lookup of the session an automatic context handoff
 * continued this one into, if any. Disk-only + bridge-independent, so it
 * resolves for a purely historical (non-live) session too — see
 * `GET /sessions/handoff-successor`. `undefined` while loading or when none
 * is found; never throws into the header.
 */
function useHandoffSuccessor(cwd: string, sessionFile: string | undefined): SessionHandoffSuccessor | undefined {
	const [successor, setSuccessor] = useState<SessionHandoffSuccessor | undefined>();
	useEffect(() => {
		let cancelled = false;
		setSuccessor(undefined);
		if (!sessionFile) return;
		api.getHandoffSuccessor(cwd, sessionFile).then((res) => {
			if (!cancelled) setSuccessor(res.successor ?? undefined);
		}).catch(() => {});
		return () => { cancelled = true; };
	}, [cwd, sessionFile]);
	return successor;
}

function Inner({ session }: { session: SessionUi }) {
	const renameSession = useStore((s) => s.renameSession);
	const createSession = useStore((s) => s.createSession);
	const setPendingDraft = useStore((s) => s.setPendingDraft);
	const selectSession = useStore((s) => s.selectSession);
	const defaultCwd = useStore((s) => s.defaultCwd);
	const sessionsById = useStore((s) => s.sessionsById);
	const actOnGoal = useStore((s) => s.actOnGoal);
	const closeActiveSession = useStore((s) => s.closeActiveSession);
	const handoffSuccessor = useHandoffSuccessor(session.cwd, session.sessionFile);

	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(session.sessionName ?? "");
	const [renameError, setRenameError] = useState<string | undefined>(undefined);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);
	const [launchOpen, setLaunchOpen] = useState(false);
	const [treeOpen, setTreeOpen] = useState(false);
	const switcherRef = useRef<HTMLDivElement>(null);
	const thinkingPickerRef = useRef<HTMLDivElement>(null);
	const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false);
	const currentModelInfo = useCurrentModelInfo(session.sessionId, session.model?.provider, session.model?.id);
	const thinkingLevels = currentModelInfo?.thinkingLevels ?? [];
	const thinkingToggleBlocked = session.status !== "idle" || Boolean(session.planMode?.modelOverride);
	const [thinkingBusy, setThinkingBusy] = useState(false);
	const [thinkingError, setThinkingError] = useState<string | undefined>(undefined);

	useEffect(() => {
		setDraft(session.sessionName ?? "");
	}, [session.sessionName, session.sessionId]);

	useEffect(() => {
		if (!switcherOpen) return;
		function onDocClick(e: MouseEvent): void {
			if (!switcherRef.current) return;
			if (!switcherRef.current.contains(e.target as Node)) setSwitcherOpen(false);
		}
		document.addEventListener("mousedown", onDocClick);
		return () => document.removeEventListener("mousedown", onDocClick);
	}, [switcherOpen]);
	useEffect(() => {
		if (!thinkingPickerOpen) return;
		function onDocClick(e: MouseEvent): void {
			if (!thinkingPickerRef.current) return;
			if (!thinkingPickerRef.current.contains(e.target as Node)) setThinkingPickerOpen(false);
		}
		document.addEventListener("mousedown", onDocClick);
		return () => document.removeEventListener("mousedown", onDocClick);
	}, [thinkingPickerOpen]);
	useEffect(() => {
		if (thinkingToggleBlocked) setThinkingPickerOpen(false);
	}, [thinkingToggleBlocked]);


	function commit(): void {
		const trimmed = draft.trim();
		if (!trimmed || trimmed === session.sessionName) {
			setEditing(false);
			setRenameError(undefined);
			return;
		}
		// Keep the input open until the API succeeds — otherwise a failure
		// (Windows-EPERM from the SDK's atomic-rename, server 404 on a
		// reaped session, etc.) silently reverts the visible name without
		// telling the user the rename never landed.
		renameSession(session.sessionId, trimmed).then(
			() => {
				setRenameError(undefined);
				setEditing(false);
			},
			(err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				// Trim the long HTTP prefix the api helper prepends.
				const compact = message.replace(/^HTTP \d+ \/sessions\/[^:]+:\s*/, "");
				setRenameError(compact || "Rename failed");
			},
		);
	}

	async function selectThinkingLevel(level: string): Promise<void> {
		if (thinkingBusy || thinkingToggleBlocked) return;
		setThinkingBusy(true);
		setThinkingError(undefined);
		try {
			await api.setSessionThinking(session.sessionId, level);
		} catch (err) {
			setThinkingError(String((err as Error).message ?? err));
		} finally {
			setThinkingBusy(false);
			setThinkingPickerOpen(false);
		}
	}

	async function openHandoffSession(resumeFromPath: string): Promise<void> {
		try {
			await createSession({ cwd: session.cwd, resumeFromPath });
		} catch (err) {
			console.error(err);
			alert(`Failed to resume: ${String(err)}`);
		}
	}

	const otherSessions = Object.values(sessionsById).filter((s) => s.sessionId !== session.sessionId);

	return (
		<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-4">
			{/* Live indicator + name */}
			<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="live session" />
			{session.planMode?.enabled ? (
				<span
					className="inline-flex shrink-0 items-center gap-1 rounded border border-thinking/40 bg-thinking/10 px-1.5 py-0.5 text-2xs uppercase tracking-meta text-thinking"
					title="Plan mode — agent reads + proposes only (Shift+Tab to exit)"
				>
					Plan
				</span>
			) : null}
			{session.goalMode ? (
				<span
					className="inline-flex shrink-0 items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs uppercase tracking-meta text-accent"
					title={`${session.goalMode.status}: ${session.goalMode.objective}`}
				>
					Goal {session.goalMode.status}
				</span>
			) : null}
			{editing ? (
				<>
					<input
						autoFocus
						value={draft}
						onChange={(e) => {
							setDraft(e.target.value);
							if (renameError) setRenameError(undefined);
						}}
						onBlur={commit}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								(e.target as HTMLInputElement).blur();
							}
							if (e.key === "Escape") {
								setDraft(session.sessionName ?? "");
								setRenameError(undefined);
								setEditing(false);
							}
						}}
						placeholder="Untitled session"
						aria-invalid={renameError ? true : undefined}
						aria-describedby={renameError ? "rename-error" : undefined}
						className={cn(
							"min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink placeholder:text-ink-4 focus:outline-none",
							renameError && "text-danger placeholder:text-danger/60",
						)}
					/>
					{renameError ? (
						<span
							id="rename-error"
							role="alert"
							title={renameError}
							className="shrink-0 truncate font-mono text-2xs text-danger"
						>
							✕ {renameError.length > 80 ? `${renameError.slice(0, 77)}…` : renameError}
						</span>
					) : null}
				</>
			) : (
				<button
					type="button"
					onClick={() => setEditing(true)}
					title="Click to rename"
					className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-ink hover:text-accent"
				>
					{session.sessionName || `Untitled · ${shortId(session.sessionId)}`}
				</button>
			)}

			{session.planMode?.enabled ? (
				<span
					className="hidden h-6 shrink-0 items-center rounded-md border border-accent-plan/40 bg-accent-plan/10 px-1.5 font-mono text-2xs uppercase tracking-meta text-accent-plan sm:flex"
					title="Plan mode active — agent will read + propose a plan, then await approval before execution (Shift+Tab to exit)"
				>
					plan
				</span>
			) : null}

			{/* Metadata */}
			<span
				className="hidden font-mono text-2xs text-ink-3 sm:inline truncate"
				title={session.cwd}
			>
				{shortPath(session.cwd, 36)}
			</span>

			{/* T-32: open this session's origin (fork or auto-handoff source)
			    and intentionally select it. The original remains in the session
			    tree, so the user can follow the chain in either direction. */}
			{session.parentSessionPath ? (
				<button
					type="button"
					onClick={() => void openHandoffSession(session.parentSessionPath!)}
					title="Open the session this one continues from"
					aria-label="Open origin session"
					className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line bg-paper-2/60 px-1.5 font-mono text-2xs uppercase tracking-meta text-ink-3 hover:border-ink/30 hover:text-ink"
				>
					<CornerLeftUp className="h-3 w-3" />
					<span className="hidden sm:inline">origin</span>
				</button>
			) : null}
			{handoffSuccessor ? (
				<button
					type="button"
					onClick={() => void openHandoffSession(handoffSuccessor.sessionFile)}
					title="Open the session an automatic context handoff continued this one into"
					aria-label="Open continuation session"
					className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line bg-paper-2/60 px-1.5 font-mono text-2xs uppercase tracking-meta text-ink-3 hover:border-ink/30 hover:text-ink"
				>
					<CornerRightDown className="h-3 w-3" />
					<span className="hidden sm:inline">continuation</span>
				</button>
			) : null}

			{session.model ? (
				<button
					type="button"
					onClick={() => setModelOpen(true)}
					title={`Switch model (${session.model.provider}/${session.model.id})`}
					className="hidden h-6 items-center gap-1 rounded-md border border-line bg-paper-2/60 px-2 font-mono text-2xs uppercase tracking-meta text-ink-3 hover:border-ink/30 hover:text-ink sm:flex"
				>
					<span className="truncate max-w-[180px]">{session.model.id}</span>
					<ChevronDown className="h-3 w-3" />
				</button>
			) : null}
			{thinkingLevels.length > 0 ? (
				<div className="relative hidden sm:block" ref={thinkingPickerRef}>
					<button
						type="button"
						onClick={() => {
							if (!thinkingBusy && !thinkingToggleBlocked) setThinkingPickerOpen((v) => !v);
						}}
						disabled={thinkingBusy || thinkingToggleBlocked}
						title={
							session.planMode?.modelOverride
								? "Thinking cannot change while Plan Mode overrides the model"
								: session.status !== "idle"
									? "Thinking can change when the session is idle"
									: session.thinkingLevel === "off"
										? "Select thinking level"
										: `Thinking: ${session.thinkingLevel ?? "default"} — click to change`
						}
						className={cn(
							"flex h-6 items-center gap-1 rounded-md border px-2 font-mono text-2xs uppercase tracking-meta",
							session.thinkingLevel === "off"
								? "border-line bg-paper-2/60 text-ink-4 hover:border-ink/30 hover:text-ink"
								: "border-thinking/40 bg-thinking/10 text-thinking hover:border-thinking/60",
							(thinkingBusy || thinkingToggleBlocked) && "cursor-not-allowed opacity-50",
						)}
					>
						{session.thinkingLevel === "off" ? "think: off" : (session.thinkingLevel ?? "think")}
						<ChevronDown className={cn("h-3 w-3 transition-transform", thinkingPickerOpen && "rotate-180")} />
					</button>
					{thinkingPickerOpen ? (
						<div className="absolute right-0 top-full z-50 mt-1 min-w-[90px] rounded-md border border-line bg-paper-2 shadow-[0_8px_24px_-8px_rgba(26,24,20,0.25)]">
							{(["off", ...thinkingLevels] as string[]).map((level) => (
								<button
									key={level}
									type="button"
									onClick={() => void selectThinkingLevel(level)}
									className={cn(
										"flex w-full items-center justify-between gap-3 px-3 py-1.5 font-mono text-2xs uppercase tracking-meta hover:bg-paper-3/60",
										session.thinkingLevel === level
											? "text-thinking"
											: "text-ink-3",
									)}
								>
									{level}
									{session.thinkingLevel === level ? (
										<span>✓</span>
									) : null}
								</button>
							))}
						</div>
					) : null}
					{thinkingError ? (
						<span
							role="alert"
							title={thinkingError}
							className="absolute left-full top-0 ml-2 max-w-48 truncate whitespace-nowrap font-mono text-2xs text-danger"
						>
							{thinkingError}
						</span>
					) : null}
				</div>
			) : null}
			{session.planMode?.modelOverride ? (
				<span
					className="hidden h-6 shrink-0 items-center gap-1 rounded-md border border-accent-plan/40 bg-accent-plan/10 px-2 font-mono text-2xs uppercase tracking-meta text-accent-plan sm:flex"
					title={`Plan mode is running on ${session.planMode.modelOverride.model.provider}/${session.planMode.modelOverride.model.id}${session.planMode.modelOverride.thinking ? ` · thinking ${session.planMode.modelOverride.thinking}` : ""}${session.planMode.modelOverride.pending ? " (applies after the current turn)" : ""}. The session model shown left is restored on exit.`}
				>
					<span className="max-w-[160px] truncate">plan: {session.planMode.modelOverride.model.id}</span>
					{session.planMode.modelOverride.thinking ? (
						<span className="text-accent-plan/70">{session.planMode.modelOverride.thinking}</span>
					) : null}
					{session.planMode.modelOverride.pending ? (
						<span className="text-accent-plan/70">pending</span>
					) : null}
				</span>
			) : null}
			{session.planMode?.enabled ? (
				<span
					className="flex h-6 items-center rounded-md border border-thinking/60 bg-thinking/10 px-1.5 font-mono text-2xs uppercase tracking-meta text-thinking"
					title="Plan mode active — agent reads + proposes only. Shift+Tab to exit."
					aria-label="Plan mode active"
				>
					Plan
				</span>
			) : null}
			{session.goalMode ? (
				<div className="hidden shrink-0 items-center gap-1 sm:flex">
					<span
						className="max-w-48 truncate font-mono text-2xs text-ink-3"
						title={`${session.goalMode.objective} · ${session.goalMode.tokensUsed}${session.goalMode.tokenBudget !== undefined ? ` / ${session.goalMode.tokenBudget}` : " tokens"}`}
					>
						Goal: {session.goalMode.objective}
					</span>
					{session.goalMode.enabled ? (
						<button type="button" className="btn-ghost h-6 px-1.5 text-2xs" onClick={() => actOnGoal("pause")}>
							Pause
						</button>
					) : session.goalMode.status === "paused" ? (
						<button type="button" className="btn-ghost h-6 px-1.5 text-2xs" onClick={() => actOnGoal("resume")}>
							Resume
						</button>
					) : null}
					<button type="button" className="btn-ghost h-6 px-1.5 text-2xs text-danger" onClick={() => actOnGoal("cancel")}>
						Cancel
					</button>
				</div>
			) : null}

			{/* Session-tree / timeline view (T-31) — navigate/branch history. */}
			<button
				type="button"
				onClick={() => setTreeOpen(true)}
				className="btn-ghost h-7 w-7 p-0"
				aria-label="Session tree"
				title="Ver árbol de sesión / bifurcar"
			>
				<GitBranch className="h-3.5 w-3.5" />
			</button>

			{/* Context-window indicator — clickable popover with manual /compact. */}
			<ContextIndicator sessionId={session.sessionId} usage={session.contextUsage} />

			{/* Switcher dropdown */}
			<div className="relative" ref={switcherRef}>
				<button
					type="button"
					onClick={() => setSwitcherOpen((v) => !v)}
					className="btn-ghost h-7 gap-1 px-1.5 text-xs"
					title="Switch sessions"
				>
					Switch
					<ChevronDown
						className={cn("h-3 w-3 transition-transform", switcherOpen && "rotate-180")}
					/>
				</button>
				{switcherOpen ? (
					<div className="absolute right-0 top-full mt-1 w-72 rounded-md border border-line bg-paper-2 shadow-[0_8px_24px_-8px_rgba(26,24,20,0.25)]">
					<button
						type="button"
						onClick={() => {
							setSwitcherOpen(false);
							setLaunchOpen(true);
						}}
						className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-sm text-accent hover:bg-paper-3/60"
					>
						<Plus className="h-3.5 w-3.5" />
						New session
					</button>
						{otherSessions.length === 0 ? (
							<div className="px-3 py-3 font-mono text-2xs text-ink-3">
								No other live sessions.
							</div>
						) : (
							<ul className="py-1">
								{otherSessions.map((s) => (
									<li key={s.sessionId}>
										<button
											type="button"
											onClick={() => {
												setSwitcherOpen(false);
												selectSession(s.sessionId);
											}}
											className="block w-full px-3 py-1.5 text-left text-sm hover:bg-paper-3/60"
										>
											<div className="truncate text-ink">
												{s.sessionName || `Untitled · ${shortId(s.sessionId)}`}
											</div>
											<div className="truncate font-mono text-2xs text-ink-3">
												{shortPath(s.cwd, 48)}
											</div>
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				) : null}
			</div>

			{/* Close (detach) — clears activeId only; the session keeps running
			    server-side (T-52) so other tabs viewing it are unaffected, and
			    re-selecting it later (e.g. from the Sidebar) restores it as-is. */}
			<button
				type="button"
				onClick={closeActiveSession}
				className="btn-ghost h-7 w-7 p-0"
				aria-label="Close session"
				title="Close session (keeps running in background)"
			>
				<X className="h-3.5 w-3.5" />
			</button>

			<ModelPickerModal
				open={modelOpen}
				sessionId={session.sessionId}
				onClose={() => setModelOpen(false)}
				onPicked={() => {
					// Snapshot will update on the SDK's next event; nothing else to do here.
				}}
			/>
			<SessionLaunchModal
				open={launchOpen}
				initialCwd={defaultCwd}
				onCancel={() => setLaunchOpen(false)}
				onConfirm={async (opts: SessionLaunchOpts) => {
					await launchSession(createSession, setPendingDraft, opts);
					setLaunchOpen(false);
				}}
			/>
			<SessionTreeModal open={treeOpen} sessionId={session.sessionId} onClose={() => setTreeOpen(false)} />
		</div>
	);
}

function shortId(id: string): string {
	return id.length <= 8 ? id : id.slice(0, 6);
}
