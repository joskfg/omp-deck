/**
 * Unit tests for `fetchSubscriptionUsage` / `getSubscriptionUsage`.
 *
 * Never hits a real provider — `fetcherOverride` is always a stub that returns
 * synthetic `UsageReport[]` or `null`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";

import {
	fetchSubscriptionUsage,
	getSubscriptionUsage,
	resetSubscriptionUsageCacheForTests,
	type UsageReportsFetcher,
} from "./usage-subscription.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIVE_HOURS_MS = 5 * 3600_000;
const SEVEN_DAYS_MS = 7 * 24 * 3600_000;

function makeLimit(
	id: string,
	label: string,
	usedFraction: number,
	windowDurationMs: number,
	resetsAt?: number,
): UsageReport["limits"][number] {
	return {
		id,
		label,
		scope: { provider: "anthropic" },
		amount: { usedFraction, unit: "percent" },
		window: { id, label, durationMs: windowDurationMs, resetsAt },
	};
}

/** One-window report (5h by default). */
function makeReport(usedFraction: number, resetsAt?: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [makeLimit("5h", "5 Hour", usedFraction, FIVE_HOURS_MS, resetsAt)],
	};
}

/** Full two-window report mimicking Claude's real response. */
function makeFullReport(fiveHourFraction: number, sevenDayFraction: number, resetsAt5h?: number, resetsAt7d?: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			makeLimit("5h", "5 Hour", fiveHourFraction, FIVE_HOURS_MS, resetsAt5h),
			makeLimit("7d", "7 Day", sevenDayFraction, SEVEN_DAYS_MS, resetsAt7d),
		],
	};
}

function fetcher(reports: UsageReport[] | null): UsageReportsFetcher {
	return async () => reports;
}

function throwingFetcher(message: string): UsageReportsFetcher {
	return async () => {
		throw new Error(message);
	};
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => resetSubscriptionUsageCacheForTests());
afterEach(() => resetSubscriptionUsageCacheForTests());

// ---------------------------------------------------------------------------
// fetchSubscriptionUsage
// ---------------------------------------------------------------------------

