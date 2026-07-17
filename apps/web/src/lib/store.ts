import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type {
	ExtUiDialogResponse,
	ImageAttachment,
	ListSessionsResponse,
	ListWorkspacesResponse,
	ModelRef,
	NotificationLevel,
	PendingPlanApprovalWire,
	PlanModeContextWire,
	SessionSummary,
	ServerFrame,
	WorkspaceEntry,
} from "@omp-deck/protocol";

/**
 * In-app notification record. Mirrors the wire frame plus client-side
 * metadata: `receivedAtMs` for ordering, `deliveredOs` so the OS-level
 * Notification renderer only fires once per item.
 */
export interface NotificationItem {
	id: string;
	level: NotificationLevel;
	title: string;
	body?: string;
	sound?: boolean;
	source?: string;
	actionUrl?: string;
	timestamp: string;
	receivedAtMs: number;
	deliveredOs: boolean;
	dismissed: boolean;
}

/** Max notifications retained in the in-app queue. Older items fall off. */
const MAX_NOTIFICATIONS = 50;

import { api } from "./api";
import { applyEvent, initSession, prependHistory, trimHistory } from "./reducer";
import type { NoticeMsg, SessionUi } from "./types";
import { WsClient, type WsStatus } from "./ws";

/** Messages fetched per scroll-up history page. */
const HISTORY_PAGE_SIZE = 100;
/** Trim the loaded window once it exceeds this many messages… */
const TRIM_THRESHOLD = 350;
/** …down to roughly this many (matches the server's snapshot tail). */
const TRIM_TARGET = 200;

function readBool(key: string, fallback: boolean): boolean {
	if (typeof localStorage === "undefined") return fallback;
	const raw = localStorage.getItem(key);
	if (raw === null) return fallback;
	return raw === "1";
}

function readString(key: string, fallback: string): string {
	if (typeof localStorage === "undefined") return fallback;
	return localStorage.getItem(key) || fallback;
}

/** Last-active session id (T-52), keyed separately from the chrome-state
 * booleans above so a brand-new tab pointed at the bare origin — not a
 * specific `/c/:id` URL — still reconnects to whatever was last open, the
 * same way browser tab-restore already does via the URL itself. Kept in
 * sync with `activeId` by the `useStore.subscribe` call below, and read
 * once here to seed the store's initial state. */
const LAST_SESSION_STORAGE_KEY = "omp-deck:last-session-id";

function readLastSessionId(): string | undefined {
	if (typeof localStorage === "undefined") return undefined;
	return localStorage.getItem(LAST_SESSION_STORAGE_KEY) || undefined;
}

/** Session ids `resumeIfKnown` has already attempted once this tab. Module
 * state, not store state — it's a de-dupe guard, not something a view
 * should ever render off of. */
const resumeAttempted = new Set<string>();

/** Ctrl/Cmd+`/` — was `Ctrl+.` (ChatGPT/VS Code's "stop generating" convention)
 * until it collided with fcitx5's built-in emoji-picker binding on one
 * setup. Configurable per-browser in Settings → Appearance; this is only the
 * fallback for anyone who hasn't picked their own. */
export const DEFAULT_ABORT_SHORTCUT_KEY = "/";

/** Matches the Tailwind `lg` breakpoint (1024px) used by `Layout`. Below this
 * width the sidebar and inspector behave as overlay drawers, so persisting
 * "open" state would auto-open them on every mobile load and bury the main
 * content under a backdrop.  */
function isDesktopViewport(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
}

/** Chrome panel state is only persisted on desktop. On mobile we always start
 * with the panel closed and never write back, so toggling on a phone does not
 * pollute the desktop preference. */
function readChromeOpen(key: string, desktopFallback: boolean): boolean {
	if (!isDesktopViewport()) return false;
	return readBool(key, desktopFallback);
}

interface StoreState {
	ws: WsClient | null;
	wsStatus: WsStatus;
	connectionId?: string;

	workspaces: WorkspaceEntry[];
	defaultCwd: string;
	sessions: SessionSummary[];

	activeId?: string;
	sessionsById: Record<string, SessionUi>;

	// Track subscriptions to avoid duplicate subscribe messages.
	subscribed: Set<string>;
	/** Number of Auto Work monitors retaining each session subscription. */
	watchingSessionCounts: Map<string, number>;

	/**
	 * Tool-card view state. `allCollapsed` is the bulk default; `perCard` holds
	 * user overrides (key = toolCallId, value = isOpen). On bulk toggle we clear
	 * `perCard` so the new default applies to every card uniformly.
	 *
	 * `hideAll` is a separate, more aggressive axis (T-48): when on, tool
	 * calls render nothing but a live spinner + running tool name, and never
	 * render history (see `AssistantMessage.tsx`). It takes visual precedence
	 * over `allCollapsed`/`perCard` — those stay togglable but have no visible
	 * effect while `hideAll` is active.
	 */
	toolView: {
		allCollapsed: boolean;
		perCard: Record<string, boolean>;
		hideAll: boolean;
	};

