/**
 * Local UI types derived from the protocol contract.
 *
 * The web app reduces AgentSessionEvent passthroughs into this shape so the
 * components render against a stable, opinionated state — never against the
 * raw SDK events.
 */

import type { GoalModeContextWire, ModelRef, PendingPlanApprovalWire, PendingPlanExecutionWire, PlanModeContextWire } from "@omp-deck/protocol";

// ─── Content blocks ────────────────────────────────────────────────────────

export interface TextBlock {
	type: "text";
	text: string;
}
export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}
export interface RedactedThinkingBlock {
	type: "redactedThinking";
	data: string;
}
export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	intent?: string;
}
export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export type AssistantContentBlock =
	| TextBlock
	| ThinkingBlock
	| RedactedThinkingBlock
	| ToolCallBlock;

// ─── Messages ──────────────────────────────────────────────────────────────

export interface UserMsg {
	id: string;
	role: "user";
	text: string;
	images?: ImageBlock[];
	timestamp?: number;
	synthetic?: boolean;
	/** Index of this message in the server-side history, when known (messages
	 * hydrated from a snapshot or a history page — not live-streamed ones).
	 * Used as the paging/trim cursor. */
	srcIndex?: number;
}

export interface AssistantMsg {
	id: string;
	role: "assistant";
	blocks: AssistantContentBlock[];
	model?: string;
	provider?: string;
	usage?: UsageRollup;
	stopReason?: string;
	isStreaming: boolean;
	errorMessage?: string;
	timestamp?: number;
	durationMs?: number;
	ttft?: number;
	/** See {@link UserMsg.srcIndex}. */
	srcIndex?: number;
}

export interface ToolResultMsg {
	id: string;
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<TextBlock | ImageBlock>;
	isError: boolean;
	timestamp?: number;
}

export interface NoticeMsg {
	id: string;
	role: "notice";
	level: "info" | "warning" | "error";
	message: string;
	/** Secondary detail, e.g. from a `notification` frame's `body` field. */
	body?: string;
	source?: string;
	timestamp: number;
}

export interface CompactionMsg {
	id: string;
	role: "compaction";
	reason: string;
	action: string;
	summary?: string;
	timestamp: number;
}

export interface TtsrMsg {
	id: string;
	role: "ttsr";
	rules: Array<{ name?: string; description?: string; body?: string }>;
	timestamp: number;
}

export interface IrcMsg {
	id: string;
	role: "irc";
	customType?: string;
	content: string;
	from?: string;
	timestamp: number;
}

/**
 * Live transition marker (T-32) — rendered inline at the moment the SDK's
 * auto-handoff compaction strategy swaps this session onto a brand-new
 * file+id. From the deck's synthetic `session_handoff` event, never
 * persisted by the SDK — a page reload after this fires still shows it
 * because the live handle keeps emitting the underlying session's messages
 * into the SAME subscription (see server `bridge/in-process.ts` docs), but
 * a reload against a DIFFERENT process (server restart) loses it — the
 * complementary `HandoffOriginMsg` below covers that case from the new
 * session's side.
 */
export interface HandoffMsg {
	id: string;
	role: "handoff";
	reason: string;
	previousSessionId: string;
	previousSessionFile?: string;
	newSessionId: string;
	newSessionFile?: string;
	timestamp: number;
}

/**
 * Persisted marker (T-32) — the transferred summary a session began with
 * because it continues an earlier one via auto-handoff. Reconstructed from
 * the SDK's own `role: "custom", customType: "handoff"` transcript entry,
 * so it survives reloads and server restarts alike.
 */
export interface HandoffOriginMsg {
	id: string;
	role: "handoff_origin";
	document: string;
	timestamp: number;
}

export type ChatMessage =
	| UserMsg
	| AssistantMsg
	| ToolResultMsg
	| NoticeMsg
	| CompactionMsg
	| TtsrMsg
	| IrcMsg
	| HandoffMsg
	| HandoffOriginMsg;

// ─── Queued prompts (sent while agent was streaming) ──────────────────────

