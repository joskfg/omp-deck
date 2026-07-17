import * as path from "node:path";
import type { ServerWebSocket } from "bun";
import type { ClientFrame, ServerFrame } from "@omp-deck/protocol";

import type { AgentBridge, SessionHandle } from "./bridge/types.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { logger } from "./log.ts";
import { getBuildInfo, getUptimeSecs } from "./build-info.ts";
import { getInternalTaskModel } from "./db/server-settings.ts";
import { maybeAutoTitleSession as sharedMaybeAutoTitleSession } from "./session-title.ts";
import { buildSkillInvocationPrompt, parseSkillSlashCommand } from "./skill-invocation.ts";
import { StreamCoalescer } from "./stream-coalescer.ts";
import type { SkillsService } from "./skills-service.ts";
const log = logger("ws");

/** Per-connection state. */
export interface ConnectionData {
	connectionId: string;
	subscriptions: Map<string, () => void>;
	tasksSubscribed: boolean;
}

/**
 * Interval between heartbeat broadcasts, in milliseconds. The web client
 * expects roughly one frame per 5s; missed frames (>15s gap) drive the
 * "disconnected" indicator.
 */
export const HEARTBEAT_INTERVAL_MS = 5000;

export class WsHub {
	private readonly connections = new Set<ServerWebSocket<ConnectionData>>();
	private readonly titledSessions = new Set<string>();
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private unsubscribeBroadcastBus: (() => void) | null = null;

