/**
 * Rules / TTSR / hooks & extensions governance (T-35).
 *
 * The omp SDK already discovers rules (Cursor/Windsurf/Cline/builtin), hook
 * scripts, and extension modules via its capability system, and already has
 * an enable/disable lever for every one of them (`disabledExtensions` +, for
 * rules specifically, the redundant `ttsr.disabledRules`). This module turns
 * that into an inventory + toggle + audit trail:
 *
 * - `listRules` / `setRuleEnabled` — every discovered rule, its scope,
 *   condition(s), effective interrupt mode, and which bucket it lands in
 *   (TTSR / always-apply / rulebook / inactive) — mirrors `bucketRules`'
 *   precedence read-only, without spinning up a live `TtsrManager`.
 * - `listExtensions` / `setExtensionEnabled` — extension modules and
 *   pre/post hooks, with origin, load state, and recent runtime errors.
 * - `listTtsrHistory` — walks persisted session trees for `ttsr_injection`
 *   entries and explains each one against the *current* rule inventory.
 *
 * Every toggle writes straight to the SDK's own `Settings` singleton
 * (`disabledExtensions`, same canonical `${kind}:${name}` ids the SDK's own
 * Extension Control Center uses) so a disable here actually changes what the
 * next session loads — `createAgentSession` calls `initializeWithSettings`
 * itself, and (T-35 confirmed) each session runs in its own freshly spawned
 * worker process, so it re-reads `Settings` from disk on start. A change here
 * therefore applies to new/resumed sessions, not to an already-running one.
 *
 * Deliberately does NOT rely on the SDK's module-level capability registry
 * (`isProviderEnabled`, the implicit `disabledExtensions` fallback inside
 * `loadCapability`) — that registry is only wired via `initializeWithSettings`
 * inside a live `createAgentSession` call (the worker process), not in this
 * (main) server process. Every classification below reads the raw settings
 * arrays directly so it's correct regardless of that wiring.
 */

import { Settings } from "@oh-my-pi/pi-coding-agent";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import type { ExtensionModule, Hook, Rule } from "@oh-my-pi/pi-coding-agent/discovery";
import type {
	ExtensionDisabledReason,
	ExtensionInfo,
	ExtensionLoadErrorInfo,
	ExtensionState,
	GovernanceSource,
	GovernedExtensionKind,
	ListExtensionsResponse,
	ListRulesResponse,
	ListTtsrHistoryResponse,
	RuleBucket,
	RuleDisabledReason,
	RuleInfo,
	SetExtensionEnabledResponse,
	SetRuleEnabledResponse,
	SessionTreeNodeWire,
	TtsrGlobalSettings,
	TtsrHistoryEntry,
	TtsrRuleExplain,
} from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import { readSessionTree } from "./bridge/session-tree.ts";
import { insertGovernanceAuditEvent, listGovernanceAuditEvents } from "./db/governance-audit.ts";
import { logger } from "./log.ts";

const log = logger("governance");

/** Thrown when a caller names a rule/extension id the current inventory doesn't contain. */
export class GovernanceNotFoundError extends Error {}

function sourceOf(meta: { provider: string; providerName: string; level: "user" | "project" | "native" }): GovernanceSource {
	return { provider: meta.provider, providerName: meta.providerName, level: meta.level };
}

// ─────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────

/** Read-only mirror of the SDK's `bucketRules` precedence (TTSR > always-apply
 *  > rulebook > inactive). Doesn't construct a live `TtsrManager`, so a rule
 *  the manager itself would additionally reject (e.g. malformed astCondition)
 *  can still show as bucket `"ttsr"` here — this is an inventory, not a
 *  simulator. */
export function classifyRuleBucket(rule: Rule, ttsrGloballyEnabled: boolean): RuleBucket {
	const hasCondition = (rule.condition?.length ?? 0) > 0 || (rule.astCondition?.length ?? 0) > 0;
	if (ttsrGloballyEnabled && hasCondition) return "ttsr";
	if (rule.alwaysApply === true) return "always-apply";
	if (rule.description) return "rulebook";
	return "inactive";
}

function readTtsrSettings(settings: Settings): TtsrGlobalSettings {
	return {
		enabled: settings.get("ttsr.enabled"),
		interruptMode: settings.get("ttsr.interruptMode"),
		builtinRules: settings.get("ttsr.builtinRules"),
		contextMode: settings.get("ttsr.contextMode"),
		repeatMode: settings.get("ttsr.repeatMode"),
		repeatGap: settings.get("ttsr.repeatGap"),
	};
}

