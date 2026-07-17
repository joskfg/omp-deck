import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import puppeteer from "puppeteer-core";

const WEB_ROOT = join(import.meta.dir, "..");
const DIST_ROOT = join(WEB_ROOT, "dist");
const FIXTURE_CWD = "/tmp/codebase-memory-e2e";
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? "/usr/bin/chromium";

if (!existsSync(DIST_ROOT)) throw new Error("Missing apps/web/dist. Run `bun run build` before this E2E smoke test.");
if (!existsSync(executablePath)) throw new Error(`Chromium executable not found: ${executablePath}. Set PUPPETEER_EXECUTABLE_PATH.`);

function json(value: unknown): Response {
	return Response.json(value);
}

function toolResponse(value: unknown): Response {
	return json({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
}

function contentType(path: string): string {
	switch (extname(path)) {
		case ".js": return "text/javascript";
		case ".css": return "text/css";
		case ".svg": return "image/svg+xml";
		case ".png": return "image/png";
		case ".woff": return "font/woff";
		case ".woff2": return "font/woff2";
		default: return "text/html";
	}
}

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/api/workspaces") {
			return json({ workspaces: [{ cwd: FIXTURE_CWD, label: "fixture-project", sessionCount: 0 }] });
		}
		if (url.pathname === "/api/sessions") return json({ sessions: [] });
		if (url.pathname === "/api/workspace-mcp/codebase-memory" && request.method === "GET") {
			return json({ cwd: FIXTURE_CWD, enabled: true, configured: true });
		}
		if (url.pathname === "/api/workspace-mcp/codebase-memory/overview") {
			return json({
				cwd: FIXTURE_CWD,
				state: "ready",
				tools: [],
				catalog: [{
					type: "text",
					text: JSON.stringify({ projects: [{ name: "fixture-project", root_path: FIXTURE_CWD, git: { branch: "main", canonical_root: FIXTURE_CWD, worktree_root: null }, nodes: 5, edges: 4, size_bytes: 128 }] }),
				}],
			});
		}
		if (url.pathname === "/api/workspace-mcp/codebase-memory/query" && request.method === "POST") {
			const body = await request.json() as { tool: string; arguments: Record<string, unknown> };
			if (body.tool === "get_graph_schema") {
				return toolResponse({ node_labels: [{ label: "Function", count: 2 }, { label: "Folder", count: 1 }, { label: "File", count: 2 }], edge_types: [{ type: "CONTAINS_FILE", count: 2 }, { type: "DEFINES", count: 2 }] });
			}
			if (body.tool === "search_graph") {
				const { label, query, file_pattern: filePattern } = body.arguments;
				if (label === "Folder") return toolResponse({ total: 1, results: [{ name: "src", qualified_name: "fixture.src", label: "Folder", file_path: "src" }] });
				if (label === "File") return toolResponse({ total: 2, results: [{ name: "README.md", qualified_name: "fixture.README", label: "File", file_path: "README.md" }, { name: "alpha.ts", qualified_name: "fixture.src.alpha", label: "File", file_path: "src/alpha.ts" }] });
				if (filePattern === "src/alpha.ts") return toolResponse({ total: 1, results: [{ name: "alpha", qualified_name: "fixture.src.alpha", label: "Function", file_path: "src/alpha.ts", start_line: 1, end_line: 3, in_degree: 0, out_degree: 1 }] });
				if (query === "alpha") return toolResponse({ total: 1, results: [{ name: "alpha", qualified_name: "fixture.src.alpha", label: "Function", file_path: "src/alpha.ts", start_line: 1, end_line: 3, in_degree: 0, out_degree: 1 }] });
				return toolResponse({ total: 0, results: [] });
			}
			if (body.tool === "get_code_snippet") {
				return toolResponse({ name: "alpha", qualified_name: "fixture.src.alpha", label: "Function", file_path: "src/alpha.ts", start_line: 1, end_line: 3, source: "export function alpha() {\n\treturn beta() + 1;\n}" });
			}
			if (body.tool === "trace_path") return toolResponse({ function: "alpha", direction: "both", callers: [], callees: [{ name: "beta", qualified_name: "fixture.src.beta", hop: 1 }] });
			return toolResponse({});
		}
		const requested = normalize(join(DIST_ROOT, url.pathname));
		const file = requested.startsWith(DIST_ROOT) && existsSync(requested) ? Bun.file(requested) : Bun.file(join(DIST_ROOT, "index.html"));
		return new Response(file, { headers: { "content-type": contentType(file.name) } });
	},
});

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
const consoleErrors: string[] = [];
page.on("console", (message) => {
	if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));
await page.evaluateOnNewDocument(() => {
	class MockWebSocket extends EventTarget {
		static readonly OPEN = 1;
		static readonly CONNECTING = 0;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readonly readyState = MockWebSocket.OPEN;
		constructor(_url: string | URL) {
			super();
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		send(): void {}
		close(): void { this.dispatchEvent(new CloseEvent("close")); }
	}
	Object.defineProperty(window, "WebSocket", { value: MockWebSocket });
});

try {
	await page.goto(`http://127.0.0.1:${server.port}/codebase-memory?cwd=${encodeURIComponent(FIXTURE_CWD)}`, { waitUntil: "networkidle0" });
	await page.waitForSelector("[data-testid='cm-graph-canvas']");
	await page.waitForFunction(() => document.body.textContent?.includes("3 nodes · 2 edges") ?? false);
	await page.locator("[data-node-id='folder:src']").click();
	await page.waitForSelector("[data-node-id='file:src/alpha.ts']");
	await page.locator("[data-node-id='file:src/alpha.ts']").click();
	await page.waitForSelector("[data-node-id='fixture.src.alpha']");
	await page.locator("[data-node-id='fixture.src.alpha']").click();
	await page.waitForFunction(() => document.body.textContent?.includes("return beta() + 1") ?? false);
	await page.setViewport({ width: 390, height: 844 });
	await page.waitForFunction(() => {
		const graph = document.querySelector("[data-testid='cm-graph-canvas']");
		const snippet = document.querySelector("pre");
		if (!graph || !snippet) return false;
		return graph.getBoundingClientRect().width > 0 && snippet.getBoundingClientRect().width > 0;
	});
	if (consoleErrors.length > 0) throw new Error(`Browser emitted console errors:\n${consoleErrors.join("\n")}`);
	console.log("Codebase Memory E2E smoke passed: graph rendered, graph node selected, detail snippet displayed.");
} finally {
	await browser.close();
	await server.stop(true);
}