	constructor(
		private bridge: AgentBridge,
		private skills: SkillsService,
	) {
		this.unsubscribeBroadcastBus = broadcastBus.subscribe((frame) => this.broadcast(frame));
		this.startHeartbeat();
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer) return;
		this.heartbeatTimer = setInterval(() => {
			try {
				const info = getBuildInfo();
				// Push through the shared bus so any subscriber (the hub itself, future
				// telemetry, tests) sees the frame, not just connected WS sockets.
				broadcastBus.broadcast({
					type: "heartbeat",
					serverStartedAt: info.serverStartedAt,
					pid: info.pid,
					uptimeSecs: getUptimeSecs(),
					buildSha: info.buildSha,
					version: info.version,
					timestamp: new Date().toISOString(),
				});
			} catch (err) {
				// An uncaught throw here is fatal to the whole process — Bun (like
				// Node) tears down the process on an unhandled exception inside a
				// setInterval callback. One bad tick must never take the deck down.
				log.error(`heartbeat tick failed`, err);
			}
		}, HEARTBEAT_INTERVAL_MS);
		// Deliberately ref'd (the default) — NOT unref()'d. This is a persistent
		// server process kept alive by the HTTP listener regardless, so there was
		// never a real benefit to unref-ing this timer. Previously it was
		// unref()'d "to not keep the event loop alive solely for heartbeats"; a
		// production instance (multi-day uptime, heavy memory/swap pressure)
		// was observed to stop emitting heartbeats entirely — no crash, no error
		// logged, every other route/WS traffic unaffected — while a freshly
		// started process running the exact same code reproduced heartbeats
		// correctly every time. That signature matches the unref'd-timer path
		// (a narrower, less-exercised feature than Bun's ref'd default) losing
		// the timer under load rather than a logic bug in this callback. Ref'd
		// removes that dependency entirely; the try/catch above is an
		// independent hardening so a future thrown error degrades to a logged
		// miss instead of crashing the whole server.
	}

	/** For tests + clean shutdown. After dispose, no more heartbeats fire. */
	dispose(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.unsubscribeBroadcastBus) {
			this.unsubscribeBroadcastBus();
			this.unsubscribeBroadcastBus = null;
		}
	}

	createConnectionData(): ConnectionData {
		return {
			connectionId: crypto.randomUUID(),
			subscriptions: new Map(),
			tasksSubscribed: false,
		};
	}

	onOpen(ws: ServerWebSocket<ConnectionData>): void {
		this.connections.add(ws);
		send(ws, { type: "hello", connectionId: ws.data.connectionId });
		log.debug(`open ${ws.data.connectionId}`);
	}

	async onMessage(ws: ServerWebSocket<ConnectionData>, raw: string | Buffer): Promise<void> {
		let frame: ClientFrame;
		try {
			frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as ClientFrame;
		} catch {
			send(ws, { type: "error", error: "invalid json" });
			return;
		}

		try {
			switch (frame.type) {
				case "ping":
					send(ws, { type: "pong" });
					return;

				case "subscribe":
					await this.handleSubscribe(ws, frame.sessionId);
					return;

				case "unsubscribe":
					this.handleUnsubscribe(ws, frame.sessionId);
					return;

				case "subscribe_tasks":
					ws.data.tasksSubscribed = true;
					return;

				case "unsubscribe_tasks":
					ws.data.tasksSubscribed = false;
					return;

				case "prompt":
					await this.handlePrompt(ws, frame);
					return;

				case "abort":
					await this.handleAbort(ws, frame.sessionId);
					return;

				case "clear_queue":
					await this.handleClearQueue(ws, frame.sessionId);
					return;

				case "cancel_queued":
					await this.handleCancelQueued(ws, frame);
					return;

				case "edit_queued":
					await this.handleEditQueued(ws, frame);
					return;

				case "ext_ui_dialog_response":
					this.handleExtUiDialogResponse(ws, frame);
					return;

				case "set_plan_mode":
					await this.handleSetPlanMode(ws, frame);
					return;

				case "plan_response":
					await this.handlePlanResponse(ws, frame);
					return;
				case "plan_execution_action":
					await this.handlePlanExecutionAction(ws, frame);
					return;
				case "goal_action":
					await this.handleGoalAction(ws, frame);
					return;

				default:
					send(ws, { type: "error", error: `unknown frame type` });
			}
		} catch (err) {
			log.warn(`message handling failed`, err);
			try {
				send(ws, { type: "error", error: "message handling failed" });
			} catch (sendErr) {
				log.warn(`message error send failed`, sendErr);
			}
		}
	}

	onClose(ws: ServerWebSocket<ConnectionData>): void {
		this.connections.delete(ws);
		const subs = ws.data.subscriptions;
		const connectionId = ws.data.connectionId;
		log.debug(`close ${connectionId} subs=${subs.size}`);
		for (const [sessionId, unsub] of subs.entries()) {
			try {
				unsub();
			} catch (err) {
				log.warn(`unsubscribe on close failed`, err);
			}
			this.bridge.trackSubscriberRemoved(sessionId, connectionId);
		}
		subs.clear();
	}

	private broadcast(frame: ServerFrame): void {
		const payload = JSON.stringify(frame);
		for (const ws of this.connections) {
			if (frame.type === "tasks_changed" && !ws.data.tasksSubscribed) continue;
			try {
				ws.send(payload);
			} catch (err) {
				log.warn(`broadcast send failed`, err);
			}
		}
	}

	// ───────────────────────────────────────────────────────────────────────

	private async handleSubscribe(ws: ServerWebSocket<ConnectionData>, sessionId: string): Promise<void> {
		const connectionId = ws.data.connectionId;
		if (ws.data.subscriptions.has(sessionId)) {
			const handle = this.bridge.getSession(sessionId);
			if (handle) {
				this.bridge.bumpActivity(sessionId);
				send(ws, { type: "subscribed", sessionId, snapshot: await handle.snapshot() });
			}
			return;
		}

		const handle = this.bridge.getSession(sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId, error: "session not active" });
			return;
		}

		let coalescer: StreamCoalescer | undefined;
		let unsubSession: (() => void) | undefined;
		let unsubUi: (() => void) | undefined;
		let unsubPlan: (() => void) | undefined;
		let released = false;
		let subscriberTracked = false;
		const teardown = (): void => {
			if (released) return;
			released = true;
			coalescer?.dispose();
			try {
				unsubSession?.();
			} catch (err) {
				log.warn(`session unsubscribe threw`, err);
			}
			try {
				unsubUi?.();
			} catch (err) {
				log.warn(`ui unsubscribe threw`, err);
			}
			try {
				unsubPlan?.();
			} catch (err) {
				log.warn(`plan-mode unsubscribe threw`, err);
			}
		};

		// Claim this session before installing listeners or awaiting a snapshot.
		// A concurrent subscribe now observes the reservation and cannot replace
		// this teardown, which would orphan the first set of listeners.
		ws.data.subscriptions.set(sessionId, teardown);

		try {
			this.bridge.trackSubscriberAdded(sessionId, connectionId);
			subscriberTracked = true;
			// Streaming updates (`message_update` / `tool_execution_update`) fire
			// per token / output chunk, each carrying the full accumulated payload
			// — per-subscriber coalescing caps that at one flush per interval and
			// is lossless because those events are latest-state snapshots. All
			// other event types pass through immediately.
			coalescer = new StreamCoalescer((event) => {
				try {
					send(ws, { type: "session_event", sessionId, event });
				} catch (err) {
					// A timer-driven flush must never throw into Bun's event loop
					// (fatal to the process) just because the socket is closing.
					log.warn(`session event send failed`, err);
				}
			});
			unsubSession = handle.subscribe((event) => coalescer?.push(event));
			// Mirror extension-UI dialog frames (ask tool etc.) into this connection.
			// `subscribeUiFrames` also replays any already-open dialogs so a page-
			// reload subscriber sees the pending modal immediately.
			unsubUi = this.bridge.subscribeUiFrames(sessionId, (frame) => {
				try {
					send(ws, frame);
				} catch (err) {
					log.warn(`ui frame send failed`, err);
				}
			});
			// Mirror plan-mode lifecycle frames (mode-changed + proposed + resolved)
			// into this connection. `subscribePlanModeFrames` replays the current
			// plan-mode state + any pending approval card so a late tab re-renders
			// the pill + approval UI immediately.
			unsubPlan = this.bridge.subscribePlanModeFrames(sessionId, (frame) => {
				try {
					send(ws, frame);
				} catch (err) {
					log.warn(`plan-mode frame send failed`, err);
				}
			});
			send(ws, { type: "subscribed", sessionId, snapshot: await handle.snapshot() });
		} catch (err) {
			teardown();
			if (ws.data.subscriptions.get(sessionId) === teardown) {
				ws.data.subscriptions.delete(sessionId);
				if (subscriberTracked) this.bridge.trackSubscriberRemoved(sessionId, connectionId);
			}
			throw err;
		}
	}

	private handleUnsubscribe(ws: ServerWebSocket<ConnectionData>, sessionId: string): void {
		const unsub = ws.data.subscriptions.get(sessionId);
		if (unsub) {
			unsub();
			ws.data.subscriptions.delete(sessionId);
			this.bridge.trackSubscriberRemoved(sessionId, ws.data.connectionId);
		}
		send(ws, { type: "unsubscribed", sessionId });
	}

	private async handlePrompt(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "prompt" }>,
	): Promise<void> {
		const handle = this.bridge.getSession(frame.sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId: frame.sessionId, error: "session not active" });
			return;
		}
		this.maybeAutoTitleSession(handle, frame.sessionId, frame.text);
		const opts: { streamingBehavior?: "steer" | "followUp"; images?: typeof frame.images } = {};
		// Default to "followUp" so a prompt sent while the agent is mid-turn is
		// queued instead of throwing AgentBusyError (which the user never sees —
		// it just looks like the message vanished). The web composer can still
		// override to "steer" when we surface that affordance.
		opts.streamingBehavior = frame.streamingBehavior ?? "followUp";
		if (frame.images && frame.images.length > 0) opts.images = frame.images;
		this.bridge.bumpActivity(frame.sessionId);
		const sendError = (err: unknown): void => {
			send(ws, {
				type: "error",
				sessionId: frame.sessionId,
				error: `prompt failed: ${String(err)}`,
			});
		};
		if (frame.text.startsWith("/")) {
			// `/skill:<name>` isn't in the SDK's ACP-builtin registry (that's
			// TUI-only plumbing gated behind InteractiveModeContext — see
			// skill-invocation.ts's header comment). Intercept it here, ahead of
			// the deck/SDK dispatch chain, and reimplement the same
			// read-SKILL.md/strip-frontmatter/inject-as-user-message behavior
			// against the deck's own SkillsService. A near-miss name (no skill
			// found) intentionally falls through to the unchanged dispatch
			// chain below rather than erroring — same as today's behavior for
			// any other unrecognized slash command.
			const parsedSkill = parseSkillSlashCommand(frame.text);
			if (parsedSkill) {
				this.skills
					.getSkillDetailByName(parsedSkill.name, handle.cwd)
					.then((detail) => {
						if (!detail) return this.dispatchNonSkillSlashCommand(handle, frame.text, opts);
						const baseDir = path.dirname(detail.skillPath);
						const composed = buildSkillInvocationPrompt(
							{ name: detail.name, body: detail.body, baseDir },
							parsedSkill.args,
						);
						return handle.prompt(composed, opts);
					})
					.catch(sendError);
				return;
			}
			await this.dispatchNonSkillSlashCommand(handle, frame.text, opts).catch(sendError);
			return;
		}
		handle.prompt(frame.text, opts).catch(sendError);
	}

	/**
	 * Fire-and-forget: T-78 server-side title generation. Runs at most once per
	 * session (`titledSessions` guard, marked before the async work starts so
	 * two rapid prompts can't both fire) and only when `internalTaskModel` is
	 * configured — an unconfigured install pays only the Set lookup + one
	 * `getInternalTaskModel()` read per prompt. Auto-work and other internal
	 * one-shot sessions never reach here: they never go through this WS
	 * client-prompt path, only through direct `session.prompt()` calls in
	 * `auto-work/engine.ts` / `routes.ts`, which title via the same shared
	 * `maybeAutoTitleSession` helper from `session-title.ts` directly (T-94).
	 */
	private maybeAutoTitleSession(handle: SessionHandle, sessionId: string, firstMessage: string): void {
		if (this.titledSessions.has(sessionId)) return;
		if (!getInternalTaskModel()) return;
		this.titledSessions.add(sessionId);
		sharedMaybeAutoTitleSession(this.bridge, handle, firstMessage);
	}

	/** The pre-T-21 slash dispatch chain: deck-native commands, then SDK ACP builtins, then plain prompt. */
	private dispatchNonSkillSlashCommand(
		handle: NonNullable<ReturnType<AgentBridge["getSession"]>>,
		text: string,
		opts: { streamingBehavior?: "steer" | "followUp"; images?: unknown },
	): Promise<unknown> {
		return handle.dispatchDeckSlashCommand(text).then((deck) => {
			if (deck.kind === "consumed") return undefined;
			if (deck.kind === "rewritten") return handle.prompt(deck.prompt, opts as never);
			return handle.dispatchSlashCommand(text).then((sdk) => {
				if (sdk.kind === "consumed") return undefined;
				if (sdk.kind === "rewritten") return handle.prompt(sdk.prompt, opts as never);
				return handle.prompt(text, opts as never);
			});
		});
	}

	private async handleAbort(ws: ServerWebSocket<ConnectionData>, sessionId: string): Promise<void> {
		const handle = this.bridge.getSession(sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId, error: "session not active" });
			return;
		}
		this.bridge.bumpActivity(sessionId);
		try {
			await handle.abort();
		} catch (err) {
			send(ws, { type: "error", sessionId, error: `abort failed: ${String(err)}` });
		}
	}

	private async handleClearQueue(ws: ServerWebSocket<ConnectionData>, sessionId: string): Promise<void> {
		const handle = this.bridge.getSession(sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId, error: "session not active" });
			return;
		}
		this.bridge.bumpActivity(sessionId);
		try {
			await handle.clearQueue();
		} catch (err) {
			send(ws, { type: "error", sessionId, error: `clear queue failed: ${String(err)}` });
		}
	}

	private async handleCancelQueued(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "cancel_queued" }>,
	): Promise<void> {
		const handle = this.bridge.getSession(frame.sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId: frame.sessionId, error: "session not active" });
			return;
		}
		this.bridge.bumpActivity(frame.sessionId);
		try {
			await handle.cancelQueuedById(frame.queuedId);
		} catch (err) {
			send(ws, {
				type: "error",
				sessionId: frame.sessionId,
				error: `cancel queued failed: ${String(err)}`,
			});
		}
	}

	private async handleEditQueued(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "edit_queued" }>,
	): Promise<void> {
		const handle = this.bridge.getSession(frame.sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId: frame.sessionId, error: "session not active" });
			return;
		}
		// Refuse silently-empty edits — the user almost certainly meant cancel.
		if (!frame.text || frame.text.trim().length === 0) {
			send(ws, {
				type: "error",
				sessionId: frame.sessionId,
				error: "edit_queued: text required (use cancel_queued to drop)",
			});
			return;
		}
		this.bridge.bumpActivity(frame.sessionId);
		try {
			await handle.editQueuedById(frame.queuedId, frame.text, frame.images);
		} catch (err) {
			send(ws, {
				type: "error",
				sessionId: frame.sessionId,
				error: `edit queued failed: ${String(err)}`,
			});
		}
	}

	private handleExtUiDialogResponse(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "ext_ui_dialog_response" }>,
	): void {
		// We don't gate on subscription state here: a user can answer a dialog
		// from any connection that received the open frame (the bridge replays
		// pending frames on subscribe). Bumping activity keeps the reaper away
		// while the user is mid-decision.
		this.bridge.bumpActivity(frame.sessionId);
		const { type: _t, sessionId, dialogId, ...response } = frame;
		void _t;
		try {
			this.bridge.respondToUiDialog(sessionId, dialogId, response);
		} catch (err) {
			log.warn(`respondToUiDialog threw`, err);
			send(ws, {
				type: "error",
				sessionId,
				error: `ext_ui_dialog_response failed: ${String(err)}`,
			});
		}
	}

	private async handleSetPlanMode(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "set_plan_mode" }>,
	): Promise<void> {
		const handle = this.bridge.getSession(frame.sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId: frame.sessionId, error: "session not active" });
			return;
		}
		this.bridge.bumpActivity(frame.sessionId);
		try {
			await handle.setPlanMode(frame.enabled);
		} catch (err) {
			log.warn(`setPlanMode threw`, err);
			send(ws, {
				type: "error",
				sessionId: frame.sessionId,
				error: `set_plan_mode failed: ${String((err as Error).message ?? err)}`,
			});
		}
	}

	private async handleGoalAction(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "goal_action" }>,
	): Promise<void> {
		const handle = this.bridge.getSession(frame.sessionId);
		if (!handle) {
			send(ws, { type: "error", sessionId: frame.sessionId, error: "session not active" });
			return;
		}
		if (frame.action === "create" && !frame.objective?.trim()) {
			send(ws, { type: "error", sessionId: frame.sessionId, error: "goal_action create requires an objective" });
			return;
		}
		if (frame.action !== "create" && frame.objective !== undefined) {
			send(ws, { type: "error", sessionId: frame.sessionId, error: "objective is only valid for goal_action create" });
			return;
		}
		this.bridge.bumpActivity(frame.sessionId);
		try {
			await handle.actOnGoal({
				action: frame.action,
				...(frame.objective !== undefined ? { objective: frame.objective } : {}),
				...(frame.tokenBudget !== undefined ? { tokenBudget: frame.tokenBudget } : {}),
			} as import("./bridge/goal-mode-bridge.ts").GoalAction);
		} catch (err) {
			log.warn(`goal_action threw`, err);
			send(ws, {
				type: "error",
				sessionId: frame.sessionId,
				error: `goal_action failed: ${String((err as Error).message ?? err)}`,
			});
		}
	}

	private async handlePlanResponse(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "plan_response" }>,
	): Promise<void> {
		// Like ext_ui_dialog_response: any connection that observed the
		// plan_proposed (replayed on subscribe) is allowed to answer. We
		// bump activity to keep the reaper away while the user is mid-
		// decision and during the renaming/synthetic-prompt phase.
		this.bridge.bumpActivity(frame.sessionId);
		const { approved, finalPath, editedContent, executionStrategy, proposalId, sessionId } = frame;
		try {
			const outcome = await this.bridge.respondToPlanApproval(sessionId, proposalId, {
				approved,
				...(finalPath !== undefined ? { finalPath } : {}),
				...(editedContent !== undefined ? { editedContent } : {}),
				...(executionStrategy !== undefined ? { executionStrategy } : {}),
			});
			if (outcome === "unknown") {
				// 409-equivalent: stale/double-click. The client rolls back its
				// optimistic UI. The bridge already broadcasts the canonical
				// `plan_proposal_resolved` from whichever side won the race.
				send(ws, {
					type: "error",
					sessionId,
					error: `plan_response: proposal ${proposalId} already resolved or unknown`,
				});
			}
		} catch (err) {
			log.warn(`respondToPlanApproval threw`, err);
			send(ws, {
				type: "error",
				sessionId,
				error: `plan_response failed: ${String((err as Error).message ?? err)}`,
			});
		}
	}
	private async handlePlanExecutionAction(
		ws: ServerWebSocket<ConnectionData>,
		frame: Extract<ClientFrame, { type: "plan_execution_action" }>,
	): Promise<void> {
		this.bridge.bumpActivity(frame.sessionId);
		try {
			const outcome = await this.bridge.actOnPendingPlanExecution(frame.sessionId, frame.proposalId);
			if (outcome === "unknown") {
				send(ws, {
					type: "error",
					sessionId: frame.sessionId,
					error: `plan_execution_action: proposal ${frame.proposalId} already resolved or unknown`,
				});
			}
		} catch (err) {
			log.warn(`actOnPendingPlanExecution threw`, err);
			send(ws, {
				type: "error",
				sessionId: frame.sessionId,
				error: `plan_execution_action failed: ${String((err as Error).message ?? err)}`,
			});
		}
	}

}

function send(ws: ServerWebSocket<ConnectionData>, frame: ServerFrame): void {
	ws.send(JSON.stringify(frame));
}
