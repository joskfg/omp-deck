import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

import type { AutoWorkGlobalConfig } from "@omp-deck/protocol";
import type { AgentBridge } from "../bridge/types.ts";

let resolveCycle: (() => void) | undefined;
const runGlobalAutoWorkCycle = mock(
	() =>
		new Promise<{ outcome: "skipped"; reason: string }>((resolve) => {
			resolveCycle = () => resolve({ outcome: "skipped", reason: "test cycle" });
		}),
);

mock.module("./engine.ts", () => ({
	runGlobalAutoWorkCycle,
	countEligibleWorkspaces: () => 0,
	shouldConsiderSqueeze: () => false,
	decideSqueezeTiming: async () => false,
	reconcileAutoMergedRuns: async () => 0,
}));

const { disposeScheduler, updateGlobalSchedule } = await import("./scheduler.ts");

const config: AutoWorkGlobalConfig = {
	scheduleEnabled: true,
	scheduleIntervalMinutes: 1,
	taskSelectionModel: null,
	squeezeEnabled: false,
	modelByDifficulty: { easy: null, medium: null, hard: null },
	updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("updateGlobalSchedule", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		runGlobalAutoWorkCycle.mockClear();
		resolveCycle = undefined;
	});

	afterEach(() => {
		disposeScheduler();
		jest.useRealTimers();
	});

	test("does not start an overlapping cycle while the previous interval cycle is still in flight", async () => {
		updateGlobalSchedule(config, {} as AgentBridge);

		jest.advanceTimersByTime(60_000);
		expect(runGlobalAutoWorkCycle).toHaveBeenCalledTimes(1);

		jest.advanceTimersByTime(60_000);
		expect(runGlobalAutoWorkCycle).toHaveBeenCalledTimes(1);

		resolveCycle?.();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		jest.advanceTimersByTime(60_000);
		expect(runGlobalAutoWorkCycle).toHaveBeenCalledTimes(2);
	});
});
