import { Hono } from "hono";
import type {
	AddWorkspaceRequest,
	AgentMessageJson,
	CreateSessionRequest,
	CreateSessionResponse,
	GetSessionHandoffSuccessorResponse,
	ListModelsResponse,
	ListSessionsResponse,
	ListSessionMonitorResponse,
	ListWorkspacePreferencesResponse,
	ListWorkspacesResponse,
	ModelRef,
	RestartServerResponse,
	RewriteTaskRequest,
	RewriteTaskResponse,
	SessionHistoryResponse,
	BranchSessionRequest,
	SessionTreeResponse,
	SetWorkspacePreferenceRequest,
	WorkspaceEntry,
} from "@omp-deck/protocol";

import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.ts";
import { logger } from "./log.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { getBuildInfo, getUptimeSecs } from "./build-info.ts";
import { getUpdateCheck } from "./update-check.ts";
import type { AgentBridge, SessionHandle } from "./bridge/types.ts";
import { getWorkspacePreference, listWorkspacePreferences, setWorkspacePreference } from "./db/workspace-preferences.ts";
import { getTask } from "./db/tasks.ts";
import { getTaskRewriteModel, getExtraWorkspaces, setExtraWorkspaces, getHiddenWorkspaces, setHiddenWorkspaces } from "./db/server-settings.ts";
import { resolveIntegrationPrompt } from "./integration-prompts.ts";
import { waitForAutoWorkSessionTerminal } from "./auto-work/engine.ts";
import { getModelCatalogOverlay } from "./model-catalog-overlay.ts";
import { listSessionMonitor } from "./session-monitor.ts";
import { findHandoffSuccessor } from "./bridge/session-handoff.ts";
import { deriveLabel } from "./workspace-label.ts";

const log = logger("routes");

import { buildTasksRouter } from "./routes-tasks.ts";
import { buildSettingsRouter, syncWorkspacesToEnv } from "./routes-settings.ts";
import { buildDelegationRouter } from "./routes-delegation.ts";
import { buildPoliciesRouter } from "./routes-policies.ts";
import { buildAdvisorsRouter } from "./routes-advisors.ts";
import { buildRoutinesRouter } from "./routes-routines.ts";
import { buildHooksRouter } from "./routes-hooks.ts";
import { buildInboxRouter } from "./routes-inbox.ts";
import { buildUtilityRouter } from "./routes-cron.ts";
import { buildSlashCommandsRouter } from "./routes-slash-commands.ts";
import { buildFsRouter, cwdNotAllowedMessage, isCwdAllowed } from "./routes-fs.ts";
import { buildBridgesRouter } from "./routes-bridges.ts";
import { buildMarketplaceRouter } from "./routes-marketplace.ts";
import { buildSkillsRouter } from "./routes-skills.ts";
import { buildKbRouter } from "./routes-kb.ts";
import { buildUploadsRouter } from "./routes-uploads.ts";
import { buildOrientationRouter } from "./routes-orientation.ts";
import { buildAuthOAuthRouter } from "./routes-auth-oauth.ts";
import { buildOnboardingRouter } from "./routes-onboarding.ts";
import { buildUsageRouter } from "./routes-usage.ts";
import { buildCodebaseMemoryRouter } from "./routes-codebase-memory.ts";
import { buildMemoryRouter } from "./routes-memory.ts";
import { buildGovernanceRouter } from "./routes-governance.ts";

import { buildAutoWorkRouter } from "./routes-auto-work.ts";
import type { RoutinesRunner } from "./routines-runner.ts";
import type { BridgeSupervisor } from "./bridge-supervisor.ts";
import type { MarketplaceService } from "./marketplace-service.ts";
import type { SkillsService } from "./skills-service.ts";
import type { KbService } from "./kb-service.ts";

