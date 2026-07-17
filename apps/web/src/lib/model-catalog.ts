import { useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "@omp-deck/protocol";

import { api } from "./api";

export interface ModelGroup {
	provider: string;
	items: ModelInfo[];
	hasCurrent: boolean;
}

export interface UseModelCatalogResult {
	models: ModelInfo[];
	loading: boolean;
	error: string | undefined;
	query: string;
	setQuery: (q: string) => void;
	showUnauth: boolean;
	setShowUnauth: (v: boolean) => void;
	availableCount: number;
	totalCount: number;
	/** Filtered + grouped-by-provider view, current-model provider floated first. */
	grouped: ModelGroup[];
	reload: () => void;
}

/**
 * Shared model-catalog fetch + filter/group logic. Backs `ModelPickerModal`
 * (swap the active session's model) and `SessionLaunchModal` (T-40: pick a
 * model before a session exists) so both surfaces search/group/label models
 * identically instead of maintaining two copies of the same logic.
 *
 * `sessionId` marks that session's current model with `isCurrent`; omit it
 * for pre-session flows where there is no "current" model yet. `active`
 * gates the fetch — pass the modal/panel's own `open` flag so a closed
 * consumer doesn't keep polling.
 */
export function useModelCatalog(sessionId?: string, active = true): UseModelCatalogResult {
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [query, setQuery] = useState("");
	const [showUnauth, setShowUnauth] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		if (!active) return;
		let stale = false;
		setLoading(true);
		setError(undefined);
		void api
			.listModels(sessionId)
			.then((resp) => {
				if (!stale) setModels(resp.models);
			})
			.catch((err) => {
				if (!stale) setError(String(err));
			})
			.finally(() => {
				if (!stale) setLoading(false);
			});
		return () => {
			stale = true;
		};
	}, [active, sessionId, reloadKey]);

	const availableCount = useMemo(() => models.filter((m) => m.isAvailable).length, [models]);
	const totalCount = models.length;

	const grouped = useMemo<ModelGroup[]>(() => {
		const q = query.trim().toLowerCase();
		const base = showUnauth ? models : models.filter((m) => m.isAvailable);
		const filtered = q
			? base.filter(
					(m) =>
						m.id.toLowerCase().includes(q) ||
						m.label.toLowerCase().includes(q) ||
						m.provider.toLowerCase().includes(q),
				)
			: base;
		const byProvider = new Map<string, ModelInfo[]>();
		for (const m of filtered) {
			const list = byProvider.get(m.provider) ?? [];
			list.push(m);
			byProvider.set(m.provider, list);
		}
		return Array.from(byProvider.entries())
			.map(([provider, items]) => ({
				provider,
				items: items.sort((a, b) => {
					if (a.isCurrent && !b.isCurrent) return -1;
					if (!a.isCurrent && b.isCurrent) return 1;
					return a.label.localeCompare(b.label);
				}),
				hasCurrent: items.some((m) => m.isCurrent),
			}))
			.sort((a, b) => {
				if (a.hasCurrent && !b.hasCurrent) return -1;
				if (!a.hasCurrent && b.hasCurrent) return 1;
				return a.provider.localeCompare(b.provider);
			});
	}, [models, query, showUnauth]);

	return {
		models,
		loading,
		error,
		query,
		setQuery,
		showUnauth,
		setShowUnauth,
		availableCount,
		totalCount,
		grouped,
		reload: () => setReloadKey((k) => k + 1),
	};
}
