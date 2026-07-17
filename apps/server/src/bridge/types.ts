import type {
	AgentMessageJson,
	AgentSessionEventJson,
	ContextUsage,
	ExtUiDialogResponse,
	GoalModeContextWire,
	ImageAttachment,
	ModelInfo,
	ModelRef,
	PendingPlanApprovalWire,
	PendingPlanExecutionWire,
	PlanExecutionStrategy,
	PlanModeContextWire,
	QueuedPromptWire,
	ServerFrame,
	SessionHistoryResponse,
	SessionSnapshot,
	SessionSummary,
	SessionTreeResponse,
} from "@omp-deck/protocol";
import type { GoalAction } from "./goal-mode-bridge.ts";

export type MaybePromise<T> = T | Promise<T>;

/**
 * Abstract bridge to omp. Production uses one SDK-hosting child process per
 * active root session; sessionless catalog and persistence operations stay in
 * the parent. Anything the server needs from omp MUST flow through this API.
 */
export interface AgentBridge {
	createSession(opts: CreateSessionOpts): Promise<SessionHandle>;
	resumeSession(opts: ResumeSessionOpts): Promise<SessionHandle>;
	getSession(sessionId: string): SessionHandle | undefined;
	listSessions(opts: { cwd?: string }): Promise<SessionSummary[]>;
	/**
	 * Permanently delete a session: dispose any live handle, then drop the
	 * underlying `.jsonl` file + artifact dir from disk (idempotent — an
	 * already-gone file is a success, not an error). `deleted: false` means
	 * the id matched neither a live handle nor the persisted listing.
	 */
	deleteSession(sessionId: string): Promise<{ deleted: boolean; sessionPath?: string }>;
	/**
	 * Read-only tree/timeline for a session's entries (T-31) — works for both
	 * a live session and a persisted-only one. Undefined when `sessionId`
	 * resolves to neither a live handle nor a persisted listing entry.
	 */
	getSessionTree(sessionId: string): Promise<SessionTreeResponse | undefined>;
	/**
	 * Fork a brand-new session file rooted at `entryId`'s root→leaf path in
	 * `sessionId`'s history (T-31). Pure copy — never mutates or rewrites the
	 * source session, live or persisted. Returns the new file's path so the
	 * caller can `resumeSession({sessionPath})` it into a live handle.
	 * Undefined when `sessionId` can't be resolved.
	 */
	forkSessionAt(sessionId: string, entryId: string): Promise<{ sessionFile: string; cwd: string } | undefined>;
	/** Pin a session against the idle reaper while a client is subscribed. */
	trackSubscriberAdded(sessionId: string, connectionId: string): void;
	/** Drop a subscriber; once subscribers hit zero and idle window elapses, the reaper claims it. */
	trackSubscriberRemoved(sessionId: string, connectionId: string): void;
	/** Bump last-activity-ts; called for explicit user actions outside subscribe. */
	bumpActivity(sessionId: string): void;
	/** Hot-apply runtime env values that do not require process restart. */
	applyEnvUpdate?(update: RuntimeEnvUpdate): void;
	/** Catalog of models the SDK knows about, plus a marker on the current one when sessionId is given. */
	listModels(opts?: { sessionId?: string }): Promise<ModelInfo[]>;
	/** Generates a session title with the configured model without creating an agent session. */
	generateTitle(opts: GenerateTitleOpts): Promise<string | null>;
	/**
	 * Subscribe to extension-UI dialog frames for `sessionId` (open + cancel).
	 * Returns an unsubscribe function. Implementations MAY immediately replay
	 * any already-open dialogs to a new subscriber so a late client (page
	 * reload, second tab) does not miss an active modal.
	 */
	subscribeUiFrames(
		sessionId: string,
		listener: (frame: Extract<ServerFrame, { type: "ext_ui_dialog_open" | "ext_ui_dialog_cancel" }>) => void,
	): () => void;
	/** Settle a previously-emitted dialog with the client's response. */
	respondToUiDialog(sessionId: string, dialogId: string, response: ExtUiDialogResponse): void;
	/**
	 * Subscribe to plan-mode frames for `sessionId` (mode-changed + proposed +
	 * resolved). Returns an unsubscribe function. Implementations MAY replay
	 * the current `plan_mode_changed` and any pending `plan_proposed` to a
	 * late subscriber so a page-reload during plan mode re-renders the pill
	 * and the approval card immediately.
	 */
	subscribePlanModeFrames(
		sessionId: string,
		listener: (
			frame: Extract<
				ServerFrame,
				{ type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" | "plan_execution_changed" }
			>,
		) => void,
	): () => void;
	/**
	 * Settle a previously-emitted plan-approval proposal with the client's
	 * response. Returns `"settled"` on success, `"unknown"` when the
	 * proposalId is unknown or already resolved (caller surfaces a 409 to
	 * the client so optimistic UI can roll back).
	 */
	respondToPlanApproval(
		sessionId: string,
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown">;
	actOnPendingPlanExecution(sessionId: string, proposalId: string): Promise<"settled" | "unknown">;
	dispose(): Promise<void>;
}

export interface RuntimeEnvUpdate {
	idleTimeoutMs?: number;
}

export interface GenerateTitleOpts {
	sessionId: string;
	model: ModelRef;
	systemPrompt: string;
	userMessage: string;
}

export interface CreateSessionOpts {
	cwd: string;
	model?: ModelRef;
	/**
	 * Narrow backend one-shot profile. The bridge disables UI, extension discovery,
	 * MCP discovery, and LSP for this session. It must be paired with a
	 * purpose-specific system prompt override, never used for normal chat sessions.
	 */
	internal?: boolean;
	/** Enter Plan Mode immediately after the SDK session is attached. */
	planMode?: boolean;
	/** Thinking level forwarded to the SDK's `createAgentSession` (T-73). */
	thinking?: string;
	/**
	 * Replaces the deck's normal `kb/system` prelude (`getEffectivePrelude()`)
	 * for this session only. For lightweight internal one-shot sessions (e.g.
	 * T-77's branch-name slug generator) that need a narrow, purpose-built
	 * system prompt instead of the full org-wide prelude. Leave unset for
	 * every normal user-facing session.
	 */
	systemPromptOverride?: string;
	/**
	 * Extra text inserted right after the prelude (or `systemPromptOverride`,
	 * if also set) and before the SDK's own default system-prompt blocks:
	 * `[prelude, systemPromptAppend, ...defaults]`. For internal callers that
     * need the normal `kb/system` prelude PLUS a narrow addendum — e.g. the
     * auto-work engine appending `kb/integrations/auto-work.md` so its
     * task-execution sessions see the commit/PR/Validate-column workflow.
     * Leave unset for every normal user-facing session.
	 */
	systemPromptAppend?: string;
}

export interface ResumeSessionOpts {
	sessionPath: string;
	/** Same semantics as `CreateSessionOpts.systemPromptAppend` — applied on
	 *  top of the normal prelude when a persisted session is resumed (e.g.
	 *  the auto-work engine resuming a run after a server restart still
	 *  needs the auto-work rules in the rebuilt system prompt). */
	systemPromptAppend?: string;
}

export type EventListener = (event: AgentSessionEventJson) => void;

export interface SessionHandle {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly cwd: string;

	subscribe(listener: EventListener): () => void;
	snapshot(): MaybePromise<SessionSnapshot>;
	/**
	 * One page of message history older than index `before` (exclusive),
	 * newest-last. Complements the tail-sliced `snapshot()`: the client
	 * walks `before` backwards (starting at the snapshot's
	 * `messagesStartIndex`) until `startIndex` reaches 0.
	 */
	getHistory(before: number, limit: number): MaybePromise<SessionHistoryResponse>;
	prompt(
		text: string,
		opts?: { streamingBehavior?: "steer" | "followUp"; images?: ImageAttachment[] },
	): Promise<void>;
	/** True iff a turn is currently in-flight. Used by the WS layer to decide
	 *  whether a freshly-arrived prompt is being queued vs. running immediately. */
	isStreamingNow(): MaybePromise<boolean>;
	/** Number of prompts the SDK currently has queued (steering + follow-up +
	 *  hidden next-turn). */
	queuedMessageCount(): MaybePromise<number>;
	/** Drop every queued prompt. Returns the per-bucket counts that were
	 *  cleared so the caller can surface a `queue_cleared` event. */
	clearQueue(): MaybePromise<{ steering: number; followUp: number }>;
	/**
	 * Snapshot of the bridge-tracked shadow queue (the user-visible queue
	 * mirrored from the SDK). Includes stable `id`s the client can use to
	 * target a specific entry for cancel/edit. Empty when no turn is in flight.
	 */
	getQueueSnapshot(): MaybePromise<QueuedPromptWire[]>;
	/**
	 * Cancel a single queued prompt by its `id`. Returns true if an entry
	 * was removed, false if the id was unknown (already drained, etc).
	 * Emits a synthetic `queue_state` event on success so subscribers
	 * reconcile their `queuedPrompts` list.
	 */
	cancelQueuedById(id: string): Promise<boolean>;
	/**
	 * Replace a queued prompt's text (and optionally images) in place.
	 * Returns true if the edit landed, false if the id was unknown.
	 * Implementation pops every SDK queue entry synchronously then
	 * re-enqueues survivors with the edited entry substituted — order
	 * preserved. Emits a synthetic `queue_state` event on success.
	 */
	editQueuedById(
		id: string,
		text: string,
		images?: ImageAttachment[],
	): Promise<boolean>;
	abort(): Promise<void>;
	setName(name: string): Promise<void>;
	/**
	 * Trigger manual compaction with optional focus instructions. Resolves once
	 * the SDK acknowledges the call; the actual compaction event arrives via
	 * the regular session event stream so the deck UI can react.
	 */
	compact(focus?: string): Promise<void>;
	/** Swap the live agent session to a different model. Throws on unknown ref or missing auth. */
	setModel(ref: ModelRef): Promise<void>;
	/** Set the active thinking level. Pass `"off"` to disable explicitly; any level from `ModelInfo.thinkingLevels` to enable. */
	setThinkingLevel(level: string): Promise<void>;
	/**
	 * Try to dispatch a leading slash command via the omp SDK's text-mode
	 * dispatcher. Returns `"fallthrough"` when nothing matched — caller should
	 * forward the original text via `prompt()`. `"consumed"` means the SDK ran
	 * the command and there is no follow-up turn. `"rewritten"` means the
	 * command produced a new prompt string the caller should send instead.
	 */
	dispatchSlashCommand(text: string): Promise<SlashDispatchResult>;
	/**
	 * Try to dispatch a leading slash command via the deck's own registry
	 * (kanban operations etc). Same return shape as `dispatchSlashCommand` so
	 * the WS hub can branch identically.
	 */
	dispatchDeckSlashCommand(text: string): Promise<SlashDispatchResult>;
	/**
	 * Snapshot of context-window utilization. Returns `undefined` when the
	 * underlying model has no declared context window.
	 */
	getContextUsage(): MaybePromise<ContextUsage | undefined>;
	dispose(): Promise<void>;
	/** Idempotent enter/exit. No-op when state already matches. */
	setPlanMode(enabled: boolean): Promise<void>;
	/** Read the bridge's plan-mode context for snapshot replay. */
	getPlanModeContext(): MaybePromise<PlanModeContextWire | undefined>;
	/** Read the unresolved plan-approval card for snapshot replay. */
	getPendingPlanApproval(): MaybePromise<PendingPlanApprovalWire | undefined>;
	/** Read compact-before-execute recovery state for snapshot replay. */
	getPendingPlanExecution(): MaybePromise<PendingPlanExecutionWire | undefined>;
	respondToPlanApproval(
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown">;
	actOnPendingPlanExecution(proposalId: string): Promise<"settled" | "unknown">;
	/** Execute a Goal Mode lifecycle action for this session. */
	actOnGoal(action: GoalAction): Promise<void>;
	/** Read Goal Mode state for snapshot replay. */
	getGoalModeContext(): MaybePromise<GoalModeContextWire | undefined>;
}

export type SlashDispatchResult =
	| { kind: "fallthrough" }
	| { kind: "consumed"; output: string }
	| { kind: "rewritten"; output: string; prompt: string };

export interface AgentMessagePassthrough extends AgentMessageJson {}
/**
 * Decision the user made on a `plan_proposed` card. `approved=false` is the
 * reject path (no rename, no synthetic prompt — just exit plan mode); the
 * other fields apply only when approving.
 */
export interface PlanApprovalResponse {
	approved: boolean;
	/** Defaults to `keep_context` when absent for old clients. */
	executionStrategy?: PlanExecutionStrategy;
	/** Ignored: plan files remain at their original path on current SDK versions. */
	finalPath?: string;
	/** Optional edited plan body. When present, overwrites `local://PLAN.md` before approval. */
	editedContent?: string;
}
