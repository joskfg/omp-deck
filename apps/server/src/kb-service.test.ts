import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { KbService, resolveProjectBranchPolicy } from "./kb-service.ts";

let fixtureRoot: string;
let kbRoot: string;
let workspaceRoot: string;

function writeProjectPolicy(relativePath: string, projectRoot: string, baseBranch: string): string {
	const sourcePath = path.join(kbRoot, "projects", relativePath);
	mkdirSync(path.dirname(sourcePath), { recursive: true });
	writeFileSync(sourcePath, `---\nprojectRoot: ${projectRoot}\nbaseBranch: ${baseBranch}\n---\n# Project policy\n`, "utf8");
	return sourcePath;
}

beforeEach(() => {
	fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "omp-deck-project-policy-"));
	kbRoot = path.join(fixtureRoot, "kb");
	workspaceRoot = path.join(fixtureRoot, "repo");
});

afterEach(() => {
	rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("resolveProjectBranchPolicy", () => {
	test("ignores a malformed deepest policy and selects the valid enclosing policy", async () => {
		writeProjectPolicy("parent.md", workspaceRoot, "main");
		const nestedPolicyPath = writeProjectPolicy("nested/project.md", path.join(workspaceRoot, "apps"), "devel");
		writeProjectPolicy("nested/invalid.md", path.join(workspaceRoot, "apps", "server"), "release./hotfix");

		const policy = await resolveProjectBranchPolicy(
			path.join(workspaceRoot, "apps", "server", ".worktrees", "aw-T1-policy-test"),
			kbRoot,
		);

		expect(policy).toEqual({
			projectRoot: path.join(workspaceRoot, "apps"),
			baseBranch: "devel",
			sourcePath: nestedPolicyPath,
		});
	});
});

describe("KbService root containment", () => {
	test("supports a KB root that is itself a symlink", async () => {
		const actualKbRoot = path.join(fixtureRoot, "actual-kb");
		const linkedKbRoot = path.join(fixtureRoot, "linked-kb");
		mkdirSync(actualKbRoot);
		writeFileSync(path.join(actualKbRoot, "inside.md"), "# Inside\n", "utf8");
		symlinkSync(actualKbRoot, linkedKbRoot, "dir");

		const service = new KbService({ root: linkedKbRoot });

		expect((await service.getTree())?.files.map((entry) => entry.path)).toEqual(["inside.md"]);
		expect((await service.getFile("inside.md"))?.body).toBe("# Inside\n");
	});

	test("never indexes or reads a symlinked directory outside the resolved root", async () => {
		mkdirSync(kbRoot);
		const outsideRoot = path.join(fixtureRoot, "outside");
		mkdirSync(outsideRoot);
		writeFileSync(path.join(kbRoot, "inside.md"), "# Inside\n", "utf8");
		writeFileSync(path.join(outsideRoot, "secret.md"), "# Secret\n", "utf8");
		symlinkSync(outsideRoot, path.join(kbRoot, "outside-link"), "dir");

		const service = new KbService({ root: kbRoot });

		expect((await service.getTree())?.dirs.map((entry) => entry.path)).not.toContain("outside-link");
		expect(await service.getFile("outside-link/secret.md")).toBeUndefined();
		expect((await service.getGraph()).nodes.map((node) => node.path)).toEqual(["inside.md"]);
	});

	test("does not read an indexed symlink after its target escapes the resolved root", async () => {
		mkdirSync(kbRoot);
		const internalRoot = path.join(kbRoot, "internal");
		const outsideRoot = path.join(fixtureRoot, "outside");
		mkdirSync(internalRoot);
		mkdirSync(outsideRoot);
		writeFileSync(path.join(internalRoot, "note.md"), "# Safe\n", "utf8");
		writeFileSync(path.join(outsideRoot, "note.md"), "# Outside secret\n", "utf8");
		const linkedDir = path.join(kbRoot, "linked");
		symlinkSync(internalRoot, linkedDir, "dir");

		const service = new KbService({ root: kbRoot });
		await service.ensureIndex();
		rmSync(linkedDir);
		symlinkSync(outsideRoot, linkedDir, "dir");

		expect((await service.search("outside secret", 20)).totalMatches).toBe(0);
	});

	test("rebuilds when invalidated while an index build is in flight", async () => {
		mkdirSync(kbRoot);
		writeFileSync(path.join(kbRoot, "before.md"), "# Before\n", "utf8");
		const service = new KbService({ root: kbRoot });
		const walkSeam = service as unknown as {
			walk: (...args: unknown[]) => Promise<void>;
		};
		const originalWalk = walkSeam.walk.bind(service);
		const firstWalkFinished = Promise.withResolvers<void>();
		const continueFirstBuild = Promise.withResolvers<void>();
		let blockFirstBuild = true;
		walkSeam.walk = async (...args) => {
			await originalWalk(...args);
			if (!blockFirstBuild) return;
			blockFirstBuild = false;
			firstWalkFinished.resolve();
			await continueFirstBuild.promise;
		};

		const indexing = service.ensureIndex();
		await firstWalkFinished.promise;
		writeFileSync(path.join(kbRoot, "after.md"), "# After\n", "utf8");
		service.invalidate();
		continueFirstBuild.resolve();
		await indexing;

		const paths = (await service.getGraph()).nodes.map((node) => node.path);
		expect(paths).toHaveLength(2);
		expect(paths).toEqual(expect.arrayContaining(["after.md", "before.md"]));
	});
});

describe("KbService.createFolder", () => {
	test("creates an empty directory that shows up in getTree, including missing parents", async () => {
		mkdirSync(kbRoot);
		const service = new KbService({ root: kbRoot });

		const result = await service.createFolder("projects/new-app");
		expect(result).toEqual({
			kind: "ok",
			entry: { name: "new-app", path: "projects/new-app", kind: "dir", mdCount: 0 },
		});

		const rootTree = await service.getTree();
		expect(rootTree?.dirs.map((d) => d.path)).toEqual(["projects"]);
		const nestedTree = await service.getTree("projects");
		expect(nestedTree?.dirs.map((d) => d.path)).toEqual(["projects/new-app"]);
	});

	test("rejects when a file or directory already exists at the target path", async () => {
		mkdirSync(kbRoot);
		writeFileSync(path.join(kbRoot, "taken.md"), "# Taken\n", "utf8");
		mkdirSync(path.join(kbRoot, "taken-dir"));
		const service = new KbService({ root: kbRoot });

		expect(await service.createFolder("taken.md")).toEqual({ kind: "conflict" });
		expect(await service.createFolder("taken-dir")).toEqual({ kind: "conflict" });
	});

	test("rejects an empty name and a path that escapes the kb root", async () => {
		mkdirSync(kbRoot);
		const service = new KbService({ root: kbRoot });

		expect(await service.createFolder("")).toEqual({ kind: "invalid-path" });
		expect(await service.createFolder("../outside")).toEqual({ kind: "invalid-path" });
	});
});
