// Mermaid enlargement above the file modal and in Wiki must preserve source and focus.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const mindmap = process.argv.includes('--mindmap');
const port = mindmap ? 9402 : 9401;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-toc-test-'));
mkdirSync(join(base, 'agent'));
// Reconstruct the visible nodes and four edge labels from issue #178.
const diagram = mindmap ? 'mindmap\n  root((AgentRun))\n    核心定位' : [
	'flowchart LR',
	'  A["Hermes Agent<br/>触发 + 执行诊断"] -->|"build_info(engine,<br/>region)"| B["Service"]',
	'  B -->|version| A',
	'  A -->|"repo.resolve /<br/>code.search /<br/>code.read"| C["Repository"]',
	'  C -->|"commit_sha 证据"| A',
].join('\n');
const original = '# Diagram\n\n```mermaid\n' + diagram + '\n```\n';
writeFileSync(join(base, 'note.md'), original);
writeFileSync(join(base, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused', models: [{ id: 'unused', name: 'Unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'unused' }));
writeFileSync(join(base, 'agent/auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(20000);
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.locator('.setup-modal .modal-close').click({ timeout: 3000 }).catch(() => {});
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	const dialog = page.locator('.wiki-document-dialog[open]');
	await dialog.waitFor();
	const check = async (host) => {
		const code = host.locator('pre > code.language-mermaid');
		const toggle = host.locator('[data-mermaid-source]');
		await toggle.waitFor();
		const inline = host.locator('.mermaid-svg svg');
		await inline.waitFor();
		const readLabels = async svg => svg.locator('foreignObject').evaluateAll(labels => labels.map(label => {
			const br = [...label.querySelectorAll('br')];
			return {
				text: label.textContent.replace(/\s+/g, ''),
				breaks: br.length,
				height: label.getBoundingClientRect().height,
			};
		}));
		const labels = await readLabels(inline);
		if (!mindmap) {
			for (const [text, breaks] of [['HermesAgent触发+执行诊断', 1], ['build_info(engine,region)', 1], ['version', 0], ['repo.resolve/code.search/code.read', 2], ['commit_sha证据', 0]]) {
				assert(labels.some(label => label.text === text && label.breaks === breaks && label.height > 0), `expected visible label ${text}: ${JSON.stringify(labels)}`);
			}
		}

		await host.locator('.mermaid-svg').click();
		assert.equal(await page.locator('.mermaid-zoom-dialog[open]').count(), 1, 'clicking the diagram opens an enlarged view');
		const zoom = page.locator('.mermaid-zoom-dialog[open]');
		const image = zoom.locator('.mermaid-zoom-content > svg');
		assert.equal(await image.isVisible(), true);
		const stage = zoom.locator('.mermaid-zoom-stage');
		const stageBox = await stage.boundingBox();
		assert(stageBox.height <= (await image.boundingBox()).height + 33, 'short diagrams leave only the stage padding below and above the SVG');
		assert.deepEqual(await zoom.locator('parsererror').allTextContents(), [], 'the enlarged SVG must be free of XML errors');
		if (!mindmap) {
			const expanded = await readLabels(image);
			assert(expanded.every(label => label.height > 0), 'all labels remain visible after expansion');
			const content = entries => entries.map(({ text, breaks }) => ({ text, breaks }));
			assert.deepEqual(content(expanded), content(labels), 'the enlarged chart preserves node and edge labels and every line break');
			const arrows = await image.evaluate(svg => [...svg.querySelectorAll('path[marker-end]')].map(path => {
				const ref = path.getAttribute('marker-end');
				const id = /#([^)]*)\)/.exec(ref)?.[1];
				return !!id && svg.getElementById(id)?.localName === 'marker';
			}));
			assert(arrows.length === 4 && arrows.every(Boolean), 'all four arrows reference markers inside the enlarged diagram');
		}
		await page.screenshot({ path: `/tmp/pi-mermaid-zoom-${mindmap ? 'mindmap' : 'flowchart'}.png` });
		const width = (await image.boundingBox()).width;
		await zoom.getByRole('button', { name: '放大', exact: true }).click();
		assert((await image.boundingBox()).width > width, 'zoom increases diagram size');
		assert(await stage.evaluate(element => element.scrollWidth > element.clientWidth), 'enlarged diagram can scroll horizontally');
		const x = stageBox.x + stageBox.width / 2;
		const y = stageBox.y + stageBox.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x - 160, y, { steps: 4 });
		await page.mouse.up();
		assert(await stage.evaluate(element => element.scrollLeft >= 150), 'dragging left reveals the right side');
		await page.mouse.move(x, y);
		assert(await stage.evaluate(element => element.scrollLeft >= 150), 'releasing the mouse ends panning');
		await page.keyboard.press('Escape');
		assert.equal(await zoom.count(), 0, 'Escape closes only the diagram');
		assert.equal(await host.isVisible(), true, 'document remains open');
		assert.equal(await code.isVisible(), false, 'opening the diagram does not unfold source');
		await host.locator('.mermaid-svg').focus();
		await page.keyboard.press('Enter');
		assert.equal(await zoom.count(), 1, 'keyboard opens viewer');
		await zoom.getByRole('button', { name: '关闭', exact: true }).click();
		assert.equal(await code.isVisible(), false, 'Mermaid source defaults to collapsed');
		await toggle.click();
		assert.equal(await code.isVisible(), true, 'click expands source');
		await toggle.click();
		assert.equal(await code.isVisible(), false, 'click collapses source');
		await toggle.focus(); await toggle.press('Enter');
		assert.equal(await code.isVisible(), true, 'keyboard expands source');
		await toggle.press('Space');
		assert.equal(await code.isVisible(), false, 'keyboard collapses source');
		await page.keyboard.press('ControlOrMeta+s');
		await sleep(1000);
		assert.equal((await import('node:fs')).readFileSync(join(base, 'note.md'), 'utf8'), original, 'folding does not change saved Markdown');
	};
	await check(dialog);
	await page.goto(`http://127.0.0.1:${port}/?wiki-window=1&cwd=${encodeURIComponent(base)}&doc=note.md`);
	await check(page.locator('.wiki-workbench'));
	console.log('PASS Mermaid opens above file/Wiki hosts, zooms, closes independently, supports keyboard and preserves Markdown');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	await sleep(300);
	try { rmSync(base, { recursive: true, force: true }); } catch {}
}
