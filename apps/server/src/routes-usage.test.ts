/**
 * Exercises the real Hono router for `/usage/*`.
 *
 * The subscription endpoint's external call is stubbed via the
 * `fetcherOverride` option on `buildUsageRouter` — no `globalThis.fetch`
 * patching needed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageReport } from "@oh-my-pi/pi-ai";

import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";
import type {
	AggregatedStatsResponse,
	SessionSummary,
	SubscriptionUsageResponse,
	ListSessionUsageResponse,
	SpendSummaryResponse,
} from "@omp-deck/protocol";
import { buildUsageRouter } from "./routes-usage.ts";
import { resetSubscriptionUsageCacheForTests } from "./usage-subscription.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-usage-"));
	resetSubscriptionUsageCacheForTests();
});

afterEach(() => {
	resetSubscriptionUsageCacheForTests();
	rmSync(dir, { recursive: true, force: true });
});

function fakeBridge(sessions: SessionSummary[]): AgentBridge {
	return {
		async createSession() {
			throw new Error("not exercised");
		},
		async resumeSession() {
			throw new Error("not exercised");
		},
		getSession() {
			return undefined;
		},
		async listSessions() {
			return sessions;
		},
		async deleteSession() {
			return { deleted: false };
		},
		trackSubscriberAdded() {},
		trackSubscriberRemoved() {},
		bumpActivity() {},
		async listModels() {
			return [];
		},
	} as unknown as AgentBridge;
}

function fakeConfig(): Config {
	return { defaultCwd: "/home/user/project", extraWorkspaces: [] as string[] } as Config;
}

function reportWith(usedFraction: number, resetsAt?: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "5h",
				label: "5 Hour",
				scope: { provider: "anthropic" },
				amount: { usedFraction, unit: "percent" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * 3600_000, resetsAt },
			},
		],
	};
}

describe("GET /usage/subscription", () => {
	test("returns available usage from UsageReport", async () => {
		const resetMs = Date.parse("2026-08-01T00:00:00Z");
		let calls = 0;
		const app = buildUsageRouter(fakeBridge([]), fakeConfig(), {
			fetcherOverride: async () => {
				calls++;
				return [reportWith(0.6, resetMs)];
			},
		});

		const res = await app.request("/usage/subscription");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SubscriptionUsageResponse;
		expect(body).toMatchObject({
			available: true,
			sessionPct: 60,
			weeklyPct: 60, // single window → session = weekly
			limits: [{ label: "5 Hour", pctUsed: 60 }],
		});

		// Second rapid call must not fire a second request (cache).
		const res2 = await app.request("/usage/subscription");
		expect(res2.status).toBe(200);
		expect(calls).toBe(1);
	});

	test("returns graceful unavailable when fetcher returns null", async () => {
		const app = buildUsageRouter(fakeBridge([]), fakeConfig(), {
			fetcherOverride: async () => null,
		});
		const res = await app.request("/usage/subscription");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SubscriptionUsageResponse;
		expect(body.available).toBe(false);
	});

	test("returns graceful unavailable when fetcher throws", async () => {
		const app = buildUsageRouter(fakeBridge([]), fakeConfig(), {
			fetcherOverride: async () => {
				throw new Error("network error");
			},
		});
		const res = await app.request("/usage/subscription");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SubscriptionUsageResponse;
		expect(body.available).toBe(false);
		if (!body.available) expect(body.reason).toMatch(/network error/);
	});
});

describe("GET /usage/sessions", () => {
	test("returns per-session token usage, defaulting to 20 sessions", async () => {
		const filePath = path.join(dir, "s1.jsonl");
		writeFileSync(
			filePath,
			[{ type: "message", message: { role: "assistant", usage: { totalTokens: 42, cost: { total: 0.02 } } } }]
				.map((l) => JSON.stringify(l))
				.join("\n") + "\n",
		);
		const summary: SessionSummary = {
			id: "s1",
			path: filePath,
			cwd: "/x",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			messageCount: 1,
		};
		const app = buildUsageRouter(fakeBridge([summary]), fakeConfig());
		const res = await app.request("/usage/sessions");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListSessionUsageResponse;
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0]?.totalTokens).toBe(42);
		expect(body.sessions[0]?.costUsd).toBeCloseTo(0.02, 6);
	});

	test("rejects a non-positive-integer limit with 400", async () => {
		const app = buildUsageRouter(fakeBridge([]), fakeConfig());
		const res = await app.request("/usage/sessions?limit=abc");
		expect(res.status).toBe(400);
	});
});

describe("GET /usage/spend", () => {
	test("aggregates cost into the current day/week/month buckets, keyed by workspace cwd", async () => {
		const nowIso = new Date().toISOString();
		const filePath = path.join(dir, "spend1.jsonl");
		writeFileSync(
			filePath,
			[
				{ type: "message", timestamp: nowIso, message: { role: "assistant", usage: { cost: { total: 0.5 } } } },
				{ type: "message", timestamp: nowIso, message: { role: "assistant", usage: { cost: { total: 0.25 } } } },
			]
				.map((l) => JSON.stringify(l))
				.join("\n") + "\n",
		);
		const summary: SessionSummary = {
			id: "spend1",
			path: filePath,
			cwd: "/spend/workspace",
			createdAt: nowIso,
			updatedAt: nowIso,
			messageCount: 2,
		};
		const app = buildUsageRouter(fakeBridge([summary]), fakeConfig());
		const res = await app.request("/usage/spend");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SpendSummaryResponse;
		expect(typeof body.dayStart).toBe("string");
		expect(typeof body.weekStart).toBe("string");
		expect(typeof body.monthStart).toBe("string");
		expect(Array.isArray(body.accounts)).toBe(true);

		const entry = body.accounts.find((a) => a.cwd === "/spend/workspace");
		expect(entry).toBeDefined();
		expect(entry?.month).toBeGreaterThan(0);
		expect(entry?.month).toBeCloseTo(0.75, 6);
	});

	test("returns a zeroed entry for the default workspace when there are no sessions at all", async () => {
		const app = buildUsageRouter(fakeBridge([]), fakeConfig());
		const res = await app.request("/usage/spend");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SpendSummaryResponse;

		const entry = body.accounts.find((a) => a.cwd === fakeConfig().defaultCwd);
		expect(entry).toBeDefined();
		expect(entry).toMatchObject({ day: 0, week: 0, month: 0 });
		expect(typeof entry?.label).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// GET /usage/stats
// ---------------------------------------------------------------------------

/** Minimal valid AggregatedStatsResponse for use as a stub return value. */
function stubStatsResponse(overrides: Partial<AggregatedStatsResponse> = {}): AggregatedStatsResponse {
	return {
		range: "7d",
		source: "sessions",
		syncInProgress: false,
		total: { costUsd: 1.5, totalTokens: 3000, requests: 10 },
		byModel: [
			{
				model: "claude-sonnet-4-6",
				provider: "anthropic",
				costUsd: 1.5,
				totalTokens: 3000,
				requests: 10,
				sessionLinks: [{ sessionId: "sess-abc", title: "My session", cwd: "/project", agentType: "main" }],
			},
		],
		byWorkspace: [{ cwd: "/project", label: "project", costUsd: 1.5, totalTokens: 3000, requests: 10 }],
		byAgentType: [{ agentType: "main", costUsd: 1.5, totalTokens: 3000, requests: 10 }],
		...overrides,
	};
}

