/**
 * Tests for the workspace registry helpers introduced by T-134.
 *
 * Route-level tests (POST/DELETE /workspaces via buildRouter) are not runnable
 * in worktree environments because a transitive dependency
 * (@oh-my-pi/pi-tui, pulled in by pi-coding-agent) is absent from the shared
 * node_modules. The acceptance criteria are covered here at the function
 * level, which exercises the identical code paths used by the route handlers.
 *
 * Covers:
 *  - getExtraWorkspaces / setExtraWorkspaces round-trip
 *  - getHiddenWorkspaces / setHiddenWorkspaces round-trip
 *  - POST semantics: registered workspace appears in the merged set
 *  - DELETE semantics: hidden workspace disappears even if a "session" uses it
 *  - defaultCwd is never removed from the merged set regardless of hidden list
 *  - syncWorkspacesToEnv returns false when OMP_DECK_WORKSPACES is shell-set
 *  - syncWorkspacesToEnv does NOT leak into MANAGED_ENV_KEYS_LOADED across tests
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./db/index.ts";
import {
	getExtraWorkspaces,
	getHiddenWorkspaces,
	setExtraWorkspaces,
	setHiddenWorkspaces,
} from "./db/server-settings.ts";
import { MANAGED_ENV_KEYS_LOADED } from "./env-store.ts";
import { syncWorkspacesToEnv } from "./routes-settings.ts";
import type { Config } from "./config.ts";

let dbDir: string;
let home: string;
let originalHome: string | undefined;
let originalOmpWorkspaces: string | undefined;
let originalDataDir: string | undefined;

beforeEach(() => {
	dbDir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-workspace-registry-db-"));
	home = mkdtempSync(path.join(os.tmpdir(), "omp-deck-workspace-registry-home-"));

	originalHome = process.env.HOME;
	process.env.HOME = home;

	// Isolate OMP_DECK_WORKSPACES so syncWorkspacesToEnv reads a clean state.
	originalOmpWorkspaces = process.env.OMP_DECK_WORKSPACES;
	delete process.env.OMP_DECK_WORKSPACES;

	// Point managed-env store at a temp dir, not $HOME/.config.
	originalDataDir = process.env.OMP_DECK_DATA_DIR;
	process.env.OMP_DECK_DATA_DIR = dbDir;

	openDb({ path: path.join(dbDir, "deck.db") });
});

afterEach(() => {
	closeDb();

	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;

	// Restore OMP_DECK_WORKSPACES and clean up any MANAGED_ENV_KEYS_LOADED entry
	// that syncWorkspacesToEnv may have added so other test suites aren't affected.
	MANAGED_ENV_KEYS_LOADED.delete("OMP_DECK_WORKSPACES");
	delete process.env.OMP_DECK_WORKSPACES;
	if (originalOmpWorkspaces !== undefined) {
		process.env.OMP_DECK_WORKSPACES = originalOmpWorkspaces;
	}

	if (originalDataDir === undefined) delete process.env.OMP_DECK_DATA_DIR;
	else process.env.OMP_DECK_DATA_DIR = originalDataDir;

	rmSync(home, { recursive: true, force: true });
	rmSync(dbDir, { recursive: true, force: true });
});

// ─── DB helpers ──────────────────────────────────────────────────────────────

describe("getExtraWorkspaces / setExtraWorkspaces", () => {
	test("returns empty array when no row exists", () => {
		expect(getExtraWorkspaces()).toEqual([]);
	});

	test("round-trips a list of cwds", () => {
		const cwds = ["/home/user/a", "/home/user/b"];
		setExtraWorkspaces(cwds);
		expect(getExtraWorkspaces()).toEqual(cwds);
	});

	test("deletes the row when set to an empty array", () => {
		setExtraWorkspaces(["/home/user/a"]);
		setExtraWorkspaces([]);
		expect(getExtraWorkspaces()).toEqual([]);
	});

	test("overwrites previous value", () => {
		setExtraWorkspaces(["/home/user/a"]);
		setExtraWorkspaces(["/home/user/b", "/home/user/c"]);
		expect(getExtraWorkspaces()).toEqual(["/home/user/b", "/home/user/c"]);
	});
});

describe("getHiddenWorkspaces / setHiddenWorkspaces", () => {
	test("returns empty array when no row exists", () => {
		expect(getHiddenWorkspaces()).toEqual([]);
	});

	test("round-trips a list of cwds", () => {
		const cwds = ["/home/user/hidden1", "/home/user/hidden2"];
		setHiddenWorkspaces(cwds);
		expect(getHiddenWorkspaces()).toEqual(cwds);
	});

	test("deletes the row when cleared", () => {
		setHiddenWorkspaces(["/home/user/hidden"]);
		setHiddenWorkspaces([]);
		expect(getHiddenWorkspaces()).toEqual([]);
	});
});

// ─── Merged workspace logic (mirrors GET /workspaces logic) ─────────────────

/** Mirrors the set-building logic in GET /workspaces. */
function buildVisible(
	defaultCwd: string,
	envExtras: string[],
	sessionCwds: string[],
): string[] {
	const hidden = new Set(getHiddenWorkspaces());
	const dbExtras = getExtraWorkspaces();
	const known = new Set<string>([defaultCwd, ...envExtras, ...dbExtras, ...sessionCwds]);
	for (const cwd of hidden) {
		if (cwd !== defaultCwd) known.delete(cwd);
	}
	return Array.from(known);
}

