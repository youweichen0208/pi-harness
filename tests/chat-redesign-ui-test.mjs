/** 3a/4a real-app regression with a deterministic, model-free reply. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
const port = 9242;
assert.equal(await portUp(port), false, `Port ${port} busy`);
const root = mkdtempSync(join(tmpdir(), 'pi-design14-'));
const cwd = join(root, 'workspace'); mkdirSync(cwd);
writeFileSync(join(cwd, 'README.md'), '# Design review\n\n## Overview\n\nA local test document.\n');
const time = Date.now();
const reply = "## 当前设计树\n\n```text\n根: 产出架构\n├── A. 交付物（文档或代码） ← 本轮\n└── B. 部署（单机或集群） ← 本轮\n```\n\n❓ **Q1** - **交付物**：交付什么？\n(a) 文档;(b) 代码。\n➡️ 推荐 (a)。先定边界。\n\n❓ **Q2** - **仓库**：仓库的职责？\n(a) 主仓库;(b) 部署仓库。\n➡️ 推荐 (b)。独立部署。\n\n⚠️ 保留原有数据。\n\n## 部署问题\n\n❓ **Q3** - **部署位置**：部署到哪里？\n(a) 单机;(b) 集群。\n";
let messages = [{id:"user",role:"user",timestamp:time,content:[{type:"text",text:"请设计架构"}]},{id:"reply",role:"assistant",timestamp:time+1,content:[{type:"text",text:reply}]}];
let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = ''; server.stderr.on('data', data => log += data); server.stdout.on('data', data => log += data);
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	assert(await portUp(port), log);
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
	const page = await context.newPage(); page.setDefaultTimeout(10000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	let socket, snapshot;
	let forceRunning = false;
	const submitted = [];
	await page.routeWebSocket('**/ws', route => {
		socket = route; const upstream = route.connectToServer();
		route.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (['prompt', 'abort', 'recall_queue'].includes(message.type)) {
				submitted.push(message);
				if (message.type === 'prompt') route.send(JSON.stringify({ type: 'prompt_result', requestId: message.requestId, conversationId: snapshot.state.conversationId, ok: true }));
				return;
			}
			upstream.send(wire);
		});
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === 'snapshot') {
				Object.assign(message.state, { messages, piConfigured: true, isStreaming: forceRunning });
				if (forceRunning) message.state.queue = { steering: ["skill:server-ops"], followUp: ["pending message"] };
				message.state.taskProgress = null;
				snapshot = structuredClone(message);
			}
			if (message.type !== 'snapshot_delta') route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://localhost:${port}`);
	await page.locator('.question-answer-bar').waitFor();
	assert.equal(await page.locator('.question-card').count(), 3);
	assert.equal(await page.locator('.question-option.selected').count(), 2);
	assert.match(await page.locator('.question-answer-bar').innerText(), /2 \/ 3/);
	assert.equal(await page.locator('.design-tree').count(), 1);
	assert.match(await page.locator('.question-note').innerText(), /保留原有数据/);
	await page.locator('.question-card').nth(2).getByRole('radio').nth(1).click();
	await page.getByRole('button', {name:'全部采纳推荐',exact:true}).click();
	assert.match(await page.locator('.question-answer-bar').innerText(), /3 \/ 3/);
	const border = await page.locator('.question-option.selected').first().evaluate(el => getComputedStyle(el).borderTopColor);
	assert.notEqual(border, 'rgb(47, 122, 174)');
	await page.screenshot({path:'/tmp/pi-v160-chat-4a.png'});
	await page.setViewportSize({width:390,height:900});
	assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
	await page.screenshot({path:'/tmp/pi-v160-chat-4a-mobile.png'});
	await page.getByRole('textbox', {name:'Q3 其他',exact:true}).fill('使用现有测试集群');
	assert.match(await page.locator('.question-answer-bar').innerText(), /3 \/ 3/);
	await page.getByRole('button', {name:'发送回答',exact:true}).click();
	await page.waitForTimeout(150);
	assert.equal(submitted.filter(m=>m.type==='prompt').length, 1);
	const sent = JSON.stringify(submitted.find(m=>m.type==='prompt'));
	assert(sent.includes('Q1 交付物：(a) 文档') && sent.includes('Q2 仓库：(b) 部署仓库') && sent.includes('Q3 部署位置：其他 · 使用现有测试集群'),sent);
	assert.deepEqual(errors, []);
	console.log('PASS 3a/4a: tree, recommendations, notes, multi-section answers, selection, send and narrow layout');
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if(server.exitCode===null) await new Promise(resolve=>server.once('exit',resolve)); }
	rmSync(root, {recursive:true,force:true});
}
