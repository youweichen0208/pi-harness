// Current parameters run with the script; output stays compact and errors remain visible.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { playgroundFixture } from "./lib/playground-fixture.mjs";

const code = [
	"def add(a: int, b: int) -> int:",
	"    return a + b",
	"",
	'if __name__ == "__main__":',
	'    print("merged run")',
	"",
].join("\n");
const value = text => ({ text: String(text) });
const testCase = (id, args) => ({ id, args: args.map(value) });
const tests = { mode: "program", selectedMethod: "add(a,b)", casesByMethod: { "add(a,b)": [testCase("c1", [1, 2]), testCase("c2", [3, 4])] } };

const fixture = await playgroundFixture();
const failed = [];
let browser;
try {
	await fixture.api("config", { enabled: true });
	await fixture.api("scratch", { content: code, tests }, "PUT");
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
	const errors = [];
	page.on("pageerror", e => errors.push(e.message));
	await page.goto(`${fixture.base}/?token=${fixture.token}`);
	await page.locator(".setup-modal .modal-close").click();
	await page.getByRole("button", { name: "Playground", exact: true }).click();
	await page.locator(".scratch-editor-cm .cm-content").waitFor();

	// The mode dropdown is gone: running is no longer an either/or choice.
	assert.equal(await page.locator(".scratch-head select").count(), 0, "the run-mode dropdown is removed");

	assert.equal(await page.locator('.lc-case-tabs, .lc-case-add').count(), 0);
	assert.equal(await page.getByLabel('a', {exact:true}).inputValue(), '1');
	const requested = [];
	page.on("request", r => { if (new URL(r.url()).pathname === "/api/playground/run") requested.push(r.postDataJSON()); });
	await page.getByLabel('a', {exact:true}).fill('5');
	await page.getByLabel('b', {exact:true}).fill('6');
	await page.locator('.scratch-head .primary').click();
	await page.waitForFunction(() => document.querySelector('.scratch-output .lc-result-value pre')?.textContent === '11');
	assert.equal(requested.length, 2);
	assert.deepEqual(requested.find(body => body.tests).tests.cases.map(c => c.id), ['c1']);
	assert.equal(await page.locator('.scratch-run-block, .scratch-run-summary').count(), 0);
	assert.match(await page.locator('.scratch-output').innerText(), /运行完成/);
	assert.match(await page.locator('.scratch-output').innerText(), /merged run/);
	await page.getByRole('tab', {name:'参数',exact:true}).click();
	assert.equal(await page.getByLabel('a', {exact:true}).inputValue(), '5');
	assert.equal(await page.locator('.scratch-output').isVisible(), false, 'output is hidden on the parameters tab');
	await page.locator('.scratch-test-pane').screenshot({path:'/tmp/playground-redesign-parameters.png'});
	await page.getByLabel('a', {exact:true}).fill('bad json');
	assert.equal(await page.locator('.scratch-head .primary').isDisabled(), true);
	await page.getByLabel('a', {exact:true}).fill('7');
	await page.locator('.scratch-head .primary').click();
	await page.waitForFunction(() => document.querySelector('.scratch-output .lc-result-value pre')?.textContent === '13');
	assert.equal(await page.getByLabel('a', {exact:true}).isVisible(), false, 'parameters are hidden on the output tab');
	await page.screenshot({path:'/tmp/playground-compact.png'});
	await page.evaluate(() => { document.documentElement.dataset.theme='graphite'; document.documentElement.dataset.appearance='dark'; });
	await page.locator('.scratch-test-pane').screenshot({path:'/tmp/playground-compact-dark.png'});
	await page.setViewportSize({width:390,height:844});
	await page.locator('.scratch-test-pane').scrollIntoViewIfNeeded();
	await page.screenshot({path:'/tmp/playground-compact-narrow.png'});
	await page.locator('.scratch-editor-cm .cm-content').fill('raise ValueError("compact error")');
	await page.locator('.scratch-head .primary').click();
	await page.waitForFunction(() => document.querySelector('.scratch-output .method-validation')?.textContent?.includes('compact error'));
	await page.waitForFunction(() => document.querySelector('.scratch-output .lc-result-summary')?.textContent?.includes('运行失败'));
	if (errors.length) failed.push(`page errors: ${errors.join("; ")}`);
	assert.deepEqual(failed, []);
	console.log("PASS Playground compact run: current parameters only, validation, output and errors");
} finally {
	await browser?.close();
	await fixture.stop();
}
