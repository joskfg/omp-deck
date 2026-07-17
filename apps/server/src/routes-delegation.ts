import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ApplyDelegationArtifactRequest,
	ApplyDelegationArtifactResponse,
	DelegationArtifactResponse,
	DelegationSettingEntry,
	DelegationSettingKey,
	DiscardDelegationArtifactRequest,
	DiscardDelegationArtifactResponse,
	GetDelegationSettingsResponse,
	PatchDelegationSettingsRequest,
} from "@omp-deck/protocol";
import { SETTINGS_SCHEMA, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { cleanupTaskBranches, getRepoRoot, mergeTaskBranches } from "@oh-my-pi/pi-coding-agent/task/worktree";

import { cwdNotAllowedMessage, isCwdAllowed, pathNotAllowedMessage } from "./routes-fs.ts";

/**
 * Delegation governance is a projection of OMP's own settings store. The deck
 * does not persist a second copy: updates write through the SDK Settings
 * singleton to ~/.omp/agent/config.yml. Artifact application and disposal are
 * explicit user actions only, never automatic deck behavior.
 */

const DELEGATION_SETTING_KEYS = [
	"task.maxConcurrency",
	"task.maxRecursionDepth",
	"task.maxRuntimeMs",
	"task.isolation.mode",
	"task.isolation.merge",
	"task.isolation.commits",
] as const satisfies readonly DelegationSettingKey[];

const MAX_ARTIFACT_BYTES = 512_000;

type DelegationValue = number | string | boolean;

export function buildDelegationRouter(): Hono {
	const app = new Hono();

	app.get("/delegation/settings", async (c) => c.json(await buildSettingsResponse()));

	app.patch("/delegation/settings", async (c) => {
		let body: PatchDelegationSettingsRequest;
		try {
			body = (await c.req.json()) as PatchDelegationSettingsRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.updates || typeof body.updates !== "object" || Array.isArray(body.updates)) {
			return c.json({ error: "updates must be an object" }, 400);
		}

		const cleaned: Array<[DelegationSettingKey, DelegationValue]> = [];
		for (const [rawKey, rawValue] of Object.entries(body.updates)) {
			if (!DELEGATION_SETTING_KEYS.includes(rawKey as DelegationSettingKey)) {
				return c.json({ error: `unknown delegation setting: ${rawKey}` }, 400);
			}
			const key = rawKey as DelegationSettingKey;
			const schema = SETTINGS_SCHEMA[key] as { type: string; values?: readonly string[] };
			if (schema.type === "number") {
				const value = typeof rawValue === "number" ? rawValue : typeof rawValue === "string" ? Number(rawValue) : Number.NaN;
				const min = key === "task.maxRecursionDepth" ? -1 : 0;
				if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
					return c.json({ error: `${key} must be an integer greater than or equal to ${min}` }, 400);
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
		for (const [key, value] of cleaned) {
			settings.set(key, value as never);
		}
		await settings.flush();
		return c.json(await buildSettingsResponse(settings));
	});

	app.get("/delegation/artifact", async (c) => {
		const artifactPath = c.req.query("path")?.trim();
		const validationError = await validatePatchArtifact(artifactPath);
		if (validationError) return c.json({ error: validationError.message }, validationError.status);
		const stat = await fs.stat(artifactPath!);
		const content = await Bun.file(artifactPath!).text();
		const body: DelegationArtifactResponse = {
			path: artifactPath!,
			content: content.slice(0, MAX_ARTIFACT_BYTES),
			truncated: stat.size > MAX_ARTIFACT_BYTES,
			sizeBytes: stat.size,
		};
		return c.json(body);
	});

	app.post("/delegation/artifact/apply", async (c) => {
		let body: ApplyDelegationArtifactRequest;
		try {
			body = (await c.req.json()) as ApplyDelegationArtifactRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.cwd || !path.isAbsolute(body.cwd) || !isCwdAllowed(body.cwd)) {
			return c.json({ error: cwdNotAllowedMessage() }, 403);
		}
		if (!!body.patchPath === !!body.branchName) {
			return c.json({ error: "provide exactly one of patchPath or branchName" }, 400);
		}

		let repoRoot: string;
		try {
			repoRoot = await getRepoRoot(body.cwd);
		} catch (err) {
			return c.json({ error: `cwd is not a git repository: ${String(err)}` }, 400);
		}

		if (body.patchPath) {
			const validationError = await validatePatchArtifact(body.patchPath);
			if (validationError) return c.json({ error: validationError.message }, validationError.status);
			const text = await Bun.file(body.patchPath).text();
			const normalized = text.endsWith("\n") ? text : `${text}\n`;
			const [alreadyApplied, forwardApplies] = await Promise.all([
				git.patch.canApplyText(repoRoot, normalized, { reverse: true }),
				git.patch.canApplyText(repoRoot, normalized),
			]);
			if (alreadyApplied && !forwardApplies) {
				return c.json({ ok: true, message: "patch already applied" } satisfies ApplyDelegationArtifactResponse);
			}
			if (!forwardApplies) {
				return c.json(
					{ ok: false, message: `patch does not apply cleanly — artifact preserved at ${body.patchPath}` } satisfies ApplyDelegationArtifactResponse,
					409,
				);
			}
			try {
				await git.patch.applyText(repoRoot, normalized);
				return c.json({ ok: true, message: "patch applied" } satisfies ApplyDelegationArtifactResponse);
			} catch (err) {
				return c.json(
					{ ok: false, message: `patch apply failed — artifact preserved at ${body.patchPath}: ${String(err)}` } satisfies ApplyDelegationArtifactResponse,
					409,
				);
			}
		}

		const merge = await mergeTaskBranches(repoRoot, [
			{ branchName: body.branchName!, taskId: body.branchName!, baseSha: body.branchBaseSha },
		]);
		if (merge.failed.length > 0) {
			return c.json(
				{ ok: false, message: `branch merge failed: ${merge.conflict ?? body.branchName}` } satisfies ApplyDelegationArtifactResponse,
				409,
			);
		}
		await cleanupTaskBranches(repoRoot, [body.branchName!]);
		return c.json({ ok: true, message: `branch ${body.branchName} merged` } satisfies ApplyDelegationArtifactResponse);
	});

	app.post("/delegation/artifact/discard", async (c) => {
		let body: DiscardDelegationArtifactRequest;
		try {
			body = (await c.req.json()) as DiscardDelegationArtifactRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.cwd || !path.isAbsolute(body.cwd) || !isCwdAllowed(body.cwd)) {
			return c.json({ error: cwdNotAllowedMessage() }, 403);
		}
		if (!!body.patchPath === !!body.branchName) {
			return c.json({ error: "provide exactly one of patchPath or branchName" }, 400);
		}
		if (body.patchPath) {
			const validationError = await validatePatchArtifact(body.patchPath);
			if (validationError) return c.json({ error: validationError.message }, validationError.status);
			await fs.unlink(body.patchPath);
			return c.json({ ok: true, message: `discarded patch ${body.patchPath}` } satisfies DiscardDelegationArtifactResponse);
		}

		let repoRoot: string;
		try {
			repoRoot = await getRepoRoot(body.cwd);
		} catch (err) {
			return c.json({ error: `cwd is not a git repository: ${String(err)}` }, 400);
		}
		const probe = Bun.spawn(["git", "rev-parse", "--verify", "--quiet", body.branchName!], {
			cwd: repoRoot,
			stdout: "ignore",
			stderr: "ignore",
		});
		if ((await probe.exited) !== 0) return c.json({ error: `branch not found: ${body.branchName}` }, 404);
		const discard = Bun.spawn(["git", "branch", "-D", body.branchName!], { cwd: repoRoot, stdout: "ignore", stderr: "pipe" });
		if ((await discard.exited) !== 0) {
			return c.json({ error: `failed to discard branch ${body.branchName}: ${await new Response(discard.stderr).text()}` }, 409);
		}
		return c.json({ ok: true, message: `discarded branch ${body.branchName}` } satisfies DiscardDelegationArtifactResponse);
	});

	return app;
}

async function buildSettingsResponse(existing?: Settings): Promise<GetDelegationSettingsResponse> {
	const settings = existing ?? (await Settings.init());
	const entries: DelegationSettingEntry[] = DELEGATION_SETTING_KEYS.map((key) => {
		const schema = SETTINGS_SCHEMA[key];
		const ui = schema.ui;
		return {
			key,
			type: schema.type as DelegationSettingEntry["type"],
			value: settings.get(key) as DelegationValue,
			defaultValue: (schema.default ?? null) as DelegationSettingEntry["defaultValue"],
			configured: settings.isConfigured(key),
			label: ui?.label ?? key,
			description: ui?.description ?? "",
			options: ui?.options?.map((option) => ({ ...option })),
		};
	});
	return { settings: entries, configPath: path.join(process.env.HOME ?? os.homedir(), ".omp", "agent", "config.yml") };
}

async function validatePatchArtifact(artifactPath: string | undefined): Promise<{ message: string; status: 400 | 403 | 404 } | null> {
	if (!artifactPath || !path.isAbsolute(artifactPath)) return { message: "path must be an absolute patch path", status: 400 };
	if (!artifactPath.endsWith(".patch")) return { message: "artifact path must end in .patch", status: 400 };
	if (!isCwdAllowed(path.dirname(artifactPath))) return { message: pathNotAllowedMessage("artifact path"), status: 403 };
	try {
		const stat = await fs.stat(artifactPath);
		if (!stat.isFile()) return { message: "artifact is not a file", status: 400 };
	} catch {
		return { message: "artifact not found", status: 404 };
	}
	return null;
}
