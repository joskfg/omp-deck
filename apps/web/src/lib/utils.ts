import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
	return `${(n / 1000 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTokens(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatCost(n: number): string {
	if (!Number.isFinite(n) || n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

export function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${ms}ms`;
	if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
	const roundedSeconds = Math.round(ms / 1000);
	const m = Math.floor(roundedSeconds / 60);
	const s = roundedSeconds % 60;
	return `${m}m ${s}s`;
}

/** Format an ISO timestamp to a compact absolute time.
 * Today → "14:30", this year → "Jul 10, 14:30", older → "Jul 10 2025, 14:30". */
export function formatTimestamp(iso: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const now = new Date();
	const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	if (sameDay) return time;
	const monthDay = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	if (d.getFullYear() === now.getFullYear()) return `${monthDay}, ${time}`;
	return `${monthDay} ${d.getFullYear()}, ${time}`;
}


export function shortPath(p: string | undefined, max = 64): string {
	if (!p) return "";
	if (p.length <= max) return p;
	const parts = p.split(/[\\/]/);
	if (parts.length <= 2) return p.slice(-max);
	return `…/${parts.slice(-2).join("/")}`;
}

export function truncate(text: string, max: number): string {
	if (!text || text.length <= max) return text ?? "";
	return `${text.slice(0, max - 1)}…`;
}

/**
 * Normalise the `cost` field from a SDK sub-agent result payload.
 *
 * The SDK's `accumulatedUsage.cost` is an object
 * `{ input, output, cacheRead, cacheWrite, total }`, but callers may also
 * pass a plain number (legacy shape). Returns `undefined` when the value is
 * absent or not a recognised shape so the UI can gate on presence.
 */
export function extractSubagentCost(cost: unknown): number | undefined {
	if (typeof cost === "number") return cost;
	if (cost !== null && typeof cost === "object" && "total" in cost) {
		const total = cost.total;
		if (typeof total === "number") return total;
	}
	return undefined;
}
