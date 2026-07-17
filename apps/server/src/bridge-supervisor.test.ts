import { describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";

import { BridgeSupervisor } from "./bridge-supervisor.ts";

type SpawnOptions = {
	onExit?: (subprocess: Subprocess, exitCode: number | null, signalCode: number | null, error?: Error) => void;
};

interface FakeProcess {
	pid: number;
	exited: Promise<number>;
	kill(): void;
	resolveExit(code: number): void;
}

function fakeProcess(pid: number): FakeProcess {
	let resolveExit!: (code: number) => void;
	return {
		pid,
		exited: new Promise<number>((resolve) => {
			resolveExit = resolve;
		}),
		kill() {},
		resolveExit,
	};
}

function supervisor(): BridgeSupervisor {
	return new BridgeSupervisor([{ name: "telegram", label: "Telegram", entry: "/tmp/telegram.ts", requiredEnv: [] }]);
}

describe("BridgeSupervisor lifecycle", () => {
	test("shares a pending start so concurrent callers spawn one process", async () => {
		const realSpawn = Bun.spawn;
		const spawned: FakeProcess[] = [];
		try {
			Bun.spawn = ((_: SpawnOptions) => {
				const proc = fakeProcess(spawned.length + 1);
				spawned.push(proc);
				return proc as unknown as Subprocess;
			}) as typeof Bun.spawn;

			const bridges = supervisor();
			const first = bridges.start("telegram");
			const second = bridges.start("telegram");
			await Promise.resolve();

			expect(spawned).toHaveLength(1);
			const [firstInfo, secondInfo] = await Promise.all([first, second]);
			expect(firstInfo.pid).toBe(1);
			expect(secondInfo.pid).toBe(1);
		} finally {
			Bun.spawn = realSpawn;
		}
	});

	test("ignores a delayed exit from the stopped process after a replacement starts", async () => {
		const realSpawn = Bun.spawn;
		const spawned: FakeProcess[] = [];
		const exits: NonNullable<SpawnOptions["onExit"]>[] = [];
		try {
			Bun.spawn = ((options: SpawnOptions) => {
				const proc = fakeProcess(spawned.length + 1);
				spawned.push(proc);
				exits.push(options.onExit!);
				return proc as unknown as Subprocess;
			}) as typeof Bun.spawn;

			const bridges = supervisor();
			await bridges.start("telegram");
			const stopping = bridges.stop("telegram");
			spawned[0]!.resolveExit(0);
			await stopping;
			await bridges.start("telegram");

			exits[0]!(spawned[0] as unknown as Subprocess, 23, null);

			const info = bridges.get("telegram");
			expect(info).toMatchObject({ pid: 2, status: "running", crashCount: 0 });
			expect(info.exitCode).toBeUndefined();
		} finally {
			Bun.spawn = realSpawn;
		}
	});
});
