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
	ServerFrame,
	SessionHistoryResponse,
	SessionSnapshot,
} from "@omp-deck/protocol";
import type { BroadcastFrame } from "../broadcast-bus.ts";

import type { GoalAction } from "./goal-mode-bridge.ts";
import type {
	CreateSessionOpts,
	PlanApprovalResponse,
	ResumeSessionOpts,
	RuntimeEnvUpdate,
	SlashDispatchResult,
} from "./types.ts";

export interface WorkerSessionMetadata {
	sessionId: string;
	sessionFile: string | undefined;
	cwd: string;
	/** Extension load failures from this session's `createAgentSession` call
	 *  (T-35), for the parent process to persist to the governance audit
	 *  trail. Empty/absent when every discovered extension loaded cleanly. */
	extensionErrors?: Array<{ path: string; error: string }>;
}


interface WorkerRequestSpec<Args extends unknown[], Result> {
	args: Args;
	result: Result;
}

export interface WorkerMethodMap {
	"bridge.createSession": WorkerRequestSpec<[opts: CreateSessionOpts], WorkerSessionMetadata>;
	"bridge.resumeSession": WorkerRequestSpec<[opts: ResumeSessionOpts], WorkerSessionMetadata>;
	"bridge.listModels": WorkerRequestSpec<[opts?: { sessionId?: string }], ModelInfo[]>;
	"bridge.trackSubscriberAdded": WorkerRequestSpec<[connectionId: string], void>;
	"bridge.trackSubscriberRemoved": WorkerRequestSpec<[connectionId: string], void>;
	"bridge.bumpActivity": WorkerRequestSpec<[], void>;
	"bridge.applyEnvUpdate": WorkerRequestSpec<[update: RuntimeEnvUpdate], void>;
	"bridge.respondToUiDialog": WorkerRequestSpec<
		[dialogId: string, response: ExtUiDialogResponse],
		void
	>;
	"bridge.respondToPlanApproval": WorkerRequestSpec<
		[proposalId: string, response: PlanApprovalResponse],
		"settled" | "unknown"
	>;
	"bridge.actOnPendingPlanExecution": WorkerRequestSpec<[proposalId: string], "settled" | "unknown">;
	"bridge.dispose": WorkerRequestSpec<[], void>;

	"channel.subscribeEvents": WorkerRequestSpec<[], void>;
	"channel.unsubscribeEvents": WorkerRequestSpec<[], void>;
	"channel.subscribeUi": WorkerRequestSpec<[], void>;
	"channel.unsubscribeUi": WorkerRequestSpec<[], void>;
	"channel.subscribePlan": WorkerRequestSpec<[], void>;
	"channel.unsubscribePlan": WorkerRequestSpec<[], void>;

	"session.snapshot": WorkerRequestSpec<[], SessionSnapshot>;
	"session.getHistory": WorkerRequestSpec<[before: number, limit: number], SessionHistoryResponse>;
	"session.prompt": WorkerRequestSpec<
		[
			text: string,
			opts?: { streamingBehavior?: "steer" | "followUp"; images?: ImageAttachment[] },
		],
		void
	>;
	"session.isStreamingNow": WorkerRequestSpec<[], boolean>;
	"session.queuedMessageCount": WorkerRequestSpec<[], number>;
	"session.clearQueue": WorkerRequestSpec<[], { steering: number; followUp: number }>;
	"session.getQueueSnapshot": WorkerRequestSpec<[], QueuedPromptWire[]>;
	"session.cancelQueuedById": WorkerRequestSpec<[id: string], boolean>;
	"session.editQueuedById": WorkerRequestSpec<
		[id: string, text: string, images?: ImageAttachment[]],
		boolean
	>;
	"session.abort": WorkerRequestSpec<[], void>;
	"session.setName": WorkerRequestSpec<[name: string], void>;
	"session.compact": WorkerRequestSpec<[focus?: string], void>;
	"session.setModel": WorkerRequestSpec<[ref: ModelRef], void>;
	"session.setThinkingLevel": WorkerRequestSpec<[level: string], void>;
	"session.dispatchSlashCommand": WorkerRequestSpec<[text: string], SlashDispatchResult>;
	"session.dispatchDeckSlashCommand": WorkerRequestSpec<[text: string], SlashDispatchResult>;
	"session.getContextUsage": WorkerRequestSpec<[], ContextUsage | undefined>;
	"session.setPlanMode": WorkerRequestSpec<[enabled: boolean], void>;
	"session.getPlanModeContext": WorkerRequestSpec<[], PlanModeContextWire | undefined>;
	"session.getPendingPlanApproval": WorkerRequestSpec<[], PendingPlanApprovalWire | undefined>;
	"session.getPendingPlanExecution": WorkerRequestSpec<[], PendingPlanExecutionWire | undefined>;
	"session.respondToPlanApproval": WorkerRequestSpec<
		[proposalId: string, response: PlanApprovalResponse],
		"settled" | "unknown"
	>;
	"session.actOnPendingPlanExecution": WorkerRequestSpec<[proposalId: string], "settled" | "unknown">;
	"session.actOnGoal": WorkerRequestSpec<[action: GoalAction], void>;
	"session.getGoalModeContext": WorkerRequestSpec<[], GoalModeContextWire | undefined>;
	"session.dispose": WorkerRequestSpec<[], void>;
}

export type WorkerMethod = keyof WorkerMethodMap;
export type WorkerArgs<M extends WorkerMethod> = WorkerMethodMap[M]["args"];
export type WorkerResult<M extends WorkerMethod> = WorkerMethodMap[M]["result"];

export type WorkerRequestFrame = {
	[M in WorkerMethod]: {
		type: "request";
		id: string;
		method: M;
		args: WorkerArgs<M>;
	};
}[WorkerMethod];

export interface SerializedWorkerError {
	name: string;
	message: string;
	stack?: string;
	code?: string | number;
}

export type WorkerResponseFrame =
	| { type: "response"; id: string; ok: true; result: unknown }
	| { type: "response"; id: string; ok: false; error: SerializedWorkerError };

export type WorkerUiFrame = Extract<
	ServerFrame,
	{ type: "ext_ui_dialog_open" | "ext_ui_dialog_cancel" }
>;

export type WorkerPlanFrame = Extract<
	ServerFrame,
	{ type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" | "plan_execution_changed" }
>;

export type WorkerEventFrame =
	| { type: "event"; channel: "session"; event: AgentSessionEventJson }
	| { type: "event"; channel: "ui"; frame: WorkerUiFrame }
	| { type: "event"; channel: "plan"; frame: WorkerPlanFrame }
	| { type: "event"; channel: "broadcast"; frame: BroadcastFrame };

export type WorkerOutboundFrame = WorkerResponseFrame | WorkerEventFrame;

export function isWorkerRequestFrame(value: unknown): value is WorkerRequestFrame {
	if (!value || typeof value !== "object") return false;
	const frame = value as Record<string, unknown>;
	return (
		frame.type === "request" &&
		typeof frame.id === "string" &&
		typeof frame.method === "string" &&
		Array.isArray(frame.args)
	);
}
