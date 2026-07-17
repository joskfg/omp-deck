import { randomBytes } from "node:crypto";

import { Hono } from "hono";
import { parse as parseYaml } from "yaml";

import type {
	CreateRoutineRequest,
	ListRoutineRunsResponse,
	ListRoutineStepRunsResponse,
	ListRoutinesResponse,
	RoutineSpec,
	UpdateRoutineRequest,
} from "@omp-deck/protocol";
import { validateRoutineSpec } from "@omp-deck/protocol";

import { logger } from "./log.ts";
import {
	createRoutine,
	createV1Routine,
	deleteRoutine,
	getRoutine,
	listRoutines,
	listRuns,
	updateRoutine,
	updateV1Routine,
} from "./db/routines.ts";
import {
	deleteWebhookSecret,
	ensureWebhookSecret,
	listStepRuns,
	upsertWebhookSecret,
} from "./db/routine-step-runs.ts";
import type { RoutinesRunner } from "./routines-runner.ts";
import { hashSecretForStorage } from "./routes-hooks.ts";
import { listTemplates, loadTemplate } from "./routines/templates.ts";

const log = logger("routes:routines");

export function buildRoutinesRouter(runner: RoutinesRunner): Hono {
	const app = new Hono();

	app.get("/routines", (c) => {
		const body: ListRoutinesResponse = { routines: listRoutines() };
		return c.json(body);
	});

	app.post("/routines", async (c) => {
		let body: CreateRoutineRequest & { specYaml?: string };
		try {
			body = (await c.req.json()) as CreateRoutineRequest & { specYaml?: string };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		// V1 routine: presence of specYaml is the discriminator.
		if (body.specYaml) {
			try {
				const spec = parseYaml(body.specYaml) as unknown;
				const result = validateRoutineSpec(spec);
				if (!result.valid) {
					return c.json({ error: "invalid spec", details: result.errors }, 400);
				}
				const typed = spec as RoutineSpec;
				const routine = createV1Routine({
					name: body.name || typed.name,
					description: body.description ?? typed.description ?? "",
					specYaml: body.specYaml,
					spec: typed,
					enabled: body.enabled !== false,
				});
				registerWebhookTriggers(typed, routine.id);
				runner.schedule(routine);
				return c.json(routine, 201);
			} catch (err) {
				log.error("createV1Routine failed", err);
				return c.json({ error: String(err) }, 400);
			}
		}
		// V0 path (legacy single-action routine).
		if (!body.name || !body.cron || !body.actionKind || body.actionBody === undefined) {
			return c.json({ error: "name, cron, actionKind, actionBody required (or pass specYaml for V1)" }, 400);
		}
		try {
			const routine = createRoutine(body);
			runner.schedule(routine);
			return c.json(routine, 201);
		} catch (err) {
			log.error("createRoutine failed", err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.get("/routines/:id", (c) => {
		const r = getRoutine(c.req.param("id"));
		if (!r) return c.json({ error: "not found" }, 404);
		return c.json(r);
	});

	app.patch("/routines/:id", async (c) => {
		let body: UpdateRoutineRequest & { specYaml?: string };
		try {
			body = (await c.req.json()) as UpdateRoutineRequest & { specYaml?: string };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const id = c.req.param("id");
		const existing = getRoutine(id);
		if (!existing) return c.json({ error: "not found" }, 404);
		// V1 routine: validate + persist spec_yaml; allow enabled-only patches too.
		if (existing.specVersion === 1) {
			if (body.specYaml !== undefined) {
				try {
					const spec = parseYaml(body.specYaml) as unknown;
					const result = validateRoutineSpec(spec);
					if (!result.valid) {
						return c.json({ error: "invalid spec", details: result.errors }, 400);
					}
					const typed = spec as RoutineSpec;
					const updated = updateV1Routine(id, {
						name: body.name,
						description: body.description,
						specYaml: body.specYaml,
						spec: typed,
						enabled: body.enabled,
					});
					if (!updated) return c.json({ error: "not found" }, 404);
					registerWebhookTriggers(typed, updated.id);
					runner.schedule(updated);
					return c.json(updated);
				} catch (err) {
					log.error("updateV1Routine failed", err);
					return c.json({ error: String(err) }, 400);
				}
			}
			// V1 routine but no spec change — patch name/description/enabled only.
			const updated = updateV1Routine(id, {
				name: body.name,
				description: body.description,
				enabled: body.enabled,
			});
			if (!updated) return c.json({ error: "not found" }, 404);
			runner.schedule(updated);
			return c.json(updated);
		}
		// V0 path.
		const updated = updateRoutine(id, body);
		if (!updated) return c.json({ error: "not found" }, 404);
		runner.schedule(updated);
		return c.json(updated);
	});

	app.delete("/routines/:id", (c) => {
		const id = c.req.param("id");
		runner.unschedule(id);
		const ok = deleteRoutine(id);
		return c.json({ ok });
	});

	app.post("/routines/:id/run", async (c) => {
		const id = c.req.param("id");
		const r = getRoutine(id);
		if (!r) return c.json({ error: "not found" }, 404);
		let payload: Record<string, unknown> = {};
		try {
			const text = await c.req.text();
			if (text.trim().length > 0) {
				const parsed = JSON.parse(text);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					payload = parsed as Record<string, unknown>;
				}
			}
		} catch {
			// ignore — manual runs may be triggered with empty body
		}
		void runner
			.fire(id, "manual", payload)
			.catch((err) => log.warn("manual fire failed", err));
		return c.json({ ok: true, queued: true }, 202);
	});

	app.get("/routines/:id/runs", (c) => {
		const id = c.req.param("id");
		const rawLimit = c.req.query("limit");
		const limit = rawLimit === undefined ? 20 : Number(rawLimit);
		if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
			return c.json({ error: "limit must be an integer between 1 and 500" }, 400);
		}
		const body: ListRoutineRunsResponse = { runs: listRuns(id, limit) };
		return c.json(body);
	});

	app.get("/routines/:id/runs/:runId/steps", (c) => {
		const runId = c.req.param("runId");
		const body: ListRoutineStepRunsResponse = { steps: listStepRuns(runId) };
		return c.json(body);
	});

	/**
	 * Generate (or rotate) the webhook secret for a routine's `webhook`
	 * trigger. Returns the plaintext secret ONCE — caller must store it
	 * client-side (the deck only persists the hash).
	 */
	app.post("/routines/:id/webhook-secret/rotate", (c) => {
		const id = c.req.param("id");
		const r = getRoutine(id);
		if (!r || r.specVersion !== 1 || !r.specYaml) {
			return c.json({ error: "V1 routine with webhook trigger required" }, 404);
		}
		const spec = (() => {
			try { return parseYaml(r.specYaml) as RoutineSpec; } catch { return null; }
		})();
		if (!spec) return c.json({ error: "spec parse failure" }, 400);
		const webhookTrigger = spec.trigger.find((t) => "webhook" in t) as { webhook: { path: string } } | undefined;
		if (!webhookTrigger) {
			return c.json({ error: "routine has no webhook trigger" }, 400);
		}
		const secret = randomBytes(32).toString("base64url");
		const hash = hashSecretForStorage(secret);
		const registered = upsertWebhookSecret({ routineId: id, path: webhookTrigger.webhook.path, secretHash: hash });
		if (!registered) return c.json({ error: "webhook path already in use" }, 409);
		return c.json({ ok: true, secret, path: webhookTrigger.webhook.path });
	});

	// ─── Templates ────────────────────────────────────────────────────────

	app.get("/routine-templates", (c) => {
		return c.json({ templates: listTemplates() });
	});

	app.post("/routine-templates/:slug", (c) => {
		const slug = c.req.param("slug");
		const loaded = loadTemplate(slug);
		if (!loaded) return c.json({ error: "template not found" }, 404);
		const validation = validateRoutineSpec(loaded.spec);
		if (!validation.valid) {
			return c.json({ error: "template spec is invalid", details: validation.errors }, 500);
		}
		const routine = createV1Routine({
			name: loaded.spec.name,
			description: loaded.spec.description ?? "",
			specYaml: loaded.specYaml,
			spec: loaded.spec,
			enabled: false,
		});
		registerWebhookTriggers(loaded.spec, routine.id);
		runner.schedule(routine);
		return c.json(routine, 201);
	});

	/**
	 * Metrics aggregation over the routine's run history. Surfaced on the
	 * routine card and the run detail header.
	 */
	app.get("/routines/:id/metrics", (c) => {
		const id = c.req.param("id");
		const r = getRoutine(id);
		if (!r) return c.json({ error: "not found" }, 404);
		const runs = listRuns(id, 100);
		const last30 = runs.slice(0, 30);
		const successCount = last30.filter((x) => x.endedAt && !x.abortReason && x.exitCode === 0).length;
		const durations = last30
			.filter((x) => x.startedAt && x.endedAt)
			.map((x) => new Date(x.endedAt!).getTime() - new Date(x.startedAt).getTime())
			.sort((a, b) => a - b);
		const pick = (q: number): number | null => {
			if (durations.length === 0) return null;
			const idx = Math.min(durations.length - 1, Math.floor(durations.length * q));
			return durations[idx] ?? null;
		};
		const mtdStart = new Date(new Date().toISOString().slice(0, 7) + "-01T00:00:00.000Z").getTime();
		const mtdCostMicros = runs
			.filter((x) => new Date(x.startedAt).getTime() >= mtdStart)
			.reduce((acc, x) => acc + (x.totalLlmCostMicros ?? 0), 0);
		const last30Summary = last30.map((x) => {
			const status: "success" | "failed" | "aborted" | "running" = !x.endedAt
				? "running"
				: x.abortReason
					? "aborted"
					: x.exitCode === 0
						? "success"
						: "failed";
			return {
				runId: x.id,
				status,
				durationMs:
					x.startedAt && x.endedAt
						? new Date(x.endedAt).getTime() - new Date(x.startedAt).getTime()
						: null,
			};
		});
		return c.json({
			total: runs.length,
			successCount,
			successRate30d: last30.length === 0 ? 0 : successCount / last30.length,
			p50DurationMs: pick(0.5),
			p95DurationMs: pick(0.95),
			mtdCostMicros,
			last30: last30Summary,
		});
	});

	return app;
}

function registerWebhookTriggers(spec: RoutineSpec, routineId: string): void {
	// Keep the registration table in sync with the authored spec. Registering a
	// trigger should be idempotent on save; only the explicit rotate endpoint
	// replaces the stored secret hash.
	const webhookTrigger = spec.trigger.find((t) => "webhook" in t) as { webhook: { path: string } } | undefined;
	if (!webhookTrigger) {
		deleteWebhookSecret(routineId);
		return;
	}

	const secret = randomBytes(32).toString("base64url");
	const registered = ensureWebhookSecret({
		routineId,
		path: webhookTrigger.webhook.path,
		secretHash: hashSecretForStorage(secret),
	});
	if (!registered) {
		log.warn(`webhook path ${webhookTrigger.webhook.path} already in use; skipping registration for ${routineId}`);
	}
}
