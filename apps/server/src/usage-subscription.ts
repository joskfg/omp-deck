/**
 * Provider subscription / rate-limit usage — `GET /api/usage/subscription`.
 *
 * Uses the SDK's `AuthStorage.fetchUsageReports()` which handles every auth
 * mode (API key, Claude.ai OAuth, Copilot, etc.) without requiring callers to
 * know the underlying credential type.  The old approach — probing
 * `POST /v1/messages` with `ANTHROPIC_API_KEY` and reading rate-limit headers
 * — only worked for direct API-key accounts; subscription users had no key in
 * the environment so it always returned `available: false`.
 *
 * Caching: one shared in-flight promise + a 60-second result cache so
 * concurrent callers and rapid polls don't fan out to the provider.
 */

import { resolveUsedFraction, type UsageReport } from "@oh-my-pi/pi-ai";
import type { SubscriptionUsageAvailable, SubscriptionUsageResponse, SubscriptionUsageUnavailable } from "@omp-deck/protocol";
import { getDeckAuthStorage, getDeckModelRegistry } from "./auth-singleton.ts";
import { logger } from "./log.ts";

const log = logger("usage-subscription");

// ---------------------------------------------------------------------------
// Public types — re-exported from @omp-deck/protocol (the wire contract),
// not re-declared here. A prior local copy of these interfaces drifted out
// of sync with the protocol package after the multi-window (limits/
// sessionPct/weeklyPct) refactor below was implemented but the duplicate
// declaration was never updated to match (T-69) — importing instead of
// duplicating makes that class of drift structurally impossible.
// ---------------------------------------------------------------------------

export type { SubscriptionUsageAvailable, SubscriptionUsageUnavailable };
export type SubscriptionUsageResult = SubscriptionUsageResponse;

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Narrowest contract the implementation needs from AuthStorage, exposed so
 * tests can pass a lightweight stub without importing the full SDK.
 */
export type UsageReportsFetcher = (options?: {
	baseUrlResolver?: (provider: string) => string | undefined;
}) => Promise<UsageReport[] | null>;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
	result: SubscriptionUsageResult;
	fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<SubscriptionUsageResult> | null = null;

