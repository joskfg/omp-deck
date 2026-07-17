import type { AutoWorkConfig, SetAutoWorkConfigRequest } from "@omp-deck/protocol";

/**
 * `PUT /api/auto-work/config` replaces the whole per-workspace row, so any
 * caller that mutates a single field (the schedule toggle in Settings, the
 * per-difficulty agent map in Project Configuration, …) must round-trip every
 * other field unchanged. Centralised here so both surfaces build the same
 * request shape from a fetched `AutoWorkConfig` instead of hand-rolling it.
 */
export function autoWorkConfigToRequest(config: AutoWorkConfig): SetAutoWorkConfigRequest {
	return {
		enabled: config.enabled,
		autoMerge: config.autoMerge,
		modelByPriority: config.modelByPriority,
		modelByDifficulty: config.modelByDifficulty,
		timeWindows: config.timeWindows,
		sessionPctLimit: config.sessionPctLimit,
		weeklyPctLimit: config.weeklyPctLimit,
		weeklyPctThreshold: config.weeklyPctThreshold,
		defaultEstimatePctByPriority: config.defaultEstimatePctByPriority,
		estimationBuffer: config.estimationBuffer,
		timeoutMinutesByPriority: config.timeoutMinutesByPriority,
	};
}
