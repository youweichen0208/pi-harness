// #100: 全部采纳推荐 must reselect every recommended option in a grill-with-docs round.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from "./lib/test-env.mjs";

const PORT = 9301, MOCK_PORT = 9302;
for (const port of [PORT, MOCK_PORT]) if (await portUp(port)) throw new Error(`Port ${port} is occupied`);
const base = mkdtempSync(join(tmpdir(), 'pi-question-accept-'));
const workdir = join(base, 'work'), dataDir = join(base, 'data'), agentDir = join(base, 'agent');
mkdirSync(workdir, { recursive: true }); mkdirSync(dataDir, { recursive: true }); mkdirSync(agentDir, { recursive: true });
writeFileSync(join(dataDir, 'plan-settings.json'), JSON.stringify({ enabled: false }));

// A grill-with-docs round: options plus ➡️ recommendations, docs written in the same turn.
const ROUND = `先写 ADR，再问这一轮：

❓ **Q1** - **部署方式**: 用哪种部署？(a) Docker Compose;(b) systemd 直装;(c) Kubernetes

➡️ 推荐 (a)。依赖隔离最省事

---

❓ **Q2** - **数据库**: 存储选什么？(a) SQLite;(b) PostgreSQL

➡️ 推荐 (b)。需要并发写入`;
let turn = 0;
let reply = ROUND;
const mock = createServer(async (req, res) => {
	let body = '';
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body);
	res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
	const send = delta => res.write(`data: ${JSON.stringify({ id: 'question-accept-test', object: 'chat.completion.chunk', created: Date.now(), model: 'question-accept-mock', choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`);
	const sendTool = () => res.write(`data: ${JSON.stringify({ id: 'question-accept-test', object: 'chat.completion.chunk', created: Date.now(), model: 'question-accept-mock', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'write', arguments: '{"path":"docs/adr/0001-deploy.md","content":"# ADR"}' } }] }, finish_reason: null }] })}\n\n`);
	const finish = () => { res.write(`data: ${JSON.stringify({ id: 'question-accept-test', object: 'chat.completion.chunk', created: Date.now(), model: 'question-accept-mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); };
	// grill-with-docs: first write the ADR, then ask the round once the tool result returns.
	if (payload.messages.some(message => JSON.stringify(message).includes('0001-deploy.md') && JSON.stringify(message).includes('tool')) && payload.messages.some(message => (message.role === 'tool' || JSON.stringify(message).includes('tool_role')))) { for (const line of reply.split('\n')) send(line + '\n'); finish(); return; }
	if (turn++ === 0 && !payload.messages.some(message => message.role === 'tool')) { send('先写 ADR。\n\n'); sendTool(); finish(); return; }
	for (const line of reply.split('\n')) send(line + '\n');
	finish();
});
await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(MOCK_PORT, '127.0.0.1', resolve); });
writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ main: { type: 'api_key', key: 'question-accept-test' } }));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { main: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'question-accept-test', models: [{ id: 'question-accept-mock', name: 'Question Accept Mock', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'main', defaultModel: 'question-accept-mock' }));

let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(PORT), PI_WEB_TOKEN: '', PI_WEB_CWD: workdir, PI_WEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: agentDir }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(PORT); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(20000);
	await page.goto(`http://127.0.0.1:${PORT}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.locator('.inputbox textarea').fill('开始 grill');
	await page.keyboard.press('Enter');
	await page.locator('.question-card').first().waitFor();
	await page.locator('.btn.send').first().waitFor({ state: 'attached' });
	await new Promise(r => setTimeout(r, 500));

	// Deselect both preselected recommendations, then 全部采纳推荐 must restore them.
	while (await page.locator('.question-option.selected[role="radio"]:not(.question-other-radio)').count()) await page.locator('.question-option.selected[role="radio"]:not(.question-other-radio)').first().click();
	assert.equal(await page.locator('.question-option.selected[role="radio"]:not(.question-other-radio)').count(), 0, 'recommendations start preselected and can be deselected');
	const bar = page.locator('.question-answer-bar');
	await bar.getByRole('button', { name: '全部采纳推荐', exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll('.question-option.selected[role="radio"]:not(.question-other-radio)').length === 2);
	// A written 其他 answer is overridden back to its recommendation as well.
	await page.locator('.question-card').first().locator('textarea').fill('自建裸机');
	await bar.getByRole('button', { name: '全部采纳推荐', exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll('.question-option.selected[role="radio"]:not(.question-other-radio)').length === 2);
	assert.equal(await page.locator('.question-card').first().locator('.question-other.selected').count(), 0);
	const counts = await bar.locator('.question-count').textContent().catch(() => '');
	console.log('PASS 全部采纳推荐 restores recommendations (answer bar:', counts.trim() || 'n/a', ')');

	// #100: clicking with everything already selected must still give visible feedback.
	await bar.getByRole('button', { name: '全部采纳推荐', exact: true }).click();
	await bar.getByRole('button', { name: '已采纳推荐', exact: true }).waitFor();
	console.log('PASS accept-all acknowledges even when nothing changes');

	// #100 (grill-with-docs shape): answer round 1, then accept-all on round 2.
	reply = ROUND.replaceAll('Q1', 'Q3').replaceAll('Q2', 'Q4');
	await bar.getByRole('button', { name: '发送回答', exact: true }).click();
	await page.locator('.question-card').nth(2).waitFor();
	await page.locator('.btn.send').first().waitFor({ state: 'attached' });
	await new Promise(r => setTimeout(r, 500));
	const live = page.locator('.question-option.selected[role="radio"]:not(.question-other-radio):not([disabled])');
	assert.equal(await live.count(), 2, 'round 2 recommendations start preselected');
	while (await live.count()) await live.first().click();
	assert.equal((await bar.innerText()).includes('待回答'), true);
	console.log('bar before accept:', (await bar.innerText()).replace(/\n+/g, ' | '));
	await bar.getByRole('button', { name: '全部采纳推荐', exact: true }).waitFor();
	await bar.getByRole('button', { name: '全部采纳推荐', exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll('.question-option.selected[role="radio"]:not(.question-other-radio):not([disabled])').length === 2);
	console.log('PASS multi-round grill: accept-all restores round 2 after answering round 1');
} catch (error) {
	console.error('FAIL', error);
	process.exitCode = 1;
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	mock.closeAllConnections();
	await new Promise(r => mock.close(r));
	rmSync(base, { recursive: true, force: true });
}
