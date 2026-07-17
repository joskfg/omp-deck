/**
 * /api/policies — model roles, retry/fallback, and auto-compaction
 * administration (T-36).
 *
 * Policy governance is a projection of OMP's own settings store, same
 * pattern as delegation governance (T-28, `routes-delegation.ts`) and memory
 * governance (T-34, `routes-memory.ts`): the deck never persists a second
 * copy, updates write through the SDK `Settings` singleton to
 * `~/.omp/agent/config.yml`.
 *
 * `modelRoles` and `retry.fallbackChains` are the schema's two record-shaped
 * settings in scope here — role id → model selector string(s) rather than a
 * scalar. Submitting an empty string (or empty array) for a role clears that
 * role's entry instead of persisting a blank value.
 */
import { Hono } from "hono";
import * as os from "node:os";
import * as path from "node:path";
import type {
	GetPolicySettingsResponse,
	PatchPolicySettingsRequest,
	PolicyModelRoleInfo,
	PolicySettingEntry,
	PolicySettingKey,
	PolicySettingValue,
} from "@omp-deck/protocol";
import { SETTINGS_SCHEMA, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getKnownRoleIds, getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";

const POLICY_SETTING_KEYS = [
	"modelRoles",
	"defaultThinkingLevel",
	"retry.enabled",
	"retry.maxRetries",
	"retry.baseDelayMs",
	"retry.maxDelayMs",
	"retry.modelFallback",
	"retry.fallbackChains",
	"retry.fallbackRevertPolicy",
	"compaction.enabled",
	"compaction.midTurnEnabled",
	"compaction.strategy",
	"compaction.thresholdPercent",
	"compaction.thresholdTokens",
	"compaction.handoffSaveToDisk",
	"compaction.autoContinue",
] as const satisfies readonly PolicySettingKey[];

/** Inclusive lower bound for number-typed settings that aren't simply "0 or more". */
const NUMBER_MIN: Partial<Record<PolicySettingKey, number>> = {
	"retry.maxRetries": 0,
	"retry.baseDelayMs": 0,
	"retry.maxDelayMs": 0,
	// -1 is the "use legacy reserve-based default" sentinel these two settings ship with.
	"compaction.thresholdPercent": -1,
	"compaction.thresholdTokens": -1,
};

/** Inclusive upper bound, where the setting has a natural ceiling. */
const NUMBER_MAX: Partial<Record<PolicySettingKey, number>> = {
	"compaction.thresholdPercent": 100,
};

/** Normalized view of the `SETTINGS_SCHEMA` shape actually used here — the schema's real per-key literal types don't unify cleanly across a mixed record/enum/boolean/number key set. */
interface PolicySchemaEntry {
	type: "record" | "number" | "enum" | "boolean";
	default?: unknown;
	values?: readonly string[];
	ui?: {
		label?: string;
		description?: string;
		options?: readonly { value: string; label: string; description?: string }[];
	};
}

export function buildPoliciesRouter(): Hono {
	const app = new Hono();

	app.get("/policies/settings", async (c) => c.json(await buildSettingsResponse()));

	app.patch("/policies/settings", async (c) => {
		let body: PatchPolicySettingsRequest;
		try {
			body = (await c.req.json()) as PatchPolicySettingsRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.updates || typeof body.updates !== "object" || Array.isArray(body.updates)) {
			return c.json({ error: "updates must be an object" }, 400);
		}

		const cleaned: Array<[PolicySettingKey, PolicySettingValue]> = [];
		for (const [rawKey, rawValue] of Object.entries(body.updates)) {
			if (!POLICY_SETTING_KEYS.includes(rawKey as PolicySettingKey)) {
				return c.json({ error: `unknown policy setting: ${rawKey}` }, 400);
			}
			const key = rawKey as PolicySettingKey;

			if (key === "modelRoles") {
				const parsed = parseStringRecord(rawValue);
				if (!parsed) return c.json({ error: "modelRoles must be an object mapping role ids to model selector strings" }, 400);
				cleaned.push([key, parsed]);
				continue;
			}
			if (key === "retry.fallbackChains") {
				const parsed = parseStringArrayRecord(rawValue);
				if (!parsed) return c.json({ error: "retry.fallbackChains must be an object mapping role ids to arrays of model selector strings" }, 400);
				cleaned.push([key, parsed]);
				continue;
			}

			const schema = SETTINGS_SCHEMA[key] as PolicySchemaEntry;
			if (schema.type === "number") {
				const value = typeof rawValue === "number" ? rawValue : typeof rawValue === "string" ? Number(rawValue) : Number.NaN;
				const min = NUMBER_MIN[key] ?? 0;
				const max = NUMBER_MAX[key];
				if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
					return c.json({ error: `${key} must be an integer between ${min} and ${max ?? "∞"}` }, 400);
				}
				cleaned.push([key, value]);
				continue;
			}
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
			return c.json({ error: `${key} has an unsupported setting type` }, 400);
		}

		const settings = await Settings.init();
		for (const [key, value] of cleaned) settings.set(key, value as never);
		await settings.flush();
		return c.json(await buildSettingsResponse(settings));
	});

	return app;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses a role→model-selector record, dropping (not rejecting) blank entries so clearing a field unassigns the role. */
function parseStringRecord(value: unknown): Record<string, string> | null {
	if (!isPlainObject(value)) return null;
	const result: Record<string, string> = {};
	for (const [role, modelId] of Object.entries(value)) {
		if (typeof modelId !== "string") return null;
		const trimmed = modelId.trim();
		if (trimmed) result[role] = trimmed;
	}
	return result;
}

/** Parses a role→ordered-model-selectors record, dropping blank/empty entries so clearing a field unassigns the role's fallback chain. */
function parseStringArrayRecord(value: unknown): Record<string, string[]> | null {
	if (!isPlainObject(value)) return null;
	const result: Record<string, string[]> = {};
	for (const [role, chain] of Object.entries(value)) {
		if (!Array.isArray(chain) || !chain.every((entry) => typeof entry === "string")) return null;
		const cleaned = chain.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
		if (cleaned.length > 0) result[role] = cleaned;
	}
	return result;
}

async function buildSettingsResponse(existing?: Settings): Promise<GetPolicySettingsResponse> {
	const settings = existing ?? (await Settings.init());
	const configPath = path.join(process.env.HOME ?? os.homedir(), ".omp", "agent", "config.yml");
	const entries: PolicySettingEntry[] = POLICY_SETTING_KEYS.map((key) => {
		const schema = SETTINGS_SCHEMA[key] as PolicySchemaEntry;
		const ui = schema.ui;
		const raw = settings.get(key) as PolicySettingValue | undefined;
		const value = raw !== undefined ? raw : schema.type === "boolean" ? false : schema.type === "number" ? 0 : schema.type === "record" ? {} : "";
		const configured = settings.isConfigured(key);
		return {
			key,
			type: schema.type,
			value,
			defaultValue: (schema.default ?? null) as PolicySettingEntry["defaultValue"],
			configured,
			origin: configured ? "omp-config" : "schema-default",
			label: ui?.label ?? key,
			description: ui?.description ?? "",
			options: ui?.options?.map((option) => ({ ...option })),
		};
	});

	const roles: PolicyModelRoleInfo[] = getKnownRoleIds(settings).map((id) => {
		const info = getRoleInfo(id, settings);
		return {
			id,
			name: info.name,
			tag: info.tag,
			assignedModel: settings.getModelRole(id),
		};
	});

	return {
		settings: entries,
		roles,
		configPath,
	};
}
