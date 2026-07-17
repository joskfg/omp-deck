import * as path from "node:path";

import type {
	AgentSessionEventJson,
	ContextUsage,
	ExtUiDialogResponse,
	GoalModeContextWire,
	ImageAttachment,
	ModelInfo,
	ModelRef,
	PendingPlanApprovalWire,
	PendingPlanExecutionWire,
	PlanModeContextWire,
	QueuedPromptWire,
	SessionHistoryResponse,
	SessionSnapshot,
	SessionSummary,
	SessionTreeResponse,
} from "@omp-deck/protocol";

import { broadcastBus } from "../broadcast-bus.ts";
import { recordExtensionLoadErrors } from "../governance-service.ts";
import { logger } from "../log.ts";
import { resolveBunExecutable } from "../runtime-bun.ts";
import { InProcessAgentBridge } from "./in-process.ts";
import { forkSessionFile, readSessionTree } from "./session-tree.ts";
import type { GoalAction } from "./goal-mode-bridge.ts";
import type {
	SerializedWorkerError,
	WorkerArgs,
	WorkerMethod,
	WorkerOutboundFrame,
	WorkerPlanFrame,
	WorkerRequestFrame,
	WorkerResult,
	WorkerSessionMetadata,
	WorkerUiFrame,
} from "./worker-protocol.ts";
import type {
	AgentBridge,
	CreateSessionOpts,
	EventListener,
	GenerateTitleOpts,
	PlanApprovalResponse,
	ResumeSessionOpts,
	RuntimeEnvUpdate,
	SessionHandle,
	SlashDispatchResult,
} from "./types.ts";

const log = logger("bridge:process");
const CHILD_SUBSCRIBER_ID = "process-bridge-parent";
type WorkerUiOpenFrame = Extract<WorkerUiFrame, { type: "ext_ui_dialog_open" }>;
type WorkerPlanModeChangedFrame = Extract<WorkerPlanFrame, { type: "plan_mode_changed" }>;
type WorkerPlanProposedFrame = Extract<WorkerPlanFrame, { type: "plan_proposed" }>;
type WorkerPlanExecutionFrame = Extract<WorkerPlanFrame, { type: "plan_execution_changed" }>;

export interface AgentWorkerProcess {
	send(message: WorkerRequestFrame): void;
	kill(): void;
	readonly exited: Promise<number>;
}

export type AgentWorkerSpawn = (onMessage: (message: unknown) => void) => AgentWorkerProcess;

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface ActiveProcess {
	process: AgentWorkerProcess;
	pending: Map<string, PendingRequest>;
	handle: ProcessSessionHandle | undefined;
	sessionId: string | undefined;
	closed: boolean;
	lastActivityAt: number;
	turnInFlight: boolean;
	subscribers: Set<string>;
	childSubscriberActive: boolean;
	uiListeners: Set<(frame: WorkerUiFrame) => void>;
	uiChannelSubscribed: boolean;
	pendingUiFrames: Map<string, WorkerUiOpenFrame>;
	planListeners: Set<(frame: WorkerPlanFrame) => void>;
	planChannelSubscribed: boolean;
	currentPlanModeFrame: WorkerPlanModeChangedFrame | undefined;
	pendingPlanFrame: WorkerPlanProposedFrame | undefined;
	pendingPlanExecutionFrame: WorkerPlanExecutionFrame | undefined;
	disposal: Promise<void> | undefined;
}

export interface ProcessAgentBridgeOptions {
	workerEntryPath: string;
	idleTimeoutMs?: number;
	reapIntervalMs?: number;
	/** Test seam; production always uses the Bun worker factory when omitted. */
	spawnWorker?: AgentWorkerSpawn;
}

