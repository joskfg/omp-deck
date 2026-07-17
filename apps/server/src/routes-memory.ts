import { Hono } from "hono";
import type { Context } from "hono";
import * as os from "node:os";
import * as path from "node:path";
import type {
	CreateHindsightMentalModelRequest,
	DeleteHindsightDocumentResponse,
	DeleteHindsightMentalModelResponse,
	GetMemorySettingsResponse,
	HindsightRecallRequest,
	MemorySettingEntry,
	MemorySettingKey,
	PatchMemorySettingsRequest,
	UpdateHindsightDocumentRequest,
} from "@omp-deck/protocol";
import { SETTINGS_SCHEMA, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

import { HindsightBackendInactiveError, HindsightError, HindsightExplorer, HindsightNotConfiguredError, getMemoryScopeStatus } from "./hindsight-explorer.ts";
import { cwdNotAllowedMessage } from "./routes-fs.ts";

/**
 * Memory governance is a projection of OMP's own settings store, same
 * pattern as delegation governance (T-28, `routes-delegation.ts`): the deck
 * never persists a second copy, updates write through the SDK `Settings`
 * singleton to `~/.omp/agent/config.yml`.
 *
 * Deliberately a narrow, curated key list — see the `MemorySettingKey` doc
 * comment in the protocol package for why credential-shaped fields
 * (`hindsight.apiToken`, `mnemopi.llmApiKey`, `mnemopi.embeddingApiKey`) are
 * excluded outright rather than masked.
 */
const MEMORY_SETTING_KEYS = [
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
] as const satisfies readonly MemorySettingKey[];

type MemoryValue = number | string | boolean;

/** Normalized view of the `SETTINGS_SCHEMA` shape actually used here — the schema's real per-key literal types don't unify cleanly across a mixed string/enum/boolean key set. */
interface MemorySchemaEntry {
	type: "string" | "number" | "enum" | "boolean";
	default?: unknown;
	values?: readonly string[];
	ui?: {
		label?: string;
		description?: string;
		options?: readonly { value: string; label: string; description?: string }[];
	};
}

class BadRequestError extends Error {}
class NotFoundError extends Error {}

export function buildMemoryRouter(isCwdAllowed: (cwd: string) => boolean): Hono {
	const app = new Hono();

	app.get("/memory/settings", async (c) => c.json(await buildSettingsResponse()));

	app.patch("/memory/settings", async (c) => {
		let body: PatchMemorySettingsRequest;
		try {
			body = (await c.req.json()) as PatchMemorySettingsRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.updates || typeof body.updates !== "object" || Array.isArray(body.updates)) {
			return c.json({ error: "updates must be an object" }, 400);
		}

		const cleaned: Array<[MemorySettingKey, MemoryValue]> = [];
		for (const [rawKey, rawValue] of Object.entries(body.updates)) {
			if (!MEMORY_SETTING_KEYS.includes(rawKey as MemorySettingKey)) {
				return c.json({ error: `unknown memory setting: ${rawKey}` }, 400);
			}
			const key = rawKey as MemorySettingKey;
			const schema = SETTINGS_SCHEMA[key] as MemorySchemaEntry;
			if (schema.type === "enum") {
				const values = schema.values ?? [];
				if (typeof rawValue !== "string" || !values.includes(rawValue)) {
					return c.json({ error: `${key} must be one of: ${values.join(", ")}` }, 400);
				}
				cleaned.push([key, rawValue]);
				continue;
			}
			if (schema.type === "boolean") {
				if (typeof rawValue !== "boolean") return c.json({ error: `${key} must be a boolean` }, 400);
				cleaned.push([key, rawValue]);
				continue;
			}
			if (schema.type === "string") {
				if (typeof rawValue !== "string") return c.json({ error: `${key} must be a string` }, 400);
				cleaned.push([key, rawValue.trim()]);
				continue;
			}
			return c.json({ error: `${key} has an unsupported setting type` }, 400);
		}

		const settings = await Settings.init();
		for (const [key, value] of cleaned) settings.set(key, value as never);
		await settings.flush();
		return c.json(await buildSettingsResponse(settings));
	});

	app.get("/memory/scope", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		if (!isCwdAllowed(cwd)) return c.json({ error: cwdNotAllowedMessage() }, 400);
		const settings = await Settings.init();
		return c.json(await getMemoryScopeStatus(settings, cwd));
	});

	app.get("/memory/hindsight/memories", (c) =>
		withExplorer(c, isCwdAllowed, (explorer) =>
			explorer.listMemories({
				q: c.req.query("q") || undefined,
				type: c.req.query("type") || undefined,
				limit: parsePositiveInt(c.req.query("limit")),
				offset: parsePositiveInt(c.req.query("offset")),
			}),
		),
	);

	app.post("/memory/hindsight/recall", (c) =>
		withExplorer(c, isCwdAllowed, async (explorer) => {
			const body = await parseJsonBody<HindsightRecallRequest>(c);
			if (!body.query || typeof body.query !== "string") throw new BadRequestError("query is required");
			return explorer.recall(body.query, { budget: body.budget, maxTokens: body.maxTokens });
		}),
	);

	app.get("/memory/hindsight/documents", (c) =>
		withExplorer(c, isCwdAllowed, (explorer) =>
			explorer.listDocuments({
				limit: parsePositiveInt(c.req.query("limit")),
				offset: parsePositiveInt(c.req.query("offset")),
			}),
		),
	);

	app.get("/memory/hindsight/documents/:id", (c) =>
		withExplorer(c, isCwdAllowed, async (explorer) => {
			const doc = await explorer.getDocument(c.req.param("id"));
			if (!doc) throw new NotFoundError("document not found");
			return doc;
		}),
	);

	app.patch("/memory/hindsight/documents/:id", (c) =>
		withExplorer(c, isCwdAllowed, async (explorer) => {
			const body = await parseJsonBody<UpdateHindsightDocumentRequest>(c);
			if (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === "string")) {
				throw new BadRequestError("tags must be a string array");
			}
			return explorer.updateDocument(c.req.param("id"), body.tags);
		}),
	);

	app.delete("/memory/hindsight/documents/:id", (c) =>
		withExplorer(c, isCwdAllowed, async (explorer) => {
			const ok = await explorer.deleteDocument(c.req.param("id"));
			return { ok } satisfies DeleteHindsightDocumentResponse;
		}),
	);

	app.get("/memory/hindsight/mental-models", (c) => withExplorer(c, isCwdAllowed, (explorer) => explorer.listMentalModels()));

	app.post("/memory/hindsight/mental-models", (c) =>
		withExplorer(c, isCwdAllowed, async (explorer) => {
			const body = await parseJsonBody<CreateHindsightMentalModelRequest>(c);
			if (!body.name?.trim() || !body.sourceQuery?.trim()) throw new BadRequestError("name and sourceQuery are required");
			return explorer.createMentalModel(body);
		}),
	);

	app.post("/memory/hindsight/mental-models/:id/refresh", (c) =>
		withExplorer(c, isCwdAllowed, (explorer) => explorer.refreshMentalModel(c.req.param("id"))),
	);

	app.delete("/memory/hindsight/mental-models/:id", (c) =>
		withExplorer(c, isCwdAllowed, async (explorer) => {
			const ok = await explorer.deleteMentalModel(c.req.param("id"));
			return { ok } satisfies DeleteHindsightMentalModelResponse;
		}),
	);

	return app;
}

