/**
 * Sessionless Hindsight memory exploration (T-34).
 *
 * Hindsight is the only OMP memory backend with a credential-safe HTTP API
 * that works without a live `AgentSession` — `HindsightApi` is a plain
 * fetch client keyed by bank id, and `loadHindsightConfig`/`computeBankScope`
 * only need the SDK `Settings` singleton plus a project cwd. Mnemopi (local
 * SQLite) and the local rollout-summary pipeline have no equivalent seam:
 * their read/write surface (`MemoryBackend.status/search/save`,
 * `MnemopiSessionState.editScopedMemory`) is wired to a live session's
 * in-memory state and returns "not initialised" without one. The deck does
 * not fabricate a fake session to reach those — see `getMemoryScopeStatus`.
 *
 * The Hindsight API token never leaves this module: it's read from
 * `Settings` to build the `HindsightApi` client's `Authorization` header and
 * is never included in any response returned to callers.
 */
import { computeBankScope } from "@oh-my-pi/pi-coding-agent/hindsight/bank";
import { isHindsightConfigured, loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightError, createHindsightClient } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	CreateHindsightMentalModelRequest,
	CreateHindsightMentalModelResponse,
	HindsightDocument,
	HindsightListDocumentsResponse,
	HindsightListMemoriesResponse,
	HindsightRecallResponse,
	ListHindsightMentalModelsResponse,
	MemoryBackendId,
	MemoryScopeStatus,
	RefreshHindsightMentalModelResponse,
} from "@omp-deck/protocol";

export { HindsightError };

export class HindsightNotConfiguredError extends Error {
	constructor() {
		super("Hindsight is not configured — set hindsight.apiUrl (and an API token, via the OMP CLI) first");
	}
}

/**
 * Thrown when Hindsight has valid config but isn't the active backend
 * (`memory.backend !== "hindsight"`). Keeps explorer routes — including
 * destructive document/mental-model deletes — from touching a backend the
 * operator has switched away from.
 */
export class HindsightBackendInactiveError extends Error {
	constructor() {
		super('Hindsight is configured but is not the active memory backend (set memory.backend to "hindsight" first)');
	}
}

export interface HindsightRecallOptions {
	budget?: "low" | "mid" | "high";
	maxTokens?: number;
}

export interface HindsightListOptions {
	limit?: number;
	offset?: number;
}

export interface HindsightListMemoriesOptions extends HindsightListOptions {
	q?: string;
	type?: string;
}

/** Bank-scoped Hindsight client for one project cwd, resolved from OMP's own settings. */
export class HindsightExplorer {
	readonly bankId: string;
	readonly scoping: string;
	#client: HindsightApi;

	private constructor(client: HindsightApi, bankId: string, scoping: string) {
		this.#client = client;
		this.bankId = bankId;
		this.scoping = scoping;
	}

	/**
	 * Throws {@link HindsightBackendInactiveError} when `memory.backend` isn't
	 * `"hindsight"`, or {@link HindsightNotConfiguredError} when it is but
	 * `hindsight.apiUrl` is unset.
	 */
	static forCwd(settings: Settings, cwd: string): HindsightExplorer {
		if ((settings.get("memory.backend") as MemoryBackendId) !== "hindsight") throw new HindsightBackendInactiveError();
		const config = loadHindsightConfig(settings);
		if (!isHindsightConfigured(config)) throw new HindsightNotConfiguredError();
		const client = createHindsightClient(config);
		const scope = computeBankScope(config, cwd);
		return new HindsightExplorer(client, scope.bankId, config.scoping);
	}

	async recall(query: string, options?: HindsightRecallOptions): Promise<HindsightRecallResponse> {
		const response = await this.#client.recall(this.bankId, query, options);
		return { bankId: this.bankId, query, results: response.results };
	}

	async listMemories(options?: HindsightListMemoriesOptions): Promise<HindsightListMemoriesResponse> {
		const response = await this.#client.listMemories(this.bankId, options);
		return { bankId: this.bankId, ...response };
	}

	async listDocuments(options?: HindsightListOptions): Promise<HindsightListDocumentsResponse> {
		const response = await this.#client.listDocuments(this.bankId, options);
		return { bankId: this.bankId, ...response };
	}

	async getDocument(documentId: string): Promise<HindsightDocument | null> {
		return this.#client.getDocument(this.bankId, documentId);
	}

	async updateDocument(documentId: string, tags: string[]): Promise<HindsightDocument> {
		return this.#client.updateDocument(this.bankId, documentId, { tags });
	}

	async deleteDocument(documentId: string): Promise<boolean> {
		return this.#client.deleteDocument(this.bankId, documentId);
	}

	async listMentalModels(): Promise<ListHindsightMentalModelsResponse> {
		const response = await this.#client.listMentalModels(this.bankId, { detail: "content" });
		return { bankId: this.bankId, items: response.items };
	}

	async createMentalModel(request: CreateHindsightMentalModelRequest): Promise<CreateHindsightMentalModelResponse> {
		return this.#client.createMentalModel(this.bankId, request.name, request.sourceQuery, {
			tags: request.tags,
			maxTokens: request.maxTokens,
		});
	}

	async refreshMentalModel(mentalModelId: string): Promise<RefreshHindsightMentalModelResponse> {
		return this.#client.refreshMentalModel(this.bankId, mentalModelId);
	}

	async deleteMentalModel(mentalModelId: string): Promise<boolean> {
		return this.#client.deleteMentalModel(this.bankId, mentalModelId);
	}
}

/**
 * Reports which memory backend is active process-wide and, only for
 * Hindsight, the bank a project resolves to. Never throws — an unconfigured
 * or non-explorable backend is reported via `explorable: false` + `message`.
 */
export async function getMemoryScopeStatus(settings: Settings, cwd: string): Promise<MemoryScopeStatus> {
	const backend = settings.get("memory.backend") as MemoryBackendId;
	if (backend !== "hindsight") {
		return { cwd, backend, explorable: false, message: nonExplorableMessage(backend) };
	}
	const config = loadHindsightConfig(settings);
	if (!isHindsightConfigured(config)) {
		return { cwd, backend, explorable: false, message: "Hindsight is selected but hindsight.apiUrl is not configured yet." };
	}
	const scope = computeBankScope(config, cwd);
	return { cwd, backend, explorable: true, bankId: scope.bankId, scoping: config.scoping };
}

function nonExplorableMessage(backend: MemoryBackendId): string {
	switch (backend) {
		case "off":
			return "Memory is off — no backend is recording or recalling memories for this project.";
		case "local":
			return "The local rollout-summary pipeline keeps its summary inline in the session transcript — there is nothing separate to browse here.";
		case "mnemopi":
			return "Mnemopi (local SQLite) memory is only readable/writable through a live OMP agent session — the deck cannot browse or edit it without one.";
		default:
			return "This memory backend has no browsable data.";
	}
}
