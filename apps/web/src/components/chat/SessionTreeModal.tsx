import { useEffect, useState } from "react";
import { GitBranch, X } from "lucide-react";
import type { SessionTreeEntryWire, SessionTreeNodeWire, SessionTreeResponse } from "@omp-deck/protocol";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn, formatTimestamp } from "@/lib/utils";

interface Props {
	open: boolean;
	sessionId: string;
	onClose: () => void;
}

/**
 * Collects all user_message entries from the tree in depth-first order,
 * traversing every branch regardless of the parent node's kind so that
 * user messages nested under assistant or tool nodes are never lost.
 */
function flattenUserMessages(nodes: SessionTreeNodeWire[]): SessionTreeEntryWire[] {
	const result: SessionTreeEntryWire[] = [];
	for (const node of nodes) {
		if (node.entry.kind === "user_message") {
			result.push(node.entry);
		}
		result.push(...flattenUserMessages(node.children));
	}
	return result;
}

/**
 * Timeline of a session's user-authored messages (T-31, T-127). Read-only
 * browsing plus "Bifurcar" on any entry, which creates a brand-new session
 * rooted at that point via `POST /sessions/:id/branch` — the source session's
 * history is never touched, so it stays safe to return to from the Sidebar or
 * the header's Switch dropdown.
 *
 * Only user_message entries are shown; agent and tool turns are excluded.
 * All rows render at the same horizontal level — no depth-based indentation.
 */
export function SessionTreeModal({ open, sessionId, onClose }: Props) {
	const branchSession = useStore((s) => s.branchSession);
	const createSession = useStore((s) => s.createSession);
	const [tree, setTree] = useState<SessionTreeResponse | undefined>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [busyEntryId, setBusyEntryId] = useState<string | undefined>();

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		setError(undefined);
		api
			.sessionTree(sessionId)
			.then((res) => {
				if (!cancelled) setTree(res);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, sessionId]);

	async function fork(entryId: string): Promise<void> {
		setBusyEntryId(entryId);
		setError(undefined);
		try {
			await branchSession(sessionId, entryId);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyEntryId(undefined);
		}
	}

	async function goToParent(): Promise<void> {
		if (!tree?.parentSessionPath) return;
		try {
			await createSession({ cwd: tree.cwd, resumeFromPath: tree.parentSessionPath });
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	const userMessages = tree ? flattenUserMessages(tree.roots) : [];

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-2xl">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<GitBranch className="h-4 w-4 text-ink-3" />
				<div className="meta">Árbol de sesión</div>
				<div className="flex-1" />
				<Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
					<X className="h-4 w-4" />
				</Button>
			</div>

			{tree?.parentSessionPath ? (
				<div className="flex items-center gap-2 border-b border-line bg-paper-2/60 px-3 py-2 font-mono text-2xs text-ink-3">
					<span>Esta sesión es una bifurcación de otra.</span>
					<button type="button" className="text-accent hover:underline" onClick={() => void goToParent()}>
						Ir a la sesión origen
					</button>
				</div>
			) : null}

			{error ? (
				<div className="mx-3 my-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}

			<div className="max-h-[65vh] overflow-y-auto px-2 py-2">
				{loading ? (
					<div className="px-3 py-6 text-center text-sm text-ink-3">Cargando árbol...</div>
				) : null}
				{!loading && tree && userMessages.length === 0 ? (
					<div className="px-3 py-6 text-center text-sm text-ink-3">
						{tree.roots.length === 0 ? "Sesión vacía." : "Sin mensajes de usuario."}
					</div>
				) : null}
				{userMessages.map((entry) => (
					<FlatRow
						key={entry.id}
						entry={entry}
						isActive={entry.id === tree?.leafId}
						busy={busyEntryId === entry.id}
						onFork={fork}
					/>
				))}
			</div>
		</Modal>
	);
}

function FlatRow({
	entry,
	isActive,
	busy,
	onFork,
}: {
	entry: SessionTreeEntryWire;
	isActive: boolean;
	busy: boolean;
	onFork: (entryId: string) => void | Promise<void>;
}) {
	return (
		<div
			className={cn(
				"group flex items-start gap-2 rounded-md px-2 py-1.5",
				isActive ? "bg-accent-soft/40" : "hover:bg-paper-3/60",
			)}
		>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5">
					{isActive ? (
						<span className="rounded border border-accent/40 bg-accent/10 px-1 py-px font-mono text-2xs uppercase tracking-meta text-accent">
							activa
						</span>
					) : null}
					<span className="font-mono text-2xs text-ink-4">{formatTimestamp(entry.timestamp)}</span>
				</div>
				<div className="mt-0.5 truncate text-sm text-ink">{entry.preview}</div>
			</div>
			<button
				type="button"
				disabled={busy}
				onClick={() => void onFork(entry.id)}
				className="shrink-0 rounded-md border border-line px-2 py-1 font-mono text-2xs uppercase tracking-meta text-ink-3 opacity-0 transition-opacity hover:border-accent/40 hover:text-accent group-hover:opacity-100 disabled:opacity-50"
				title="Crea una sesión nueva a partir de este punto — no modifica esta sesión"
			>
				{busy ? "..." : "Bifurcar"}
			</button>
		</div>
	);
}
