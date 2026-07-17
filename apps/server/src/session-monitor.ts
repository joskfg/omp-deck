import type { SessionSummary } from "@omp-deck/protocol";
import type { AgentBridge } from "./bridge/types.ts";
import { logger } from "./log.ts";

const log = logger("session-monitor");
const RECENT_RECORD_LIMIT = 40;
const RECENT_MESSAGE_LIMIT = 8;

export type SessionMonitorStatus = "active" | "error" | "completed";

export interface SessionMonitorMessage {
	role: "user" | "assistant" | "notice" | "tool";
	text: string;
	isError?: boolean;
}

export interface SessionMonitorEntry extends SessionSummary {
	status: SessionMonitorStatus;
	error?: string;
	recentMessages: SessionMonitorMessage[];
	/** Tool-call blocks in persisted assistant messages, over the whole transcript. */
	toolCallCount: number;
}

interface TranscriptRecord {
	type?: string;
	level?: string;
	message?: unknown;
	data?: unknown;
	stopReason?: string;
	isError?: boolean;
}

/**
 * Builds the monitoring projection without resuming persisted sessions. The
 * transcript tail is intentionally bounded, so opening the monitor cannot load
 * a whole long-running conversation into memory.
 */
export async function listSessionMonitor(bridge: AgentBridge, cwd?: string): Promise<SessionMonitorEntry[]> {
	const sessions = await bridge.listSessions(cwd ? { cwd } : {});
	return Promise.all(sessions.map((session) => monitorSession(bridge, session)));
}

async function monitorSession(bridge: AgentBridge, session: SessionSummary): Promise<SessionMonitorEntry> {
	// The SDK's list projection derives `messageCount` from only the first
	// 4 KB of the transcript, so it undercounts anything non-trivial (T-88).
	// Scan the full file once for exact message + tool-call totals; the same
	// pass yields the bounded record tail the persisted branch renders from.
	const scan = await scanTranscript(session.path);
	const counts = scan.ok
		? { messageCount: scan.messageCount, toolCallCount: scan.toolCallCount }
		: { messageCount: session.messageCount, toolCallCount: 0 };

	const live = bridge.getSession(session.id);
	if (live) {
		const snapshot = await live.snapshot();
		const recentMessages = messagesFromUnknown(snapshot.messages).slice(-RECENT_MESSAGE_LIMIT);
		return {
			...session,
			...counts,
			status: snapshot.isStreaming ? "active" : "completed",
			recentMessages,
		};
	}

	const recentMessages = scan.tail.flatMap(messageFromRecord).slice(-RECENT_MESSAGE_LIMIT);
	const error = findTerminalError(scan.tail);
	return {
		...session,
		...counts,
		status: error ? "error" : "completed",
		...(error ? { error } : {}),
		recentMessages,
	};
}

interface TranscriptScan {
	/** False when the transcript file could not be read at all. */
	ok: boolean;
	/** Last `RECENT_RECORD_LIMIT` parseable records, in transcript order. */
	tail: TranscriptRecord[];
	/** Persisted user + assistant messages across the WHOLE transcript. */
	messageCount: number;
	/** Tool-call blocks inside persisted assistant messages across the WHOLE transcript. */
	toolCallCount: number;
}

/** Single pass over the whole transcript: exact counters + bounded tail. */
async function scanTranscript(filePath: string): Promise<TranscriptScan> {
	let lines: string[];
	try {
		lines = (await Bun.file(filePath).text()).split("\n").filter(Boolean);
	} catch (error) {
		log.warn(`could not read transcript ${filePath}`, error);
		return { ok: false, tail: [], messageCount: 0, toolCallCount: 0 };
	}
	let messageCount = 0;
	let toolCallCount = 0;
	const tail: TranscriptRecord[] = [];
	for (const line of lines) {
		let record: TranscriptRecord;
		try {
			record = JSON.parse(line) as TranscriptRecord;
		} catch {
			continue;
		}
		if (record.type === "message") {
			const message = asRecord(record.message);
			if (message?.role === "user") messageCount++;
			if (message?.role === "assistant") {
				messageCount++;
				toolCallCount += countToolCallBlocks(message.content);
			}
		}
		tail.push(record);
		if (tail.length > RECENT_RECORD_LIMIT) tail.shift();
	}
	return { ok: true, tail, messageCount, toolCallCount };
}

function countToolCallBlocks(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let count = 0;
	for (const part of content) {
		if (asRecord(part)?.type === "toolCall") count++;
	}
	return count;
}

function findTerminalError(records: TranscriptRecord[]): string | undefined {
	for (const record of [...records].reverse()) {
		// A later successful terminal event proves preceding notice/tool errors
		// were handled by the agent. In particular, TTSR intentionally aborts
		// and retries a stream after injecting its matched rules.
		if (
			(record.type === "agent_end" || record.type === "turn_end") &&
			(record.stopReason === "end_turn" || record.stopReason === "stop")
		) {
			return undefined;
		}
		if (record.type === "agent_end" && record.stopReason === "error") return "Agent turn ended with an error.";
		if (record.type === "notice" && record.level === "error") return textFromUnknown(record.message ?? record.data) || "Session reported an error.";
		if (record.isError) return textFromUnknown(record.message ?? record.data) || "A recent session step failed.";
		const message = asRecord(record.message);
		if (message?.role === "toolResult" && message.isError === true) return textFromUnknown(message.content) || "A recent tool step failed.";
		if (message?.role === "assistant" && message.stopReason === "error") return textFromUnknown(message.errorMessage) || "Assistant response ended with an error.";
	}
	return undefined;
}

function messageFromRecord(record: TranscriptRecord): SessionMonitorMessage[] {
	if (record.type !== "message") return [];
	return messagesFromUnknown([record.message]);
}

function messagesFromUnknown(messages: unknown): SessionMonitorMessage[] {
	if (!Array.isArray(messages)) return [];
	return messages.flatMap((message) => {
		const value = asRecord(message);
		if (!value || typeof value.role !== "string") return [];
		const text = textFromUnknown(value.content);
		if (!text) return [];
		switch (value.role) {
			case "user":
				return [{ role: "user", text }];
			case "assistant":
				return [{ role: "assistant", text, ...(value.stopReason === "error" ? { isError: true } : {}) }];
			case "notice":
				return [{ role: "notice", text, ...(value.level === "error" ? { isError: true } : {}) }];
			case "toolResult":
				return [{ role: "tool", text, ...(value.isError === true ? { isError: true } : {}) }];
			default:
				return [];
		}
	});
}

function textFromUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map((part) => {
			const item = asRecord(part);
			return item && typeof item.text === "string" ? item.text : "";
		})
		.join("");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