async function loadRuleInventory(
	cwd: string | undefined,
	settings: Settings,
): Promise<{ rules: RuleInfo[]; ttsr: TtsrGlobalSettings; warnings: string[] }> {
	const ttsr = readTtsrSettings(settings);
	const result = await loadCapability<Rule>("rules", { cwd, includeDisabled: true, includeInvalid: true });

	const disabledIds = new Set(settings.get("disabledExtensions") ?? []);
	const disabledProviders = new Set(settings.get("disabledProviders") ?? []);
	const disabledRuleNames = new Set(settings.get("ttsr.disabledRules") ?? []);

	const rules: RuleInfo[] = result.all.map((rule) => {
		const extensionId = `rule:${rule.name}`;
		const shadowed = Boolean(rule._shadowed);
		let state: ExtensionState;
		let disabledReason: RuleDisabledReason | undefined;
		if (disabledIds.has(extensionId) || disabledRuleNames.has(rule.name)) {
			state = "disabled";
			disabledReason = "rule-disabled";
		} else if (shadowed) {
			state = "shadowed";
			disabledReason = "shadowed";
		} else if (disabledProviders.has(rule._source.provider)) {
			state = "disabled";
			disabledReason = "provider-disabled";
		} else {
			state = "active";
		}

		return {
			name: rule.name,
			path: rule.path,
			description: rule.description,
			scope: rule.scope,
			condition: rule.condition,
			astCondition: rule.astCondition,
			alwaysApply: rule.alwaysApply,
			interruptMode: rule.interruptMode ?? ttsr.interruptMode,
			interruptModeOverridden: rule.interruptMode !== undefined,
			bucket: classifyRuleBucket(rule, ttsr.enabled),
			source: sourceOf(rule._source),
			enabled: state === "active",
			disabledReason,
		};
	});

	rules.sort((a, b) => a.name.localeCompare(b.name));
	return { rules, ttsr, warnings: result.warnings };
}

export async function listRules(cwd?: string): Promise<ListRulesResponse> {
	const settings = await Settings.init();
	return loadRuleInventory(cwd, settings);
}

export async function setRuleEnabled(
	name: string,
	enabled: boolean,
	cwd: string | undefined,
	actor = "user",
): Promise<SetRuleEnabledResponse> {
	const settings = await Settings.init();
	const inventory = await loadRuleInventory(cwd, settings);
	const existing = inventory.rules.find((r) => r.name === name);
	if (!existing) throw new GovernanceNotFoundError(`unknown rule: ${name}`);

	const extensionId = `rule:${name}`;
	const before = settings.get("disabledExtensions") ?? [];
	const after = enabled ? before.filter((x) => x !== extensionId) : before.includes(extensionId) ? before : [...before, extensionId];

	let result: "ok" | "error" = "ok";
	let error: string | undefined;
	try {
		settings.set("disabledExtensions", after);
		// Also clear the older TTSR-specific disable lever on enable, so a rule
		// disabled that way (e.g. from the SDK's own TUI) doesn't stay silently
		// inert after this toggle claims it's enabled.
		if (enabled) {
			const disabledRuleNames = settings.get("ttsr.disabledRules") ?? [];
			if (disabledRuleNames.includes(name)) {
				settings.set(
					"ttsr.disabledRules",
					disabledRuleNames.filter((x) => x !== name),
				);
			}
		}
		await settings.flush();
	} catch (err) {
		result = "error";
		error = err instanceof Error ? err.message : String(err);
	}

	const audit = insertGovernanceAuditEvent({
		kind: "rule",
		targetId: extensionId,
		action: enabled ? "enable" : "disable",
		actor,
		cwd,
		before,
		after,
		result,
		error,
	});
	if (result === "error") {
		log.error(`setRuleEnabled failed for ${extensionId}`, error);
		throw new Error(error);
	}

	// Recompute from a fresh inventory rather than patching `existing` in
	// place — `shadowed`/`provider-disabled` state and the `ttsr.disabledRules`
	// clear above both affect the outcome in ways a local flip would miss.
	const refreshed = await loadRuleInventory(cwd, settings);
	const rule = refreshed.rules.find((r) => r.name === name);
	if (!rule) throw new GovernanceNotFoundError(`rule disappeared after toggle: ${name}`);
	return { rule, audit };
}

// ─────────────────────────────────────────────────────────────────────────
// Extensions & hooks
// ─────────────────────────────────────────────────────────────────────────

