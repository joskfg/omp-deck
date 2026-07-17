import { Hono } from "hono";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { FilePathMatch, ListDirResponse, ListFilePathsResponse } from "@omp-deck/protocol";

import { logger } from "./log.ts";

const log = logger("fs-complete");

/**
 * `GET /api/fs/complete?cwd=<absolute>&q=<>&limit=<>` enumerates file paths
 * under `cwd`, fuzzy-scored against `q`, capped at `limit` (default 20).
 *
 * Used by the composer's `@filepath` autocomplete dropdown. The picker calls
 * this on every keystroke after the `@` token, so the underlying file
 * inventory is cached per-cwd for 30 s; only the scoring runs per request.
 *
 * Honors `.gitignore` when `cwd` is a git work tree by shelling out to
 * `git ls-files --cached --others --exclude-standard`. Falls back to a manual
 * walk that skips well-known build/dependency directories otherwise.
 */
export function buildFsRouter(): Hono {
	const app = new Hono();

	app.get("/fs/complete", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		const q = c.req.query("q") ?? "";
		const limit = clampInt(c.req.query("limit"), 20, 1, 100);

		if (!cwd || !path.isAbsolute(cwd)) {
			return c.json({ error: "cwd query param must be an absolute path" }, 400);
		}
		// Refuse cwds that resolve outside the user's home or a configured
		// workspace root — loopback-only is the *transport*, not the
		// authorization. A bug in another route shouldn't let the picker walk
		// `C:\Windows`.
		if (!isCwdAllowed(cwd)) {
			return c.json({ error: cwdNotAllowedMessage() }, 403);
		}

		const cached = inventoryCache.get(cwd);
		const fromCache = cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS;
		const entries = fromCache
			? cached!.entries
			: await loadInventory(cwd).catch((err) => {
					log.warn(`inventory failed for ${cwd}: ${String(err)}`);
					return [] as InventoryEntry[];
				});
		if (!fromCache) inventoryCache.set(cwd, { at: Date.now(), entries });

		const matches = score(entries, q, limit);
		const body: ListFilePathsResponse = {
			matches: matches.map((e) => ({ path: e.path, name: e.name, isDir: e.isDir })),
			cached: fromCache,
		};
		return c.json(body);
	});

	// `GET /fs/browse?path=<absolute>` lists the immediate subdirectories of
	// `path` (default: $HOME) for the workspace-picker's "Browse…" folder
	// dialog. Sandboxed by the same `isCwdAllowed` home-boundary check as
	// `/fs/complete` — this walks raw directories, not a git-aware inventory,
	// so it must never be pointed outside $HOME. Hidden directories (leading
	// `.`) are omitted; they're noise for picking a project root.
	app.get("/fs/browse", (c) => {
		const raw = c.req.query("path")?.trim();
		const requested = raw ? path.resolve(raw) : path.resolve(resolveHome());

		if (!isCwdAllowed(requested)) {
			return c.json({ error: pathNotAllowedMessage() }, 403);
		}

		let dirs: string[];
		try {
			dirs = readdirSync(requested, { withFileTypes: true })
				.filter((d) => d.isDirectory() && !d.name.startsWith("."))
				.map((d) => d.name)
				.sort((a, b) => a.localeCompare(b));
		} catch (err) {
			log.warn(`browse: readdir failed at ${requested}: ${String(err)}`);
			return c.json({ error: "failed to read directory" }, 500);
		}

		const homeResolved = path.resolve(resolveHome());
		const parent = requested === homeResolved ? null : path.dirname(requested);

		const body: ListDirResponse = { path: requested, parent, dirs };
		return c.json(body);
	});

	return app;
}

// ─── Inventory ─────────────────────────────────────────────────────────────

interface InventoryEntry {
	/** Forward-slash path relative to cwd. */
	path: string;
	/** Lowercased forward-slash path for case-insensitive matching. */
	pathLower: string;
	/** Basename ("Composer.tsx"). */
	name: string;
	/** Lowercased basename for matching. */
	nameLower: string;
	isDir: boolean;
}

