import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { HandoffMsg, HandoffOriginMsg } from "@/lib/types";
import { Markdown } from "@/lib/markdown";
import { cn, formatTimestamp } from "@/lib/utils";

function shortId(id: string): string {
	return id.length <= 8 ? id : id.slice(0, 6);
}

/**
 * Live transition marker (T-32) — rendered at the exact point in the
 * transcript where the SDK's auto-handoff compaction swapped this session
 * onto a new file+id. The tab itself never navigates away: the same live
 * handle keeps streaming into this same view, so this is purely
 * informational (why + when + the new identity), not a dead end.
 */
export function HandoffLine({ msg }: { msg: HandoffMsg }) {
	return (
		<div className="border-l-2 border-accent pl-2 py-1">
			<div className="font-mono text-2xs uppercase tracking-meta text-accent">
				context handoff
				<span className="text-ink-3 normal-case tracking-normal"> · {msg.reason || "context limit reached"}</span>
			</div>
			<div className="mt-0.5 text-[12px] text-ink-3">
				Continuing as session <span className="font-mono text-ink-2">{shortId(msg.newSessionId)}</span> — you're
				still looking at it, this tab keeps streaming.
				<span className="ml-1.5 text-ink-4">{formatTimestamp(new Date(msg.timestamp).toISOString())}</span>
			</div>
		</div>
	);
}

/**
 * Persisted marker (T-32) — the transferred summary a session began with
 * because it continues an earlier one via auto-handoff. This is the first
 * message of a handoff-continuation session; expand to read the full
 * transferred context. Pairs with the "← Origin" breadcrumb in ChatHeader
 * (built from `session.parentSessionPath`) for the actual navigation.
 */
export function HandoffOrigin({ msg }: { msg: HandoffOriginMsg }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="border-l-2 border-accent">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-1.5 pl-2 py-0.5 text-left font-mono text-2xs uppercase tracking-meta text-accent hover:text-accent/80"
			>
				<ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
				<span>continued via context handoff</span>
				<span className="text-ink-3 normal-case tracking-normal">
					· {formatTimestamp(new Date(msg.timestamp).toISOString())}
				</span>
			</button>
			{open ? (
				<div className="pl-2 pt-1 pb-2 text-[13px] text-ink-2">
					<Markdown>{msg.document || "(no transferred summary)"}</Markdown>
				</div>
			) : null}
		</div>
	);
}