describe("GET /usage/stats", () => {
	test("returns 200 with the AggregatedStatsResponse shape from the stub", async () => {
		const stub = stubStatsResponse();
		const app = buildUsageRouter(fakeBridge([]), fakeConfig(), {
			statsOverride: async () => stub,
		});

		const res = await app.request("/usage/stats");
		expect(res.status).toBe(200);
		const body = (await res.json()) as AggregatedStatsResponse;
		expect(body.source).toBe("sessions");
		expect(body.range).toBe("7d");
		expect(typeof body.syncInProgress).toBe("boolean");
		expect(Array.isArray(body.byModel)).toBe(true);
		expect(Array.isArray(body.byWorkspace)).toBe(true);
		expect(Array.isArray(body.byAgentType)).toBe(true);
		expect(body.total.costUsd).toBe(1.5);
	});

	test("parses range query param and forwards it to the stats impl", async () => {
		let capturedOpts: Record<string, unknown> = {};
		const app = buildUsageRouter(fakeBridge([]), fakeConfig(), {
			statsOverride: async (_bridge, opts) => {
				capturedOpts = opts as Record<string, unknown>;
				return stubStatsResponse({ range: opts.range as AggregatedStatsResponse["range"] });
			},
		});

		const res = await app.request("/usage/stats?range=30d");
		expect(res.status).toBe(200);
		expect(capturedOpts.range).toBe("30d");
	});

	test("parses cwd, model, and agentType query params and forwards them", async () => {
		let capturedOpts: Record<string, unknown> = {};
		const app = buildUsageRouter(fakeBridge([]), fakeConfig(), {
			statsOverride: async (_bridge, opts) => {
				capturedOpts = opts as Record<string, unknown>;
				return stubStatsResponse();
			},
		});

		const res = await app.request(
			"/usage/stats?cwd=%2Fhome%2Fuser%2Fproject&model=claude-sonnet-4-6&agentType=main",
		);
		expect(res.status).toBe(200);
		expect(capturedOpts.cwd).toBe("/home/user/project");
		expect(capturedOpts.model).toBe("claude-sonnet-4-6");
		expect(capturedOpts.agentType).toBe("main");
	});

	test("uses default range '7d' when no range param is given", async () => {
		let capturedRange: string | undefined;
		const app = buildUsageRouter(fakeBridge([]), fakeConfig(), {
			statsOverride: async (_bridge, opts) => {
				capturedRange = opts.range;
				return stubStatsResponse();
			},
		});

		const res = await app.request("/usage/stats");
		expect(res.status).toBe(200);
		expect(capturedRange).toBe("7d");
	});

	test("forwards the bridge to the stats impl", async () => {
		const sessions: SessionSummary[] = [
			{ id: "s1", path: "/sessions/p/s1.jsonl", cwd: "/project", title: "T", updatedAt: "", createdAt: "", messageCount: 0 },
		];
		let bridgePassed = false;
		const app = buildUsageRouter(fakeBridge(sessions), fakeConfig(), {
			statsOverride: async (bridge) => {
				const listed = await bridge.listSessions({});
				bridgePassed = listed.length === 1 && listed[0]?.id === "s1";
				return stubStatsResponse();
			},
		});

		const res = await app.request("/usage/stats");
		expect(res.status).toBe(200);
		expect(bridgePassed).toBe(true);
	});

	test("session links in byModel contain sessionId and agentType", async () => {
		const stub = stubStatsResponse();
		const app = buildUsageRouter(fakeBridge([]), fakeConfig(), {
			statsOverride: async () => stub,
		});

		const res = await app.request("/usage/stats");
		const body = (await res.json()) as AggregatedStatsResponse;
		const modelRow = body.byModel[0]!;
		expect(modelRow).toBeDefined();
		const link = modelRow.sessionLinks[0]!;
		expect(link).toBeDefined();
		expect(link.sessionId).toBe("sess-abc");
		expect(link.agentType).toBe("main");
	});

	test("source field is always 'sessions' (not routine data)", async () => {
		const app = buildUsageRouter(fakeBridge([]), fakeConfig(), {
			statsOverride: async () => stubStatsResponse(),
		});
		const body = (await (await app.request("/usage/stats")).json()) as AggregatedStatsResponse;
		expect(body.source).toBe("sessions");
	});
});
