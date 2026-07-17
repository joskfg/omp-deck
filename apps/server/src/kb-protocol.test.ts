import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { InternalUrlRouter, parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";

import { KbProtocolHandler } from "./kb-protocol.ts";

const ENV_KEYS = ["OMP_DECK_KB_ROOT"];

let saved: Record<string, string | undefined>;
let homedirSpy: ReturnType<typeof spyOn<typeof os, "homedir">>;
let kbRoot: string;
let router: InternalUrlRouter;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	kbRoot = mkdtempSync(path.join(os.tmpdir(), "omp-deck-kb-proto-"));
	process.env.OMP_DECK_KB_ROOT = kbRoot;
	// Wall off homedir as a safety net even though OMP_DECK_KB_ROOT wins.
	// Bun's os.homedir() ignores process.env.HOME/USERPROFILE reassignment at
	// runtime, so stub the function directly (see orientation-store.test.ts).
	const tmpHome = mkdtempSync(path.join(os.tmpdir(), "omp-deck-kb-home-"));
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tmpHome);

	// Seed a small wiki.
	mkdirSync(path.join(kbRoot, "system"), { recursive: true });
	mkdirSync(path.join(kbRoot, "integrations"), { recursive: true });
	mkdirSync(path.join(kbRoot, "tools"), { recursive: true });
	writeFileSync(
		path.join(kbRoot, "system", "working-voice.md"),
		"# Working voice\n\nbody\n",
		"utf8",
	);
	writeFileSync(
		path.join(kbRoot, "system", "deck-orientation.md"),
		"# Deck orientation\n\nbody — with em-dash\n",
		"utf8",
	);
	writeFileSync(path.join(kbRoot, "tools", "x.md"), "x\n", "utf8");
	writeFileSync(
		path.join(kbRoot, "integrations", "auto-work.md"),
		"## Shared Auto Work\n\nCommit before requesting review.",
		"utf8",
	);
	writeFileSync(
		path.join(kbRoot, "integrations", "auto-work.user.md"),
		"## Local Auto Work\n\nUse the staging repository.",
		"utf8",
	);

	InternalUrlRouter.resetForTests();
	router = InternalUrlRouter.instance();
	router.register(new KbProtocolHandler());
});

