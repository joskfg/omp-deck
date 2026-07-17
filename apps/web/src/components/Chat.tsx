import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useStore, selectActiveSession } from "@/lib/store";
import { ChatHeader } from "./chat/ChatHeader";
import { SessionPicker } from "./chat/SessionPicker";
import { TodoPanel } from "./todos/TodoPanel";
import { UserMessage } from "./messages/UserMessage";
import { AssistantMessage } from "./messages/AssistantMessage";
import { Notice } from "./messages/Notice";
import { CompactionLine } from "./messages/CompactionLine";
import { TtsrLine } from "./messages/TtsrLine";
import { IrcLine } from "./messages/IrcLine";
import { QueuedMessage } from "./messages/QueuedMessage";
import { PlanApproval } from "./messages/PlanApproval";
import { HandoffLine, HandoffOrigin } from "./messages/HandoffLine";

/**
 * Scroll position captured immediately before requesting an older history
 * page, so the viewport can be re-anchored after the page is prepended
 * (otherwise the browser keeps `scrollTop` and the content jumps down by
 * the height of the inserted messages).
 */
interface PrependAnchor {
	sessionId: string;
	firstId: string;
	scrollHeight: number;
	scrollTop: number;
}

export function Chat() {
	const session = useStore(selectActiveSession);
	const loadOlderMessages = useStore((s) => s.loadOlderMessages);
	const trimConversation = useStore((s) => s.trimConversation);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickyRef = useRef(true);
	const anchorRef = useRef<PrependAnchor | null>(null);
	const [showScrollButton, setShowScrollButton] = useState(false);

	const messages = session?.messages ?? [];
	const toolCalls = session?.toolCalls ?? {};
	const queuedPrompts = session?.queuedPrompts ?? [];
	const todoPanelOpen = useStore((s) => s.todoPanelOpen);
	const todoPhases = session?.todoPhases ?? [];
	const sessionId = session?.sessionId;
	const hasOlder = (session?.historyStartIndex ?? 0) > 0;

	useEffect(() => {
		stickyRef.current = true;
		setShowScrollButton(false);
	}, [sessionId]);

	// Re-anchor the viewport after an older page was prepended: keep the
	// message the user was looking at in place by offsetting scrollTop with
	// the height the new content added. Must run before paint (layout effect)
	// to avoid a visible flash at the wrong position.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		const anchor = anchorRef.current;
		if (!el || !anchor) return;
		if (anchor.sessionId !== sessionId) {
			anchorRef.current = null;
			return;
		}
		const firstId = messages[0]?.id;
		if (firstId && firstId !== anchor.firstId) {
			el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
			anchorRef.current = null;
		}
	}, [messages, sessionId]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (stickyRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages, toolCalls, queuedPrompts]);

	function handleScroll(): void {
		const el = scrollRef.current;
		if (!el || !sessionId) return;
		const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		const sticky = fromBottom < 100;
		stickyRef.current = sticky;
		setShowScrollButton(!sticky);
		if (sticky) {
			// Back at the tail — shrink an over-grown window so a long scroll
			// session doesn't keep thousands of DOM nodes alive. No-op below
			// the threshold.
			trimConversation(sessionId);
			return;
		}
		// Approaching the top (within 10% of the scrollable range, with a
		// floor so short viewports still prefetch early) — page in older
		// history before the user hits the edge, so the conversation feels
		// fully loaded.
		if (hasOlder && !session?.historyLoading) {
			const range = el.scrollHeight - el.clientHeight;
			const threshold = Math.max(range * 0.1, 600);
			if (el.scrollTop <= threshold) {
				anchorRef.current = {
					sessionId,
					firstId: messages[0]?.id ?? "",
					scrollHeight: el.scrollHeight,
					scrollTop: el.scrollTop,
				};
				void loadOlderMessages(sessionId);
			}
		}
	}

	function scrollToBottom(): void {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
		stickyRef.current = true;
		setShowScrollButton(false);
	}

	// No active session — show the picker as the main pane instead of a
	// dead-end "go to sidebar" message.
	if (!session) {
		return <SessionPicker />;
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<ChatHeader />
			{todoPanelOpen && todoPhases.length > 0 ? (
				<div className="max-h-[40vh] shrink-0 overflow-y-auto">
					<TodoPanel phases={todoPhases} />
				</div>
			) : null}
			<div className="relative min-h-0 flex-1">
				<div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
					<div className="mx-auto flex max-w-[760px] flex-col gap-7 px-6 py-10">
						{session.historyLoading ? (
							<div className="text-center font-mono text-2xs uppercase tracking-meta text-ink-3">
								Loading earlier messages…
							</div>
						) : null}
						{messages.length === 0 ? (
							<div className="text-center font-mono text-2xs uppercase tracking-meta text-ink-3">
								Empty session — send a prompt below.
							</div>
						) : null}

						{messages.map((m) => {
							switch (m.role) {
								case "user":
									return <UserMessage key={m.id} msg={m} />;
								case "assistant":
									return <AssistantMessage key={m.id} msg={m} toolCalls={toolCalls} />;
								case "notice":
									return <Notice key={m.id} msg={m} />;
								case "compaction":
									return <CompactionLine key={m.id} msg={m} />;
								case "ttsr":
									return <TtsrLine key={m.id} msg={m} />;
								case "irc":
									return <IrcLine key={m.id} msg={m} />;
								case "handoff":
									return <HandoffLine key={m.id} msg={m} />;
								case "handoff_origin":
									return <HandoffOrigin key={m.id} msg={m} />;
								default:
									return null;
							}
						})}

						{queuedPrompts.map((q) => (
							<QueuedMessage key={q.id} msg={q} />
						))}
						{session.pendingPlanApproval || session.pendingPlanExecution ? (
							<PlanApproval session={session} />
						) : null}
					</div>
				</div>
				{showScrollButton ? (
					<button
						type="button"
						onClick={scrollToBottom}
						aria-label="Scroll to bottom"
						className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-paper-2 p-2 text-ink-2 shadow-[0_8px_24px_-8px_rgba(26,24,20,0.25)] transition hover:bg-paper hover:text-ink"
					>
						<ArrowDown className="h-4 w-4" />
					</button>
				) : null}
			</div>
		</div>
	);
}
