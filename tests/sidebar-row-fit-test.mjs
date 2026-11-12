// Sidebar rows must fit their own content.
//
// Regression: `.compact-navigation` pinned every nav row to `height: 32px`,
// which cropped two-line rows — a title plus its branch note needed ~37px, so
// the note's descenders were cut and `scrollHeight` exceeded `clientHeight`.
// The same rules also left the timestamp competing with the title for width.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-sidebar-"));
const dataDir = join(root, "data");
const cwd = join(root, "workspace");
mkdirSync(dataDir);
mkdirSync(cwd);
writeFileSync(join(cwd, "a.txt"), "a");

// Sessions are read from the agent directory in the SDK's own format, so this
// test points at a project that already has history rather than fabricating it.
// The sidebar can only be measured against real history: projects come from the
// saved client state and sessions from the agent directory, both in formats this
// test must not fabricate. Point PI_TEST_DATA_DIR / PI_TEST_AGENT_DIR at any
// install to run it; without history the test reports a skip.
const AGENT_DIR = process.env.PI_TEST_AGENT_DIR || join(homedir(), ".pi", "agent");
const SESSION_CWD = process.env.PI_TEST_SESSION_CWD || REPO_ROOT;
const REAL_STATE = process.env.PI_TEST_DATA_DIR || join(homedir(), ".pi-web");

const harness = await startIsolatedHarness({ env: { PI_WEB_CWD: SESSION_CWD, PI_WEB_DATA_DIR: REAL_STATE, PI_CODING_AGENT_DIR: AGENT_DIR } });
const failed = [];
let browser;
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
	const errors = [];
	page.on("pageerror", e => errors.push(e.message));
	await page.goto(`http://127.0.0.1:${harness.port}`);
	const setup = page.locator(".setup-modal .modal-close");
	if (await setup.count()) await setup.click();
	await page.locator(".panel-left").waitFor();
	// The active project starts expanded; its sessions are what this measures.
	await page.waitForTimeout(2500);
	await page.waitForSelector(".session-item", { timeout: 15000 }).catch(() => {});

	const geom = await page.evaluate(() => {
		const panel = document.querySelector(".panel-left");
		const rect = panel.getBoundingClientRect();
		const rows = [...document.querySelectorAll(".session-item")].map(el => {
			const box = el.getBoundingClientRect();
			const info = el.querySelector(".session-info");
			const title = el.querySelector(".session-title");
			const time = el.querySelector(".session-time");
			const cs = getComputedStyle(el);
			return {
				height: +box.height.toFixed(1),
				width: +box.width.toFixed(1),
				right: +box.right.toFixed(1),
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				overflowY: cs.overflowY,
				infoScroll: info?.scrollHeight ?? 0,
				infoClient: info?.clientHeight ?? 0,
				titleWidth: title ? +title.getBoundingClientRect().width.toFixed(1) : 0,
				hasNote: !!el.querySelector(".session-info small"),
				timeWidth: time ? +time.getBoundingClientRect().width.toFixed(1) : 0,
			};
		});
		const projects = [...document.querySelectorAll(".project-item")].map(el => {
			const box = el.getBoundingClientRect();
			return { height: +box.height.toFixed(1), right: +box.right.toFixed(1) };
		});
		return { panelWidth: +rect.width.toFixed(1), panelRight: +rect.right.toFixed(1), rows, projects, docScrollX: document.documentElement.scrollWidth > innerWidth };
	});

	if (!geom.rows.length) {
		const dump = await page.evaluate(() => ({
			url: location.href,
			left: document.querySelector(".panel-left")?.innerText?.slice(0, 300),
			setup: !!document.querySelector(".setup-modal"),
			empty: document.querySelector(".panel-empty")?.textContent,
		}));
		console.log("DUMP", JSON.stringify(dump, null, 1));
	}
	assert(geom.rows.length > 0, "the fixture must render at least one session row");

	for (const [index, row] of geom.rows.entries()) {
		// The row must not clip its own content, and must not be taller than it needs.
		if (row.scrollHeight > row.clientHeight + 1) {
			failed.push(`session row ${index + 1} clips its content: scrollHeight ${row.scrollHeight} > clientHeight ${row.clientHeight}`);
		}
		if (row.infoScroll > row.infoClient + 1) {
			failed.push(`session row ${index + 1} clips its info block: ${row.infoScroll} > ${row.infoClient}`);
		}
		// A row carrying a second line needs more height than a single-line row.
		if (row.hasNote && row.height < 38) {
			failed.push(`two-line session row ${index + 1} is only ${row.height}px tall`);
		}
		// Rows stay inside the panel; a long title must not widen the row.
		if (row.right > geom.panelRight + 0.5) {
			failed.push(`session row ${index + 1} overflows the panel: right ${row.right} > ${geom.panelRight}`);
		}
		// The title keeps a usable measure instead of collapsing behind the timestamp.
		if (row.titleWidth < 90) {
			failed.push(`session row ${index + 1} leaves the title only ${row.titleWidth}px`);
		}
	}
	for (const [index, row] of geom.projects.entries()) {
		if (row.right > geom.panelRight + 0.5) failed.push(`project row ${index + 1} overflows the panel: right ${row.right} > ${geom.panelRight}`);
	}
	if (geom.docScrollX) failed.push("the panel causes horizontal page scrolling");
	assert.deepEqual(failed, [], `sidebar geometry:\n${failed.join("\n")}`);
	assert.deepEqual(errors, []);
	console.log(`PASS sidebar rows fit their content: ${geom.rows.length} session row(s), none clipped, titles keep ≥90px`);
} finally {
	await browser?.close();
	await harness.stop();
	rmSync(root, { recursive: true, force: true });
}
