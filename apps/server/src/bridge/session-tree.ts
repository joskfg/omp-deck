/**
 * T-31: read-only session-tree projection and non-destructive branch/fork
 * creation, built directly on the SDK's `SessionManager` — no live
 * `AgentSession`/model registry required for either operation.
 *
 * Both entry points open an independent `SessionManager` over the source
 * `.jsonl` file and never write back to it: `readSessionTree` never writes
 * at all, and `forkSessionFile`'s `createBranchedSession` call re-points the
 * *new* manager instance at a freshly minted file path before it writes
 * anything to disk. That makes both safe to call even while the source
 * session is live in another process (SDK appends are synchronous OS
 * writes, so a concurrent read always sees the latest persisted state).
 */
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent";
import type {
	SessionTreeEntryKind,
	SessionTreeEntryWire,
	SessionTreeNodeWire,
	SessionTreeResponse,
} from "@omp-deck/protocol";

/** Preview text is truncated to keep the tree payload light — the existing
 *  history/transcript views remain the source of full message content. */
const PREVIEW_MAX_CHARS = 240;

function truncate(text: string, max = PREVIEW_MAX_CHARS): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Extracts displayable text from an SDK message `content` field — a plain
 *  string, or an array of blocks (text / tool-call / other). Tolerant of
 *  unknown block shapes since the SDK's message union evolves independently. */
function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map((part) => {
			const block = asRecord(part);
			if (!block) return "";
			if (typeof block.text === "string") return block.text;
			if (block.type === "toolCall" && typeof block.name === "string") return `[tool: ${block.name}]`;
			return "";
		})
		.join("");
}

/** Best-effort {kind, preview} summary for one session entry. Falls back to
 *  a generic preview for entry types this deck version doesn't recognize
 *  yet, rather than throwing. */
function summarizeEntry(entry: SessionEntry): { kind: SessionTreeEntryKind; preview: string } {
	switch (entry.type) {
		case "message": {
			const message = asRecord(entry.message);
			const role = typeof message?.role === "string" ? message.role : "message";
			const text = truncate(textFromContent(message?.content));
			if (role === "user") return { kind: "user_message", preview: text || "(mensaje vacío)" };
			if (role === "assistant") return { kind: "assistant_message", preview: text || "(sin texto)" };
			if (role === "toolResult") return { kind: "tool_message", preview: text || "(resultado de herramienta)" };
			return { kind: "message", preview: text || role };
		}
		case "thinking_level_change":
			return { kind: "thinking_level_change", preview: `Thinking → ${entry.thinkingLevel ?? "off"}` };
		case "model_change":
			return { kind: "model_change", preview: `Modelo → ${entry.model}${entry.role ? ` (${entry.role})` : ""}` };
		case "service_tier_change":
			return { kind: "service_tier_change", preview: `Service tier → ${entry.serviceTier ?? "default"}` };
		case "compaction":
			return { kind: "compaction", preview: truncate(entry.shortSummary || entry.summary) };
		case "branch_summary":
			return { kind: "branch_summary", preview: truncate(entry.summary) };
		case "custom":
			return { kind: "custom", preview: entry.customType };
		case "custom_message":
			return { kind: "custom_message", preview: truncate(`${entry.customType}: ${textFromContent(entry.content)}`) };
		case "label":
			return { kind: "label", preview: entry.label ? `Label: ${entry.label}` : "Label eliminado" };
		case "title_change":
			return { kind: "title_change", preview: `Título → "${entry.title}"` };
		case "ttsr_injection":
			return { kind: "ttsr_injection", preview: `Reglas TTSR: ${entry.injectedRules.join(", ")}` };
		case "mcp_tool_selection":
			return { kind: "mcp_tool_selection", preview: `${entry.selectedToolNames.length} herramientas MCP seleccionadas` };
		case "session_init":
			return { kind: "session_init", preview: truncate(entry.task) };
		case "mode_change":
			return { kind: "mode_change", preview: `Modo → ${entry.mode}` };
		default: {
			// Forward-compat fallback for an SDK entry type this deck version
			// doesn't know yet — `entry` narrows to `never` here since the cases
			// above are exhaustive today, so read the raw shape via `asRecord`
			// instead of accessing `.type` directly.
			const raw = asRecord(entry);
			return { kind: "message", preview: typeof raw?.type === "string" ? raw.type : "unknown" };
		}
	}
}

function toWireEntry(entry: SessionEntry, label: string | undefined): SessionTreeEntryWire {
	const { kind, preview } = summarizeEntry(entry);
	return {
		id: entry.id,
		parentId: entry.parentId,
		kind,
		timestamp: entry.timestamp,
		preview,
		...(label ? { label } : {}),
		// T-35: carry the injected rule names so the deck can explain a TTSR
		// interruption against the current rule inventory, not just preview text.
		...(entry.type === "ttsr_injection" ? { injectedRules: entry.injectedRules } : {}),
	};
}

function toWireNode(node: SessionTreeNode): SessionTreeNodeWire {
	return {
		entry: toWireEntry(node.entry, node.label),
		children: node.children.map(toWireNode),
	};
}

/**
 * Read-only tree/timeline for a persisted session file. Safe to call even
 * while the session is live in another process — see module docs.
 */
export async function readSessionTree(sessionPath: string): Promise<SessionTreeResponse> {
	const manager = await SessionManager.open(sessionPath);
	const header = manager.getHeader();
	return {
		sessionId: manager.getSessionId(),
		sessionFile: sessionPath,
		cwd: manager.getCwd(),
		...(header?.parentSession ? { parentSessionPath: header.parentSession } : {}),
		leafId: manager.getLeafId(),
		roots: manager.getTree().map(toWireNode),
	};
}

/**
 * Fork a brand-new session file rooted at `entryId`'s root→leaf path from
 * `sessionPath`. Never mutates or rewrites `sessionPath` — see module docs.
 * Throws when `entryId` doesn't exist on `sessionPath`'s branch.
 */
export async function forkSessionFile(sessionPath: string, entryId: string): Promise<{ sessionFile: string; cwd: string }> {
	const manager = await SessionManager.open(sessionPath);
	const newSessionFile = manager.createBranchedSession(entryId);
	if (!newSessionFile) throw new Error("session is not persisted, cannot fork");
	return { sessionFile: newSessionFile, cwd: manager.getCwd() };
}
