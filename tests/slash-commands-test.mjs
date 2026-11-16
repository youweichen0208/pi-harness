/** Native OMP command catalogue and dispatch, with isolated files and a local provider. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OmpChatService } from '../dist/server/omp/chat-service.js';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { scrubHostEnv } from './lib/test-env.mjs';
scrubHostEnv();
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_/.test(key)) delete process.env[key];
const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-slash-'))), data = join(root, 'data'), agent = join(data, 'omp/agent');
for (const name of ['extensions', 'commands/fixture-custom', 'skills/fixture']) mkdirSync(join(agent, name), { recursive: true });
const effects = join(root, 'effects.txt'); writeFileSync(effects, '');
writeFileSync(join(agent, 'extensions/fixture.js'), `import { appendFileSync } from 'node:fs'; export default api => api.registerCommand('fixture-extension', { description: 'Native extension', handler: async args => { appendFileSync(${JSON.stringify(effects)}, args); } });`);
writeFileSync(join(agent, 'commands/fixture-custom/index.js'), `export default () => ({ name: 'fixture-custom', description: 'Native custom command', execute: () => 'CUSTOM_COMMAND_BODY' });`);
writeFileSync(join(agent, 'commands/fixture-file.md'), '---\ndescription: Native file command\nargument-hint: <file>\n---\nFILE_COMMAND_BODY $@');
writeFileSync(join(agent, 'skills/fixture/SKILL.md'), '---\nname: fixture\ndescription: Native skill\n---\nSKILL_COMMAND_BODY');
const requests = [], events = [];
let service, harness, browser;
const wait = async (predicate, label) => { for (let i = 0; i < 800; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error('Timed out ' + label); };
const provider = createServer(async (req, res) => {
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
	let raw = ''; for await (const chunk of req) raw += chunk;
	const message = JSON.parse(raw);
	if (req.url === '/mcp') {
		if (message.id === undefined) { res.writeHead(202); res.end(); return; }
		const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, serverInfo: { name: 'fixture', version: '1' }, capabilities: { prompts: {} } }
			: message.method === 'prompts/list' ? { prompts: [{ name: 'catalog-prompt', description: 'Native MCP prompt', arguments: [{ name: 'text', required: true }] }] }
			: message.method === 'tools/list' ? { tools: [] } : {};
		res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); return;
	}
	requests.push(message);
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
	emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
	emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Native command fixture reply.' } });
	emit('content_block_stop', { index: 0 });
	emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } });
	emit('message_stop', {}); res.end();
});
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } }));
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', contextWindow: 1000000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: true, enableAgentsUser: false, enableAgentsProject: false, enablePiUser: false, enablePiProject: false, enableClaudeUser: false, enableClaudeProject: false, enableCodexUser: false, customDirectories: [join(agent, 'skills')] }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	service = new OmpChatService(root, join(data, 'client-state.json'));
	const client = await service.attach('commands', event => events.push(event));
	await client.setModel('fixture/fixture'); await client.pushSlashCommands();
	const catalog = () => events.filter(event => event.type === 'slash_commands').at(-1)?.commands ?? [];
	const command = name => catalog().find(command => command.name === name);
	assert.equal(command('fixture-extension')?.source, 'extension', 'native extension must not be mislabeled builtin');
	assert.equal(command('fixture-custom')?.source, 'custom');
	await wait(() => catalog().some(command => command.source === 'mcp_prompt'), 'native MCP prompt catalogue');
	assert.equal(command('fixture-file')?.source, 'file');
	assert.equal(command('fixture-file')?.argumentHint, '<file>');
	assert.equal(command('skill:fixture')?.source, 'skill');
	assert.equal(command('fixture-extension')?.argumentHint, 'arguments');
	assert.equal(command('models')?.source, 'builtin', 'native builtin alias is selectable');
	assert.equal(command('new')?.source, 'builtin');
	assert.equal(new Set(catalog().map(command => command.name)).size, catalog().length);
	await client.prompt('/fixture-extension expected');
	await wait(() => readFileSync(effects, 'utf8') === 'expected', 'native extension side effect');
	await wait(() => !client.session.state.running, 'extension settles');
	assert.equal(requests.length, 0);
	await client.prompt('/model fixture/fixture');
	await wait(() => !client.session.state.running, 'model command settles');
	assert.equal(requests.length, 0, 'native builtin stays local');
	await client.prompt('/unknown-fixture ordinary text');
	await wait(() => !client.session.state.running, 'unknown slash model reply');
	assert.equal(requests.length, 1);
	assert(JSON.stringify(requests[0].messages).includes('/unknown-fixture ordinary text'));
	// Do not call the host's catalogue refresh: only the native event may update it.
	writeFileSync(join(agent, 'commands/fixture-late.md'), '---\ndescription: Added by native reload\n---\nLATE_COMMAND_BODY');
	await client.session.command('harness_mcp', { action: 'reload' });
	await wait(() => command('fixture-late')?.source === 'file', 'native available_commands_update');
	const first = client.session, firstId = client.conversationId;
	await client.newChat(true);
	const secondId = client.conversationId;
	writeFileSync(join(agent, 'commands/fixture-background.md'), 'BACKGROUND_COMMAND_BODY');
	const marker = events.length;
	await first.command('harness_mcp', { action: 'reload' });
	assert(!events.slice(marker).some(event => event.type === 'slash_commands' && event.commands.some(command => command.name === 'fixture-background')), 'background metadata cannot replace active catalogue');
	await client.switchConversation(firstId);
	assert.equal(command('fixture-background')?.source, 'file', 'switch publishes that conversation catalogue');
	await client.abort(); const stopped = first.generation;
	await client.pushSlashCommands();
	assert.equal(first.generation, stopped, 'catalogue reads cannot revive a stopped worker');
	assert.equal(command('fixture-background')?.source, 'file', 'stopped catalogue remains available');
	await client.switchConversation(secondId);
	assert.equal(requests.length, 1, 'metadata, reload and switching never call a model');
	if (process.argv.includes('--browser')) {
		await service.disposeAll(); service = undefined;
		const { chromium } = await import('playwright-core');
		const { CHROME_PATH } = await import('./lib/chrome.mjs');
		harness = await startIsolatedHarness({ env: { PI_WEB_DATA_DIR: data, PI_WEB_CWD: root } });
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
		const page = await browser.newPage();
		await page.goto(`http://127.0.0.1:${harness.port}`);
		const input = page.locator('.inputbar textarea');
		await input.waitFor();
		await page.waitForFunction(() => !document.querySelector('.inputbar textarea')?.disabled);
		for (const [name, source, label] of [['fixture-file', 'file', '文件命令'], ['fixture-custom', 'custom', '自定义命令'], ['fixture-extension', 'extension', '扩展'], ['skill:fixture', 'skill', '技能'], ['models', 'builtin', '内置']]) {
			await input.fill('/' + name);
			const item = page.locator('.slash-item').filter({ has: page.locator('.slash-name', { hasText: '/' + name }) }).first();
			await item.waitFor();
			assert.equal(await item.locator('.slash-source.' + source).textContent(), label);
			if (source === 'file') assert.equal(await item.locator('.slash-hint').textContent(), '<file>');
		}
		await input.fill('/fixture-file'); await page.locator('.slash-item').first().waitFor();
		await page.screenshot({ path: join(tmpdir(), 'omp-command-catalog.png') });
		await page.locator('.slash-item').first().click();
		assert.equal(await input.inputValue(), '/fixture-file ');
		assert.equal(requests.length, 1, 'selecting a command only fills the draft');
		console.log('PASS native command picker labels, hints, aliases and draft-only selection in browser');
	}
	console.log('PASS native slash catalogue: sources/hints/aliases, dispatch, dynamic reload, background isolation, switch and Stop cache');
} finally { await browser?.close(); await harness?.stop(); await service?.disposeAll(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true }); }