export function classifyExtensionState(
	extensionId: string,
	provider: string,
	shadowed: boolean,
	disabledIds: Set<string>,
	disabledProviders: Set<string>,
): { state: ExtensionState; disabledReason?: ExtensionDisabledReason } {
	if (disabledIds.has(extensionId)) return { state: "disabled", disabledReason: "item-disabled" };
	if (shadowed) return { state: "shadowed", disabledReason: "shadowed" };
	if (disabledProviders.has(provider)) return { state: "disabled", disabledReason: "provider-disabled" };
	return { state: "active" };
}

async function loadExtensionInventory(
	cwd: string | undefined,
	settings: Settings,
): Promise<{ extensions: ExtensionInfo[]; warnings: string[] }> {
	const disabledIds = new Set(settings.get("disabledExtensions") ?? []);
	const disabledProviders = new Set(settings.get("disabledProviders") ?? []);
	const loadOpts = { cwd, includeDisabled: true, includeInvalid: true };

	const [modulesResult, hooksResult] = await Promise.all([
		loadCapability<ExtensionModule>("extension-modules", loadOpts),
		loadCapability<Hook>("hooks", loadOpts),
	]);

	const extensions: ExtensionInfo[] = [];

	for (const mod of modulesResult.all) {
		const extId = `extension-module:${mod.name}`;
		const cls = classifyExtensionState(extId, mod._source.provider, Boolean(mod._shadowed), disabledIds, disabledProviders);
		extensions.push({
			id: extId,
			kind: "extension-module",
			name: mod.name,
			path: mod.path,
			source: sourceOf(mod._source),
			state: cls.state,
			disabledReason: cls.disabledReason,
		});
	}

	for (const hook of hooksResult.all) {
		const extId = `hook:${hook.type}:${hook.tool}:${hook.name}`;
		const cls = classifyExtensionState(extId, hook._source.provider, Boolean(hook._shadowed), disabledIds, disabledProviders);
		extensions.push({
			id: extId,
			kind: "hook",
			name: hook.name,
			path: hook.path,
			source: sourceOf(hook._source),
			state: cls.state,
			disabledReason: cls.disabledReason,
			trigger: `${hook.type}:${hook.tool}`,
		});
	}

	extensions.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
	return { extensions, warnings: [...modulesResult.warnings, ...hooksResult.warnings] };
}

const EXTENSION_LOAD_ERROR_LIST_LIMIT = 50;

function listExtensionLoadErrors(): ExtensionLoadErrorInfo[] {
	return listGovernanceAuditEvents({ kind: "extension_load_error", limit: EXTENSION_LOAD_ERROR_LIST_LIMIT }).map((e) => ({
		id: e.id,
		occurredAt: e.occurredAt,
		sessionId: e.sessionId,
		cwd: e.cwd,
		path: e.targetId,
		message: e.error ?? "",
	}));
}

export async function listExtensions(cwd?: string): Promise<ListExtensionsResponse> {
	const settings = await Settings.init();
	const { extensions, warnings } = await loadExtensionInventory(cwd, settings);
	return { extensions, loadErrors: listExtensionLoadErrors(), warnings };
}

const GOVERNED_EXTENSION_PREFIXES: readonly GovernedExtensionKind[] = ["extension-module", "hook"];

export async function setExtensionEnabled(
	extId: string,
	enabled: boolean,
	cwd: string | undefined,
	actor = "user",
): Promise<SetExtensionEnabledResponse> {
	const kind = GOVERNED_EXTENSION_PREFIXES.find((k) => extId.startsWith(`${k}:`));
	if (!kind) throw new GovernanceNotFoundError(`unsupported extension id: ${extId}`);

	const settings = await Settings.init();
	const { extensions } = await loadExtensionInventory(cwd, settings);
	const existing = extensions.find((e) => e.id === extId);
	if (!existing) throw new GovernanceNotFoundError(`unknown extension id: ${extId}`);

	const before = settings.get("disabledExtensions") ?? [];
	const after = enabled ? before.filter((x) => x !== extId) : before.includes(extId) ? before : [...before, extId];

	let result: "ok" | "error" = "ok";
	let error: string | undefined;
	try {
		settings.set("disabledExtensions", after);
		await settings.flush();
	} catch (err) {
		result = "error";
		error = err instanceof Error ? err.message : String(err);
	}

	const audit = insertGovernanceAuditEvent({
		kind: "extension",
		targetId: extId,
		action: enabled ? "enable" : "disable",
		actor,
		cwd,
		before,
		after,
		result,
		error,
	});
	if (result === "error") {
		log.error(`setExtensionEnabled failed for ${extId}`, error);
		throw new Error(error);
	}

	// Recompute from a fresh inventory rather than patching `existing` in
	// place — shadowed/provider-disabled state can interact with the toggle
	// in ways a local flip would miss.
	const refreshedInventory = await loadExtensionInventory(cwd, settings);
	const extension = refreshedInventory.extensions.find((e) => e.id === extId);
	if (!extension) throw new GovernanceNotFoundError(`extension disappeared after toggle: ${extId}`);
	return { extension, audit };
}

