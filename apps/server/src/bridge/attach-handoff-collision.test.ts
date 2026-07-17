/**
 * T-32 regression test: reopening a handoff's ORIGIN file (e.g. via the
 * handoff banner's "origin" link) must NEVER dispose the still-live
 * continuation, even though the origin file's own on-disk id equals the
 * continuation's `active` map key (which stays pinned to its pre-handoff
 * id by design — see `bridge/in-process.ts`'s `session_handoff` emission
 * and `attach()`'s collision-disambiguation doc comments).
 *
 * Regression covered: `attach()`'s pre-existing "supersede a same-id
 * duplicate" safety net did not distinguish that case from a GENUINE
 * duplicate attach, so resuming the origin silently killed the user's
 * live, actively-streaming continuation session.
 */
import { describe, expect, test } from "bun:test";

import { InProcessAgentBridge, type InProcessSessionHandle } from "./in-process.ts";

class StubSession {
	readonly sessionId: string;
	readonly settings = { override: () => {} };
	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}
	subscribe(_listener: unknown): () => void {
		return () => {};
	}
	async dispose(): Promise<void> {}
}

function makeSessionManager(sessionId: string, sessionFile: string | undefined) {
	return {
		getArtifactsDir: () => null,
		getSessionId: () => sessionId,
		getSessionFile: () => sessionFile,
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
	const attachBridge = bridge as unknown as AttachBridge;
	return attachBridge.attach.bind(attachBridge);
}

/** Directly registers a fake `Active` entry — simulates a live handle that
 *  has already auto-handed-off onto `sessionFile` while staying keyed
 *  under `id` (no live attach()/event stream needed for this test). */
function registerFakeActive(bridge: InProcessAgentBridge, id: string, sessionFile: string): { disposed: boolean } {
	const state = { disposed: false };
	const handle = {
		sessionId: id,
		sessionFile,
		cwd: "/tmp",
		async dispose() {
			state.disposed = true;
		},
	} as unknown as InProcessSessionHandle;
	(bridge as unknown as { active: Map<string, unknown> }).active.set(id, { handle, subscribers: new Set() });
	return state;
}

describe("attach() handoff-origin collision (T-32)", () => {
	test("reopening the origin file gets an independent handle without disposing the live continuation", async () => {
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		const originId = "origin-id";
		const originFile = "/tmp/origin.jsonl";
		const continuationFile = "/tmp/continuation.jsonl";

		// The live continuation: still keyed by `originId`, but its CURRENT
		// file has moved on (simulating a completed auto-handoff).
		const continuationState = registerFakeActive(bridge, originId, continuationFile);

		// Re-attach for the origin file itself — same on-disk id, DIFFERENT
		// (diverged) current file relative to what's registered under that id.
		const attach = getAttach(bridge);
		const originHandle = await attach(
			new StubSession(originId),
			"/tmp",
			makeSessionManager(originId, originFile),
			() => {},
			false,
		);

		expect(continuationState.disposed).toBe(false);
		expect(bridge.getSession(originId)).toBeDefined();
		expect(bridge.getSession(originId)?.sessionFile).toBe(continuationFile);
		expect(originHandle.sessionId).not.toBe(originId);
		expect(bridge.getSession(originHandle.sessionId)).toBe(originHandle);
	});

	test("a genuine duplicate attach for the SAME file still supersedes (unchanged behavior)", async () => {
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		const id = "shared-id";
		const file = "/tmp/same.jsonl";
		const firstState = registerFakeActive(bridge, id, file);

		const attach = getAttach(bridge);
		const secondHandle = await attach(new StubSession(id), "/tmp", makeSessionManager(id, file), () => {}, false);

		expect(firstState.disposed).toBe(true);
		expect(secondHandle.sessionId).toBe(id);
		expect(bridge.getSession(id)).toBe(secondHandle);
	});
});
