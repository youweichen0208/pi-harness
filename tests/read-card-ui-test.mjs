import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 8964;
assert.equal(await portUp(port), false, `Port ${port} busy`);
const root = mkdtempSync(join(tmpdir(), 'pi-edit-live-'));
const cwd = join(root, 'workspace');
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, 'app.ts'), 'const value = "old";\n');

const running = [
 {id:'user',role:'user',content:[{type:'text',text:'Read the screenshot'}]},
 {id:'read',role:'assistant',content:[{type:'toolCall',id:'read1',name:'read',argumentsText:JSON.stringify({path:'scratch/preview.png'})}]},
 {id:'result',role:'toolResult',toolCallId:'read1',toolOutputUrl:'/api/tool-output?toolCallId=read1',content:[{type:'text',text:'Read image file [image/jpeg]\n[Image: original 3136x240, displayed at 2000x153. Multiply coordinates by 1.57 to map to original image.]'},{type:'image',dataUrl:'data:image/png;base64,' + readFileSync('build/icon.png').toString('base64')}]},
];
let server, browser, socket, baseState;

try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = '';
	server.stdout.on('data', data => log += data);
	server.stderr.on('data', data => log += data);
	for (let n = 0; n < 100 && !await portUp(port); n++) await sleep(100);
	assert(await portUp(port), log);

	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	let conversationId;
	let phaseMessages = running;

	await page.routeWebSocket('**/ws', route => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage(wire => upstream.send(wire));
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === 'snapshot') {
				conversationId = message.state.conversationId;
				baseState = { ...message.state, messages: phaseMessages, isStreaming: false, piConfigured: true };
				route.send(JSON.stringify({ ...message, state: baseState }));
				return;
			}
			// Everything after the first frame is fixture-driven.
			if (['snapshot_delta', 'tool_status', 'terminal_list'].includes(message.type)) return;
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${port}`);

	await page.locator('.process-group-summary-line').click();
	await page.locator('.toolcall-read').waitFor();
	assert.equal(await page.locator('.read-group-head,.read-file-head').count(), 0, 'single read has no redundant nested rows');
	assert.equal(await page.locator('.toolcall-read .read-download,.toolcall-read .toolcall-output').count(), 0, 'image read hides full output download and redundant notice');
	assert.equal(await page.locator('.toolcall-read .tool-image-actions a').count(), 1);
	assert.equal(await page.locator('.toolcall-read-title code').textContent(), 'scratch/preview.png');
	assert.equal(await page.locator('.toolcall-read .toolcall-read-path').count(), 0, 'path appears only in the header');
	for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
		await page.setViewportSize({width, height:1000});
		await page.evaluate(value => document.documentElement.dataset.appearance = value, theme);
		const card = page.locator('.toolcall-read');
		await card.locator('.tool-result-image img').waitFor();
		assert(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'read card fits its available width');
		await card.screenshot({path:`/tmp/pi-read-card-${theme}-${width}.png`});
	}
	await page.locator('.toolcall-read .toolcall-toggle').click();
	assert.equal(await page.locator('.toolcall-read .toolcall-body').count(), 0);
	await page.locator('.toolcall-read .toolcall-toggle').click();
	await page.locator('.toolcall-read .tool-result-image').waitFor();
	await page.locator('.toolcall-read .toolcall-expand').click();
	await page.locator('.toolcall-zoom').waitFor();
	assert.deepEqual(errors, []);
	console.log('PASS read card hierarchy, image preview, collapse, zoom, themes and narrow width');
} finally {
	await browser?.close().catch(() => {});
	server?.kill('SIGTERM');
	await sleep(300);
	rmSync(root, { recursive: true, force: true });
}
