/**
 * Aggregated historical OMP stats — `GET /api/usage/stats` (T-37).
 *
 * Data source: @oh-my-pi/omp-stats SQLite DB (`messages` table).  Only
 * agent-session transcript data lives here; Deck `routine_runs` are a
 * separate table and are NOT included — satisfying the acceptance
 * criterion "session and routine data are not mixed without explicit
 * labeling."  The response carries `source: "sessions"` to make this
 * boundary explicit in the wire format.
 *
 * Sync strategy: `syncAllSessions()` is fired as a single-flight
 * background task (5-min TTL) so the GET path never blocks on I/O.
 * The first request before any sync has run returns empty data with
 * `syncInProgress: true`; callers should surface this to the user.
 *
 * Query approach: `getDashboardStats(range)` from @oh-my-pi/omp-stats
 * is called to ensure `initDb()` runs (creates the SQLite file and
 * applies migrations).  Custom combined WHERE-clause queries are then
 * run on a separate read-only Database handle so workspace+model
 * cross-filtering and session drill-down links work correctly.
 *
 * Session links: `messages.session_file` paths are resolved to Deck
 * session IDs via a `bridge.listSessions({})` path → {id, title, cwd}
 * map.  Nested subagent/advisor transcripts are mapped to their parent
 * session with an explicit `agentType` label.  No raw filesystem paths
 * are sent to the client.
 */

import * as path from "node:path";
import { Database } from "bun:sqlite";
import { syncAllSessions, getDashboardStats } from "@oh-my-pi/omp-stats";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import type { AgentBridge } from "./bridge/types.ts";
import type {
	AggregatedStatsResponse,
	OmpStatsRange,
	SessionDrillDownLink,
} from "@omp-deck/protocol";
import { deriveLabel } from "./workspace-label.ts";
import { logger } from "./log.ts";

const log = logger("usage-stats");

// ---------------------------------------------------------------------------
// Single-flight background sync
// ---------------------------------------------------------------------------

const SYNC_TTL_MS = 5 * 60 * 1000; // 5 min

let syncInFlight: Promise<void> | null = null;
let lastSyncCompletedAt = 0;

/**
 * Trigger a background syncAllSessions() if none is in flight and the last
 * completed sync is older than `SYNC_TTL_MS`.  Never awaited by the caller —
 * the GET handler returns immediately with whatever is in the DB.
 */
export function ensureBackgroundSync(): void {
	if (syncInFlight !== null) return;
	if (Date.now() - lastSyncCompletedAt < SYNC_TTL_MS) return;

	syncInFlight = syncAllSessions()
		.then(() => {
			lastSyncCompletedAt = Date.now();
		})
		.catch((err: unknown) => {
			log.warn("omp-stats background sync failed", err);
		})
		.finally(() => {
			syncInFlight = null;
		});
}

export function isSyncInProgress(): boolean {
	return syncInFlight !== null;
}

/** Test helper: reset module-level sync state between tests. */
export function resetSyncStateForTests(): void {
	syncInFlight = null;
	lastSyncCompletedAt = 0;
}

// ---------------------------------------------------------------------------
// Session path → Deck ID resolution
// ---------------------------------------------------------------------------

interface SessionInfo {
	id: string;
	title: string | undefined;
	cwd: string;
}

/**
 * Build a Map<sessionFilePath, SessionInfo> from the bridge session listing.
 * Only main sessions are directly indexed; nested transcripts are resolved
 * via `resolveDeckSessionId` at lookup time.
 */
async function buildPathMap(bridge: AgentBridge): Promise<Map<string, SessionInfo>> {
	const sessions = await bridge.listSessions({});
	const map = new Map<string, SessionInfo>();
	for (const s of sessions) {
		if (s.path) {
			map.set(s.path, { id: s.id, title: s.title ?? undefined, cwd: s.cwd ?? "" });
		}
	}
	return map;
}

/**
 * For a nested transcript (subagent/advisor), derive the parent session path.
 *
 * Layout:
 *   main:     <sessionsDir>/<project>/<sessionId>.jsonl   (2 segments)
 *   nested:   <sessionsDir>/<project>/<sessionId>/<subId>.jsonl  (3 segments)
 *
 * Parent of a nested path = <dirname of dirname>/<basename of dirname>.jsonl
 */
export function resolveParentSessionPath(sessionFile: string): string {
	const dir = path.dirname(sessionFile);
	return path.join(path.dirname(dir), path.basename(dir) + ".jsonl");
}