export class ProcessAgentBridge implements AgentBridge {
	private readonly workerEntryPath: string;
	private readonly spawnWorker: AgentWorkerSpawn;
	private readonly sessionlessBridge = new InProcessAgentBridge({
		idleTimeoutMs: 0,
	});
	private readonly active = new Map<string, ActiveProcess>();
	private readonly processes = new Set<ActiveProcess>();
	private readonly pendingResumes = new Map<string, Promise<ProcessSessionHandle>>();
	private idleTimeoutMs: number;
	private readonly reapIntervalMs: number;
	private reaperTimer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(options: ProcessAgentBridgeOptions) {
		this.workerEntryPath = options.workerEntryPath;
		this.spawnWorker =
			options.spawnWorker ??
			((onMessage) => spawnAgentWorker(this.workerEntryPath, onMessage));
		this.idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60_000;
		this.reapIntervalMs = options.reapIntervalMs ?? 60_000;
		if (this.idleTimeoutMs > 0) this.startReaper();
	}

	async createSession(opts: CreateSessionOpts): Promise<SessionHandle> {
		return this.spawnSession("bridge.createSession", [opts]);
	}

	resumeSession(opts: ResumeSessionOpts): Promise<SessionHandle> {
		const sessionPath = path.resolve(opts.sessionPath);
		for (const record of this.active.values()) {
			const live = record.handle;
			if (live?.sessionFile && path.resolve(live.sessionFile) === sessionPath) {
				return Promise.resolve(live);
			}
		}

		const pending = this.pendingResumes.get(sessionPath);
		if (pending) return pending;
		const resume = this.spawnSession("bridge.resumeSession", [opts]).finally(() => {
			if (this.pendingResumes.get(sessionPath) === resume) this.pendingResumes.delete(sessionPath);
		});
		this.pendingResumes.set(sessionPath, resume);
		return resume;
	}

	getSession(sessionId: string): SessionHandle | undefined {
		return this.active.get(sessionId)?.handle;
	}

	listSessions(opts: { cwd?: string }): Promise<SessionSummary[]> {
		return this.sessionlessBridge.listSessions(opts);
	}

	async deleteSession(sessionId: string): Promise<{ deleted: boolean; sessionPath?: string }> {
		const live = this.active.get(sessionId)?.handle;
		if (live) await live.dispose();
		return this.sessionlessBridge.deleteSession(sessionId);
	}

	/**
	 * Reads directly off the live worker's `sessionFile` when the session is
	 * active (never disposes it — this is a read, not a delete), otherwise
	 * falls back to the sessionless bridge's persisted-listing resolution.
	 */
	getSessionTree(sessionId: string): Promise<SessionTreeResponse | undefined> {
		const liveFile = this.active.get(sessionId)?.handle?.sessionFile;
		if (liveFile) return readSessionTree(liveFile);
		return this.sessionlessBridge.getSessionTree(sessionId);
	}

	/** Same live/persisted resolution as {@link getSessionTree}, never disposes the live handle. */
	forkSessionAt(sessionId: string, entryId: string): Promise<{ sessionFile: string; cwd: string } | undefined> {
		const liveFile = this.active.get(sessionId)?.handle?.sessionFile;
		if (liveFile) return forkSessionFile(liveFile, entryId);
		return this.sessionlessBridge.forkSessionAt(sessionId, entryId);
	}

	trackSubscriberAdded(sessionId: string, connectionId: string): void {
		const record = this.active.get(sessionId);
		if (!record) return;
		const wasEmpty = record.subscribers.size === 0;
		record.subscribers.add(connectionId);
		record.lastActivityAt = Date.now();
		if (wasEmpty && record.subscribers.size > 0) {
			record.childSubscriberActive = true;
			this.sendWithoutWaiting(record, "bridge.trackSubscriberAdded", [CHILD_SUBSCRIBER_ID]);
		}
	}

	trackSubscriberRemoved(sessionId: string, connectionId: string): void {
		const record = this.active.get(sessionId);
		if (!record) return;
		record.subscribers.delete(connectionId);
		record.lastActivityAt = Date.now();
		if (record.subscribers.size === 0 && record.childSubscriberActive) {
			record.childSubscriberActive = false;
			this.sendWithoutWaiting(record, "bridge.trackSubscriberRemoved", [CHILD_SUBSCRIBER_ID]);
		}
	}

	bumpActivity(sessionId: string): void {
		const record = this.active.get(sessionId);
		if (!record) return;
		record.lastActivityAt = Date.now();
		this.sendWithoutWaiting(record, "bridge.bumpActivity", []);
	}

