// macOS must release its native fullscreen Space before hiding to the tray.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { testEnv } from './lib/test-env.mjs';
if (process.platform !== 'darwin') { console.log('SKIP macOS native fullscreen'); process.exit(0); }
const base = mkdtempSync(join(tmpdir(), 'pi-fullscreen-close-'));
let app;
try {
	app = await electron.launch({ args: ['.', `--user-data-dir=${join(base, 'profile')}`], env: { ...testEnv(), PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') } });
	let page;
	for (let i = 0; i < 200; i++) { page = app.windows().find(p => p.url().startsWith('http://127.0.0.1:')); if (page) break; await sleep(100); }
	assert(page, 'main window loaded');
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await app.evaluate(async ({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:'));
		globalThis.closeTrace = [];
		win.once('leave-full-screen', () => globalThis.closeTrace.push('leave'));
		// AppKit itself emits hide while moving between Spaces; record the app's
		// explicit hide call, which must wait for the native leave event.
		if (!win.__originalHide) {
			win.__originalHide = win.hide.bind(win);
			win.hide = () => { globalThis.closeTrace.push(win.isFullScreen() ? 'hide-fullscreen' : 'hide'); win.__originalHide(); };
		}
		await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Native fullscreen entry timed out')), 10000); win.once('enter-full-screen', () => { clearTimeout(timer); resolve(); }); win.setFullScreen(true); });
		win.close();
		win.close();
	});
	let state;
	for (let i = 0; i < 100; i++) {
		state = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:')); return { visible: w.isVisible(), fullscreen: w.isFullScreen(), trace: globalThis.closeTrace }; });
		if (!state.visible && state.trace.some(e => e.startsWith('hide'))) break;
		await sleep(100);
	}
	assert.equal(state.visible, false, 'close hides main window');
	assert.equal(state.fullscreen, false, `hidden window must not retain a fullscreen Space: ${JSON.stringify(state.trace)}`);
	assert.deepEqual(state.trace, ['leave', 'hide'], 'exit fullscreen before hiding');
	await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:')); w.show(); });
	assert(await page.locator('body').isVisible(), 'window can be reopened');
	console.log('PASS macOS fullscreen close exits the Space before hiding and reopens');
} finally { await app?.close(); rmSync(base, { recursive: true, force: true }); }
