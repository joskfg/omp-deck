/**
 * Guards Auto Work's generated Pull Requests against leaking links or
 * credentials (T-119).
 *
 * Two independent checks, both run from `createPullRequestViaGh` before the
 * branch is pushed or a PR is opened — nothing sensitive leaves the local
 * worktree once either one rejects:
 *
 *  1. `assertNoSensitiveContent(label, text)` — validates the auto-generated
 *     PR title/body. That text is 100% engine-controlled (a fixed template
 *     plus the task title), it has no legitimate reason to ever contain a
 *     link or a credential, so ANY absolute URL or credential-shaped string
 *     is rejected outright, with no exemptions. This is what catches the
 *     concrete bug T-119 was filed for: the PR body used to embed the
 *     deck's own session URL (`Session: http://localhost:8787/c/<id>`, or a
 *     configured custom deck host) directly in the public GitHub PR
 *     description — see `buildAutoWorkPrMessage` in `./engine.ts`.
 *
 *  2. `assertNoSecretsInDiff(diff)` — scans lines the branch ADDS (i.e.
 *     `+`-prefixed lines from `git diff <base>...HEAD`, `+++` file headers
 *     excluded) for credential-shaped strings: provider API-key prefixes,
 *     PEM private-key blocks, and `user:pass@host` embedded in a URL.
 *     Only added lines are scanned, so pre-existing repository content the
 *     PR didn't introduce never trips the guard.
 *
 *     Deliberately does NOT flag general absolute URLs in the diff — unlike
 *     the message check above, a blanket URL ban on arbitrary source changes
 *     would reject huge swaths of ordinary development in this repo (doc
 *     links, `https://github.com/...` test fixtures, CDN imports, ...) for
 *     no security benefit: a URL sitting in application code is not a
 *     secret. Provider-prefixed API-key patterns are exempted via
 *     `looksLikePlaceholderKey` so `.env.example`-style fixtures and docs
 *     don't false-positive — but `user:pass@` URL credentials are never
 *     exempted, even when the password segment looks placeholder-ish, per
 *     this ticket's explicit "usuario:contraseña en URLs" requirement.
 *
 * Scope note: this enforces the boundary right before the branch is
 * *pushed* (and before the PR is opened), not at the moment of `git commit`
 * — Auto Work's commits are made by the agent's own session, outside any
 * code path the deck server controls, so there is no in-process hook point
 * earlier than "about to push". Nothing sensitive reaches `origin` (or a
 * public PR) once this guard rejects, a rejected run still leaves the
 * offending commit sitting locally in the worktree for a human to inspect
 * and rewrite (see `completed_pr_failed` handling in `./engine.ts`).
 */

import { looksLikePlaceholderKey } from "../credential-quality.ts";

export class SensitiveContentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SensitiveContentError";
	}
}

interface CredentialPatternDef {
	readonly name: string;
	readonly re: RegExp;
	/** When true, a match whose full text `looksLikePlaceholderKey` suppresses the hit. */
	readonly exemptPlaceholders: boolean;
}

// `re` here is the "template" — always compiled fresh (see `withGlobalFlag`)
// before use so a shared, stateful `g`-flagged RegExp's `.lastIndex` can
// never leak across calls.
const CREDENTIAL_PATTERN_DEFS: readonly CredentialPatternDef[] = [
	{ name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/, exemptPlaceholders: true },
	{ name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/, exemptPlaceholders: true },
	{ name: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, exemptPlaceholders: true },
	{ name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,72}\b/, exemptPlaceholders: true },
	{ name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, exemptPlaceholders: true },
	{ name: "OpenAI-shaped API key", re: /\bsk-(?:proj-|org-)?[A-Za-z0-9_-]{20,}\b/, exemptPlaceholders: true },
	{ name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/, exemptPlaceholders: true },
	{ name: "PEM private key block", re: /-----BEGIN(?: RSA| EC| OPENSSH| DSA| PGP)? PRIVATE KEY-----/, exemptPlaceholders: false },
	// `<scheme>://<user>:<pass>@<host>` — credentials embedded directly in a URL.
	// Never exempted (see module docstring).
	{ name: "credentials embedded in a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s"'<>]+/i, exemptPlaceholders: false },
];

const ABSOLUTE_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]"'`]+/gi;

/** Recompiles `re` with a guaranteed `g` flag so `matchAll` is safe and stateless per call. */
function withGlobalFlag(re: RegExp): RegExp {
	return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

/** Truncates a matched secret to a short, non-reversible-looking excerpt for error messages. */
function redact(value: string): string {
	if (value.length <= 8) return "*".repeat(value.length);
	return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}

// Redacted URLs never echo any part of the match — for an internal link the
// host itself is the sensitive datum, so only a count is reported.

function findCredentials(text: string): string[] {
	const hits: string[] = [];
	for (const def of CREDENTIAL_PATTERN_DEFS) {
		for (const match of text.matchAll(withGlobalFlag(def.re))) {
			const value = match[0];
			if (def.exemptPlaceholders && looksLikePlaceholderKey(value)) continue;
			hits.push(`${def.name} (${redact(value)})`);
		}
	}
	return hits;
}

function findAbsoluteUrls(text: string): string[] {
	return [...text.matchAll(withGlobalFlag(ABSOLUTE_URL_RE))].map((m) => m[0]);
}

/**
 * Throws when `text` — an Auto Work-generated PR title or body — contains an
 * absolute URL or a credential-shaped string. `label` identifies the field
 * in the thrown message (e.g. `"PR title"`, `"PR body"`). The thrown message
 * is persisted to run/task state and logs, so findings are always redacted,
 * never the raw matched URL or credential text.
 */
export function assertNoSensitiveContent(label: string, text: string): void {
	const urls = findAbsoluteUrls(text);
	const credentials = findCredentials(text);
	if (urls.length === 0 && credentials.length === 0) return;
	const parts: string[] = [];
	if (urls.length > 0) parts.push(`${urls.length} redacted link(s)`);
	if (credentials.length > 0) parts.push(`credential(s): ${credentials.join(", ")}`);
	throw new SensitiveContentError(`${label} contains sensitive content — ${parts.join(" · ")}. Auto Work refuses to publish this.`);
}

/** Strips a unified diff down to the text of lines it ADDS (`+`-prefixed, `+++` file headers excluded). */
function addedLines(diff: string): string {
	return diff
		.split("\n")
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
		.map((line) => line.slice(1))
		.join("\n");
}

/**
 * Throws when a line the branch ADDS (not pre-existing repository content)
 * looks like a credential. Does not flag general absolute URLs in the diff
 * — see module docstring for why.
 */
export function assertNoSecretsInDiff(diff: string): void {
	const credentials = findCredentials(addedLines(diff));
	if (credentials.length === 0) return;
	throw new SensitiveContentError(
		`branch diff adds credential-shaped content — ${credentials.join(", ")}. Auto Work refuses to push or open a PR for this branch — remove the secret (and rewrite history if it was already committed locally) before retrying.`,
	);
}
