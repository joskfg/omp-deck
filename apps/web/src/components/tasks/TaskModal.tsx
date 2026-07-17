import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Bot, CheckCircle2, Circle, FolderOpen, Link2, MessageSquarePlus, RotateCcw, Trash2, Wand2, X, Zap } from "lucide-react";
import type { Task, TaskDifficulty, TaskPriority, TaskState } from "@omp-deck/protocol";

import { MarkdownEdit } from "@/components/MarkdownEdit";
import { Modal } from "@/components/ui/Modal";
import { candidateDependencyTasks, resolveDependencyTasks, resolveDependentTasks } from "@/lib/task-dependencies";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DirBrowserModal } from "@/components/DirBrowserModal";

const PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4", "P5"];
const DIFFICULTIES: { value: TaskDifficulty; label: string }[] = [
	{ value: "easy", label: "easy" },
	{ value: "medium", label: "medium" },
	{ value: "hard", label: "hard" },
];

interface Props {
	task: Task | null;
	states: TaskState[];
	/** Full task list, used to resolve dependency titles/state (T-57). */
	allTasks: Task[];
	onClose: () => void;
	onSave: (patch: {
		title?: string;
		body?: string;
		stateId?: string;
		cwd?: string;
		priority?: TaskPriority;
		difficulty?: TaskDifficulty;
		dependsOn?: string[];
		autoWork?: boolean;
	}) => void;
	onDelete: () => void;
	onArchive: () => void;
	onOpenInChat: () => void;
	/** Same-flavor launch as `onOpenInChat` but with a short `T-<id>` reference
	 * draft instead of the full title+body (T-44) — the agent re-reads the
	 * task itself via `GET /api/tasks` instead of paying for the body twice. */
	onSendToAgent: () => void;
}

/**
 * Centered modal for full task detail / edit. Title is a large inline-editable
 * input; body uses MarkdownEdit (rendered by default, click to edit). The
 * action bar mirrors the inbox reader for consistency: state-change on the
 * left, archive / delete / Send-to-agent / Open-in-chat / close on the right.
 */
