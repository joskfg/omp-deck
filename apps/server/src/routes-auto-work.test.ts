/**
 * Exercises the real Hono router for `/auto-work/*` (T-60, T-62): defaults
 * when unconfigured, persistence across a simulated restart (close + reopen
 * the same on-disk DB file), server-side validation of the PUT body, and
 * the run-history/cost-estimate read surface.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { UsageReport } from "@oh-my-pi/pi-ai";

import type {
	AutoWorkConfig,
	AutoWorkCostEstimateResponse,
	AutoWorkGlobalConfig,
	ListAutoWorkRunsResponse,
	ModelInfo,
	SetAutoWorkConfigRequest,
	SetAutoWorkGlobalConfigRequest,
} from "@omp-deck/protocol";

import { closeDb, openDb } from "./db/index.ts";
import { DEFAULT_AUTO_WORK_VALUES, setAutoWorkConfig } from "./db/auto-work.ts";
import { completeAutoWorkRun, getAutoWorkRun, listAutoWorkRuns, startAutoWorkRun } from "./db/auto-work-runs.ts";
import { createTask, deleteTask, getTask } from "./db/tasks.ts";
import { buildAutoWorkRouter } from "./routes-auto-work.ts";
import type { AgentBridge, EventListener, SessionHandle } from "./bridge/types.ts";
import type { Config } from "./config.ts";
import { resetSubscriptionUsageCacheForTests } from "./usage-subscription.ts";
import { disposeScheduler } from "./auto-work/scheduler.ts";

let dbDir: string;
let dbPath: string;

function fakeConfig(): Config {
	return { port: 8787 } as Config;
}

const AVAILABLE_MODEL: ModelInfo = {
	provider: "anthropic",
	id: "claude-good",
	label: "Claude Good",
	isAvailable: true,
};
const UNAUTHED_MODEL: ModelInfo = {
	provider: "anthropic",
	id: "claude-noauth",
	label: "Claude No Auth",
	isAvailable: false,
};

function fakeBridge(models: ModelInfo[]): AgentBridge {
	return {
		async listModels() {
			return models;
		},
	} as unknown as AgentBridge;
}

function fullConfigBody(overrides: Partial<SetAutoWorkConfigRequest> = {}): SetAutoWorkConfigRequest {
	return {
		enabled: true,
		autoMerge: false,
		modelByPriority: { P0: null, P1: null, P2: null, P3: null, P4: null, P5: null },
		timeWindows: [{ start: 9, end: 17 }],
		sessionPctLimit: 25,
		weeklyPctLimit: 60,
		weeklyPctThreshold: 80,
		defaultEstimatePctByPriority: { P0: 20, P1: 15, P2: 10, P3: 8, P4: 5, P5: 3 },
		estimationBuffer: 1.3,
		timeoutMinutesByPriority: { P0: 120, P1: 90, P2: 60, P3: 45, P4: 45, P5: 45 },
		...overrides,
	};
}

function globalConfigBody(
	overrides: Partial<SetAutoWorkGlobalConfigRequest> = {},
): SetAutoWorkGlobalConfigRequest {
	return {
		scheduleEnabled: true,
		scheduleIntervalMinutes: 15,
		taskSelectionModel: { provider: "anthropic", id: "claude-good" },
		squeezeEnabled: false,
		...overrides,
	};
}

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-auto-work-db-"));
	dbPath = path.join(dbDir, "deck.db");
	openDb({ path: dbPath });
});

afterEach(() => {
	disposeScheduler();
	closeDb();
	try {
		fs.rmSync(dbDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

describe("GET and PUT /auto-work/global-config", () => {
	test("GET returns the computed global config when no row exists", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());

		const res = await app.request("/auto-work/global-config");
		expect(res.status).toBe(200);
		const body = (await res.json()) as AutoWorkGlobalConfig;
		expect(body).toMatchObject({
			scheduleEnabled: false,
			scheduleIntervalMinutes: 5,
			taskSelectionModel: null,
			squeezeEnabled: false,
		});
	});

	test("PUT saves and returns a global schedule configuration", async () => {
		const app = buildAutoWorkRouter(fakeBridge([AVAILABLE_MODEL]), fakeConfig());
		const request = globalConfigBody();

		const putRes = await app.request("/auto-work/global-config", {
			method: "PUT",
			body: JSON.stringify(request),
		});
		expect(putRes.status).toBe(200);
		const saved = (await putRes.json()) as AutoWorkGlobalConfig;
		expect(saved).toMatchObject(request);

		const getRes = await app.request("/auto-work/global-config");
		expect(getRes.status).toBe(200);
		expect((await getRes.json()) as AutoWorkGlobalConfig).toMatchObject(request);
	});

	test("PUT rejects a non-positive schedule interval", async () => {
		const app = buildAutoWorkRouter(fakeBridge([AVAILABLE_MODEL]), fakeConfig());

		const res = await app.request("/auto-work/global-config", {
			method: "PUT",
			body: JSON.stringify(globalConfigBody({ scheduleIntervalMinutes: 0 })),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "scheduleIntervalMinutes must be a positive integer" });
	});

	test("PUT rejects an unknown task-selection model", async () => {
		const app = buildAutoWorkRouter(fakeBridge([AVAILABLE_MODEL]), fakeConfig());

		const res = await app.request("/auto-work/global-config", {
			method: "PUT",
			body: JSON.stringify(globalConfigBody({ taskSelectionModel: { provider: "unknown", id: "missing" } })),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "taskSelectionModel: unknown model: unknown/missing" });
	});

	test("PUT rejects a task-selection model without configured auth", async () => {
		const app = buildAutoWorkRouter(fakeBridge([UNAUTHED_MODEL]), fakeConfig());

		const res = await app.request("/auto-work/global-config", {
			method: "PUT",
			body: JSON.stringify(globalConfigBody({ taskSelectionModel: { provider: "anthropic", id: "claude-noauth" } })),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "taskSelectionModel: no auth configured for anthropic/claude-noauth" });
	});

	test("PUT rejects a non-boolean squeezeEnabled", async () => {
		const app = buildAutoWorkRouter(fakeBridge([AVAILABLE_MODEL]), fakeConfig());

		const res = await app.request("/auto-work/global-config", {
			method: "PUT",
			body: JSON.stringify(globalConfigBody({ squeezeEnabled: "yes" as unknown as boolean })),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "squeezeEnabled must be a boolean" });
	});

	test("PUT rejects a body that omits squeezeEnabled entirely", async () => {
		const app = buildAutoWorkRouter(fakeBridge([AVAILABLE_MODEL]), fakeConfig());

		// `SetAutoWorkGlobalConfigRequest` marks squeezeEnabled required, so bypass
		// the TS type to simulate a client that never sends the field at all.
		const bodyWithoutSqueeze = {
			...globalConfigBody(),
			squeezeEnabled: undefined,
		} as unknown as SetAutoWorkGlobalConfigRequest;
		const serialized = JSON.stringify(bodyWithoutSqueeze);
		// Confirm JSON.stringify actually drops undefined-valued keys rather than
		// assuming it, so this test truly exercises an omitted field, not a
		// `squeezeEnabled: null`/"undefined" literal on the wire.
		expect(serialized).not.toContain("squeezeEnabled");

		const res = await app.request("/auto-work/global-config", {
			method: "PUT",
			body: serialized,
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "squeezeEnabled must be a boolean" });
	});

	test("PUT with squeezeEnabled true persists and round-trips", async () => {
		const app = buildAutoWorkRouter(fakeBridge([AVAILABLE_MODEL]), fakeConfig());
		const request = globalConfigBody({ squeezeEnabled: true });

		const putRes = await app.request("/auto-work/global-config", {
			method: "PUT",
			body: JSON.stringify(request),
		});
		expect(putRes.status).toBe(200);
		expect(await putRes.json()).toMatchObject({ squeezeEnabled: true });

		const getRes = await app.request("/auto-work/global-config");
		expect(getRes.status).toBe(200);
		expect(await getRes.json()).toMatchObject({ squeezeEnabled: true });
	});

	test("PUT toggles squeezeEnabled from true back to false", async () => {
		const app = buildAutoWorkRouter(fakeBridge([AVAILABLE_MODEL]), fakeConfig());

		const onRes = await app.request("/auto-work/global-config", {
			method: "PUT",
			body: JSON.stringify(globalConfigBody({ squeezeEnabled: true })),
		});
		expect(onRes.status).toBe(200);
		expect(await onRes.json()).toMatchObject({ squeezeEnabled: true });

		const offRes = await app.request("/auto-work/global-config", {
			method: "PUT",
			body: JSON.stringify(globalConfigBody({ squeezeEnabled: false })),
		});
		expect(offRes.status).toBe(200);
		expect(await offRes.json()).toMatchObject({ squeezeEnabled: false });

		const getRes = await app.request("/auto-work/global-config");
		expect(getRes.status).toBe(200);
		expect(await getRes.json()).toMatchObject({ squeezeEnabled: false });
	});
});

describe("GET /auto-work/config", () => {
	test("requires a cwd query param", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const res = await app.request("/auto-work/config");
		expect(res.status).toBe(400);
	});

	test("accepts any absolute path (NFS, outside $HOME) — config is a pure DB key", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent("/mnt/nas/Public/openscad")}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as AutoWorkConfig;
		expect(body.workspaceCwd).toBe("/mnt/nas/Public/openscad");
		expect(body.enabled).toBe(false);
	});

	test("returns computed defaults when no config exists", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as AutoWorkConfig;
		expect(body.workspaceCwd).toBe(cwd);
		expect(body.enabled).toBe(false);
		expect(body.modelByPriority).toEqual({ P0: null, P1: null, P2: null, P3: null, P4: null, P5: null });
		expect(body.timeWindows).toEqual([{ start: 0, end: 24 }]);
		expect(body.sessionPctLimit).toBe(100);
		expect(body.weeklyPctLimit).toBe(100);
	});
});

describe("PUT /auto-work/config — validation", () => {
	test("rejects a missing cwd", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const res = await app.request("/auto-work/config", {
			method: "PUT",
			body: JSON.stringify(fullConfigBody()),
		});
		expect(res.status).toBe(400);
	});

	test("rejects invalid json", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	test("rejects a missing priority key in modelByPriority", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const cwd = process.cwd();
		const bad = fullConfigBody();
		delete (bad.modelByPriority as Record<string, unknown>).P3;
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(bad),
		});
		expect(res.status).toBe(400);
	});

	test("rejects overlapping timeWindows", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody({ timeWindows: [{ start: 0, end: 10 }, { start: 8, end: 14 }] })),
		});
		expect(res.status).toBe(400);
	});

	test("accepts multiple non-overlapping timeWindows", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody({ timeWindows: [{ start: 0, end: 6 }, { start: 13, end: 15 }, { start: 20, end: 24 }] })),
		});
		expect(res.status).toBe(200);
	});

	test("rejects an out-of-range pct limit", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody({ sessionPctLimit: 150 })),
		});
		expect(res.status).toBe(400);
	});

	test("rejects an out-of-range weekly threshold", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody({ weeklyPctThreshold: -1 })),
		});
		expect(res.status).toBe(400);
	});

	test("rejects an unknown model override", async () => {
		const app = buildAutoWorkRouter(fakeBridge([AVAILABLE_MODEL]), fakeConfig());
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(
				fullConfigBody({ modelByPriority: { P0: { provider: "nope", id: "nope" }, P1: null, P2: null, P3: null, P4: null, P5: null } }),
			),
		});
		expect(res.status).toBe(400);
	});

	test("rejects a model override with no configured auth", async () => {
		const app = buildAutoWorkRouter(fakeBridge([UNAUTHED_MODEL]), fakeConfig());
		const cwd = process.cwd();
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(
				fullConfigBody({
					modelByPriority: {
						P0: { provider: "anthropic", id: "claude-noauth" },
						P1: null,
						P2: null,
						P3: null,
						P4: null,
						P5: null,
					},
				}),
			),
		});
		expect(res.status).toBe(400);
	});
});

describe("PUT /auto-work/config — persistence", () => {
	test("round-trips a full config through GET", async () => {
		const app = buildAutoWorkRouter(fakeBridge([AVAILABLE_MODEL]), fakeConfig());
		const cwd = process.cwd();
		const putRes = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(
				fullConfigBody({
					modelByPriority: {
						P0: { provider: "anthropic", id: "claude-good" },
						P1: null,
						P2: null,
						P3: null,
						P4: null,
						P5: null,
					},
				}),
			),
		});
		expect(putRes.status).toBe(200);

		const getRes = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`);
		const body = (await getRes.json()) as AutoWorkConfig;
		expect(body.enabled).toBe(true);
		expect(body.modelByPriority.P0).toEqual({ provider: "anthropic", id: "claude-good" });
		expect(body.modelByPriority.P1).toBeNull();
		expect(body.timeWindows).toEqual([{ start: 9, end: 17 }]);
		expect(body.sessionPctLimit).toBe(25);
		expect(body.weeklyPctLimit).toBe(60);
	});

	test("persists across a simulated server restart (close + reopen the DB file)", async () => {
		const cwd = process.cwd();
		const app1 = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		await app1.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody()),
		});

		closeDb();
		openDb({ path: dbPath });

		const app2 = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const res = await app2.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`);
		const body = (await res.json()) as AutoWorkConfig;
		expect(body.enabled).toBe(true);
		expect(body.timeWindows).toEqual([{ start: 9, end: 17 }]);
		expect(body.sessionPctLimit).toBe(25);
		expect(body.weeklyPctLimit).toBe(60);
	});

	test("a second PUT replaces the prior config (upsert, not insert)", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const cwd = process.cwd();
		await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody({ enabled: true, sessionPctLimit: 25 })),
		});
		await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`, {
			method: "PUT",
			body: JSON.stringify(fullConfigBody({ enabled: false, sessionPctLimit: 80 })),
		});
		const res = await app.request(`/auto-work/config?cwd=${encodeURIComponent(cwd)}`);
		const body = (await res.json()) as AutoWorkConfig;
		expect(body.enabled).toBe(false);
		expect(body.sessionPctLimit).toBe(80);
	});
});

describe("GET /auto-work/runs", () => {
	test("returns an empty list when no runs exist", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const res = await app.request("/auto-work/runs");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListAutoWorkRunsResponse;
		expect(body.runs).toEqual([]);
	});

	test("reflects a run recorded via startAutoWorkRun/completeAutoWorkRun", async () => {
		const runId = startAutoWorkRun({
			taskId: "task-x",
			taskPriority: "P2",
			sessionId: "session-x",
			worktreePath: "/tmp/wt-x",
		});
		completeAutoWorkRun(runId, { status: "completed", inputTokens: 100, outputTokens: 50, pctConsumed: 1.5 });

		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const res = await app.request("/auto-work/runs");
		const body = (await res.json()) as ListAutoWorkRunsResponse;
		expect(body.runs.length).toBe(1);
		expect(body.runs[0]!.id).toBe(runId);
		expect(body.runs[0]!.status).toBe("completed");
		expect(body.runs[0]!.inputTokens).toBe(100);
		expect(body.runs[0]!.outputTokens).toBe(50);
		expect(body.runs[0]!.pctConsumed).toBe(1.5);
	});

	test("filters by taskId, priority, and status", async () => {
		const a = startAutoWorkRun({ taskId: "t-a", taskPriority: "P1", sessionId: "s-a", worktreePath: "/tmp/a" });
		completeAutoWorkRun(a, { status: "completed", pctConsumed: 1 });
		startAutoWorkRun({ taskId: "t-b", taskPriority: "P3", sessionId: "s-b", worktreePath: "/tmp/b" });

		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());

		const byTask = (await (await app.request("/auto-work/runs?taskId=t-a")).json()) as ListAutoWorkRunsResponse;
		expect(byTask.runs.map((r) => r.id)).toEqual([a]);

		const byPriority = (await (
			await app.request("/auto-work/runs?priority=P3")
		).json()) as ListAutoWorkRunsResponse;
		expect(byPriority.runs.length).toBe(1);
		expect(byPriority.runs[0]!.taskId).toBe("t-b");

		const byStatus = (await (
			await app.request("/auto-work/runs?status=completed")
		).json()) as ListAutoWorkRunsResponse;
		expect(byStatus.runs.map((r) => r.id)).toEqual([a]);
	});

	test("rejects an invalid priority or status filter", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		expect((await app.request("/auto-work/runs?priority=P9")).status).toBe(400);
		expect((await app.request("/auto-work/runs?status=bogus")).status).toBe(400);
		expect((await app.request("/auto-work/runs?limit=0")).status).toBe(400);
		expect((await app.request("/auto-work/runs?limit=abc")).status).toBe(400);
	});
});

describe("GET /auto-work/cost-estimate", () => {
	test("requires a valid priority query param", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		expect((await app.request("/auto-work/cost-estimate")).status).toBe(400);
		expect((await app.request("/auto-work/cost-estimate?priority=nope")).status).toBe(400);
	});

	test("returns null average with zero sample size when no history exists", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const res = await app.request("/auto-work/cost-estimate?priority=P4");
		expect(res.status).toBe(200);
		const body = (await res.json()) as AutoWorkCostEstimateResponse;
		expect(body).toEqual({ avgPctConsumed: null, sampleSize: 0 });
	});

	test("averages the last 10 completed runs at the given priority", async () => {
		for (let i = 1; i <= 12; i++) {
			const runId = startAutoWorkRun({
				taskId: `p2-${i}`,
				taskPriority: "P2",
				sessionId: `s-${i}`,
				worktreePath: `/tmp/${i}`,
			});
			completeAutoWorkRun(runId, { status: "completed", pctConsumed: i });
		}

		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const res = await app.request("/auto-work/cost-estimate?priority=P2");
		const body = (await res.json()) as AutoWorkCostEstimateResponse;
		expect(body.sampleSize).toBe(10);
		expect(body.avgPctConsumed).toBe(7.5);
	});
});

describe("POST /auto-work/runs/:id/create-pr", () => {
	test("404 when the run id does not exist", async () => {
		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const res = await app.request("/auto-work/runs/awrun_nonexistent/create-pr", { method: "POST" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "run not found" });
	});

	test("400 when the run status is 'running' (not retryable)", async () => {
		const task = createTask({ title: "In flight", cwd: "/tmp/wt-running" });
		const runId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P2",
			sessionId: "sess-running",
			worktreePath: "/tmp/wt-running",
		});

		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const res = await app.request(`/auto-work/runs/${runId}/create-pr`, { method: "POST" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("run is not completed (status: running)");

		// Not mutated: still running.
		expect(getAutoWorkRun(runId)?.status).toBe("running");
	});

	test("400 when the run status is 'failed' (not retryable)", async () => {
		const task = createTask({ title: "Failed run", cwd: "/tmp/wt-failed" });
		const runId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P2",
			sessionId: "sess-failed",
			worktreePath: "/tmp/wt-failed",
		});
		completeAutoWorkRun(runId, { status: "failed", failureReason: "agent crashed" });

		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const res = await app.request(`/auto-work/runs/${runId}/create-pr`, { method: "POST" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("run is not completed (status: failed)");
	});

	test("200: retries a completed_pr_failed run, flips it back to completed, and appends (not replaces) Agent History", async () => {
		const task = createTask({
			title: "Retry me",
			body: "## Description\nOriginal task body content that must survive the retry.",
			cwd: "/tmp/wt-retry",
		});
		const runId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P2",
			sessionId: "sess-retry",
			worktreePath: "/tmp/wt-retry",
		});
		completeAutoWorkRun(runId, {
			status: "completed_pr_failed",
			failureReason: "some prior gh error",
			inputTokens: 10,
			outputTokens: 5,
			pctConsumed: 2,
		});

		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig(), {
			createPullRequest: async () => ({ url: "https://github.com/jaesbit/omp-deck/pull/42", number: 42 }),
		});
		const res = await app.request(`/auto-work/runs/${runId}/create-pr`, { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ number: 42, url: "https://github.com/jaesbit/omp-deck/pull/42" });

		const updatedRun = getAutoWorkRun(runId);
		expect(updatedRun?.status).toBe("completed");
		expect(updatedRun?.failureReason).toBeNull();
		expect(updatedRun?.inputTokens).toBe(10);
		expect(updatedRun?.outputTokens).toBe(5);
		expect(updatedRun?.pctConsumed).toBe(2);

		const updatedTask = getTask(task.id);
		expect(updatedTask?.body).toContain("## Description\nOriginal task body content that must survive the retry.");
		expect(updatedTask?.body).toContain("## Agent History");
		expect(updatedTask?.body).toMatch(new RegExp(`### .+ — run ${runId}\\nPR retry succeeded: PR #42\\.`));
	});

	test("200: also accepts a plain 'completed' run (backward-compat path for pre-T-85 rows)", async () => {
		const task = createTask({ title: "Old-style completed", cwd: "/tmp/wt-old" });
		const runId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P3",
			sessionId: "sess-old",
			worktreePath: "/tmp/wt-old",
		});
		completeAutoWorkRun(runId, { status: "completed", inputTokens: 1, outputTokens: 1, pctConsumed: 0.5 });

		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig(), {
			createPullRequest: async () => ({ url: "https://github.com/jaesbit/omp-deck/pull/7", number: 7 }),
		});
		const res = await app.request(`/auto-work/runs/${runId}/create-pr`, { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ number: 7, url: "https://github.com/jaesbit/omp-deck/pull/7" });

		const updatedRun = getAutoWorkRun(runId);
		expect(updatedRun?.status).toBe("completed");
		expect(updatedRun?.failureReason).toBeNull();
	});

	test("500 when createPullRequest rejects, and leaves the run status/failureReason unchanged", async () => {
		const task = createTask({ title: "PR fails again", cwd: "/tmp/wt-boom" });
		const runId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P2",
			sessionId: "sess-boom",
			worktreePath: "/tmp/wt-boom",
		});
		completeAutoWorkRun(runId, {
			status: "completed_pr_failed",
			failureReason: "first gh error",
			inputTokens: 3,
			outputTokens: 4,
			pctConsumed: 1,
		});

		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig(), {
			createPullRequest: async () => {
				throw new Error("boom");
			},
		});
		const res = await app.request(`/auto-work/runs/${runId}/create-pr`, { method: "POST" });
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "boom" });

		const unchanged = getAutoWorkRun(runId);
		expect(unchanged?.status).toBe("completed_pr_failed");
		expect(unchanged?.failureReason).toBe("first gh error");
		expect(unchanged?.inputTokens).toBe(3);
		expect(unchanged?.outputTokens).toBe(4);
		expect(unchanged?.pctConsumed).toBe(1);

		const unchangedTask = getTask(task.id);
		expect(unchangedTask?.body ?? "").not.toContain("PR retry succeeded");
	});

	test("404 when the run's taskId no longer resolves to a real task", async () => {
		const task = createTask({ title: "Deleted after run start", cwd: "/tmp/wt-gone" });
		const runId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P2",
			sessionId: "sess-gone",
			worktreePath: "/tmp/wt-gone",
		});
		completeAutoWorkRun(runId, { status: "completed_pr_failed", failureReason: "err", pctConsumed: 1 });
		expect(deleteTask(task.id)).toBe(true);

		const app = buildAutoWorkRouter(fakeBridge([]), fakeConfig());
		const res = await app.request(`/auto-work/runs/${runId}/create-pr`, { method: "POST" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "task not found for run" });

		// Not mutated by the failed lookup.
		expect(getAutoWorkRun(runId)?.status).toBe("completed_pr_failed");
	});
});

/**
 * `POST /auto-work/trigger` exercises the global orchestrator with a stub
 * `AgentBridge` and a real git repository so worktree creation runs for real.
 */
