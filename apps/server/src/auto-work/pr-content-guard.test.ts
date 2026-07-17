import { describe, expect, test } from "bun:test";
import { SensitiveContentError, assertNoSecretsInDiff, assertNoSensitiveContent } from "./pr-content-guard.ts";

// Credential-shaped fixtures below are built with string concatenation
// rather than a literal contiguous string. This repo's own diff-scanning
// guard (this file's subject) would otherwise flag this very test file when
// Auto Work opens the PR that adds it — see `pr-content-guard.ts`'s module
// docstring and T-119.

describe("assertNoSensitiveContent", () => {
	test("passes plain, link-free, credential-free text", () => {
		expect(() => assertNoSensitiveContent("PR body", "Auto Work completed T-1: Fix login bug\n\nSession: abcdef12")).not.toThrow();
	});

	test("rejects an absolute URL of any kind, not just credential-bearing ones", () => {
		expect(() => assertNoSensitiveContent("PR body", "See http://localhost:8787/c/abc123 for details")).toThrow(SensitiveContentError);
		expect(() => assertNoSensitiveContent("PR body", "docs at https://example.com/readme")).toThrow(SensitiveContentError);
	});

	test("never echoes any part of a matched URL in the thrown message — only a redacted count", () => {
		try {
			assertNoSensitiveContent("PR body", "internal: http://10.0.0.5:9999/secret-path?x=1");
			throw new Error("expected assertNoSensitiveContent to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(SensitiveContentError);
			const message = (err as Error).message;
			expect(message).not.toContain("10.0.0.5");
			expect(message).not.toContain("secret-path");
			expect(message).toContain("redacted link");
		}
	});

	test("rejects credentials embedded in a URL (user:pass@host) unconditionally, no placeholder exemption", () => {
		const sneaky = ["https://user", "notreallyaplaceholder@internal.example.com/hook"].join(":");
		expect(() => assertNoSensitiveContent("PR body", sneaky)).toThrow(SensitiveContentError);
	});

	test("rejects a realistic-looking provider API key", () => {
		const key = ["sk-ant", `api03-${"B".repeat(60)}`].join("-");
		expect(() => assertNoSensitiveContent("PR title", `key: ${key}`)).toThrow(SensitiveContentError);
	});

	test("exempts a placeholder-shaped provider key (.env.example style)", () => {
		// The literal placeholder OpenAI echoed back in the credential-quality.ts
		// motivating bug (issue #4) — an established "known safe" fixture in
		// this codebase, reused here instead of inventing a new one.
		expect(() => assertNoSensitiveContent("PR body", "OPENAI_API_KEY=sk-your-XXXXXXXXXXXXXXXXhere")).not.toThrow();
	});

	test("labels the failing field in the thrown message", () => {
		expect(() => assertNoSensitiveContent("PR title", "http://example.com")).toThrow(/PR title contains sensitive content/);
	});
});

describe("assertNoSecretsInDiff", () => {
	function diffOf(addedLines: string[]): string {
		return [
			"diff --git a/file.txt b/file.txt",
			"index 0000000..1111111 100644",
			"--- a/file.txt",
			"+++ b/file.txt",
			`@@ -0,0 +1,${addedLines.length} @@`,
			...addedLines.map((line) => `+${line}`),
		].join("\n");
	}

	test("allows an ordinary diff with no credentials", () => {
		expect(() => assertNoSecretsInDiff(diffOf(["export function add(a, b) { return a + b; }"]))).not.toThrow();
	});

	test("does NOT flag a plain absolute URL added by the diff — only the message guard does that", () => {
		expect(() => assertNoSecretsInDiff(diffOf(["See https://github.com/jaesbit/omp-deck/pull/42 for context."]))).not.toThrow();
	});

	test("ignores pre-existing (removed/context) lines, only scans ADDED lines", () => {
		const key = ["sk-ant", `api03-${"C".repeat(60)}`].join("-");
		const diff = [
			"diff --git a/file.txt b/file.txt",
			"index 0000000..1111111 100644",
			"--- a/file.txt",
			"+++ b/file.txt",
			"@@ -1,1 +1,1 @@",
			`-${key}`,
			" unrelated context line",
		].join("\n");
		expect(() => assertNoSecretsInDiff(diff)).not.toThrow();
	});

	test("rejects a realistic-looking secret in an added line", () => {
		const key = ["AKIA", "Q".repeat(16)].join("");
		expect(() => assertNoSecretsInDiff(diffOf([`const key = "${key}";`]))).toThrow(SensitiveContentError);
	});

	test("exempts a placeholder-shaped key in an added line (.env.example fixtures)", () => {
		expect(() => assertNoSecretsInDiff(diffOf(["OPENAI_API_KEY=sk-your-XXXXXXXXXXXXXXXXhere"]))).not.toThrow();
	});

	test("rejects user:pass@ credentials in an added line, even when the password looks placeholder-ish", () => {
		const sneaky = ["http://demo", "changeme@internal.example.com/"].join(":");
		expect(() => assertNoSecretsInDiff(diffOf([sneaky]))).toThrow(SensitiveContentError);
	});

	test("rejects a PEM private key block added by the diff", () => {
		const pemHeader = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
		expect(() => assertNoSecretsInDiff(diffOf([pemHeader]))).toThrow(SensitiveContentError);
	});

	test("redacts the matched secret in its thrown message, never the raw value", () => {
		const key = ["sk-ant", `api03-${"D".repeat(60)}`].join("-");
		try {
			assertNoSecretsInDiff(diffOf([`const key = "${key}";`]));
			throw new Error("expected assertNoSecretsInDiff to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(SensitiveContentError);
			const message = (err as Error).message;
			expect(message).not.toContain(key);
			expect(message).toContain("Anthropic API key");
		}
	});
});