	/** Pinned todo panel in the conversation, toggled next to `ToolCardsToggle`
	 * in Layout.tsx. Off by default — no panel, not even a "no todos" stub,
	 * until the user turns it on (T-46). Session-only, not persisted. */
	todoPanelOpen: boolean;

	/** Composer pre-fill used by session-launch flows. `autoSend` is reserved
	 * for an intentional initial prompt, never a user-typed composer draft. */
	pendingDraft?: { text: string; sessionId?: string; autoSend?: boolean };

	/** Shared chrome state — each view can open/close the inspector and sidebar. */
	sidebarOpen: boolean;
	inspectorOpen: boolean;

	/**
	 * Key (as reported by `KeyboardEvent.key`, e.g. `"/"`, `"."`, `"Escape"`)
	 * that, combined with Ctrl/Cmd, aborts the active session's in-flight turn
	 * (see `useGlobalAbortShortcut` in App.tsx). Configurable in
	 * Settings → Appearance because the default collides with some IME
	 * emoji-picker bindings (fcitx5's `Ctrl+.`, notably). Per-browser, like
	 * theme and chrome panel state.
	 */
	abortShortcutKey: string;

	/**
	 * Monotonic counter bumped every time the server broadcasts a `tasks_changed`
	 * frame (any kanban mutation, whether triggered by the deck UI, a deck slash
	 * command, or an agent calling the REST API). Views that own a local tasks
	 * cache (e.g. TasksView) subscribe to this counter and refetch when it
	 * changes — keeps the kanban view live without polling.
	 */
	tasksChangeCounter: number;
	/** True only while the Tasks view owns the task-change event stream. */
	tasksSubscribed: boolean;

	/**
	 * Mirror of {@link tasksChangeCounter} for the skill catalog. Bumped on every
	 * `skills_changed` frame (plugin install / uninstall / enable / disable, or
	 * a SKILL.md mutation under the plugins cache dir). Drives live refetch in
	 * `SkillsView` without polling.
	 */
	skillsChangeCounter: number;

	/**
	 * Counter for `kb_changed` broadcasts. Bumped on any mutation under the
	 * watched kb root; `KbView` watches it and refetches the current file +
	 * tree. Same pattern as `tasksChangeCounter` / `skillsChangeCounter`.
	 */
	kbChangeCounter: number;

	/**
	 * Counter for `sessions_changed` broadcasts (a session's name or model was
	 * patched, e.g. `PATCH /api/sessions/:id`). Sidebar and SessionPicker
	 * watch it and refetch the persisted session list so a rename made from
	 * another tab or the REST API shows up without a manual refresh. Same
	 * pattern as `tasksChangeCounter` / `skillsChangeCounter`.
	 */
	sessionsChangeCounter: number;

	/**
	 * Counter for `auto_work_runs_changed` broadcasts. Bumped on every run
	 * lifecycle event (start, complete, fail, timeout). AutoWorkView watches
	 * this and refetches the run list. Same pattern as `tasksChangeCounter`.
	 */
	autoWorkRunsChangeCounter: number;

	/**
	 * Per-session open extension-UI dialog (currently used by the SDK `ask`
	 * tool, but the channel is shape-typed to cover any extension dialog).
	 * At most one dialog per session is open at a time because the SDK awaits
	 * each `ctx.ui.*` call serially; if a second open arrives it replaces the
	 * first (the server-side bridge already cancelled the predecessor before
	 * sending the new one). Cleared on `ext_ui_dialog_cancel` and on local
	 * response submission.
	 */
	pendingDialogs: Record<string, Extract<ServerFrame, { type: "ext_ui_dialog_open" }>>;

	/**
	 * Latest heartbeat the server has broadcast. `lastHeartbeatAt` is the
	 * client's local Date.now() at the moment we received the frame, NOT the
	 * server's `timestamp` — the gap drives the connection indicator and must
	 * be measured in the client's clock.
	 */
	heartbeat: {
		lastReceivedAtMs: number;
		serverStartedAt: string;
		pid: number;
		uptimeSecs: number;
		buildSha: string | null;
		version: string;
	} | null;

	/**
	 * In-app notification queue. Each `notification` frame is appended; the
	 * notification renderer pops from here when delivering an OS notification
	 * + audio cue, and a small toast surface reads from here too. Capped at
	 * MAX_NOTIFICATIONS via prune; oldest fall off.
	 */
	notifications: NotificationItem[];