describe("POST /auto-work/trigger", () => {
	class FakeSessionHandle {
		readonly sessionId: string;
		private listeners = new Set<EventListener>();

		constructor(
			sessionId: string,
			private readonly emitsTerminal: boolean,
			private readonly selectedTaskId?: string,
		) {
			this.sessionId = sessionId;
		}

		subscribe(listener: EventListener): () => void {
			this.listeners.add(listener);
			if (this.emitsTerminal) queueMicrotask(() => listener({ type: "turn_end" } as never));
			return () => this.listeners.delete(listener);
		}

		snapshot() {
			return { messages: [{ role: "assistant", content: this.selectedTaskId ?? "" }] };
		}

		async prompt(): Promise<void> {}
	}

	function triggerBridge(handle: FakeSessionHandle): AgentBridge {
		return {
			async listModels() {
				return [];
			},
			async createSession() {
				return handle as unknown as SessionHandle;
			},
			getSession() {
				return undefined;
			},
			async listSessions() {
				return [];
			},
			async deleteSession() {
				return { deleted: true };
			},
			async resumeSession() {
				throw new Error("no persisted session to resume in this fixture");
			},
		} as unknown as AgentBridge;
	}

	// Stubs `gh pr create` for the route-level trigger tests below — a real
	// invocation is never wanted here (this router doesn't own the PR
	// mechanics; that's covered by `auto-work/engine.test.ts`).
	async function stubCreatePullRequest() {
		return { url: "https://github.com/jaesbit/omp-deck/pull/999", number: 999 };
	}

	function runGit(args: string[], cwd: string): void {
		const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}

	let homeDir: string;
	let repoCwd: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		originalHome = process.env.HOME;
		homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-trigger-home-"));
		process.env.HOME = homeDir;
		repoCwd = path.join(homeDir, "workspace");
		fs.mkdirSync(repoCwd, { recursive: true });
		runGit(["init", "-q"], repoCwd);
		runGit(["config", "user.email", "test@example.com"], repoCwd);
		runGit(["config", "user.name", "Test"], repoCwd);
		fs.writeFileSync(path.join(repoCwd, "README.md"), "hello\n");
		runGit(["add", "."], repoCwd);
		runGit(["commit", "-q", "-m", "init"], repoCwd);

		resetSubscriptionUsageCacheForTests();
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		resetSubscriptionUsageCacheForTests();
		fs.rmSync(homeDir, { recursive: true, force: true });
	});

	test("runs enabled workspace work without requiring a cwd", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Trigger me", cwd: repoCwd, priority: "P5", autoWork: true });

		const app = buildAutoWorkRouter(triggerBridge(new FakeSessionHandle("sess_trigger", true, task.id)), fakeConfig(), {
			createPullRequest: stubCreatePullRequest,
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});
		const res = await app.request("/auto-work/trigger", { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { outcome: string; taskId?: string; runId?: string };
		expect(body.outcome).toBe("completed");
		expect(body.taskId).toBe(task.id);

		expect(getTask(task.id)?.stateId).toBe("s_validate");
		expect(listAutoWorkRuns({ taskId: task.id })[0]?.status).toBe("completed");
	});

	test("skips when every eligible workspace already has an active run", async () => {
		setAutoWorkConfig(repoCwd, { ...DEFAULT_AUTO_WORK_VALUES, enabled: true });
		const task = createTask({ title: "Already running", cwd: repoCwd, priority: "P5", autoWork: true });
		const priorRunId = startAutoWorkRun({
			taskId: task.id,
			taskPriority: "P5",
			sessionId: "in-flight",
			worktreePath: path.join(repoCwd, ".worktrees", "aw-in-flight"),
		});

		const app = buildAutoWorkRouter(triggerBridge(new FakeSessionHandle("sess_2", false)), fakeConfig(), {
			createPullRequest: stubCreatePullRequest,
			getSubscriptionUsage: async () => ({ available: true, weeklyPct: 5 }),
		});
		const res = await app.request("/auto-work/trigger", { method: "POST" });
		expect(res.status).toBe(200);
		expect((await res.json()) as { outcome: string; reason?: string }).toMatchObject({
			outcome: "skipped",
			reason: "another auto-work run is already active",
		});

		const runs = listAutoWorkRuns({ taskId: task.id });
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ id: priorRunId, status: "running" });
	});
});