interface CacheEntry {
	at: number;
	entries: InventoryEntry[];
}

const CACHE_TTL_MS = 30_000;
const inventoryCache = new Map<string, CacheEntry>();

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"target",
	"dist",
	"build",
	".next",
	".turbo",
	".cache",
	".bun",
	"__pycache__",
	"venv",
	".venv",
	".pytest_cache",
]);
const MAX_ENTRIES = 50_000;

async function loadInventory(cwd: string): Promise<InventoryEntry[]> {
	const gitDir = path.join(cwd, ".git");
	if (existsSync(gitDir)) {
		const out = await runGitLsFiles(cwd).catch(() => null);
		if (out) return out;
	}
	return walkManual(cwd);
}

/**
 * Use Bun's spawn to call `git ls-files --cached --others --exclude-standard`.
 * Output is one relative path per line. We probe `stat()` to mark directories
 * — `git ls-files` only emits files, but `@filepath` autocomplete should let
 * users insert directories too (the SDK's auto-reader handles directory
 * targets by listing contents).
 */
async function runGitLsFiles(cwd: string): Promise<InventoryEntry[] | null> {
	const proc = Bun.spawn(
		["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd, stdout: "pipe", stderr: "pipe" },
	);
	const exitCode = await proc.exited;
	if (exitCode !== 0) return null;
	const stdout = await new Response(proc.stdout).text();
	const rels = stdout.split("\0").filter(Boolean);
	const out: InventoryEntry[] = [];
	const seenDirs = new Set<string>();
	for (const rel of rels) {
		out.push(toEntry(rel, false));
		// Synthesize directory entries from path segments so `@apps/web/sr` can
		// match the `apps/web/src` dir before any file inside it.
		let dir = path.posix.dirname(rel.replace(/\\/g, "/"));
		while (dir && dir !== "." && dir !== "/") {
			if (seenDirs.has(dir)) break;
			seenDirs.add(dir);
			out.push(toEntry(dir, true));
			dir = path.posix.dirname(dir);
		}
		if (out.length > MAX_ENTRIES) break;
	}
	return out;
}

function walkManual(cwd: string): InventoryEntry[] {
	const out: InventoryEntry[] = [];
	const queue: string[] = [""];
	while (queue.length > 0 && out.length < MAX_ENTRIES) {
		const rel = queue.shift()!;
		const abs = rel ? path.join(cwd, rel) : cwd;
		let dirents;
		try {
			dirents = readdirSync(abs, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const d of dirents) {
			if (d.name.startsWith(".") && d.name !== "." && d.name !== "..") {
				// Skip hidden files/dirs aggressively — composer mentions
				// almost never target dotfiles. Users can drag-and-drop those
				// or explicitly read them via the agent.
				if (SKIP_DIRS.has(d.name) || d.name === ".git") continue;
				if (d.isDirectory()) continue;
			}
			if (d.isDirectory() && SKIP_DIRS.has(d.name)) continue;
			const sub = rel ? `${rel}/${d.name}` : d.name;
			out.push(toEntry(sub, d.isDirectory()));
			if (d.isDirectory()) queue.push(sub);
			if (out.length >= MAX_ENTRIES) break;
		}
	}
	return out;
}

function toEntry(rel: string, isDir: boolean): InventoryEntry {
	const fwd = rel.replace(/\\/g, "/");
	const name = path.posix.basename(fwd);
	return {
		path: fwd,
		pathLower: fwd.toLowerCase(),
		name,
		nameLower: name.toLowerCase(),
		isDir,
	};
}

// ─── Scoring ───────────────────────────────────────────────────────────────

/**
 * Rank inventory against `q`:
 *
 * 1. Exact basename match (`q` === basename)
 * 2. Basename prefix match
 * 3. Basename substring match
 * 4. Path prefix match
 * 5. Path substring match
 *
 * Within a tier, shorter paths win (closer to root → usually more relevant).
 * When `q` is empty the picker shows the first `limit` entries with directories
 * before files, then alphabetical — gives a useful "browse" mode.
 */
function score(entries: InventoryEntry[], rawQ: string, limit: number): InventoryEntry[] {
	const q = rawQ.toLowerCase().replace(/\\/g, "/");
	if (q === "") {
		return [...entries]
			.sort((a, b) => {
				if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
				return a.path.localeCompare(b.path);
			})
			.slice(0, limit);
	}

	type Scored = { e: InventoryEntry; tier: number };
	const scored: Scored[] = [];
	for (const e of entries) {
		let tier: number;
		if (e.nameLower === q) tier = 0;
		else if (e.nameLower.startsWith(q)) tier = 1;
		else if (e.nameLower.includes(q)) tier = 2;
		else if (e.pathLower.startsWith(q)) tier = 3;
		else if (e.pathLower.includes(q)) tier = 4;
		else continue;
		scored.push({ e, tier });
	}
	scored.sort((a, b) => {
		if (a.tier !== b.tier) return a.tier - b.tier;
		// Shallower paths first within a tier.
		const da = a.e.path.split("/").length;
		const db = b.e.path.split("/").length;
		if (da !== db) return da - db;
		return a.e.path.localeCompare(b.e.path);
	});
	return scored.slice(0, limit).map((s) => s.e);
}

// ─── Sandboxing ────────────────────────────────────────────────────────────

/** `$HOME`/`%USERPROFILE%`, resolved once so `isCwdAllowed` and the default
 * `/fs/browse` root always agree — `os.homedir()` falls back to the passwd
 * database and can silently diverge from `$HOME` (notably: it ignores
 * runtime env overrides, which trips up tests that stub `$HOME`). */
function resolveHome(): string {
	return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

export const ALLOWED_WORKSPACE_ROOTS_GUIDANCE =
	"Configure additional workspace roots in Settings → Env → OMP_DECK_WORKSPACES.";

export function cwdNotAllowedMessage(): string {
	return `cwd is not an allowed workspace. It must be an existing directory under $HOME or a root in OMP_DECK_WORKSPACES. ${ALLOWED_WORKSPACE_ROOTS_GUIDANCE}`;
}

export function pathNotAllowedMessage(label = "path"): string {
	return `${label} is not under an allowed workspace root. ${ALLOWED_WORKSPACE_ROOTS_GUIDANCE}`;
}

export function isCwdAllowed(cwd: string): boolean {
	// Allow cwds under $HOME or under any root listed in OMP_DECK_WORKSPACES.
	// The deck is loopback-only, but a buggy client shouldn't be able to probe
	// arbitrary filesystem paths — only paths the user has explicitly configured
	// as workspaces are permitted.
	try {
		const resolved = path.resolve(cwd);
		if (!(existsSync(resolved) && statSync(resolved).isDirectory())) return false;
		// Compare canonical paths rather than lexical paths. A directory symlink
		// below an allowed root can otherwise escape it after path.resolve().
		const canonicalCwd = realpathSync(resolved);

		// Build the list of allowed roots: $HOME + each OMP_DECK_WORKSPACES entry.
		const rawRoots: string[] = [];
		const home = resolveHome();
		if (home) rawRoots.push(path.resolve(home));
		const extra = (process.env.OMP_DECK_WORKSPACES ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.map((p) => path.resolve(p));
		rawRoots.push(...extra);

		const roots = rawRoots.flatMap((root) => {
			try {
				return [realpathSync(root)];
			} catch {
				return [];
			}
		});
		if (roots.length === 0) return false;

		return roots.some((root) => {
			const rel = path.relative(root, canonicalCwd);
			// Empty rel = cwd IS the root (exact match). Both are allowed.
			return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
		});
	} catch {
		return false;
	}
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (!raw) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(n)));
}
