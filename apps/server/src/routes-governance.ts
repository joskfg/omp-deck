/**
 * /api/governance — rules, TTSR, hooks & extensions administration (T-35).
 *
 * - `GET /governance/rules` / `PUT /governance/rules/:name` — inventory +
 *   enable/disable for every rule the SDK discovers.
 * - `GET /governance/extensions` / `PUT /governance/extensions/:id` —
 *   inventory + enable/disable for extension modules and hooks.
 * - `GET /governance/ttsr/history` — persisted TTSR injections explained
 *   against the current rule inventory.
 * - `GET /governance/audit` — the audit trail every toggle above (and every
 *   extension load error) writes to.
 */

import { Hono } from "hono";

import type {
	ListGovernanceAuditResponse,
	SetExtensionEnabledRequest,
	SetRuleEnabledRequest,
} from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import { listGovernanceAuditEvents } from "./db/governance-audit.ts";
import {
	GovernanceNotFoundError,
	listExtensions,
	listRules,
	listTtsrHistory,
	setExtensionEnabled,
	setRuleEnabled,
} from "./governance-service.ts";
import { cwdNotAllowedMessage, isCwdAllowed } from "./routes-fs.ts";
import { logger } from "./log.ts";

const log = logger("routes:governance");

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	const n = raw ? Number.parseInt(raw, 10) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** Resolves+validates an optional `cwd` query param. Returns `{ ok: true, cwd }`
 *  (cwd possibly undefined — every inventory function defaults sanely) or
 *  `{ ok: false, response }` when an explicit cwd fails the workspace allowlist. */
function resolveCwd(c: { req: { query(name: string): string | undefined } }): { ok: true; cwd: string | undefined } | { ok: false; status: 403; error: string } {
	const raw = c.req.query("cwd")?.trim();
	if (!raw) return { ok: true, cwd: undefined };
	if (!isCwdAllowed(raw)) return { ok: false, status: 403, error: cwdNotAllowedMessage() };
	return { ok: true, cwd: raw };
}

async function readEnabledBody(req: Request): Promise<{ ok: true; enabled: boolean } | { ok: false; error: string }> {
	let body: SetRuleEnabledRequest | SetExtensionEnabledRequest;
	try {
		body = (await req.json()) as SetRuleEnabledRequest | SetExtensionEnabledRequest;
	} catch {
		return { ok: false, error: "invalid json body" };
	}
	if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
	return { ok: true, enabled: body.enabled };
}

export function buildGovernanceRouter(bridge: AgentBridge): Hono {
	const app = new Hono();

	app.get("/governance/rules", async (c) => {
		const cwdResult = resolveCwd(c);
		if (!cwdResult.ok) return c.json({ error: cwdResult.error }, cwdResult.status);
		try {
			return c.json(await listRules(cwdResult.cwd));
		} catch (err) {
			log.error("listRules failed", err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.put("/governance/rules/:name", async (c) => {
		const name = c.req.param("name");
		if (!name) return c.json({ error: "name is required" }, 400);
		const cwdResult = resolveCwd(c);
		if (!cwdResult.ok) return c.json({ error: cwdResult.error }, cwdResult.status);
		const body = await readEnabledBody(c.req.raw);
		if (!body.ok) return c.json({ error: body.error }, 400);
		try {
			return c.json(await setRuleEnabled(name, body.enabled, cwdResult.cwd));
		} catch (err) {
			if (err instanceof GovernanceNotFoundError) return c.json({ error: err.message }, 404);
			log.error(`setRuleEnabled failed for ${name}`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/governance/extensions", async (c) => {
		const cwdResult = resolveCwd(c);
		if (!cwdResult.ok) return c.json({ error: cwdResult.error }, cwdResult.status);
		try {
			return c.json(await listExtensions(cwdResult.cwd));
		} catch (err) {
			log.error("listExtensions failed", err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.put("/governance/extensions/:id", async (c) => {
		const id = c.req.param("id");
		if (!id) return c.json({ error: "id is required" }, 400);
		const cwdResult = resolveCwd(c);
		if (!cwdResult.ok) return c.json({ error: cwdResult.error }, cwdResult.status);
		const body = await readEnabledBody(c.req.raw);
		if (!body.ok) return c.json({ error: body.error }, 400);
		try {
			return c.json(await setExtensionEnabled(id, body.enabled, cwdResult.cwd));
		} catch (err) {
			if (err instanceof GovernanceNotFoundError) return c.json({ error: err.message }, 404);
			log.error(`setExtensionEnabled failed for ${id}`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/governance/ttsr/history", async (c) => {
		const cwdResult = resolveCwd(c);
		if (!cwdResult.ok) return c.json({ error: cwdResult.error }, cwdResult.status);
		const limit = clampInt(c.req.query("limit"), 30, 1, 200);
		try {
			return c.json(await listTtsrHistory(bridge, cwdResult.cwd, limit));
		} catch (err) {
			log.error("listTtsrHistory failed", err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/governance/audit", async (c) => {
		const kindRaw = c.req.query("kind");
		const kind = kindRaw === "rule" || kindRaw === "extension" || kindRaw === "extension_load_error" ? kindRaw : undefined;
		const limit = clampInt(c.req.query("limit"), 200, 1, 1000);
		try {
			const entries = listGovernanceAuditEvents({ kind, limit });
			const body: ListGovernanceAuditResponse = { entries };
			return c.json(body);
		} catch (err) {
			log.error("listGovernanceAuditEvents failed", err);
			return c.json({ error: String(err) }, 500);
		}
	});

	return app;
}
