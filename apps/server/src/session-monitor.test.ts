import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { SessionSnapshot, SessionSummary } from "@omp-deck/protocol"

import type { AgentBridge, SessionHandle } from "./bridge/types.ts"
import { listSessionMonitor } from "./session-monitor.ts"

let tempDir: string

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-session-monitor-"))
})

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true })
})

function session(id: string, transcriptPath: string, cwd: string): SessionSummary {
	return {
		id,
		path: transcriptPath,
		cwd,
		createdAt: "2026-07-10T10:00:00.000Z",
		updatedAt: "2026-07-10T10:05:00.000Z",
		messageCount: 3,
	}
}

function writeTranscript(name: string, records: unknown[]): string {
	const transcriptPath = path.join(tempDir, name)
	fs.writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8")
	return transcriptPath
}

function liveHandle(snapshot: SessionSnapshot): SessionHandle {
	return {
		sessionId: snapshot.sessionId,
		sessionFile: snapshot.sessionFile,
		cwd: snapshot.cwd,
		snapshot: async () => snapshot,
	} as SessionHandle
}

/** Minimal deterministic bridge surface exercised by `listSessionMonitor`. */
class SessionMonitorBridge {
	readonly listCalls: Array<{ cwd?: string }> = []
	private readonly liveSessions: Map<string, SessionHandle>

	constructor(
		private readonly sessions: SessionSummary[],
		liveSessions: Iterable<readonly [string, SessionHandle]> = [],
	) {
		this.liveSessions = new Map(liveSessions)
	}

	async listSessions(opts: { cwd?: string }): Promise<SessionSummary[]> {
		this.listCalls.push(opts)
		return opts.cwd ? this.sessions.filter((candidate) => candidate.cwd === opts.cwd) : this.sessions
	}

	getSession(sessionId: string): SessionHandle | undefined {
		return this.liveSessions.get(sessionId)
	}
}

function asAgentBridge(bridge: SessionMonitorBridge): AgentBridge {
	return bridge as unknown as AgentBridge
}

