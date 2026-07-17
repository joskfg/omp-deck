import { Hono } from "hono";
import * as os from "node:os";
import * as path from "node:path";
import type {
	DeckBaseUrlResponse,
	EnvEntry,
	EnvValueSource,
	InternalTaskModelResponse,
	PlanModelResponse,
	ListEnvSettingsResponse,
	PatchEnvSettingsRequest,
	PatchEnvSettingsResponse,
	RestartServerResponse,
	RevealEnvValueResponse,
	SetDeckBaseUrlRequest,
	SetInternalTaskModelRequest,
	SetPlanModelRequest,
	SetTaskRewriteModelRequest,
	TaskRewriteModelResponse,
} from "@omp-deck/protocol";

import type { Config } from "./config.ts";
import { parseInt10, splitList } from "./config.ts";
import { ENV_SCHEMA, ENV_SCHEMA_BY_KEY, type EnvSchemaEntry, validateEnvValue } from "./env-schema.ts";
import {
	MANAGED_ENV_KEYS_LOADED,
	appendEnvAudit,
	applyManagedEnvUpdatesToProcess,
	getDataDir,
	getManagedEnvPath,
	readManagedEnvFile,
	writeManagedEnvUpdates,
} from "./env-store.ts";
import { getDeckBaseUrl, getInternalTaskModel, getPlanModel, getTaskRewriteModel, setDeckBaseUrl, setInternalTaskModel, setPlanModel, setTaskRewriteModel } from "./db/server-settings.ts";
import { setLogLevel } from "./log.ts";
import type { AgentBridge } from "./bridge/types.ts";

