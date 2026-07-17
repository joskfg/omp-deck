import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
	GetMemorySettingsResponse,
	HindsightMentalModel,
	HindsightRecallItem,
	MemoryScopeStatus,
} from "@omp-deck/protocol";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

/** Minimal structural contract for a `bun:test` spy handle — avoids naming the library's own generic spy type. */
interface RestorableSpy {
	mockRestore(): void;
}

let hindsightConfig: {
	hindsightApiUrl: string | null;
	scoping: "global" | "per-project" | "per-project-tagged";
} = { hindsightApiUrl: null, scoping: "per-project" };

const loadHindsightConfig = mock(() => hindsightConfig);
const isHindsightConfigured = mock(() => hindsightConfig.hindsightApiUrl !== null);
const computeBankScope = mock((_config: unknown, directory: string) => ({ bankId: `bank-${path.basename(directory)}` }));

class FakeHindsightError extends Error {
	statusCode?: number;
	constructor(message: string, statusCode?: number) {
		super(message);
		this.statusCode = statusCode;
	}
}

const recall = mock(async (_bankId: string, query: string) => ({ query, results: [] as HindsightRecallItem[] }));
const listMemories = mock(async (_bankId: string) => ({ items: [] as unknown[] }));
const listDocuments = mock(async (_bankId: string) => ({ items: [] as unknown[] }));
const getDocument = mock(async (_bankId: string, _id: string) => null as Record<string, unknown> | null);
const updateDocument = mock(async (_bankId: string, id: string, options: { tags: string[] }) => ({ id, tags: options.tags }));
const deleteDocument = mock(async (_bankId: string, _id: string) => true);
const listMentalModels = mock(async (_bankId: string) => ({ items: [] as HindsightMentalModel[] }));
const createMentalModel = mock(async (_bankId: string, name: string, sourceQuery: string) => ({ operation_id: `op-${name}-${sourceQuery}` }));
const refreshMentalModel = mock(async (_bankId: string, id: string) => ({ operation_id: `refresh-${id}` }));
const deleteMentalModel = mock(async (_bankId: string, _id: string) => true);

const createHindsightClient = mock(() => ({
	recall,
	listMemories,
	listDocuments,
	getDocument,
	updateDocument,
	deleteDocument,
	listMentalModels,
	createMentalModel,
	refreshMentalModel,
	deleteMentalModel,
}));

mock.module("@oh-my-pi/pi-coding-agent/hindsight/config", () => ({ loadHindsightConfig, isHindsightConfigured }));
mock.module("@oh-my-pi/pi-coding-agent/hindsight/bank", () => ({ computeBankScope }));
mock.module("@oh-my-pi/pi-coding-agent/hindsight/client", () => ({
	createHindsightClient,
	HindsightError: FakeHindsightError,
	HindsightApi: class {},
}));

// `mock.module` above must register before `routes-memory.ts` (which transitively
// imports the mocked hindsight subpaths via `hindsight-explorer.ts`) is loaded —
// a static top-level import would resolve the real modules first.
const { buildMemoryRouter } = await import("./routes-memory.ts");

let originalHome: string | undefined;
let fakeHome: string;
let allowedCwd: string;
let settings: Settings;
let initSpy: RestorableSpy;
let setSpy: RestorableSpy;
let flushSpy: RestorableSpy;

const isCwdAllowed = (candidate: string): boolean => candidate === allowedCwd;

beforeEach(() => {
	originalHome = process.env.HOME;
	fakeHome = mkdtempSync(path.join(os.tmpdir(), "omp-deck-memory-home-"));
	allowedCwd = path.join(fakeHome, "workspace");
	mkdirSync(allowedCwd);
	process.env.HOME = fakeHome;

	hindsightConfig = { hindsightApiUrl: null, scoping: "per-project" };
	settings = Settings.isolated();
	initSpy = spyOn(Settings, "init").mockResolvedValue(settings);
	setSpy = spyOn(settings, "set");
	flushSpy = spyOn(settings, "flush");
	for (const fn of [loadHindsightConfig, isHindsightConfigured, computeBankScope, createHindsightClient, recall, listMemories, listDocuments, getDocument, updateDocument, deleteDocument, listMentalModels, createMentalModel, refreshMentalModel, deleteMentalModel]) {
		fn.mockClear();
	}
});

