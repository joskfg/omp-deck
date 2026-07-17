/**
 * `kb://` URI handler for the omp SDK's InternalUrlRouter.
 *
 * Lets the `read`/`write` tools resolve `kb://<path>` against the user's
 * configured KB root (the same root `kb-service.ts` serves over REST).
 * Without this, the prelude's promise that the harness resolves `kb://`
 * URIs is a lie — the SDK only ships handlers for `agent://`, `artifact://`,
 * `memory://`, `skill://`, `rule://`, `mcp://`, `omp://`, `local://`,
 * `issue://`, `pr://`.
 *
 * Read resolution rules (intentionally narrow — the wider semantic-match
 * surface lives behind /api/kb/search, this is for the read tool only):
 *
 *   - `kb://`                  → markdown index of top-level entries
 *   - `kb://<dir>/`            → markdown index of entries under <dir>
 *   - `kb://<path>.md`         → that file verbatim
 *   - `kb://<path>` (no ext)   → tries `<path>.md` first; if that's a
 *                                 directory, falls back to listing it
 *
 * Write support (create/overwrite only — no delete/rename via `kb://`;
 * deletion continues to use `fs`/shell commands):
 *
 *   - `kb://<path>.md`         → creates or overwrites that file verbatim
 *   - `kb://<path>` (no ext)   → writes `<path>.md` unless a file already
 *                                 exists at the exact extensionless path
 *   - Missing parent directories under the KB root are created on demand.
 *
 * Path traversal is rejected the same way `local-protocol.ts` rejects it —
 * the resolved real path MUST stay under the resolved real KB root. Every
 * newly-created path segment is re-validated after `mkdir` so a symlink
 * planted mid-path can't smuggle the write outside the KB root.
 *
 * Honors `OMP_DECK_KB_ROOT` (same env var `kb-service.ts` reads), so users
 * who relocate their kb get `kb://` resolution against the new location
 * automatically.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
} from "@oh-my-pi/pi-coding-agent/internal-urls";

import { resolveKbRoot } from "./kb-service.ts";

function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md" || ext === ".markdown") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}

function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("kb:// URL escapes KB root");
	}
}

/**
 * Walk up from `targetPath` to the nearest ancestor that already exists on
 * disk, validating containment at every step. Used before `mkdir -p` so a
 * symlink planted at a not-yet-existing path segment can't redirect the
 * write outside the KB root — mirrors the SDK's `vault-protocol.ts` write path.
 * Callers MUST re-validate containment on the returned realpath: a symlinked
 * ancestor resolves outside the lexical check this loop performs up front.
 */