describe("listSessionMonitor", () => {
	test("classifies a persisted terminal error and preserves its displayable message tail", async () => {
		const cwd = "/workspaces/deploy"
		const transcriptPath = writeTranscript("terminal-error.jsonl", [
			{ type: "session", version: 3, id: "terminal-error", cwd },
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "Deploy the current build" }] },
			},
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "Starting deployment" }] },
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "deploy",
					content: [{ type: "text", text: "Deployment API returned 503" }],
					isError: true,
				},
			},
			{ type: "agent_end", stopReason: "error" },
		])
		const persisted = session("terminal-error", transcriptPath, cwd)

		const [entry] = await listSessionMonitor(asAgentBridge(new SessionMonitorBridge([persisted])))

		expect(entry).toEqual({
			...persisted,
			// Counters come from the full transcript scan, not the (prefix-derived)
			// summary value: one user + one assistant message, no toolCall blocks.
			messageCount: 2,
			toolCallCount: 0,
			status: "error",
			error: "Agent turn ended with an error.",
			recentMessages: [
				{ role: "user", text: "Deploy the current build" },
				{ role: "assistant", text: "Starting deployment" },
				{ role: "tool", text: "Deployment API returned 503", isError: true },
			],
		})
	})

	test("classifies a persisted session ending normally as completed", async () => {
		const cwd = "/workspaces/review"
		const transcriptPath = writeTranscript("completed.jsonl", [
			{ type: "session", version: 3, id: "completed", cwd },
			{ type: "message", message: { role: "user", content: "Review the diff" } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "The diff is ready to merge" }] },
			},
			{ type: "agent_end", stopReason: "stop" },
		])
		const persisted = session("completed", transcriptPath, cwd)

		const [entry] = await listSessionMonitor(asAgentBridge(new SessionMonitorBridge([persisted])))

		expect(entry).toEqual({
			...persisted,
			messageCount: 2,
			toolCallCount: 0,
			status: "completed",
			recentMessages: [
				{ role: "user", text: "Review the diff" },
				{ role: "assistant", text: "The diff is ready to merge" },
			],
		})
	})

	test("does not retain a TTSR advisory as a terminal failure after a successful turn", async () => {
		const cwd = "/workspaces/auto-work"
		const transcriptPath = writeTranscript("ttsr-advisory.jsonl", [
			{ type: "session", version: 3, id: "ttsr-advisory", cwd },
			{ type: "notice", level: "error", message: "TTSR matched rules: tool policy" },
			{ type: "ttsr_triggered", rules: [{ name: "tool policy" }] },
			{ type: "agent_end", stopReason: "end_turn" },
		])
		const persisted = session("ttsr-advisory", transcriptPath, cwd)

		const [entry] = await listSessionMonitor(asAgentBridge(new SessionMonitorBridge([persisted])))
		if (!entry) throw new Error("Expected the persisted session to be monitored")

		expect(entry.status).toBe("completed")
		expect(entry.error).toBeUndefined()
	})

	test("uses a live streaming snapshot instead of a persisted transcript tail", async () => {
		const cwd = "/workspaces/live"
		const transcriptPath = writeTranscript("live.jsonl", [
			{ type: "session", version: 3, id: "live", cwd },
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "Disk transcript must not be used" }],
					isError: true,
				},
			},
			{ type: "agent_end", stopReason: "error" },
		])
		const persisted = session("live", transcriptPath, cwd)
		const snapshot: SessionSnapshot = {
			sessionId: "live",
			sessionFile: transcriptPath,
			cwd,
			isStreaming: true,
			messages: [
				{ role: "user", content: [{ type: "text", text: "Continue the migration" }] },
				{ role: "assistant", content: [{ type: "text", text: "Migrating the final table" }] },
			],
			todoPhases: [],
		}
		const bridge = new SessionMonitorBridge([persisted], [["live", liveHandle(snapshot)]])

		const [entry] = await listSessionMonitor(asAgentBridge(bridge))

		expect(entry.status).toBe("active")
		expect(entry.recentMessages).toEqual([
			{ role: "user", text: "Continue the migration" },
			{ role: "assistant", text: "Migrating the final table" },
		])
	})

	test("forwards a cwd filter to the bridge before monitoring persisted sessions", async () => {
		const selectedCwd = "/workspaces/selected"
		const selected = session(
			"selected",
			writeTranscript("selected.jsonl", [
				{ type: "session", version: 3, id: "selected", cwd: selectedCwd },
				{ type: "message", message: { role: "user", content: "Selected workspace" } },
			]),
			selectedCwd,
		)
		const excludedCwd = "/workspaces/excluded"
		const excluded = session(
			"excluded",
			writeTranscript("excluded.jsonl", [
				{ type: "session", version: 3, id: "excluded", cwd: excludedCwd },
				{ type: "message", message: { role: "user", content: "Other workspace" } },
			]),
			excludedCwd,
		)
		const bridge = new SessionMonitorBridge([selected, excluded])

		const entries = await listSessionMonitor(asAgentBridge(bridge), selectedCwd)

		expect(bridge.listCalls).toEqual([{ cwd: selectedCwd }])
		expect(entries.map((entry) => entry.id)).toEqual(["selected"])
	})

	test("counts toolCall blocks across all assistant messages and only user+assistant records", async () => {
		const cwd = "/workspaces/counters"
		const transcriptPath = writeTranscript("counters.jsonl", [
			{ type: "session", version: 3, id: "counters", cwd },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Refactor the parser" }] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Reading the parser first" },
						{ type: "toolCall", toolName: "read", args: { path: "parser.ts" } },
						{ type: "toolCall", toolName: "grep", args: { pattern: "parse" } },
					],
				},
			},
			{
				type: "message",
				message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "parser source" }] },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolName: "edit", args: { path: "parser.ts" } }],
				},
			},
			{ type: "agent_end", stopReason: "stop" },
		])
		const persisted = session("counters", transcriptPath, cwd)

		const [entry] = await listSessionMonitor(asAgentBridge(new SessionMonitorBridge([persisted])))

		// One user + two assistant messages, the toolResult record is not a message.
		expect(entry.messageCount).toBe(3)
		// 2 toolCall blocks in the first assistant message + 1 in the second.
		expect(entry.toolCallCount).toBe(3)
	})

	test("derives live session counters from the transcript on disk, not the snapshot tail", async () => {
		const cwd = "/workspaces/live-counters"
		const transcriptPath = writeTranscript("live-counters.jsonl", [
			{ type: "session", version: 3, id: "live-counters", cwd },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Run the migration" }] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Applying migrations" },
						{ type: "toolCall", toolName: "bash", args: { command: "migrate" } },
					],
				},
			},
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Now verify the schema" }] } },
		])
		const persisted = session("live-counters", transcriptPath, cwd)
		const snapshot: SessionSnapshot = {
			sessionId: "live-counters",
			sessionFile: transcriptPath,
			cwd,
			isStreaming: true,
			// A single snapshot message with no toolCall blocks: if counters came
			// from here, messageCount would be 1 and toolCallCount 0.
			messages: [{ role: "assistant", content: [{ type: "text", text: "Verifying the schema" }] }],
			todoPhases: [],
		}
		const bridge = new SessionMonitorBridge([persisted], [["live-counters", liveHandle(snapshot)]])

		const [entry] = await listSessionMonitor(asAgentBridge(bridge))

		expect(entry.status).toBe("active")
		expect(entry.messageCount).toBe(3)
		expect(entry.toolCallCount).toBe(1)
		expect(entry.recentMessages).toEqual([{ role: "assistant", text: "Verifying the schema" }])
	})

	test("falls back to the summary messageCount when the transcript is unreadable", async () => {
		const cwd = "/workspaces/missing"
		const persisted = session("missing", path.join(tempDir, "does-not-exist.jsonl"), cwd)

		const [entry] = await listSessionMonitor(asAgentBridge(new SessionMonitorBridge([persisted])))

		expect(entry).toEqual({
			...persisted,
			// The `session` fixture's summary value survives untouched.
			messageCount: persisted.messageCount,
			toolCallCount: 0,
			status: "completed",
			recentMessages: [],
		})
	})

	test("skips unparseable transcript lines without breaking the counters", async () => {
		const cwd = "/workspaces/garbage"
		const transcriptPath = path.join(tempDir, "garbage.jsonl")
		const records = [
			{ type: "session", version: 3, id: "garbage", cwd },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Fix the flaky test" }] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Pinning the clock" },
						{ type: "toolCall", toolName: "edit", args: { path: "clock.test.ts" } },
					],
				},
			},
			{ type: "agent_end", stopReason: "stop" },
		]
		const lines = records.map((record) => JSON.stringify(record))
		// Interleave garbage between every valid record, including a truncated JSON line.
		lines.splice(3, 0, '{"type":"message","message":{"role":"assistant"')
		lines.splice(2, 0, "not json at all")
		lines.splice(1, 0, "%%%")
		fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf8")
		const persisted = session("garbage", transcriptPath, cwd)

		const [entry] = await listSessionMonitor(asAgentBridge(new SessionMonitorBridge([persisted])))

		expect(entry.status).toBe("completed")
		expect(entry.messageCount).toBe(2)
		expect(entry.toolCallCount).toBe(1)
		expect(entry.recentMessages).toEqual([
			{ role: "user", text: "Fix the flaky test" },
			{ role: "assistant", text: "Pinning the clock" },
		])
	})
})