/**
 * Resolve a `messages.session_file` path to a Deck {id, title, cwd} triple
 * plus the agent type label for the file.
 *
 * Walks ancestor paths (each level up tries `<dir>.jsonl`) to handle
 * arbitrarily nested transcripts: subagents, advisors inside subagents,
 * advisors at any depth, etc. The first ancestor path found in the map wins.
 *
 * Returns null if no ancestor path is in the map (e.g. session was deleted
 * from the Deck DB after being synced into omp-stats).
 */
export function resolveDeckSession(
	sessionFile: string,
	agentTypeFromDb: string,
	pathMap: Map<string, SessionInfo>,
): { info: SessionInfo; agentType: string } | null {
	// Direct match (main session)
	const direct = pathMap.get(sessionFile);
	if (direct) return { info: direct, agentType: agentTypeFromDb };

	// Walk up ancestor directories, trying <ancestorDir>.jsonl at each level,
	// until we hit the root or run out of candidates.
	let current = sessionFile;
	for (let i = 0; i < 10; i++) {
		const parent = resolveParentSessionPath(current);
		if (parent === current) break; // no progress (hit filesystem root)
		const info = pathMap.get(parent);
		if (info) return { info, agentType: agentTypeFromDb };
		current = parent;
	}

	return null;
}

// ---------------------------------------------------------------------------
// WHERE clause builder + cutoff helper
// ---------------------------------------------------------------------------

interface WhereClause {
	sql: string;
	params: (string | number)[];
}

interface WhereOpts {
	cutoff: number | null;
	folder?: string;
	model?: string;
	agentType?: string;
}

function buildWhere(opts: WhereOpts): WhereClause {
	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (opts.cutoff !== null) {
		conditions.push("timestamp >= ?");
		params.push(opts.cutoff);
	}
	if (opts.folder) {
		conditions.push("folder = ?");
		params.push(opts.folder);
	}
	if (opts.model) {
		conditions.push("model = ?");
		params.push(opts.model);
	}
	if (opts.agentType) {
		conditions.push("agent_type = ?");
		params.push(opts.agentType);
	}

	return {
		sql: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
		params,
	};
}

const RANGE_HOURS: Record<string, number | null> = {
	"1h": 1,
	"24h": 24,
	"7d": 24 * 7,
	"30d": 24 * 30,
	"90d": 24 * 90,
	all: null,
};

/**
 * Convert an omp-stats TimeRange string to a Unix-ms cutoff timestamp, or
 * null for "all time".  Unknown strings fall back to the 24-hour default.
 */
