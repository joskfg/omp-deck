/**
 * Pure reducer over AgentSessionEvent passthroughs.
 *
 * Builds a coherent UI state from a stream of unknown-shape events. Treats
 * the SDK contract structurally — never imports SDK types — so the protocol
 * boundary stays narrow.
 */

import type { AgentSessionEventJson, SessionSnapshot } from "@omp-deck/protocol";

import type {
	AssistantContentBlock,
	AssistantMsg,
	ChatMessage,
	HandoffMsg,
	HandoffOriginMsg,
	ImageBlock,
	NoticeMsg,
	QueuedPrompt,
	SessionUi,
	TextBlock,
	ToolCallStream,
	TodoPhase,
	UsageRollup,
} from "./types";

// ─── Public API ────────────────────────────────────────────────────────────

let ID_SEQ = 0;
const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${++ID_SEQ}`;

const EMPTY_USAGE: UsageRollup = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};

export function initSession(snapshot: SessionSnapshot): SessionUi {
	const state: SessionUi = {
		sessionId: snapshot.sessionId,
		cwd: snapshot.cwd,
		sessionFile: snapshot.sessionFile,
		sessionName: snapshot.sessionName,
		parentSessionPath: snapshot.parentSessionPath,
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		messages: [],
		toolCalls: {},
		todoPhases: normalizeTodoPhases(snapshot.todoPhases),
		status: snapshot.isStreaming ? "streaming" : "idle",
		usage: { ...EMPTY_USAGE },
		turnCount: 0,
		contextUsage: snapshot.contextUsage,
		queuedPrompts: hydrateQueuedPrompts(snapshot.queuedPrompts),
		planMode: snapshot.planMode,
		pendingPlanApproval: snapshot.pendingPlanApproval,
		pendingPlanExecution: snapshot.pendingPlanExecution,
		goalMode: snapshot.goalMode,
	};
	const base = snapshot.messagesStartIndex ?? 0;
	state.historyStartIndex = base;
	snapshot.messages.forEach((m, i) => {
		ingestMessage(state, m, base + i);
	});
	// A tail-sliced snapshot can't rebuild usage from its messages alone —
	// the server rolls up the FULL history and ships it alongside.
	if (snapshot.usageRollup) {
		state.usage = { ...snapshot.usageRollup };
	}
	return state;
}

/**
 * Prepend one fetched page of older history. The page is ingested in
 * isolation (so usage rollup and queued-prompt draining don't double-apply)
 * and merged in front of the current window. Existing tool-call streams win
 * over re-folded historical ones.
 */
export function prependHistory(
	state: SessionUi,
	messages: SessionSnapshot["messages"],
	startIndex: number,
): SessionUi {
	if (messages.length === 0) {
		return { ...state, historyStartIndex: startIndex, historyLoading: false };
	}
	const temp: SessionUi = {
		...state,
		messages: [],
		toolCalls: {},
		queuedPrompts: [],
		usage: { ...EMPTY_USAGE },
	};
	messages.forEach((m, i) => {
		ingestMessage(temp, m, startIndex + i);
	});
	return {
		...state,
		messages: [...temp.messages, ...state.messages],
		toolCalls: { ...temp.toolCalls, ...state.toolCalls },
		historyStartIndex: startIndex,
		historyLoading: false,
	};
}

/**
 * Shrink the loaded window back to ~`targetCount` messages by dropping the
 * oldest ones (and the tool-call streams they own). Cuts only at a message
 * whose server-side history index is known, so `historyStartIndex` stays a
 * valid re-fetch cursor: scrolling back up re-pages exactly what was
 * dropped. Returns `state` unchanged when there is nothing to trim or no
 * safe cut point exists.
 */
export function trimHistory(state: SessionUi, targetCount: number): SessionUi {
	const excess = state.messages.length - targetCount;
	if (excess <= 0) return state;
	// Latest safe cut at or before `excess` — the newest droppable prefix
	// whose boundary message carries a known srcIndex.
	let cut = -1;
	let cutSrc = 0;
	for (let i = excess; i >= 1; i--) {
		const m = state.messages[i];
		if (m && (m.role === "user" || m.role === "assistant") && typeof m.srcIndex === "number") {
			cut = i;
			cutSrc = m.srcIndex;
			break;
		}
	}
	if (cut <= 0) return state;
	const dropped = state.messages.slice(0, cut);
	// Free the tool-call streams owned by dropped assistant messages; their
	// cards are no longer rendered and re-paging re-folds the results.
	let toolCalls = state.toolCalls;
	const deadIds: string[] = [];
	for (const m of dropped) {
		if (m.role !== "assistant") continue;
		for (const b of m.blocks) {
			if (b.type === "toolCall" && b.id) deadIds.push(b.id);
		}
	}
	if (deadIds.length > 0) {
		toolCalls = { ...state.toolCalls };
		for (const id of deadIds) delete toolCalls[id];
	}
	return {
		...state,
		messages: state.messages.slice(cut),
		toolCalls,
		historyStartIndex: cutSrc,
	};
}

export function applyEvent(state: SessionUi, event: AgentSessionEventJson): SessionUi {
	switch (event.type) {
		// ─── Agent lifecycle ───────────────────────────────────────────────
		case "agent_start":
			return { ...state, lastError: undefined };
		case "agent_end":
			return { ...state, status: "idle" };

		// ─── Turn lifecycle ────────────────────────────────────────────────
		case "turn_start":
			return {
				...state,
				status: "streaming",
				turnCount: state.turnCount + 1,
				lastError: undefined,
			};
		case "turn_end":
			return { ...state, status: "idle" };

		// Synthetic event the deck's bridge emits after the SDK's own turn-end
		// or compaction-complete, carrying the freshly-computed context-window
		// utilization. Lets the header indicator update without re-snapshotting.
		case "context_usage": {
			const usage = (event as { contextUsage?: import("@omp-deck/protocol").ContextUsage }).contextUsage;
			if (!usage) return state;
			return { ...state, contextUsage: usage };
		}

		// Synthetic event the deck's bridge emits after `setModel` (and possibly
		// other session-header mutations) so the UI re-renders the new model
		// label without waiting for the next assistant turn.
		case "session_updated": {
			const snap = (event as { snapshot?: SessionSnapshot }).snapshot;
			if (!snap) return state;
			return {
				...state,
				model: snap.model,
				sessionName: snap.sessionName,
				thinkingLevel: snap.thinkingLevel,
			};
		}

		// ─── Messages ──────────────────────────────────────────────────────
		case "message_start": {
			const msg = (event as any).message;
			if (!msg) return state;
			const next = { ...state, messages: state.messages.slice() };
			ingestMessage(next, msg);
			return next;
		}
		case "message_update": {
			const msg = (event as any).message;
			if (!msg || msg.role !== "assistant") return state;
			return updateAssistantMessage(state, msg);
		}
		case "message_end": {
			const msg = (event as any).message;
			if (!msg) return state;
			return finalizeMessage(state, msg);
		}

		// ─── Tool execution ────────────────────────────────────────────────
		case "tool_execution_start": {
			const id = String((event as any).toolCallId ?? "");
			if (!id) return state;
			const stream: ToolCallStream = {
				id,
				name: String((event as any).toolName ?? "?"),
				args: (event as any).args as Record<string, unknown> | undefined,
				intent: (event as any).intent as string | undefined,
				status: "running",
				isError: false,
				startedAt: Date.now(),
			};
			return { ...state, toolCalls: { ...state.toolCalls, [id]: stream } };
		}
		case "tool_execution_update": {
			const id = String((event as any).toolCallId ?? "");
			const prev = state.toolCalls[id];
			if (!prev) return state;
			return {
				...state,
				toolCalls: {
					...state.toolCalls,
					[id]: { ...prev, partialResult: (event as any).partialResult },
				},
			};
		}
		case "tool_execution_end": {
			const id = String((event as any).toolCallId ?? "");
			const prev = state.toolCalls[id];
			const isError = Boolean((event as any).isError);
			const result = (event as any).result as unknown;
			const next: ToolCallStream = prev
				? {
						...prev,
						status: isError ? "error" : "complete",
						isError,
						result,
						endedAt: Date.now(),
					}
				: {
						id,
						name: String((event as any).toolName ?? "?"),
						args: undefined,
						status: isError ? "error" : "complete",
						isError,
						result,
						startedAt: Date.now(),
						endedAt: Date.now(),
					};
			const nextState = { ...state, toolCalls: { ...state.toolCalls, [id]: next } };
			// T-97: roll up sub-agent usage into the parent CostStrip when the
			// task tool completes successfully. The SDK places the aggregated
			// usage in `result.details.usage`, `rollupUsage` handles the
			// `{ cost: { total } }` object shape via `extractUsage`.
			if (!isError && next.name === "task" && result && typeof result === "object") {
				const details = (result as Record<string, unknown>).details;
				if (details && typeof details === "object") {
					rollupUsage(nextState, (details as Record<string, unknown>).usage);
				}
			}
			return nextState;
		}

		// ─── Todos ─────────────────────────────────────────────────────────
		case "todo_reminder": {
			const todos = (event as any).todos as unknown;
			return { ...state, todoPhases: normalizeTodoPhases([todos]) };
		}
		// Synthetic event emitted by the deck bridge after every `todo`
		// `tool_execution_end`. Carries the canonical `TodoPhase[]` from
		// `session.getTodoPhases()` so the Inspector reflects in-turn changes
		// without waiting for the next SDK reminder tick (T-106).
		case "todo_phases_set": {
			const phases = (event as { todoPhases?: unknown }).todoPhases;
			return { ...state, todoPhases: normalizeTodoPhases(phases) };
		}
		case "todo_auto_clear":
			// The SDK clears completed tasks from its live cache after a delay, but
			// the deck should keep the last rendered list until a new todo
			// explicitly replaces it.
			return state;

		// ─── Compaction / retry / TTSR ────────────────────────────────────
		case "auto_compaction_start":
			return {
				...state,
				status: "compacting",
				compaction: {
					reason: String((event as any).reason ?? ""),
					action: String((event as any).action ?? ""),
					startedAt: Date.now(),
				},
			};
		case "auto_compaction_end": {
			const next: SessionUi = { ...state, status: "streaming", compaction: undefined };
			const result = (event as any).result;
			if (result && typeof result === "object") {
				const summary =
					typeof (result as any).shortSummary === "string"
						? (result as any).shortSummary
						: typeof (result as any).summary === "string"
							? (result as any).summary
							: undefined;
				next.messages = [
					...state.messages,
					{
						id: nextId("compaction"),
						role: "compaction",
						reason: String((event as any).reason ?? state.compaction?.reason ?? ""),
						action: String((event as any).action ?? state.compaction?.action ?? ""),
						summary,
						timestamp: Date.now(),
					},
				];
			}
			return next;
		}
		// T-32: deck-synthetic marker for a completed auto-handoff — see
		// `bridge/in-process.ts`'s `session_handoff` emission doc comment.
		// Appended alongside (not instead of) the `auto_compaction_end` case
		// above, which already cleared `compaction`/`status`.
		case "session_handoff": {
			const handoffMsg: HandoffMsg = {
				id: nextId("handoff"),
				role: "handoff",
				reason: String((event as any).reason ?? ""),
				previousSessionId: String((event as any).previousSessionId ?? ""),
				previousSessionFile:
					typeof (event as any).previousSessionFile === "string" ? (event as any).previousSessionFile : undefined,
				newSessionId: String((event as any).newSessionId ?? ""),
				newSessionFile: typeof (event as any).newSessionFile === "string" ? (event as any).newSessionFile : undefined,
				timestamp: typeof (event as any).timestamp === "number" ? (event as any).timestamp : Date.now(),
			};
			return {
				...state,
				messages: [...state.messages, handoffMsg],
				// This tab's own `sessionId` deliberately stays put (see server
				// docs) — the live handle keeps streaming into this SAME
				// subscription — but `sessionFile`/`parentSessionPath` must follow
				// the swap so the header's origin breadcrumb and any path-based
				// API call reflect the session this tab now actually represents.
				...(handoffMsg.newSessionFile ? { sessionFile: handoffMsg.newSessionFile } : {}),
				...(handoffMsg.previousSessionFile ? { parentSessionPath: handoffMsg.previousSessionFile } : {}),
			};
		}
		case "auto_retry_start":
			return {
				...state,
				status: "retrying",
				retry: {
					attempt: Number((event as any).attempt ?? 0),
					maxAttempts: Number((event as any).maxAttempts ?? 0),
					errorMessage: String((event as any).errorMessage ?? ""),
				},
			};
		case "auto_retry_end":
			return {
				...state,
				status: "streaming",
				retry: undefined,
				lastError: (event as any).success ? undefined : ((event as any).finalError as string | undefined),
			};
		case "retry_fallback_applied":
			return pushNotice(state, {
				level: "warning",
				message: `Fallback applied: ${(event as any).from} → ${(event as any).to} (${(event as any).role})`,
				source: "retry",
			});
		case "retry_fallback_succeeded":
			return pushNotice(state, {
				level: "info",
				message: `Recovered on ${(event as any).model} (${(event as any).role})`,
				source: "retry",
			});
		case "ttsr_triggered":
			return {
				...state,
				ttsr: {
					rules: ((event as any).rules as Array<{ name?: string; description?: string }>) ?? [],
					at: Date.now(),
				},
				messages: [
					...state.messages,
					{
						id: nextId("ttsr"),
						role: "ttsr",
						rules: ((event as any).rules as any[]) ?? [],
						timestamp: Date.now(),
					},
				],
			};

		// ─── Misc surface ──────────────────────────────────────────────────
		case "notice":
			return pushNotice(state, {
				level: ((event as any).level as "info" | "warning" | "error") ?? "info",
				message: String((event as any).message ?? ""),
				source: (event as any).source as string | undefined,
			});
		case "thinking_level_changed":
			return {
				...state,
				thinkingLevel: (event as any).thinkingLevel as string | undefined,
			};
		case "goal_updated": {
			const goal = (event as any).goal as Record<string, unknown> | null;
			const goalState = (event as any).state as { enabled?: boolean; reason?: "completed" } | undefined;
			if (!goal) return { ...state, goal: null, goalMode: undefined };
			return {
				...state,
				goal: { goal, state: goalState },
				goalMode: {
					enabled: goalState?.enabled === true,
					objective: String(goal.objective ?? ""),
					status: (goal.status as any) ?? "paused",
					tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : undefined,
					tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
					timeUsedSeconds: typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : 0,
					reason: goalState?.reason,
				},
			};
		}
		case "irc_message": {
			const msg = (event as any).message;
			if (!msg) return state;
			return {
				...state,
				messages: [
					...state.messages,
					{
						id: nextId("irc"),
						role: "irc",
						customType: msg.customType as string | undefined,
						content: extractText(msg.content),
						from: (msg.attribution as string | undefined) ?? undefined,
						timestamp: Date.now(),
					},
				],
			};
		}

		// ─── Prompt queue (synthetic events emitted by the bridge) ────────
		// `prompt_queued` fires when the user sends a prompt while the agent
		// is mid-turn — the SDK queues it and runs it once the current turn
		// ends. Surface it as a visible bubble so the draft does not appear
		// to vanish. `queue_cleared` fires when the SDK queue is dropped
		// (explicit `clear_queue` from the user, or `abort` which mirrors
		// stop-everything intent).
		case "prompt_queued": {
			const ev = event as {
				queuedId?: string;
				text?: string;
				images?: ImageBlock[];
				behavior?: "followUp" | "steer";
			};
			const entry: QueuedPrompt = {
				id: typeof ev.queuedId === "string" && ev.queuedId.length > 0
					? ev.queuedId
					: nextId("queued"),
				text: typeof ev.text === "string" ? ev.text : "",
				behavior: ev.behavior === "steer" ? "steer" : "followUp",
				queuedAt: Date.now(),
			};
			if (Array.isArray(ev.images) && ev.images.length > 0) entry.images = ev.images;
			return { ...state, queuedPrompts: [...state.queuedPrompts, entry] };
		}
		case "queue_cleared":
			return state.queuedPrompts.length === 0
				? state
				: { ...state, queuedPrompts: [] };

		// `queue_state` is the authoritative re-broadcast emitted after a
		// cancel / edit / drain so the client replaces its `queuedPrompts`
		// wholesale instead of patching deltas. Also fires on every
		// `prompt_queued` so the snapshot id-ordering stays canonical.
		case "queue_state": {
			const ev = event as { queue?: unknown };
			const next = hydrateQueuedPrompts(ev.queue);
			if (next.length === state.queuedPrompts.length && next.every((q, i) => {
				const prev = state.queuedPrompts[i];
				return prev && prev.id === q.id && prev.text === q.text;
			})) {
				return state;
			}
			return { ...state, queuedPrompts: next };
		}
	}
	return state;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function pushNotice(state: SessionUi, p: Omit<NoticeMsg, "id" | "role" | "timestamp">): SessionUi {
	return {
		...state,
		messages: [
			...state.messages,
			{
				id: nextId("notice"),
				role: "notice",
				timestamp: Date.now(),
				...p,
			},
		],
	};
}

function ingestMessage(state: SessionUi, msg: any, srcIndex?: number): void {
	if (!msg || typeof msg !== "object") return;
	switch (msg.role) {
		case "user": {
			const text = extractText(msg.content);
			const synthetic = Boolean(msg.synthetic);
			state.messages.push({
				id: nextId("user"),
				role: "user",
				text,
				images: extractImages(msg.content),
				timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
				synthetic,
				srcIndex,
			});
			// If this real user message corresponds to a previously-queued prompt
			// (same text, FIFO), drop the queued bubble so we don't render the
			// same message twice. Synthetic round-trips (slash echoes) don't
			// originate from the composer, so they never match the queue.
			if (!synthetic && state.queuedPrompts.length > 0 && text.length > 0) {
				const idx = state.queuedPrompts.findIndex((q) => q.text === text);
				if (idx >= 0) {
					state.queuedPrompts = [
						...state.queuedPrompts.slice(0, idx),
						...state.queuedPrompts.slice(idx + 1),
					];
				}
			}
			return;
		}
		case "assistant": {
			state.messages.push({
				id: nextId("asst"),
				role: "assistant",
				blocks: extractAssistantBlocks(msg.content),
				model: typeof msg.model === "string" ? msg.model : undefined,
				provider: typeof msg.provider === "string" ? msg.provider : undefined,
				usage: extractUsage(msg.usage),
				stopReason: typeof msg.stopReason === "string" ? msg.stopReason : undefined,
				isStreaming: false,
				errorMessage: typeof msg.errorMessage === "string" ? msg.errorMessage : undefined,
				timestamp: typeof msg.timestamp === "number" ? msg.timestamp : undefined,
				durationMs: typeof msg.duration === "number" ? msg.duration : undefined,
				ttft: typeof msg.ttft === "number" ? msg.ttft : undefined,
				srcIndex,
			});
			if (msg.usage) {
				rollupUsage(state, msg.usage);
			}
			return;
		}
		case "toolResult": {
			// Don't add as a top-level message — fold into the toolCalls map so
			// the chat renders the tool's lifecycle as a single inline card.
			const id = String(msg.toolCallId ?? "");
			if (!id) return;
			const content = Array.isArray(msg.content)
				? (msg.content
						.map((c: any) => normalizeTextOrImage(c))
						.filter(Boolean) as Array<TextBlock | ImageBlock>)
				: [];
			const prev = state.toolCalls[id];
			state.toolCalls[id] = prev
				? {
						...prev,
						resultContent: content,
						isError: Boolean(msg.isError ?? prev.isError),
						status: msg.isError ? "error" : prev.status === "running" ? "complete" : prev.status,
						endedAt: prev.endedAt ?? Date.now(),
					}
				: {
						id,
						name: String(msg.toolName ?? "?"),
						args: undefined,
						resultContent: content,
						status: msg.isError ? "error" : "complete",
						isError: Boolean(msg.isError),
						startedAt: Date.now(),
						endedAt: Date.now(),
					};
			return;
		}
		// T-32: the SDK persists the transferred summary a session began with
		// (because it continues an earlier one via auto-handoff) as a
		// `role: "custom", customType: "handoff"` entry — the FIRST message of
		// the new session. Reconstructed here so it survives reloads and
		// server restarts alike (see HandoffOriginMsg doc comment).
		case "custom": {
			if (msg.customType !== "handoff") return;
			const raw = extractText(msg.content);
			const match = /^<handoff-context>\n([\s\S]*?)\n<\/handoff-context>/.exec(raw);
			state.messages.push({
				id: nextId("handoff-origin"),
				role: "handoff_origin",
				document: match?.[1] ?? raw,
				timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
			} satisfies HandoffOriginMsg);
			return;
		}
		default:
			return;
	}
}

function updateAssistantMessage(state: SessionUi, msg: any): SessionUi {
	const messages = state.messages.slice();
	// Walk backward to find the last assistant message.
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.role === "assistant") {
			const updated: AssistantMsg = {
				...m,
				blocks: extractAssistantBlocks(msg.content),
				isStreaming: true,
				model: typeof msg.model === "string" ? msg.model : m.model,
				provider: typeof msg.provider === "string" ? msg.provider : m.provider,
			};
			messages[i] = updated;
			return { ...state, messages };
		}
	}
	// Fallback: synthesize.
	messages.push({
		id: nextId("asst"),
		role: "assistant",
		blocks: extractAssistantBlocks(msg.content),
		isStreaming: true,
		model: typeof msg.model === "string" ? msg.model : undefined,
		provider: typeof msg.provider === "string" ? msg.provider : undefined,
	});
	return { ...state, messages };
}

function finalizeMessage(state: SessionUi, msg: any): SessionUi {
	if (!msg || typeof msg !== "object") return state;
	if (msg.role !== "assistant") return state;
	const messages = state.messages.slice();
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.role === "assistant") {
			messages[i] = {
				...m,
				blocks: extractAssistantBlocks(msg.content),
				isStreaming: false,
				model: typeof msg.model === "string" ? msg.model : m.model,
				provider: typeof msg.provider === "string" ? msg.provider : m.provider,
				usage: extractUsage(msg.usage) ?? m.usage,
				stopReason: typeof msg.stopReason === "string" ? msg.stopReason : m.stopReason,
				errorMessage: typeof msg.errorMessage === "string" ? msg.errorMessage : m.errorMessage,
				timestamp: typeof msg.timestamp === "number" ? msg.timestamp : m.timestamp,
				durationMs: typeof msg.duration === "number" ? msg.duration : m.durationMs,
				ttft: typeof msg.ttft === "number" ? msg.ttft : m.ttft,
			};
			const next = { ...state, messages };
			if (msg.usage) {
				rollupUsage(next, msg.usage);
			}
			return next;
		}
	}
	return state;
}

function extractAssistantBlocks(content: unknown): AssistantContentBlock[] {
	if (!Array.isArray(content)) return [];
	const out: AssistantContentBlock[] = [];
	for (const c of content) {
		if (!c || typeof c !== "object") continue;
		const type = (c as any).type;
		if (type === "text" && typeof (c as any).text === "string") {
			out.push({ type: "text", text: (c as any).text });
		} else if (type === "thinking" && typeof (c as any).thinking === "string") {
			out.push({ type: "thinking", thinking: (c as any).thinking });
		} else if (type === "redactedThinking") {
			out.push({ type: "redactedThinking", data: String((c as any).data ?? "") });
		} else if (type === "toolCall") {
			out.push({
				type: "toolCall",
				id: String((c as any).id ?? ""),
				name: String((c as any).name ?? "?"),
				arguments: ((c as any).arguments ?? {}) as Record<string, unknown>,
				intent: (c as any).intent as string | undefined,
			});
		}
	}
	return out;
}

function normalizeTextOrImage(c: any): TextBlock | ImageBlock | null {
	if (!c || typeof c !== "object") return null;
	if (c.type === "text" && typeof c.text === "string") return { type: "text", text: c.text };
	if (c.type === "image" && typeof c.data === "string")
		return { type: "image", data: c.data, mimeType: String(c.mimeType ?? "image/png") };
	return null;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const c of content) {
			if (c && typeof c === "object" && (c as any).type === "text") {
				parts.push(String((c as any).text ?? ""));
			}
		}
		return parts.join("");
	}
	return "";
}

function extractImages(content: unknown): ImageBlock[] | undefined {
	if (!Array.isArray(content)) return undefined;
	const out: ImageBlock[] = [];
	for (const c of content) {
		const norm = normalizeTextOrImage(c);
		if (norm && norm.type === "image") out.push(norm);
	}
	return out.length > 0 ? out : undefined;
}

function extractUsage(u: unknown): UsageRollup | undefined {
	if (!u || typeof u !== "object") return undefined;
	const r = u as Record<string, unknown>;
	const cost =
		r.cost && typeof r.cost === "object"
			? Number((r.cost as Record<string, unknown>).total ?? 0)
			: 0;
	return {
		input: Number(r.input ?? 0),
		output: Number(r.output ?? 0),
		cacheRead: Number(r.cacheRead ?? 0),
		cacheWrite: Number(r.cacheWrite ?? 0),
		totalTokens: Number(r.totalTokens ?? 0),
		cost: Number.isFinite(cost) ? cost : 0,
		reasoningTokens: typeof r.reasoningTokens === "number" ? r.reasoningTokens : undefined,
	};
}

function rollupUsage(state: SessionUi, raw: unknown): void {
	const u = extractUsage(raw);
	if (!u) return;
	state.usage = {
		input: state.usage.input + u.input,
		output: state.usage.output + u.output,
		cacheRead: state.usage.cacheRead + u.cacheRead,
		cacheWrite: state.usage.cacheWrite + u.cacheWrite,
		totalTokens: state.usage.totalTokens + u.totalTokens,
		cost: state.usage.cost + u.cost,
		reasoningTokens:
			state.usage.reasoningTokens !== undefined || u.reasoningTokens !== undefined
				? (state.usage.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0)
				: undefined,
	};
}

function normalizeTodoPhases(raw: unknown): TodoPhase[] {
	if (!Array.isArray(raw)) return [];
	const out: TodoPhase[] = [];
	for (const p of raw) {
		if (!p) continue;
		// Two shapes seen in practice:
		//   - TodoPhase: { id, name, tasks: TodoItem[] }
		//   - bare TodoItem[]: array passed directly via todo_reminder.todos
		if (Array.isArray(p)) {
			out.push({ tasks: (p as any[]).map(coerceTask) });
		} else if (typeof p === "object") {
			const phase = p as Record<string, unknown>;
			const tasks = Array.isArray(phase.tasks) ? (phase.tasks as any[]).map(coerceTask) : [];
			out.push({
				id: typeof phase.id === "string" ? phase.id : undefined,
				name: typeof phase.name === "string" ? phase.name : undefined,
				tasks,
			});
		}
	}
	return out;
}

function coerceTask(t: any) {
	return {
		id: typeof t?.id === "string" ? t.id : undefined,
		content: String(t?.content ?? ""),
		status: String(t?.status ?? "pending"),
		notes: Array.isArray(t?.notes) ? (t.notes as unknown[]).map(String) : undefined,
	};
}
/**
 * Normalize the wire shape (`QueuedPromptWire[]`) into the UI's
 * `QueuedPrompt[]`. Tolerates missing optional fields and skips anything
 * that doesn't carry at least an id+text — the bridge is canonical but the
 * reducer guards against malformed events from older server builds.
 */
function hydrateQueuedPrompts(raw: unknown): QueuedPrompt[] {
	if (!Array.isArray(raw)) return [];
	const out: QueuedPrompt[] = [];
	for (const r of raw) {
		if (!r || typeof r !== "object") continue;
		const w = r as {
			id?: unknown;
			text?: unknown;
			images?: unknown;
			behavior?: unknown;
			queuedAt?: unknown;
		};
		if (typeof w.id !== "string" || w.id.length === 0) continue;
		const entry: QueuedPrompt = {
			id: w.id,
			text: typeof w.text === "string" ? w.text : "",
			behavior: w.behavior === "steer" ? "steer" : "followUp",
			queuedAt: typeof w.queuedAt === "number" ? w.queuedAt : Date.now(),
		};
		if (Array.isArray(w.images) && w.images.length > 0) {
			entry.images = w.images as ImageBlock[];
		}
		out.push(entry);
	}
	return out;
}
