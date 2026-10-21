/** Maintained table of contents in the Wiki editor: insert, live regeneration, removal and byte preservation. No model calls. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { testEnv } from "./lib/test-env.mjs";

const port = 9272;
assert.equal(await portUp(port), false, "isolated port must be free");
const base = realpathSync(mkdtempSync(join(tmpdir(), "wiki-toc-")));
const cwd = join(base, "workspace"), agent = join(base, "agent");
mkdirSync(agent); mkdirSync(cwd);
const filler = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.\n\n`).join("");
// Odd but valid formatting that a whole-document re-serialization would normalize.
const body = `Intro with *stars*  and   spaces.\n\n## Setup\n\n${filler}## Usage\n\n${filler}### Details\n\n* star bullet\n`;
const original = `# Guide\n\n${body}`;
const docPath = join(cwd, "guide.md");
writeFileSync(docPath, original);
const stale = "# Stale\n\n<!-- toc -->\n- [Old](#old)\n<!-- /toc -->\n\n## Fresh heading\n\nText.\n";
const stalePath = join(cwd, "stale.md");
writeFileSync(stalePath, stale);
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "unused", models: [{ id: "unused", name: "Unused local model", input: ["text"], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "unused" }));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "unused" } }));
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: "", PI_WEB_HOST: "127.0.0.1", PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
let log = "", browser;
server.stdout.on("data", data => { log += data; }); server.stderr.on("data", data => { log += data; });
const wait = async (check, label) => {
	for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
	throw new Error(`Timeout: ${label}`);
};
const tocOf = text => text.match(/<!-- toc -->[\s\S]*?<!-- \/toc -->/)?.[0];
try {
	for (let i = 0; i < 150 && !await portUp(port); i++) {
		assert.equal(server.exitCode, null, log);
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(15000);
	const errors = []; page.on("pageerror", error => errors.push(error.message));
	const writes = [];
	await page.route("**/api/wiki", async route => { const request = route.request().postDataJSON(); if (request.action === "write") writes.push(request.path); await route.continue(); });
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".conn-dot.ok").first().waitFor({ state: "attached" });
	const editor = page.locator(".wiki-prose .fp-rich-document"), toc = editor.locator(".rich-toc");
	const open = async name => { await page.locator(".file-name", { hasText: name }).first().evaluate(el => el.click()); await editor.waitFor(); };
	const close = async () => { await page.locator(".wiki-modal-header > button").last().click(); await page.locator(".wiki-document-dialog").waitFor({ state: "detached" }); };
	const caretIn = text => editor.locator("p", { hasText: text }).first().evaluate(el => { el.closest("[contenteditable]").focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });

	// A stale block is displayed fresh, but opening alone never writes the file.
	await open("stale.md");
	assert.deepEqual(await toc.locator("li").allTextContents(), ["Fresh heading"]);
	await page.waitForTimeout(1200);
	assert.deepEqual(writes, []); assert.equal(readFileSync(stalePath, "utf8"), stale);
	await close();

	// Toolbar insert: one block below the title, generated from the headings.
	await open("guide.md");
	await caretIn("Intro with");
	await page.getByRole("button", { name: "插入目录", exact: true }).click();
	const expected = "<!-- toc -->\n- [Setup](#setup)\n- [Usage](#usage)\n  - [Details](#details)\n<!-- /toc -->";
	await wait(() => readFileSync(docPath, "utf8").includes(expected), "inserted toc saved");
	assert.equal(readFileSync(docPath, "utf8"), `# Guide\n\n${expected}\n\n${body}`, "only the block is added");
	assert.deepEqual(await toc.locator("li").allTextContents(), ["Setup", "Usage", "Details"]);
	// A second insert does not duplicate the block.
	await page.getByRole("button", { name: "插入目录", exact: true }).click();
	assert.equal(await toc.count(), 1);

	// Editing a heading regenerates the block in the display and in the file.
	await editor.locator("h2", { hasText: "Usage" }).evaluate(el => { el.closest("[contenteditable]").focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
	await page.keyboard.type(" Notes");
	await wait(async () => (await toc.locator("li").allTextContents()).includes("Usage Notes"), "display follows heading");
	await wait(() => tocOf(readFileSync(docPath, "utf8"))?.includes("- [Usage Notes](#usage-notes)"), "file follows heading");

	// Links jump to the matching heading inside the editor.
	await toc.locator("a", { hasText: "Usage Notes" }).click();
	await wait(() => editor.locator("h2", { hasText: "Usage Notes" }).evaluate(el => { const top = el.getBoundingClientRect().top, box = el.closest(".wiki-scroll").getBoundingClientRect(); return top >= box.top && top < box.top + 200; }), "jump to heading");

	// Removing the block restores every other byte that was not edited.
	await toc.getByRole("button", { name: "移除目录", exact: true }).click();
	await wait(() => !readFileSync(docPath, "utf8").includes("<!-- toc -->"), "toc removed");
	assert.equal(readFileSync(docPath, "utf8"), `# Guide\n\n${body.replace("## Usage\n", "## Usage Notes\n")}`);

	// Slash menu inserts the same block.
	await caretIn("Intro with");
	await page.keyboard.press("Enter"); await page.keyboard.type("/ml");
	await page.locator(".fp-slash-menu").getByRole("option", { name: "插入目录" }).click();
	await wait(() => tocOf(readFileSync(docPath, "utf8"))?.includes("- [Usage Notes](#usage-notes)"), "slash insert saved");
	assert.equal(await toc.count(), 1);
	await close();
	assert.deepEqual(errors, []);
	console.log("PASS wiki toc: fresh display without writes, toolbar/slash insert, no duplicates, live regeneration, jump, removal and byte preservation");
} catch (error) { console.error(log.slice(-6000)); throw error; }
finally {
	await browser?.close();
	if (server.exitCode === null && server.signalCode === null) { const stopped = once(server, "exit"); server.kill(); await stopped; }
	rmSync(base, { recursive: true, force: true });
}