export function buildSettingsRouter(
	bridge: AgentBridge,
	config: Config,
	opts: { restartServer?: () => RestartServerResponse } = {},
): Hono {
	const app = new Hono();

	app.get("/settings/env", (c) => c.json(buildEnvResponse()));

	app.get("/settings/env/:key", async (c) => {
		if (c.req.query("reveal") !== "1") return c.json({ error: "reveal=1 required" }, 400);
		if (!isLoopbackRequest(c.req.raw)) return c.json({ error: "secret reveal requires loopback" }, 403);
		const key = c.req.param("key");
		const entry = ENV_SCHEMA_BY_KEY.get(key);
		if (!entry) return c.json({ error: "unknown env key" }, 404);
		const current = resolveEntry(entry);
		await appendEnvAudit("reveal", [key]);
		const body: RevealEnvValueResponse = {
			key,
			value: current.value ?? "",
			masked: maskValue(current.value ?? "", entry.sensitive),
			isSet: isNonEmpty(current.value),
			source: current.source,
		};
		return c.json(body);
	});

	app.patch("/settings/env", async (c) => {
		let body: PatchEnvSettingsRequest;
		try {
			body = (await c.req.json()) as PatchEnvSettingsRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const updates = body.updates ?? {};
		const clean: Record<string, string | null> = {};
		for (const [key, value] of Object.entries(updates)) {
			const entry = ENV_SCHEMA_BY_KEY.get(key);
			if (!entry) return c.json({ error: `unknown env key: ${key}` }, 400);
			if (value !== null && typeof value !== "string") {
				return c.json({ error: `invalid env value for ${key}` }, 400);
			}
			if (value !== null) {
				const err = validateEnvValue(entry, value);
				if (err) return c.json({ error: `${key}: ${err}` }, 400);
			}
			clean[key] = value;
		}

		await writeManagedEnvUpdates(clean);
		applyManagedEnvUpdatesToProcess(clean);
		await appendEnvAudit("set", Object.keys(clean).filter((key) => clean[key] !== null));
		await appendEnvAudit("unset", Object.keys(clean).filter((key) => clean[key] === null));

		const appliedHot = applyHotUpdates(clean, bridge, config);
		const response = buildEnvResponse() as PatchEnvSettingsResponse;
		response.appliedHot = appliedHot;
		return c.json(response);
	});

	app.post("/server/restart", (c) => {
		if (!isLoopbackRequest(c.req.raw)) return c.json({ error: "restart requires loopback" }, 403);
		const resp = opts.restartServer?.() ?? { ok: false, message: "Restart is unavailable" };
		return c.json(resp);
	});

	app.get("/settings/deck-base-url", (c) => {
		const body: DeckBaseUrlResponse = getDeckBaseUrl(config);
		return c.json(body);
	});

	app.put("/settings/deck-base-url", async (c) => {
		let body: SetDeckBaseUrlRequest;
		try {
			body = (await c.req.json()) as SetDeckBaseUrlRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (body.deckBaseUrl !== null && typeof body.deckBaseUrl !== "string") {
			return c.json({ error: "deckBaseUrl must be a string or null" }, 400);
		}
		if (typeof body.deckBaseUrl === "string" && body.deckBaseUrl.trim() !== "") {
			try {
				new URL(body.deckBaseUrl.trim());
			} catch {
				return c.json({ error: "deckBaseUrl must be a valid absolute URL" }, 400);
			}
		}
		const response: DeckBaseUrlResponse = setDeckBaseUrl(config, body.deckBaseUrl);
		return c.json(response);
	});

	app.get("/settings/task-rewrite-model", (c) => {
		const model = getTaskRewriteModel();
		const body: TaskRewriteModelResponse = { model };
		return c.json(body);
	});

	app.put("/settings/task-rewrite-model", async (c) => {
		let body: SetTaskRewriteModelRequest;
		try {
			body = (await c.req.json()) as SetTaskRewriteModelRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (body.model !== null && (typeof body.model !== "object" || typeof body.model.provider !== "string" || typeof body.model.id !== "string")) {
			return c.json({ error: "model must be {provider: string, id: string} or null" }, 400);
		}
		if (body.model !== null) {
			const catalog = await bridge.listModels();
			const known = catalog.some((m) => m.provider === body.model!.provider && m.id === body.model!.id);
			if (!known) return c.json({ error: `model ${body.model.provider}/${body.model.id} is not in the available catalog` }, 400);
		}
		const model = setTaskRewriteModel(body.model);
		const resp: TaskRewriteModelResponse = { model };
		return c.json(resp);
	});

	app.get("/settings/internal-task-model", (c) => {
		const model = getInternalTaskModel();
		const body: InternalTaskModelResponse = { model };
		return c.json(body);
	});

	app.put("/settings/internal-task-model", async (c) => {
		let body: SetInternalTaskModelRequest;
		try {
			body = (await c.req.json()) as SetInternalTaskModelRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (body.model !== null && (typeof body.model !== "object" || typeof body.model.provider !== "string" || typeof body.model.id !== "string")) {
			return c.json({ error: "model must be {provider: string, id: string} or null" }, 400);
		}
		if (body.model !== null) {
			const catalog = await bridge.listModels();
			const known = catalog.some((m) => m.provider === body.model!.provider && m.id === body.model!.id);
			if (!known) return c.json({ error: `model ${body.model.provider}/${body.model.id} is not in the available catalog` }, 400);
		}
		const model = setInternalTaskModel(body.model);
		const resp: InternalTaskModelResponse = { model };
		return c.json(resp);
	});

	app.get("/settings/plan-model", (c) => {
		const cfg = getPlanModel();
		const body: PlanModelResponse = cfg
			? { model: { provider: cfg.provider, id: cfg.id }, thinking: cfg.thinking ?? null }
			: { model: null, thinking: null };
		return c.json(body);
	});

	app.put("/settings/plan-model", async (c) => {
		let body: SetPlanModelRequest;
		try {
			body = (await c.req.json()) as SetPlanModelRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (body.model !== null && (typeof body.model !== "object" || typeof body.model.provider !== "string" || typeof body.model.id !== "string")) {
			return c.json({ error: "model must be {provider: string, id: string} or null" }, 400);
		}
		if (body.thinking != null && typeof body.thinking !== "string") {
			return c.json({ error: "thinking must be a string or null" }, 400);
		}
		if (body.model !== null) {
			const catalog = await bridge.listModels();
			const known = catalog.some((m) => m.provider === body.model!.provider && m.id === body.model!.id);
			if (!known) return c.json({ error: `model ${body.model.provider}/${body.model.id} is not in the available catalog` }, 400);
		}
		const cfg = setPlanModel(
			body.model === null
				? null
				: { provider: body.model.provider, id: body.model.id, ...(body.thinking ? { thinking: body.thinking } : {}) },
		);
		const resp: PlanModelResponse = cfg
			? { model: { provider: cfg.provider, id: cfg.id }, thinking: cfg.thinking ?? null }
			: { model: null, thinking: null };
		return c.json(resp);
	});

	return app;
}

function buildEnvResponse(): ListEnvSettingsResponse {
	const entries = ENV_SCHEMA.map((entry) => toResponseEntry(entry));
	return {
		entries,
		envFilePath: getManagedEnvPath(),
		dataDir: getDataDir(),
		restartRequired: entries.some((entry) => entry.restartTarget === "server" && entry.source === "env-file"),
	};
}

function toResponseEntry(entry: EnvSchemaEntry): EnvEntry {
	const current = resolveEntry(entry);
	return {
		key: entry.key,
		masked: maskValue(current.value ?? "", entry.sensitive),
		isSet: isNonEmpty(current.value),
		source: current.source,
		...(entry.defaultValue !== undefined ? { defaultValue: entry.defaultValue } : {}),
		valueType: entry.valueType,
		sensitive: entry.sensitive,
		restartRequired: entry.restartRequired,
		hotApply: entry.hotApply,
		description: entry.description,
		...(entry.options ? { options: entry.options } : {}),
		...(entry.restartRequired ? { restartTarget: entry.restartTarget ?? "server" } : {}),
	};
}

function isNonEmpty(value: string | undefined): boolean {
	return value !== undefined && value !== "";
}

function resolveEntry(entry: EnvSchemaEntry): { source: EnvValueSource; value?: string } {
	const file = readManagedEnvFile();
	const fileValue = file.values.get(entry.key);
	const processValue = process.env[entry.key];
	if (processValue !== undefined && !(MANAGED_ENV_KEYS_LOADED.has(entry.key) && processValue === fileValue)) {
		return { source: "process-env", value: processValue };
	}
	if (fileValue !== undefined) return { source: "env-file", value: fileValue };
	if (entry.defaultValue !== undefined) return { source: "default", value: entry.defaultValue };
	return { source: "unset" };
}

function maskValue(value: string, sensitive: boolean): string {
	if (!value) return "unset";
	if (!sensitive) return value;
	const tail = value.slice(-4);
	return tail ? `••••••••${tail}` : "••••••••";
}

function applyHotUpdates(
	updates: Record<string, string | null>,
	bridge: AgentBridge,
	config: Config,
): string[] {
	const applied: string[] = [];
	const effective = new Map(ENV_SCHEMA.map((entry) => [entry.key, resolveEntry(entry).value]));

	if ("LOG_LEVEL" in updates) {
		if (setLogLevel(effective.get("LOG_LEVEL") ?? "info")) applied.push("LOG_LEVEL");
	}
	if ("OMP_DECK_IDLE_TIMEOUT_MS" in updates) {
		const next = parseInt10(effective.get("OMP_DECK_IDLE_TIMEOUT_MS"), 5 * 60_000);
		config.idleTimeoutMs = next;
		bridge.applyEnvUpdate?.({ idleTimeoutMs: next });
		applied.push("OMP_DECK_IDLE_TIMEOUT_MS");
	}
	if ("OMP_DECK_DEFAULT_CWD" in updates) {
		const next = effective.get("OMP_DECK_DEFAULT_CWD")?.trim() || os.homedir();
		config.defaultCwd = path.resolve(next);
		applied.push("OMP_DECK_DEFAULT_CWD");
	}
	if ("OMP_DECK_WORKSPACES" in updates) {
		config.extraWorkspaces = splitList(effective.get("OMP_DECK_WORKSPACES")).map((p) => path.resolve(p));
		applied.push("OMP_DECK_WORKSPACES");
	}
	return applied;
}

function isLoopbackRequest(req: Request): boolean {
	const host = new URL(req.url).hostname.toLowerCase();
	return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Best-effort sync of the canonical workspace list to `OMP_DECK_WORKSPACES`
 * in the managed env store (T-134). Returns `true` when the env var was
 * updated in-process, `false` when it is owned by the launching shell and
 * cannot be overwritten at runtime — callers fall back to the DB lists in
 * that case and still succeed.
 */
export async function syncWorkspacesToEnv(cwds: string[], config: Config): Promise<boolean> {
	// Shell-set vars are NOT in MANAGED_ENV_KEYS_LOADED; we must not clobber them.
	const ownedByManaged =
		MANAGED_ENV_KEYS_LOADED.has("OMP_DECK_WORKSPACES") || process.env.OMP_DECK_WORKSPACES === undefined;
	if (!ownedByManaged) return false;
	const newValue = cwds.length > 0 ? cwds.join(",") : null;
	await writeManagedEnvUpdates({ OMP_DECK_WORKSPACES: newValue });
	applyManagedEnvUpdatesToProcess({ OMP_DECK_WORKSPACES: newValue });
	config.extraWorkspaces = splitList(newValue ?? "").map((p) => path.resolve(p));
	return true;
}
