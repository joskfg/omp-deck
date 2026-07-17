/**
 * Exercises the real Hono router for the internal task model setting and the
 * KB env schema contract. Each assertion covers a persisted API contract
 * rather than the router's internal storage wiring.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { InternalTaskModelResponse, ListEnvSettingsResponse, ModelInfo } from "@omp-deck/protocol";

import { closeDb, openDb } from "./db/index.ts";
import { ENV_SCHEMA_BY_KEY } from "./env-schema.ts";
import { buildSettingsRouter } from "./routes-settings.ts";
import type { Config } from "./config.ts";
import type { AgentBridge } from "./bridge/types.ts";

let dbDir: string;

const AVAILABLE_MODEL: ModelInfo = {
	provider: "anthropic",
	id: "claude-good",
	label: "Claude Good",
	isAvailable: true,
};

function fakeBridge(models: ModelInfo[] = [AVAILABLE_MODEL]): AgentBridge {
	return {
		async listModels() {
			return models;
		},
	} as unknown as AgentBridge;
}

function fakeConfig(): Config {
	return { port: 8787 } as Config;
}

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-settings-internal-task-model-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
});

afterEach(() => {
	closeDb();
	try {
		fs.rmSync(dbDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

describe("GET /settings/internal-task-model", () => {
	test("returns model: null when unset", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const res = await app.request("/settings/internal-task-model");
		expect(res.status).toBe(200);
		const body = (await res.json()) as InternalTaskModelResponse;
		expect(body).toEqual({ model: null });
	});
});

describe("PUT /settings/internal-task-model", () => {
	test("persists a catalog model and GET reflects it afterward", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const putRes = await app.request("/settings/internal-task-model", {
			method: "PUT",
			body: JSON.stringify({ model: { provider: "anthropic", id: "claude-good" } }),
		});
		expect(putRes.status).toBe(200);
		expect((await putRes.json()) as InternalTaskModelResponse).toEqual({
			model: { provider: "anthropic", id: "claude-good" },
		});

		const getRes = await app.request("/settings/internal-task-model");
		expect((await getRes.json()) as InternalTaskModelResponse).toEqual({
			model: { provider: "anthropic", id: "claude-good" },
		});
	});

	test("model: null clears a previously-persisted override", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		await app.request("/settings/internal-task-model", {
			method: "PUT",
			body: JSON.stringify({ model: { provider: "anthropic", id: "claude-good" } }),
		});

		const clearRes = await app.request("/settings/internal-task-model", {
			method: "PUT",
			body: JSON.stringify({ model: null }),
		});
		expect(clearRes.status).toBe(200);
		expect((await clearRes.json()) as InternalTaskModelResponse).toEqual({ model: null });

		const getRes = await app.request("/settings/internal-task-model");
		expect((await getRes.json()) as InternalTaskModelResponse).toEqual({ model: null });
	});

	for (const [name, body] of [
		["missing id", { model: { provider: "anthropic" } }],
		["missing provider", { model: { id: "claude-good" } }],
		["non-object model", { model: "claude-good" }],
	] as const) {
		test(`rejects a malformed model shape (${name})`, async () => {
			const app = buildSettingsRouter(fakeBridge(), fakeConfig());
			const res = await app.request("/settings/internal-task-model", {
				method: "PUT",
				body: JSON.stringify(body),
			});
			expect(res.status).toBe(400);
		});
	}

	test("rejects a model that is not present in the bridge's catalog", async () => {
		const app = buildSettingsRouter(fakeBridge([AVAILABLE_MODEL]), fakeConfig());
		const res = await app.request("/settings/internal-task-model", {
			method: "PUT",
			body: JSON.stringify({ model: { provider: "openai", id: "not-in-catalog" } }),
		});
		expect(res.status).toBe(400);

		const getRes = await app.request("/settings/internal-task-model");
		expect((await getRes.json()) as InternalTaskModelResponse).toEqual({ model: null });
	});

	test("rejects an invalid json body", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const res = await app.request("/settings/internal-task-model", { method: "PUT", body: "not json" });
		expect(res.status).toBe(400);
	});
});

describe("ENV_SCHEMA KB path contract (T-108)", () => {
	test("OMP_DECK_KB_ROOT is present in ENV_SCHEMA", () => {
		expect(ENV_SCHEMA_BY_KEY.has("OMP_DECK_KB_ROOT")).toBe(true);
	});

	test("OMP_DECK_KB_ROOT entry is a non-sensitive path var", () => {
		const entry = ENV_SCHEMA_BY_KEY.get("OMP_DECK_KB_ROOT")!;
		expect(entry.valueType).toBe("path");
		expect(entry.sensitive).toBe(false);
	});

	test("OMP_DECK_ORG_ROOT description references OMP_DECK_KB_ROOT not a bare hardcoded path", () => {
		const entry = ENV_SCHEMA_BY_KEY.get("OMP_DECK_ORG_ROOT")!;
		expect(entry.description).toMatch(/OMP_DECK_KB_ROOT/);
	});

	test("GET /settings/env includes an entry for OMP_DECK_KB_ROOT with correct value", async () => {
		const tmpKb = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-t108-kb-"));
		const savedKbRoot = process.env.OMP_DECK_KB_ROOT;
		process.env.OMP_DECK_KB_ROOT = tmpKb;
		try {
			const app = buildSettingsRouter(fakeBridge(), fakeConfig());
			const res = await app.request("/settings/env");
			expect(res.status).toBe(200);
			const body = (await res.json()) as ListEnvSettingsResponse;
			const kbEntry = body.entries.find((e) => e.key === "OMP_DECK_KB_ROOT");
			expect(kbEntry).toBeDefined();
			expect(kbEntry!.masked).toBe(tmpKb);
			expect(kbEntry!.source).toBe("process-env");
		} finally {
			if (savedKbRoot === undefined) delete process.env.OMP_DECK_KB_ROOT;
			else process.env.OMP_DECK_KB_ROOT = savedKbRoot;
			fs.rmSync(tmpKb, { recursive: true, force: true });
		}
	});

	test("GET /settings/env OMP_DECK_ORG_ROOT entry description references OMP_DECK_KB_ROOT", async () => {
		const app = buildSettingsRouter(fakeBridge(), fakeConfig());
		const res = await app.request("/settings/env");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListEnvSettingsResponse;
		const orgEntry = body.entries.find((e) => e.key === "OMP_DECK_ORG_ROOT");
		expect(orgEntry).toBeDefined();
		expect(orgEntry!.description).toMatch(/OMP_DECK_KB_ROOT/);
	});
});
