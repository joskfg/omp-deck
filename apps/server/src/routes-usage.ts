/**
 * Usage REST surface (T-59). Mounted on the main router at `/api/usage/*`.
 *
 * - `GET /usage/subscription` — cached provider subscription / rate-limit
 *   usage via the SDK's AuthStorage; see `usage-subscription.ts`.
 * - `GET /usage/sessions` — per-session token/cost totals from persisted
 *   transcripts; see `usage-sessions.ts`.
 * - `GET /usage/spend` — per-account (workspace) spend by day/week/month
 *   bucket, from the same transcripts; see `usage-spend.ts` (T-98).
 * - `GET /usage/stats` — aggregated historical stats from the omp-stats
 *   SQLite DB, filterable by workspace/model/agentType/range (T-37).
 */

import { Hono } from "hono";
import type { AggregatedStatsResponse, ListSessionUsageResponse, SpendSummaryResponse } from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";
import { getSubscriptionUsage, type UsageReportsFetcher } from "./usage-subscription.ts";
import { listSessionUsage } from "./usage-sessions.ts";
import { getAccountSpendSummary } from "./usage-spend.ts";
import { getAggregatedStats, type AggregatedStatsOpts } from "./usage-stats.ts";

const DEFAULT_SESSIONS_LIMIT = 20;
const MAX_SESSIONS_LIMIT = 200;

export interface BuildUsageRouterOptions {
	/**
	 * Test-only: override the usage-reports fetcher injected into
	 * `getSubscriptionUsage`, avoiding the real `getDeckAuthStorage()` call.
	 */
	fetcherOverride?: UsageReportsFetcher;
	/**
	 * Test-only: replace the real `getAggregatedStats` with a stub so route
	 * tests can exercise query-param parsing and response shaping without
	 * touching the omp-stats SQLite DB or the sync worker.
	 */
	statsOverride?: (bridge: AgentBridge, opts: AggregatedStatsOpts) => Promise<AggregatedStatsResponse>;
}

export function buildUsageRouter(bridge: AgentBridge, config: Config, options: BuildUsageRouterOptions = {}): Hono {
	const app = new Hono();

	app.get("/usage/subscription", async (c) => {
		const result = await getSubscriptionUsage(options.fetcherOverride);
		return c.json(result);
	});

	app.get("/usage/spend", async (c) => {
		const result: SpendSummaryResponse = await getAccountSpendSummary(bridge, config);
		return c.json(result);
	});

	app.get("/usage/sessions", async (c) => {
		const rawLimit = c.req.query("limit");
		let limit = DEFAULT_SESSIONS_LIMIT;
		if (rawLimit !== undefined) {
			const parsed = Number(rawLimit);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				return c.json({ error: "limit must be a positive integer" }, 400);
			}
			limit = Math.min(parsed, MAX_SESSIONS_LIMIT);
		}
		const sessions = await listSessionUsage(bridge, limit);
		const body: ListSessionUsageResponse = { sessions };
		return c.json(body);
	});

	// Valid range values mirror omp-stats' TimeRange; unknown values are
	// accepted and fall back to "24h" inside getAggregatedStats.
	app.get("/usage/stats", async (c) => {
		const range = c.req.query("range") ?? "7d";
		const cwd = c.req.query("cwd") ?? undefined;
		const model = c.req.query("model") ?? undefined;
		const agentType = c.req.query("agentType") ?? undefined;
		const statsImpl = options.statsOverride ?? getAggregatedStats;
		const result: AggregatedStatsResponse = await statsImpl(bridge, {
			range,
			cwd,
			model,
			agentType,
		});
		return c.json(result);
	});

	return app;
}