async function findExistingAncestor(targetPath: string, rootPath: string): Promise<string> {
	let current = targetPath;
	for (;;) {
		ensureWithinRoot(current, rootPath);
		try {
			return await fs.realpath(current);
		} catch (error) {
			if (!(typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
			const parent = path.dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

/**
 * Pull the path portion from a `kb://...` URL while preserving the original
 * separators the way `LocalProtocolHandler` does. The URL parser eats the
 * first segment into `hostname`, so we glue it back to `pathname`.
 */
function extractRelativePath(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const pathname = url.rawPathname ?? url.pathname;

	// `kb:///foo` (empty authority, explicit `/`-rooted pathname) is an
	// absolute-path spelling, not shorthand for `kb://foo` — reject it up
	// front instead of silently stripping the leading slash and treating it
	// as KB-root-relative. `kb://foo` itself never reaches this branch: the
	// URL parser always eats a non-empty first segment into `host`.
	if (!host && pathname && pathname !== "/") {
		throw new Error(`kb:// path must be relative: ${pathname}`);
	}

	const combined = host ? (pathname && pathname !== "/" ? `${host}${pathname}` : host) : "";

	if (!combined) return "";

	let decoded: string;
	try {
		decoded = decodeURIComponent(combined.replaceAll("\\", "/"));
	} catch {
		throw new Error(`Invalid URL encoding in kb:// path: ${url.href}`);
	}

	// Reject absolute paths, drive letters, and parent traversal segments.
	// Mirrors the rules the SDK's `validateRelativePath` enforces for skill:// /
	// local:// — we can't import that helper from the deck without coupling to
	// a non-stable surface, so we restate the checks inline.
	if (decoded.startsWith("/") || /^[A-Za-z]:/.test(decoded)) {
		throw new Error(`kb:// path must be relative: ${decoded}`);
	}
	const segments = decoded.split("/").filter((s) => s.length > 0);
	for (const seg of segments) {
		if (seg === "." || seg === "..") {
			throw new Error(`kb:// path contains traversal segment: ${decoded}`);
		}
	}
	return segments.join("/");
}

async function buildDirectoryListing(
	url: InternalUrl,
	resolvedDir: string,
	relativeDir: string,
	kbRoot: string,
): Promise<InternalResource> {
	const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
	const dirs: string[] = [];
	const files: string[] = [];
	for (const entry of entries) {
		const name = entry.name;
		if (name.startsWith(".")) continue; // hide dotfiles in listings
		if (entry.isDirectory()) {
			dirs.push(name);
		} else if (entry.isFile()) {
			// Surface markdown by default; skip noise like .DS_Store but keep
			// .json/.txt for completeness so the listing shows the same set the
			// /api/kb/tree view does.
			if (/\.(md|markdown|json|txt)$/i.test(name)) files.push(name);
		}
	}
	dirs.sort((a, b) => a.localeCompare(b));
	files.sort((a, b) => a.localeCompare(b));

	const prefix = relativeDir ? `${relativeDir}/` : "";
	const lines: string[] = [];
	lines.push(`# kb://${prefix}`);
	lines.push("");
	lines.push(`Root: ${kbRoot}`);
	lines.push("");
	if (dirs.length === 0 && files.length === 0) {
		lines.push("(empty)");
	} else {
		if (dirs.length > 0) {
			lines.push("## Subdirectories");
			lines.push("");
			for (const d of dirs) lines.push(`- [${d}/](kb://${prefix}${d}/)`);
			lines.push("");
		}
		if (files.length > 0) {
			lines.push("## Files");
			lines.push("");
			for (const f of files) lines.push(`- [${f}](kb://${prefix}${f})`);
			lines.push("");
		}
	}
	const content = lines.join("\n");
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: resolvedDir,
	};
}

/**
 * Resolves `kb://<path>` against the configured KB root.
 *
 * Reads stay `immutable: true` — the `read` tool suppresses hashline edit
 * affordances for `kb://` resources because there is no hashline patch path
 * wired for this scheme. Writes still work: {@link KbProtocolHandler.write}
 * lets the `write` tool create/overwrite files directly (see `write()`
 * below). `PUT /api/kb/file` remains the REST-facing edit path and also
 * triggers the `kb_changed` watcher broadcast the cockpit listens for.
 */
export class KbProtocolHandler implements ProtocolHandler {
	readonly scheme = "kb";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const kbRoot = path.resolve(resolveKbRoot());

		let resolvedRoot: string;
		try {
			resolvedRoot = await fs.realpath(kbRoot);
		} catch {
			throw new Error(
				`kb:// unavailable: KB root does not exist (${kbRoot}). Set OMP_DECK_KB_ROOT to point at your wiki.`,
			);
		}

		const relativePath = extractRelativePath(url);

		// Bare `kb://` (or `kb:///`) — list the root.
		if (!relativePath) {
			return buildDirectoryListing(url, resolvedRoot, "", resolvedRoot);
		}

		// Trailing slash → explicit directory listing.
		const trailingSlash = (url.rawPathname ?? url.pathname).endsWith("/");

		const candidates: string[] = [];
		const direct = path.resolve(resolvedRoot, relativePath);
		candidates.push(direct);
		// `.md` ergonomics: when the caller wrote `kb://system/working-voice`,
		// also try `system/working-voice.md`. Only when no extension is present.
		if (!path.extname(relativePath)) candidates.push(`${direct}.md`);

		for (const candidate of candidates) {
			let realCandidate: string;
			try {
				realCandidate = await fs.realpath(candidate);
			} catch {
				continue;
			}
			ensureWithinRoot(realCandidate, resolvedRoot);

			const stat = await fs.stat(realCandidate);
			if (stat.isDirectory()) {
				if (candidate !== direct) continue; // never list a `.md`-suffix dir
				return buildDirectoryListing(url, realCandidate, relativePath, resolvedRoot);
			}
			if (stat.isFile()) {
				let content = await fs.readFile(realCandidate, "utf8");
				const relativeCandidate = path.relative(resolvedRoot, realCandidate).split(path.sep).join("/");
				if (relativeCandidate.startsWith("integrations/") && relativeCandidate.endsWith(".md") && !relativeCandidate.endsWith(".user.md")) {
					const userPath = realCandidate.slice(0, -3) + ".user.md";
					try {
						const userRealPath = await fs.realpath(userPath);
						ensureWithinRoot(userRealPath, resolvedRoot);
						const userStat = await fs.stat(userRealPath);
						if (userStat.isFile()) content += `\n\n${await fs.readFile(userRealPath, "utf8")}`;
					} catch {
						// An absent customization is the normal case.
					}
				}
				return {
					url: url.href,
					content,
					contentType: getContentType(realCandidate),
					size: Buffer.byteLength(content, "utf-8"),
					sourcePath: realCandidate,
					notes: [
						"Editable via the `write` tool (kb://<path>) or PUT /api/kb/file?path=<relative>.",
					],
				};
			}
		}

		const hint = trailingSlash
			? ""
			: !path.extname(relativePath)
				? " (also tried .md suffix)"
				: "";
		throw new Error(`kb resource not found: ${relativePath}${hint}`);
	}

	/**
	 * Creates or overwrites `kb://<path>` against the configured KB root,
	 * creating any missing parent directories on demand. There is no
	 * `kb://` delete/rename — use `fs`/shell commands (e.g. `rm`, `git rm`)
	 * for that, per T-130's scope.
	 */
	async write(url: InternalUrl, content: string): Promise<void> {
		const kbRoot = path.resolve(resolveKbRoot());

		let resolvedRoot: string;
		try {
			resolvedRoot = await fs.realpath(kbRoot);
		} catch {
			throw new Error(
				`kb:// unavailable: KB root does not exist (${kbRoot}). Set OMP_DECK_KB_ROOT to point at your wiki.`,
			);
		}

		const relativePath = extractRelativePath(url);
		if (!relativePath) {
			throw new Error("kb:// write requires a file path, e.g. kb://notes/topic.md");
		}
		if ((url.rawPathname ?? url.pathname).endsWith("/")) {
			throw new Error(`kb:// write target must be a file, not a directory: ${relativePath}`);
		}

		const direct = path.resolve(resolvedRoot, relativePath);
		ensureWithinRoot(direct, resolvedRoot);

		// `.md` ergonomics mirror the read path: an extensionless target writes
		// `<path>.md` unless a file already exists at the exact extensionless path.
		let target = direct;
		if (!path.extname(relativePath)) {
			let directExistsAsFile = false;
			try {
				const realDirect = await fs.realpath(direct);
				ensureWithinRoot(realDirect, resolvedRoot);
				directExistsAsFile = (await fs.stat(realDirect)).isFile();
			} catch (error) {
				// A missing extensionless path is the normal case (fall through to
				// the `.md` target below). Anything else — most importantly a
				// symlink escaping the KB root — MUST hard-error like the read
				// path does, not be silently treated as "absent".
				if (!(typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT")) {
					throw error;
				}
			}
			if (!directExistsAsFile) target = `${direct}.md`;
		}

		// Symlink-safety: if the target already exists, its realpath must stay
		// under the KB root and must not be a directory. If it doesn't exist
		// yet, walk up to the nearest existing ancestor, confirm ITS realpath
		// also stays under the root, then create the missing parents before
		// writing — mirrors the SDK's `vault-protocol.ts` write path.
		try {
			const realTarget = await fs.realpath(target);
			ensureWithinRoot(realTarget, resolvedRoot);
			if ((await fs.stat(realTarget)).isDirectory()) {
				throw new Error(`kb:// write target is a directory: ${relativePath}`);
			}
		} catch (error) {
			if (!(typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT")) {
				throw error;
			}
			const parentDir = path.dirname(target);
			const existingAncestor = await findExistingAncestor(parentDir, resolvedRoot);
			ensureWithinRoot(existingAncestor, resolvedRoot);
			await fs.mkdir(parentDir, { recursive: true });
			ensureWithinRoot(await fs.realpath(parentDir), resolvedRoot);
		}

		await fs.writeFile(target, content, "utf8");
	}
}
