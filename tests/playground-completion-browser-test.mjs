/** Real Jedi completions rendered by CodeMirror; optional existing app tools are read-only. */
import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { playgroundFixture } from "./lib/playground-fixture.mjs";
const fixture = await playgroundFixture({ PI_WEB_PYTHON: process.env.PI_WEB_PYTHON });
if (process.env.PI_TEST_PYTHON_TOOLS) symlinkSync(process.env.PI_TEST_PYTHON_TOOLS, join(fixture.dataDir, "python-tools"), "dir");
let browser;
try {
	await fixture.api("scratch", { content: 'a = "1"\na', tests: { mode: "program", selectedMethod: "", casesByMethod: {} } }, "PUT");
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await page.goto(`${fixture.base}/?token=${fixture.token}`);
	await page.locator(".setup-modal .modal-close").click();
	await page.getByRole("button", { name: "Playground", exact: true }).click();
	const editor = page.locator('.scratch-editor-cm .cm-content');
	await editor.waitFor();
	await editor.press('ControlOrMeta+End');
	await editor.press('.');
	const options = page.locator('.cm-tooltip-autocomplete .cm-completionLabel');
	await options.first().waitFor();
	const labels = await options.allTextContents();
	console.log('First completions:', labels.slice(0, 8));
	assert(labels.every(name => !name.startsWith('_')), 'a. only shows public string members');
	await editor.press('Escape');
	await page.keyboard.insertText('split');
	await page.locator('.cm-completionLabel').filter({ hasText: /^split$/ }).waitFor();
	await editor.press('Tab');
	assert.match(await editor.innerText(), /a\.split$/);
	await editor.press('(');
	await page.locator('.scratch-signature').filter({ hasText: 'split' }).waitFor();
	// Original screenshot: reassignment inside an int-annotated function.
	await editor.fill('def add(a: int, b: int) -> int:\n    a = "1"\n    a');
	await editor.press('ControlOrMeta+End');
	await editor.press('.');
	await options.first().waitFor();
	assert(!(await options.first().innerText()).startsWith('_'));
	await editor.press('Escape');
	await page.keyboard.insertText('sp');
	await page.locator('.cm-completionLabel').filter({ hasText: /^split$/ }).waitFor();
	for (const prefix of ['_', '__']) {
		await editor.press('Escape');
		await editor.fill(`a = "1"\na.${prefix}`);
		await editor.press('ControlOrMeta+End');
		const response = page.waitForResponse(response => response.url().includes('/api/playground/language') && response.request().postDataJSON()?.action === 'completion' && response.request().postDataJSON()?.code === `a = "1"\na.${prefix}`);
		await editor.press('Control+Space');
		assert.equal((await response).status(), 200);
		await page.waitForTimeout(200);
		assert.equal(await options.count(), 0, 'explicit underscore input does not show internal members');
	}
	console.log('PASS public-only completions, prefix filtering, Tab insertion, signatures and hidden underscore members');
} finally { await browser?.close(); await fixture.stop(); }
