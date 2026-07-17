/**
 * Server-side session-title generation (T-78).
 *
 * omp-deck's in-process bridge talks to the SDK's `AgentSession`/`SessionManager`
 * directly, bypassing the `omp` CLI's own "input controller" — which is where the
 * SDK's native auto-title generator normally lives (see the comment on
 * `InProcessSessionHandle.setName` in `bridge/in-process.ts`). That generator never
 * fires for deck-driven sessions, so without this module the only titling
 * mechanism is the agent's own self-titling behavior, which only runs after
 * the agent has already done a turn of work — never "first".
 *
 * This uses the bridge's sessionless title request with only the session-title
 * integration as its system prompt. It is gated entirely behind the
 * `internalTaskModel` setting (`db/server-settings.ts`) — `null` (the default)
 * means this is a no-op, so an unconfigured install behaves exactly as before.
 */

import { broadcastBus } from "./broadcast-bus.ts";
import type { AgentBridge, SessionHandle } from "./bridge/types.ts";
import { getInternalTaskModel } from "./db/server-settings.ts";
import { getTask } from "./db/tasks.ts";
import { resolveIntegrationPrompt } from "./integration-prompts.ts";
import { KbService, resolveKbRoot } from "./kb-service.ts";
import { logger } from "./log.ts";

const log = logger("session-title");

const autoTitleInFlight = new Map<string, Promise<void>>();


/** Internal task ids look like `t_01kx1s8fxrt7ss33k4` — the convention used by
 *  the "Open in chat" / "Assign to agent" flows embeds one in the prompt
 *  (e.g. `GET /api/tasks/t_01kx1s8fxrt7ss33k4`). Best-effort context signal —
 *  when absent, title generation just proceeds without task context. */
const TASK_ID_PATTERN = /\bt_[a-z0-9]{18}\b/;

/**
 * Generates a title for a brand-new session from its first user message.
 * Returns `undefined` when the feature is off, the model call fails, or the
 * model returns nothing usable — callers should leave the session untitled
 * rather than fall back to a placeholder.
 */
export async function generateSessionTitle(
	bridge: AgentBridge,
	opts: { sessionId: string; firstMessage: string },
): Promise<string | undefined> {
	const model = getInternalTaskModel();
	if (!model) return undefined;

	const taskIdMatch = TASK_ID_PATTERN.exec(opts.firstMessage);
	const task = taskIdMatch ? getTask(taskIdMatch[0]) : undefined;
	const userMessage = [
		`First user message:\n${opts.firstMessage}`,
		task ? `Linked kanban task: T-${task.displayId}: ${task.title}\n${task.body ?? ""}` : "",
	].filter(Boolean).join("\n\n");

	try {
		const text = await bridge.generateTitle({
			sessionId: opts.sessionId,
			model,
			systemPrompt: await resolveSessionTitleIntegrationPrompt(),
			userMessage,
		});
		return text ? sanitizeTitle(text) || undefined : undefined;
	} catch (err) {
		log.warn("session-title generation failed", err);
		return undefined;
	}
}

/**
 * Fire-and-forget: generates and persists a session's title from its first
 * user message exactly once, the moment the session's first turn starts.
 * Shared by the regular WS chat flow (`WsHub#maybeAutoTitleSession`, T-78)
 * and the Auto Work engine (T-94) so both paths title "on first turn, never
 * again" identically — skips already-named sessions, and is itself a no-op
 * when `internalTaskModel` is unset (`generateSessionTitle`'s own gate).
 */
export function maybeAutoTitleSession(bridge: AgentBridge, handle: SessionHandle, firstMessage: string): void {
	if (!getInternalTaskModel() || autoTitleInFlight.has(handle.sessionId)) return;
	let task: Promise<void>;
	task = Promise.resolve()
		.then(async () => {
			try {
				const snapshot = await handle.snapshot();
				if (snapshot.sessionName) return;
				const title = await generateSessionTitle(bridge, { sessionId: handle.sessionId, firstMessage });
				if (!title) return;
				await handle.setName(title);
				broadcastBus.broadcast({ type: "sessions_changed" });
			} catch (err) {
				log.warn(`auto-title failed for session ${handle.sessionId}`, err);
			}
		})
		.finally(() => {
			if (autoTitleInFlight.get(handle.sessionId) === task) {
				autoTitleInFlight.delete(handle.sessionId);
			}
		});
	autoTitleInFlight.set(handle.sessionId, task);
}

function resolveSessionTitleIntegrationPrompt(): Promise<string> {
	return resolveIntegrationPrompt(new KbService({ root: resolveKbRoot() }), "session-title");
}

/** First line, strip wrapping quotes/backticks the model sometimes adds, cap length. */
function sanitizeTitle(text: string): string {
	const firstLine = text.trim().split("\n")[0] ?? "";
	return firstLine.replace(/^["'`]+|["'`]+$/g, "").trim().slice(0, 100);
}