/** Test-only: drop the cache / in-flight state between test cases. */
export function resetSubscriptionUsageCacheForTests(): void {
	cache = null;
	inFlight = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Cached + request-coalesced subscription usage lookup.
 *
 * @param fetcherOverride  Inject a custom fetcher in tests; production always
 *   uses the deck's shared `getDeckAuthStorage()` instance.
 * @param now  Override `Date.now()` for TTL tests.
 */
export async function getSubscriptionUsage(
	fetcherOverride?: UsageReportsFetcher,
	now: number = Date.now(),
): Promise<SubscriptionUsageResult> {
	if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.result;
	if (inFlight) return inFlight;

	inFlight = (async () => {
		try {
			const result = await fetchSubscriptionUsage(fetcherOverride);
			cache = { result, fetchedAt: now };
			return result;
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}

/**
 * Single uncached fetch. Exported for tests that want to exercise the
 * raw lookup without the caching layer.
 */
export async function fetchSubscriptionUsage(
	fetcherOverride?: UsageReportsFetcher,
): Promise<SubscriptionUsageResult> {
	try {
		let reports: UsageReport[] | null;

		if (fetcherOverride) {
			reports = await fetcherOverride();
		} else {
			const [authStorage, registry] = await Promise.all([getDeckAuthStorage(), getDeckModelRegistry()]);
			reports = await authStorage.fetchUsageReports({
				baseUrlResolver: (provider) => registry.getProviderBaseUrl(provider),
			});
		}

		if (!reports || reports.length === 0) {
			return { available: false, reason: "no provider usage data available" };
		}
		// Identify the primary provider: "anthropic" first (the deck is Claude-based),
		// otherwise the provider whose limits carry the highest max fraction.
		// Other providers (copilot, openai-codex, etc.) must not mix into the
		// session/weekly sort — e.g. copilot limits have windowDurationMs=undefined
		// which sorts to +∞ and would win as "weekly" with fraction 0.
		const byProvider = new Map<string, typeof reports[number]["limits"]>();
		for (const report of reports) {
			const existing = byProvider.get(report.provider);
			byProvider.set(report.provider, existing ? [...existing, ...report.limits] : [...report.limits]);
		}
		const primaryProvider =
			byProvider.has("anthropic")
				? "anthropic"
				: [...byProvider.entries()].reduce(
						(best, [provider, limits]) => {
							const maxFrac = Math.max(0, ...limits.map((l) => resolveUsedFraction(l) ?? 0));
							const bestFrac = Math.max(0, ...(byProvider.get(best) ?? []).map((l) => resolveUsedFraction(l) ?? 0));
							return maxFrac > bestFrac ? provider : best;
						},
						[...byProvider.keys()][0]!,
					);
		const primaryLimits = byProvider.get(primaryProvider) ?? [];

		// Dedup within the primary provider's limits (same window can appear
		// across multiple accounts — keep the highest fraction seen).
		const byId = new Map<string, { fraction: number; label: string; resetsAt?: number; windowDurationMs?: number }>();
		for (const limit of primaryLimits) {
			const fraction = resolveUsedFraction(limit);
			if (fraction === undefined) continue;
			const existing = byId.get(limit.id);
			if (existing === undefined || fraction > existing.fraction) {
				byId.set(limit.id, {
					fraction,
					label: limit.label,
					resetsAt: limit.window?.resetsAt,
					windowDurationMs: limit.window?.durationMs,
				});
			}
		}

		// Build the full limits array across ALL providers (for display), sorted
		// shortest-first. This is separate from the primary-report selection above.
		//
		// Keyed by provider:account:limitId so same-window limits from different
		// accounts are kept as distinct display bars, not collapsed into one.
		// Within the same (provider, account, limitId) tuple we keep the highest
		// fraction seen (defensive — normally each tuple appears once).
		interface DisplayEntry {
			fraction: number;
			label: string;
			resetsAt?: number;
			windowDurationMs?: number;
			provider: string;
			account: string;
		}
		const allByKey = new Map<string, DisplayEntry>();
		for (const report of reports) {
			for (const limit of report.limits) {
				const fraction = resolveUsedFraction(limit);
				if (fraction === undefined) continue;
				const { scope } = limit;
				// Derive a human-readable account label, always non-empty.
				const account =
					scope.accountId ?? scope.orgId ?? scope.projectId ?? scope.tier ?? "(shared)";
				const displayKey = `${scope.provider}:${account}:${limit.id}`;
				const existing = allByKey.get(displayKey);
				if (existing === undefined || fraction > existing.fraction) {
					allByKey.set(displayKey, {
						fraction,
						label: limit.label,
						resetsAt: limit.window?.resetsAt,
						windowDurationMs: limit.window?.durationMs,
						provider: scope.provider,
						account,
					});
				}
			}
		}
		const allSorted = [...allByKey.values()].sort((a, b) => {
			const da = a.windowDurationMs ?? Number.POSITIVE_INFINITY;
			const db = b.windowDurationMs ?? Number.POSITIVE_INFINITY;
			return da - db;
		});
		const limits = allSorted.map((entry) => ({
			label: entry.label,
			pctUsed: Math.min(100, Math.max(0, entry.fraction * 100)),
			resetAt:
				entry.resetsAt != null
					? new Date(entry.resetsAt).toISOString()
					: new Date(Date.now() + (entry.windowDurationMs ?? 0)).toISOString(),
			...(entry.windowDurationMs != null ? { windowDurationMs: entry.windowDurationMs } : {}),
			provider: entry.provider,
			account: entry.account,
		}));

		// session = shortest primary window, weekly = longest primary window.
		const primarySorted = [...byId.values()].sort((a, b) => {
			const da = a.windowDurationMs ?? Number.POSITIVE_INFINITY;
			const db = b.windowDurationMs ?? Number.POSITIVE_INFINITY;
			return da - db;
		});
		const session = primarySorted[0];
		const weekly = primarySorted[primarySorted.length - 1] ?? session;

		return {
			available: true,
			limits,
			sessionPct: session != null ? Math.min(100, Math.max(0, session.fraction * 100)) : 0,
			sessionResetAt:
				session?.resetsAt != null
					? new Date(session.resetsAt).toISOString()
					: new Date(Date.now() + (session?.windowDurationMs ?? 0)).toISOString(),
			weeklyPct: weekly != null ? Math.min(100, Math.max(0, weekly.fraction * 100)) : 0,
			weeklyResetAt:
				weekly?.resetsAt != null
					? new Date(weekly.resetsAt).toISOString()
					: new Date(Date.now() + (weekly?.windowDurationMs ?? 0)).toISOString(),
		};
	} catch (err) {
		log.warn("failed to fetch subscription usage", err);
		return {
			available: false,
			reason: `request failed: ${(err as Error)?.message ?? String(err)}`,
		};
	}
}
