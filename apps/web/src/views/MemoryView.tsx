/**
 * Memory (T-34) — governance + exploration for OMP's own session-memory
 * subsystem (Hindsight remote / Mnemopi local SQLite / local rollout
 * summaries). Deliberately separate from `/kb`: the KB is hand-tended
 * long-term knowledge the deck reads/writes directly; this is the agent's
 * autonomous recall/retain layer, governed via OMP's own settings and (for
 * Hindsight, the only backend with a sessionless HTTP API) explored per
 * project through the deck server.
 */
import { useCallback, useEffect, useState } from "react";
import { Brain, RefreshCw, Trash2 } from "lucide-react";
import type {
	HindsightListDocumentsResponse,
	HindsightMentalModel,
	HindsightRecallItem,
	MemoryScopeStatus,
	WorkspaceEntry,
} from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { MemorySettingsSection } from "@/components/settings/MemorySettingsSection";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { usePersistedViewState } from "@/lib/use-persisted-view-state";

export function MemoryView() {
	const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
	const [selectedCwd, setSelectedCwd] = usePersistedViewState("memory.workspace", "");
	const [scope, setScope] = useState<MemoryScopeStatus>();
	const [scopeLoading, setScopeLoading] = useState(false);
	const [scopeError, setScopeError] = useState<string>();

	useEffect(() => {
		void api.listWorkspaces().then((response) => setWorkspaces(response.workspaces));
	}, []);

	// Fall back to the first known workspace once loaded, if nothing selected yet.
	useEffect(() => {
		if (!selectedCwd && workspaces.length > 0) setSelectedCwd(workspaces[0]!.cwd);
	}, [workspaces, selectedCwd, setSelectedCwd]);

	const loadScope = useCallback(async (cwd: string): Promise<void> => {
		if (!cwd) return;
		setScopeLoading(true);
		setScopeError(undefined);
		try {
			setScope(await api.getMemoryScope(cwd));
		} catch (cause) {
			setScope(undefined);
			setScopeError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setScopeLoading(false);
		}
	}, []);

	useEffect(() => {
		if (selectedCwd) void loadScope(selectedCwd);
	}, [selectedCwd, loadScope]);

	const selectedWorkspace = workspaces.find((w) => w.cwd === selectedCwd);

	return (
		<Layout
			sidebar={<Sidebar />}
			inspector={<div />}
			main={
				<div className="flex h-full overflow-hidden">
					<div className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-line">
						<div className="flex items-center justify-between border-b border-line px-4 py-3">
							<div className="flex items-center gap-2">
								<Brain className="h-4 w-4 text-ink-3" />
								<h1 className="text-sm font-semibold text-ink">Memory</h1>
							</div>
							<button
								type="button"
								onClick={() => {
									void api.listWorkspaces().then((response) => setWorkspaces(response.workspaces));
									if (selectedCwd) void loadScope(selectedCwd);
								}}
								className="rounded p-1 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"
								title="Refresh"
							>
								<RefreshCw className="h-3.5 w-3.5" />
							</button>
						</div>
						<div className="flex-1 overflow-y-auto p-2">
							{workspaces.map((workspace) => (
								<button
									key={workspace.cwd}
									type="button"
									onClick={() => setSelectedCwd(workspace.cwd)}
									className={cn(
										"w-full rounded-md px-2.5 py-2 text-left transition-colors",
										workspace.cwd === selectedCwd ? "bg-accent-soft text-accent" : "hover:bg-paper-3",
									)}
								>
									<div className="truncate text-sm font-medium">{workspace.label}</div>
									<div className="truncate font-mono text-2xs text-ink-3" title={workspace.cwd}>
										{workspace.cwd}
									</div>
								</button>
							))}
							{workspaces.length === 0 ? <p className="py-8 text-center text-xs text-ink-3">No known workspaces yet.</p> : null}
						</div>
					</div>

					<div className="min-w-0 flex-1 overflow-y-auto p-4">
						<div className="mx-auto max-w-3xl space-y-6">
							<MemorySettingsSection onChanged={() => selectedCwd && void loadScope(selectedCwd)} />
							<div className="border-t border-line pt-6">
								<h2 className="text-base font-semibold text-ink">Explore recalled memory</h2>
								<p className="mt-1 text-sm text-ink-3">
									Per-project trace of what the active backend has recorded — separate from the KB. Only the Hindsight backend
									exposes a sessionless API the deck can browse; Mnemopi (local SQLite) requires a live OMP session.
								</p>
							</div>
							{!selectedWorkspace ? (
								<p className="py-8 text-center text-sm text-ink-3">Select a project to inspect its memory.</p>
							) : scopeLoading ? (
								<p className="py-8 text-center text-sm text-ink-3">Loading…</p>
							) : scopeError ? (
								<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{scopeError}</div>
							) : scope ? (
								<>
									<ScopeCard scope={scope} />
									{scope.explorable ? <HindsightExplorer cwd={scope.cwd} bankId={scope.bankId ?? ""} /> : null}
								</>
							) : null}
						</div>
					</div>
				</div>
			}
		/>
	);
}