	// ─── Actions ─────────────────────────────────────────────────────────
	bootstrap(): Promise<void>;
	connect(): void;
	disconnect(): void;
	refreshWorkspaces(): Promise<void>;
	refreshSessions(cwd?: string): Promise<void>;
	createSession(opts: {
		cwd: string;
		resumeFromPath?: string;
		model?: ModelRef;
		planMode?: boolean;
		/** Thinking level for session creation (T-73). */
		thinking?: string;
	}): Promise<string>;
	/**
	 * Fork a new session rooted at `entryId`'s history in `sessionId` (T-31).
	 * Never mutates the source session — the server creates a brand-new
	 * `.jsonl` file and resumes it into a live handle. Activates the new
	 * session the same way `createSession`/`selectSession` do.
	 */
	branchSession(sessionId: string, entryId: string): Promise<string>;
	selectSession(id: string): void;
	/** Retain a session for read-only monitoring. The returned cleanup releases
	 *  this watcher; the wire subscription stays alive while another owner needs it. */
	watchSession(id: string): () => void;
	/** Detach the current tab's view from the active session — clears
	 *  `activeId` only. Unlike `disposeSession`, the underlying server-side
	 *  session keeps running in the background (T-52) and any other tab
	 *  still subscribed to it is unaffected; re-selecting the same id later
	 *  just resumes viewing it via `selectSession`'s idempotent subscribe. */
	closeActiveSession(): void;
	/**
	 * Fetch one page of older messages for a subscribed session and prepend
	 * it to the loaded window. No-op while a fetch is in flight or when the
	 * full history is already loaded. Called by the chat pane as the user
	 * scrolls toward the top.
	 */
	loadOlderMessages(sessionId: string): Promise<void>;
	/**
	 * Shrink a session's loaded window back to the default tail once the
	 * user has returned to the bottom of the conversation. Dropped pages are
	 * re-fetched transparently by `loadOlderMessages` when scrolling up
	 * again.
	 */
	trimConversation(sessionId: string): void;
	/** Start or stop receiving task-change broadcasts for the mounted Tasks view. */
	subscribeTasks(): void;
	unsubscribeTasks(): void;
	sendPrompt(text: string, images?: ImageAttachment[]): void;
	abort(): void;
	/** Drop every queued (followUp / steering) prompt for the active session.
	 *  Server echoes a `queue_cleared` session event that reconciles
	 *  `queuedPrompts` in the reducer. */
	clearQueue(): void;
	/** Cancel a single queued prompt by its server-assigned id. Server echoes
	 *  a `queue_state` session event with the new ordered queue. */
	cancelQueued(queuedId: string): void;
	/** Edit a queued prompt's text (and optionally images) in place. */
	editQueued(queuedId: string, text: string, images?: ImageAttachment[]): void;
	/** Permanently delete a session (server drops the `.jsonl` file + any
	 *  live handle — irreversible). Removes the row from both `sessionsById`
	 *  and the persisted `sessions` list locally; clears `activeId` if it
	 *  pointed at the deleted session. */
	deleteSession(id: string): Promise<void>;
	/** Auto-resume a session a `subscribe` attempt found inactive (idle-
	 *  reaped, or the server restarted) but that still exists on disk.
	 *  No-op past the first attempt per id in this tab; clears `activeId`
	 *  if it turns out the id doesn't exist at all. Called from the `error`
	 *  frame handler below, not meant to be invoked directly by views. See
	 *  T-52. */
	resumeIfKnown(id: string): Promise<void>;
	renameSession(id: string, name: string): Promise<void>;
	toggleAllToolCards(): void;
	toggleHideAllToolCards(): void;
	setToolCardOpen(id: string, open: boolean): void;
	toggleTodoPanel(): void;
	setPendingDraft(draft: { text: string; sessionId?: string; autoSend?: boolean } | undefined): void;
	setSidebarOpen(open: boolean): void;
	setInspectorOpen(open: boolean): void;
	setAbortShortcutKey(key: string): void;
	/** Send a dialog response over the WS and clear it locally. */
	respondToExtUiDialog(sessionId: string, dialogId: string, response: ExtUiDialogResponse): void;
	/**
	 * Toggle plan mode on the active session (T-105). Idempotent on the wire;
	 * server emits `plan_mode_changed` which the reducer mirrors back.
	 */
	setPlanMode(enabled: boolean): void;
	/** Execute a Goal Mode lifecycle action on the active session. */
	actOnGoal(action: "create" | "pause" | "resume" | "cancel" | "set_budget", options?: { objective?: string; tokenBudget?: number }): void;
	/**
	 * Reply to a `plan_proposed` card. Optimistically clears
	 * `pendingPlanApproval` so the UI hides immediately; the server emits
	 * `plan_proposal_resolved`, and on `error` (stale proposalId) the next
	 * `plan_proposed` replay on subscribe will restore it.
	 */
	respondToPlanApproval(args: {
		sessionId: string;
		proposalId: string;
		approved: boolean;
		finalPath?: string;
		editedContent?: string;
		executionStrategy?: "keep_context" | "compact_context";
	}): void;
	actOnPendingPlanExecution(sessionId: string, proposalId: string): void;
	/** Mark a notification as delivered to the OS so the renderer only fires once. */
	markNotificationDelivered(id: string): void;
	/** Hide an in-app toast for a notification (does not affect an already-delivered OS notif). */
	dismissNotification(id: string): void;
}

function ensureSessionSubscription(id: string, get: () => StoreState): void {
	if (get().subscribed.has(id)) return;
	get().subscribed.add(id);
	get().ws?.send({ type: "subscribe", sessionId: id });
}

