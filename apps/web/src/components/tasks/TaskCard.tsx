import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FolderOpen, Zap } from "lucide-react";
import type { Task, TaskPriority } from "@omp-deck/protocol";
import { formatBriefTime } from "@/lib/time";
import { cn, truncate } from "@/lib/utils";

/** P0 reads as urgent, P5 fades into the background — matches the badge's
 * role as a governance signal, not decoration. */
const PRIORITY_TONE: Record<TaskPriority, string> = {
	P0: "bg-danger/15 text-danger",
	P1: "bg-warn/15 text-warn",
	P2: "bg-accent-soft text-accent",
	P3: "bg-thinking/15 text-thinking",
	P4: "bg-success/15 text-success",
	P5: "bg-paper-3 text-ink-3",
};

interface Props {
	task: Task;
	onOpen: (task: Task) => void;
	onPickCwd?: (task: Task) => void;
	projectColor?: string;
}

/**
 * Sortable card inside a column. While dragging, the in-list instance
 * collapses to a dashed-outline placeholder so the user sees where the card
 * will land; the lifted card itself is rendered by the DragOverlay in
 * TasksView. The two modes share `<TaskCardBody>` so the visual is identical.
 */
export function TaskCard({ task, onOpen, onPickCwd, projectColor }: Props) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: task.id });

	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	if (isDragging) {
		// Slot placeholder — same dimensions as the rendered card (content kept
		// in flow but invisible) so the column layout stays pixel-stable while
		// the lifted overlay is dragged around.
		return (
			<div
				ref={setNodeRef}
				style={style}
				{...attributes}
				{...listeners}
				aria-hidden="true"
				className="rounded-md border border-dashed border-line-strong bg-paper-3/30 px-3 py-2"
			>
				<div className="invisible text-sm font-medium">{task.title}</div>
				{task.body ? (
					<div className="invisible mt-1 line-clamp-2 text-xs">
						{truncate(task.body.split(/\r?\n/)[0] ?? "", 120)}
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div
			ref={setNodeRef}
			style={style}
			{...attributes}
			{...listeners}
			onClick={(e) => {
				if (e.defaultPrevented) return;
				onOpen(task);
			}}
			role="button"
			tabIndex={0}
			className="group relative"
		>
			<TaskCardBody task={task} lifted={false} projectColor={projectColor} />
			{onPickCwd ? (
				<button
					type="button"
					aria-label="Change workspace folder"
					className="absolute bottom-1.5 right-1.5 rounded p-0.5 text-ink-4 opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/40"
					onPointerDown={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onPickCwd(task);
					}}
				>
					<FolderOpen className="h-3 w-3" />
				</button>
			) : null}
		</div>
	);
}

/**
 * Visual body of the card. Reused by the DragOverlay so the lifted version is
 * identical in shape; only the chrome differs (shadow, scale, rotation).
 */
export function TaskCardBody({
	task,
	lifted,
	projectColor,
}: {
	task: Task;
	lifted: boolean;
	projectColor?: string;
}) {
	// Surface the most recent activity timestamp — body edits bump updatedAt
	// without disturbing the per-column sort, which is exactly the signal a
	// glance at the card should reveal.
	const stamp = task.updatedAt;
	const brief = formatBriefTime(stamp);
	return (
		<div
			className={cn(
				"select-none rounded-md border bg-paper-2 px-3 py-2 text-sm transition-shadow",
				lifted
					? "border-ink/30 shadow-[0_12px_24px_-8px_rgba(26,24,20,0.35),0_2px_4px_-2px_rgba(26,24,20,0.2)] rotate-[1.5deg] scale-[1.02] cursor-grabbing"
					: "border-line cursor-grab hover:border-line-strong active:cursor-grabbing",
			)}
		>
			<div className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-meta text-ink-3">
				{projectColor ? (
					<span
						className="h-2 w-2 shrink-0 rounded-full ring-1 ring-ink/20"
						style={{ backgroundColor: projectColor }}
						role="img"
						aria-label={`Project color for ${task.cwd}`}
					/>
				) : null}
				<span>T-{task.displayId}</span>
				<span
					className={cn(
						"rounded px-1 py-px",
						PRIORITY_TONE[task.priority],
					)}
					title="Priority"
				>
					{task.priority}
				</span>
				{task.autoWork ? (
					<Zap
						className="h-3 w-3 shrink-0 text-accent"
						role="img"
						aria-label="Eligible for Auto Work"
					/>
				) : null}
				{brief ? (
					<time
						dateTime={stamp}
						title={new Date(stamp).toLocaleString()}
						className="ml-auto text-ink-4"
					>
						{brief}
					</time>
				) : null}
			</div>
			<div className="mt-0.5 font-medium leading-snug text-ink">{task.title}</div>
			{task.body ? (
				<div className="mt-1 line-clamp-2 text-xs text-ink-3">
					{truncate(task.body.split(/\r?\n/)[0] ?? "", 120)}
				</div>
			) : null}
		</div>
	);
}
