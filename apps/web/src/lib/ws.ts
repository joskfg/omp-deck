import type { ClientFrame, ServerFrame } from "@omp-deck/protocol";

type Listener = (frame: ServerFrame) => void;
type StatusListener = (status: WsStatus) => void;

export type WsStatus = "connecting" | "open" | "closed";

export class WsClient {
	private socket: WebSocket | null = null;
	private listeners = new Set<Listener>();
	private statusListeners = new Set<StatusListener>();
	private queue: ClientFrame[] = [];
	private retryDelay = 500;
	private maxRetryDelay = 8000;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private status: WsStatus = "closed";
	private url: string;
	private closed = false;

	constructor(url?: string) {
		this.url = url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
	}

	connect(): void {
		if (this.closed) return;
		this.setStatus("connecting");
		const sock = new WebSocket(this.url);
		this.socket = sock;

		sock.addEventListener("open", () => {
			this.setStatus("open");
			this.retryDelay = 500;
			this.flushQueue();
		});

		sock.addEventListener("message", (ev) => {
			let frame: ServerFrame;
			try {
				frame = JSON.parse(ev.data) as ServerFrame;
			} catch {
				return;
			}
			for (const l of this.listeners) {
				try {
					l(frame);
				} catch (err) {
					console.warn("ws listener threw", err);
				}
			}
		});

		const onTeardown = (): void => {
			this.socket = null;
			this.setStatus("closed");
			if (!this.closed) this.scheduleReconnect();
		};
		sock.addEventListener("close", onTeardown);
		sock.addEventListener("error", () => sock.close());
	}

	dispose(): void {
		this.closed = true;
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		this.socket?.close();
		this.socket = null;
		this.setStatus("closed");
	}

	send(frame: ClientFrame): void {
		if (this.socket && this.socket.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(frame));
		} else if (frame.type !== "subscribe" && frame.type !== "subscribe_tasks") {
			this.queue.push(frame);
		}
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	onStatus(listener: StatusListener): () => void {
		this.statusListeners.add(listener);
		listener(this.status);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	getStatus(): WsStatus {
		return this.status;
	}

	private setStatus(s: WsStatus): void {
		if (this.status === s) return;
		this.status = s;
		for (const l of this.statusListeners) l(s);
	}

	private flushQueue(): void {
		while (this.queue.length > 0 && this.socket?.readyState === WebSocket.OPEN) {
			const f = this.queue.shift()!;
			this.socket.send(JSON.stringify(f));
		}
	}

	private scheduleReconnect(): void {
		if (this.retryTimer) return;
		const delay = this.retryDelay;
		this.retryDelay = Math.min(this.maxRetryDelay, this.retryDelay * 2);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.connect();
		}, delay);
	}
}
