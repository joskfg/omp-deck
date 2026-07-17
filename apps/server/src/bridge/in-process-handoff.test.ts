import { describe, expect, test } from "bun:test";

import { InProcessAgentBridge, type InProcessSessionHandle } from "./in-process.ts";

/**
 * T-32: stub SDK session that records the listener `attach()` installs so
 * tests can fire synthetic `auto_compaction_start`/`auto_compaction_end`
 * events through it, mirroring `in-process-lifecycle.test.ts`'s
 * `StubSession` but with a mutable `sessionFile` — needed to simulate the
 * SDK's in-place `newSession()` file swap mid-handoff.
 */
class HandoffStubSession {
	readonly sessionId: string;
	sessionFile: string | undefined;
	readonly settings = { override: () => {} };
	private listener: ((event: unknown) => void) | undefined;

	constructor(sessionId: string, sessionFile: string) {
		this.sessionId = sessionId;
		this.sessionFile = sessionFile;
	}

	subscribe(listener: (event: unknown) => void): () => void {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	}

	fire(event: Record<string, unknown>): void {
		this.listener?.(event);
	}

	async dispose(): Promise<void> {}
}

function makeSessionManager(getId: () => string, getFile: () => string | undefined = () => undefined) {
	return {
		getArtifactsDir: () => null,
		getSessionId: getId,
		getSessionFile: getFile,
		buildSessionContext: () => ({}),
		appendModeChange: () => {},
	};
}

type AttachBridge = {
	attach(
		session: unknown,
		cwd: string,
		sessionManager: unknown,
		setToolUIContext: (uiBridge: unknown, hasUI: boolean) => void,
		hasUI: boolean,
	): Promise<InProcessSessionHandle>;
};

function getAttach(bridge: InProcessAgentBridge): AttachBridge["attach"] {
	// Test-only access to the bridge's private wiring seam (same seam
	// in-process-lifecycle.test.ts uses).
	const attachBridge = bridge as unknown as AttachBridge;
	return attachBridge.attach.bind(attachBridge);
}

describe("InProcessSessionHandle auto-handoff (T-32)", () => {
	test("emits a session_handoff event with the old/new identity on a successful handoff", async () => {
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		const session = new HandoffStubSession("provider-id", "/tmp/old.jsonl");
		let currentSessionId = "old-file-id";
		const attach = getAttach(bridge);
		const handle = await attach(session, "/tmp", makeSessionManager(() => currentSessionId), () => {}, false);

		const events: Array<Record<string, unknown>> = [];
		handle.subscribe((e) => events.push(e as unknown as Record<string, unknown>));

		session.fire({ type: "auto_compaction_start", reason: "threshold", action: "handoff" });
		// Simulate the SDK's newSession() swap completing before auto_compaction_end fires.
		currentSessionId = "new-file-id";
		session.sessionFile = "/tmp/new.jsonl";
		session.fire({ type: "auto_compaction_end", action: "handoff", result: undefined, aborted: false, willRetry: false });

		const handoff = events.find((e) => e.type === "session_handoff");
		expect(handoff).toMatchObject({
			type: "session_handoff",
			reason: "threshold",
			previousSessionId: "old-file-id",
			previousSessionFile: "/tmp/old.jsonl",
			newSessionId: "new-file-id",
			newSessionFile: "/tmp/new.jsonl",
		});
		expect(typeof handoff?.timestamp).toBe("number");
		// The wire-facing handle identity intentionally never re-keys — see
		// in-process.ts's session_handoff emission doc comment.
		expect(handle.sessionId).toBe("provider-id");
	});

	test("does not emit session_handoff when the handoff was aborted", async () => {
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		const session = new HandoffStubSession("provider-id", "/tmp/old.jsonl");
		const attach = getAttach(bridge);
		const handle = await attach(session, "/tmp", makeSessionManager(() => "old-file-id"), () => {}, false);

		const events: Array<Record<string, unknown>> = [];
		handle.subscribe((e) => events.push(e as unknown as Record<string, unknown>));

		session.fire({ type: "auto_compaction_start", reason: "overflow", action: "handoff" });
		session.fire({ type: "auto_compaction_end", action: "handoff", result: undefined, aborted: true, willRetry: false });

		expect(events.find((e) => e.type === "session_handoff")).toBeUndefined();
	});

	test("ignores auto_compaction_end events for a non-handoff action", async () => {
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		const session = new HandoffStubSession("provider-id", "/tmp/old.jsonl");
		const attach = getAttach(bridge);
		const handle = await attach(session, "/tmp", makeSessionManager(() => "old-file-id"), () => {}, false);

		const events: Array<Record<string, unknown>> = [];
		handle.subscribe((e) => events.push(e as unknown as Record<string, unknown>));

		session.fire({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		session.fire({
			type: "auto_compaction_end",
			action: "context-full",
			result: { summary: "x", shortSummary: "x" },
			aborted: false,
			willRetry: false,
		});

		expect(events.find((e) => e.type === "session_handoff")).toBeUndefined();
	});

	test("a second handoff on the same live handle reports the first handoff's new id as its own previous id", async () => {
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		const session = new HandoffStubSession("provider-id", "/tmp/a.jsonl");
		let currentSessionId = "id-a";
		const attach = getAttach(bridge);
		const handle = await attach(session, "/tmp", makeSessionManager(() => currentSessionId), () => {}, false);

		const events: Array<Record<string, unknown>> = [];
		handle.subscribe((e) => events.push(e as unknown as Record<string, unknown>));

		// First handoff: a -> b.
		session.fire({ type: "auto_compaction_start", reason: "threshold", action: "handoff" });
		currentSessionId = "id-b";
		session.sessionFile = "/tmp/b.jsonl";
		session.fire({ type: "auto_compaction_end", action: "handoff", result: undefined, aborted: false, willRetry: false });

		// Second handoff on the SAME live handle: b -> c.
		session.fire({ type: "auto_compaction_start", reason: "overflow", action: "handoff" });
		currentSessionId = "id-c";
		session.sessionFile = "/tmp/c.jsonl";
		session.fire({ type: "auto_compaction_end", action: "handoff", result: undefined, aborted: false, willRetry: false });

		const handoffs = events.filter((e) => e.type === "session_handoff");
		expect(handoffs).toHaveLength(2);
		expect(handoffs[0]).toMatchObject({ previousSessionId: "id-a", newSessionId: "id-b" });
		// Must report "id-b" (the FIRST handoff's outcome), not the original
		// attach()-time id — this is the regression this test guards against.
		expect(handoffs[1]).toMatchObject({ previousSessionId: "id-b", newSessionId: "id-c" });
	});
});
