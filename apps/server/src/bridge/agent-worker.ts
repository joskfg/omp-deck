import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";

import { broadcastBus } from "../broadcast-bus.ts";
import { closeDb, openDb } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { KbProtocolHandler } from "../kb-protocol.ts";
import { logger } from "../log.ts";
import { BrowserNotificationChannel, notificationService } from "../notifications/index.ts";
import { InProcessAgentBridge } from "./in-process.ts";
import { isWorkerRequestFrame } from "./worker-protocol.ts";
import type {
	SerializedWorkerError,
	WorkerOutboundFrame,
	WorkerRequestFrame,
	WorkerSessionMetadata,
} from "./worker-protocol.ts";
import type { SessionHandle } from "./types.ts";

const log = logger("bridge:agent-worker");

interface ProcessIpcChannel {
	readonly connected?: boolean;
	send(message: WorkerOutboundFrame): void;
}

export async function runAgentWorker(): Promise<void> {
	const ipc = process as unknown as ProcessIpcChannel;
	if (typeof ipc.send !== "function") {
		throw new Error("agent worker requires a Bun IPC channel");
	}

	let bridge: InProcessAgentBridge | undefined;
	let handle: SessionHandle | undefined;
	let unsubscribeEvents: (() => void) | undefined;
	let unsubscribeUi: (() => void) | undefined;
	let unsubscribePlan: (() => void) | undefined;
	let unsubscribeBroadcast: (() => void) | undefined;
	let runtimePrepared = false;

	const send = (frame: WorkerOutboundFrame): void => {
		if (ipc.connected === false) return;
		ipc.send(frame);
	};

	const requireBridge = (): InProcessAgentBridge => {
		if (!bridge) throw new Error("agent worker has not initialized a bridge");
		return bridge;
	};

	const requireHandle = (): SessionHandle => {
		if (!handle) throw new Error("agent worker has not initialized a session");
		return handle;
	};

	const prepareRuntime = async (): Promise<void> => {
		if (runtimePrepared) return;
		runtimePrepared = true;
		const config = loadConfig();
		openDb({ path: config.dbPath });
		notificationService.register(new BrowserNotificationChannel());
		unsubscribeBroadcast = broadcastBus.subscribe((frame) => {
			send({ type: "event", channel: "broadcast", frame });
		});
		InternalUrlRouter.instance().register(new KbProtocolHandler());
		try {
			const darkTheme = await getThemeByName("dark");
			if (darkTheme) setThemeInstance(darkTheme);
		} catch (error) {
			log.warn("SDK theme initialization failed in agent worker", error);
		}
	};

	const initialize = async (
		startSession: (workerBridge: InProcessAgentBridge) => Promise<SessionHandle>,
	): Promise<WorkerSessionMetadata> => {
		if (bridge || handle) throw new Error("agent worker supports exactly one root session");
		await prepareRuntime();
		bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		handle = await startSession(bridge);
		unsubscribeEvents = handle.subscribe((event) => {
			send({ type: "event", channel: "session", event });
		});
		const extensionErrors = bridge.takeExtensionLoadErrors(handle.sessionId);
		return {
			sessionId: handle.sessionId,
			sessionFile: handle.sessionFile,
			cwd: handle.cwd,
			...(extensionErrors.length > 0 ? { extensionErrors } : {}),
		};
	};

	const dispatch = async (frame: WorkerRequestFrame): Promise<unknown> => {
		switch (frame.method) {
			case "bridge.createSession": {
				const [opts] = frame.args;
				return initialize((workerBridge) => workerBridge.createSession(opts));
			}
			case "bridge.resumeSession": {
				const [opts] = frame.args;
				return initialize((workerBridge) => workerBridge.resumeSession(opts));
			}
			case "bridge.listModels":
				return requireBridge().listModels(frame.args[0]);
			case "bridge.trackSubscriberAdded":
				requireBridge().trackSubscriberAdded(requireHandle().sessionId, frame.args[0]);
				return undefined;
			case "bridge.trackSubscriberRemoved":
				requireBridge().trackSubscriberRemoved(requireHandle().sessionId, frame.args[0]);
				return undefined;
			case "bridge.bumpActivity":
				requireBridge().bumpActivity(requireHandle().sessionId);
				return undefined;
			case "bridge.applyEnvUpdate":
				requireBridge().applyEnvUpdate(frame.args[0]);
				return undefined;
			case "bridge.respondToUiDialog":
				requireBridge().respondToUiDialog(requireHandle().sessionId, frame.args[0], frame.args[1]);
				return undefined;
			case "bridge.respondToPlanApproval":
				return requireBridge().respondToPlanApproval(
					requireHandle().sessionId,
					frame.args[0],
					frame.args[1],
				);
			case "bridge.actOnPendingPlanExecution":
				return requireBridge().actOnPendingPlanExecution(requireHandle().sessionId, frame.args[0]);
			case "bridge.dispose":
				unsubscribeEvents?.();
				unsubscribeEvents = undefined;
				unsubscribeUi?.();
				unsubscribeUi = undefined;
				unsubscribePlan?.();
				unsubscribePlan = undefined;
				unsubscribeBroadcast?.();
				unsubscribeBroadcast = undefined;
				await requireBridge().dispose();
				closeDb();
				return undefined;

			case "channel.subscribeEvents":
				if (!unsubscribeEvents) {
					unsubscribeEvents = requireHandle().subscribe((event) => {
						send({ type: "event", channel: "session", event });
					});
				}
				return undefined;
			case "channel.unsubscribeEvents":
				unsubscribeEvents?.();
				unsubscribeEvents = undefined;
				return undefined;
			case "channel.subscribeUi":
				if (!unsubscribeUi) {
					unsubscribeUi = requireBridge().subscribeUiFrames(requireHandle().sessionId, (uiFrame) => {
						send({ type: "event", channel: "ui", frame: uiFrame });
					});
				}
				return undefined;
			case "channel.unsubscribeUi":
				unsubscribeUi?.();
				unsubscribeUi = undefined;
				return undefined;
			case "channel.subscribePlan":
				if (!unsubscribePlan) {
					unsubscribePlan = requireBridge().subscribePlanModeFrames(
						requireHandle().sessionId,
						(planFrame) => {
							send({ type: "event", channel: "plan", frame: planFrame });
						},
					);
				}
				return undefined;
			case "channel.unsubscribePlan":
				unsubscribePlan?.();
				unsubscribePlan = undefined;
				return undefined;

			case "session.snapshot":
				return requireHandle().snapshot();
			case "session.getHistory":
				return requireHandle().getHistory(frame.args[0], frame.args[1]);
			case "session.prompt":
				return requireHandle().prompt(frame.args[0], frame.args[1]);
			case "session.isStreamingNow":
				return requireHandle().isStreamingNow();
			case "session.queuedMessageCount":
				return requireHandle().queuedMessageCount();
			case "session.clearQueue":
				return requireHandle().clearQueue();
			case "session.getQueueSnapshot":
				return requireHandle().getQueueSnapshot();
			case "session.cancelQueuedById":
				return requireHandle().cancelQueuedById(frame.args[0]);
			case "session.editQueuedById":
				return requireHandle().editQueuedById(frame.args[0], frame.args[1], frame.args[2]);
			case "session.abort":
				return requireHandle().abort();
			case "session.setName":
				return requireHandle().setName(frame.args[0]);
			case "session.compact":
				return requireHandle().compact(frame.args[0]);
			case "session.setModel":
				return requireHandle().setModel(frame.args[0]);
			case "session.setThinkingLevel":
				return requireHandle().setThinkingLevel(frame.args[0]);
			case "session.dispatchSlashCommand":
				return requireHandle().dispatchSlashCommand(frame.args[0]);
			case "session.dispatchDeckSlashCommand":
				return requireHandle().dispatchDeckSlashCommand(frame.args[0]);
			case "session.getContextUsage":
				return requireHandle().getContextUsage();
			case "session.setPlanMode":
				return requireHandle().setPlanMode(frame.args[0]);
			case "session.getPlanModeContext":
				return requireHandle().getPlanModeContext();
			case "session.getPendingPlanApproval":
				return requireHandle().getPendingPlanApproval();
			case "session.getPendingPlanExecution":
				return requireHandle().getPendingPlanExecution();
			case "session.respondToPlanApproval":
				return requireHandle().respondToPlanApproval(frame.args[0], frame.args[1]);
			case "session.actOnPendingPlanExecution":
				return requireHandle().actOnPendingPlanExecution(frame.args[0]);
			case "session.actOnGoal":
				return requireHandle().actOnGoal(frame.args[0]);
			case "session.getGoalModeContext":
				return requireHandle().getGoalModeContext();
			case "session.dispose":
				return requireHandle().dispose();
		}
	};


	process.on(
		"message",
		createWorkerRequestHandler(dispatch, send, (error) => {
			log.warn("agent worker request handler failed", error);
		}),
	);

	process.once("disconnect", () => {
		void (async () => {
			try {
				await bridge?.dispose();
			} catch (error) {
				log.warn("worker bridge disposal after IPC disconnect failed", error);
			}
			unsubscribeBroadcast?.();
			unsubscribeBroadcast = undefined;
			closeDb();
			process.exit(0);
		})();
	});
}

export function createWorkerRequestHandler(
	dispatch: (frame: WorkerRequestFrame) => Promise<unknown>,
	send: (frame: WorkerOutboundFrame) => void,
	onError: (error: unknown) => void,
): (message: unknown) => void {
	return (message: unknown): void => {
		if (!isWorkerRequestFrame(message)) return;
		void respondToWorkerRequest(message, dispatch, send).catch(onError);
	};
}

async function respondToWorkerRequest(
	frame: WorkerRequestFrame,
	dispatch: (frame: WorkerRequestFrame) => Promise<unknown>,
	send: (frame: WorkerOutboundFrame) => void,
): Promise<void> {
	try {
		const result = await dispatch(frame);
		send({ type: "response", id: frame.id, ok: true, result });
	} catch (error) {
		send({ type: "response", id: frame.id, ok: false, error: serializeError(error) });
	}
}

function serializeError(error: unknown): SerializedWorkerError {
	if (error instanceof Error) {
		const code = (error as Error & { code?: string | number }).code;
		return {
			name: error.name,
			message: error.message,
			...(error.stack ? { stack: error.stack } : {}),
			...(code !== undefined ? { code } : {}),
		};
	}
	return { name: "Error", message: String(error) };
}
