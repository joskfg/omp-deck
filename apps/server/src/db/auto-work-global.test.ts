/**
 * Unit tests for the global Auto Work configuration DB layer. Each case boots
 * a fresh on-disk SQLite database so the single-row migration is exercised.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_AUTO_WORK_GLOBAL, getAutoWorkGlobalConfig, setAutoWorkGlobalConfig } from "./auto-work-global.ts";
import { closeDb, getDb, openDb } from "./index.ts";

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
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-global-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

describe("global auto-work config", () => {
	test("repairs a legacy database that recorded migration 017 without its global config table", () => {
		dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auto-work-global-legacy-db-"));
		const dbPath = path.join(dbDir, "deck.db");
		const legacyDb = new Database(dbPath, { create: true, strict: true });

		try {
			legacyDb.exec(`
				CREATE TABLE schema_migrations (
					name TEXT PRIMARY KEY,
					applied_at TEXT NOT NULL
				)
			`);
			const migrationsDir = path.join(import.meta.dir, "migrations");
			const recordMigration = legacyDb.prepare<unknown, [string, string]>(
				"INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
			);
			for (const migration of fs
				.readdirSync(migrationsDir)
				.filter((name) => name.endsWith(".sql") && name < "017-auto-work-schedule.sql")
				.sort()) {
				legacyDb.exec(fs.readFileSync(path.join(migrationsDir, migration), "utf8"));
				recordMigration.run(migration, "2026-01-01T00:00:00.000Z");
			}
			recordMigration.run("017-auto-work-schedule.sql", "2026-01-01T00:00:00.000Z");

			expect(
				legacyDb
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auto_work_global_config'",
					)
					.get(),
			).toBeNull();
		} finally {
			legacyDb.close();
		}

		openDb({ path: dbPath });

		expect(getAutoWorkGlobalConfig()).toMatchObject(DEFAULT_AUTO_WORK_GLOBAL);
		expect(
			getDb()
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auto_work_global_config'",
				)
				.get()?.name,
		).toBe("auto_work_global_config");
	});

	test("returns computed defaults when no config row exists", () => {
		bootDb();

		expect(getAutoWorkGlobalConfig()).toMatchObject(DEFAULT_AUTO_WORK_GLOBAL);
	});

	test("round-trips a full config and replaces every value on a subsequent save", () => {
		bootDb();

		const initial = {
			scheduleEnabled: true,
			scheduleIntervalMinutes: 15,
			taskSelectionModel: { provider: "anthropic", id: "claude-selector" },
			squeezeEnabled: true,
			modelByDifficulty: { easy: null, medium: null, hard: null },
		};
		const initialSaved = setAutoWorkGlobalConfig(initial);
		expect(initialSaved).toMatchObject(initial);
		expect(getAutoWorkGlobalConfig()).toMatchObject(initial);

		const replacement = {
			scheduleEnabled: false,
			scheduleIntervalMinutes: 60,
			taskSelectionModel: null,
			squeezeEnabled: false,
			modelByDifficulty: {
				easy: { provider: "anthropic", id: "claude-easy" },
				medium: null,
				hard: { provider: "openai", id: "gpt-hard" },
			},
		};
		const replacementSaved = setAutoWorkGlobalConfig(replacement);
		expect(replacementSaved).toMatchObject(replacement);
		expect(getAutoWorkGlobalConfig()).toMatchObject(replacement);
	});
});