afterEach(() => {
	initSpy.mockRestore();
	setSpy.mockRestore();
	flushSpy.mockRestore();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(fakeHome, { recursive: true, force: true });
});

describe("memory settings governance routes (T-34)", () => {
	test("GET exposes exactly the ten governed keys and never a credential-shaped setting", async () => {
		const app = buildMemoryRouter(isCwdAllowed);
		const res = await app.request("/memory/settings");

		expect(res.status).toBe(200);
		const body = (await res.json()) as GetMemorySettingsResponse;
		expect(body.settings.map((entry) => entry.key)).toEqual([
			"memory.backend",
			"mnemopi.scoping",
			"mnemopi.autoRecall",
			"mnemopi.autoRetain",
			"hindsight.apiUrl",
			"hindsight.bankId",
			"hindsight.scoping",
			"hindsight.autoRecall",
			"hindsight.autoRetain",
			"hindsight.mentalModelsEnabled",
		]);
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("apiToken");
		expect(serialized).not.toContain("llmApiKey");
		expect(serialized).not.toContain("embeddingApiKey");
		expect(body.configPath).toBe(path.join(fakeHome, ".omp", "agent", "config.yml"));
	});

	test("GET reports an unset string setting as an empty value rather than throwing", async () => {
		const app = buildMemoryRouter(isCwdAllowed);
		const res = await app.request("/memory/settings");
		const body = (await res.json()) as GetMemorySettingsResponse;
		expect(body.settings.find((entry) => entry.key === "hindsight.bankId")).toMatchObject({
			type: "string",
			value: "",
			configured: false,
		});
	});

	test("PATCH rejects a credential-shaped key as unknown, never reading or writing it", async () => {
		const app = buildMemoryRouter(isCwdAllowed);
		const res = await app.request("/memory/settings", {
			method: "PATCH",
			body: JSON.stringify({ updates: { "hindsight.apiToken": "sk-leak-me" } }),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "unknown memory setting: hindsight.apiToken" });
		expect(setSpy).not.toHaveBeenCalled();
		expect(flushSpy).not.toHaveBeenCalled();
	});

	for (const { name, updates, error } of [
		{ name: "an unknown key", updates: { "memory.autolearn": true }, error: "unknown memory setting: memory.autolearn" },
		{
			name: "an invalid backend enum value",
			updates: { "memory.backend": "vector-db" },
			error: "memory.backend must be one of: off, local, hindsight, mnemopi",
		},
		{ name: "a non-boolean auto-recall value", updates: { "mnemopi.autoRecall": "yes" }, error: "mnemopi.autoRecall must be a boolean" },
	]) {
		test(`PATCH rejects ${name} without changing OMP settings`, async () => {
			const app = buildMemoryRouter(isCwdAllowed);
			const res = await app.request("/memory/settings", { method: "PATCH", body: JSON.stringify({ updates }) });

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error });
			expect(setSpy).not.toHaveBeenCalled();
			expect(flushSpy).not.toHaveBeenCalled();
		});
	}

	test("PATCH persists an allowed setting and returns its new effective value", async () => {
		const app = buildMemoryRouter(isCwdAllowed);
		const res = await app.request("/memory/settings", {
			method: "PATCH",
			body: JSON.stringify({ updates: { "memory.backend": "hindsight", "hindsight.autoRecall": false } }),
		});

		expect(res.status).toBe(200);
		expect(setSpy).toHaveBeenCalledTimes(2);
		expect(setSpy).toHaveBeenCalledWith("memory.backend", "hindsight");
		expect(setSpy).toHaveBeenCalledWith("hindsight.autoRecall", false);
		expect(flushSpy).toHaveBeenCalledTimes(1);
		const body = (await res.json()) as GetMemorySettingsResponse;
		expect(body.settings.find((entry) => entry.key === "memory.backend")).toMatchObject({ value: "hindsight", configured: true });
		expect(body.settings.find((entry) => entry.key === "hindsight.autoRecall")).toMatchObject({ value: false, configured: true });
	});
});

