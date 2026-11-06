/** #149: foreign workspace paths reach the shared viewer without file reads. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
const root = mkdtempSync(join(tmpdir(), 'pi-external-preview-'));
let server, browser;
try {
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	for (const lang of ['zh', 'en']) {
		for (const [cwd, path, outside, fullPath] of [
			['D:\\projA', 'D:\\projB\\docs\\CONTEXT.md', true, 'D:\\projB\\docs\\CONTEXT.md'],
			['D:\\projA', '..\\projB\\CONTEXT.md', true, 'D:\\projB\\CONTEXT.md'],
			['/work/projA', '/work/projB/CONTEXT.md', true, '/work/projB/CONTEXT.md'],
			['D:\\projA', 'd:/PROJA/docs/CONTEXT.md', false],
			['/work/projA', '/work/projA/docs/CONTEXT.md', false],
			['/work/projA', 'docs/CONTEXT.md', false],
		]) {
			const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
			page.setDefaultTimeout(10000);
			await page.addInitScript(lang => localStorage.setItem('pi-harness:lang', lang), lang);
			const reads = [];
			await page.routeWebSocket('**/ws', route => {
				const upstream = route.connectToServer();
				route.onMessage(raw => {
					const message = JSON.parse(String(raw));
					if (message.type === 'prompt') throw Error('No model calls allowed');
					if (message.type === 'read_file') {
						reads.push(message);
						route.send(JSON.stringify({ ...message, type: 'file_content', cwd, path, name: 'CONTEXT.md', kind: 'text', text: '# Inside workspace', version: 'fixture', size: 18, lines: 1, binary: false, truncated: false }));
						return;
					}
					if (message.type === 'list_files') { route.send(JSON.stringify({ type: 'files', cwd, path: '', parent: null, truncated: false, entries: [{ path, name: 'CONTEXT.md', type: 'file' }] })); return; }
					upstream.send(raw);
				});
				upstream.onMessage(raw => {
					const message = JSON.parse(String(raw));
					if (message.type === 'snapshot') Object.assign(message.state, { cwd, piConfigured: true });
					if (message.type !== 'snapshot_delta' && message.type !== 'files') route.send(JSON.stringify(message));
				});
			});
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.locator('button.file-name', { hasText: 'CONTEXT.md' }).click();
			const viewer = page.locator('.fp');
			await viewer.waitFor();
			if (outside) {
				assert.equal(await viewer.locator('.fp-file-path').innerText(), fullPath, 'external path must not be prefixed with projA');
				assert.equal(reads.length, 0, 'preflight must avoid impossible reads');
				for (const button of await viewer.locator('.fp-view-switch button').all()) assert(await button.isDisabled());
				assert.equal(await viewer.locator('.fp-view-switch button').count(), 2);
				assert.match(await viewer.innerText(), lang === 'zh' ? /文件在会话工作区之外，无法预览/ : /outside the session workspace/);
				assert.equal(await viewer.getByRole('button', { name: lang === 'zh' ? '重新读取' : 'Reload', exact: true }).count(), 0);
			} else {
				await viewer.locator('.fp-markdown h1').waitFor();
				assert.equal(reads.length, 1);
				assert.equal(await viewer.locator('.fp-file-path').innerText(), 'projA / docs / CONTEXT.md');
				for (const button of await viewer.locator('.fp-view-switch button').all()) assert(await button.isEnabled());
			}
			await viewer.locator('.fp-reference').click();
			await page.locator('.attach-chip.reference').waitFor();
			assert.match(await page.locator('.attach-chip.reference').innerText(), /CONTEXT.md/);
			await page.close();
			console.log(`PASS ${lang}: ${path} (${outside ? "blocked" : "previewable"}), reference available`);
		}
	}
} finally { await browser?.close(); await server?.stop(); rmSync(root, { recursive: true, force: true }); }
