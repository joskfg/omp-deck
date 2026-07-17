import { describe, expect, test } from "bun:test";

import { InProcessAgentBridge, type InProcessSessionHandle } from "./in-process.ts";

class StubSession {
	readonly sessionId = "shared-session";
	readonly settings = { override: () => {} };
	readonly disposeStarted = Promise.withResolvers<void>();
	readonly disposeFinished = Promise.withResolvers<void>();
	private readonly disposeGate: Promise<void>;
	unsubscribeCalls = 0;

	constructor(disposeGate: Promise<void> = Promise.resolve()) {
		this.disposeGate = disposeGate;
	}

	subscribe(_listener: unknown): () => void {
		return () => {
			this.unsubscribeCalls += 1;
		};
	}

	async dispose(): Promise<void> {
		this.disposeStarted.resolve();
		await this.disposeGate;
		this.disposeFinished.resolve();
	}
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

function makeSessionManager(sessionId: string) {
	return {
		getArtifactsDir: () => null,
		getSessionId: () => sessionId,
		getSessionFile: () => undefined,
		buildSessionContext: () => ({}),
		appendModeChange: () => {},
	};
}

function getAttach(bridge: InProcessAgentBridge): AttachBridge["attach"] {
	// Test-only access to the bridge's private wiring seam.
	const attachBridge = bridge as unknown as AttachBridge;
	return attachBridge.attach.bind(attachBridge);
}

describe("InProcessAgentBridge lifecycle", () => {
	test("disposal releases the active SDK subscription", async () => {
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		const session = new StubSession();
		const attach = getAttach(bridge);
		const handle = await attach(
			session,
			"/tmp",
			makeSessionManager(session.sessionId),
			() => {},
			false,
		);

		await handle.dispose();

		expect(session.unsubscribeCalls).toBe(1);
		expect(bridge.getSession(session.sessionId)).toBeUndefined();
	});

	test("a superseded handle cannot remove its replacement after asynchronous disposal", async () => {
		const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
		const releaseFirstDispose = Promise.withResolvers<void>();
		const firstSession = new StubSession(releaseFirstDispose.promise);
		const replacementSession = new StubSession();
		const attach = getAttach(bridge);
		const firstHandle = await attach(
			firstSession,
			"/tmp",
			makeSessionManager(firstSession.sessionId),
			() => {},
			false,
		);

		const replacementHandle = await attach(
			replacementSession,
			"/tmp",
			makeSessionManager(replacementSession.sessionId),
			() => {},
			false,
		);
		await firstSession.disposeStarted.promise;
		expect(bridge.getSession(firstSession.sessionId)).toBe(replacementHandle);

		releaseFirstDispose.resolve();
		await firstSession.disposeFinished.promise;
		await Promise.resolve();

		expect(firstSession.unsubscribeCalls).toBe(1);
		expect(bridge.getSession(firstSession.sessionId)).toBe(replacementHandle);
		await replacementHandle.dispose();
		expect(firstHandle).not.toBe(replacementHandle);
	});
});
