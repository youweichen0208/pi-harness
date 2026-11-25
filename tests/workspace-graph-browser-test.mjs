/** Real workspace catalog, Graph HTTP endpoint and browser; no model is configured. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = await mkdtemp(join(tmpdir(), "workspace-graph-ui-"));
const data = join(root, "data"), repo = join(root, "consumer"), supplier = join(root, "supplier");
const agent = join(root, "config"), other = join(root, "external"), library = join(root, "library");
const actualCorpus = process.argv.includes("--real-corpus");
let server, browser;
try {
	for (const dir of [repo, data, agent, other, library, supplier]) await mkdir(dir);
	await writeFile(join(supplier, "keep.ts"), 'export { helper } from "./helper.js";\n');
	await writeFile(join(supplier, "helper.ts"), 'export const helper = true;\n');
	await writeFile(join(repo, "entry.ts"), 'import { value } from "./source.js";\nexport const read = () => value;\n');
	await writeFile(join(repo, "source.ts"), 'export const value = 42;\n');
	await writeFile(join(data, "knowledge-library.json"), JSON.stringify({ cwd: library, path: "design.md" }));
	if (actualCorpus) await cp(".scratch/graph-eval/samples", join(root, "pinned"), { recursive: true });
	await writeFile(join(data, "project-workspaces.json"), JSON.stringify({ revision: 1, workspaces: [
		{ id: "main", name: "Product", paths: [repo, supplier] },
		{ id: "empty", name: "Empty", paths: [] },
		...(actualCorpus ? [{ id: "pinned", name: "SDK + Harness", paths: [join(root, "pinned/sdk"), join(root, "pinned/harness")] }] : []),
	] }));
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: other, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
	page.setDefaultTimeout(18000);
	const faults = [], commands = [], requests = [];
	page.on("pageerror", e => faults.push(e.message));
	page.on("websocket", ws => ws.on("framesent", frame => {
		try { commands.push(JSON.parse(String(frame.payload)).type); } catch { /* heartbeat */ }
	}));
	page.on("request", req => { if (req.url().includes("/api/workspace-graph")) requests.push(req.postDataJSON()); });
	await page.addInitScript(() => { localStorage.setItem("pi-harness:lang", "en"); });
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.locator(".conn-dot.ok").first().waitFor({ state: "attached" });
	const setup = page.locator(".setup-modal .modal-close");
	await setup.waitFor({ timeout: 2500 }).catch(() => {});
	if (await setup.isVisible()) await setup.click();
	const tab = page.getByRole("tab", { name: "Graph", exact: true });
	await tab.click();
	const panel = page.locator(".wg");
	for (const button of await page.locator(".notices-overlay .notice-close").all()) await button.click();
	const picker = panel.getByRole("combobox", { name: "Choose workspace" });
	await picker.waitFor();
	assert.equal(await picker.inputValue(), "", "multiple groups need an explicit selection");
	assert.equal(await page.evaluate(() => localStorage.getItem("pi-harness:project-workspace")), null);
	assert.equal(requests.length, 0);
	await picker.selectOption("main");
	await panel.getByText("Not indexed", { exact: true }).waitFor();
	await panel.getByRole("button", { name: "Build graph", exact: true }).click();
	await panel.getByText("Ready", { exact: true }).waitFor();
	await panel.locator(".wg-nav").getByRole("button", { name: "consumer", exact: true }).click();
	const relation = panel.locator(".wg-relations button").filter({ hasText: "imports" }).first();
	await relation.click();
	await panel.locator(".wg-excerpt pre").nth(1).waitFor();
	assert.match(await panel.locator(".wg-excerpt").first().innerText(), /from "\.\/source.js"/);
	assert.match(await panel.locator(".wg-excerpt").last().innerText(), /value = 42/);

	const diagram = panel.locator(".wg-plot");
	await diagram.getByRole("button", { name: "entry.ts", exact: true }).focus();
	await page.keyboard.press("Enter");
	await panel.getByRole("button", { name: "Set as path start" }).click();
	await diagram.getByRole("button", { name: "source.ts", exact: true }).click();
	await panel.getByRole("button", { name: "Impact analysis" }).click();
	await panel.getByRole("heading", { name: "Impact analysis" }).waitFor();
	await relation.waitFor();
	await panel.getByRole("button", { name: "Find path here" }).click();
	await panel.getByRole("heading", { name: "Directed path" }).waitFor();
	await relation.waitFor();

	const checked = await page.evaluate(async () => (await fetch("/api/workspace-graph", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ workspaceId: "main", request: { op: "graph_status" } }),
	})).json());
	// Hold an updating lifecycle with a real, already-published version.
	// Relationship reads still hit the real service while management is disabled.
	const duringUpdate = async route => {
		if (route.request().postDataJSON().request.op === "graph_status") {
			await route.fulfill({ json: { ...checked, state: "updating" } });
		} else await route.continue();
	};
	await page.route("**/api/workspace-graph*", duringUpdate);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await panel.getByText("Updating", { exact: true }).waitFor();
	assert(await panel.getByRole("button", { name: "Update graph" }).isDisabled());
	await panel.getByRole("textbox", { name: "Search modules or symbols" }).fill("entry.ts");
	await panel.getByRole("button", { name: "Search graph", exact: true }).click();
	await relation.click();
	await panel.locator(".wg-excerpt pre").nth(1).waitFor();
	await page.unroute("**/api/workspace-graph*", duringUpdate);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await panel.getByText("Ready", { exact: true }).waitFor();
	const sourceId = checked.sources.find(item => item.name === "consumer").id;
	const hash = createHash("sha256").update("export const value = 42;\n").digest("hex");
	await writeFile(join(library, "design.md"), [
		"---", "sources:", "  - sourceId: " + sourceId, "    path: source.ts", '    lines: "1"', "    sha256: " + hash,
		"  - sourceId: excluded", "    path: private-path.ts", "---", "# Design", "",
	].join("\n"));
	assert(!requests.some(entry => entry.request.op === "graph_document"));
	await panel.locator(".wg-doc-review summary").click();
	await panel.getByLabel("Path in the knowledge library").fill("design.md");
	await panel.getByRole("button", { name: "Check references" }).click();
	await panel.locator(".wg-doc-refs").getByText("Verified", { exact: true }).waitFor();
	await panel.locator(".wg-doc-refs").getByText("Unavailable", { exact: true }).waitFor();
	assert(!((await panel.locator(".wg-doc-refs").innerText()).includes("private-path")));
	assert(await panel.locator(".wg-doc-refs time").getAttribute("datetime"));
	await panel.getByRole("button", { name: "Recheck references" }).click();
	await panel.getByRole("button", { name: "Locate in graph" }).click();
	await panel.getByRole("heading", { name: "Neighbors" }).waitFor();
	await panel.getByRole("heading", { name: "source.ts", exact: true }).waitFor();
	await panel.getByRole("textbox", { name: "Search modules or symbols" }).fill("nonexistent-name");
	await panel.getByRole("button", { name: "Search graph", exact: true }).click();
	await panel.getByText("No matching nodes or relationships.").waitFor();

	await writeFile(join(repo, "source.ts"), "export const value = 43;\n");
	await panel.getByRole("button", { name: "Refresh status" }).click();
	await panel.getByText("Update needed", { exact: true }).waitFor();
	await panel.getByRole("button", { name: "Update graph" }).click();
	await panel.getByText("Ready", { exact: true }).waitFor();
	await panel.locator(".wg-nav").getByRole("button", { name: "consumer", exact: true }).click();
	await relation.click();
	await panel.locator(".wg-excerpt pre").getByText("export const value = 43;", { exact: false }).first().waitFor();

	await panel.locator(".wg-doc-review summary").click();
	await panel.getByLabel("Path in the knowledge library").fill("design.md");
	await panel.getByRole("button", { name: "Check references" }).click();
	await panel.locator(".wg-doc-refs").getByText("Stale", { exact: true }).waitFor();

	// An update from another entry point should refresh this open view. Exercise
	// the focus check independently of the toolbar's status/update actions.
	await writeFile(join(repo, "fresh.ts"), 'export const fresh = 1;\n');
	await page.evaluate(async () => {
		const req = op => fetch("/api/workspace-graph", { method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ workspaceId: "main", request: { op } }) }).then(res => res.json());
		await req("graph_update");
		for (let i = 0; i < 60; i++) {
			if ((await req("graph_status")).state === "ready") { window.dispatchEvent(new Event("focus")); return; }
			await new Promise(r => setTimeout(r, 150));
		}
		throw Error("Remote fixture update did not publish");
	});
	await panel.locator(".wg-plot").getByRole("button", { name: "fresh.ts" }).waitFor();
	// Hold an old view's result until after switching groups. Neither that result
	// nor old evidence may populate the empty workspace.
	let entered, resume;
	const intercepted = new Promise(resolve => { entered = resolve; });
	const release = new Promise(resolve => { resume = resolve; });
	await page.route("**/api/workspace-graph*", async route => {
		const { request } = route.request().postDataJSON();
		if (request.query === "held-request") {
			entered();
			await release;
			await route.fulfill({ json: { workspaceId: "main", state: "ready", sources: [],
				nodes: [{ id: "stale", sourceId: "old", kind: "symbol", label: "OLD RESULT" }], edges: [] } }).catch(() => {});
		} else await route.continue();
	});
	await panel.getByRole("textbox", { name: "Search modules or symbols" }).fill("held-request");
	await panel.getByRole("button", { name: "Search graph", exact: true }).click();
	await intercepted;
	await panel.getByRole("combobox", { name: "Choose workspace" }).selectOption("empty");
	resume();
	await panel.getByText("This workspace has no projects yet.").waitFor();
	assert.equal(await panel.getByText("OLD RESULT").count(), 0);
	assert.equal(await panel.locator(".wg-excerpt").count(), 0);
	await panel.getByRole("combobox", { name: "Choose workspace" }).selectOption("main");
	await page.setViewportSize({ width: 390, height: 844 });
	await panel.locator(".wg-nav").getByRole("button", { name: "consumer", exact: true }).click();
	await relation.click();
	await panel.locator(".wg-excerpt pre").nth(1).scrollIntoViewIfNeeded();
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
	// A is stale first. While the publication/version and aggregate status stay
	// stale, B changing must invalidate B's displayed relation and excerpts.
	const supplierButton = panel.locator(".wg-nav").getByRole("button", { name: "supplier", exact: true });
	await supplierButton.click();
	const supplierEdge = panel.locator(".wg-relations button").filter({ hasText: "keep.ts" });
	await supplierEdge.click();
	await panel.locator(".wg-excerpt pre").nth(1).waitFor();
	await writeFile(join(repo, "fresh.ts"), 'export const fresh = 2;\n');
	await panel.getByRole("button", { name: "Refresh status" }).click();
	await panel.getByText("Update needed", { exact: true }).waitFor();
	await panel.locator(".wg-excerpt").first().waitFor({ state: "detached" });
	await supplierEdge.click();
	await panel.locator(".wg-excerpt pre").nth(1).waitFor();
	await writeFile(join(supplier, "helper.ts"), 'export const helper = false;\n');
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await supplierEdge.waitFor({ state: "detached" });
	assert.equal(await panel.locator(".wg-excerpt").count(), 0);
	if (actualCorpus) {
		await page.setViewportSize({ width: 1360, height: 900 });
		await panel.getByRole("combobox", { name: "Choose workspace" }).selectOption("pinned");
		await panel.getByRole("button", { name: "Build graph" }).click();
		const flow = panel.locator(".wg-relations button").filter({ has: page.getByText("agent_settled → conv.lastTaskEndedAt", { exact: true }) });
		await flow.first().waitFor();
		assert.equal(await flow.count(), 1, "one repository projection per proof");
		await flow.first().click();
		await panel.locator(".wg-excerpt").first().getByText('this._emit({ type: "agent_settled", aborted });', { exact: false }).first().waitFor();
		await panel.locator(".wg-excerpt").last().getByText("conv.lastTaskEndedAt = Date.now();", { exact: false }).first().waitFor();
		if (process.argv.includes("--screenshots")) {
			await mkdir(".scratch/graph-eval/screenshots", { recursive: true });
			const dismiss = page.locator(".notices-overlay .notice-close");
			for (const button of await dismiss.all()) await button.click();
			await page.screenshot({ path: ".scratch/graph-eval/screenshots/graph-desktop.png", animations: "disabled" });
			await page.setViewportSize({ width: 390, height: 844 });
			await page.waitForFunction(() => matchMedia("(max-width: 820px)").matches && document.querySelector(".wg-body")?.clientWidth <= 390);
			await page.screenshot({ path: ".scratch/graph-eval/screenshots/graph-mobile.png", fullPage: true, animations: "disabled" });
		}
	}
	for (const op of ["graph_impact", "graph_document", "graph_status", "graph_build", "graph_update", "graph_search", "graph_neighbors", "graph_path", "graph_evidence"]) assert(requests.some(entry => entry.request.op === op), op);
	assert(!commands.includes("set_cwd") && !commands.includes("prompt"), JSON.stringify(commands));
	assert.deepEqual(faults, []);
	console.log("PASS workspace Graph selection, build, path, two-end evidence, impact, document review, update, external refresh, workspace race and narrow layout");
} finally {
	await browser?.close();
	await server?.stop();
	await rm(root, { recursive: true, force: true });
}