describe("memory scope route (T-34)", () => {
	test("rejects a cwd outside the allowed workspace set", async () => {
		const app = buildMemoryRouter(isCwdAllowed);
		const res = await app.request(`/memory/scope?cwd=${encodeURIComponent("/outside")}`);
		expect(res.status).toBe(400);
	});

	test("reports mnemopi as configured but not sessionlessly explorable", async () => {
		settings.set("memory.backend", "mnemopi");
		const app = buildMemoryRouter(isCwdAllowed);
		const res = await app.request(`/memory/scope?cwd=${encodeURIComponent(allowedCwd)}`);

		expect(res.status).toBe(200);
		const body = (await res.json()) as MemoryScopeStatus;
		expect(body).toMatchObject({ backend: "mnemopi", explorable: false });
		expect(body.message).toContain("live OMP agent session");
	});

	test("reports hindsight as explorable with a server-computed bank id once configured", async () => {
		settings.set("memory.backend", "hindsight");
		hindsightConfig = { hindsightApiUrl: "https://hindsight.example", scoping: "per-project" };
		const app = buildMemoryRouter(isCwdAllowed);
		const res = await app.request(`/memory/scope?cwd=${encodeURIComponent(allowedCwd)}`);

		expect(res.status).toBe(200);
		const body = (await res.json()) as MemoryScopeStatus;
		expect(body).toEqual({
			cwd: allowedCwd,
			backend: "hindsight",
			explorable: true,
			bankId: `bank-${path.basename(allowedCwd)}`,
			scoping: "per-project",
		});
	});
});