describe("fetchSubscriptionUsage", () => {
	test("returns unavailable when reports array is null", async () => {
		const result = await fetchSubscriptionUsage(fetcher(null));
		expect(result.available).toBe(false);
		if (!result.available) expect(result.reason).toMatch(/no provider usage data/);
	});

	test("returns unavailable when reports array is empty", async () => {
		const result = await fetchSubscriptionUsage(fetcher([]));
		expect(result.available).toBe(false);
	});

	test("maps usedFraction to sessionPct and builds limits array", async () => {
		const resetMs = Date.parse("2026-08-01T00:00:00Z");
		const result = await fetchSubscriptionUsage(fetcher([makeReport(0.75, resetMs)]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result.sessionPct).toBe(75);
		expect(result.weeklyPct).toBe(75); // only one window → session = weekly
		expect(result.sessionResetAt).toBe(new Date(resetMs).toISOString());
		expect(result.limits).toHaveLength(1);
		expect(result.limits[0]).toMatchObject({ label: "5 Hour", pctUsed: 75, windowDurationMs: FIVE_HOURS_MS });
	});

	test("exposes sessionPct (5h) and weeklyPct (7d) separately", async () => {
		const reset5h = Date.parse("2026-08-01T05:00:00Z");
		const reset7d = Date.parse("2026-08-07T00:00:00Z");
		const result = await fetchSubscriptionUsage(fetcher([makeFullReport(0.4, 0.2, reset5h, reset7d)]));
		expect(result.available).toBe(true);
		if (!result.available) return;

		expect(result.limits[0]).toMatchObject({ label: "5 Hour", pctUsed: 40, windowDurationMs: FIVE_HOURS_MS });
		expect(result.limits[1]).toMatchObject({ label: "7 Day", pctUsed: 20, windowDurationMs: SEVEN_DAYS_MS });

		expect(result.sessionPct).toBe(40);
		expect(result.sessionResetAt).toBe(new Date(reset5h).toISOString());
		expect(result.weeklyPct).toBe(20);
		expect(result.weeklyResetAt).toBe(new Date(reset7d).toISOString());
	});

	test("sessionPct is from shortest window, weeklyPct from longest", async () => {
		// 7d window is more used than 5h
		const result = await fetchSubscriptionUsage(fetcher([makeFullReport(0.3, 0.8)]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result.sessionPct).toBeCloseTo(30, 5);
		expect(result.weeklyPct).toBeCloseTo(80, 5);
	});

	test("deduplicates limits with the same id, keeping highest fraction", async () => {
		const low: UsageReport = { provider: "anthropic", fetchedAt: Date.now(), limits: [makeLimit("5h", "5 Hour", 0.2, FIVE_HOURS_MS)] };
		const high: UsageReport = { provider: "anthropic", fetchedAt: Date.now(), limits: [makeLimit("5h", "5 Hour", 0.9, FIVE_HOURS_MS)] };
		const result = await fetchSubscriptionUsage(fetcher([low, high]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result.sessionPct).toBeCloseTo(90, 5);
		expect(result.weeklyPct).toBeCloseTo(90, 5); // one window → session = weekly
		expect(result.limits).toHaveLength(1);
	});

	test("clamps sessionPct and weeklyPct to [0, 100]", async () => {
		const result = await fetchSubscriptionUsage(fetcher([makeReport(1.5)]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result.sessionPct).toBe(100);
		expect(result.weeklyPct).toBe(100);
		expect(result.limits[0]!.pctUsed).toBe(100);
	});

	test("returns available with empty limits and 0% when reports have no usedFraction", async () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [{ id: "5h", label: "5 Hour", scope: { provider: "anthropic" }, amount: { unit: "tokens" } }],
		};
		const result = await fetchSubscriptionUsage(fetcher([report]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result.sessionPct).toBe(0);
		expect(result.weeklyPct).toBe(0);
		expect(result.limits).toHaveLength(0);
	});

	test("returns graceful unavailable when fetcher throws (network error)", async () => {
		const result = await fetchSubscriptionUsage(throwingFetcher("ECONNREFUSED"));
		expect(result.available).toBe(false);
		if (!result.available) expect(result.reason).toMatch(/ECONNREFUSED/);
	});

	test("uses fallback resetAt values when windows have no resetsAt — falls back to now+windowDurationMs, not now", async () => {
		// makeReport creates a 5-hour window without a resetsAt timestamp.
		// The fallback must be at least now + windowDurationMs in the future,
		// not just the current time (which would misleadingly imply an immediate reset).
		const before = Date.now();
		const result = await fetchSubscriptionUsage(fetcher([makeReport(0.5)]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		// All reset timestamps must be valid ISO strings.
		expect(() => new Date(result.sessionResetAt)).not.toThrow();
		expect(() => new Date(result.weeklyResetAt)).not.toThrow();
		expect(() => new Date(result.limits[0]!.resetAt)).not.toThrow();
		// The fallback must be at or after before + windowDurationMs (5h) — strictly
		// in the future relative to when the call started, not just the current time.
		expect(Date.parse(result.sessionResetAt)).toBeGreaterThanOrEqual(before + FIVE_HOURS_MS);
		expect(Date.parse(result.weeklyResetAt)).toBeGreaterThanOrEqual(before + FIVE_HOURS_MS);
		expect(Date.parse(result.limits[0]!.resetAt)).toBeGreaterThanOrEqual(before + FIVE_HOURS_MS);
	});

	test("same limit.id from different accountIds produces separate limits entries", async () => {
		// Regression: the old allById Map was keyed only by limit.id, so two
		// accounts' "5h" windows collapsed to one bar. Now keyed by
		// provider:account:limitId, each account must produce its own entry.
		const reportA: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "5h",
					label: "5 Hour",
					scope: { provider: "anthropic", accountId: "acc_111" },
					amount: { usedFraction: 0.3, unit: "percent" },
					window: { id: "5h", label: "5 Hour", durationMs: FIVE_HOURS_MS },
				},
			],
		};
		const reportB: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "5h",
					label: "5 Hour",
					scope: { provider: "anthropic", accountId: "acc_222" },
					amount: { usedFraction: 0.7, unit: "percent" },
					window: { id: "5h", label: "5 Hour", durationMs: FIVE_HOURS_MS },
				},
			],
		};
		const result = await fetchSubscriptionUsage(fetcher([reportA, reportB]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		// Both accounts must appear as distinct bars.
		expect(result.limits).toHaveLength(2);
		const accounts = result.limits.map((l) => l.account).sort();
		expect(accounts).toEqual(["acc_111", "acc_222"]);
		// session/weekly still uses the primary-provider byId dedup (highest fraction).
		expect(result.sessionPct).toBeCloseTo(70, 5);
	});

	test("provider and account fields are carried through to each limit entry", async () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "5h",
					label: "5 Hour",
					scope: { provider: "anthropic", accountId: "acc_abc" },
					amount: { usedFraction: 0.5, unit: "percent" },
					window: { id: "5h", label: "5 Hour", durationMs: FIVE_HOURS_MS },
				},
			],
		};
		const result = await fetchSubscriptionUsage(fetcher([report]));
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result.limits).toHaveLength(1);
		expect(result.limits[0]).toMatchObject({ provider: "anthropic", account: "acc_abc" });
	});

	test("falls back through orgId then projectId then tier then (shared) for account label", async () => {
		const makeScoped = (scope: UsageReport["limits"][number]["scope"]): UsageReport => ({
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [{ id: "5h", label: "5 Hour", scope, amount: { usedFraction: 0.1, unit: "percent" }, window: { id: "5h", label: "5 Hour", durationMs: FIVE_HOURS_MS } }],
		});
		// orgId wins when accountId absent
		const r1 = await fetchSubscriptionUsage(fetcher([makeScoped({ provider: "anthropic", orgId: "org_x" })]));
		expect(r1.available && r1.limits[0]?.account).toBe("org_x");
		// projectId wins when accountId+orgId absent
		const r2 = await fetchSubscriptionUsage(fetcher([makeScoped({ provider: "anthropic", projectId: "proj_y" })]));
		expect(r2.available && r2.limits[0]?.account).toBe("proj_y");
		// tier wins when all above absent
		const r3 = await fetchSubscriptionUsage(fetcher([makeScoped({ provider: "anthropic", tier: "pro" })]));
		expect(r3.available && r3.limits[0]?.account).toBe("pro");
		// (shared) when none present
		const r4 = await fetchSubscriptionUsage(fetcher([makeScoped({ provider: "anthropic" })]));
		expect(r4.available && r4.limits[0]?.account).toBe("(shared)");
	});
});

