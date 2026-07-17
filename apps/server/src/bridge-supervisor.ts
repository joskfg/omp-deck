import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import type { BridgeInfo, BridgeLogLine, BridgeName, BridgeStatus } from "@omp-deck/protocol";

import { logger } from "./log.ts";
import { resolveBunExecutable } from "./runtime-bun.ts";

const log = logger("bridges");

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolved path to the telegram bridge entry. In dev the server runs from
 * `apps/server/src/`, so the bridge entry sits four hops away. In production
 * builds (server bundled into `dist/`) the operator can override via
 * `OMP_BRIDGE_TELEGRAM_ENTRY`.
 */
function defaultTelegramEntry(): string {
	const override = process.env.OMP_BRIDGE_TELEGRAM_ENTRY?.trim();
	if (override) return path.resolve(override);
	return path.resolve(here, "..", "..", "bridges", "telegram", "src", "index.ts");
}

/** Env vars the telegram bridge needs to start — also the "is Telegram configured" signal `auto-work/notify.ts` (T-67) gates outbound push notifications on. */
export const TELEGRAM_REQUIRED_ENV = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"];

/** True when every var `TELEGRAM_REQUIRED_ENV` lists is set — the same check `BridgeSupervisor.start` uses to refuse starting the interactive bridge. */
export function isTelegramBridgeConfigured(): boolean {
	return TELEGRAM_REQUIRED_ENV.every((key) => (process.env[key] ?? "").trim() !== "");
}

interface BridgeSpec {
	name: BridgeName;
	label: string;
	entry: string;
	requiredEnv: string[];
}

class LogRing {
	private buf: BridgeLogLine[] = [];
	constructor(private readonly capacity: number) {}
	push(line: BridgeLogLine): void {
		this.buf.push(line);
		if (this.buf.length > this.capacity) this.buf.shift();
	}
	snapshot(): BridgeLogLine[] {
		return this.buf.slice();
	}
	clear(): void {
		this.buf = [];
	}
}

interface Tracked {
	spec: BridgeSpec;
	proc?: Subprocess;
	startPromise?: Promise<BridgeInfo>;
	startToken?: symbol;
	startedAt?: number;
	stoppedAt?: number;
	status: BridgeStatus;
	exitCode?: number;
	exitSignal?: string;
	crashCount: number;
	logs: LogRing;
	stopRequested: boolean;
	lastError?: string;
}

export class BridgeSupervisor {
	private readonly tracked = new Map<BridgeName, Tracked>();

	constructor(specs: BridgeSpec[]) {
		for (const spec of specs) {
			this.tracked.set(spec.name, {
				spec,
				status: "stopped",
				crashCount: 0,
				logs: new LogRing(200),
				stopRequested: false,
			});
		}
	}

	list(): BridgeInfo[] {
		return Array.from(this.tracked.values()).map((t) => this.toInfo(t));
	}

	get(name: BridgeName): BridgeInfo {
		const t = this.requireBridge(name);
		return this.toInfo(t);
	}

	async start(name: BridgeName): Promise<BridgeInfo> {
		const t = this.requireBridge(name);
		if (t.proc) return this.toInfo(t);
		if (t.startPromise) return t.startPromise;

		const missing = this.missingEnv(t.spec);
		if (missing.length > 0) {
			t.lastError = `missing required env: ${missing.join(", ")}`;
			throw new Error(t.lastError);
		}

		t.stopRequested = false;
		t.lastError = undefined;
		t.logs.clear();
		t.status = "starting";

		const token = Symbol(name);
		t.startToken = token;
		const startPromise = Promise.resolve().then(() => this.launch(t, name, token));
		t.startPromise = startPromise;
		try {
			return await startPromise;
		} finally {
			if (t.startPromise === startPromise) t.startPromise = undefined;
			if (t.startToken === token) t.startToken = undefined;
		}
	}

