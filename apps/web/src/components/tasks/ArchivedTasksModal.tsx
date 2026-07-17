import { useEffect, useState } from "react";
import { ArchiveX, RotateCcw, X } from "lucide-react";
import type { Task, TaskPriority, TaskState } from "@omp-deck/protocol";
import { Modal } from "@/components/ui/Modal";
import { tasksApi } from "@/lib/tasks-api";
import { cn, shortPath } from "@/lib/utils";

const PRIORITY_TONE: Record<TaskPriority, string> = {
	P0: "bg-danger/15 text-danger",
	P1: "bg-warn/15 text-warn",
	P2: "bg-accent-soft text-accent",
	P3: "bg-thinking/15 text-thinking",
	P4: "bg-success/15 text-success",
	P5: "bg-paper-3 text-ink-3",
};

interface Props {
	open: boolean;
	onClose: () => void;
	/** Board states — used to locate the backlog column. */
	states: TaskState[];
	/** Called after a task is successfully restored so the board can refresh. */
	onRestored: () => void;
}

/**
 * Modal listing all archived tasks with a per-row "Mover a backlog" action.
 * Restore clears `archived_at` AND moves the task to the backlog state in one
 * call so the card surfaces in the kanban column immediately after refresh.
 */
export function ArchivedTasksModal({ open, onClose, states, onRestored }: Props) {
	const [tasks, setTasks] = useState<Task[]>([]);
	const [loading, setLoading] = useState(false);
	const [fetchError, setFetchError] = useState<string | undefined>();
	const [search, setSearch] = useState("");
	const [restoring, setRestoring] = useState<Set<string>>(new Set());
	const [restoreErrors, setRestoreErrors] = useState<Map<string, string>>(new Map());

	// Locate the backlog state. Never fall back to an arbitrary column.
	const backlogState =
		states.find((s) => s.id === "s_backlog") ??
		states.find((s) => s.name.toLowerCase() === "backlog");

	// Fetch archived tasks whenever the modal opens.
	useEffect(() => {
		if (!open) return;
		setSearch("");
		setRestoreErrors(new Map());
		setLoading(true);
		setFetchError(undefined);
		tasksApi
			.list(true)
			.then((data) => {
				setTasks(data.tasks.filter((t) => t.archivedAt !== undefined));
			})
			.catch((e: unknown) => {
				setFetchError(String(e));
			})
			.finally(() => {
				setLoading(false);
			});
	}, [open]);

	const filtered = search
		? tasks.filter((t) => t.title.toLowerCase().includes(search.toLowerCase()))
		: tasks;

	async function restore(task: Task): Promise<void> {
		if (!backlogState) return;
		setRestoring((prev) => new Set(prev).add(task.id));
		setRestoreErrors((prev) => {
			const next = new Map(prev);
			next.delete(task.id);
			return next;
		});
		try {
			await tasksApi.update(task.id, {
				archived: false,
				stateId: backlogState.id,
			});
			// Optimistic removal from the modal list.
			setTasks((prev) => prev.filter((t) => t.id !== task.id));
			onRestored();
		} catch (e: unknown) {
			setRestoreErrors((prev) => new Map(prev).set(task.id, String(e)));
		} finally {
			setRestoring((prev) => {
				const next = new Set(prev);
				next.delete(task.id);
				return next;
			});
		}
	}

	return (
		<Modal
			open={open}
			onClose={onClose}
			widthClass="max-w-2xl"
			heightClass="max-h-[80vh]"
		>
			{/* Header */}
			<div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
				<ArchiveX className="h-4 w-4 shrink-0 text-ink-3" />
				<span className="font-mono text-sm font-medium text-ink">Tareas archivadas</span>
				{!loading && !fetchError && (
					<span className="font-mono text-xs text-ink-4">
						{tasks.length} tarea{tasks.length === 1 ? "" : "s"}
					</span>
				)}
				<button
					type="button"
					onClick={onClose}
					aria-label="Cerrar"
					className="ml-auto rounded p-1 text-ink-3 hover:bg-paper-3 hover:text-ink"
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			{/* No-backlog warning — disables all restore actions */}
			{!backlogState && states.length > 0 && (
				<div className="shrink-0 border-b border-line bg-warn/10 px-4 py-2 font-mono text-xs text-warn">
					No se encontró una columna de backlog. Añade una columna con id{" "}
					<code className="rounded bg-warn/20 px-1">s_backlog</code> o nombre{" "}
					<code className="rounded bg-warn/20 px-1">backlog</code> para habilitar la restauración.
				</div>
			)}

			{/* Search */}
			<div className="shrink-0 border-b border-line px-4 py-2">
				<input
					type="search"
					placeholder="Buscar por título…"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					className="field h-8 w-full px-3 text-sm placeholder:text-ink-4"
					autoFocus
				/>
			</div>

			{/* Body */}
			<div className="flex-1 overflow-y-auto">
				{loading ? (
					<div className="flex items-center justify-center py-10 text-sm text-ink-3">
						Cargando…
					</div>
				) : fetchError ? (
					<div className="px-4 py-6 font-mono text-xs text-danger">{fetchError}</div>
				) : filtered.length === 0 ? (
					<div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-ink-3">
						<ArchiveX className="h-8 w-8 opacity-40" />
						{search ? "Sin resultados para esa búsqueda." : "No hay tareas archivadas."}
					</div>
				) : (
					<ul>
						{filtered.map((task) => {
							const isRestoring = restoring.has(task.id);
							const rowError = restoreErrors.get(task.id);
							return (
								<li
									key={task.id}
									className="border-b border-line last:border-0"
								>
									<div className="flex items-start gap-3 px-4 py-3">
										{/* Meta badges */}
										<div className="flex shrink-0 flex-wrap items-center gap-1.5 pt-0.5 font-mono text-[10px] uppercase tracking-meta text-ink-3">
											<span className="text-ink-4">T-{task.displayId}</span>
											<span
												className={cn(
													"rounded px-1 py-px",
													PRIORITY_TONE[task.priority],
												)}
											>
												{task.priority}
											</span>
											<span className="rounded bg-paper-3 px-1 py-px text-ink-3">
												{task.difficulty}
											</span>
										</div>

										{/* Title + cwd */}
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm font-medium text-ink leading-snug">
												{task.title}
											</p>
											{task.cwd && (
												<p
													className="mt-0.5 truncate font-mono text-[10px] text-ink-4"
													title={task.cwd}
												>
													{shortPath(task.cwd, 48)}
												</p>
											)}
										</div>

										{/* Restore button */}
										<button
											type="button"
											onClick={() => void restore(task)}
											disabled={isRestoring || !backlogState}
											title={
												!backlogState
													? "No se encontró columna de backlog"
													: "Mover a backlog"
											}
											className={cn(
												"flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1.5 font-mono text-xs transition-colors",
												backlogState
													? "btn-ghost text-ink-2 hover:bg-accent-soft hover:text-accent"
													: "cursor-not-allowed text-ink-4 opacity-50",
											)}
										>
											<RotateCcw
												className={cn(
													"h-3 w-3",
													isRestoring && "animate-spin",
												)}
											/>
											{isRestoring ? "Moviendo…" : "Mover a backlog"}
										</button>
									</div>

									{/* Per-row error */}
									{rowError && (
										<p className="px-4 pb-2 font-mono text-[11px] text-danger">
											{rowError}
										</p>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</Modal>
	);
}