describe("hindsight explorer routes (T-34)", () => {
	test("every route requires cwd and validates it against the allowed workspace set", async () => {
		const app = buildMemoryRouter(isCwdAllowed);
		const missing = await app.request("/memory/hindsight/memories");
		expect(missing.status).toBe(400);

		const disallowed = await app.request(`/memory/hindsight/memories?cwd=${encodeURIComponent("/outside")}`);
		expect(disallowed.status).toBe(400);
		expect(createHindsightClient).not.toHaveBeenCalled();
	});

	test("refuses to browse or mutate Hindsight while a different backend is active", async () => {
		settings.set("memory.backend", "mnemopi");
		hindsightConfig = { hindsightApiUrl: "https://hindsight.example", scoping: "per-project" };
		const app = buildMemoryRouter(isCwdAllowed);

		const res = await app.request(`/memory/hindsight/documents/doc-1?cwd=${encodeURIComponent(allowedCwd)}`, { method: "DELETE" });

		expect(res.status).toBe(409);
		expect(deleteDocument).not.toHaveBeenCalled();
	});

	test("reports 409 when hindsight is active but hindsight.apiUrl is unset", async () => {
		settings.set("memory.backend", "hindsight");
		const app = buildMemoryRouter(isCwdAllowed);

		const res = await app.request(`/memory/hindsight/memories?cwd=${encodeURIComponent(allowedCwd)}`);
		expect(res.status).toBe(409);
	});

	describe("with hindsight active and configured", () => {
		beforeEach(() => {
			settings.set("memory.backend", "hindsight");
			hindsightConfig = { hindsightApiUrl: "https://hindsight.example", scoping: "per-project" };
		});

		test("recall traces results against the server-derived bank id, never a client-supplied one", async () => {
			recall.mockImplementationOnce(async (bankId: string, query: string) => ({
				query,
				results: [{ id: "m1", text: "remembered fact", type: "fact", mentioned_at: "2026-07-01T00:00:00Z", bankSeen: bankId }],
			}));
			const app = buildMemoryRouter(isCwdAllowed);

			const res = await app.request(`/memory/hindsight/recall?cwd=${encodeURIComponent(allowedCwd)}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "what did we decide about auth", bankId: "attacker-controlled-bank" }),
			});

			expect(res.status).toBe(200);
			const expectedBankId = `bank-${path.basename(allowedCwd)}`;
			expect(recall).toHaveBeenCalledWith(expectedBankId, "what did we decide about auth", { budget: undefined, maxTokens: undefined });
			const body = await res.json();
			expect(body).toMatchObject({ bankId: expectedBankId, query: "what did we decide about auth" });
		});

		test("recall requires a non-empty query", async () => {
			const app = buildMemoryRouter(isCwdAllowed);
			const res = await app.request(`/memory/hindsight/recall?cwd=${encodeURIComponent(allowedCwd)}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
			expect(recall).not.toHaveBeenCalled();
		});

		test("listMemories forwards q/type/limit/offset query params", async () => {
			const app = buildMemoryRouter(isCwdAllowed);
			await app.request(
				`/memory/hindsight/memories?cwd=${encodeURIComponent(allowedCwd)}&q=auth&type=fact&limit=5&offset=10`,
			);
			expect(listMemories).toHaveBeenCalledWith(`bank-${path.basename(allowedCwd)}`, { q: "auth", type: "fact", limit: 5, offset: 10 });
		});

		test("GET document maps a null result to 404", async () => {
			const app = buildMemoryRouter(isCwdAllowed);
			const res = await app.request(`/memory/hindsight/documents/missing?cwd=${encodeURIComponent(allowedCwd)}`);
			expect(res.status).toBe(404);
		});

		test("PATCH document rejects a non-array tags payload", async () => {
			const app = buildMemoryRouter(isCwdAllowed);
			const res = await app.request(`/memory/hindsight/documents/doc-1?cwd=${encodeURIComponent(allowedCwd)}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ tags: "not-an-array" }),
			});
			expect(res.status).toBe(400);
			expect(updateDocument).not.toHaveBeenCalled();
		});

		test("PATCH document updates tags on the resolved bank", async () => {
			const app = buildMemoryRouter(isCwdAllowed);
			const res = await app.request(`/memory/hindsight/documents/doc-1?cwd=${encodeURIComponent(allowedCwd)}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ tags: ["reviewed"] }),
			});
			expect(res.status).toBe(200);
			expect(updateDocument).toHaveBeenCalledWith(`bank-${path.basename(allowedCwd)}`, "doc-1", { tags: ["reviewed"] });
		});

		test("DELETE document reports ok on success", async () => {
			const app = buildMemoryRouter(isCwdAllowed);
			const res = await app.request(`/memory/hindsight/documents/doc-1?cwd=${encodeURIComponent(allowedCwd)}`, { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		});

		test("POST mental model requires both name and sourceQuery", async () => {
			const app = buildMemoryRouter(isCwdAllowed);
			const res = await app.request(`/memory/hindsight/mental-models?cwd=${encodeURIComponent(allowedCwd)}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "project-conventions" }),
			});
			expect(res.status).toBe(400);
			expect(createMentalModel).not.toHaveBeenCalled();
		});

		test("POST mental model creates it on the resolved bank", async () => {
			const app = buildMemoryRouter(isCwdAllowed);
			const res = await app.request(`/memory/hindsight/mental-models?cwd=${encodeURIComponent(allowedCwd)}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "project-conventions", sourceQuery: "what conventions apply here" }),
			});
			expect(res.status).toBe(200);
			expect(createMentalModel).toHaveBeenCalledWith(`bank-${path.basename(allowedCwd)}`, "project-conventions", "what conventions apply here", {
				tags: undefined,
				maxTokens: undefined,
			});
		});

		test("DELETE mental model reports ok on success", async () => {
			const app = buildMemoryRouter(isCwdAllowed);
			const res = await app.request(`/memory/hindsight/mental-models/mm-1?cwd=${encodeURIComponent(allowedCwd)}`, { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(deleteMentalModel).toHaveBeenCalledWith(`bank-${path.basename(allowedCwd)}`, "mm-1");
		});

		test("maps an upstream Hindsight failure to 502 without leaking the raw error object", async () => {
			recall.mockImplementationOnce(async () => {
				throw new FakeHindsightError("bank not found", 404);
			});
			const app = buildMemoryRouter(isCwdAllowed);
			const res = await app.request(`/memory/hindsight/recall?cwd=${encodeURIComponent(allowedCwd)}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "anything" }),
			});
			expect(res.status).toBe(502);
			expect(await res.json()).toEqual({ error: "Hindsight request failed: bank not found" });
		});
	});
});