export interface QueuedPrompt {
	/** Stable id assigned by the server when the SDK queued the prompt.
	 *  Used as React key and for targeted future-cancellation if we add per-
	 *  bubble × buttons later. */
	id: string;
	text: string;
	images?: ImageBlock[];
	/** "followUp" (run after current turn) vs "steer" (interrupt). Today every
	 *  composer-driven prompt uses "followUp"; "steer" is reserved for a
	 *  future affordance. */
	behavior: "followUp" | "steer";
	/** Bridge clock at enqueue. Used purely for chronological display. */
	queuedAt: number;
}

// ─── Tool call lifecycle ───────────────────────────────────────────────────

export interface ToolCallStream {
	id: string;
	name: string;
	args: Record<string, unknown> | undefined;
	intent?: string;
	status: "running" | "complete" | "error";
	partialResult?: unknown;
	result?: unknown;
	isError: boolean;
	startedAt: number;
	endedAt?: number;
	/** Set when a paired tool_result message arrives. Mirrors result content for compatibility. */
	resultContent?: Array<TextBlock | ImageBlock>;
}

// ─── Todos ─────────────────────────────────────────────────────────────────

export interface TodoTask {
	id?: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "dropped" | string;
	notes?: string[];
}

export interface TodoPhase {
	id?: string;
	name?: string;
	tasks: TodoTask[];
}

// ─── Cost / usage ──────────────────────────────────────────────────────────

export interface UsageRollup {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	reasoningTokens?: number;
}

// ─── Session ───────────────────────────────────────────────────────────────

export interface SessionUi {
	sessionId: string;
	cwd: string;
	sessionFile?: string;
	sessionName?: string;
	/** Set when this session itself is a fork/handoff of another session (T-31). */
	parentSessionPath?: string;
	model?: ModelRef;
	thinkingLevel?: string;

	messages: ChatMessage[];
	/**
	 * Server-side history index of `messages[0]`'s underlying entry — the
	 * `before` cursor for paging older messages. `0` means the full history
	 * is loaded. Grows again when the tail window is trimmed.
	 */
	historyStartIndex?: number;
	/** True while a history page fetch is in flight. */
	historyLoading?: boolean;
	/** Tool calls keyed by toolCallId for richer per-call rendering. */
	toolCalls: Record<string, ToolCallStream>;
	todoPhases: TodoPhase[];

	status: "idle" | "streaming" | "compacting" | "retrying";

	retry?: {
		attempt: number;
		maxAttempts: number;
		errorMessage: string;
	};

	compaction?: {
		reason: string;
		action: string;
		startedAt: number;
	};

	ttsr?: {
		rules: Array<{ name?: string; description?: string }>;
		at: number;
	};

	mode?: { mode: string; data?: unknown };
	goal?: { goal: unknown; state?: unknown } | null;

	usage: UsageRollup;
	turnCount: number;
	/**
	 * Live context-window utilization. `undefined` when the model doesn't
	 * declare a window. Updated by the bridge's synthetic `context_usage` event
	 * after every turn-end / compaction.
	 */
	contextUsage?: import("@omp-deck/protocol").ContextUsage;

	/** Latest provider error displayed in chrome (cleared on next turn_start). */
	lastError?: string;

	/**
	 * Prompts the user sent while the agent was streaming. The SDK queues them
	 * (as `followUp` by default) and runs each one as a new turn after the
	 * current one finishes. We track them client-side so the chat renders a
	 * visible "queued" bubble per pending prompt instead of swallowing the
	 * draft silently. Dropped entry-by-entry when the matching real user
	 * `message_start` arrives, or all at once on `queue_cleared`.
	 */
	queuedPrompts: QueuedPrompt[];

	/**
	 * Plan-mode state (T-105). `planMode` is present iff the session is in
	 * plan mode at the moment of subscribe / since the last `plan_mode_changed`
	 * frame. `pendingPlanApproval` is the unresolved card (set from
	 * `plan_proposed`, cleared on `plan_proposal_resolved` / approval response).
	 */
	planMode?: PlanModeContextWire;
	pendingPlanApproval?: PendingPlanApprovalWire;
	pendingPlanExecution?: PendingPlanExecutionWire;
	/** Goal Mode state, present for active and paused autonomous objectives. */
	goalMode?: GoalModeContextWire;
}
