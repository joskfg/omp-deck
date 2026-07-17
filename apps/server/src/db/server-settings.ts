/**
 * Generic global key/value settings store (T-61). Unlike
 * `workspace-preferences.ts` / `auto-work.ts`, these settings are not keyed
 * by workspace cwd — one value per key, server-wide.
 *
 * Add typed wrappers around `getServerSetting` / `setServerSetting` as new
 * global settings show up rather than growing ad-hoc tables per setting.
 * Current consumers: `deckBaseUrl` (T-61), `taskRewriteModel` (T-76), `internalTaskModel` (T-78),
 * `planModel` (T-30), `extraWorkspaces`, `hiddenWorkspaces` (T-134).
 */

import type { Config } from "../config.ts";
import { getDb, nowIso } from "./index.ts";

const DECK_BASE_URL_KEY = "deckBaseUrl";

interface Row {
	value: string;
}

/** Raw KV read. Returns `undefined` when `key` has never been set. */
export function getServerSetting(key: string): string | undefined {
	const row = getDb().query<Row, [string]>("SELECT value FROM server_settings WHERE key = ?").get(key) as
		| Row
		| null;
	return row?.value;
}

/** Raw KV upsert. */
export function setServerSetting(key: string, value: string): void {
	getDb()
		.prepare<unknown, [string, string, string]>(
			`INSERT INTO server_settings (key, value, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.run(key, value, nowIso());
}

/** Deletes `key`, reverting any dependent typed getter back to its computed default. */
export function deleteServerSetting(key: string): void {
	getDb().prepare<unknown, [string]>("DELETE FROM server_settings WHERE key = ?").run(key);
}

/**
 * The base URL used to build session deep links (e.g. from the auto-work
 * completion flow — see `buildSessionUrl` in `../deck-links.ts`). Falls back
 * to `http://localhost:${config.port}` when nothing has been persisted, so
 * the feature works out of the box on a fresh install.
 */
export function getDeckBaseUrl(config: Config): { deckBaseUrl: string; isCustom: boolean } {
	const stored = getServerSetting(DECK_BASE_URL_KEY);
	if (stored !== undefined && stored !== "") {
		return { deckBaseUrl: stored, isCustom: true };
	}
	return { deckBaseUrl: `http://localhost:${config.port}`, isCustom: false };
}

/** `value: null` (or empty string) clears the override, reverting to the computed default. */
export function setDeckBaseUrl(config: Config, value: string | null): { deckBaseUrl: string; isCustom: boolean } {
	const trimmed = value?.trim() ?? "";
	if (trimmed === "") {
		deleteServerSetting(DECK_BASE_URL_KEY);
	} else {
		setServerSetting(DECK_BASE_URL_KEY, trimmed);
	}
	return getDeckBaseUrl(config);
}

const TASK_REWRITE_MODEL_KEY = "taskRewriteModel";

export type ModelRefRaw = { provider: string; id: string };

/**
 * Returns the configured model for task rewriting, or `null` when none has
 * been persisted (the caller should fall back to the SDK default).
 */
export function getTaskRewriteModel(): ModelRefRaw | null {
	const stored = getServerSetting(TASK_REWRITE_MODEL_KEY);
	if (!stored) return null;
	try {
		return JSON.parse(stored) as ModelRefRaw;
	} catch {
		return null;
	}
}

/** Pass `null` to clear the override. */
export function setTaskRewriteModel(model: ModelRefRaw | null): ModelRefRaw | null {
	if (model === null) {
		deleteServerSetting(TASK_REWRITE_MODEL_KEY);
	} else {
		setServerSetting(TASK_REWRITE_MODEL_KEY, JSON.stringify(model));
	}
	return getTaskRewriteModel();
}

const INTERNAL_TASK_MODEL_KEY = "internalTaskModel";

/**
 * Model used for internal one-shot agent jobs the user never sees directly —
 * first consumer is server-side session-title generation (T-78). Scoped
 * generically (not `sessionTitleModel`) so future internal jobs can reuse
 * the same setting without a migration. `null` means the feature is off:
 * no internal job runs until an operator opts in via Settings.
 */
export function getInternalTaskModel(): ModelRefRaw | null {
	const stored = getServerSetting(INTERNAL_TASK_MODEL_KEY);
	if (!stored) return null;
	try {
		return JSON.parse(stored) as ModelRefRaw;
	} catch {
		return null;
	}
}

/** Pass `null` to clear the override (disables internal-task-model jobs). */
export function setInternalTaskModel(model: ModelRefRaw | null): ModelRefRaw | null {
	if (model === null) {
		deleteServerSetting(INTERNAL_TASK_MODEL_KEY);
	} else {
		setServerSetting(INTERNAL_TASK_MODEL_KEY, JSON.stringify(model));
	}
	return getInternalTaskModel();
}

const PLAN_MODEL_KEY = "planModel";

export type PlanModelConfigRaw = { provider: string; id: string; thinking?: string };

/**
 * Plan-role model + thinking level (T-30). The deck temporarily switches a
 * session to this model when it enters Plan Mode and restores the persistent
 * model on exit. `null` means no override: Plan Mode keeps the session's
 * current model, so an unconfigured install behaves exactly as before.
 */
export function getPlanModel(): PlanModelConfigRaw | null {
	const stored = getServerSetting(PLAN_MODEL_KEY);
	if (!stored) return null;
	try {
		const parsed = JSON.parse(stored) as PlanModelConfigRaw;
		if (typeof parsed?.provider !== "string" || typeof parsed?.id !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Pass `null` to clear the override (Plan Mode stops switching models). */
export function setPlanModel(model: PlanModelConfigRaw | null): PlanModelConfigRaw | null {
	if (model === null) {
		deleteServerSetting(PLAN_MODEL_KEY);
	} else {
		const record: PlanModelConfigRaw = { provider: model.provider, id: model.id };
		if (model.thinking) record.thinking = model.thinking;
		setServerSetting(PLAN_MODEL_KEY, JSON.stringify(record));
	}
	return getPlanModel();
}

// ─── Workspace registry (T-134) ─────────────────────────────────────────────

const EXTRA_WORKSPACES_KEY = "extraWorkspaces";

/**
 * Workspaces explicitly registered via the Projects UI (T-134). Supplements
 * `config.extraWorkspaces` (from OMP_DECK_WORKSPACES) and session-discovered
 * cwds in `GET /workspaces`. Stored as a JSON array of absolute paths.
 */
export function getExtraWorkspaces(): string[] {
	const raw = getServerSetting(EXTRA_WORKSPACES_KEY);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((v): v is string => typeof v === "string");
	} catch {
		return [];
	}
}

export function setExtraWorkspaces(cwds: string[]): void {
	if (cwds.length === 0) {
		deleteServerSetting(EXTRA_WORKSPACES_KEY);
	} else {
		setServerSetting(EXTRA_WORKSPACES_KEY, JSON.stringify(cwds));
	}
}

const HIDDEN_WORKSPACES_KEY = "hiddenWorkspaces";

/**
 * Denylist: cwds excluded from `GET /workspaces` regardless of env config or
 * session history (T-134). Stored as a JSON array of absolute paths.
 * `defaultCwd` is never added here — it cannot be hidden.
 */
export function getHiddenWorkspaces(): string[] {
	const raw = getServerSetting(HIDDEN_WORKSPACES_KEY);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((v): v is string => typeof v === "string");
	} catch {
		return [];
	}
}

export function setHiddenWorkspaces(cwds: string[]): void {
	if (cwds.length === 0) {
		deleteServerSetting(HIDDEN_WORKSPACES_KEY);
	} else {
		setServerSetting(HIDDEN_WORKSPACES_KEY, JSON.stringify(cwds));
	}
}
