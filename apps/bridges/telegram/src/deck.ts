import type { CreateSessionRequest, CreateSessionResponse, ImageAttachment, ServerFrame } from "@omp-deck/protocol";

export class SessionNotActiveError extends Error {
	constructor(sessionId: string) {
		super(`session not active: ${sessionId}`);
	}
}

/**
 * Minimal WebSocket surface `DeckClient` depends on — lets tests inject a
 * fake transport instead of opening a real socket.
 */
export type DeckWebSocket = Pick<WebSocket, "send" | "close"> & {
	onopen: ((ev: Event) => unknown) | null;
	onerror: ((ev: Event) => unknown) | null;
	onclose: ((ev: CloseEvent) => unknown) | null;
	onmessage: ((ev: MessageEvent) => unknown) | null;
};

export class DeckClient {
	constructor(
		private readonly apiBase: string,
		private readonly wsUrl: string,
		private readonly wsFactory: (url: string) => DeckWebSocket = (url) => new WebSocket(url),
	) {}

	async createSession(opts: { cwd: string; resumeFromPath?: string }): Promise<CreateSessionResponse> {
		const body: CreateSessionRequest = {
			cwd: opts.cwd,
			...(opts.resumeFromPath ? { resumeFromPath: opts.resumeFromPath } : {}),
		};
		return this.request<CreateSessionResponse>("/api/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
	}

	async deleteSession(sessionId: string): Promise<void> {
		const res = await fetch(`${this.apiBase}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
		if (res.status === 404) return;
		if (!res.ok) throw new Error(`deck delete session failed: ${res.status}`);
	}

	/**
	 * Runs one prompt→reply turn over the deck WS and resolves with ONLY the
	 * turn's final assistant text (T-125). There is deliberately no
	 * partial-text callback here — callers structurally cannot observe
	 * anything before the turn's terminal event, so a Telegram-origin session
	 * can never leak intermediate/streaming content.
	 */
	promptSession(args: { sessionId: string; text: string; images?: ImageAttachment[] }): Promise<string> {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const ws = this.wsFactory(this.wsUrl);
		let promptSent = false;
		let settled = false;
		let latestText = "";

		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			try {
				ws.close();
			} catch {
				// already closed
			}
			if (err) reject(err);
			else resolve(latestText.trim() || "Turn complete.");
		};

		ws.onopen = () => {
			ws.send(JSON.stringify({ type: "subscribe", sessionId: args.sessionId }));
		};
		ws.onerror = () => finish(new Error("deck websocket failed"));
		ws.onclose = () => {
			if (!settled) finish(new Error("deck websocket closed before turn ended"));
		};
		ws.onmessage = (ev) => {
			let frame: ServerFrame;
			try {
				frame = JSON.parse(String(ev.data)) as ServerFrame;
			} catch {
				finish(new Error("deck websocket sent invalid json"));
				return;
			}
			if (frame.type === "subscribed" && frame.sessionId === args.sessionId && !promptSent) {
				promptSent = true;
				ws.send(
					JSON.stringify({
						type: "prompt",
						sessionId: args.sessionId,
						text: args.text,
						...(args.images && args.images.length > 0 ? { images: args.images } : {}),
					}),
				);
				return;
			}
			if (frame.type === "error" && (!frame.sessionId || frame.sessionId === args.sessionId)) {
				const message = frame.error.toLowerCase();
				finish(message.includes("session not active") ? new SessionNotActiveError(args.sessionId) : new Error(frame.error));
				return;
			}
			if (frame.type !== "session_event" || frame.sessionId !== args.sessionId) return;
			const event = frame.event as Record<string, unknown>;
			if (event.type === "message_update" || event.type === "message_end" || event.type === "message_start") {
				const msg = event.message as Record<string, unknown> | undefined;
				if (msg?.role === "assistant") {
					const next = extractAssistantText(msg.content);
					if (next) latestText = next;
				}
				return;
			}
			if (event.type === "turn_end" || event.type === "agent_end") {
				// The terminal event's own `message` is the authoritative last
				// message of the turn (T-125) — always adopt its text (even if
				// empty) instead of accumulated streaming text, so stale
				// preamble/narration from earlier in the turn is never shown as
				// the final result when the final message adds nothing new.
				const msg = event.message as Record<string, unknown> | undefined;
				if (msg?.role === "assistant") latestText = extractAssistantText(msg.content);
				finish();
			}
		};

		return promise;
	}

	private async request<T>(path: string, init: RequestInit): Promise<T> {
		const res = await fetch(`${this.apiBase}${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(init.headers ?? {}) },
		});
		if (!res.ok) throw new Error(`deck request failed ${path}: HTTP ${res.status} ${await res.text()}`);
		return (await res.json()) as T;
	}
}

function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") out += block.text;
	}
	return out;
}
