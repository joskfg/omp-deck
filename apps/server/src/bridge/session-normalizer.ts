/**
 * Pure normalisation helpers for SessionManager list records.
 *
 * This module uses only `import type` so it carries zero SDK runtime
 * dependencies and can be tested without the full pi-coding-agent graph.
 */
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent";
import type { SessionSummary } from "@omp-deck/protocol";

/**
 * Superset of SessionInfo that covers legacy/unknown record shapes that
 * may arrive from older SDK versions or future SDK changes.  Every extra
 * field is `unknown` so access compiles but must be coerced before use.
 */
export type RawSessionRecord = SessionInfo & {
	sessionId?: unknown;
	file?: unknown;
	sessionFile?: unknown;
	count?: unknown;
	timestamp?: unknown;
	createdAt?: unknown;
	modifiedAt?: unknown;
	updatedAt?: unknown;
	header?: { id?: unknown; cwd?: unknown; title?: unknown; timestamp?: unknown };
};

/** Coerce a Date, ISO string, or any unknown value to an ISO-8601 string.
 * Returns "" when the value is absent or produces an invalid date. */
export function toIso(val: unknown): string {
	if (val instanceof Date) return Number.isNaN(val.getTime()) ? "" : val.toISOString();
	if (typeof val === "string") return val;
	return "";
}

/** Compute elapsed ms between two ISO timestamps. Returns undefined when either
 * is invalid or updatedAt is not after createdAt (stale / corrupted records). */
export function computeDurationMs(createdAt: string, updatedAt: string): number | undefined {
	if (!createdAt || !updatedAt) return undefined;
	const c = new Date(createdAt).getTime();
	const u = new Date(updatedAt).getTime();
	if (Number.isNaN(c) || Number.isNaN(u)) return undefined;
	const diff = u - c;
	return diff > 0 ? diff : undefined;
}

/** Normalize a SessionManager.list / listAll record into our SessionSummary. */
export function summarizeSession(raw: RawSessionRecord): SessionSummary {
	const id = String(raw.id ?? raw.sessionId ?? raw.header?.id ?? "");
	const filePath = String(raw.path ?? raw.file ?? raw.sessionFile ?? "");
	const cwd = String(raw.cwd ?? raw.header?.cwd ?? "");
	const title =
		typeof raw.title === "string"
			? raw.title
			: typeof raw.header?.title === "string"
				? raw.header.title
				: undefined;
	// SDK's SessionInfo uses `created: Date` and `modified: Date`.
	// Legacy/unknown shapes may carry string fields, keep those as fallbacks.
	const createdAt =
		toIso(raw.created) || toIso(raw.timestamp) || toIso(raw.createdAt) || toIso(raw.header?.timestamp);
	const updatedAt =
		toIso(raw.modified) || toIso(raw.modifiedAt) || toIso(raw.updatedAt) || createdAt;
	const messageCount = Number(raw.messageCount ?? raw.count ?? 0);
	const durationMs = computeDurationMs(createdAt, updatedAt);
	const parentPath = typeof raw.parentSessionPath === "string" && raw.parentSessionPath ? raw.parentSessionPath : undefined;
	return {
		id,
		path: filePath,
		cwd,
		title,
		createdAt,
		updatedAt,
		messageCount,
		durationMs,
		...(parentPath ? { parentPath } : {}),
	};
}