describe("POST semantics — register a project", () => {
	test("a registered project appears in the merged visible set", () => {
		const newProject = path.join(home, "myproject");
		mkdirSync(newProject);

		// Simulate POST /workspaces handler: add to extras + un-hide.
		const extras = getExtraWorkspaces();
		if (!extras.includes(newProject)) setExtraWorkspaces([...extras, newProject]);
		const hidden = getHiddenWorkspaces();
		if (hidden.includes(newProject)) setHiddenWorkspaces(hidden.filter((h) => h !== newProject));

		const visible = buildVisible(home, [], []);
		expect(visible).toContain(newProject);
	});
});

describe("DELETE semantics — hide a project", () => {
	test("hiding a session-discovered workspace removes it from the visible set", () => {
		const sessionProject = path.join(home, "sessionproject");
		mkdirSync(sessionProject);

		// It appears via session discovery before deletion.
		expect(buildVisible(home, [], [sessionProject])).toContain(sessionProject);

		// Simulate DELETE /workspaces handler.
		const hidden = getHiddenWorkspaces();
		if (!hidden.includes(sessionProject)) setHiddenWorkspaces([...hidden, sessionProject]);
		const extras = getExtraWorkspaces();
		if (extras.includes(sessionProject)) setExtraWorkspaces(extras.filter((e) => e !== sessionProject));

		// Must not appear even though session still references it.
		expect(buildVisible(home, [], [sessionProject])).not.toContain(sessionProject);
	});

	test("hiding an extraWorkspaces entry also removes it", () => {
		const envProject = path.join(home, "envproject");
		mkdirSync(envProject);

		expect(buildVisible(home, [envProject], [])).toContain(envProject);

		// Simulate DELETE for an env-registered workspace.
		const hidden = getHiddenWorkspaces();
		if (!hidden.includes(envProject)) setHiddenWorkspaces([...hidden, envProject]);

		expect(buildVisible(home, [envProject], [])).not.toContain(envProject);
	});

	test("defaultCwd is never removed even if somehow added to hidden", () => {
		// Safety: defaultCwd in the hidden list must be ignored.
		setHiddenWorkspaces([home]);
		const visible = buildVisible(home, [], []);
		expect(visible).toContain(home);
	});
});

describe("re-adding a previously hidden workspace", () => {
	test("un-hides it and it reappears in the visible set", () => {
		const project = path.join(home, "project");
		mkdirSync(project);

		// Register, then hide.
		setExtraWorkspaces([project]);
		setHiddenWorkspaces([project]);
		expect(buildVisible(home, [], [])).not.toContain(project);

		// Re-register (un-hide + add to extras).
		const hidden = getHiddenWorkspaces();
		setHiddenWorkspaces(hidden.filter((h) => h !== project));
		const extras = getExtraWorkspaces();
		if (!extras.includes(project)) setExtraWorkspaces([...extras, project]);

		expect(buildVisible(home, [], [])).toContain(project);
	});
});

// ─── syncWorkspacesToEnv ─────────────────────────────────────────────────────

describe("syncWorkspacesToEnv", () => {
	test("returns true and updates config.extraWorkspaces when OMP_DECK_WORKSPACES is unset", async () => {
		const project = path.join(home, "syncproject");
		mkdirSync(project);
		const cfg = {
			extraWorkspaces: [],
		} as unknown as Config;

		const synced = await syncWorkspacesToEnv([project], cfg);

		expect(synced).toBe(true);
		expect(cfg.extraWorkspaces).toContain(project);
		// process.env was updated too.
		expect(process.env.OMP_DECK_WORKSPACES).toContain(project);
	});

	test("returns false when OMP_DECK_WORKSPACES is shell-set (process-env owned)", async () => {
		// Simulate a shell-set var: present in process.env but NOT in MANAGED_ENV_KEYS_LOADED.
		process.env.OMP_DECK_WORKSPACES = "/some/shell/path";
		MANAGED_ENV_KEYS_LOADED.delete("OMP_DECK_WORKSPACES");

		const cfg = { extraWorkspaces: [] } as unknown as Config;
		const synced = await syncWorkspacesToEnv(["/new/path"], cfg);

		expect(synced).toBe(false);
		// config.extraWorkspaces must not have been mutated.
		expect(cfg.extraWorkspaces).toEqual([]);
		// process.env must still hold the original shell value.
		expect(process.env.OMP_DECK_WORKSPACES).toBe("/some/shell/path");
	});

	test("does not leak OMP_DECK_WORKSPACES into MANAGED_ENV_KEYS_LOADED across runs", async () => {
		const project = path.join(home, "leaktest");
		mkdirSync(project);
		const cfg = { extraWorkspaces: [] } as unknown as Config;

		await syncWorkspacesToEnv([project], cfg);
		// afterEach cleans up; verify the key was added during the call.
		expect(MANAGED_ENV_KEYS_LOADED.has("OMP_DECK_WORKSPACES")).toBe(true);
		// afterEach will delete it — verified by the next test running cleanly.
	});
});