function releaseSessionSubscription(id: string, get: () => StoreState): void {
	if (!get().subscribed.delete(id)) return;
	get().ws?.send({ type: "unsubscribe", sessionId: id });
	// Evict the local conversation cache — nothing renders it anymore, and a
	// long transcript (messages + tool-call streams) is the dominant heap
	// cost per session. Re-selecting the session re-subscribes and the
	// server replays a fresh snapshot, so nothing is lost.
	useStore.setState((s) => {
		if (!(id in s.sessionsById)) return {};
		const next = { ...s.sessionsById };
		delete next[id];
		return { sessionsById: next };
	});
}

export const useStore = create<StoreState>()(
	subscribeWithSelector((set, get) => ({
		ws: null,
		wsStatus: "closed",
		workspaces: [],
		defaultCwd: "",
		sessions: [],
		sessionsById: {},
		activeId: readLastSessionId(),
		watchingSessionCounts: new Map(),
		subscribed: new Set<string>(),
		toolView: { allCollapsed: false, perCard: {}, hideAll: false },
		todoPanelOpen: false,
		tasksChangeCounter: 0,
		tasksSubscribed: false,
		skillsChangeCounter: 0,
		kbChangeCounter: 0,
		sessionsChangeCounter: 0,
		autoWorkRunsChangeCounter: 0,
		pendingDialogs: {},
		heartbeat: null,
		notifications: [],
		// Hydrate chrome state from localStorage at module init so first render
		// matches the user's last preference — but only on desktop. On mobile the
		// panels are overlay drawers and always start closed.
		sidebarOpen: readChromeOpen("omp-deck:sidebar-open", true),
		inspectorOpen: readChromeOpen("omp-deck:inspector-open", false),
		abortShortcutKey: readString("omp-deck:abort-shortcut-key", DEFAULT_ABORT_SHORTCUT_KEY),

		async bootstrap() {
			get().connect();
			await Promise.all([get().refreshWorkspaces(), get().refreshSessions()]);
		},

		connect() {
			if (get().ws) return;
			const ws = new WsClient();
			ws.onStatus((status) => set({ wsStatus: status }));
			ws.subscribe((frame) => handleFrame(frame, set, get));
			ws.connect();
			set({ ws });
		},

		disconnect() {
			get().ws?.dispose();
			set({ ws: null, wsStatus: "closed" });
		},

		async refreshWorkspaces() {
			try {
				const resp: ListWorkspacesResponse = await api.listWorkspaces();
				set({ workspaces: resp.workspaces, defaultCwd: resp.defaultCwd });
			} catch (err) {
				console.warn("listWorkspaces failed", err);
			}
		},

		async refreshSessions(cwd?: string) {
			try {
				const resp: ListSessionsResponse = await api.listSessions(cwd);
				set((s) => {
					// Keep the currently-open session(s)' live cache (`sessionsById`,
					// which feeds ChatHeader's title) in sync with the persisted list.
					// `sessionsById.sessionName` otherwise only updates on this tab's
					// own `renameSession()` call or on (re)subscribe — a rename from
					// another tab, a routine, or the REST API would bump
					// `sessionsChangeCounter` and refresh the sidebar/picker list but
					// leave an already-open chat header showing the stale name.
					const byId = { ...s.sessionsById };
					for (const row of resp.sessions) {
						const existing = byId[row.id];
						if (existing && row.title !== undefined && existing.sessionName !== row.title) {
							byId[row.id] = { ...existing, sessionName: row.title };
						}
					}
					return { sessions: resp.sessions, sessionsById: byId };
				});
			} catch (err) {
				console.warn("listSessions failed", err);
			}
		},

		async createSession(opts) {
			const created = await api.createSession({
				cwd: opts.cwd,
				...(opts.resumeFromPath ? { resumeFromPath: opts.resumeFromPath } : {}),
				...(opts.model ? { model: opts.model } : {}),
				...(opts.planMode ? { planMode: true } : {}),
				...(opts.thinking ? { thinking: opts.thinking } : {}),
			});
			const previousActiveId = get().activeId;
			if (previousActiveId && previousActiveId !== created.sessionId && !get().watchingSessionCounts.has(previousActiveId)) {
				releaseSessionSubscription(previousActiveId, get);
			}
			set({ activeId: created.sessionId });
			ensureSessionSubscription(created.sessionId, get);
			// Background-refresh sidebar to reflect the new entry.
			void get().refreshSessions();
			void get().refreshWorkspaces();
			return created.sessionId;
		},

		async branchSession(sessionId: string, entryId: string) {
			const created = await api.branchSession(sessionId, entryId);
			const previousActiveId = get().activeId;
			if (previousActiveId && previousActiveId !== created.sessionId && !get().watchingSessionCounts.has(previousActiveId)) {
				releaseSessionSubscription(previousActiveId, get);
			}
			set({ activeId: created.sessionId });
			ensureSessionSubscription(created.sessionId, get);
			void get().refreshSessions();
			void get().refreshWorkspaces();
			return created.sessionId;
		},

		selectSession(id: string) {
			const previousActiveId = get().activeId;
			if (previousActiveId && previousActiveId !== id && !get().watchingSessionCounts.has(previousActiveId)) {
				releaseSessionSubscription(previousActiveId, get);
			}
			set({ activeId: id });
			ensureSessionSubscription(id, get);
		},
		watchSession(id: string) {
			const count = get().watchingSessionCounts.get(id) ?? 0;
			set((s) => ({ watchingSessionCounts: new Map(s.watchingSessionCounts).set(id, count + 1) }));
			ensureSessionSubscription(id, get);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				const current = get().watchingSessionCounts.get(id) ?? 0;
				if (current <= 1) {
					set((s) => {
						const next = new Map(s.watchingSessionCounts);
						next.delete(id);
						return { watchingSessionCounts: next };
					});
					if (get().activeId !== id) releaseSessionSubscription(id, get);
					return;
				}
				set((s) => ({ watchingSessionCounts: new Map(s.watchingSessionCounts).set(id, current - 1) }));
			};
		},

		async loadOlderMessages(sessionId: string) {
			const ui = get().sessionsById[sessionId];
			if (!ui || ui.historyLoading) return;
			const before = ui.historyStartIndex ?? 0;
			if (before <= 0) return;
			set((s) => {
				const prev = s.sessionsById[sessionId];
				if (!prev) return {};
				return { sessionsById: { ...s.sessionsById, [sessionId]: { ...prev, historyLoading: true } } };
			});
			try {
				const page = await api.sessionHistory(sessionId, before, HISTORY_PAGE_SIZE);
				set((s) => {
					const prev = s.sessionsById[sessionId];
					if (!prev) return {};
					// The page must abut the current window front; if the cursor
					// moved while the fetch was in flight (trim, re-snapshot),
					// discard the stale page instead of splicing a gap/overlap.
					if ((prev.historyStartIndex ?? 0) !== before) {
						return { sessionsById: { ...s.sessionsById, [sessionId]: { ...prev, historyLoading: false } } };
					}
					return {
						sessionsById: {
							...s.sessionsById,
							[sessionId]: prependHistory(prev, page.messages, page.startIndex),
						},
					};
				});
			} catch (err) {
				console.warn(`loadOlderMessages failed for ${sessionId}`, err);
				set((s) => {
					const prev = s.sessionsById[sessionId];
					if (!prev) return {};
					return { sessionsById: { ...s.sessionsById, [sessionId]: { ...prev, historyLoading: false } } };
				});
			}
		},

		trimConversation(sessionId: string) {
			set((s) => {
				const prev = s.sessionsById[sessionId];
				if (!prev || prev.historyLoading || prev.messages.length <= TRIM_THRESHOLD) return {};
				const next = trimHistory(prev, TRIM_TARGET);
				if (next === prev) return {};
				return { sessionsById: { ...s.sessionsById, [sessionId]: next } };
			});
		},

		subscribeTasks() {
			if (get().tasksSubscribed) return;
			set({ tasksSubscribed: true });
			get().ws?.send({ type: "subscribe_tasks" });
		},
		unsubscribeTasks() {
			if (!get().tasksSubscribed) return;
			set({ tasksSubscribed: false });
			get().ws?.send({ type: "unsubscribe_tasks" });
		},


		sendPrompt(text, images) {
			const id = get().activeId;
			if (!id) return;
			const frame: Parameters<NonNullable<StoreState["ws"]>["send"]>[0] = images && images.length > 0
				? { type: "prompt", sessionId: id, text, images }
				: { type: "prompt", sessionId: id, text };
			get().ws?.send(frame);
		},

		abort() {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "abort", sessionId: id });
		},

		clearQueue() {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "clear_queue", sessionId: id });
		},

		cancelQueued(queuedId: string) {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "cancel_queued", sessionId: id, queuedId });
		},

		editQueued(queuedId, text, images) {
			const id = get().activeId;
			if (!id) return;
			const frame: Parameters<NonNullable<StoreState["ws"]>["send"]>[0] = images && images.length > 0
				? { type: "edit_queued", sessionId: id, queuedId, text, images }
				: { type: "edit_queued", sessionId: id, queuedId, text };
			get().ws?.send(frame);
		},

		async deleteSession(id: string) {
			// Backend delete FIRST: on failure, keep all local state intact and
			// rethrow so callers can surface the error — silently pruning a
			// session the server still has would make it "reappear" on reload.
			await api.disposeSession(id);
			set((s) => {
				const nextWatching = new Map(s.watchingSessionCounts);
				nextWatching.delete(id);
				const nextById = { ...s.sessionsById };
				delete nextById[id];
				return {
					watchingSessionCounts: nextWatching,
					sessionsById: nextById,
					sessions: s.sessions.filter((row) => row.id !== id),
					activeId: s.activeId === id ? undefined : s.activeId,
				};
			});
			releaseSessionSubscription(id, get);
		},

		closeActiveSession() {
			const id = get().activeId;
			if (!id) return;
			set({ activeId: undefined });
			if (!get().watchingSessionCounts.has(id)) releaseSessionSubscription(id, get);
		},

		async resumeIfKnown(id: string) {
			if (resumeAttempted.has(id)) return;
			resumeAttempted.add(id);
			let persisted = get().sessions.find((row) => row.id === id);
			if (!persisted) {
				await get().refreshSessions();
				persisted = get().sessions.find((row) => row.id === id);
			}
			if (!persisted) {
				// Truly unknown or deleted — stop pointing the UI at a dead id
				// instead of leaving the tab stuck on a blank screen.
				set((s) => (s.activeId === id ? { activeId: undefined } : {}));
				return;
			}
			// The failed subscribe already marked `id` as "subscribed" for this
			// connection; clear that so the post-resume `createSession` call
			// below can send a fresh `subscribe` once the new handle exists.
			get().subscribed.delete(id);
			try {
				await get().createSession({ cwd: persisted.cwd, resumeFromPath: persisted.path });
			} catch (err) {
				console.warn(`auto-resume failed for ${id}`, err);
				set((s) => (s.activeId === id ? { activeId: undefined } : {}));
			}
		},

		async renameSession(id, name) {
			// Re-throw on failure so the caller (ChatHeader) can keep the input
			// open + surface the error. Silently swallowing makes Windows-EPERM
			// failures from the SDK's atomic-rename journal save look like the
			// UI is broken when it's actually the FS rejecting the rename
			// because the journal file is held open by the live session.
			await api.renameSession(id, name);
			set((s) => {
				const existing = s.sessionsById[id];
				const next = existing
					? { ...s.sessionsById, [id]: { ...existing, sessionName: name } }
					: s.sessionsById;
				const sessions = s.sessions.map((r) => (r.id === id ? { ...r, title: name } : r));
				return { sessionsById: next, sessions };
			});
		},

		toggleAllToolCards() {
			set((s) => ({
				toolView: { ...s.toolView, allCollapsed: !s.toolView.allCollapsed, perCard: {} },
			}));
		},

		toggleHideAllToolCards() {
			set((s) => ({
				toolView: { ...s.toolView, hideAll: !s.toolView.hideAll },
			}));
		},

		setToolCardOpen(id, open) {
			set((s) => ({
				toolView: {
					...s.toolView,
					perCard: { ...s.toolView.perCard, [id]: open },
				},
			}));
		},

		toggleTodoPanel() {
			set((s) => ({ todoPanelOpen: !s.todoPanelOpen }));
		},

		setPendingDraft(draft) {
			set({ pendingDraft: draft });
		},

		setSidebarOpen(open) {
			// Only persist on desktop so toggling on mobile (where the panel is an
			// ephemeral overlay) doesn't auto-open it the next time the user lands
			// on the page from a wider screen.
			if (isDesktopViewport()) {
				try {
					localStorage.setItem("omp-deck:sidebar-open", open ? "1" : "0");
				} catch {}
			}
			set({ sidebarOpen: open });
		},

		setInspectorOpen(open) {
			if (isDesktopViewport()) {
				try {
					localStorage.setItem("omp-deck:inspector-open", open ? "1" : "0");
				} catch {}
			}
			set({ inspectorOpen: open });
		},

		setAbortShortcutKey(key) {
			try {
				localStorage.setItem("omp-deck:abort-shortcut-key", key);
			} catch {}
			set({ abortShortcutKey: key });
		},

		respondToExtUiDialog(sessionId, dialogId, response) {
			// Clear local state first — the dialog modal closes immediately —
			// then send the response over the WS so the SDK call settles.
			set((s) => {
				const current = s.pendingDialogs[sessionId];
				if (!current || current.dialogId !== dialogId) return {};
				const next = { ...s.pendingDialogs };
				delete next[sessionId];
				return { pendingDialogs: next };
			});
			get().ws?.send({
				type: "ext_ui_dialog_response",
				sessionId,
				dialogId,
				...response,
			});
		},

		setPlanMode(enabled) {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "set_plan_mode", sessionId: id, enabled });
		},
		actOnGoal(action, options) {
			const sessionId = get().activeId;
			if (!sessionId) return;
			get().ws?.send({ type: "goal_action", sessionId, action, ...options });
		},

		respondToPlanApproval({ sessionId, proposalId, approved, finalPath, editedContent, executionStrategy }) {
			// Optimistically clear the local approval card so the UI hides
			// immediately. Server emits `plan_proposal_resolved`; if the
			// proposalId is stale (sibling tab won the race), the bridge's
			// own replay-on-subscribe will restore the next pending proposal
			// (if any) without us having to roll back here.
			set((s) => {
				const prev = s.sessionsById[sessionId];
				if (!prev || !prev.pendingPlanApproval) return {};
				if (prev.pendingPlanApproval.proposalId !== proposalId) return {};
				return {
					sessionsById: {
						...s.sessionsById,
						[sessionId]: { ...prev, pendingPlanApproval: undefined },
					},
				};
			});
			get().ws?.send({
				type: "plan_response",
				sessionId,
				proposalId,
				approved,
				...(finalPath !== undefined ? { finalPath } : {}),
				...(editedContent !== undefined ? { editedContent } : {}),
				...(executionStrategy !== undefined ? { executionStrategy } : {}),
			});
		},

		actOnPendingPlanExecution(sessionId, proposalId) {
			get().ws?.send({ type: "plan_execution_action", sessionId, proposalId, action: "execute" });
		},

		markNotificationDelivered(id) {
			set((s) => {
				const i = s.notifications.findIndex((n) => n.id === id);
				if (i < 0 || s.notifications[i]?.deliveredOs) return {};
				const next = s.notifications.slice();
				const target = next[i];
				if (!target) return {};
				next[i] = { ...target, deliveredOs: true };
				return { notifications: next };
			});
		},

		dismissNotification(id) {
			set((s) => {
				const i = s.notifications.findIndex((n) => n.id === id);
				if (i < 0 || s.notifications[i]?.dismissed) return {};
				const next = s.notifications.slice();
				const target = next[i];
				if (!target) return {};
				next[i] = { ...target, dismissed: true };
				return { notifications: next };
			});
		},
	})),
);

