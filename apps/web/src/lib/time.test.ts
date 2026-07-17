/**
 * Tests for the brief-time formatter on kanban task cards. The behavior under
 * test is purely deterministic — both `iso` and `now` are injected, and the
 * formatter reads local-timezone fields, so tests use small offsets from the
 * same wall-clock anchor to avoid DST flapping.
 */
import { describe, expect, test } from "bun:test";

import { formatBriefTime } from "./time";

const ANCHOR_ISO = "2026-05-23T15:30:00.000Z";
const ANCHOR = new Date(ANCHOR_ISO).getTime();

describe("formatBriefTime", () => {
	test("returns 'just now' for < 60s elapsed", () => {
		expect(formatBriefTime(new Date(ANCHOR - 1_000).toISOString(), ANCHOR)).toBe("just now");
		expect(formatBriefTime(new Date(ANCHOR - 59_999).toISOString(), ANCHOR)).toBe("just now");
	});

	test("returns minutes for < 60m elapsed", () => {
		expect(formatBriefTime(new Date(ANCHOR - 60_000).toISOString(), ANCHOR)).toBe("1m");
		expect(formatBriefTime(new Date(ANCHOR - 5 * 60_000).toISOString(), ANCHOR)).toBe("5m");
		expect(formatBriefTime(new Date(ANCHOR - 59 * 60_000).toISOString(), ANCHOR)).toBe("59m");
	});

	test("returns same-day time at exact hour (no colon, no minutes)", () => {
		// Build now + iso from the same local hour so we don't depend on the
		// CI host's UTC offset.
		const now = new Date(2026, 4, 23, 17, 0, 0).getTime(); // local 5pm
		const morning = new Date(2026, 4, 23, 9, 0, 0).toISOString();
		expect(formatBriefTime(morning, now)).toBe("9am");
		const noon = new Date(2026, 4, 23, 12, 0, 0).toISOString();
		expect(formatBriefTime(noon, now)).toBe("12pm");
		const midnight = new Date(2026, 4, 23, 0, 0, 0).toISOString();
		// Midnight-of-today rendered to a now also on the same calendar day.
		expect(formatBriefTime(midnight, new Date(2026, 4, 23, 14, 0, 0).getTime())).toBe("12am");
	});

	test("returns same-day time with minutes when not on the hour", () => {
		const now = new Date(2026, 4, 23, 17, 0, 0).getTime();
		const at530pm = new Date(2026, 4, 23, 13, 30, 0).toISOString();
		expect(formatBriefTime(at530pm, now)).toBe("1:30pm");
		const at1245am = new Date(2026, 4, 23, 0, 45, 0).toISOString();
		expect(formatBriefTime(at1245am, now)).toBe("12:45am");
	});

	test("returns MM/DD for prior calendar day within < 365d", () => {
		const now = new Date(2026, 4, 23, 17, 0, 0).getTime();
		const yesterday = new Date(2026, 4, 22, 17, 0, 0).toISOString();
		expect(formatBriefTime(yesterday, now)).toBe("05/22");
		const earlier = new Date(2026, 0, 8, 9, 30, 0).toISOString();
		expect(formatBriefTime(earlier, now)).toBe("01/08");
	});

	test("returns MM/DD/YY for ≥ 365d elapsed", () => {
		const now = new Date(2026, 4, 23, 17, 0, 0).getTime();
		const lastYearSameDay = new Date(2025, 4, 23, 17, 0, 0).toISOString();
		expect(formatBriefTime(lastYearSameDay, now)).toBe("05/23/25");
		const old = new Date(2024, 7, 1, 9, 0, 0).toISOString();
		expect(formatBriefTime(old, now)).toBe("08/01/24");
	});

	test("boundary at 60m flips 'Xm' → time-of-day", () => {
		// 60 minutes elapsed = exactly 1 hour ago; should fall into the time-of-day tier.
		const now = new Date(2026, 4, 23, 12, 0, 0).getTime();
		const oneHourAgo = new Date(2026, 4, 23, 11, 0, 0).toISOString();
		expect(formatBriefTime(oneHourAgo, now)).toBe("11am");
	});

	test("invalid input returns empty string", () => {
		expect(formatBriefTime("not-a-date", ANCHOR)).toBe("");
	});
});