/**
 * Shared per-route plumbing for every `/memory/hindsight/*` endpoint:
 * validates `cwd`, resolves a bank-scoped `HindsightExplorer`, and maps
 * thrown errors to HTTP status codes. Never proxies an upstream Hindsight
 * status code verbatim — those come from a third-party server the deck
 * doesn't fully trust the shape of.
 */
async function withExplorer<T>(
	c: Context,
	isCwdAllowed: (cwd: string) => boolean,
	handler: (explorer: HindsightExplorer) => Promise<T>,
): Promise<Response> {
	const cwd = c.req.query("cwd")?.trim();
	if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
	if (!isCwdAllowed(cwd)) return c.json({ error: cwdNotAllowedMessage() }, 400);

	try {
		const settings = await Settings.init();
		const explorer = HindsightExplorer.forCwd(settings, cwd);
		return c.json(await handler(explorer));
	} catch (error) {
		if (error instanceof BadRequestError) return c.json({ error: error.message }, 400);
		if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
		if (error instanceof HindsightBackendInactiveError) return c.json({ error: error.message }, 409);
		if (error instanceof HindsightNotConfiguredError) return c.json({ error: error.message }, 409);
		if (error instanceof HindsightError) return c.json({ error: `Hindsight request failed: ${error.message}` }, 502);
		return c.json({ error: `Hindsight request failed: ${String(error)}` }, 502);
	}
}

async function parseJsonBody<T>(c: Context): Promise<T> {
	try {
		return (await c.req.json()) as T;
	} catch {
		throw new BadRequestError("invalid json body");
	}
}

function parsePositiveInt(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}

async function buildSettingsResponse(existing?: Settings): Promise<GetMemorySettingsResponse> {
	const settings = existing ?? (await Settings.init());
	const entries: MemorySettingEntry[] = MEMORY_SETTING_KEYS.map((key) => {
		const schema = SETTINGS_SCHEMA[key] as MemorySchemaEntry;
		const ui = schema.ui;
		const raw = settings.get(key) as MemoryValue | undefined;
		const value = raw !== undefined ? raw : schema.type === "boolean" ? false : "";
		return {
			key,
			type: schema.type,
			value,
			defaultValue: (schema.default ?? null) as MemorySettingEntry["defaultValue"],
			configured: settings.isConfigured(key),
			label: ui?.label ?? key,
			description: ui?.description ?? "",
			options: ui?.options?.map((option) => ({ ...option })),
		};
	});
	return { settings: entries, configPath: path.join(process.env.HOME ?? os.homedir(), ".omp", "agent", "config.yml") };
}