export function computeCutoff(range: string): number | null {
	if (!(range in RANGE_HOURS)) return Date.now() - 24 * 60 * 60 * 1000;
	const hours = RANGE_HOURS[range];
	if (hours === null) return null;
	return Date.now() - (hours ?? 24) * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Main aggregation function
// ---------------------------------------------------------------------------

export interface AggregatedStatsOpts {
	/** omp-stats range string: 1h | 24h | 7d | 30d | 90d | all. Default: "7d". */
	range?: string;
	/** Filter to a specific workspace (maps to `messages.folder`). */
	cwd?: string;
	/** Filter to a specific model name (maps to `messages.model`). */
	model?: string;
	/** Filter to a specific agent type: main | subagent | advisor. */
	agentType?: string;
}

const SESSION_FILE_LIMIT = 500;
const SESSION_LINKS_PER_MODEL = 20;

export async function getAggregatedStats(
	bridge: AgentBridge,
	opts: AggregatedStatsOpts = {},
): Promise<AggregatedStatsResponse> {
	const { range = "7d", cwd: folder, model, agentType } = opts;

	ensureBackgroundSync();

	// Ensure initDb() has run inside omp-stats (creates schema + runs migrations).
	// getDashboardStats is the lightest exported function that guarantees this.
	// We discard its result; our own queries drive the response.
	await getDashboardStats(range);

	const syncInProgress = isSyncInProgress();
	const dbPath = getStatsDbPath();

	let db: Database;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch {
		// DB file doesn't exist yet (no sync has completed) — return empty.
		return { range: range as OmpStatsRange, source: "sessions", syncInProgress, total: { costUsd: 0, totalTokens: 0, requests: 0 }, byModel: [], byWorkspace: [], byAgentType: [] };
	}

	try {
		const cutoff = computeCutoff(range);

		// byModel query: filter by (cutoff, folder, agentType) — not by model,
		// since we GROUP BY model.
		const modelWhere = buildWhere({ cutoff, folder, agentType });

		// byWorkspace query: filter by (cutoff, model, agentType) — not by
		// folder, since we GROUP BY folder.
		const wsWhere = buildWhere({ cutoff, model, agentType });

		// Total: all four filters applied.
		const totalWhere = buildWhere({ cutoff, folder, model, agentType });

		// byAgentType: all filters applied, GROUP BY agent_type.
		const agentTypeWhere = buildWhere({ cutoff, folder, model });

		// Run all aggregate queries.
		const totalRow = db
			.prepare(
				`SELECT SUM(cost_total) as cost_usd, SUM(total_tokens) as total_tokens, COUNT(*) as requests
				 FROM messages ${totalWhere.sql}`,
			)
			.get(...totalWhere.params) as { cost_usd: number | null; total_tokens: number | null; requests: number | null } | undefined;

		const modelRows = db
			.prepare(
				`SELECT model, provider,
				        SUM(cost_total) as cost_usd,
				        SUM(total_tokens) as total_tokens,
				        COUNT(*) as requests
				 FROM messages ${modelWhere.sql}
				 GROUP BY model, provider
				 ORDER BY cost_usd DESC`,
			)
			.all(...modelWhere.params) as Array<{
			model: string;
			provider: string;
			cost_usd: number | null;
			total_tokens: number | null;
			requests: number | null;
		}>;

		const wsRows = db
			.prepare(
				`SELECT folder,
				        SUM(cost_total) as cost_usd,
				        SUM(total_tokens) as total_tokens,
				        COUNT(*) as requests
				 FROM messages ${wsWhere.sql}
				 GROUP BY folder
				 ORDER BY cost_usd DESC`,
			)
			.all(...wsWhere.params) as Array<{
			folder: string;
			cost_usd: number | null;
			total_tokens: number | null;
			requests: number | null;
		}>;

		const agentTypeRows = db
			.prepare(
				`SELECT agent_type,
				        SUM(cost_total) as cost_usd,
				        SUM(total_tokens) as total_tokens,
				        COUNT(*) as requests
				 FROM messages ${agentTypeWhere.sql}
				 GROUP BY agent_type
				 ORDER BY cost_usd DESC`,
			)
			.all(...agentTypeWhere.params) as Array<{
			agent_type: string;
			cost_usd: number | null;
			total_tokens: number | null;
			requests: number | null;
		}>;

		// Fetch distinct (model, provider, session_file, agent_type) tuples for
		// drill-down link resolution — capped to avoid unbounded memory use.
		const sessionFileRows = db
			.prepare(
				`SELECT DISTINCT model, provider, session_file, agent_type
				 FROM messages ${modelWhere.sql}
				 ORDER BY timestamp DESC
				 LIMIT ${SESSION_FILE_LIMIT}`,
			)
			.all(...modelWhere.params) as Array<{
			model: string;
			provider: string;
			session_file: string;
			agent_type: string;
		}>;

		// Build path → SessionInfo map from bridge (no raw paths to client).
		const pathMap = await buildPathMap(bridge);

		// Group resolved session links by (model, provider).
		const sessionLinksByModel = new Map<string, SessionDrillDownLink[]>();
		for (const row of sessionFileRows) {
			const key = `${row.model}::${row.provider}`;
			const existing = sessionLinksByModel.get(key) ?? [];
			if (existing.length >= SESSION_LINKS_PER_MODEL) continue;

			const resolved = resolveDeckSession(row.session_file, row.agent_type, pathMap);
			if (!resolved) continue;

			// Deduplicate by session ID (multiple nested files → same parent).
			if (existing.some((l) => l.sessionId === resolved.info.id)) continue;

			existing.push({
				sessionId: resolved.info.id,
				title: resolved.info.title,
				cwd: resolved.info.cwd,
				agentType: resolved.agentType as "main" | "subagent" | "advisor",
			});
			sessionLinksByModel.set(key, existing);
		}

		return {
			range: range as OmpStatsRange,
			source: "sessions",
			syncInProgress,
			total: {
				costUsd: totalRow?.cost_usd ?? 0,
				totalTokens: totalRow?.total_tokens ?? 0,
				requests: totalRow?.requests ?? 0,
			},
			byModel: modelRows.map((row) => ({
				model: row.model,
				provider: row.provider,
				costUsd: row.cost_usd ?? 0,
				totalTokens: row.total_tokens ?? 0,
				requests: row.requests ?? 0,
				sessionLinks: sessionLinksByModel.get(`${row.model}::${row.provider}`) ?? [],
			})),
			byWorkspace: wsRows.map((row) => ({
				cwd: row.folder,
				label: deriveLabel(row.folder),
				costUsd: row.cost_usd ?? 0,
				totalTokens: row.total_tokens ?? 0,
				requests: row.requests ?? 0,
			})),
			byAgentType: agentTypeRows.map((row) => ({
				agentType: row.agent_type as "main" | "subagent" | "advisor",
				costUsd: row.cost_usd ?? 0,
				totalTokens: row.total_tokens ?? 0,
				requests: row.requests ?? 0,
			})),
		};
	} finally {
		db.close();
	}
}

