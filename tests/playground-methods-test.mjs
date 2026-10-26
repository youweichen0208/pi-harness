import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { playgroundFixture, end } from "./lib/playground-fixture.mjs";
import { CHROME_PATH } from "./lib/chrome.mjs";
const fixture = await playgroundFixture();
const { api, run } = fixture;
const value = text => ({ text: String(text) });
const testCase = (id, args, expected) => ({ id, args: args.map(value), ...(expected === undefined ? {} : { expected: value(expected) }) });
const results = events => events.filter(e => e.type === "case_result").map(e => e.result);
let browser;
try {
	await api("config", { enabled: true });
	const code = "def add(a: int, b: int) -> int:\n    return a + b\n";
	const tests = { mode: "methods", selectedMethod: "add(a,b)", casesByMethod: { "add(a,b)": [testCase("a", [1, 2], 3)] } };
	await api("scratch", { content: code, tests }, "PUT");
	await api("scratch", { content: code }, "PUT");
	assert.deepEqual((await (await api("scratch")).json()).tests, tests);
	assert.equal((await api("run", { code, tests: { methodId: "missing()", cases: [testCase("a", [])] } })).status, 400);
	assert.equal((await api("run", { code, tests: { methodId: tests.selectedMethod, cases: [testCase("a", ["bad", 2])] } })).status, 400);
	const available = (await (await api("status")).json()).python.available;
	if (available) {
		const mixed = await run(code, { methodId: tests.selectedMethod, cases: [testCase("a", [1, 2], 3), testCase("b", [3, 4], 8), testCase("c", [5, 8])] });
		assert.deepEqual(results(mixed).map(r => r.status), ["passed", "failed", "unasserted"]);
		assert.equal(end(mixed).exitCode, 1);
		for (const [source, id, args, expected] of [
			['def echo(v):\n    return v', 'echo(v)', ['{"a":[1,true,null]}'], '{"a":[1,true,null]}'],
			['def echo(v):\n    return v', 'echo(v)', ['123456789012345678901234567890'], '123456789012345678901234567890'],
			['async def echo(v: str) -> str:\n    return v', 'echo(v)', ['中文'], '中文'],
		]) assert.equal(results(await run(source, { methodId: id, cases: [testCase("a", args, expected)] }))[0].status, "passed");
		const isolated = await run('state = []\ndef f():\n    state.append(1)\n    return len(state)', { methodId: 'f()', cases: [testCase("a", [], 1), testCase("b", [], 1)] });
		assert.deepEqual(results(isolated).map(r => r.status), ["passed", "passed"]);
		const errors = await run('def f(x):\n    return 1 / x', { methodId: 'f(x)', cases: [testCase("a", [0]), testCase("b", [1], 1)] });
		assert.deepEqual(results(errors).map(r => r.status), ["error", "passed"]);
		await api("config", { timeoutMs: 1000 });
		const timeout = await run('def f():\n    while True: pass', { methodId: 'f()', cases: [testCase("a", []), testCase("b", [])] });
		assert(end(timeout).timedOut); assert.deepEqual(results(timeout).map(r => r.status), ["skipped", "skipped"]);
		await api("config", { timeoutMs: 10000 });
	}
	if (process.argv.includes("--browser")) {
		assert(available, "browser test requires Python");
		const { chromium } = await import("playwright-core");
		browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await page.goto(`${fixture.base}/?token=${fixture.token}`);
		await page.locator(".setup-modal .modal-close").click();
		await page.getByRole("button", { name: "Playground", exact: true }).click();
		await page.locator('.scratch-editor-cm .cm-content').waitFor();
		await page.locator('.scratch-head .primary').click();
		await page.waitForFunction(() => document.querySelector('.method-case')?.getAttribute('data-status') === 'passed');
		await page.locator('.scratch-head select').selectOption('program');
		const editor = page.locator('.scratch-editor-cm .cm-content');
		await editor.fill('print("Python browser works")');
		await editor.press('ControlOrMeta+a');
		await editor.press('ControlOrMeta+/');
		assert.equal(await editor.innerText(), '# print("Python browser works")', "issue #134: toggle Python line comments");
		await editor.press('ControlOrMeta+/');
		assert.equal(await editor.innerText(), 'print("Python browser works")', "toggle comments off without losing code");
		await editor.fill('print("Python browser works")\nprint("second line")');
		await editor.press('ControlOrMeta+a');
		await page.getByRole('button', { name: '注释', exact: true }).click();
		assert.equal(await editor.innerText(), '# print("Python browser works")\n# print("second line")');
		await page.getByRole('button', { name: '注释', exact: true }).click();
		assert.equal(await editor.innerText(), 'print("Python browser works")\nprint("second line")');
		await editor.press('ControlOrMeta+z');
		assert((await editor.innerText()).startsWith('# '), "comment action is undoable");
		await page.getByRole('button', { name: '注释', exact: true }).click();
		await page.locator('.scratch-head .primary').click();
		await page.locator('.playground-stream pre').filter({ hasText: 'Python browser works' }).last().waitFor();
		await page.waitForFunction(() => document.querySelector('.scratch-save-status')?.textContent?.includes('已保存'));
		await page.reload();
		await page.locator(".setup-modal .modal-close").click();
		await page.getByRole("button", { name: "Playground", exact: true }).click();
		await page.waitForFunction(() => document.querySelector('.scratch-editor-cm .cm-content')?.textContent?.includes('Python browser works'));
		assert.equal(await page.locator('.scratch-head select').inputValue(), 'program');
		await page.screenshot({ path: "/tmp/pi-python-playground-desktop.png" });
		const noteBody = '```python\nprint("note Python")\n```\n\n```java\nSystem.out.println("legacy");\n```';
		const note = (await (await fetch(`${fixture.base}/api/notes?token=${fixture.token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Python note", body: noteBody, pinned: false }) })).json()).note;
		await page.getByRole("button", { name: "小记", exact: true }).click();
		await page.locator(".note-list-item").first().click();
		await page.locator("button[data-code-run]").first().waitFor();
		assert.equal(await page.locator("button[data-code-run]").count(), 1, "only Python has a Run button");
		await page.locator("button[data-code-run]").click();
		await page.waitForFunction(() => document.querySelector('.notes-editor > .playground-result .playground-stream pre')?.textContent?.includes('note Python'));
		const after = (await (await fetch(`${fixture.base}/api/notes/${note.id}?token=${fixture.token}`)).json()).note;
		assert.equal(after.body, noteBody); assert.equal(after.version, note.version);
		await page.getByRole("button", { name: "对话", exact: true }).click();
		const onDisk = 'print("disk")';
		writeFileSync(join(fixture.root, "demo.py"), onDisk);
		await page.evaluate(() => window.dispatchEvent(new CustomEvent("pi-harness:open-tool-file", { detail: { path: "demo.py" } })));
		const fileRun = page.getByRole("button", { name: "运行编辑器中的内容（含未保存改动）" });
		await fileRun.waitFor();
		await page.locator(".fp-editor").fill('print("buffer Python")');
		await fileRun.click();
		await page.waitForFunction(() => document.querySelector('.fp .playground-result .playground-stream pre')?.textContent?.includes('buffer Python'));
		assert.equal(readFileSync(join(fixture.root, "demo.py"), "utf8"), onDisk);
		await page.getByRole("button", { name: "Playground", exact: true }).click();
		await page.setViewportSize({ width: 390, height: 844 });
		assert(await page.locator('.scratch-head .primary').isVisible());
		await page.screenshot({ path: "/tmp/pi-python-playground-mobile.png" });
		console.log("PASS Python browser: function cases, script mode, output, saved draft/mode and mobile");
	}
	console.log("PASS Python function tests: assertions, JSON, arbitrary integers, async, state isolation, exceptions, timeout and persisted cases");
} finally { await browser?.close(); await fixture.stop(); }
