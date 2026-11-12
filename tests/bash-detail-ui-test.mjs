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

const port = 8965;
assert.equal(await portUp(port), false, `Port ${port} busy`);
const root = mkdtempSync(join(tmpdir(), 'pi-edit-live-'));
const cwd = join(root, 'workspace');
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, 'app.ts'), 'const value = "old";\n');

const command = "python3 - <<'PY'\n" + Array.from({length:12},(_,i)=>`print(${i})`).join('\n') + '\nPY';
const running = [
 {id:'user',role:'user',content:[{type:'text',text:'Run the script'}]},
 {id:'bash',role:'assistant',content:[{type:'toolCall',id:'bash1',name:'bash',argumentsText:JSON.stringify({command})}]},
 {id:'result',role:'toolResult',toolCallId:'bash1',content:[{type:'text',text:Array.from({length:20},(_,i)=>i === 0 ? ' web/src/styles.css | 208 +++++---' : i === 1 ? ' 2 files changed, 196 insertions(+), 34 deletions(-)' : i === 2 ? 'AssertionError [ERR_ASSERTION]: expected true' : i === 3 ? '    at file:///tmp/test.mjs:91:2' : `output ${i} ${'long-output '.repeat(20)}`).join('\n')}],details:{exitCode:0}},
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

	await page.locator('.bash-row-head').click();
	const card = page.locator('.bash-row-body');
	await card.waitFor();
	assert(await card.locator('.bash-syntax [class^=hljs]').count() > 0);
	assert.equal(await card.locator('.bash-numbered-line').first().locator('code').textContent(), ' web/src/styles.css | 208 +++++---');
	assert(await card.locator('.bash-color-add').count() > 0);
	assert(await card.locator('.bash-color-delete').count() > 0);
	assert.equal(await card.locator('.bash-output-count,.bash-numbered-line > span,.bash-color-path').count(), 0);
	assert.equal(await card.locator('.bash-numbered-line.error').count(), 1);
	assert.equal((await card.locator('.bash-full-command').textContent()).split('\n').length, 6);
	await card.locator('.bash-detail-heading button[aria-expanded]').click();
	assert.equal(await card.locator('.bash-full-command').textContent(), command);
	await card.locator('.bash-detail-heading button[aria-expanded]').click();
	assert.equal((await card.locator('.bash-full-command').textContent()).split('\n').length, 6);
	assert.equal(await card.locator('.bash-numbered-line').count(), 6);
	await card.locator(':scope > .bash-group-more').click();
	assert.equal(await card.locator('.bash-numbered-line').count(), 20);
	for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
		await page.setViewportSize({width, height:1000});
		await page.evaluate(value => document.documentElement.dataset.appearance = value, theme);
		assert(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
		await card.screenshot({path:`/tmp/pi-bash-detail-${theme}-${width}.png`});
	}
	const wrap = card.locator('button[aria-pressed]');
	assert.equal(await wrap.getAttribute('aria-pressed'), 'true');
	assert(await card.locator('.bash-numbered-output').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
	await wrap.click();
	assert(await card.locator('.bash-numbered-output').evaluate(el => el.scrollWidth > el.clientWidth));
	await wrap.click();
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pi:reveal-tool',{detail:{toolCallId:'bash1',search:true}})));
	await page.waitForFunction(expected => document.querySelector('.bash-full-command')?.textContent === expected, command);
	assert.equal(await card.locator('.bash-full-command').textContent(), command);
	for (const [cmd, text, kind] of [
		['rg -n "目录" docs/a.md', '3:正文 **强调**\n7:第二条', 'search'],
		["python3 - <<'PY'\nprint('css ok')\nPY\nrg -n x src/a.ts", 'css ok\n299:const x = 1;', 'mixed'],
		['cat src/a.ts', 'const value = "hello";', 'code'],
		['cat README.md', '# Heading\n\nReadable **document**', 'markdown'],
		['curl localhost', '{"id":9007199254740993,"items":[1,2,3]}', 'json'],
	]) {
		const messages = structuredClone(running);
		messages[1].content[0].argumentsText = JSON.stringify({ command: cmd });
		messages[2].content[0].text = text;
		socket.send(JSON.stringify({type:'snapshot',state:{...baseState,messages}}));
		const formatted = card.locator('.bash-formatted-output');
		await formatted.waitFor();
		if (kind === 'search') assert.equal(await formatted.locator('.bash-search-result').count(), 2);
		if (kind === 'mixed') { assert.equal(await formatted.locator('.bash-mixed-log pre').textContent(), 'css ok\n'); assert.equal(await formatted.locator('.bash-search-result').count(), 1); }
		if (kind === 'markdown') assert.equal(await formatted.locator('h1').textContent(), 'Heading');
		assert.equal(await card.getByRole('button', {name:'原始输出', exact:true}).count(), 0);
		assert.equal(await formatted.locator('.bash-source-number').count(), 0);
		await card.screenshot({path:`/tmp/pi-formatted-${kind}.png`});
		assert(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
	}
	const mixedMessages = structuredClone(running);
	mixedMessages[1].content[0].argumentsText = JSON.stringify({command:'echo log; rg -n x src/a.ts'});
	mixedMessages[2].content[0].text = 'log one\nlog two\nlog three\nlog four\n' + [1,2,3,4].map(n => `${n}:const x${n} = ${n};`).join('\n');
	socket.send(JSON.stringify({type:'snapshot',state:{...baseState,messages:mixedMessages}}));
	await page.waitForFunction(() => document.querySelector('.bash-mixed-log')?.textContent.includes('log four'));
	const toggle = card.locator(':scope > .bash-group-more');
	const expandedText = await card.locator('.bash-formatted-output').textContent();
	await toggle.click();
	const collapsedText = await card.locator('.bash-formatted-output').textContent();
	assert.notEqual(collapsedText, expandedText, 'collapse must change mixed output content');
	assert.equal(await card.locator('.bash-search-result').count(), 3);
	assert.equal(await card.locator('.bash-search-file > .bash-search-location').count(), 1);
	assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
	await toggle.click();
	assert.equal(await card.locator('.bash-formatted-output').textContent(), expandedText);
	assert.equal(await card.locator('.bash-search-result').count(), 4);
	assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
	await card.screenshot({path:'/tmp/pi-compact-matches.png'});
	const pipelineMessages = structuredClone(running);
	pipelineMessages[1].content[0].argumentsText = JSON.stringify({command:'npm test 2>&1 | rg -n "Test Files|Tests" | head -3'});
	pipelineMessages[2].content[0].text = '3:> node --test\n25:> check:design\n33: Test Files 182 passed (182)';
	socket.send(JSON.stringify({type:'snapshot',state:{...baseState,messages:pipelineMessages}}));
	await card.locator('.bash-numbered-output').waitFor();
	assert.deepEqual(await card.locator('.bash-numbered-line code').allTextContents(), ['> node --test', '> check:design', 'Test Files 182 passed (182)']);
	assert.equal(await card.locator('.bash-color-add').textContent(), 'passed');
	// #167: successive model/tool cycles form one disclosure, not a wall of summaries.
	const cycles = [running[0], ...Array.from({length:13}, (_, i) => {
		const calls = [0,1].map(n => ({type:'toolCall', id:`cycle-${i}-${n}`, name:'bash', argumentsText:JSON.stringify({command:`echo cycle-${i}-${n}`})}));
		return [{id:`cycle-${i}`,role:'assistant',content:[{type:'thinking',thinking:`Check ${i}`,durationMs:1000}, ...calls]}, ...calls.map(call => ({id:`result-${call.id}`,role:'toolResult',toolCallId:call.id,content:[{type:'text',text:'ok'}]}))];
	}).flat()];
	socket.send(JSON.stringify({type:'snapshot',state:{...baseState,messages:cycles}}));
	await page.locator('.process-group-summary-line').first().waitFor();
	assert.equal(await page.locator('.process-group').count(), 1, '13 command/thinking cycles share one group');
	const summary = page.locator('.process-group-summary-line');
	assert.match(await summary.textContent(), /26/);
	assert.equal(await page.locator('.bash-row:visible').count(), 0);
	for (const theme of ['light','dark']) for (const width of [1440,375]) {
		await page.setViewportSize({width,height:1000});
		await page.evaluate(value => document.documentElement.dataset.appearance = value, theme);
		assert((await summary.boundingBox()).height < 48, 'completed activity occupies a compact summary');
		await page.locator('.process-group').screenshot({path:`/tmp/pi-issue167-${theme}-${width}.png`});
	}
	await summary.focus(); await page.keyboard.press('Enter');
	assert.equal(await page.locator('.bash-row:visible').count(), 26);
	await page.locator('.process-group-head').click();
	assert.equal(await page.locator('.bash-row:visible').count(), 0);
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pi:reveal-tool',{detail:{toolCallId:'cycle-12-1',search:true}})));
	await page.locator('[data-tool-call-id="cycle-12-1"] .bash-row-body').waitFor();
	assert.equal(await page.locator('.bash-row:visible').count(), 26);
	assert.deepEqual(errors, []);
	console.log('PASS command preview, full expansion, output expansion, search reveal and responsive themes');
} finally {
	await browser?.close().catch(() => {});
	server?.kill('SIGTERM');
	await sleep(300);
	rmSync(root, { recursive: true, force: true });
}