/** Called from the main process after a worker reports extension load errors
 *  for a session it just created/resumed (T-35). Best-effort: a DB failure
 *  here must never take down session creation, so callers should catch. */
export function recordExtensionLoadErrors(
	cwd: string,
	sessionId: string,
	errors: ReadonlyArray<{ path: string; error: string }>,
): void {
	for (const err of errors) {
		insertGovernanceAuditEvent({
			kind: "extension_load_error",
			targetId: err.path,
			action: "load_error",
			actor: "system",
			cwd,
			sessionId,
			result: "error",
			error: err.error,
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────
// TTSR history
// ─────────────────────────────────────────────────────────────────────────

function explainRule(name: string, byName: Map<string, RuleInfo>): TtsrRuleExplain {
	const rule = byName.get(name);
	if (!rule) return { name, found: false };
	return {
		name,
		found: true,
		description: rule.description,
		condition: rule.condition,
		astCondition: rule.astCondition,
		scope: rule.scope,
		interruptMode: rule.interruptMode,
	};
}

function* walkTree(nodes: readonly SessionTreeNodeWire[]): Generator<SessionTreeNodeWire> {
	for (const node of nodes) {
		yield node;
		yield* walkTree(node.children);
	}
}

const DEFAULT_TTSR_HISTORY_SESSION_LIMIT = 30;

/**
 * Walks the most recently updated sessions (bounded by `limit` — this reads
 * a `.jsonl` file per candidate session, so it's not meant to scan the whole
 * history) looking for persisted `ttsr_injection` entries, and explains each
 * one against the rule inventory of *that session's own cwd* (not the
 * request's `cwd` filter) — a cross-workspace "every session" call still
 * explains each injection correctly. Inventories are loaded lazily and
 * cached per distinct cwd encountered, since most callers touch only one
 * or two workspaces.
 */
export async function listTtsrHistory(
	bridge: AgentBridge,
	cwd: string | undefined,
	limit = DEFAULT_TTSR_HISTORY_SESSION_LIMIT,
): Promise<ListTtsrHistoryResponse> {
	const settings = await Settings.init();
	const sessions = await bridge.listSessions(cwd ? { cwd } : {});

	const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const candidates = sorted.slice(0, limit);
	const truncated = sorted.length > candidates.length;

	const ruleByNameByCwd = new Map<string, Map<string, RuleInfo>>();
	async function ruleByNameFor(sessionCwd: string): Promise<Map<string, RuleInfo>> {
		const cached = ruleByNameByCwd.get(sessionCwd);
		if (cached) return cached;
		const inventory = await loadRuleInventory(sessionCwd, settings);
		const byName = new Map(inventory.rules.map((r) => [r.name, r]));
		ruleByNameByCwd.set(sessionCwd, byName);
		return byName;
	}

	const entries: TtsrHistoryEntry[] = [];
	for (const session of candidates) {
		let tree;
		try {
			tree = await readSessionTree(session.path);
		} catch (err) {
			log.debug(`listTtsrHistory: skipping unreadable session ${session.path}`, err);
			continue;
		}
		const injectionNodes = [...walkTree(tree.roots)].filter((node) => node.entry.kind === "ttsr_injection");
		if (injectionNodes.length === 0) continue;

		const ruleByName = await ruleByNameFor(tree.cwd);
		for (const node of injectionNodes) {
			const ruleNames = node.entry.injectedRules ?? [];
			entries.push({
				sessionId: tree.sessionId,
				sessionPath: tree.sessionFile,
				cwd: tree.cwd,
				sessionTitle: session.title,
				entryId: node.entry.id,
				occurredAt: node.entry.timestamp,
				ruleNames,
				rules: ruleNames.map((name) => explainRule(name, ruleByName)),
			});
		}
	}

	entries.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
	return { entries, truncated };
}