export function buildRouter(
	bridge: AgentBridge,
	config: Config,
	runner: RoutinesRunner,
	supervisor: BridgeSupervisor,
	marketplace: MarketplaceService,
	skills: SkillsService,
	kb: KbService,
	opts: { restartServer?: () => RestartServerResponse } = {},
): Hono {
	const app = new Hono();

	app.get("/health", (c) => {
		const info = getBuildInfo();
		return c.json({
			ok: true,
			pid: info.pid,
			defaultCwd: config.defaultCwd,
			title: config.title,
			extraWorkspaces: config.extraWorkspaces,
			serverStartedAt: info.serverStartedAt,
			version: info.version,
			buildSha: info.buildSha,
			uptimeSecs: getUptimeSecs(),
		});
	});

	app.get("/version", async (c) => {
		const info = getBuildInfo();
		const body = await getUpdateCheck({ currentVersion: info.version });
		return c.json(body);
	});

	app.get("/workspaces", async (c) => {
		const allSessions = await bridge.listSessions({});
		const counts = new Map<string, number>();
		for (const s of allSessions) {
			if (!s.cwd) continue;
			counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
		}

		const hiddenSet = new Set(getHiddenWorkspaces());
		const dbExtras = getExtraWorkspaces();

		// Always include default + env extras + DB-registered extras.
		const known = new Set<string>([config.defaultCwd, ...config.extraWorkspaces, ...dbExtras]);
		for (const cwd of counts.keys()) known.add(cwd);

		// Filter hidden (defaultCwd is never filtered).
		for (const cwd of hiddenSet) {
			if (cwd !== config.defaultCwd) known.delete(cwd);
		}

		const preferenceByCwd = new Map(listWorkspacePreferences().map((p) => [p.cwd, p]));

		const workspaces: WorkspaceEntry[] = Array.from(known)
			.map((cwd) => {
				const entry: WorkspaceEntry = {
					cwd,
					label: deriveLabel(cwd),
					sessionCount: counts.get(cwd) ?? 0,
				};
				const pref = preferenceByCwd.get(cwd);
				if (pref?.model) entry.defaultModel = pref.model;
				if (pref?.thinking) entry.defaultThinking = pref.thinking;
				return entry;
			})
			.sort((a, b) => b.sessionCount - a.sessionCount || a.label.localeCompare(b.label));

		const body: ListWorkspacesResponse = {
			workspaces,
			defaultCwd: config.defaultCwd,
		};
		return c.json(body);
	});

	app.post("/workspaces", async (c) => {
		let body: AddWorkspaceRequest;
		try {
			body = (await c.req.json()) as AddWorkspaceRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const cwd = body.cwd?.trim();
		if (!cwd || !path.isAbsolute(cwd))
			return c.json({ error: "cwd must be a non-empty absolute path" }, 400);
		const resolved = path.resolve(cwd);

		// Must be an existing directory under an allowed root.
		try {
			if (!fs.statSync(resolved).isDirectory())
				return c.json({ error: "cwd must be a directory" }, 400);
		} catch {
			return c.json({ error: "cwd does not exist" }, 400);
		}
		if (!isCwdAllowed(resolved))
			return c.json({ error: cwdNotAllowedMessage() }, 400);

		// Register in DB.
		const extras = getExtraWorkspaces();
		if (!extras.includes(resolved)) setExtraWorkspaces([...extras, resolved]);

		// Un-hide if it was previously hidden.
		const hidden = getHiddenWorkspaces();
		if (hidden.includes(resolved)) setHiddenWorkspaces(hidden.filter((h) => h !== resolved));

		// Best-effort env sync — skips silently when OMP_DECK_WORKSPACES is shell-set.
		if (!config.extraWorkspaces.includes(resolved)) {
			await syncWorkspacesToEnv([...config.extraWorkspaces, resolved], config);
		}

		return c.json({ ok: true });
	});

	app.delete("/workspaces", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		const resolved = path.resolve(cwd);

		if (resolved === config.defaultCwd)
			return c.json({ error: "the default workspace cannot be removed" }, 400);

		// Add to denylist.
		const hidden = getHiddenWorkspaces();
		if (!hidden.includes(resolved)) setHiddenWorkspaces([...hidden, resolved]);

		// Remove from DB extras.
		const extras = getExtraWorkspaces();
		if (extras.includes(resolved)) setExtraWorkspaces(extras.filter((e) => e !== resolved));

		// Best-effort env sync — remove from OMP_DECK_WORKSPACES if present and manageable.
		if (config.extraWorkspaces.includes(resolved)) {
			await syncWorkspacesToEnv(
				config.extraWorkspaces.filter((e) => e !== resolved),
				config,
			);
		}

		return c.json({ ok: true });
	});

	// ─── Workspace preferences (T-42: per-cwd default model override) ──────

	app.get("/workspace-preferences", (c) => {
		const body: ListWorkspacePreferencesResponse = { preferences: listWorkspacePreferences() };
		return c.json(body);
	});

	app.put("/workspace-preferences", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		if (!isCwdAllowed(cwd)) {
			return c.json({ error: cwdNotAllowedMessage() }, 400);
		}
		let body: SetWorkspacePreferenceRequest;
		try {
			body = (await c.req.json()) as SetWorkspacePreferenceRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body || typeof body !== "object" || Array.isArray(body) || body.model === undefined) {
			return c.json({ error: "model is required" }, 400);
		}
		if (body.model !== null) {
			const invalid = await validateModelRef(bridge, body.model);
			if (invalid) return c.json({ error: invalid }, 400);
		}
		// Validate thinking level when provided and not null.
		const rawThinking = body.thinking;
		const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "auto"] as const;
		if (rawThinking !== undefined && rawThinking !== null && !(VALID_THINKING_LEVELS as readonly string[]).includes(rawThinking)) {
			return c.json({ error: `invalid thinking level: ${rawThinking}` }, 400);
		}
		try {
			const preference = setWorkspacePreference(cwd, body.model, rawThinking);
			return c.json(preference);
		} catch (err) {
			log.error(`setWorkspacePreference failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/sessions", async (c) => {
		const cwd = c.req.query("cwd");
		try {
			const sessions = await bridge.listSessions(cwd ? { cwd } : {});
			const body: ListSessionsResponse = { sessions };
			return c.json(body);
		} catch (err) {
			log.error(`listSessions failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/sessions/monitor", async (c) => {
		const cwd = c.req.query("cwd");
		try {
			const sessions = await listSessionMonitor(bridge, cwd);
			const body: ListSessionMonitorResponse = { sessions };
			return c.json(body);
		} catch (err) {
			log.error(`list session monitor failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	/**
	 * T-32: best-effort forward link for a session's automatic context
	 * handoff, if any — see `bridge/session-handoff.ts`. Registered before
	 * `/sessions/:id/...` so Hono doesn't swallow this static path as an id.
	 * Bridge-independent (disk-only lookup): works for a live OR a purely
	 * historical session, since it only needs `cwd` + the session's own file
	 * path, both already known to any client that has listed or opened it.
	 */
	app.get("/sessions/handoff-successor", async (c) => {
		const cwd = c.req.query("cwd");
		const sessionFile = c.req.query("sessionFile");
		if (!cwd || !sessionFile) {
			return c.json({ error: "cwd and sessionFile query params are required" }, 400);
		}
		if (!isCwdAllowed(cwd)) {
			return c.json({ error: cwdNotAllowedMessage() }, 400);
		}
		try {
			const successor = await findHandoffSuccessor(cwd, sessionFile);
			const body: GetSessionHandoffSuccessorResponse = { successor: successor ?? null };
			return c.json(body);
		} catch (err) {
			log.error(`findHandoffSuccessor failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	/**
	 * One page of message history older than `before` (a history index,
	 * exclusive). Complements the tail-sliced subscribe snapshot: the web
	 * client calls this as the user scrolls toward the top, walking `before`
	 * backwards until `startIndex` reaches 0. Only answerable for active
	 * sessions — the client is by construction subscribed (and thus the
	 * session active) whenever it pages.
	 */
	app.get("/sessions/:id/history", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not active" }, 404);
		const before = Number(c.req.query("before"));
		if (!Number.isFinite(before) || before < 0) {
			return c.json({ error: "invalid 'before' index" }, 400);
		}
		const limitRaw = Number(c.req.query("limit"));
		const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
		const body: SessionHistoryResponse = await handle.getHistory(before, limit);
		return c.json(body);
	});

	/**
	 * Read-only tree/timeline of a session's entries (T-31) — works for a
	 * live session and a persisted-only one alike.
	 */
	app.get("/sessions/:id/tree", async (c) => {
		const id = c.req.param("id");
		try {
			const tree = await bridge.getSessionTree(id);
			if (!tree) return c.json({ error: "session not found" }, 404);
			const body: SessionTreeResponse = tree;
			return c.json(body);
		} catch (err) {
			log.error(`getSessionTree failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	/**
	 * Fork a brand-new session rooted at `entryId`'s history (T-31). Never
	 * mutates the source session — creates a new `.jsonl` file, then resumes
	 * it into a live handle so the response matches `POST /sessions`.
	 */
	app.post("/sessions/:id/branch", async (c) => {
		const id = c.req.param("id");
		let body: BranchSessionRequest;
		try {
			body = (await c.req.json()) as BranchSessionRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body?.entryId || typeof body.entryId !== "string") {
			return c.json({ error: "entryId is required" }, 400);
		}
		let forked: { sessionFile: string; cwd: string } | undefined;
		try {
			forked = await bridge.forkSessionAt(id, body.entryId);
		} catch (err) {
			log.error(`forkSessionAt failed`, err);
			return c.json({ error: String(err) }, 400);
		}
		if (!forked) return c.json({ error: "session not found" }, 404);
		try {
			const handle = await bridge.resumeSession({ sessionPath: forked.sessionFile });
			const resp: CreateSessionResponse = {
				sessionId: handle.sessionId,
				sessionFile: handle.sessionFile,
				cwd: handle.cwd,
			};
			return c.json(resp);
		} catch (err) {
			log.error(`resumeSession after fork failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions", async (c) => {
		let body: CreateSessionRequest;
		try {
			body = (await c.req.json()) as CreateSessionRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		const requestedCwd = body.cwd?.trim();
		const cwd = requestedCwd || config.defaultCwd;

		// Only gate cwds the caller actually supplied — resuming a session or
		// falling back to the (already-trusted) default shouldn't re-validate.
		if (!body.resumeFromPath && requestedCwd && !isCwdAllowed(requestedCwd)) {
			return c.json({ error: cwdNotAllowedMessage() }, 400);
		}

		// Model + Plan Mode are creation-time-only options (T-39): a resumed
		// session keeps its persisted state instead of taking a fresh default,
		// so combining them with `resumeFromPath` is rejected rather than
		// silently ignored.
		if (body.resumeFromPath && (body.model || body.planMode)) {
			return c.json(
				{ error: "model and planMode cannot be combined with resumeFromPath" },
				400,
			);
		}

		// Resolve the model to apply: explicit request > per-workspace default
		// (T-42) > undefined (SDK/OMP_MODEL picks its own default). Only when
		// creating fresh — resume never takes a model.
		let resolvedModel: ModelRef | undefined;
		let resolvedThinking: string | undefined;
		if (!body.resumeFromPath) {
			const workspacePref = getWorkspacePreference(cwd);
			resolvedModel = body.model ?? workspacePref?.model;
			// Thinking: explicit request > workspace default > undefined.
			resolvedThinking = (body.thinking ?? workspacePref?.thinking) ?? undefined;
			if (resolvedModel) {
				const invalid = await validateModelRef(bridge, resolvedModel);
				if (invalid) return c.json({ error: invalid }, 400);
			}
		}

		try {
			const handle = body.resumeFromPath
				? await bridge.resumeSession({ sessionPath: body.resumeFromPath })
				: await bridge.createSession({
						cwd,
						...(resolvedModel ? { model: resolvedModel } : {}),
						...(body.planMode ? { planMode: true } : {}),
						...(resolvedThinking ? { thinking: resolvedThinking } : {}),
					});
			const resp: CreateSessionResponse = {
				sessionId: handle.sessionId,
				sessionFile: handle.sessionFile,
				cwd: handle.cwd,
			};
			return c.json(resp);
		} catch (err) {
			log.error(`createSession failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions/:id/abort", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		try {
			await handle.abort();
			return c.json({ ok: true });
		} catch (err) {
			log.error(`abort failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions/:id/compact", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		// Body is optional — accept missing/empty JSON without bouncing.
		let body: { focus?: string } = {};
		try {
			const raw = await c.req.text();
			if (raw.trim().length > 0) body = JSON.parse(raw) as { focus?: string };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			await handle.compact(body.focus);
			return c.json({ ok: true });
		} catch (err) {
			log.error(`compact failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.patch("/sessions/:id", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found or not active" }, 404);
		let body: { name?: string; model?: { provider?: unknown; id?: unknown }; thinking?: unknown };
		try {
			body = (await c.req.json()) as { name?: string; model?: { provider?: unknown; id?: unknown }; thinking?: unknown };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (body.model !== undefined && body.thinking !== undefined) {
			return c.json({ error: "model and thinking must change in separate requests" }, 400);
		}
		let thinking: string | undefined;
		if (body.thinking !== undefined) {
			if (typeof body.thinking !== "string" || !body.thinking.trim()) {
				return c.json({ error: "thinking must be a non-empty string" }, 400);
			}
			thinking = body.thinking.trim();
			const snapshot = await handle.snapshot();
			if (snapshot.planMode?.modelOverride) {
				return c.json({ error: "thinking cannot change while Plan Mode overrides the model" }, 409);
			}
			if (await handle.isStreamingNow()) {
				return c.json({ error: "thinking cannot change while a turn is streaming" }, 409);
			}
			if (!snapshot.model) {
				return c.json({ error: "session has no active model" }, 409);
			}
			const model = (await bridge.listModels({ sessionId: id })).find(
				(candidate) => candidate.provider === snapshot.model?.provider && candidate.id === snapshot.model?.id,
			);
			if (!model?.thinkingLevels?.length) {
				return c.json({ error: "active model does not support thinking" }, 400);
			}
			if (thinking !== "off" && !model.thinkingLevels.includes(thinking)) {
				return c.json({ error: "thinking level is not supported by the active model" }, 400);
			}
		}
		try {
			let changed = false;
			if (typeof body.name === "string") {
				await handle.setName(body.name.trim());
				changed = true;
			}
			if (body.model && typeof body.model === "object") {
				const provider = typeof body.model.provider === "string" ? body.model.provider : "";
				const modelId = typeof body.model.id === "string" ? body.model.id : "";
				if (!provider || !modelId) {
					return c.json({ error: "model requires provider and id strings" }, 400);
				}
				await handle.setModel({ provider, id: modelId });
				changed = true;
			}
			if (thinking !== undefined) {
				await handle.setThinkingLevel(thinking);
				changed = true;
			}
			if (changed) broadcastBus.broadcast({ type: "sessions_changed" });
			return c.json({ ok: true, sessionId: id });
		} catch (err) {
			const message = String((err as Error).message ?? err);
			if (message.startsWith("thinking cannot change while")) {
				return c.json({ error: message }, 409);
			}
			log.error(`patch session failed`, err);
			return c.json({ error: message }, 500);
		}
	});

	app.get("/models", async (c) => {
		const sessionId = c.req.query("sessionId");
		try {
			const opts: { sessionId?: string } = {};
			if (sessionId) opts.sessionId = sessionId;
			const models = await bridge.listModels(opts);
			const active = models.find((m) => m.isCurrent);
			const body: ListModelsResponse = {
				models,
				...(active ? { active: { provider: active.provider, id: active.id } } : {}),
			};
			return c.json(body);
		} catch (err) {
			log.error(`listModels failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.delete("/sessions/:id", async (c) => {
		const id = c.req.param("id");
		try {
			const result = await bridge.deleteSession(id);
			if (!result.deleted) return c.json({ error: "session not found" }, 404);
			broadcastBus.broadcast({ type: "sessions_changed" });
			return c.json({ ok: true });
		} catch (err) {
			log.error(`delete session failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	// ─── Task rewrite (T-76) ──────────────────────────────────────────────
	// Mounted here (not in buildTasksRouter) because it needs `bridge` and
	// `config.defaultCwd` which the static task router doesn't carry.

	app.post("/tasks/:id/rewrite", async (c) => {
		const id = c.req.param("id");
		const task = getTask(id);
		if (!task) return c.json({ error: "task not found" }, 404);

		let reqBody: RewriteTaskRequest = {};
		try {
			const raw = await c.req.text();
			if (raw.trim()) reqBody = JSON.parse(raw) as RewriteTaskRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		// Model resolution: explicit override in request > server-wide setting > SDK default.
		const configuredModel = getTaskRewriteModel();
		const model = reqBody.model ?? configuredModel ?? undefined;

		if (model) {
			const invalid = await validateModelRef(bridge, model);
			if (invalid) return c.json({ error: invalid }, 400);
		}

		const cwd = task.cwd ?? config.defaultCwd;
		const projectContext = task.cwd ? `\nProject path: ${task.cwd}` : "";
		const prompt = [
			"You are a technical project manager. Rewrite the following kanban task to be clearer, more specific, and actionable.",
			"Keep the scope unchanged — do not add or remove work, just improve clarity and completeness.",
			projectContext,
			"",
			`Current title: ${JSON.stringify(task.title)}`,
			`Current priority: ${task.priority}`,
			`Current difficulty: ${task.difficulty}`,
			`Current body:\n${task.body ?? "(empty)"}`,
			"",
			"The rewritten task must preserve the priority and difficulty fields from above — do not change or omit them.",
			"Return ONLY a JSON object with exactly these fields — no markdown fences, no prose, no explanation:",
			'{"title": "<improved one-line title>", "body": "<improved body, markdown allowed>"}',
		].filter(Boolean).join("\n");

		let session: SessionHandle | undefined;
		try {
			session = await bridge.createSession({
				cwd,
				systemPromptOverride: await resolveIntegrationPrompt(kb, "task-rewrite"),
				internal: true,
				...(model ? { model } : {}),
			});
			const terminal = waitForAutoWorkSessionTerminal(session, 60_000);
			await session.prompt(prompt);
			const outcome = await terminal;
			if (outcome !== "completed") {
				return c.json({ error: `rewrite session ${outcome}` }, 500);
			}
			const snapshot = await session.snapshot();
			const text = extractLatestAssistantText(snapshot.messages);
			const parsed = extractJsonObject(text);
			const parsedTitle = parsed?.["title"];
			const parsedBody = parsed?.["body"];
			if (!parsed || typeof parsedTitle !== "string" || typeof parsedBody !== "string") {
				return c.json({ error: "model did not return expected JSON" }, 500);
			}
			const resp: RewriteTaskResponse = { title: parsedTitle, body: parsedBody };
			return c.json(resp);
		} catch (err) {
			log.error("task rewrite failed", err);
			return c.json({ error: String(err) }, 500);
		} finally {
			if (session) {
				bridge.deleteSession(session.sessionId).catch((err) => {
					log.warn("task rewrite session cleanup failed", err);
				});
			}
		}
	});

	app.route("/", buildTasksRouter());
	app.route("/", buildUploadsRouter({ uploadsRoot: config.uploadsRoot }));
	app.route("/", buildRoutinesRouter(runner));
	app.route("/", buildHooksRouter(runner));
	app.route("/", buildInboxRouter());
	app.route("/", buildUtilityRouter());
	app.route("/", buildSlashCommandsRouter());
	app.route("/", buildFsRouter());
	app.route("/", buildSettingsRouter(bridge, config, opts));
	app.route("/", buildDelegationRouter());
	app.route("/", buildPoliciesRouter());
	app.route("/", buildAdvisorsRouter());
	app.route("/", buildOrientationRouter());
	app.route("/", buildBridgesRouter(supervisor));
	app.route("/", buildMarketplaceRouter(marketplace));
	app.route("/", buildSkillsRouter(skills));
	app.route("/", buildKbRouter(kb));
	app.route("/auth/oauth", buildAuthOAuthRouter());
	app.route("/", buildCodebaseMemoryRouter(isCwdAllowed));
	app.route("/", buildMemoryRouter(isCwdAllowed));
	app.route("/onboarding", buildOnboardingRouter());
	app.route("/", buildUsageRouter(bridge, config));
	app.route("/", buildAutoWorkRouter(bridge, config));
	app.route("/", buildGovernanceRouter(bridge));

	return app;
}

/**
 * Validate a `ModelRef` against the bridge's live model catalog. Returns an
 * error message when the model is unknown or lacks configured auth; returns
 * `undefined` when it is safe to use. Used by both `POST /sessions` and
 * `PUT /workspace-preferences` so an unauthenticated/unknown model never gets
 * silently swapped for the SDK default — the caller gets a 400 instead.
 */
async function validateModelRef(bridge: AgentBridge, ref: ModelRef): Promise<string | undefined> {
	const models = await bridge.listModels();
	const match = models.find((m) => m.provider === ref.provider && m.id === ref.id);
	if (match) {
		if (!match.isAvailable) return `no auth configured for ${ref.provider}/${ref.id}`;
		return undefined;
	}
	// Not in the picker-visible list. Distinguish "unknown to the SDK"
	// (bad input) from "shadowed by the catalog overlay" (transient
	// failure-driven or upstream-removed). The error message only
	// reaches the server log + the 400 body — the picker doesn't show
	// it to the user, so the wording is purely operational.
	const shadowed = getModelCatalogOverlay()
		.listShadowed()
		.some((s) => s.provider === ref.provider && s.id === ref.id);
	if (shadowed) {
		return `unavailable: ${ref.provider}/${ref.id} (shadowed by catalog overlay)`;
	}
	return `unknown model: ${ref.provider}/${ref.id}`;
}

/**
 * Extract the text content of the most recent assistant message. Mirrors the
 * same logic in `auto-work/engine.ts` for the model-as-selector pattern.
 */
export function extractLatestAssistantText(messages: AgentMessageJson[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!;
		if (msg.role !== "assistant") continue;
		if (typeof msg.content === "string") return msg.content;
		if (!Array.isArray(msg.content)) continue;
		const text = msg.content.flatMap((b: unknown) => {
			if (
				b &&
				typeof b === "object" &&
				"type" in b &&
				b.type === "text" &&
				"text" in b &&
				typeof b.text === "string"
			) return [b.text];
			return [];
		}).join("");
		if (text) return text;
	}
	return "";
}

/**
 * Try to extract a JSON object from model output. Handles bare JSON,
 * markdown-fenced JSON, and JSON embedded in prose.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
	const candidates: string[] = [text.trim()];
	const fence = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
	if (fence?.[1]) candidates.push(fence[1].trim());
	const obj = /\{[\s\S]*\}/u.exec(text);
	if (obj?.[0]) candidates.push(obj[0]);
	for (const c of candidates) {
		try {
			const val: unknown = JSON.parse(c);
			if (val && typeof val === "object" && !Array.isArray(val)) {
				return val as Record<string, unknown>;
			}
		} catch { /* try next candidate */ }
	}
	return null;
}
