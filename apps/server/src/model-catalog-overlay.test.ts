/**
 * Tests for `ModelCatalogOverlay` (T-74).
 *
 * The overlay's contract is small and entirely about shadow-set behavior,
 * so we exercise it with a stub `RegistryLike` and a fake clock. The
 * real registry's behavior is verified separately by the existing bridge
 * suites; this file's job is to lock down the overlay's invariants.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
	ModelCatalogOverlay,
	classifyModelError,
	__setModelCatalogOverlayForTesting,
} from "./model-catalog-overlay.ts";
import type { OverlayModel, RegistryLike, ShadowEntry } from "./model-catalog-overlay.ts";

const HOUR = 60 * 60 * 1000;

class StubRegistry implements RegistryLike {
	private all: OverlayModel[] = [];
	refreshCalls: Array<RegistryLike["refresh"] extends (...a: infer A) => unknown ? A[0] : never> = [];

	getAll(): Array<{ provider: string; id: string }> {
		return this.all.map((m) => ({ provider: m.provider, id: m.id }));
	}

	async refresh(mode: "online" | "online-if-uncached" | "offline"): Promise<undefined> {
		this.refreshCalls.push(mode);
	}

	setModels(next: OverlayModel[]): void {
		this.all = next;
	}
}

interface Harness {
	overlay: ModelCatalogOverlay;
	registry: StubRegistry;
	now: () => number;
	tick: (ms: number) => void;
}

function makeHarness(opts: { ttlMs?: number; disabled?: boolean; initial?: OverlayModel[] } = {}): Harness {
	const registry = new StubRegistry();
	registry.setModels(opts.initial ?? []);
	let nowMs = 1_700_000_000_000;
	const tick = (ms: number) => {
		nowMs += ms;
	};
	const overlay = new ModelCatalogOverlay(async () => registry, {
		shadowTtlMs: opts.ttlMs ?? 24 * HOUR,
		disabled: opts.disabled ?? false,
		now: () => nowMs,
	});
	return { overlay, registry, now: () => nowMs, tick };
}

afterEach(() => {
	// Don't leak the test singleton into other suites.
	__setModelCatalogOverlayForTesting(undefined);
});

describe("ModelCatalogOverlay.getModels", () => {
	it("returns the full registry list when the shadow is empty", async () => {
		const { overlay, registry } = makeHarness({
			initial: [
				{ provider: "anthropic", id: "claude-opus-4-1" },
				{ provider: "openai", id: "gpt-5" },
			],
		});
		const out = await overlay.getModels();
		expect(out).toHaveLength(2);
		expect(out.map((m) => m.id).sort()).toEqual(["claude-opus-4-1", "gpt-5"]);
		expect(registry.refreshCalls).toEqual([]);
	});

	it("filters out models in the shadow set", async () => {
		const { overlay } = makeHarness({
			initial: [
				{ provider: "anthropic", id: "claude-opus-4-1" },
				{ provider: "openai", id: "gpt-5" },
			],
		});
		overlay.recordFailure({ provider: "openai", id: "gpt-5" }, makeError("404", "model not found"));
		const out = await overlay.getModels();
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual({ provider: "anthropic", id: "claude-opus-4-1" });
	});

	it("disabled mode is a transparent pass-through", async () => {
		const { overlay } = makeHarness({
			disabled: true,
			initial: [
				{ provider: "openai", id: "gpt-5" },
			],
		});
		overlay.recordFailure({ provider: "openai", id: "gpt-5" }, makeError("404", "model not found"));
		const [first] = await overlay.getModels();
		expect(first).toBeDefined();
		expect(first?.id).toBe("gpt-5");
	});
});

describe("ModelCatalogOverlay.recordFailure", () => {
	it("shadows on not_found", async () => {
		const { overlay } = makeHarness();
		const shadowed = overlay.recordFailure(
			{ provider: "anthropic", id: "claude-opus-4-1" },
			makeError("404", "model not found"),
		);
		const [first] = overlay.listShadowed();
		expect(first).toBeDefined();
		expect(first?.reason).toBe("not_found");
	});

	it("shadows on unauthorized", async () => {
		const { overlay } = makeHarness();
		const shadowed = overlay.recordFailure(
			{ provider: "openai", id: "gpt-5" },
			makeError("401", "invalid api key"),
		);
		const [first] = overlay.listShadowed();
		expect(first).toBeDefined();
		expect(first?.reason).toBe("unauthorized");
	});

	it("does not shadow on 5xx / server errors, including rate-limit / timeout", async () => {
		const { overlay } = makeHarness();
		const shadowed = overlay.recordFailure(
			{ provider: "anthropic", id: "claude-opus-4-1" },
			makeError("503", "service unavailable"),
		);
		expect(shadowed).toBe(false);
		expect(overlay.listShadowed()).toHaveLength(0);

		// Rate-limit/timeout messages classify to the same "server" kind via the
		// substring branch and must not shadow the model either — distinct,
		// human-meaningful business rule from generic 5xx handling.
		const rateLimited = overlay.recordFailure(
			{ provider: "openai", id: "gpt-5" },
			makeError("429", "rate limit exceeded"),
		);
		expect(rateLimited).toBe(false);
	});

	it("does not shadow on unknown errors", async () => {
		const { overlay } = makeHarness();
		const shadowed = overlay.recordFailure(
			{ provider: "openai", id: "gpt-5" },
			new Error("weird transient thing"),
		);
		expect(shadowed).toBe(false);
	});

	it("increments count on repeated failures and keeps the latest reason", async () => {
		const { overlay } = makeHarness();
		overlay.recordFailure(
			{ provider: "openai", id: "gpt-5" },
			makeError("401", "invalid api key"),
		);
		overlay.recordFailure(
			{ provider: "openai", id: "gpt-5" },
			makeError("404", "model not found"),
		);
		const [first] = overlay.listShadowed();
		expect(first).toBeDefined();
		expect(first?.count).toBe(2);
		// The second failure's reason wins.
		expect(first?.reason).toBe("not_found");
	});
});

describe("ModelCatalogOverlay.recordSuccess", () => {
	it("clears the shadow for a model that just worked", async () => {
		const { overlay } = makeHarness();
		overlay.recordFailure(
			{ provider: "openai", id: "gpt-5" },
			makeError("404", "model not found"),
		);
		expect(overlay.listShadowed()).toHaveLength(1);
		overlay.recordSuccess({ provider: "openai", id: "gpt-5" });
		expect(overlay.listShadowed()).toHaveLength(0);
	});

	it("is a no-op when there is no shadow to clear", () => {
		const { overlay } = makeHarness();
		expect(() => overlay.recordSuccess({ provider: "openai", id: "gpt-5" })).not.toThrow();
		expect(overlay.listShadowed()).toHaveLength(0);
	});
});

describe("ModelCatalogOverlay TTL", () => {
	it("drops shadow entries older than the configured TTL", async () => {
		const { overlay, tick } = makeHarness({ ttlMs: HOUR });
		overlay.recordFailure(
			{ provider: "openai", id: "gpt-5" },
			makeError("404", "model not found"),
		);
		expect(overlay.listShadowed()).toHaveLength(1);
		tick(HOUR + 1);
		// getModels sweeps the expired shadows.
		await overlay.getModels();
		expect(overlay.listShadowed()).toHaveLength(0);
	});

	it("keeps shadow entries that are still within the TTL", async () => {
		const { overlay, tick } = makeHarness({ ttlMs: HOUR });
		overlay.recordFailure(
			{ provider: "openai", id: "gpt-5" },
			makeError("404", "model not found"),
		);
		tick(HOUR - 1);
		await overlay.getModels();
		expect(overlay.listShadowed()).toHaveLength(1);
	});
});

describe("ModelCatalogOverlay.refresh", () => {
	it("calls the registry with the requested mode", async () => {
		const { overlay, registry } = makeHarness({
			initial: [{ provider: "openai", id: "gpt-5" }],
		});
		await overlay.refresh({ forceOnline: true });
		expect(registry.refreshCalls).toEqual(["online"]);
		await overlay.refresh();
		expect(registry.refreshCalls).toEqual(["online", "online-if-uncached"]);
	});

	it("shadows models that disappeared from the registry", async () => {
		const { overlay, registry } = makeHarness({
			initial: [
				{ provider: "openai", id: "gpt-5" },
				{ provider: "openai", id: "gpt-5-mini" },
			],
		});
		// Initial getModels() snapshots the previous set.
		await overlay.getModels();
		// Simulate upstream dropping gpt-5.
		registry.setModels([{ provider: "openai", id: "gpt-5-mini" }]);
		const visible = await overlay.refresh();
		expect(visible.map((m) => m.id)).toEqual(["gpt-5-mini"]);
		const shadowed = overlay.listShadowed();
		expect(shadowed).toHaveLength(1);
		expect(shadowed[0]).toMatchObject({ provider: "openai", id: "gpt-5", reason: "upstream_removed" });
	});

	it("does not shadow a freshly-removed model on the first call (no prior snapshot)", async () => {
		const { overlay, registry } = makeHarness();
		// No prior getModels / refresh call: lastSnapshot is empty.
		registry.setModels([{ provider: "openai", id: "gpt-5" }]);
		const visible = await overlay.refresh();
		expect(visible.map((m) => m.id)).toEqual(["gpt-5"]);
		expect(overlay.listShadowed()).toHaveLength(0);
	});

	it("does not overwrite a more specific reason (not_found / unauthorized) with upstream_removed", async () => {
		const { overlay, registry } = makeHarness({
			initial: [
				{ provider: "openai", id: "gpt-5" },
				{ provider: "openai", id: "gpt-5-mini" },
			],
		});
		// User has been getting 401s on gpt-5; the bridge already shadowed it.
		overlay.recordFailure({ provider: "openai", id: "gpt-5" }, makeError("401", "invalid api key"));
		await overlay.getModels();
		// Upstream now drops gpt-5 too.
		registry.setModels([{ provider: "openai", id: "gpt-5-mini" }]);
		await overlay.refresh();
		const [first] = overlay.listShadowed();
		expect(first).toBeDefined();
		expect(first?.reason).toBe("unauthorized");
	});

	it("un-shadows a model the upstream brought back", async () => {
		const { overlay, registry } = makeHarness({
			initial: [
				{ provider: "openai", id: "gpt-5" },
				{ provider: "openai", id: "gpt-5-mini" },
			],
		});
		await overlay.getModels();
		registry.setModels([{ provider: "openai", id: "gpt-5-mini" }]);
		await overlay.refresh();
		expect(overlay.listShadowed()).toHaveLength(1);
		registry.setModels([
			{ provider: "openai", id: "gpt-5" },
			{ provider: "openai", id: "gpt-5-mini" },
		]);
		const visible = await overlay.refresh();
		expect(visible.map((m) => m.id).sort()).toEqual(["gpt-5", "gpt-5-mini"]);
		// The upstream_removed entry is dropped because the model is back
		// in the registry and not in the shadow.
		expect(overlay.listShadowed()).toHaveLength(0);
	});
});

describe("ModelCatalogOverlay shadow set injection (test seam)", () => {
	it("__setShadowForTesting seeds the shadow", async () => {
		const { overlay } = makeHarness({
			initial: [
				{ provider: "openai", id: "gpt-5" },
				{ provider: "anthropic", id: "claude-opus-4-1" },
			],
		});
		const seed: ShadowEntry[] = [
			{
				provider: "openai",
				id: "gpt-5",
				// Use a failure-driven reason (not `upstream_removed`) so the
				// auto-revive block in `getModels()` doesn't immediately
				// re-include the model just because it's still in the
				// registry. The point of this test is the filter, not the
				// reconcile path (covered separately by `refresh` tests).
				reason: "not_found",
				firstSeenAt: 0,
				lastFailureAt: 0,
				count: 1,
				errorMessage: "seeded",
			},
		];
		overlay.__setShadowForTesting(seed);
		const visible = await overlay.getModels();
		expect(visible.map((m) => m.id)).toEqual(["claude-opus-4-1"]);
	});
});

describe("classifyModelError", () => {
	it("classifies 404 as not_found", () => {
		expect(classifyModelError(makeError("404", ""))).toEqual({ kind: "not_found", retriable: false });
	});
	it("classifies 401/403 as unauthorized", () => {
		expect(classifyModelError(makeError("401", ""))).toEqual({ kind: "unauthorized", retriable: false });
		expect(classifyModelError(makeError("403", ""))).toEqual({ kind: "unauthorized", retriable: false });
	});
	it("classifies 500+ as server, retriable", () => {
		expect(classifyModelError(makeError("500", ""))).toEqual({ kind: "server", retriable: true });
		expect(classifyModelError(makeError("502", ""))).toEqual({ kind: "server", retriable: true });
		expect(classifyModelError(makeError("503", ""))).toEqual({ kind: "server", retriable: true });
	});
	it("recognizes 'model_not_found' / 'model not found' substrings", () => {
		expect(classifyModelError(new Error("upstream: model_not_found"))).toEqual({
			kind: "not_found",
			retriable: false,
		});
		expect(classifyModelError(new Error("The model not found"))).toEqual({
			kind: "not_found",
			retriable: false,
		});
	});
	it("recognizes auth-shaped errors without a numeric status", () => {
		expect(classifyModelError(new Error("invalid_api_key"))).toEqual({
			kind: "unauthorized",
			retriable: false,
		});
		expect(classifyModelError(new Error("Incorrect API key provided"))).toEqual({
			kind: "unauthorized",
			retriable: false,
		});
	});
	it("recognizes transient conditions as retriable server/unknown", () => {
		expect(classifyModelError(new Error("overloaded"))).toEqual({ kind: "server", retriable: true });
		expect(classifyModelError(new Error("rate limit"))).toEqual({ kind: "server", retriable: true });
		expect(classifyModelError(new Error("timeout"))).toEqual({ kind: "server", retriable: true });
		expect(classifyModelError(new Error("something else entirely"))).toEqual({
			kind: "unknown",
			retriable: true,
		});
	});
	it("handles non-Error values", () => {
		expect(classifyModelError("plain string")).toEqual({ kind: "unknown", retriable: true });
		expect(classifyModelError(undefined)).toEqual({ kind: "unknown", retriable: true });
		expect(classifyModelError({ status: 404, message: "" })).toEqual({
			kind: "not_found",
			retriable: false,
		});
	});
});

/** Helper to build an error whose message starts with the supplied prefix. */
function makeError(statusText: string, body: string): Error {
	const e = new Error(`${statusText} ${body}`.trim());
	(e as Error & { status: number }).status = Number(statusText);
	return e;
}
