import { afterEach, describe, expect, test } from "bun:test"

import { WsClient } from "./ws"

class FakeWebSocket {
	static readonly CONNECTING = 0
	static readonly OPEN = 1

	readonly sent: string[] = []
	readyState = FakeWebSocket.CONNECTING
	private listeners = new Map<string, Array<(event: Event) => void>>()
	constructor() {
		socket = this;
	}

	addEventListener(type: string, listener: (event: Event) => void): void {
		const listeners = this.listeners.get(type) ?? []
		listeners.push(listener)
		this.listeners.set(type, listeners)
	}

	send(payload: string): void {
		this.sent.push(payload)
	}

	close(): void {
		this.readyState = FakeWebSocket.CONNECTING
		this.emit("close")
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN
		this.emit("open")
	}

	private emit(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener({ type } as Event)
	}
}

const originalWebSocket = globalThis.WebSocket
let socket: FakeWebSocket


afterEach(() => {
	globalThis.WebSocket = originalWebSocket
})

describe("WsClient disconnected queue", () => {
	test("does not flush stale subscription frames after reconnecting", () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		const client = new WsClient("ws://test")

		client.connect()
		client.send({ type: "subscribe", sessionId: "session-1" })
		client.send({ type: "subscribe_tasks" })
		client.send({ type: "ping" })
		socket.open()

		expect(socket.sent.map((payload) => JSON.parse(payload))).toEqual([{ type: "ping" }])
		client.dispose()
	})
})
