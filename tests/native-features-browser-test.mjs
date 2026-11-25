/** Render native tool history and OAuth interactions without model or provider requests. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { serializeMessage } from '../dist/server/serialize.js';
import { testEnv } from "./lib/test-env.mjs";
const directory = mkdtempSync(join(tmpdir(), 'pi-native-browser-'));
const port = 31000 + Math.floor(Math.random() * 10000);
const server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), HOME: directory, PORT: String(port), PI_WEB_DATA_DIR: directory, PI_WEB_CWD: directory, PI_CODING_AGENT_DIR: join(directory, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser;
server.stdout.on('data', data => { logs += data; });
server.stderr.on('data', data => { logs += data; });
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null) throw new Error(logs);
		try { const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); assert.equal(health.pid, server.pid); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
	}
	assert(ready, logs);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	for (const language of ['zh', 'en']) {
		const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
		const errors = [], sent = [];
		let socket, baseState, replaying = false;
		page.on('pageerror', error => errors.push(String(error)));
		const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1kAAAAASUVORK5CYII=';
		const result = serializeMessage({ role: 'toolResult', toolCallId: 'native', toolName: 'codemode', isError: false, timestamp: 2, content: [{ type: 'text', text: 'Fixture result' }, { type: 'image', mimeType: 'image/png', data: image }], nestedCalls: { complete: true, calls: [{ id: 'child', name: 'mcp__echo__add', arguments: { a: 2, b: 3 }, status: 'ok', durationMs: 12 }] } }, 1);
		await page.routeWebSocket('**/ws', route => {
			socket = route;
			const upstream = route.connectToServer();
			route.onMessage(wire => { const message = JSON.parse(wire.toString()); sent.push(message); if (!['provider_auth_response', 'cancel_provider_login'].includes(message.type)) upstream.send(wire); });
			upstream.onMessage(wire => {
				const message = JSON.parse(wire.toString());
				if (replaying && ['snapshot', 'snapshot_delta'].includes(message.type)) return;
				if (message.type === 'snapshot') {
					message.state.piConfigured = true;
					message.state.model = { id: 'router', name: 'Router', provider: 'fixture', vision: false };
					message.state.routedModel = { id: 'physical', name: 'Physical', provider: 'fixture', vision: false, thinkingLevel: 'high' };
					message.state.messages = [{ id: 'assistant', role: 'assistant', timestamp: 1, content: [{ type: 'toolCall', id: 'native', name: 'codemode', argumentsText: '{"code":"fixture"}' }] }, result];
					baseState = message.state;
				}
				route.send(JSON.stringify(message));
			});
		});
		await page.addInitScript(language => { localStorage.setItem('pi-harness:lang', language); localStorage.setItem('pi-left-collapsed', 'true'); }, language);
		await page.goto(`http://127.0.0.1:${port}`);
		await page.locator('.codemode-body').waitFor();
		await page.locator('.chip-routed-model:visible').first().waitFor();
		assert.match(await page.locator('.chip-routed-model:visible').first().textContent(), /Physical/);
		assert.match(await page.locator('.codemode-body').textContent(), /mcp__echo__add/);
		await page.locator('.codemode-call > summary').click();
		assert.match(await page.locator('.codemode-call').textContent(), /"a":2/);
		const picture = page.locator('.codemode-images img');
		await picture.waitFor();
		assert(await picture.evaluate(node => node.complete && node.naturalWidth === 1));
		replaying = true;
		socket.send(JSON.stringify({ type: 'snapshot', state: { ...baseState, isStreaming: true, messages: baseState.messages.slice(0, 1) } }));
		const child = { type: 'tool_status', conversationId: baseState.conversationId, toolCallId: 'live-child', parentToolCallId: 'native', toolName: 'mcp__http__add', running: true, isError: false, argumentsText: '{"a":4,"b":5}' };
		socket.send(JSON.stringify(child));
		await page.waitForFunction(() => document.querySelector('.codemode-body')?.textContent.includes('mcp__http__add'));
		socket.send(JSON.stringify({ ...child, conversationId: 'other-conversation', toolCallId: 'foreign-child', toolName: 'foreign-tool' }));
		socket.send(JSON.stringify({ ...child, running: false, durationMs: 123 }));
		await page.waitForFunction(() => document.querySelector('.codemode-body')?.textContent.includes('123ms'));
		assert(!await page.locator('.codemode-body').textContent().then(text => text.includes('foreign-tool')));
		socket.send(JSON.stringify({ type: 'snapshot', state: baseState }));
		await page.waitForFunction(() => document.querySelector('.codemode-body')?.textContent.includes('mcp__echo__add'));
		assert.equal(await page.locator('.codemode-call').count(), 1);
		const fixture = {
			snapshot: "fixture-snapshot", title: "Repository overview", text: Array.from({length:16}, (_,i) => "Paragraph " + (i+1)).join("\n"),
			elements: [{id:1,role:"a",label:"Issues"},{id:2,role:"button",label:"New issue"},{id:3,role:"input",label:"Search"}],
		};
		const snapshotMessages = [
			{id:"read-message",role:"assistant",timestamp:3,content:[{type:"toolCall",id:"read-call",name:"embedded_browser",argumentsText:'{"action":"read"}'}]},
			serializeMessage({role:"toolResult",toolCallId:"read-call",toolName:"embedded_browser",isError:false,durationMs:18,timestamp:4,content:[{type:"text",text:JSON.stringify(fixture)}]},2),
		];
		socket.send(JSON.stringify({type:"snapshot",state:{...baseState,isStreaming:false,messages:snapshotMessages}}));
		const card = page.locator(".snapshot-card");
		await card.locator(".snap-title").waitFor();
		assert.equal(await card.locator(".snap-title").innerText(),fixture.title);
		assert.equal(await card.locator(".snap-url,.snap-json").count(),0,"legacy snapshot shows neither a fabricated URL nor raw JSON by default");
		assert.equal((await card.locator(".snap-text").innerText()).split("\n").length,10);
		await card.getByRole("button",{name:language==="zh"?"展开正文":"Show more text"}).click();
		assert.equal(await card.locator(".snap-text").innerText(),fixture.text);
		await card.getByRole("button",{name:language==="zh"?"可点击元素":"Links and buttons",exact:true}).click();
		assert.equal(await card.locator("tbody tr").count(),2);
		await card.getByRole("searchbox").fill("new");
		assert.equal(await card.locator("tbody tr").count(),1);
		await card.locator("tbody button").click();
		assert.match(await page.locator(".view-pane textarea:visible").first().inputValue(),/fixture-snapshot/);
		await card.getByRole("tab",{name:/JSON/}).click();
		assert.deepEqual(JSON.parse(await card.locator(".snap-json").innerText()),fixture);
		await card.getByRole("tab",{name:language==="zh"?"摘要":"Summary"}).click();
		await page.setViewportSize({width:390,height:800});
		assert(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1),"snapshot fits narrow chats");
		await page.setViewportSize({width:1000,height:850});
		if (process.env.PI_SNAPSHOT_SCREENSHOT && language === "zh") await card.screenshot({path:process.env.PI_SNAPSHOT_SCREENSHOT});
		const browserTool = 'embedded_browser';
		const browserMessages = [undefined, 60000].flatMap((durationMs, index) => {
			const id = `browser-timeout-${index}`;
			return [
				{ id, role: 'assistant', timestamp: 3 + index, content: [{ type: 'toolCall', id, name: browserTool, argumentsText: '{}' }] },
				serializeMessage({ role: 'toolResult', toolCallId: id, toolName: browserTool, isError: true, ...(durationMs === undefined ? {} : { durationMs }), timestamp: 5 + index, content: [{ type: 'text', text: 'Browser request timed out.' }] }, index),
			];
		});
		socket.send(JSON.stringify({ type: 'snapshot', state: { ...baseState, isStreaming: false, messages: browserMessages } }));
		for (const id of ['browser-timeout-0', 'browser-timeout-1']) {
			const card = page.locator(`[data-tool-call-id="${id}"]`);
			await card.waitFor();
			const header = card.locator('.tool-step-head');
			assert.match(await header.textContent(), language === 'zh' ? /响应超时/ : /Timed out/);
			assert.match(await header.locator('.tool-step-state').getAttribute('class'), /failed/);
		}
		assert((await page.locator('[data-tool-call-id="browser-timeout-1"] .tool-step-state').textContent()).includes('·'));
		assert(!(await page.locator('[data-tool-call-id="browser-timeout-0"] .tool-step-state').textContent()).includes('·'));
		await page.locator('[data-tool-call-id="browser-timeout-0"] .tool-step-head').click();
		const timeoutHelp = page.locator('[data-tool-call-id="browser-timeout-0"] .browser-progress-update');
		await timeoutHelp.waitFor();
		assert.match(await timeoutHelp.textContent(), language === 'zh' ? /响应超时/ : /Timed out/);
		// Ordinary browser failures hide the inline "Error · duration" label; details stay reachable by expanding.
		const failedClick = { id: 'browser-error', role: 'assistant', timestamp: 7, content: [{ type: 'toolCall', id: 'browser-error', name: browserTool, argumentsText: '{"action":"clickAt","x":10,"y":20}' }] };
		socket.send(JSON.stringify({ type: 'snapshot', state: { ...baseState, isStreaming: false, messages: [failedClick, serializeMessage({ role: 'toolResult', toolCallId: 'browser-error', toolName: browserTool, isError: true, durationMs: 22600, timestamp: 8, content: [{ type: 'text', text: 'Element not found' }] }, 0)] } }));
		const errorCard = page.locator('[data-tool-call-id="browser-error"]');
		await errorCard.waitFor();
		assert.match(await errorCard.locator('.tool-step-head').textContent(), language === 'zh' ? /点击元素/ : /Click element/);
		assert.equal(await errorCard.locator('.tool-step-head .tool-step-state').count(), 0);
		assert.doesNotMatch(await errorCard.locator('.tool-step-head').textContent(), /Error|出错|22\.6/);
		await errorCard.locator('.tool-step-head').click();
		await errorCard.locator('.toolcall-body').waitFor();
		assert.match(await errorCard.locator('.toolcall-body').textContent(), /Element not found/);
		await page.evaluate(() => {
			window.deviceActions = [];
			window.open = url => { window.deviceActions.push(['open', url]); return null; };
			Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async code => {
				window.deviceActions.push(['copy',code]);
				if (window.failCopy) throw new Error('clipboard denied');
			}}});
		});
		for (const [index, flags] of [{}, {openBrowserOnConfirm:false,copyCodeOnConfirm:false}, {openBrowserOnConfirm:false,copyCodeOnConfirm:true}, {openBrowserOnConfirm:true,copyCodeOnConfirm:false}, {openBrowserOnConfirm:true,copyCodeOnConfirm:true}].entries()) {
			const device = {requestId:`device-${index}`,provider:'fixture',phase:'pending',url:'https://example.invalid/device',code:'ABCD',...flags};
			await page.evaluate(() => { window.deviceActions = []; window.failCopy = true; });
			socket.send(JSON.stringify({type:'provider_auth',state:device}));
			await page.locator('.provider-auth-modal code').waitFor();
			socket.send(JSON.stringify({type:'provider_auth',state:device})); // reconnect replay
			await page.waitForTimeout(60);
			assert.deepEqual(await page.evaluate(() => window.deviceActions), []);
			const button = page.locator('.provider-auth-device-confirm');
			if (flags.openBrowserOnConfirm === false && flags.copyCodeOnConfirm === false) assert.equal(await button.count(),0);
			else {
				await button.click();
				const expected = [];
				if (flags.copyCodeOnConfirm !== false) expected.push(['copy','ABCD']);
				if (flags.openBrowserOnConfirm !== false) expected.push(['open',device.url]);
				assert.deepEqual(await page.evaluate(() => window.deviceActions),expected);
				if (flags.copyCodeOnConfirm !== false) {
					await page.getByRole('status').filter({hasText:language === 'zh' ? '复制失败' : 'Copy failed'}).waitFor();
					assert.equal(await page.locator('.provider-auth-modal code').textContent(),'ABCD');
					await page.evaluate(() => { window.failCopy = false; });
					await button.click();
					await page.getByRole('status').filter({hasText:language === 'zh' ? '授权码已复制' : 'Authorization code copied'}).waitFor();
				}
			}
		}
		const state = { requestId: 'auth-fixture', provider: 'openai', phase: 'pending', url: 'https://example.invalid/authorize', prompt: { id: 'code', kind: 'manual_code', message: 'Fixture authorization code' } };
		socket.send(JSON.stringify({ type: 'provider_auth', state }));
		await page.locator('.provider-auth-modal').waitFor();
		assert.equal(await page.locator('.provider-auth-modal a').getAttribute('href'), state.url);
		await page.locator('.provider-auth-modal input').fill('fixture-code');
		await page.locator('.provider-auth-modal button[type="submit"]').click();
		assert(sent.some(message => message.type === 'provider_auth_response' && message.value === 'fixture-code' && message.requestId === state.requestId && message.promptId === 'code'));
		await page.keyboard.press('Escape');
		await page.locator('.provider-auth-modal').waitFor({ state: 'hidden' });
		assert(sent.some(message => message.type === 'cancel_provider_login' && message.requestId === state.requestId));
		assert.deepEqual(errors, []);
		await page.close();
		console.log(`PASS ${language}: nested tool history, tool image, OAuth response and cancellation`);
	}
} finally {
	await browser?.close();
	if (server.exitCode === null) { const exit = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exit; }
	rmSync(directory, { recursive: true, force: true });
}