	applyEnvUpdate(update: RuntimeEnvUpdate): void {
		if (update.idleTimeoutMs !== undefined && update.idleTimeoutMs !== this.idleTimeoutMs) {
			this.idleTimeoutMs = update.idleTimeoutMs;
			if (this.reaperTimer) {
				clearInterval(this.reaperTimer);
				this.reaperTimer = undefined;
			}
			if (this.idleTimeoutMs > 0 && !this.disposed) this.startReaper();
		}
		for (const record of this.active.values()) {
			this.sendWithoutWaiting(record, "bridge.applyEnvUpdate", [update]);
		}
	}

	async listModels(opts: { sessionId?: string } = {}): Promise<ModelInfo[]> {
		if (opts.sessionId) {
			const record = this.active.get(opts.sessionId);
			if (record) return this.request(record, "bridge.listModels", [opts]);
		}
		return this.sessionlessBridge.listModels(opts);
	}

	generateTitle(opts: GenerateTitleOpts): Promise<string | null> {
		return this.sessionlessBridge.generateTitle(opts);
	}

	subscribeUiFrames(
		sessionId: string,
		listener: (frame: WorkerUiFrame) => void,
	): () => void {
		const record = this.active.get(sessionId);
		if (!record) return () => {};
		record.uiListeners.add(listener);
		for (const frame of record.pendingUiFrames.values()) invokeListener(listener, frame, "UI replay");
		if (!record.uiChannelSubscribed) {
			record.uiChannelSubscribed = true;
			this.sendWithoutWaiting(record, "channel.subscribeUi", []);
		}
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			record.uiListeners.delete(listener);
		};
	}

	respondToUiDialog(sessionId: string, dialogId: string, response: ExtUiDialogResponse): void {
		const record = this.active.get(sessionId);
		if (!record) return;
		record.lastActivityAt = Date.now();
		record.pendingUiFrames.delete(dialogId);
		this.sendWithoutWaiting(record, "bridge.respondToUiDialog", [dialogId, response]);
	}

	subscribePlanModeFrames(
		sessionId: string,
		listener: (frame: WorkerPlanFrame) => void,
	): () => void {
		const record = this.active.get(sessionId);
		if (!record) return () => {};
		record.planListeners.add(listener);
		if (record.currentPlanModeFrame) {
			invokeListener(listener, record.currentPlanModeFrame, "plan-mode replay");
		}
		if (record.pendingPlanFrame) {
			invokeListener(listener, record.pendingPlanFrame, "plan-mode replay");
		}
		if (record.pendingPlanExecutionFrame) {
			invokeListener(listener, record.pendingPlanExecutionFrame, "plan-mode replay");
		}
		if (!record.planChannelSubscribed) {
			record.planChannelSubscribed = true;
			this.sendWithoutWaiting(record, "channel.subscribePlan", []);
		}
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			record.planListeners.delete(listener);
		};
	}

	async respondToPlanApproval(
		sessionId: string,
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown"> {
		const record = this.active.get(sessionId);
		if (!record) return "unknown";
		record.lastActivityAt = Date.now();
		return this.request(record, "bridge.respondToPlanApproval", [proposalId, response]);
	}

	async actOnPendingPlanExecution(sessionId: string, proposalId: string): Promise<"settled" | "unknown"> {
		const record = this.active.get(sessionId);
		if (!record) return "unknown";
		record.lastActivityAt = Date.now();
		return this.request(record, "bridge.actOnPendingPlanExecution", [proposalId]);
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		if (this.reaperTimer) {
			clearInterval(this.reaperTimer);
			this.reaperTimer = undefined;
		}
		this.disposePromise = (async () => {
			const records = [...this.processes];
			await Promise.all(records.map((record) => this.disposeRecord(record)));
			this.processes.clear();
			this.active.clear();
			await this.sessionlessBridge.dispose();
		})();
		return this.disposePromise;
	}

	requestSession<M extends WorkerMethod>(
		sessionId: string,
		method: M,
		args: WorkerArgs<M>,
	): Promise<WorkerResult<M>> {
		const record = this.active.get(sessionId);
		if (!record) return Promise.reject(new Error(`session is not active: ${sessionId}`));
		record.lastActivityAt = Date.now();
		return this.request(record, method, args);
	}

	disposeSession(sessionId: string): Promise<void> {
		const record = this.active.get(sessionId);
		if (!record) return Promise.resolve();
		return this.disposeRecord(record);
	}

	private async spawnSession<M extends "bridge.createSession" | "bridge.resumeSession">(
		method: M,
		args: WorkerArgs<M>,
	): Promise<ProcessSessionHandle> {
		if (this.disposed) throw new Error("process agent bridge is disposed");
		let record: ActiveProcess;
		const child = this.spawnWorker((message) => {
			this.onWorkerMessage(record, message);
		});
		record = {
			process: child,
			pending: new Map(),
			handle: undefined,
			sessionId: undefined,
			closed: false,
			lastActivityAt: Date.now(),
			turnInFlight: false,
			subscribers: new Set(),
			childSubscriberActive: false,
			uiListeners: new Set(),
			uiChannelSubscribed: false,
			pendingUiFrames: new Map(),
			planListeners: new Set(),
			planChannelSubscribed: false,
			currentPlanModeFrame: undefined,
			pendingPlanFrame: undefined,
			pendingPlanExecutionFrame: undefined,
			disposal: undefined,
		};
		this.processes.add(record);
		void child.exited.then(
			(code) => this.onWorkerExit(record, `agent worker exited with code ${code}`),
			(error) => this.onWorkerExit(record, `agent worker exit failed: ${String(error)}`),
		);

		try {
			const metadata = await this.request(record, method, args);
			if (record.closed) throw new Error("agent worker exited during session initialization");
			const previous = this.active.get(metadata.sessionId);
			// T-32: an id collision where the existing record's worker has since
			// auto-handed-off onto a DIFFERENT file (its `active` map key stays
			// pinned to its pre-handoff id — same contract as the in-process
			// bridge, see in-process.ts's `attach()` doc comments) is a
			// legitimate, INDEPENDENT resume of that id's ORIGINAL file (e.g. the
			// handoff banner's "origin" link), not a duplicate. Disposing it here
			// would kill the user's still-live worker process. Give the new
			// record its own identity instead; a genuine duplicate (same file)
			// still supersedes exactly as before.
			const previousFile = previous?.handle?.sessionFile;
			const isDivergedHandoffOrigin =
				previous !== undefined &&
				previous.handle !== undefined &&
				previousFile !== undefined &&
				metadata.sessionFile !== undefined &&
				path.resolve(previousFile) !== path.resolve(metadata.sessionFile);
			const registrationId = isDivergedHandoffOrigin ? Bun.randomUUIDv7() : metadata.sessionId;
			const handle = new ProcessSessionHandle(this, { ...metadata, sessionId: registrationId });
			record.sessionId = registrationId;
			record.handle = handle;
			if (metadata.extensionErrors?.length) {
				try {
					recordExtensionLoadErrors(metadata.cwd, registrationId, metadata.extensionErrors);
				} catch (err) {
					log.warn(`failed to record extension load errors for session ${registrationId}`, err);
				}
			}
			if (previous && !isDivergedHandoffOrigin) {
				await this.disposeRecord(previous);
			}
			if (record.closed) throw new Error("agent worker exited while replacing the active session");
			if (this.disposed) throw new Error("process agent bridge was disposed during session initialization");
			this.active.set(registrationId, record);
			return handle;
		} catch (error) {
			this.terminateProcess(record);
			throw error;
		}
	}

	private request<M extends WorkerMethod>(
		record: ActiveProcess,
		method: M,
		args: WorkerArgs<M>,
	): Promise<WorkerResult<M>> {
		if (record.closed) return Promise.reject(new Error("agent worker is not running"));
		const id = crypto.randomUUID();
		return new Promise<WorkerResult<M>>((resolve, reject) => {
			record.pending.set(id, {
				resolve: (value) => resolve(value as WorkerResult<M>),
				reject,
			});
			try {
				record.process.send({ type: "request", id, method, args } as WorkerRequestFrame);
			} catch (error) {
				record.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private sendWithoutWaiting<M extends WorkerMethod>(
		record: ActiveProcess,
		method: M,
		args: WorkerArgs<M>,
	): void {
		void this.request(record, method, args).catch((error) => {
			if (!record.closed) log.warn(`agent worker request ${method} failed`, error);
		});
	}

	private onWorkerMessage(record: ActiveProcess, message: unknown): void {
		if (!message || typeof message !== "object") return;
		const frame = message as WorkerOutboundFrame;
		if (frame.type === "response") {
			const pending = record.pending.get(frame.id);
			if (!pending) return;
			record.pending.delete(frame.id);
			if (frame.ok) pending.resolve(frame.result);
			else pending.reject(deserializeError(frame.error));
			return;
		}
		if (frame.type !== "event") return;
		record.lastActivityAt = Date.now();
		if (frame.channel === "session") {
			const eventType = (frame.event as { type?: string }).type;
			if (eventType === "turn_start") record.turnInFlight = true;
			else if (eventType === "turn_end" || eventType === "agent_end") record.turnInFlight = false;
			// T-32: an auto-handoff swaps the worker's live session onto a new
			// file+id in place (id/`active` map key deliberately stay pinned —
			// same contract as the in-process bridge, see in-process.ts docs).
			// Sync the tracked file BEFORE emitting so `resumeSession`'s
			// live-file guard (above) can find this handle by its CURRENT file
			// and any listener reacting to the event sees the fresh value.
			if (eventType === "session_handoff") {
				const newSessionFile = readStringField(frame.event, "newSessionFile");
				if (newSessionFile) record.handle?.setSessionFile(newSessionFile);
			}
			record.handle?.emit(frame.event);
			return;
		}
		if (frame.channel === "broadcast") {
			broadcastBus.broadcast(frame.frame);
			return;
		}
		if (frame.channel === "ui") {
			// T-32: the child worker's own uiBridge always tags frames with its
			// NATURAL id — it has no visibility into this parent's disambiguated
			// `registrationId` for a diverged-handoff-origin collision (see
			// spawnSession). Rewrite so a client subscribed under the registered
			// id (the only id it was ever given) actually receives it.
			const uiFrame = rewriteFrameSessionId(frame.frame, record.sessionId);
			if (uiFrame.type === "ext_ui_dialog_open") {
				record.pendingUiFrames.set(uiFrame.dialogId, uiFrame);
			} else {
				record.pendingUiFrames.delete(uiFrame.dialogId);
			}
			for (const listener of record.uiListeners) invokeListener(listener, uiFrame, "UI");
			return;
		}
		const planFrame = rewriteFrameSessionId(frame.frame, record.sessionId);
		if (planFrame.type === "plan_mode_changed") {
			record.currentPlanModeFrame = planFrame;
			if (!planFrame.enabled) record.pendingPlanFrame = undefined;
		} else if (planFrame.type === "plan_proposed") {
			record.pendingPlanFrame = planFrame;
		} else if (planFrame.type === "plan_execution_changed") {
			if (planFrame.status === "dispatched") {
				if (record.pendingPlanExecutionFrame?.proposalId === planFrame.proposalId) {
					record.pendingPlanExecutionFrame = undefined;
				}
			} else {
				record.pendingPlanExecutionFrame = planFrame;
			}
		} else if (record.pendingPlanFrame?.proposalId === planFrame.proposalId) {
			record.pendingPlanFrame = undefined;
		}
		for (const listener of record.planListeners) invokeListener(listener, planFrame, "plan-mode");
	}

	private onWorkerExit(record: ActiveProcess, reason: string): void {
		if (record.closed) return;
		record.closed = true;
		const error = new Error(reason);
		for (const pending of record.pending.values()) pending.reject(error);
		record.pending.clear();
		if (record.sessionId && this.active.get(record.sessionId) === record) {
			this.active.delete(record.sessionId);
		}
		record.handle?.markClosed();
		record.uiListeners.clear();
		this.processes.delete(record);
		record.planListeners.clear();
		record.pendingUiFrames.clear();
		record.currentPlanModeFrame = undefined;
		record.pendingPlanFrame = undefined;
		record.pendingPlanExecutionFrame = undefined;
	}

	private disposeRecord(record: ActiveProcess): Promise<void> {
		if (record.disposal) return record.disposal;
		record.disposal = (async () => {
			if (!record.closed) {
				try {
					await this.request(record, "bridge.dispose", []);
				} catch (error) {
					if (!record.closed) log.warn("agent worker bridge.dispose failed", error);
				}
			}
			this.terminateProcess(record);
			try {
				await record.process.exited;
			} catch {
				// onWorkerExit handles rejection and pending request cleanup.
			}
			this.onWorkerExit(record, "agent worker disposed");
		})();
		return record.disposal;
	}

	private terminateProcess(record: ActiveProcess): void {
		if (record.closed) return;
		try {
			record.process.kill();
		} catch (error) {
			log.warn("failed to terminate agent worker", error);
		}
	}

	private startReaper(): void {
		this.reaperTimer = setInterval(() => {
			void this.reapIdle().catch((error) => log.warn("process bridge reaper failed", error));
		}, this.reapIntervalMs);
		(this.reaperTimer as unknown as { unref?: () => void }).unref?.();
	}

	private async reapIdle(): Promise<void> {
		if (this.disposed || this.idleTimeoutMs <= 0) return;
		const cutoff = Date.now() - this.idleTimeoutMs;
		const candidates = [...this.active.values()].filter(
			(record) =>
				!record.closed &&
				!record.turnInFlight &&
				record.subscribers.size === 0 &&
				record.lastActivityAt <= cutoff,
		);
		await Promise.all(candidates.map((record) => this.disposeRecord(record)));
	}
}

export class ProcessSessionHandle implements SessionHandle {
	readonly sessionId: string;
	readonly cwd: string;
	private currentSessionFile: string | undefined;
	private readonly listeners = new Set<EventListener>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(
		private readonly bridge: ProcessAgentBridge,
		metadata: WorkerSessionMetadata,
	) {
		this.sessionId = metadata.sessionId;
		this.currentSessionFile = metadata.sessionFile;
		this.cwd = metadata.cwd;
	}

	get sessionFile(): string | undefined {
		return this.currentSessionFile;
	}

	/** T-32: called by the bridge when a `session_handoff` event reports this
	 *  session's live file changed underneath it (see `onWorkerMessage`). */
	setSessionFile(sessionFile: string): void {
		this.currentSessionFile = sessionFile;
	}

	subscribe(listener: EventListener): () => void {
		if (this.disposed) return () => {};
		this.listeners.add(listener);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			this.listeners.delete(listener);
		};
	}

	emit(event: AgentSessionEventJson): void {
		for (const listener of this.listeners) invokeListener(listener, event, "session");
	}

	markClosed(): void {
		this.disposed = true;
		this.listeners.clear();
	}

	snapshot(): Promise<SessionSnapshot> {
		return this.call("session.snapshot", []);
	}

	getHistory(before: number, limit: number): Promise<SessionHistoryResponse> {
		return this.call("session.getHistory", [before, limit]);
	}

	prompt(
		text: string,
		opts?: { streamingBehavior?: "steer" | "followUp"; images?: ImageAttachment[] },
	): Promise<void> {
		return this.call("session.prompt", [text, opts]);
	}

	isStreamingNow(): Promise<boolean> {
		return this.call("session.isStreamingNow", []);
	}

	queuedMessageCount(): Promise<number> {
		return this.call("session.queuedMessageCount", []);
	}

	clearQueue(): Promise<{ steering: number; followUp: number }> {
		return this.call("session.clearQueue", []);
	}

	getQueueSnapshot(): Promise<QueuedPromptWire[]> {
		return this.call("session.getQueueSnapshot", []);
	}

	cancelQueuedById(id: string): Promise<boolean> {
		return this.call("session.cancelQueuedById", [id]);
	}

	editQueuedById(id: string, text: string, images?: ImageAttachment[]): Promise<boolean> {
		return this.call("session.editQueuedById", [id, text, images]);
	}

	abort(): Promise<void> {
		return this.call("session.abort", []);
	}

	setName(name: string): Promise<void> {
		return this.call("session.setName", [name]);
	}

	compact(focus?: string): Promise<void> {
		return this.call("session.compact", [focus]);
	}

	setModel(ref: ModelRef): Promise<void> {
		return this.call("session.setModel", [ref]);
	}

	setThinkingLevel(level: string): Promise<void> {
		return this.call("session.setThinkingLevel", [level]);
	}

	dispatchSlashCommand(text: string): Promise<SlashDispatchResult> {
		return this.call("session.dispatchSlashCommand", [text]);
	}

	dispatchDeckSlashCommand(text: string): Promise<SlashDispatchResult> {
		return this.call("session.dispatchDeckSlashCommand", [text]);
	}

	getContextUsage(): Promise<ContextUsage | undefined> {
		return this.call("session.getContextUsage", []);
	}

	setPlanMode(enabled: boolean): Promise<void> {
		return this.call("session.setPlanMode", [enabled]);
	}

	getPlanModeContext(): Promise<PlanModeContextWire | undefined> {
		return this.call("session.getPlanModeContext", []);
	}

	getPendingPlanApproval(): Promise<PendingPlanApprovalWire | undefined> {
		return this.call("session.getPendingPlanApproval", []);
	}

	getPendingPlanExecution(): Promise<PendingPlanExecutionWire | undefined> {
		return this.call("session.getPendingPlanExecution", []);
	}

	respondToPlanApproval(
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown"> {
		return this.call("session.respondToPlanApproval", [proposalId, response]);
	}

	actOnPendingPlanExecution(proposalId: string): Promise<"settled" | "unknown"> {
		return this.call("session.actOnPendingPlanExecution", [proposalId]);
	}

	actOnGoal(action: GoalAction): Promise<void> {
		return this.call("session.actOnGoal", [action]);
	}

	getGoalModeContext(): Promise<GoalModeContextWire | undefined> {
		return this.call("session.getGoalModeContext", []);
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		this.listeners.clear();
		this.disposePromise = this.bridge.disposeSession(this.sessionId);
		return this.disposePromise;
	}

	private call<M extends WorkerMethod>(method: M, args: WorkerArgs<M>): Promise<WorkerResult<M>> {
		if (this.disposed) return Promise.reject(new Error(`session is disposed: ${this.sessionId}`));
		return this.bridge.requestSession(this.sessionId, method, args);
	}
}

/** T-32: rewrites a `{ sessionId }`-carrying frame to the given id, only
 *  allocating a new object when the id actually differs — see
 *  `onWorkerMessage`'s ui/plan-frame doc comment for why this is needed. */
function rewriteFrameSessionId<T extends { sessionId: string }>(frame: T, sessionId: string | undefined): T {
	if (!sessionId || frame.sessionId === sessionId) return frame;
	return { ...frame, sessionId };
}

function readStringField(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (!(key in value)) return undefined;
	const v = (value as Record<string, unknown>)[key];
	return typeof v === "string" ? v : undefined;
}

function invokeListener<T>(listener: (value: T) => void, value: T, channel: string): void {
	try {
		listener(value);
	} catch (error) {
		log.warn(`${channel} listener failed`, error);
	}
}

function spawnAgentWorker(
	workerEntryPath: string,
	onMessage: (message: unknown) => void,
): AgentWorkerProcess {
	return Bun.spawn({
		cmd: [resolveBunExecutable(), workerEntryPath, "--agent-worker"],
		cwd: process.cwd(),
		env: snapshotProcessEnv(),
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		serialization: "advanced",
		ipc: onMessage,
	}) as unknown as AgentWorkerProcess;
}

function snapshotProcessEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

function deserializeError(serialized: SerializedWorkerError): Error {
	const error = new Error(serialized.message);
	error.name = serialized.name;
	if (serialized.stack) error.stack = serialized.stack;
	if (serialized.code !== undefined) {
		(error as Error & { code?: string | number }).code = serialized.code;
	}
	return error;
}