export function TaskModal({
	task,
	states,
	allTasks,
	onClose,
	onSave,
	onDelete,
	onArchive,
	onOpenInChat,
	onSendToAgent,
}: Props) {
	const open = task !== null;

	// Local mirror of editable fields so we can commit on blur without
	// thrashing the API on every keystroke.
	const [title, setTitle] = useState("");
	const [stateId, setStateId] = useState("");
	const [cwd, setCwd] = useState("");
	const [cwdBrowserOpen, setCwdBrowserOpen] = useState(false);

	useEffect(() => {
		if (!task) return;
		setTitle(task.title);
		setStateId(task.stateId);
		setCwd(task.cwd ?? "");
	}, [task]);
	// Rewrite state: null = idle, loading = in-flight, RewriteTaskResponse = preview pending
	const [rewrite, setRewrite] = useState<{ title: string; body: string } | "loading" | null>(null);
	const activeTaskIdRef = useRef<string | null>(task?.id ?? null);

	async function triggerRewrite(): Promise<void> {
		if (!task || rewrite === "loading") return;
		setRewrite("loading");
		try {
			const result = await api.rewriteTask(task.id);
			if (activeTaskIdRef.current === task.id) setRewrite(result);
		} catch (err) {
			if (activeTaskIdRef.current === task.id) {
				setRewrite(null);
				// Surface the error to the user as a dismissible note inline.
				setRewriteError(err instanceof Error ? err.message : String(err));
			}
		}
	}
	const [rewriteError, setRewriteError] = useState<string | null>(null);

	function acceptRewrite(): void {
		if (!task || !rewrite || rewrite === "loading") return;
		onSave({ title: rewrite.title, body: rewrite.body });
		setTitle(rewrite.title);
		setRewrite(null);
	}

	// Resolved-to-full-Task dependency lists for the picker (T-57); pure logic
	// lives in task-dependencies.ts so it has plain unit tests.
	const dependencyTasks = useMemo(
		() => (task ? resolveDependencyTasks(task, allTasks) : []),
		[task, allTasks],
	);
	const candidateTasks = useMemo(
		() => (task ? candidateDependencyTasks(task, allTasks) : []),
		[task, allTasks],
	);
	const dependentTasks = useMemo(
		() => (task ? resolveDependentTasks(task, allTasks) : []),
		[task, allTasks],
	);

	// Clear rewrite preview/error when a new task opens.
	useEffect(() => {
		activeTaskIdRef.current = task?.id ?? null;
		setRewrite(null);
		setRewriteError(null);
	}, [task?.id]);

	if (!task) return null;

	function commitTitle(): void {
		if (!task) return;
		if (title !== task.title) onSave({ title });
	}
	function commitState(next: string): void {
		setStateId(next);
		if (!task || next === task.stateId) return;
		onSave({ stateId: next });
	}
	function commitPriority(next: TaskPriority): void {
		if (!task || next === task.priority) return;
		onSave({ priority: next });
	}
	function commitDifficulty(next: TaskDifficulty): void {
		if (!task || next === task.difficulty) return;
		onSave({ difficulty: next });
	}
	function commitCwd(): void {
		if (!task) return;
		const next = cwd.trim() || undefined;
		if ((task.cwd ?? "") !== (next ?? "")) onSave({ cwd: next });
	}
	// Auto Work needs a repo to run in: block enabling the flag until the task
	// names a workspace. Mirrors the server-side invariant (autoWork ⇒ cwd).
	// Turning the flag OFF stays allowed for legacy cwd-less rows.
	const autoWorkToggleBlocked = task !== null && !task.autoWork && cwd.trim().length === 0;
	function addDependency(depId: string): void {
		if (!task || !depId || task.dependsOn.includes(depId)) return;
		onSave({ dependsOn: [...task.dependsOn, depId] });
	}
	function removeDependency(depId: string): void {
		if (!task) return;
		onSave({ dependsOn: task.dependsOn.filter((id) => id !== depId) });
	}

	const isArchived = Boolean(task.archivedAt);

	return (
		<>
		<Modal open={open} onClose={onClose} widthClass="max-w-3xl">
			{/* Single scrollable wrapper — only the action bar (sticky) stays visible at all
			    viewport heights; title, metadata, and body all scroll together so the body
			    is reachable even on short/split-screen windows (T-86). */}
			<div className="flex-1 min-h-0 overflow-y-auto">
				<header className="sticky top-0 z-10 bg-paper flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
					<span
						className="flex h-8 shrink-0 items-center rounded-md border border-line bg-paper-2 px-2.5 font-mono text-sm font-semibold uppercase tracking-meta text-ink-2"
						title={task.id}
					>
						T-{task.displayId}
					</span>
					<select
						value={stateId}
						onChange={(e) => commitState(e.target.value)}
						className="field h-8 px-2 font-mono text-2xs uppercase tracking-meta"
					>
						{states.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</select>
					<div
						className="h-2 w-2 rounded-full"
						style={{
							backgroundColor:
								states.find((s) => s.id === stateId)?.color ?? "var(--ink-3, #6e6a62)",
						}}
					/>
					<select
						value={task.priority}
						onChange={(e) => commitPriority(e.target.value as TaskPriority)}
						title="Priority — P0 highest, P5 lowest"
						className="field h-8 px-2 font-mono text-2xs uppercase tracking-meta"
					>
						{PRIORITIES.map((p) => (
							<option key={p} value={p}>
								{p}
							</option>
						))}
					</select>
					<select
						value={task.difficulty}
						onChange={(e) => commitDifficulty(e.target.value as TaskDifficulty)}
						title="Difficulty — affects auto-work agent selection"
						className="field h-8 px-2 font-mono text-2xs uppercase tracking-meta"
					>
						{DIFFICULTIES.map((d) => (
							<option key={d.value} value={d.value}>
								{d.label}
							</option>
						))}
					</select>
					<div className="ml-auto flex shrink-0 items-center gap-1">
						<IconAction
							label={isArchived ? "Unarchive" : "Archive"}
							icon={isArchived ? RotateCcw : Archive}
							onClick={onArchive}
						/>
						<IconAction label="Delete" icon={Trash2} tone="danger" onClick={onDelete} />
						<button
							type="button"
							onClick={() => void triggerRewrite()}
							disabled={rewrite === "loading"}
							className={cn(
								"btn-ghost h-8 shrink-0 gap-1.5 whitespace-nowrap px-2.5 text-sm",
								rewrite === "loading" && "opacity-60 cursor-wait",
							)}
							title="Rewrite this task with AI to improve clarity and completeness"
						>
							<Wand2 className="h-4 w-4 shrink-0" />
							<span>{rewrite === "loading" ? "Rewriting…" : "Rewrite"}</span>
						</button>
						<button
							type="button"
							onClick={onSendToAgent}
							className="btn-ghost h-8 shrink-0 gap-1.5 whitespace-nowrap px-2.5 text-sm"
							title="Assign a short T-N reference as the first prompt — the agent reads the full task itself"
						>
							<Bot className="h-4 w-4 shrink-0" />
							<span>Assign to agent</span>
						</button>
						<button
							type="button"
							onClick={onOpenInChat}
							className="btn-primary h-8 shrink-0 gap-1.5 whitespace-nowrap px-2.5 text-sm"
							title="Open this task as a new chat session"
						>
							<MessageSquarePlus className="h-4 w-4 shrink-0" />
							<span>Open in chat</span>
						</button>
						<IconAction label="Close" icon={X} onClick={onClose} />
					</div>
				</header>

				<div className="border-b border-line px-6 pt-5 pb-3">
					<input
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						onBlur={commitTitle}
						onKeyDown={(e) => {
							if (e.key === "Enter") (e.target as HTMLInputElement).blur();
						}}
						placeholder="Untitled task"
						className={cn(
							"w-full bg-transparent text-xl font-semibold text-ink placeholder:text-ink-4 focus:outline-none",
							isArchived && "text-ink-3 line-through",
						)}
					/>
					<div className="mt-1 grid grid-cols-[max-content_1fr_max-content_1fr] gap-x-4 gap-y-1 font-mono text-2xs text-ink-3">
						<span className="text-ink-4">created</span>
						<span>{new Date(task.createdAt).toLocaleString()}</span>
						<span className="text-ink-4">updated</span>
						<span>{new Date(task.updatedAt).toLocaleString()}</span>
						<span className="text-ink-4">cwd</span>
						<span className="col-span-3 flex items-center gap-1">
							<input
								value={cwd}
								onChange={(e) => setCwd(e.target.value)}
								onBlur={commitCwd}
								placeholder="(defaults to server cwd)"
								className="min-w-0 flex-1 bg-transparent font-mono text-2xs text-ink placeholder:text-ink-4 focus:outline-none"
							/>
							<button
								type="button"
								onClick={() => setCwdBrowserOpen(true)}
								className="shrink-0 rounded p-0.5 text-ink-4 hover:text-ink"
								title="Browse for folder"
							>
								<FolderOpen className="h-3.5 w-3.5" />
							</button>
						</span>
						<span className="text-ink-4">auto work</span>
						<span className="col-span-3">
							<label
								className={cn(
									"inline-flex items-center gap-1.5 text-ink-2",
									autoWorkToggleBlocked ? "cursor-not-allowed opacity-60" : "cursor-pointer",
								)}
								title={autoWorkToggleBlocked ? "Assign a workspace (cwd) above first — Auto Work needs a repo to run in" : undefined}
							>
								<input
									type="checkbox"
									checked={task.autoWork}
									disabled={autoWorkToggleBlocked}
									onChange={(e) => {
										const patch: { autoWork: boolean; cwd?: string } = { autoWork: e.target.checked };
										const trimmed = cwd.trim();
										// A cwd typed but not yet committed via blur travels in the
										// same atomic patch, so the server invariant (autoWork ⇒ cwd)
										// never rejects the toggle.
										if (e.target.checked && trimmed && trimmed !== task.cwd) patch.cwd = trimmed;
										onSave(patch);
									}}
									className="h-3.5 w-3.5 rounded-sm border-line accent-accent"
								/>
								<Zap className="h-3.5 w-3.5 shrink-0 text-accent" />
								<span>Eligible for Auto Work</span>
							</label>
						</span>
						{isArchived ? (
							<>
								<span className="text-warn">archived</span>
								<span>{new Date(task.archivedAt!).toLocaleString()}</span>
							</>
						) : null}
					</div>
				</div>

				<div className="border-b border-line px-6 py-3">
					<div className="mb-2 flex items-center gap-1.5 font-mono text-2xs uppercase tracking-meta text-ink-4">
						<Link2 className="h-3.5 w-3.5" />
						<span>Depends on</span>
					</div>
					<div className="flex flex-wrap items-center gap-1.5">
						{dependencyTasks.map((dep) => {
							const depState = states.find((s) => s.id === dep.stateId);
							const isDone = depState?.name.toLowerCase() === "done";
							return (
								<span
									key={dep.id}
									className="inline-flex items-center gap-1.5 rounded-md border border-line bg-paper-2 py-1 pl-2 pr-1 text-xs text-ink-2"
									title={dep.title}
								>
									{isDone ? (
										<CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
									) : (
										<Circle
											className="h-3.5 w-3.5 shrink-0"
											style={{ color: depState?.color ?? "var(--ink-3, #6e6a62)" }}
										/>
									)}
									<span className="font-mono text-2xs text-ink-4">T-{dep.displayId}</span>
									<span className="max-w-[16rem] truncate">{dep.title || "Untitled task"}</span>
									<span className="text-2xs text-ink-4">{depState?.name ?? "?"}</span>
									<button
										type="button"
										onClick={() => removeDependency(dep.id)}
										aria-label={`Remove dependency T-${dep.displayId}`}
										className="flex h-4 w-4 items-center justify-center rounded-sm text-ink-4 hover:bg-danger/10 hover:text-danger"
									>
										<X className="h-3 w-3" />
									</button>
								</span>
							);
						})}
						{candidateTasks.length > 0 ? (
							<select
								value=""
								onChange={(e) => addDependency(e.target.value)}
								className="field h-7 px-2 text-2xs"
								aria-label="Add dependency"
							>
								<option value="">+ Add dependency…</option>
								{candidateTasks.map((c) => (
									<option key={c.id} value={c.id}>
										T-{c.displayId} {c.title || "Untitled task"}
									</option>
								))}
							</select>
						) : dependencyTasks.length === 0 ? (
							<span className="text-2xs text-ink-4">No other tasks to depend on yet.</span>
						) : null}
					</div>
				</div>
				{dependentTasks.length > 0 && (
					<div className="border-b border-line px-6 py-3">
						<div className="mb-2 flex items-center gap-1.5 font-mono text-2xs uppercase tracking-meta text-ink-4">
							<Link2 className="h-3.5 w-3.5" />
							<span>Required by</span>
						</div>
						<div className="flex flex-wrap items-center gap-1.5">
							{dependentTasks.map((dep) => {
								const depState = states.find((s) => s.id === dep.stateId);
								const isDone = depState?.name.toLowerCase() === "done";
								return (
									<span
										key={dep.id}
										className="inline-flex items-center gap-1.5 rounded-md border border-line bg-paper-2 py-1 px-2 text-xs text-ink-2"
										title={dep.title}
									>
										{isDone ? (
											<CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
										) : (
											<Circle
												className="h-3.5 w-3.5 shrink-0"
												style={{ color: depState?.color ?? "var(--ink-3, #6e6a62)" }}
											/>
										)}
										<span className="font-mono text-2xs text-ink-4">T-{dep.displayId}</span>
										<span className="max-w-[16rem] truncate">{dep.title || "Untitled task"}</span>
										<span className="text-2xs text-ink-4">{depState?.name ?? "?"}</span>
									</span>
								);
							})}
						</div>
					</div>
				)}
				{rewriteError ? (
					<div className="mx-6 mt-4 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
						<span className="min-w-0 flex-1">Rewrite failed: {rewriteError}</span>
						<button type="button" onClick={() => setRewriteError(null)} className="shrink-0 hover:text-danger/80"><X className="h-3.5 w-3.5" /></button>
					</div>
				) : null}
				{rewrite && rewrite !== "loading" ? (
					<div className="mx-6 mt-4 rounded-md border border-accent/40 bg-accent-soft/20 px-3 py-2.5">
						<div className="mb-1.5 flex items-center justify-between gap-2">
							<span className="font-mono text-2xs uppercase tracking-meta text-accent">✦ Rewritten — review changes</span>
							<div className="flex items-center gap-1.5">
								<button
									type="button"
									onClick={acceptRewrite}
									className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent/90"
								>
									Accept
								</button>
								<button
									type="button"
									onClick={() => setRewrite(null)}
									className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-3 hover:text-ink"
								>
									Dismiss
								</button>
							</div>
						</div>
						{rewrite.title !== task.title ? (
							<div className="mb-1 text-sm font-medium text-ink">{rewrite.title}</div>
						) : null}
						{rewrite.body !== (task.body ?? "") ? (
							<div className="line-clamp-3 text-xs text-ink-3">{rewrite.body.slice(0, 200)}{rewrite.body.length > 200 ? "…" : ""}</div>
						) : null}
						{rewrite.title === task.title && rewrite.body === (task.body ?? "") ? (
							<div className="text-xs text-ink-3">No changes suggested.</div>
						) : null}
					</div>
				) : null}
				<div className="px-6 py-5">
					<MarkdownEdit
						value={task.body}
						onChange={(next) => onSave({ body: next })}
						placeholder="Click to add notes — markdown supported. Use this for context, acceptance criteria, links."
					/>
				</div>
			</div>
		</Modal>
		<DirBrowserModal
			open={cwdBrowserOpen}
			initialPath={cwd || undefined}
			onClose={() => setCwdBrowserOpen(false)}
			onSelect={(selected) => {
				setCwdBrowserOpen(false);
				setCwd(selected);
				if (!task) return;
				const next = selected.trim() || undefined;
				if ((task.cwd ?? "") !== (next ?? "")) onSave({ cwd: next });
			}}
		/>
		</>
	);
}

function IconAction({
	label,
	icon: Icon,
	onClick,
	tone = "default",
}: {
	label: string;
	icon: typeof Trash2;
	onClick: () => void;
	tone?: "default" | "danger";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className={cn(
				"flex h-8 w-8 items-center justify-center rounded-md transition-colors",
				tone === "danger"
					? "text-ink-3 hover:bg-danger/10 hover:text-danger"
					: "text-ink-3 hover:bg-paper-3 hover:text-ink",
			)}
		>
			<Icon className="h-4 w-4" />
		</button>
	);
}
