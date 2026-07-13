/**
 * Unit tests for the auto-work-config DB layer (T-60). Boots a fresh
 * on-disk SQLite database under `os.tmpdir()` per test so migrations run
 * end-to-end, same pattern as `workspace-preferences.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./index.ts";
import { DEFAULT_AUTO_WORK_VALUES, getAutoWorkConfig, setAutoWorkConfig } from "./auto-work.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
		dbDir = null;
	}
});

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

describe("auto-work config", () => {
	test("getAutoWorkConfig returns computed defaults when no row exists", () => {
		bootDb();
		const config = getAutoWorkConfig("/tmp/nowhere");
		expect(config.workspaceCwd).toBe("/tmp/nowhere");
		expect(config).toMatchObject(DEFAULT_AUTO_WORK_VALUES);
	});

	test("setAutoWorkConfig stores and round-trips a full config", () => {
		bootDb();
		const stored = setAutoWorkConfig("/tmp/project-a", {
			enabled: true,
			autoMerge: true,
			modelByPriority: {
				P0: { provider: "anthropic", id: "claude-x" },
				P1: null,
				P2: null,
				P3: null,
				P4: null,
				P5: null,
			},
			timeWindows: [{ start: 8, end: 20 }],
			sessionPctLimit: 30,
			weeklyPctLimit: 75,
			weeklyPctThreshold: 70,
			defaultEstimatePctByPriority: { P0: 25, P1: 15, P2: 10, P3: 8, P4: 5, P5: 3 },
			estimationBuffer: 1.5,
			timeoutMinutesByPriority: { P0: 100, P1: 80, P2: 50, P3: 40, P4: 40, P5: 40 },
		});
		expect(stored.enabled).toBe(true);
		expect(stored.modelByPriority.P0).toEqual({ provider: "anthropic", id: "claude-x" });
		expect(stored.modelByPriority.P1).toBeNull();
		expect(stored.timeWindows).toEqual([{ start: 8, end: 20 }]);
		expect(stored.sessionPctLimit).toBe(30);
		expect(stored.weeklyPctLimit).toBe(75);
		expect(stored.weeklyPctThreshold).toBe(70);
		expect(stored.defaultEstimatePctByPriority).toEqual({ P0: 25, P1: 15, P2: 10, P3: 8, P4: 5, P5: 3 });
		expect(stored.estimationBuffer).toBe(1.5);
		expect(stored.timeoutMinutesByPriority).toEqual({ P0: 100, P1: 80, P2: 50, P3: 40, P4: 40, P5: 40 });

		const fetched = getAutoWorkConfig("/tmp/project-a");
		expect(fetched).toEqual(stored);
	});

	test("setAutoWorkConfig upserts — a second call replaces the whole row", () => {
		bootDb();
		setAutoWorkConfig("/tmp/project-b", { ...DEFAULT_AUTO_WORK_VALUES, enabled: true, sessionPctLimit: 10 });
		setAutoWorkConfig("/tmp/project-b", { ...DEFAULT_AUTO_WORK_VALUES, enabled: false, sessionPctLimit: 90 });
		const config = getAutoWorkConfig("/tmp/project-b");
		expect(config.enabled).toBe(false);
		expect(config.sessionPctLimit).toBe(90);
	});
});