// Mirror `activeId` into localStorage (T-52) so a brand-new tab pointed at
// the bare origin — not a specific `/c/:id` URL — reconnects to whatever
// was last open, the same way browser tab-restore already does via the URL
// itself (see `useSessionRoute`/`readLastSessionId`).
useStore.subscribe(
	(s) => s.activeId,
	(activeId) => {
		try {
			if (activeId) localStorage.setItem(LAST_SESSION_STORAGE_KEY, activeId);
			else localStorage.removeItem(LAST_SESSION_STORAGE_KEY);
		} catch {
			/* localStorage unavailable (private mode) — non-fatal */
		}
	},
);

function handleFrame(
	frame: ServerFrame,
	set: (partial: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)) => void,
	get: () => StoreState,
): void {
	switch (frame.type) {
		case "hello":
			set({ connectionId: frame.connectionId });
			// Re-subscribe to any previously-active sessions.
			for (const id of get().subscribed) {
				get().ws?.send({ type: "subscribe", sessionId: id });
			}
			if (get().tasksSubscribed) get().ws?.send({ type: "subscribe_tasks" });
			return;

		case "subscribed":
			set((s) => ({
				sessionsById: {
					...s.sessionsById,
					[frame.sessionId]: initSession(frame.snapshot),
				},
			}));
			return;

		case "unsubscribed":
			// Desired subscriptions are released synchronously before the server
			// acknowledgement arrives. Do not clear a newer re-subscription here.
			return;

		case "session_event": {
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const next = applyEvent(prev, frame.event);
				return { sessionsById: { ...s.sessionsById, [frame.sessionId]: next } };
			});
			return;
		}

		case "tasks_changed":
			set((s) => ({ tasksChangeCounter: s.tasksChangeCounter + 1 }));
			return;

		case "skills_changed":
			set((s) => ({ skillsChangeCounter: s.skillsChangeCounter + 1 }));
			return;

		case "kb_changed":
			set((s) => ({ kbChangeCounter: s.kbChangeCounter + 1 }));
			return;

		case "sessions_changed":
			set((s) => ({ sessionsChangeCounter: s.sessionsChangeCounter + 1 }));
			return;

		case "auto_work_runs_changed":
			set((s) => ({ autoWorkRunsChangeCounter: s.autoWorkRunsChangeCounter + 1 }));
			return;

		case "ext_ui_dialog_open":
			set((s) => ({
				pendingDialogs: { ...s.pendingDialogs, [frame.sessionId]: frame },
			}));
			return;

		case "ext_ui_dialog_cancel":
			set((s) => {
				const current = s.pendingDialogs[frame.sessionId];
				if (!current || current.dialogId !== frame.dialogId) return {};
				const next = { ...s.pendingDialogs };
				delete next[frame.sessionId];
				return { pendingDialogs: next };
			});
			return;

		case "plan_mode_changed":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const planMode: PlanModeContextWire | undefined = frame.enabled
					? {
							enabled: true,
							planFilePath: frame.planFilePath ?? "local://PLAN.md",
							...(frame.modelOverride ? { modelOverride: frame.modelOverride } : {}),
						}
					: undefined;
				// On exit, also drop any unresolved approval card — the bridge
				// has already rejected its standing handler, so leaving the
				// card visible would let the user click into a 409.
				const pendingPlanApproval = frame.enabled ? prev.pendingPlanApproval : undefined;
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...prev, planMode, pendingPlanApproval },
					},
				};
			});
			return;

		case "plan_proposed":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const pending: PendingPlanApprovalWire = {
					proposalId: frame.proposalId,
					planFilePath: frame.planFilePath,
					planContent: frame.planContent,
					suggestedTitle: frame.suggestedTitle,
					suggestedFinalPath: frame.suggestedFinalPath,
				};
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...prev, pendingPlanApproval: pending },
					},
				};
			});
			return;

		case "plan_execution_changed":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const existing = prev.pendingPlanExecution;
				if (frame.status === "dispatched" && existing?.proposalId !== frame.proposalId) return {};
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: {
							...prev,
							pendingPlanExecution: frame.status === "dispatched"
								? undefined
								: {
									proposalId: frame.proposalId,
									planFilePath: frame.planFilePath,
									status: frame.status,
									...(frame.error ? { error: frame.error } : {}),
								},
						},
					},
				};
			});
			return;

		case "plan_proposal_resolved":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev?.pendingPlanApproval) return {};
				if (prev.pendingPlanApproval.proposalId !== frame.proposalId) return {};
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...prev, pendingPlanApproval: undefined },
					},
				};
			});
			return;

		case "session_disposed":
			get().subscribed.delete(frame.sessionId);
			set((s) => {
				const nextSessions = { ...s.sessionsById };
				delete nextSessions[frame.sessionId];
				const nextDialogs = { ...s.pendingDialogs };
				delete nextDialogs[frame.sessionId];
				const nextWatchingSessionCounts = new Map(s.watchingSessionCounts);
				nextWatchingSessionCounts.delete(frame.sessionId);
				return {
					sessionsById: nextSessions,
					pendingDialogs: nextDialogs,
					watchingSessionCounts: nextWatchingSessionCounts,
					activeId: s.activeId === frame.sessionId ? undefined : s.activeId,
				};
			});
			return;

		case "error": {
			const id = frame.sessionId;
			if (!id) return;
			const prev = get().sessionsById[id];
			if (prev) {
				set((s) => ({
					sessionsById: {
						...s.sessionsById,
						[id]: { ...prev, lastError: frame.error },
					},
				}));
				return;
			}
			// No local snapshot yet: this was a `subscribe` attempt against a
			// session this server process doesn't currently have running
			// (idle-reaped, or the server restarted since the tab last saw
			// it). Transparently resume it from disk if it's a session we
			// know about, instead of leaving the tab stuck on a blank state
			// (T-52).
			if (frame.error === "session not active") {
				void get().resumeIfKnown(id);
			}
			return;
		}

		case "heartbeat":
			set(() => ({
				heartbeat: {
					lastReceivedAtMs: Date.now(),
					serverStartedAt: frame.serverStartedAt,
					pid: frame.pid,
					uptimeSecs: frame.uptimeSecs,
					buildSha: frame.buildSha,
					version: frame.version,
				},
			}));
			return;

		case "notification":
			set((s) => {
				// Dedupe by id: server may re-send on reconnect.
				if (s.notifications.some((n) => n.id === frame.id)) return {};
				const item: NotificationItem = {
					id: frame.id,
					level: frame.level,
					title: frame.title,
					timestamp: frame.timestamp,
					receivedAtMs: Date.now(),
					deliveredOs: false,
					dismissed: false,
				};
				if (frame.body !== undefined) item.body = frame.body;
				if (frame.sound !== undefined) item.sound = frame.sound;
				if (frame.source !== undefined) item.source = frame.source;
				if (frame.actionUrl !== undefined) item.actionUrl = frame.actionUrl;
				const next = [...s.notifications, item];
				// Cap retention; oldest fall off.
				if (next.length > MAX_NOTIFICATIONS) next.splice(0, next.length - MAX_NOTIFICATIONS);

				// Also route to the active session's message stream as an inline NoticeMsg
				// so advisories appear chronologically alongside user/assistant turns.
				const noticeId = `notification:${frame.id}`;
				const activeSession = s.activeId ? s.sessionsById[s.activeId] : undefined;
				if (!activeSession) return { notifications: next };
				// Dedup: frame may be re-delivered on reconnect.
				if (activeSession.messages.some((m) => m.id === noticeId)) return { notifications: next };
				const noticeLevel: NoticeMsg["level"] =
					frame.level === "critical" ? "error"
					: frame.level === "warn" ? "warning"
					: frame.level === "error" ? "error"
					: "info";
				const noticeMsg: NoticeMsg = {
					id: noticeId,
					role: "notice",
					level: noticeLevel,
					message: frame.title,
					timestamp: new Date(frame.timestamp).getTime(),
				};
				if (frame.body !== undefined) noticeMsg.body = frame.body;
				if (frame.source !== undefined) noticeMsg.source = frame.source;
				const updatedSession: SessionUi = {
					...activeSession,
					messages: [...activeSession.messages, noticeMsg],
				};
				return {
					notifications: next,
					sessionsById: { ...s.sessionsById, [s.activeId!]: updatedSession },
				};
			});
			return;

		case "pong":
		default:
			return;
	}
}

// Selectors ────────────────────────────────────────────────────────────────
export const selectActiveSession = (s: StoreState): SessionUi | undefined =>
	s.activeId ? s.sessionsById[s.activeId] : undefined;
