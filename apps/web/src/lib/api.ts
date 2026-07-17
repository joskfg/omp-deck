import type {
	ApplyDelegationArtifactRequest,
	ApplyDelegationArtifactResponse,
	AdvisorSettingsResponse,
	AggregatedStatsResponse,
	AutoWorkConfig,
	AutoWorkCycleResult,
	AutoWorkGlobalConfig,
	AutoWorkRunStatus,
	AutoWorkScheduleStatus,
	BranchSessionRequest,
	CodebaseMemoryIndexResult,
	CodebaseMemoryMcpStatus,
	CodebaseMemoryOverview,
	CodebaseMemoryQueryResult,
	CreateSessionRequest,
	CreateSessionResponse,
	DeckBaseUrlResponse,
	DelegationArtifactResponse,
	DiscardDelegationArtifactRequest,
	DiscardDelegationArtifactResponse,
	GetDelegationSettingsResponse,
	CreateHindsightMentalModelRequest,
	CreateHindsightMentalModelResponse,
	DeleteHindsightDocumentResponse,
	DeleteHindsightMentalModelResponse,
	GetMemorySettingsResponse,
	HindsightDocument,
	HindsightListDocumentsResponse,
	HindsightListMemoriesResponse,
	HindsightRecallRequest,
	HindsightRecallResponse,
	ListHindsightMentalModelsResponse,
	MemoryScopeStatus,
	PatchMemorySettingsRequest,
	PatchMemorySettingsResponse,
	RefreshHindsightMentalModelResponse,
	UpdateHindsightDocumentRequest,
	GetSessionHandoffSuccessorResponse,
	InternalTaskModelResponse,
	ListAutoWorkRunsResponse,
	ListDirResponse,
	ListFilePathsResponse,
	ListModelsResponse,
	ListSessionsResponse,
	ListSessionMonitorResponse,
	ListSessionUsageResponse,
	ListSlashCommandsResponse,
	ListTasksResponse,
	ListWorkspacePreferencesResponse,
	ListWorkspacesResponse,
	AddWorkspaceRequest,
	ModelRef,
	OmpStatsRange,
	PatchDelegationSettingsRequest,
	PatchDelegationSettingsResponse,
	GetPolicySettingsResponse,
	PatchPolicySettingsRequest,
	PatchPolicySettingsResponse,
	PlanModelResponse,
	QueryCodebaseMemoryRequest,
	RewriteTaskRequest,
	RewriteTaskResponse,
	SessionHistoryResponse,
	SessionTreeResponse,
	SetAdvisorSettingsRequest,
	SetAutoWorkConfigRequest,
	SetAutoWorkGlobalConfigRequest,
	SetDeckBaseUrlRequest,
	SetInternalTaskModelRequest,
	SetPlanModelRequest,
	SetTaskRewriteModelRequest,
	SpendSummaryResponse,
	SubscriptionUsageResponse,
	TaskPriority,
	TaskRewriteModelResponse,
	WorkspacePreference,
} from "@omp-deck/protocol";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "(unreadable body)");
		let parsedError: string | undefined;
		try {
			parsedError = (JSON.parse(text) as { error?: string }).error;
		} catch {
			// Body wasn't JSON — fall through to the raw-text error below.
		}
		throw new Error(parsedError ?? `HTTP ${res.status} ${path}: ${text}`);
	}
	return (await res.json()) as T;
}

