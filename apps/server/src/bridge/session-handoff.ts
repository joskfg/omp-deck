/**
 * T-32: best-effort, read-only lookup of a session's auto-handoff successor.
 *
 * The SDK's context-handoff compaction strategy (`compaction.strategy =
 * "handoff"`) generates a summary and starts a brand-new session file whose
 * header carries `parentSession = <old file path>` (`SessionInfo.
 * parentSessionPath` once listed) — the SAME field a manual fork
 * (`SessionManager.createBranchedSession`) also sets. Disk alone can't tell
 * the two apart from the parent's side by the header alone, so this module
 * opens each candidate child and checks two things about its FIRST entry:
 *
 * 1. It's the SDK's own `custom_message` / `customType: "handoff"` marker
 *    (written only by `AgentSession.handoff()`, always as entry index 0 of
 *    the fresh file — a new session starts with zero entries and the
 *    marker is the very first thing appended to it, never by a fork).
 * 2. Its OWN `timestamp` field lands within `MARKER_FRESHNESS_MS` of the
 *    candidate file's `created` timestamp.
 *
 * (2) is required because `createBranchedSession` copies entries VERBATIM
 * — including their original `timestamp`s — from root to leaf. Forking any
 * point in a handoff-continuation session's later history therefore
 * produces a new file whose entry 0 IS that same handoff marker (inherited
 * from the branch it copied), but stamped with the ORIGINAL handoff's
 * (long-past) timestamp rather than the fork's own `created` time — so the
 * proximity check rejects it while a genuine handoff (marker appended at
 * essentially the same instant the file was created) always passes.
 *
 * Deliberately disk-only (no deck-side DB): the source file's on-disk
 * `parentSession` link is authoritative and survives server restarts or a
 * handoff that happened outside this deck instance entirely — see
 * `bridge/in-process.ts`'s `session_handoff` synthetic-event doc comment for
 * the complementary live-transition path (reason string only available
 * there, never persisted by the SDK).
 */
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { SessionHandoffSuccessor } from "@omp-deck/protocol";

const HANDOFF_MARKER_CUSTOM_TYPE = "handoff";

/** Generous tolerance for the marker-vs-`created` proximity check — the
 *  real gap is sub-second (synchronous `newSession()` + `appendCustom-
 *  MessageEntry()` calls), this just guards against clock/rounding noise. */
const MARKER_FRESHNESS_MS = 30_000;

/**
 * Given the path of a persisted (or still-live) session file, find the
 * persisted sibling — if any — that continues it via an automatic context
 * handoff. Returns `undefined` when none is found; never throws (a
 * candidate that fails to open is skipped, not fatal to the lookup).
 */
export async function findHandoffSuccessor(
	cwd: string,
	sessionFile: string,
	/** Test-only override — production callers rely on the SDK's default
	 *  per-cwd session directory, same as every other `SessionManager.list`
	 *  caller in this codebase. */
	sessionDir?: string,
): Promise<SessionHandoffSuccessor | undefined> {
	if (!cwd || !sessionFile) return undefined;
	let candidates: Array<{ path: string; parentSessionPath?: string; created: Date }>;
	try {
		const list = await SessionManager.list(cwd, sessionDir);
		candidates = list
			.filter((info) => info.parentSessionPath === sessionFile)
			.sort((a, b) => a.created.getTime() - b.created.getTime());
	} catch {
		return undefined;
	}
	for (const candidate of candidates) {
		try {
			const manager = await SessionManager.open(candidate.path, sessionDir);
			const first = manager.getBranch()[0];
			if (!first || first.type !== "custom_message" || first.customType !== HANDOFF_MARKER_CUSTOM_TYPE) continue;
			const markerAt = new Date(first.timestamp).getTime();
			if (!Number.isFinite(markerAt) || Math.abs(markerAt - candidate.created.getTime()) > MARKER_FRESHNESS_MS) {
				continue;
			}
			return {
				sessionId: manager.getSessionId(),
				sessionFile: candidate.path,
				createdAt: candidate.created.toISOString(),
			};
		} catch {
			// Unreadable/corrupt candidate — skip, keep looking.
		}
	}
	return undefined;
}
