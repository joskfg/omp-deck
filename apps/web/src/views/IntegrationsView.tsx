import { Layout } from "@/components/Layout";
import { ExternalLink, Plug } from "lucide-react";

/**
 * /integrations — MCP server overview.
 *
 * The built-in codebase-memory-mcp server is discovered for every session.
 * Project-level activation is managed from Project Configuration. The
 * remaining curated server catalog is still planned for V1.5.
 */
export function IntegrationsView() {
	return (
		<Layout
			sidebar={
				<div className="p-3">
					<div className="meta mb-2">Integrations</div>
					<div className="text-sm text-ink-3">
						Codebase Memory MCP is included by default. Manage its project-level
						toggle from Project Configuration.
					</div>
				</div>
			}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<div className="meta">Integrations</div>
						<span className="rounded border border-success/40 bg-success/10 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-success">
							Built-in
						</span>
					</div>
					<div className="flex flex-1 items-center justify-center px-6 py-8">
						<div className="max-w-2xl space-y-4">
							<div className="rounded border border-line bg-paper-2 p-3">
								<div className="flex items-center justify-between gap-3">
									<div>
										<div className="font-medium text-ink">codebase-memory-mcp</div>
										<div className="mt-1 text-xs text-ink-3">
											Built-in code intelligence server, enabled by default per project.
										</div>
									</div>
									<span className="font-mono text-2xs text-success">available</span>
								</div>
							</div>
							<div className="flex items-center gap-2">
								<Plug className="h-5 w-5 text-accent" />
								<h2 className="text-lg font-medium text-ink">Coming in V1.5</h2>
							</div>
							<p className="text-sm text-ink-2">
								The Integrations page will host one-click installs for the curated MCP
								server catalog —{" "}
								<a
									href="https://github.com/taylorwilsdon/google_workspace_mcp"
									target="_blank"
									rel="noreferrer"
									className="text-accent hover:underline"
								>
									Google Workspace
								</a>{" "}
								(Gmail + Calendar + Drive + Docs + 8 more), Slack, GitHub, Linear,
								Notion, Discord. Per-tenant OAuth, automatic refresh, advertised-tools
								panel.
							</p>
							<p className="text-sm text-ink-2">
								<strong className="text-ink">In V1:</strong> install MCP servers from
								chat with{" "}
								<code className="paper-code px-1 py-0.5 text-xs">/mcp install &lt;url-or-smithery-id&gt;</code>{" "}
								or{" "}
								<code className="paper-code px-1 py-0.5 text-xs">/mcp smithery-search &lt;query&gt;</code>.
								Once installed, any routine's <code>agent</code> step can use them via{" "}
								<code className="paper-code px-1 py-0.5 text-xs">mcp_servers_allowed: [...]</code>.
							</p>
							<p className="text-sm text-ink-2">
								The dedicated <code>mcp</code> step type for deterministic tool calls
								also lands in V1.5 once the SDK bridge exposes a direct{" "}
								<code className="paper-code px-1 py-0.5 text-xs">callMcpTool()</code>{" "}
								surface — the schema accepts the step spec today, only execution is
								deferred.
							</p>
							<div className="rounded border border-line bg-paper-2 p-3">
								<div className="meta mb-1.5">Design doc</div>
								<a
									href="https://github.com/bjb2/omp-deck/blob/main/docs/proposals/routines-v1-plan.md#5-integrations-via-mcp-v15"
									target="_blank"
									rel="noreferrer"
									className="flex items-center gap-1 text-sm text-accent hover:underline"
								>
									routines-v1-plan.md §5
									<ExternalLink className="h-3 w-3" />
								</a>
							</div>
						</div>
					</div>
				</div>
			}
			inspector={null}
			topBar={null}
		/>
	);
}
