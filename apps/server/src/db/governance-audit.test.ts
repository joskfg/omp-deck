/**
 * Unit tests for the governance audit trail (T-35). Boots a fresh on-disk
 * SQLite database per test, same pattern as `server-settings.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./index.ts";
import { insertGovernanceAuditEvent, listGovernanceAuditEvents } from "./governance-audit.ts";

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
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-governance-audit-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

describe("insertGovernanceAuditEvent", () => {
	test("persists a rule enable/disable row with generated id and timestamp", () => {
		bootDb();
		const event = insertGovernanceAuditEvent({
			kind: "rule",
			targetId: "rule:my-rule",
			action: "disable",
			cwd: "/tmp/proj",
			before: ["a"],
			after: ["a", "rule:my-rule"],
			result: "ok",
		});
		expect(event.id).toBeTruthy();
		expect(event.occurredAt).toBeTruthy();
		expect(event.actor).toBe("user");

		const [stored] = listGovernanceAuditEvents();
		expect(stored).toEqual(event);
	});

	test("round-trips before/after JSON and a non-default actor", () => {
		bootDb();
		insertGovernanceAuditEvent({
			kind: "extension_load_error",
			targetId: "/ext/broken.ts",
			action: "load_error",
			actor: "system",
			sessionId: "s-1",
			result: "error",
			error: "boom",
		});
		const [stored] = listGovernanceAuditEvents();
		expect(stored?.actor).toBe("system");
		expect(stored?.sessionId).toBe("s-1");
		expect(stored?.error).toBe("boom");
		expect(stored?.before).toBeUndefined();
		expect(stored?.after).toBeUndefined();
	});
});

describe("listGovernanceAuditEvents", () => {
	test("orders newest first and filters by kind", () => {
		bootDb();
		insertGovernanceAuditEvent({ kind: "rule", targetId: "rule:a", action: "disable", result: "ok" });
		insertGovernanceAuditEvent({ kind: "extension", targetId: "hook:pre:edit:x", action: "enable", result: "ok" });
		insertGovernanceAuditEvent({ kind: "rule", targetId: "rule:b", action: "enable", result: "ok" });

		const all = listGovernanceAuditEvents();
		expect(all.map((e) => e.targetId)).toEqual(["rule:b", "hook:pre:edit:x", "rule:a"]);

		const onlyRules = listGovernanceAuditEvents({ kind: "rule" });
		expect(onlyRules.map((e) => e.targetId)).toEqual(["rule:b", "rule:a"]);
	});

	test("respects limit", () => {
		bootDb();
		for (let i = 0; i < 5; i++) {
			insertGovernanceAuditEvent({ kind: "rule", targetId: `rule:${i}`, action: "disable", result: "ok" });
		}
		expect(listGovernanceAuditEvents({ limit: 2 })).toHaveLength(2);
	});
});