export const api = {
	getAppTitle(): Promise<{ title: string }> {
		return request<{ title: string }>("/health");
	},
	listWorkspaces(): Promise<ListWorkspacesResponse> {
		return request<ListWorkspacesResponse>("/workspaces");
	},
	addWorkspace(cwd: string): Promise<{ ok: true }> {
		return request<{ ok: true }>("/workspaces", {
			method: "POST",
			body: JSON.stringify({ cwd } satisfies AddWorkspaceRequest),
		});
	},
	removeWorkspace(cwd: string): Promise<{ ok: true }> {
		return request<{ ok: true }>(`/workspaces?cwd=${encodeURIComponent(cwd)}`, {
			method: "DELETE",
		});
	},
	listSessions(cwd?: string): Promise<ListSessionsResponse> {
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		return request<ListSessionsResponse>(`/sessions${q}`);
	},
	listSessionMonitor(cwd?: string): Promise<ListSessionMonitorResponse> {
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		return request<ListSessionMonitorResponse>(`/sessions/monitor${q}`);
	},
	sessionHistory(id: string, before: number, limit: number): Promise<SessionHistoryResponse> {
		return request<SessionHistoryResponse>(
			`/sessions/${encodeURIComponent(id)}/history?before=${before}&limit=${limit}`,
		);
	},
	sessionTree(id: string): Promise<SessionTreeResponse> {
		return request<SessionTreeResponse>(`/sessions/${encodeURIComponent(id)}/tree`);
	},
	branchSession(id: string, entryId: string): Promise<CreateSessionResponse> {
		const body: BranchSessionRequest = { entryId };
		return request<CreateSessionResponse>(`/sessions/${encodeURIComponent(id)}/branch`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	/** T-32: best-effort lookup of the session an automatic context handoff
	 *  continued into, if any. Bridge-independent — works for a purely
	 *  historical (non-live) session too. */
	getHandoffSuccessor(cwd: string, sessionFile: string): Promise<GetSessionHandoffSuccessorResponse> {
		return request<GetSessionHandoffSuccessorResponse>(
			`/sessions/handoff-successor?cwd=${encodeURIComponent(cwd)}&sessionFile=${encodeURIComponent(sessionFile)}`,
		);
	},
	createSession(body: CreateSessionRequest): Promise<CreateSessionResponse> {
		return request<CreateSessionResponse>("/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	abortSession(id: string): Promise<{ ok: true }> {
		return request(`/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" });
	},
	renameSession(id: string, name: string): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		});
	},
	listModels(sessionId?: string): Promise<ListModelsResponse> {
		const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
		return request<ListModelsResponse>(`/models${q}`);
	},
	setSessionModel(id: string, model: ModelRef): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ model }),
		});
	},
	setSessionThinking(id: string, thinking: string): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ thinking }),
		});
	},
	compactSession(id: string, focus?: string): Promise<{ ok: true }> {
		const body = focus && focus.trim().length > 0 ? JSON.stringify({ focus: focus.trim() }) : "";
		const init: RequestInit = { method: "POST" };
		if (body) {
			init.body = body;
			init.headers = { "content-type": "application/json" };
		}
		return request(`/sessions/${encodeURIComponent(id)}/compact`, init);
	},
	disposeSession(id: string): Promise<{ ok: true }> {
		return request(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	listSlashCommands(cwd?: string): Promise<ListSlashCommandsResponse> {
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		return request<ListSlashCommandsResponse>(`/slash-commands${q}`);
	},
	completeFilePath(cwd: string, q: string, limit = 20): Promise<ListFilePathsResponse> {
		const params = new URLSearchParams({ cwd, q, limit: String(limit) });
		return request<ListFilePathsResponse>(`/fs/complete?${params.toString()}`);
	},
	browseDir(path?: string): Promise<ListDirResponse> {
		const q = path ? `?path=${encodeURIComponent(path)}` : "";
		return request<ListDirResponse>(`/fs/browse${q}`);
	},
	listWorkspacePreferences(): Promise<ListWorkspacePreferencesResponse> {
		return request<ListWorkspacePreferencesResponse>("/workspace-preferences");
	},
	setWorkspacePreference(cwd: string, model: ModelRef | null, thinking?: string | null): Promise<WorkspacePreference> {
		return request<WorkspacePreference>(`/workspace-preferences?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify({ model, ...(thinking !== undefined ? { thinking } : {}) }),
		});
	},
	getAutoWorkConfig(cwd: string): Promise<AutoWorkConfig> {
		return request<AutoWorkConfig>(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`);
	},
	setAutoWorkConfig(cwd: string, config: SetAutoWorkConfigRequest): Promise<AutoWorkConfig> {
		return request<AutoWorkConfig>(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(config),
		});
	},
	getCodebaseMemoryMcpStatus(cwd: string): Promise<CodebaseMemoryMcpStatus> {
		return request<CodebaseMemoryMcpStatus>(`/workspace-mcp/codebase-memory?cwd=${encodeURIComponent(cwd)}`);
	},
	setCodebaseMemoryMcpEnabled(cwd: string, enabled: boolean): Promise<CodebaseMemoryMcpStatus> {
		return request<CodebaseMemoryMcpStatus>(`/workspace-mcp/codebase-memory?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify({ enabled }),
		});
	},
	getCodebaseMemoryOverview(cwd: string): Promise<CodebaseMemoryOverview> {
		return request<CodebaseMemoryOverview>(`/workspace-mcp/codebase-memory/overview?cwd=${encodeURIComponent(cwd)}`);
	},
	queryCodebaseMemory(cwd: string, body: QueryCodebaseMemoryRequest): Promise<CodebaseMemoryQueryResult> {
		return request<CodebaseMemoryQueryResult>(`/workspace-mcp/codebase-memory/query?cwd=${encodeURIComponent(cwd)}`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	indexCodebaseMemory(cwd: string): Promise<CodebaseMemoryIndexResult> {
		return request<CodebaseMemoryIndexResult>(`/workspace-mcp/codebase-memory/index?cwd=${encodeURIComponent(cwd)}`, {
			method: "POST",
		});
	},
	getDeckBaseUrl(): Promise<DeckBaseUrlResponse> {
		return request<DeckBaseUrlResponse>("/settings/deck-base-url");
	},
	setDeckBaseUrl(deckBaseUrl: string | null): Promise<DeckBaseUrlResponse> {
		return request<DeckBaseUrlResponse>("/settings/deck-base-url", {
			method: "PUT",
			body: JSON.stringify({ deckBaseUrl } satisfies SetDeckBaseUrlRequest),
		});
	},
	getAdvisorSettings(): Promise<AdvisorSettingsResponse> {
		return request<AdvisorSettingsResponse>("/advisors/settings");
	},
	setAdvisorEnabled(enabled: boolean): Promise<AdvisorSettingsResponse> {
		return request<AdvisorSettingsResponse>("/advisors/settings", {
			method: "PUT",
			body: JSON.stringify({ enabled } satisfies SetAdvisorSettingsRequest),
		});
	},
	listAutoWorkRuns(filter: {
		limit?: number;
		taskId?: string;
		priority?: TaskPriority;
		status?: AutoWorkRunStatus;
	} = {}): Promise<ListAutoWorkRunsResponse> {
		const params = new URLSearchParams();
		if (filter.limit !== undefined) params.set("limit", String(filter.limit));
		if (filter.taskId) params.set("taskId", filter.taskId);
		if (filter.priority) params.set("priority", filter.priority);
		if (filter.status) params.set("status", filter.status);
		const qs = params.toString();
		return request<ListAutoWorkRunsResponse>(`/auto-work/runs${qs ? `?${qs}` : ""}`);
	},
	retryAutoWorkRunPr(runId: string): Promise<{ number: number; url: string }> {
		return request<{ number: number; url: string }>(
			`/auto-work/runs/${encodeURIComponent(runId)}/create-pr`,
			{ method: "POST" },
		);
	},
	stopAutoWorkRun(runId: string): Promise<{ ok: true }> {
		return request<{ ok: true }>(`/auto-work/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
	},
	deleteAutoWorkRun(runId: string): Promise<{ ok: true }> {
		return request<{ ok: true }>(`/auto-work/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
	},
	triggerAutoWork(): Promise<AutoWorkCycleResult> {
		return request<AutoWorkCycleResult>(`/auto-work/trigger`, { method: "POST" });
	},
	getAutoWorkScheduleStatus(): Promise<AutoWorkScheduleStatus> {
		return request<AutoWorkScheduleStatus>(`/auto-work/schedule-status`);
	},
	getAutoWorkGlobalConfig(): Promise<AutoWorkGlobalConfig> {
		return request<AutoWorkGlobalConfig>(`/auto-work/global-config`);
	},
	setAutoWorkGlobalConfig(body: SetAutoWorkGlobalConfigRequest): Promise<AutoWorkGlobalConfig> {
		return request<AutoWorkGlobalConfig>(`/auto-work/global-config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	},
	getSubscriptionUsage(): Promise<SubscriptionUsageResponse> {
		return request<SubscriptionUsageResponse>(`/usage/subscription`);
	},
	getAccountSpendSummary(): Promise<SpendSummaryResponse> {
		return request<SpendSummaryResponse>(`/usage/spend`);
	},
	listSessionUsage(limit = 20): Promise<ListSessionUsageResponse> {
		return request<ListSessionUsageResponse>(`/usage/sessions?limit=${limit}`);
	},
	getAggregatedStats(opts: {
		range?: OmpStatsRange;
		cwd?: string;
		model?: string;
		agentType?: "main" | "subagent" | "advisor";
	} = {}): Promise<AggregatedStatsResponse> {
		const params = new URLSearchParams();
		if (opts.range) params.set("range", opts.range);
		if (opts.cwd) params.set("cwd", opts.cwd);
		if (opts.model) params.set("model", opts.model);
		if (opts.agentType) params.set("agentType", opts.agentType);
		const qs = params.toString();
		return request<AggregatedStatsResponse>(`/usage/stats${qs ? `?${qs}` : ""}`);
	},
	listTasks(): Promise<ListTasksResponse> {
		return request<ListTasksResponse>("/tasks");
	},
	rewriteTask(taskId: string, opts: RewriteTaskRequest = {}): Promise<RewriteTaskResponse> {
		return request<RewriteTaskResponse>(`/tasks/${encodeURIComponent(taskId)}/rewrite`, {
			method: "POST",
			body: JSON.stringify(opts),
		});
	},
	getTaskRewriteModel(): Promise<TaskRewriteModelResponse> {
		return request<TaskRewriteModelResponse>("/settings/task-rewrite-model");
	},
	setTaskRewriteModel(model: ModelRef | null): Promise<TaskRewriteModelResponse> {
		return request<TaskRewriteModelResponse>("/settings/task-rewrite-model", {
			method: "PUT",
			body: JSON.stringify({ model } satisfies SetTaskRewriteModelRequest),
		});
	},
	getInternalTaskModel(): Promise<InternalTaskModelResponse> {
		return request<InternalTaskModelResponse>("/settings/internal-task-model");
	},
	setInternalTaskModel(model: ModelRef | null): Promise<InternalTaskModelResponse> {
		return request<InternalTaskModelResponse>("/settings/internal-task-model", {
			method: "PUT",
			body: JSON.stringify({ model } satisfies SetInternalTaskModelRequest),
		});
	},
	getPlanModel(): Promise<PlanModelResponse> {
		return request<PlanModelResponse>("/settings/plan-model");
	},
	setPlanModel(model: ModelRef | null, thinking: string | null = null): Promise<PlanModelResponse> {
		return request<PlanModelResponse>("/settings/plan-model", {
			method: "PUT",
			body: JSON.stringify({ model, thinking } satisfies SetPlanModelRequest),
		});
	},
	getDelegationSettings(): Promise<GetDelegationSettingsResponse> {
		return request<GetDelegationSettingsResponse>("/delegation/settings");
	},
	patchDelegationSettings(body: PatchDelegationSettingsRequest): Promise<PatchDelegationSettingsResponse> {
		return request<PatchDelegationSettingsResponse>("/delegation/settings", {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	},
	getPolicySettings(): Promise<GetPolicySettingsResponse> {
		return request<GetPolicySettingsResponse>("/policies/settings");
	},
	patchPolicySettings(body: PatchPolicySettingsRequest): Promise<PatchPolicySettingsResponse> {
		return request<PatchPolicySettingsResponse>("/policies/settings", {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	},
	getDelegationArtifact(path: string): Promise<DelegationArtifactResponse> {
		return request<DelegationArtifactResponse>(`/delegation/artifact?path=${encodeURIComponent(path)}`);
	},
	applyDelegationArtifact(body: ApplyDelegationArtifactRequest): Promise<ApplyDelegationArtifactResponse> {
		return request<ApplyDelegationArtifactResponse>("/delegation/artifact/apply", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	discardDelegationArtifact(body: DiscardDelegationArtifactRequest): Promise<DiscardDelegationArtifactResponse> {
		return request<DiscardDelegationArtifactResponse>("/delegation/artifact/discard", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	getMemorySettings(): Promise<GetMemorySettingsResponse> {
		return request<GetMemorySettingsResponse>("/memory/settings");
	},
	patchMemorySettings(body: PatchMemorySettingsRequest): Promise<PatchMemorySettingsResponse> {
		return request<PatchMemorySettingsResponse>("/memory/settings", {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	},
	getMemoryScope(cwd: string): Promise<MemoryScopeStatus> {
		return request<MemoryScopeStatus>(`/memory/scope?cwd=${encodeURIComponent(cwd)}`);
	},
	listHindsightMemories(cwd: string, params: { q?: string; type?: string; limit?: number; offset?: number } = {}): Promise<HindsightListMemoriesResponse> {
		const q = new URLSearchParams({ cwd });
		if (params.q) q.set("q", params.q);
		if (params.type) q.set("type", params.type);
		if (params.limit !== undefined) q.set("limit", String(params.limit));
		if (params.offset !== undefined) q.set("offset", String(params.offset));
		return request<HindsightListMemoriesResponse>(`/memory/hindsight/memories?${q.toString()}`);
	},
	recallHindsightMemory(cwd: string, body: HindsightRecallRequest): Promise<HindsightRecallResponse> {
		return request<HindsightRecallResponse>(`/memory/hindsight/recall?cwd=${encodeURIComponent(cwd)}`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	listHindsightDocuments(cwd: string, params: { limit?: number; offset?: number } = {}): Promise<HindsightListDocumentsResponse> {
		const q = new URLSearchParams({ cwd });
		if (params.limit !== undefined) q.set("limit", String(params.limit));
		if (params.offset !== undefined) q.set("offset", String(params.offset));
		return request<HindsightListDocumentsResponse>(`/memory/hindsight/documents?${q.toString()}`);
	},
	updateHindsightDocument(cwd: string, documentId: string, body: UpdateHindsightDocumentRequest): Promise<HindsightDocument> {
		return request<HindsightDocument>(`/memory/hindsight/documents/${encodeURIComponent(documentId)}?cwd=${encodeURIComponent(cwd)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	},
	deleteHindsightDocument(cwd: string, documentId: string): Promise<DeleteHindsightDocumentResponse> {
		return request<DeleteHindsightDocumentResponse>(`/memory/hindsight/documents/${encodeURIComponent(documentId)}?cwd=${encodeURIComponent(cwd)}`, {
			method: "DELETE",
		});
	},
	listHindsightMentalModels(cwd: string): Promise<ListHindsightMentalModelsResponse> {
		return request<ListHindsightMentalModelsResponse>(`/memory/hindsight/mental-models?cwd=${encodeURIComponent(cwd)}`);
	},
	createHindsightMentalModel(cwd: string, body: CreateHindsightMentalModelRequest): Promise<CreateHindsightMentalModelResponse> {
		return request<CreateHindsightMentalModelResponse>(`/memory/hindsight/mental-models?cwd=${encodeURIComponent(cwd)}`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	refreshHindsightMentalModel(cwd: string, mentalModelId: string): Promise<RefreshHindsightMentalModelResponse> {
		return request<RefreshHindsightMentalModelResponse>(
			`/memory/hindsight/mental-models/${encodeURIComponent(mentalModelId)}/refresh?cwd=${encodeURIComponent(cwd)}`,
			{ method: "POST" },
		);
	},
	deleteHindsightMentalModel(cwd: string, mentalModelId: string): Promise<DeleteHindsightMentalModelResponse> {
		return request<DeleteHindsightMentalModelResponse>(
			`/memory/hindsight/mental-models/${encodeURIComponent(mentalModelId)}?cwd=${encodeURIComponent(cwd)}`,
			{ method: "DELETE" },
		);
	},
};