function ScopeCard({ scope }: { scope: MemoryScopeStatus }) {
	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex items-center gap-2">
				<Badge tone={scope.explorable ? "success" : "muted"}>{scope.backend}</Badge>
				{scope.bankId ? <span className="font-mono text-2xs text-ink-3">bank: {scope.bankId}</span> : null}
				{scope.scoping ? <span className="font-mono text-2xs text-ink-3">scoping: {scope.scoping}</span> : null}
			</div>
			{scope.message ? <p className="mt-2 text-xs text-ink-3">{scope.message}</p> : null}
		</div>
	);
}

function HindsightExplorer({ cwd, bankId }: { cwd: string; bankId: string }) {
	return (
		<div className="space-y-4">
			<RecallSection cwd={cwd} />
			<RawListSection
				title="Memories"
				description="Bulk-listed working/episodic memory rows for this bank, as returned by Hindsight."
				load={(params) => api.listHindsightMemories(cwd, params)}
			/>
			<DocumentsSection cwd={cwd} />
			<MentalModelsSection cwd={cwd} bankId={bankId} />
		</div>
	);
}

function RecallSection({ cwd }: { cwd: string }) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<HindsightRecallItem[]>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();

	async function runRecall(): Promise<void> {
		if (!query.trim()) return;
		setLoading(true);
		setError(undefined);
		try {
			const response = await api.recallHindsightMemory(cwd, { query: query.trim() });
			setResults(response.results);
		} catch (cause) {
			setResults(undefined);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}

	return (
		<section className="rounded-md border border-line bg-paper-2 p-4">
			<h3 className="mb-1 text-sm font-semibold text-ink">Recall — traceability</h3>
			<p className="mb-3 text-xs text-ink-3">Run the same recall query the agent would, and see exactly what it would surface.</p>
			<div className="flex gap-2">
				<input
					type="text"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") void runRecall();
					}}
					placeholder="What did we decide about auth?"
					className="h-8 flex-1 rounded-md border border-line bg-paper px-2 text-sm text-ink outline-none focus:border-accent"
				/>
				<Button size="sm" onClick={() => void runRecall()} disabled={loading || !query.trim()}>
					{loading ? "Recalling…" : "Recall"}
				</Button>
			</div>
			{error ? <div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</div> : null}
			{results ? (
				results.length === 0 ? (
					<p className="mt-3 text-xs text-ink-3">No memories matched.</p>
				) : (
					<ul className="mt-3 space-y-2">
						{results.map((item, index) => (
							<li key={item.id ?? index} className="rounded-md border border-line bg-paper p-2.5">
								<p className="text-xs text-ink">{item.text}</p>
								<div className="mt-1 flex flex-wrap gap-2 font-mono text-2xs text-ink-3">
									{item.type ? <span>type: {item.type}</span> : null}
									{item.mentioned_at ? <span>mentioned: {item.mentioned_at}</span> : null}
									{item.id ? <span>id: {item.id}</span> : null}
								</div>
							</li>
						))}
					</ul>
				)
			) : null}
		</section>
	);
}