// ---------------------------------------------------------------------------
// getSubscriptionUsage caching
// ---------------------------------------------------------------------------

describe("getSubscriptionUsage caching", () => {
	test("two rapid calls only invoke the fetcher once", async () => {
		let calls = 0;
		const stub: UsageReportsFetcher = async () => {
			calls++;
			return [makeReport(0.1, Date.now() + FIVE_HOURS_MS)];
		};
		const [a, b] = await Promise.all([getSubscriptionUsage(stub), getSubscriptionUsage(stub)]);
		expect(calls).toBe(1);
		expect(a).toEqual(b);
	});

	test("a second call within the TTL window reuses the cached result", async () => {
		let calls = 0;
		const stub: UsageReportsFetcher = async () => {
			calls++;
			return [makeReport(0.2, Date.now() + FIVE_HOURS_MS)];
		};
		const t0 = Date.now();
		await getSubscriptionUsage(stub, t0);
		await getSubscriptionUsage(stub, t0 + 1_000);
		expect(calls).toBe(1);
	});

	test("a call after the TTL expires fires a fresh request", async () => {
		let calls = 0;
		const stub: UsageReportsFetcher = async () => {
			calls++;
			return [makeReport(0.3, Date.now() + FIVE_HOURS_MS)];
		};
		const t0 = Date.now();
		await getSubscriptionUsage(stub, t0);
		await getSubscriptionUsage(stub, t0 + 61_000);
		expect(calls).toBe(2);
	});
});
