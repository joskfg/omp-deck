import { afterEach, describe, expect, test } from "bun:test";

import { loadConfig } from "./config.ts";

const originalTitle = process.env.OMP_DECK_TITLE;

afterEach(() => {
	if (originalTitle === undefined) delete process.env.OMP_DECK_TITLE;
	else process.env.OMP_DECK_TITLE = originalTitle;
});

describe("OMP_DECK_TITLE", () => {
	test("defaults to omp-deck when unset", () => {
		delete process.env.OMP_DECK_TITLE;

		expect(loadConfig().title).toBe("omp-deck");
	});

	test("uses the trimmed configured title", () => {
		process.env.OMP_DECK_TITLE = "  Acme Deck  ";

		expect(loadConfig().title).toBe("Acme Deck");
	});
});
