import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { playgroundFixture } from "./lib/playground-fixture.mjs";
const fixture = await playgroundFixture();
let browser;
const broken = 'def add(a: int, b: int) -> int:\n    a = 1\nb = 2\n    return a + b\n\nif __name__ == "__main__":\n    print(add(2, 3))';
const fixed = broken.replace('\nb = 2', '\n    b = 2');
try {
	await fixture.api('config', { enabled: false });
	const indent = async (code, range = {}) => {
		const response = await fixture.api('indent', { code, ...range });
		assert.equal(response.status, 200, response.ok ? '' : await response.text());
		return (await response.json()).code;
	};
	assert.equal(await indent(broken), fixed);
	assert.equal(await indent(fixed), fixed, 'repeat is idempotent');
	const literal = 'def f():\n  value = """first\n    preserve these spaces\nlast"""\n  return value\nraise RuntimeError("must not execute")';
	assert.equal(await indent(literal), literal.replace('\n  value', '\n    value').replace('\n  return', '\n    return'));
	const scoped = 'def f():\n  return 1\n\ndef g():\n  return 2';
	assert.equal(await indent(scoped, { fromLine: 1, toLine: 2 }), scoped.replace('  return 1', '    return 1'));
	for (const code of ['def broken(:', 'def f():\nx=1\nreturn x', 'return 1', 'if True:\n    x=1\nif False:\n    return x']) {
		assert.equal((await fixture.api('indent', { code })).status, 422, 'ambiguous/invalid source stays unchanged');
	}
	assert.equal((await fixture.api('indent', { code: broken, fromLine: 4 })).status, 422, 'do not repair a line outside selection');
	assert.equal((await fixture.api('indent', { code: fixed, toLine: 0 })).status, 400);
	assert.equal((await fixture.api('indent', { code: fixed, extra: true })).status, 400);
	await fixture.api('scratch', { content: broken, tests: { mode: 'program', selectedMethod: '', casesByMethod: {} } }, 'PUT');
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await page.goto(`${fixture.base}/?token=${fixture.token}`);
	await page.locator('.setup-modal .modal-close').click();
	await page.getByRole('button', { name: 'Playground', exact: true }).click();
	const editor = page.locator('.scratch-editor-cm .cm-content');
	await editor.waitFor();
	const editorText = async () => (await editor.locator('.cm-line').allTextContents()).join('\n');
	const button = page.getByRole('button', { name: '自动缩进', exact: true });
	await button.click();
	await page.waitForFunction(() => document.querySelector('.cm-content')?.innerText.includes('\n    b = 2'));
	assert.equal(await editorText(), fixed);
	await editor.press('ControlOrMeta+z');
	assert.equal(await editorText(), broken, 'single undo restores exact source');
	await button.click();
	await page.waitForFunction(() => document.querySelector('.cm-content')?.innerText.includes('\n    b = 2'));
	await page.waitForFunction(() => document.querySelector('.scratch-save-status')?.textContent.includes('已保存'));
	assert.equal((await (await fixture.api('scratch')).json()).content, fixed);
	await editor.fill(scoped);
	await editor.press('ControlOrMeta+Home');
	await editor.press('Shift+ArrowDown');
	await editor.press('Shift+ArrowDown');
	await button.click();
	await page.waitForFunction(() => document.querySelector('.cm-content')?.innerText.includes('    return 1'));
	assert.equal(await editorText(), scoped.replace('  return 1', '    return 1'), 'browser selection limits indentation');
	await editor.fill('def broken(:');
	await button.click();
	await page.getByText('无法确定正确的缩进，请检查代码块结构后重试。原代码已保留。', { exact: true }).waitFor();
	assert.equal(await editorText(), 'def broken(:');
	console.log('PASS auto indent: screenshot repair, selection, normalization, strings, idempotence, no execution, invalid source, undo and save');
} finally { await browser?.close(); await fixture.stop(); }
