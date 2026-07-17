/**
 * Governance audit trail (T-35): every rule/extension enable-disable change
 * and every extension runtime load error lands here, so "why did this
 * change / why did loading this fail" has one queryable answer instead of
 * living only in server logs.
 */

import type { GovernanceAuditAction, GovernanceAuditEntry, GovernanceAuditKind, GovernanceAuditResult } from "@omp-deck/protocol";

import { getDb, id, nowIso } from "./index.ts";

export type { GovernanceAuditAction, GovernanceAuditKind, GovernanceAuditResult } from "@omp-deck/protocol";
export type GovernanceAuditEvent = GovernanceAuditEntry;

export interface InsertGovernanceAuditEventInput {
	kind: GovernanceAuditKind;
	targetId: string;
	action: GovernanceAuditAction;
	actor?: string;
	cwd?: string;
	sessionId?: string;
	before?: unknown;
	after?: unknown;
	result: GovernanceAuditResult;
	error?: string;
}

interface Row {
	id: string;
	occurred_at: string;
	kind: string;
	target_id: string;
	action: string;
	actor: string;
	cwd: string | null;
	session_id: string | null;
	before_json: string | null;
	after_json: string | null;
	result: string;
	error: string | null;
}

function fromRow(row: Row): GovernanceAuditEvent {
	return {
		id: row.id,
		occurredAt: row.occurred_at,
		kind: row.kind as GovernanceAuditKind,
		targetId: row.target_id,
		action: row.action as GovernanceAuditAction,
		actor: row.actor,
		cwd: row.cwd ?? undefined,
		sessionId: row.session_id ?? undefined,
		before: row.before_json ? (JSON.parse(row.before_json) as unknown) : undefined,
		after: row.after_json ? (JSON.parse(row.after_json) as unknown) : undefined,
		result: row.result as GovernanceAuditResult,
		error: row.error ?? undefined,
	};
}

/** Insert one audit row. Returns the persisted event (with generated id/timestamp). */
export function insertGovernanceAuditEvent(input: InsertGovernanceAuditEventInput): GovernanceAuditEvent {
	const event: GovernanceAuditEvent = {
		id: id(),
		occurredAt: nowIso(),
		kind: input.kind,
		targetId: input.targetId,
		action: input.action,
		actor: input.actor ?? "user",
		cwd: input.cwd,
		sessionId: input.sessionId,
		before: input.before,
		after: input.after,
		result: input.result,
		error: input.error,
	};
	getDb()
		.prepare<
			unknown,
			[string, string, string, string, string, string, string | null, string | null, string | null, string | null, string, string | null]
		>(
			`INSERT INTO governance_audit_events
				(id, occurred_at, kind, target_id, action, actor, cwd, session_id, before_json, after_json, result, error)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			event.id,
			event.occurredAt,
			event.kind,
			event.targetId,
			event.action,
			event.actor,
			event.cwd ?? null,
			event.sessionId ?? null,
			event.before !== undefined ? JSON.stringify(event.before) : null,
			event.after !== undefined ? JSON.stringify(event.after) : null,
			event.result,
			event.error ?? null,
		);
	return event;
}

export interface ListGovernanceAuditEventsFilter {
	kind?: GovernanceAuditKind;
	limit?: number;
}

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

export function listGovernanceAuditEvents(filter: ListGovernanceAuditEventsFilter = {}): GovernanceAuditEvent[] {
	const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
	// `rowid DESC` breaks ties within the same `occurred_at` millisecond by
	// insertion order — `occurred_at` alone isn't fine-grained enough when
	// several audit rows land in the same request (e.g. multiple extension
	// load errors from one session).
	const rows = filter.kind
		? (getDb()
				.prepare<Row, [string, number]>(
					"SELECT * FROM governance_audit_events WHERE kind = ? ORDER BY occurred_at DESC, rowid DESC LIMIT ?",
				)
				.all(filter.kind, limit) as Row[])
		: (getDb()
				.prepare<Row, [number]>("SELECT * FROM governance_audit_events ORDER BY occurred_at DESC, rowid DESC LIMIT ?")
				.all(limit) as Row[]);
	return rows.map(fromRow);
}