afterEach(() => {
	InternalUrlRouter.resetForTests();
	homedirSpy.mockRestore();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("kb:// resolution", () => {
	test("resolves an explicit `.md` path verbatim", async () => {
		const res = await router.resolve("kb://system/working-voice.md");
		expect(res.content).toContain("# Working voice");
		expect(res.contentType).toBe("text/markdown");
		expect(res.immutable).toBe(true);
		expect(res.sourcePath?.endsWith(path.join("system", "working-voice.md"))).toBe(true);
	});

	test("resolves an integration's base instructions followed by its user layer", async () => {
		const res = await router.resolve("kb://integrations/auto-work.md");
		expect(res.content).toBe(
			"## Shared Auto Work\n\nCommit before requesting review.\n\n## Local Auto Work\n\nUse the staging repository.",
		);
	});

	test("resolves an explicit integration user layer without re-including the base instructions", async () => {
		const res = await router.resolve("kb://integrations/auto-work.user.md");
		expect(res.content).toBe("## Local Auto Work\n\nUse the staging repository.");
	});

	test("UTF-8 content (em-dash etc.) round-trips byte-exact", async () => {
		const res = await router.resolve("kb://system/deck-orientation.md");
		expect(res.content).toContain("with em-dash");
		expect(res.content.includes("\u2014")).toBe(true);
	});

	test("falls back to `.md` suffix when caller omits the extension", async () => {
		const res = await router.resolve("kb://system/working-voice");
		expect(res.content).toContain("# Working voice");
	});

	test("directory path returns a markdown index of entries", async () => {
		const res = await router.resolve("kb://system/");
		expect(res.contentType).toBe("text/markdown");
		expect(res.content).toContain("# kb://system/");
		expect(res.content).toContain("[working-voice.md](kb://system/working-voice.md)");
	});

	test("bare `kb://` lists the root", async () => {
		const res = await router.resolve("kb://");
		expect(res.content).toContain("# kb://");
		expect(res.content).toContain("[system/](kb://system/)");
		expect(res.content).toContain("[tools/](kb://tools/)");
	});

	test("missing file produces an actionable error mentioning the .md fallback", async () => {
		await expect(router.resolve("kb://system/nope")).rejects.toThrow(/\.md/);
	});

	test("path traversal is rejected", async () => {
		await expect(router.resolve("kb://../etc/passwd")).rejects.toThrow(/traversal/);
	});

	test("absolute / drive-letter paths are rejected", async () => {
		await expect(router.resolve("kb:///etc/passwd")).rejects.toThrow(/must be relative/);
		await expect(router.resolve("kb://C:/Windows/System32")).rejects.toThrow();
	});

	test("OMP_DECK_KB_ROOT override is honored on every resolve", async () => {
		const altRoot = mkdtempSync(path.join(os.tmpdir(), "omp-deck-kb-alt-"));
		mkdirSync(path.join(altRoot, "system"), { recursive: true });
		writeFileSync(path.join(altRoot, "system", "x.md"), "ALT\n", "utf8");
		process.env.OMP_DECK_KB_ROOT = altRoot;
		const res = await router.resolve("kb://system/x.md");
		expect(res.content).toBe("ALT\n");
	});

	test("missing KB root yields an actionable error", async () => {
		process.env.OMP_DECK_KB_ROOT = path.join(os.tmpdir(), "does-not-exist-here", String(Math.random()));
		await expect(router.resolve("kb://anything")).rejects.toThrow(/OMP_DECK_KB_ROOT/);
	});
});

describe("kb:// write", () => {
	function kbHandler(): KbProtocolHandler {
		return router.getHandler("kb") as KbProtocolHandler;
	}

	test("creates a new file at an explicit `.md` path", async () => {
		await kbHandler().write(parseInternalUrl("kb://notes/topic.md"), "# Topic\n\nbody\n");
		expect(readFileSync(path.join(kbRoot, "notes", "topic.md"), "utf8")).toBe("# Topic\n\nbody\n");
	});

	test("creates missing parent directories recursively", async () => {
		await kbHandler().write(parseInternalUrl("kb://a/b/c/deep.md"), "deep\n");
		expect(readFileSync(path.join(kbRoot, "a", "b", "c", "deep.md"), "utf8")).toBe("deep\n");
	});

	test("overwrites an existing file", async () => {
		await kbHandler().write(parseInternalUrl("kb://system/working-voice.md"), "# Replaced\n");
		expect(readFileSync(path.join(kbRoot, "system", "working-voice.md"), "utf8")).toBe("# Replaced\n");
	});

	test("extensionless path falls back to a `.md` target when nothing exists at the exact path", async () => {
		await kbHandler().write(parseInternalUrl("kb://notes/fallback"), "content\n");
		expect(readFileSync(path.join(kbRoot, "notes", "fallback.md"), "utf8")).toBe("content\n");
	});

	test("extensionless path overwrites an exact extensionless file when one already exists", async () => {
		mkdirSync(path.join(kbRoot, "exact"), { recursive: true });
		writeFileSync(path.join(kbRoot, "exact", "noext"), "old\n", "utf8");
		await kbHandler().write(parseInternalUrl("kb://exact/noext"), "new\n");
		expect(readFileSync(path.join(kbRoot, "exact", "noext"), "utf8")).toBe("new\n");
	});

	test("extensionless path whose direct name is an existing directory still falls back to `<path>.md`", async () => {
		await kbHandler().write(parseInternalUrl("kb://system"), "index\n");
		expect(readFileSync(path.join(kbRoot, "system.md"), "utf8")).toBe("index\n");
	});

	test("path traversal is rejected", async () => {
		await expect(kbHandler().write(parseInternalUrl("kb://../etc/passwd"), "pwned\n")).rejects.toThrow(/traversal/);
	});

	test("absolute / drive-letter paths are rejected", async () => {
		await expect(kbHandler().write(parseInternalUrl("kb:///etc/passwd"), "x")).rejects.toThrow(/must be relative/);
		await expect(kbHandler().write(parseInternalUrl("kb://C:/Windows/System32/x.md"), "x")).rejects.toThrow();
	});

	test("a trailing-slash (directory) target is rejected", async () => {
		await expect(kbHandler().write(parseInternalUrl("kb://system/"), "x")).rejects.toThrow(/directory/);
	});

	test("writing over an existing directory is rejected", async () => {
		mkdirSync(path.join(kbRoot, "dirlikefile.md"));
		await expect(kbHandler().write(parseInternalUrl("kb://dirlikefile.md"), "x")).rejects.toThrow(/directory/);
	});

	test("bare `kb://` is rejected", async () => {
		await expect(kbHandler().write(parseInternalUrl("kb://"), "x")).rejects.toThrow(/file path/);
	});

	test("missing KB root yields an actionable error", async () => {
		process.env.OMP_DECK_KB_ROOT = path.join(os.tmpdir(), "does-not-exist-here", String(Math.random()));
		await expect(kbHandler().write(parseInternalUrl("kb://anything.md"), "x")).rejects.toThrow(/OMP_DECK_KB_ROOT/);
	});

	test("OMP_DECK_KB_ROOT override is honored on write", async () => {
		const altRoot = mkdtempSync(path.join(os.tmpdir(), "omp-deck-kb-write-alt-"));
		process.env.OMP_DECK_KB_ROOT = altRoot;
		await kbHandler().write(parseInternalUrl("kb://alt/x.md"), "ALT\n");
		expect(readFileSync(path.join(altRoot, "alt", "x.md"), "utf8")).toBe("ALT\n");
	});

	test("a symlinked ancestor escaping the KB root is rejected, not silently written through", async () => {
		const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "omp-deck-kb-write-outside-"));
		symlinkSync(outsideRoot, path.join(kbRoot, "escape-link"), "dir");
		await expect(kbHandler().write(parseInternalUrl("kb://escape-link/pwned.md"), "pwned\n")).rejects.toThrow(
			/escapes KB root/,
		);
	});

	test("a target that is itself a symlink escaping the KB root is rejected", async () => {
		const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "omp-deck-kb-write-outside-file-"));
		const outsideFile = path.join(outsideRoot, "secret.md");
		writeFileSync(outsideFile, "secret\n", "utf8");
		symlinkSync(outsideFile, path.join(kbRoot, "escape.md"), "file");
		await expect(kbHandler().write(parseInternalUrl("kb://escape.md"), "pwned\n")).rejects.toThrow(/escapes KB root/);
		expect(readFileSync(outsideFile, "utf8")).toBe("secret\n");
	});
});
