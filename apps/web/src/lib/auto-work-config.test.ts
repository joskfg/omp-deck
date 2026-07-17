import { describe, expect, test } from "bun:test";

import type { AutoWorkConfig } from "@omp-deck/protocol";

import { autoWorkConfigToRequest } from "./auto-work-config";

function config(overrides: Partial<AutoWorkConfig> = {}): AutoWorkConfig {
	return {
		workspaceCwd: "/work/proj",
		enabled: true,
		modelByPriority: { P0: null, P1: null, P2: null, P3: null, P4: null, P5: null },
		modelByDifficulty: { easy: null, medium: { provider: "anthropic", id: "haiku" }, hard: null },
		timeWindows: [{ start: 9, end: 17 }],
		sessionPctLimit: 25,
		weeklyPctLimit: 60,
		weeklyPctThreshold: 80,
		defaultEstimatePctByPriority: { P0: 5, P1: 5, P2: 5, P3: 5, P4: 5, P5: 5 },
		estimationBuffer: 1.3,
		timeoutMinutesByPriority: { P0: 30, P1: 30, P2: 30, P3: 30, P4: 30, P5: 30 },
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("autoWorkConfigToRequest", () => {
	test("carries every mutable field from the fetched config into the PUT body", () => {
		const cfg = config();
		const body = autoWorkConfigToRequest(cfg);
		expect(body).toEqual({
			enabled: cfg.enabled,
			modelByPriority: cfg.modelByPriority,
			modelByDifficulty: cfg.modelByDifficulty,
			timeWindows: cfg.timeWindows,
			sessionPctLimit: cfg.sessionPctLimit,
			weeklyPctLimit: cfg.weeklyPctLimit,
			weeklyPctThreshold: cfg.weeklyPctThreshold,
			defaultEstimatePctByPriority: cfg.defaultEstimatePctByPriority,
			estimationBuffer: cfg.estimationBuffer,
			timeoutMinutesByPriority: cfg.timeoutMinutesByPriority,
		});
	});

	test("drops read-only identity fields not part of the write contract", () => {
		const body = autoWorkConfigToRequest(config());
		expect(body).not.toHaveProperty("workspaceCwd");
		expect(body).not.toHaveProperty("updatedAt");
	});

	test("preserves an unrelated field (modelByPriority) when only modelByDifficulty changes", () => {
		const base = config();
		const mutated: AutoWorkConfig = {
			...base,
			modelByDifficulty: { ...base.modelByDifficulty, hard: { provider: "anthropic", id: "opus" } },
		};
		const body = autoWorkConfigToRequest(mutated);
		expect(body.modelByPriority).toEqual(base.modelByPriority);
		expect(body.modelByDifficulty.hard).toEqual({ provider: "anthropic", id: "opus" });
	});
});
