/**
 * `isCwdAllowed` gates both `/fs/complete` and the cwd a caller supplies to
 * `POST /sessions`. It must fail closed: only existing directories that
 * resolve under $HOME or a configured OMP_DECK_WORKSPACES root are acceptable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildFsRouter, isCwdAllowed } from "./routes-fs.ts";

describe("isCwdAllowed", () => {
	let originalHome: string | undefined;
	let fakeHome: string;
	let dirUnderHome: string;
	let fileUnderHome: string;

	beforeEach(() => {
		fakeHome = mkdtempSync(path.join(os.tmpdir(), "omp-deck-home-"));
		dirUnderHome = path.join(fakeHome, "projects", "app");
		mkdirSync(dirUnderHome, { recursive: true });
		fileUnderHome = path.join(fakeHome, "notes.txt");
		writeFileSync(fileUnderHome, "not a directory");

		originalHome = process.env.HOME;
		process.env.HOME = fakeHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	test("accepts an existing directory under $HOME", () => {
		expect(isCwdAllowed(dirUnderHome)).toBe(true);
	});

	test("rejects a path that escapes $HOME via ..", () => {
		expect(isCwdAllowed(path.join(fakeHome, "..", "outside"))).toBe(false);
	});

	test("rejects an absolute path outside $HOME entirely", () => {
		const outside = mkdtempSync(path.join(os.tmpdir(), "omp-deck-outside-"));
		try {
			expect(isCwdAllowed(outside)).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("rejects a path that doesn't exist on disk", () => {
		expect(isCwdAllowed(path.join(fakeHome, "does-not-exist"))).toBe(false);
	});

	test("rejects a path that exists but is a file, not a directory", () => {
		expect(isCwdAllowed(fileUnderHome)).toBe(false);
	});

	test("rejects a symlink under $HOME that resolves outside the allowed root", () => {
		const outside = mkdtempSync(path.join(os.tmpdir(), "omp-deck-outside-"));
		const link = path.join(fakeHome, "escaped-project");
		try {
			symlinkSync(outside, link, "dir");
			expect(isCwdAllowed(link)).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("accepts a symlink under $HOME that resolves within the allowed root", () => {
		const target = path.join(fakeHome, "projects", "target");
		const link = path.join(fakeHome, "linked-project");
		mkdirSync(target, { recursive: true });
		symlinkSync(target, link, "dir");
		expect(isCwdAllowed(link)).toBe(true);
	});

	test("fails closed when $HOME/$USERPROFILE is unset", () => {
		delete process.env.HOME;
		delete process.env.USERPROFILE;
		expect(isCwdAllowed(dirUnderHome)).toBe(false);
	});

	test("accepts an existing directory under an OMP_DECK_WORKSPACES root", () => {
		const nfsRoot = mkdtempSync(path.join(os.tmpdir(), "omp-deck-nfs-"));
		const dir = path.join(nfsRoot, "project", "src");
		mkdirSync(dir, { recursive: true });
		const original = process.env.OMP_DECK_WORKSPACES;
		try {
			process.env.OMP_DECK_WORKSPACES = nfsRoot;
			expect(isCwdAllowed(dir)).toBe(true);
		} finally {
			if (original === undefined) delete process.env.OMP_DECK_WORKSPACES;
			else process.env.OMP_DECK_WORKSPACES = original;
			rmSync(nfsRoot, { recursive: true, force: true });
		}
	});

	test("accepts the OMP_DECK_WORKSPACES root itself as a cwd", () => {
		const nfsRoot = mkdtempSync(path.join(os.tmpdir(), "omp-deck-nfs-"));
		const original = process.env.OMP_DECK_WORKSPACES;
		try {
			process.env.OMP_DECK_WORKSPACES = nfsRoot;
			expect(isCwdAllowed(nfsRoot)).toBe(true);
		} finally {
			if (original === undefined) delete process.env.OMP_DECK_WORKSPACES;
			else process.env.OMP_DECK_WORKSPACES = original;
			rmSync(nfsRoot, { recursive: true, force: true });
		}
	});

	test("rejects a path outside $HOME when OMP_DECK_WORKSPACES is unset", () => {
		const outside = mkdtempSync(path.join(os.tmpdir(), "omp-deck-outside-"));
		const original = process.env.OMP_DECK_WORKSPACES;
		try {
			delete process.env.OMP_DECK_WORKSPACES;
			expect(isCwdAllowed(outside)).toBe(false);
		} finally {
			if (original !== undefined) process.env.OMP_DECK_WORKSPACES = original;
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("fails closed when both $HOME and OMP_DECK_WORKSPACES are unset", () => {
		const originalWorkspaces = process.env.OMP_DECK_WORKSPACES;
		delete process.env.HOME;
		delete process.env.USERPROFILE;
		delete process.env.OMP_DECK_WORKSPACES;
		try {
			expect(isCwdAllowed(dirUnderHome)).toBe(false);
		} finally {
			if (originalWorkspaces !== undefined) process.env.OMP_DECK_WORKSPACES = originalWorkspaces;
		}
	});
});

describe("GET /fs/browse", () => {
	let originalHome: string | undefined;
	let fakeHome: string;

	beforeEach(() => {
		fakeHome = mkdtempSync(path.join(os.tmpdir(), "omp-deck-browse-home-"));
		mkdirSync(path.join(fakeHome, "projects", "app"), { recursive: true });
		mkdirSync(path.join(fakeHome, "projects", "other"), { recursive: true });
		mkdirSync(path.join(fakeHome, ".hidden"), { recursive: true });
		writeFileSync(path.join(fakeHome, "projects", "readme.txt"), "not a dir");

		originalHome = process.env.HOME;
		process.env.HOME = fakeHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	test("defaults to $HOME and lists its subdirectories, hiding dotdirs and files", async () => {
		const app = buildFsRouter();
		const res = await app.request("/fs/browse");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { path: string; parent: string | null; dirs: string[] };
		expect(body.path).toBe(path.resolve(fakeHome));
		expect(body.parent).toBeNull();
		expect(body.dirs).toEqual(["projects"]);
	});

	test("navigates into a subdirectory and reports its parent", async () => {
		const app = buildFsRouter();
		const target = path.join(fakeHome, "projects");
		const res = await app.request(`/fs/browse?path=${encodeURIComponent(target)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { path: string; parent: string | null; dirs: string[] };
		expect(body.path).toBe(path.resolve(target));
		expect(body.parent).toBe(path.resolve(fakeHome));
		expect(body.dirs).toEqual(["app", "other"]);
	});

	test("rejects a path outside $HOME with 403", async () => {
		const app = buildFsRouter();
		const outside = mkdtempSync(path.join(os.tmpdir(), "omp-deck-browse-outside-"));
		try {
			const res = await app.request(`/fs/browse?path=${encodeURIComponent(outside)}`);
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({
				error:
					"path is not under an allowed workspace root. Configure additional workspace roots in Settings → Env → OMP_DECK_WORKSPACES.",
			});
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("rejects a nonexistent path with 403 (fails closed, not 500)", async () => {
		const app = buildFsRouter();
		const missing = path.join(fakeHome, "does-not-exist");
		const res = await app.request(`/fs/browse?path=${encodeURIComponent(missing)}`);
		expect(res.status).toBe(403);
	});
});
