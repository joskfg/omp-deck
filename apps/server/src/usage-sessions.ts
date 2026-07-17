/**
 * Per-session token/cost usage — `GET /api/usage/sessions`. Needed by the
 * cost-estimation task later in the Auto Work chain.
 *
 * Session discovery reuses `AgentBridge.listSessions` (the same call
 * `GET /api/sessions` uses) rather than re-walking `~/.omp/agent/sessions`
 * ourselves. Each session's `.jsonl` transcript is then read directly:
 * `SessionSummary` carries message counts but not token/cost totals, and
 * there's no existing aggregation utility for that — so this is the one new
 * piece of parsing, kept intentionally minimal (line-by-line JSON.parse,
 * summing the `usage` field the SDK already writes on every assistant
 * message; see a sample record shape in the PR description).
 *
 * Provider extraction: the SDK writes a `model_change` entry early in the
 * transcript with a `model` string of the form `"provider/modelId"`. As a
 * fallback the `provider` field on the first assistant message is used.
 * Both are absent in very old transcripts — the field is then omitted.
 */

import type { AgentBridge } from "./bridge/types.ts";
import type { SessionUsageSummary } from "@omp-deck/protocol";
import { deriveLabel } from "./workspace-label.ts";
import { logger } from "./log.ts";

const log = logger("usage-sessions");

interface AssistantUsage {
	totalTokens?: number;
	cost?: { total?: number };
}

interface TranscriptLine {
	type?: string;
	/** model_change: "provider/modelId" string */
	model?: string;
	message?: {
		role?: string;
		usage?: AssistantUsage;
		/** Provider field present on some assistant messages (e.g. "openai-codex"). */
		provider?: string;
	};
}

/**
 * Aggregates token/cost totals and extracts the provider from one transcript.
 * Returns all three in a single pass to avoid re-reading the file.
 */
async function aggregateTranscript(
	filePath: string,
): Promise<{ totalTokens: number; costUsd: number; provider: string | undefined }> {
	let totalTokens = 0;
	let costUsd = 0;
	let provider: string | undefined;
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		log.warn(`could not read transcript ${filePath}`, err);
		return { totalTokens, costUsd, provider };
	}
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let parsed: TranscriptLine;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // tolerate a partially-flushed last line
		}
		// Extract provider from first model_change entry: "provider/modelId"
		if (provider === undefined && parsed.type === "model_change" && typeof parsed.model === "string") {
			const slash = parsed.model.indexOf("/");
			if (slash > 0) provider = parsed.model.slice(0, slash);
		}
		if (parsed.type !== "message" || parsed.message?.role !== "assistant") continue;
		// Fallback: provider field on assistant message
		if (provider === undefined && typeof parsed.message?.provider === "string") {
			provider = parsed.message.provider;
		}
		const usage = parsed.message?.usage;
		if (!usage) continue;
		if (typeof usage.totalTokens === "number") totalTokens += usage.totalTokens;
		if (typeof usage.cost?.total === "number") costUsd += usage.cost.total;
	}
	return { totalTokens, costUsd, provider };
}

/**
 * Lists the `limit` most-recently-updated sessions across all workspaces with
 * their aggregated token/cost usage, account label, and provider.
 */
export async function listSessionUsage(bridge: AgentBridge, limit: number): Promise<SessionUsageSummary[]> {
	const sessions = await bridge.listSessions({});
	const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
	return Promise.all(
		sorted.map(async (s) => {
			const { totalTokens, costUsd, provider } = await aggregateTranscript(s.path);
			return {
				id: s.id,
				path: s.path,
				cwd: s.cwd,
				accountLabel: deriveLabel(s.cwd),
				title: s.title,
				updatedAt: s.updatedAt,
				totalTokens,
				costUsd,
				messageCount: s.messageCount,
				...(provider !== undefined ? { provider } : {}),
			};
		}),
	);
}
