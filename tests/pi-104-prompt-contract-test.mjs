/** Native 1.0.4 runtime getter versus WebUI sections in Codemode on/only. Local model only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, SettingsManager, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { promptView } from '../dist/server/system-prompt-view.js';
import { nativeToolExtensions } from '../dist/server/native-tools.js';
import { scrubHostEnv } from './lib/test-env.mjs';
scrubHostEnv();
const root = mkdtempSync(join(tmpdir(), 'pi-104-prompt-')), agentDir = join(root, 'agent');
process.env.PI_WEB_DATA_DIR = root;
mkdirSync(join(agentDir, 'skills/fixture'), { recursive: true });
writeFileSync(join(agentDir, 'skills/fixture/SKILL.md'), '---\nname: fixture\ndescription: Native hidden-reader fixture\n---\nRead fixture instructions.');
const scenarios = [
	{ mode: 'on', defaultTools: ['+codemode'], subagent: true },
	{ mode: 'only', defaultTools: ['+codemode'], subagent: true },
	{ mode: 'on', defaultTools: ['+codemode'], subagent: true },
	{ mode: 'only', defaultTools: ['+codemode', '-subagent'], subagent: false },
	{ mode: 'only', defaultTools: ['codemode'], subagent: false, skills: false },
	{ mode: 'only', defaultTools: ['+codemode'], enabled: false, subagent: false },
];
let session, scenario, failure, calls = 0;
const server = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	try {
		const request = JSON.parse(raw), view = promptView(session, root);
		assert.equal(view.opaque, false);
		assert.equal(view.raw, session.systemPrompt);
		assert.equal(request.messages.find(m => m.role === 'system').content, view.raw);
		const skills = view.sections.find(s => s.name === 'skills');
		assert.equal(!!skills, scenario.skills !== false, 'skills require a callable reader, even when hidden from the model');
		if (skills) {
			assert(skills.text.includes('Native hidden-reader fixture'));
			assert.equal(skills.text.includes('Use the read tool'), scenario.mode === 'on');
		}
		const tools = view.sections.find(s => s.name === 'tools').text;
		assert.equal(/^- bash:/m.test(tools), scenario.mode === 'on');
		assert.equal(view.rules.some(rule => rule.text === 'Use bash for file operations like ls, rg, find'), scenario.mode === 'on');
		const names = request.tools.map(t => t.function.name);
		if (scenario.mode === 'only') assert.deepEqual(names.sort(), scenario.subagent ? ['codemode', 'subagent'] : ['codemode']);
		else assert(names.includes('read'));
		assert.equal(names.includes('subagent'), scenario.subagent, 'model-only tools follow activation settings in either Codemode mode');
		assert.equal(/^- subagent:/m.test(tools), scenario.subagent, 'WebUI tool section matches model-only tool visibility');
		assert.equal(session.getCallableToolNames().includes('subagent'), false, 'subagent must never be callable inside Codemode');
		calls++;
	} catch (error) { failure = error; }
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const choice of [{ index: 0, delta: { content: 'fixture' }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [choice] })}\n\n`);
	res.end('data: [DONE]\n\n');
});
try {
	await new Promise(r => server.listen(0, '127.0.0.1', r)); assert(server.address().port >= 8900);
	writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 100 }] } } }));
	for (scenario of scenarios) {
		if (scenario.enabled === undefined) rmSync(join(root, 'subagents.json'), { force: true });
		else writeFileSync(join(root, 'subagents.json'), JSON.stringify({ enabled: scenario.enabled }));
		const settingsManager = SettingsManager.inMemory({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultTools: scenario.defaultTools, codemode: { mode: scenario.mode }, retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, extensionFactories: nativeToolExtensions(undefined, undefined, () => settingsManager.getSettings().defaultTools) }); await resourceLoader.reload();
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) }));
		await session.bindExtensions({ mode: 'rpc' });
		try { await session.prompt('Check native visibility'); if (failure) throw failure; } finally { session.dispose(); session = undefined; }
	}
	assert.equal(calls, scenarios.length);
	console.log('PASS Codemode on/only/on: native getter, model input, rule visibility, skills and model-only tool filtering');
} finally { session?.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); }