function RawListSection<T>({
	title,
	description,
	load,
}: {
	title: string;
	description: string;
	load: (params: { limit?: number; offset?: number }) => Promise<T>;
}) {
	const [data, setData] = useState<T>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const [limit, setLimit] = useState(20);
	const [offset, setOffset] = useState(0);

	async function run(): Promise<void> {
		setLoading(true);
		setError(undefined);
		try {
			setData(await load({ limit, offset }));
		} catch (cause) {
			setData(undefined);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}

	return (
		<section className="rounded-md border border-line bg-paper-2 p-4">
			<h3 className="mb-1 text-sm font-semibold text-ink">{title}</h3>
			<p className="mb-3 text-xs text-ink-3">{description}</p>
			<div className="flex items-center gap-2">
				<label className="font-mono text-2xs text-ink-3">
					limit
					<input
						type="number"
						min={1}
						value={limit}
						onChange={(event) => setLimit(Number(event.target.value) || 20)}
						className="ml-1 h-7 w-16 rounded border border-line bg-paper px-1 text-xs text-ink outline-none focus:border-accent"
					/>
				</label>
				<label className="font-mono text-2xs text-ink-3">
					offset
					<input
						type="number"
						min={0}
						value={offset}
						onChange={(event) => setOffset(Number(event.target.value) || 0)}
						className="ml-1 h-7 w-16 rounded border border-line bg-paper px-1 text-xs text-ink outline-none focus:border-accent"
					/>
				</label>
				<Button size="sm" onClick={() => void run()} disabled={loading}>
					{loading ? "Loading…" : "Load"}
				</Button>
			</div>
			{error ? <div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</div> : null}
			{data ? <pre className="mt-3 max-h-72 overflow-auto rounded bg-paper p-3 font-mono text-2xs text-ink-2">{JSON.stringify(data, null, 2)}</pre> : null}
		</section>
	);
}

function DocumentsSection({ cwd }: { cwd: string }) {
	const [listing, setListing] = useState<HindsightListDocumentsResponse>();
	const [listError, setListError] = useState<string>();
	const [documentId, setDocumentId] = useState("");
	const [tagsInput, setTagsInput] = useState("");
	const [detail, setDetail] = useState<Record<string, unknown>>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();

	async function loadList(): Promise<void> {
		setListError(undefined);
		try {
			setListing(await api.listHindsightDocuments(cwd, { limit: 20 }));
		} catch (cause) {
			setListing(undefined);
			setListError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function updateTags(): Promise<void> {
		if (!documentId.trim()) return;
		setBusy(true);
		setError(undefined);
		setNotice(undefined);
		try {
			const tags = tagsInput
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean);
			setDetail(await api.updateHindsightDocument(cwd, documentId.trim(), { tags }));
			setNotice("Tags updated.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function deleteDocument(): Promise<void> {
		if (!documentId.trim()) return;
		if (!window.confirm(`Delete document ${documentId.trim()}? This cannot be undone.`)) return;
		setBusy(true);
		setError(undefined);
		setNotice(undefined);
		try {
			await api.deleteHindsightDocument(cwd, documentId.trim());
			setDetail(undefined);
			setNotice("Document deleted.");
			void loadList();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="rounded-md border border-line bg-paper-2 p-4">
			<h3 className="mb-1 text-sm font-semibold text-ink">Documents — edit tags / delete</h3>
			<p className="mb-3 text-xs text-ink-3">
				Retained conversation documents for this bank. List to find an id, then edit its tags or delete it.
			</p>
			<Button size="sm" variant="outline" onClick={() => void loadList()}>
				List documents
			</Button>
			{listError ? <div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{listError}</div> : null}
			{listing ? <pre className="mt-3 max-h-56 overflow-auto rounded bg-paper p-3 font-mono text-2xs text-ink-2">{JSON.stringify(listing, null, 2)}</pre> : null}

			<div className="mt-4 space-y-2 border-t border-line pt-3">
				<input
					type="text"
					value={documentId}
					onChange={(event) => setDocumentId(event.target.value)}
					placeholder="Document id"
					className="h-8 w-full rounded-md border border-line bg-paper px-2 font-mono text-xs text-ink outline-none focus:border-accent"
				/>
				<input
					type="text"
					value={tagsInput}
					onChange={(event) => setTagsInput(event.target.value)}
					placeholder="Comma-separated tags"
					className="h-8 w-full rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none focus:border-accent"
				/>
				<div className="flex gap-2">
					<Button size="sm" onClick={() => void updateTags()} disabled={busy || !documentId.trim()}>
						Save tags
					</Button>
					<Button size="sm" variant="danger" onClick={() => void deleteDocument()} disabled={busy || !documentId.trim()}>
						<Trash2 className="h-3.5 w-3.5" /> Delete
					</Button>
				</div>
				{notice ? <p className="text-xs text-success">{notice}</p> : null}
				{error ? <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</div> : null}
				{detail ? <pre className="max-h-56 overflow-auto rounded bg-paper p-3 font-mono text-2xs text-ink-2">{JSON.stringify(detail, null, 2)}</pre> : null}
			</div>
		</section>
	);
}

function MentalModelsSection({ cwd, bankId }: { cwd: string; bankId: string }) {
	const [models, setModels] = useState<HindsightMentalModel[]>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const [name, setName] = useState("");
	const [sourceQuery, setSourceQuery] = useState("");
	const [busyId, setBusyId] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		setLoading(true);
		setError(undefined);
		try {
			const response = await api.listHindsightMentalModels(cwd);
			setModels(response.items);
		} catch (cause) {
			setModels(undefined);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}, [cwd]);

	useEffect(() => {
		void load();
	}, [load]);

	async function create(): Promise<void> {
		if (!name.trim() || !sourceQuery.trim()) return;
		setBusyId("__create__");
		setError(undefined);
		try {
			await api.createHindsightMentalModel(cwd, { name: name.trim(), sourceQuery: sourceQuery.trim() });
			setName("");
			setSourceQuery("");
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusyId(null);
		}
	}

	async function refresh(id: string): Promise<void> {
		setBusyId(id);
		setError(undefined);
		try {
			await api.refreshHindsightMentalModel(cwd, id);
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusyId(null);
		}
	}

	async function remove(id: string): Promise<void> {
		if (!window.confirm(`Delete mental model ${id}? This cannot be undone.`)) return;
		setBusyId(id);
		setError(undefined);
		try {
			await api.deleteHindsightMentalModel(cwd, id);
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusyId(null);
		}
	}

	return (
		<section className="rounded-md border border-line bg-paper-2 p-4">
			<h3 className="mb-1 text-sm font-semibold text-ink">Mental models — create / refresh / invalidate / delete</h3>
			<p className="mb-3 text-xs text-ink-3">Curated reflect summaries injected into developer instructions for bank {bankId}.</p>
			{error ? <div className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</div> : null}
			{loading ? (
				<p className="text-xs text-ink-3">Loading…</p>
			) : models && models.length > 0 ? (
				<ul className="space-y-2">
					{models.map((model) => (
						<li key={model.id} className="rounded-md border border-line bg-paper p-2.5">
							<div className="flex items-center justify-between gap-2">
								<div className="min-w-0">
									<p className="truncate text-sm font-medium text-ink">{model.name}</p>
									{model.last_refreshed_at ? <p className="font-mono text-2xs text-ink-3">refreshed: {model.last_refreshed_at}</p> : null}
								</div>
								<div className="flex shrink-0 gap-1">
									<Button size="sm" variant="outline" disabled={busyId === model.id} onClick={() => void refresh(model.id)}>
										Refresh
									</Button>
									<Button size="sm" variant="danger" disabled={busyId === model.id} onClick={() => void remove(model.id)}>
										<Trash2 className="h-3.5 w-3.5" />
									</Button>
								</div>
							</div>
							{model.content ? <p className="mt-2 whitespace-pre-wrap text-xs text-ink-2">{model.content}</p> : null}
						</li>
					))}
				</ul>
			) : (
				<p className="text-xs text-ink-3">No mental models yet.</p>
			)}
			<div className="mt-4 space-y-2 border-t border-line pt-3">
				<input
					type="text"
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Name (e.g. project-conventions)"
					className="h-8 w-full rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none focus:border-accent"
				/>
				<input
					type="text"
					value={sourceQuery}
					onChange={(event) => setSourceQuery(event.target.value)}
					placeholder="Source query (what should this model summarize?)"
					className="h-8 w-full rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none focus:border-accent"
				/>
				<Button size="sm" onClick={() => void create()} disabled={busyId === "__create__" || !name.trim() || !sourceQuery.trim()}>
					Create mental model
				</Button>
			</div>
		</section>
	);
}
