import { describe, expect, test } from "bun:test"

import { extractSubagentCost, formatDurationMs, formatTimestamp } from "./utils"

describe("formatDurationMs", () => {
	const cases = [
		{ name: "milliseconds", input: 999, expected: "999ms" },
		{ name: "seconds", input: 1_500, expected: "1.5s" },
		{ name: "minutes", input: 65_000, expected: "1m 5s" },
		{ name: "zero milliseconds", input: 0, expected: "0ms" },
		{ name: "rounded minute carry", input: 59_999, expected: "1m 0s" },
	]

	for (const { name, input, expected } of cases) {
		test(`formats ${name}`, () => {
			expect(formatDurationMs(input)).toBe(expected)
		})
	}

	test("uses an em dash for invalid or negative durations", () => {
		for (const input of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			expect(formatDurationMs(input)).toBe("—")
		}
	})
})

describe("formatTimestamp", () => {
	test("renders a valid ISO timestamp as an absolute date and time", () => {
		const localDate = new Date(2020, 0, 2, 12, 34, 0)
		const formatted = formatTimestamp(localDate.toISOString())
		const monthDay = localDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })
		const time = localDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })

		expect(formatted).toBe(`${monthDay} 2020, ${time}`)
	})

	test("returns an invalid timestamp unchanged", () => {
		expect(formatTimestamp("not-a-date")).toBe("not-a-date")
	})
})

describe("extractSubagentCost", () => {
	test("returns a plain number unchanged", () => {
		expect(extractSubagentCost(0.05)).toBe(0.05)
	})

	test("returns 0 when cost is the number 0 (subscription model, no per-token price)", () => {
		expect(extractSubagentCost(0)).toBe(0)
	})

	test("extracts total from SDK accumulatedUsage.cost object shape", () => {
		expect(extractSubagentCost({ input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.12 })).toBe(0.12)
	})

	test("extracts total from minimal { total } object", () => {
		expect(extractSubagentCost({ total: 0.007 })).toBe(0.007)
	})

	test("returns 0 when total is 0 (subscription model via object shape)", () => {
		expect(extractSubagentCost({ total: 0 })).toBe(0)
	})

	test("returns undefined for undefined", () => {
		expect(extractSubagentCost(undefined)).toBeUndefined()
	})

	test("returns undefined for null", () => {
		expect(extractSubagentCost(null)).toBeUndefined()
	})

	test("returns undefined for object without a numeric total", () => {
		expect(extractSubagentCost({})).toBeUndefined()
		expect(extractSubagentCost({ total: "0.05" })).toBeUndefined()
	})
})