	private launch(t: Tracked, name: BridgeName, token: symbol): BridgeInfo {
		if (t.startToken !== token || t.stopRequested) return this.toInfo(t);

		let proc: Subprocess;
		try {
			proc = Bun.spawn({
				// Use the resolved Bun path rather than `process.execPath` directly.
				// `process.execPath` can be stale (issue #6: user reinstalls Bun /
				// uninstalls the official-installer copy / switches version managers
				// after deck boot) and posix_spawn ENOENTs on it. `resolveBunExecutable`
				// falls back to a PATH lookup.
				cmd: [resolveBunExecutable(), t.spec.entry],
				cwd: path.dirname(t.spec.entry),
				env: { ...process.env } as Record<string, string>,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				onExit: (subprocess, exitCode, signalCode, _error) => {
					// A delayed exit from a process that stop() already converged
					// (and a subsequent start replaced) must not overwrite the
					// current process's lifecycle state.
					if (t.proc !== subprocess) return;
					t.proc = undefined;
					t.exitCode = exitCode ?? undefined;
					t.exitSignal = signalCode != null ? String(signalCode) : undefined;
					t.stoppedAt = Date.now();
					if (t.stopRequested) {
						t.status = "stopped";
					} else {
						t.crashCount += 1;
						t.status = "crashed";
						log.warn(`bridge ${name} crashed`, { exitCode, signalCode });
					}
				},
			});
		} catch (err) {
			if (t.startToken === token) {
				t.status = "crashed";
				t.lastError = String(err);
			}
			throw err;
		}

		// stop() can cancel a scheduled start before this microtask launches.
		// If a synchronous spawn hook re-entered and invalidated the token, do
		// not leave the newly-created subprocess orphaned.
		if (t.startToken !== token || t.stopRequested) {
			try {
				proc.kill();
			} catch (err) {
				log.warn(`bridge ${name} kill threw`, err);
			}
			return this.toInfo(t);
		}

		t.proc = proc;
		t.startedAt = Date.now();
		t.stoppedAt = undefined;
		t.exitCode = undefined;
		t.exitSignal = undefined;
		t.status = "running";

		void pumpStream(t, proc.stdout as ReadableStream<Uint8Array>, "stdout");
		void pumpStream(t, proc.stderr as ReadableStream<Uint8Array>, "stderr");
		log.info(`bridge ${name} started pid=${proc.pid}`);
		return this.toInfo(t);
	}

	async stop(name: BridgeName): Promise<BridgeInfo> {
		const t = this.requireBridge(name);
		if (!t.proc) {
			if (t.startPromise) {
				t.stopRequested = true;
				t.startToken = undefined;
				t.status = "stopped";
				await t.startPromise.catch(() => undefined);
			}
			t.status = "stopped";
			return this.toInfo(t);
		}
		t.stopRequested = true;
		try {
			t.proc.kill();
		} catch (err) {
			log.warn(`bridge ${name} kill threw`, err);
		}
		try {
			await t.proc.exited;
		} catch {
			// ignore — onExit already updated bookkeeping
		}
		// onExit may fire before or after `exited` resolves on Bun's Windows
		// path. Force-converge state so the response reflects the actual
		// post-stop reality rather than whatever the race produced.
		t.proc = undefined;
		t.status = "stopped";
		t.lastError = undefined;
		t.stoppedAt = t.stoppedAt ?? Date.now();
		return this.toInfo(t);
	}

	async restart(name: BridgeName): Promise<BridgeInfo> {
		await this.stop(name);
		return this.start(name);
	}

	logs(name: BridgeName): BridgeLogLine[] {
		return this.requireBridge(name).logs.snapshot();
	}

	async shutdown(): Promise<void> {
		await Promise.all(
			Array.from(this.tracked.keys()).map((name) =>
				this.stop(name).catch((err) => log.warn(`bridge ${name} shutdown failed`, err)),
			),
		);
	}

	private requireBridge(name: BridgeName): Tracked {
		const t = this.tracked.get(name);
		if (!t) throw new Error(`unknown bridge: ${name}`);
		return t;
	}

	private missingEnv(spec: BridgeSpec): string[] {
		return spec.requiredEnv.filter((key) => !(process.env[key] ?? "").trim());
	}

	private toInfo(t: Tracked): BridgeInfo {
		const info: BridgeInfo = {
			name: t.spec.name,
			label: t.spec.label,
			status: t.status,
			crashCount: t.crashCount,
			missingEnv: this.missingEnv(t.spec),
			requiredEnv: [...t.spec.requiredEnv],
		};
		if (t.proc) info.pid = t.proc.pid;
		if (t.startedAt) info.startedAt = new Date(t.startedAt).toISOString();
		if (t.stoppedAt) info.stoppedAt = new Date(t.stoppedAt).toISOString();
		if (t.exitCode !== undefined) info.exitCode = t.exitCode;
		if (t.exitSignal !== undefined) info.exitSignal = t.exitSignal;
		if (t.lastError) info.lastError = t.lastError;
		return info;
	}
}

async function pumpStream(t: Tracked, stream: ReadableStream<Uint8Array> | undefined, label: "stdout" | "stderr"): Promise<void> {
	if (!stream) return;
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let pending = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			let nl = pending.indexOf("\n");
			while (nl !== -1) {
				const raw = pending.slice(0, nl).replace(/\r$/, "");
				pending = pending.slice(nl + 1);
				if (raw) t.logs.push({ stream: label, text: raw, timestamp: new Date().toISOString() });
				nl = pending.indexOf("\n");
			}
		}
		const tail = pending.trim();
		if (tail) t.logs.push({ stream: label, text: tail, timestamp: new Date().toISOString() });
	} catch (err) {
		log.warn(`bridge ${t.spec.name} ${label} pump failed`, err);
	}
}

export function buildDefaultBridgeSupervisor(): BridgeSupervisor {
	return new BridgeSupervisor([
		{
			name: "telegram",
			label: "Telegram",
			entry: defaultTelegramEntry(),
			requiredEnv: TELEGRAM_REQUIRED_ENV,
		},
	]);
}
