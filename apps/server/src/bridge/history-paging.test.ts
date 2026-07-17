/**
 * Tests for the pure history-paging arithmetic behind the tail-sliced
 * subscribe snapshot: `sliceHistoryPage` (the `GET /sessions/:id/history` /
 * `SessionHandle.getHistory` page math) and `computeUsageRollup` (full-history
 * token/cost totals shipped alongside a tail snapshot).
 *
 * Importing `./in-process.ts` pulls the `@oh-my-pi/pi-coding-agent` SDK
 * modules in at load time but triggers no side effects — the established
 * pattern in `in-process-queue.test.ts`, which imports the same module.
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessageJson } from "@omp-deck/protocol";

import { computeUsageRollup, sliceHistoryPage } from "./in-process.ts";

/** `n` user messages whose content is their own history index: "m0".."m{n-1}". */
function history(n: number): AgentMessageJson[] {
	return Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` }));
}

describe("sliceHistoryPage", () => {
	const cases: Array<{
		name: string;
		total: number;
		before: number;
		limit: number;
		contents: string[];
		startIndex: number;
	}> = [
		{ name: "middle page ends just before `before`", total: 10, before: 6, limit: 3, contents: ["m3", "m4", "m5"], startIndex: 3 },
		{ name: "page shorter than limit at the history start", total: 10, before: 2, limit: 5, contents: ["m0", "m1"], startIndex: 0 },
		{ name: "before=0 yields an empty page at index 0", total: 10, before: 0, limit: 5, contents: [], startIndex: 0 },
		{ name: "before past the end clamps to the history length", total: 5, before: 99, limit: 2, contents: ["m3", "m4"], startIndex: 3 },
		{ name: "negative before clamps to 0 instead of throwing", total: 5, before: -3, limit: 2, contents: [], startIndex: 0 },
		{ name: "limit below 1 clamps up to a single message", total: 5, before: 3, limit: 0, contents: ["m2"], startIndex: 2 },
		{ name: "negative limit clamps up to a single message", total: 5, before: 3, limit: -7, contents: ["m2"], startIndex: 2 },
		{ name: "fractional before/limit are floored", total: 10, before: 6.9, limit: 2.9, contents: ["m4", "m5"], startIndex: 4 },
		{ name: "limit larger than what exists returns the whole prefix", total: 3, before: 3, limit: 500, contents: ["m0", "m1", "m2"], startIndex: 0 },
		{ name: "empty history yields an empty page", total: 0, before: 10, limit: 100, contents: [], startIndex: 0 },
	];

	for (const c of cases) {
		test(c.name, () => {
			const page = sliceHistoryPage(history(c.total), c.before, c.limit);
			expect(page.messages.map((m) => m.content)).toEqual(c.contents);
			expect(page.startIndex).toBe(c.startIndex);
		});
	}

	test("walking `before` backwards from the end covers the full history exactly once", () => {
		const all = history(23);
		const seen: unknown[] = [];
		let before = all.length;
		while (before > 0) {
			const page = sliceHistoryPage(all, before, 5);
			seen.unshift(...page.messages.map((m) => m.content));
			expect(page.startIndex).toBeLessThan(before);
			before = page.startIndex;
		}
		expect(seen).toEqual(all.map((m) => m.content));
	});
});

describe("computeUsageRollup", () => {
	test("sums every usage field (and cost.total) across assistant messages", () => {
		const rollup = computeUsageRollup([
			{ role: "user", content: "q" },
			{
				role: "assistant",
				content: [],
				usage: { input: 100, output: 20, cacheRead: 7, cacheWrite: 3, totalTokens: 130, cost: { total: 0.25 } },
			},
			{
				role: "assistant",
				content: [],
				usage: { input: 1000, output: 200, cacheRead: 70, cacheWrite: 30, totalTokens: 1300, cost: { total: 0.5 } },
			},
		]);
		expect(rollup).toEqual({
			input: 1100,
			output: 220,
			cacheRead: 77,
			cacheWrite: 33,
			totalTokens: 1430,
			cost: 0.75,
		});
	});

	test("ignores non-assistant messages and malformed usage instead of throwing or miscounting", () => {
		const rollup = computeUsageRollup([
			// usage on a user message must not count
			{ role: "user", content: "q", usage: { input: 9999, totalTokens: 9999, cost: { total: 99 } } },
			{ role: "assistant", content: [] }, // no usage at all
			{ role: "assistant", content: [], usage: "nope" }, // non-object usage
			// junk values coerce to 0, non-finite cost is skipped
			{ role: "assistant", content: [], usage: { input: "abc", output: 5, cost: { total: "wat" } } },
			{ role: "assistant", content: [], usage: { input: 10, totalTokens: 15, cost: { total: 0.1 } } },
		]);
		expect(rollup).toEqual({
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: 0.1,
		});
	});

	test("reasoningTokens is absent unless some assistant message carried it, then sums only those", () => {
		const without = computeUsageRollup([
			{ role: "assistant", content: [], usage: { input: 1, output: 1, totalTokens: 2 } },
		]);
		expect(without.reasoningTokens).toBeUndefined();

		const withSome = computeUsageRollup([
			{ role: "assistant", content: [], usage: { input: 1, reasoningTokens: 5 } },
			{ role: "assistant", content: [], usage: { input: 1 } },
			{ role: "assistant", content: [], usage: { input: 1, reasoningTokens: 7 } },
		]);
		expect(withSome.reasoningTokens).toBe(12);
	});
	// T-97: Codex sub-agent cost in snapshot rollup
	test("includes task toolResult details.usage in snapshot rollup (T-97)", () => {
		const rollup = computeUsageRollup([
			// Parent assistant turn (e.g. deciding to spawn sub-agents)
			{
				role: "assistant",
				content: [],
				usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.25 } },
			},
			// Task tool result carrying aggregated sub-agent usage
			{
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "task",
				content: [{ type: "text", text: "done" }],
				isError: false,
				details: {
					results: [{ id: "Worker1", tokens: 5432 }],
					usage: {
						input: 1000,
						output: 200,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1200,
						cost: { input: 0.01, output: 0.032, cacheRead: 0, cacheWrite: 0, total: 0.042 },
					},
				},
			},
			// Non-task toolResult must not count
			{
				role: "toolResult",
				toolCallId: "tc-2",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				details: { usage: { totalTokens: 9999, cost: { total: 99 } } },
			},
			// Error task toolResult must not count
			{
				role: "toolResult",
				toolCallId: "tc-3",
				toolName: "task",
				content: [{ type: "text", text: "err" }],
				isError: true,
				details: { usage: { totalTokens: 9999, cost: { total: 99 } } },
			},
		]);
		const { cost, ...rest } = rollup;
		expect(rest).toEqual({
			input: 1100,
			output: 220,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1320,
		});
		expect(cost).toBeCloseTo(0.292, 6);
	});
});
