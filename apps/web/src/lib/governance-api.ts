import type {
	ListExtensionsResponse,
	ListGovernanceAuditResponse,
	ListRulesResponse,
	ListTtsrHistoryResponse,
	SetExtensionEnabledResponse,
	SetRuleEnabledResponse,
} from "@omp-deck/protocol";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "(unreadable body)");
		let parsedError: string | undefined;
		try {
			const parsed: unknown = JSON.parse(text);
			if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
				parsedError = parsed.error;
			}
		} catch {
			// Body wasn't JSON — fall through to the raw-text error below.
		}
		throw new Error(parsedError ?? `HTTP ${res.status} ${path}: ${text}`);
	}
	return (await res.json()) as T;
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) search.set(key, String(value));
	}
	const qs = search.toString();
	return qs ? `${path}?${qs}` : path;
}

export const governanceApi = {
	listRules(cwd?: string): Promise<ListRulesResponse> {
		return req<ListRulesResponse>(withQuery("/governance/rules", { cwd }));
	},
	setRuleEnabled(name: string, enabled: boolean, cwd?: string): Promise<SetRuleEnabledResponse> {
		return req<SetRuleEnabledResponse>(withQuery(`/governance/rules/${encodeURIComponent(name)}`, { cwd }), {
			method: "PUT",
			body: JSON.stringify({ enabled }),
		});
	},
	listExtensions(cwd?: string): Promise<ListExtensionsResponse> {
		return req<ListExtensionsResponse>(withQuery("/governance/extensions", { cwd }));
	},
	setExtensionEnabled(id: string, enabled: boolean, cwd?: string): Promise<SetExtensionEnabledResponse> {
		return req<SetExtensionEnabledResponse>(withQuery(`/governance/extensions/${encodeURIComponent(id)}`, { cwd }), {
			method: "PUT",
			body: JSON.stringify({ enabled }),
		});
	},
	listTtsrHistory(cwd?: string, limit?: number): Promise<ListTtsrHistoryResponse> {
		return req<ListTtsrHistoryResponse>(withQuery("/governance/ttsr/history", { cwd, limit }));
	},
	listAudit(kind?: string, limit?: number): Promise<ListGovernanceAuditResponse> {
		return req<ListGovernanceAuditResponse>(withQuery("/governance/audit", { kind, limit }));
	},
};
