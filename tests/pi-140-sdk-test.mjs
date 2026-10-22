/** Pi 1.4 worker admission through real sessions, native tools and a local model. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Type } from 'typebox';
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, getPackageDir } from '@earendil-works/pi-coding-agent';
import { nativeToolExtensions } from '../dist/server/native-tools.js';
import { serializeMessage } from '../dist/server/serialize.js';
import { scrubHostEnv } from './lib/test-env.mjs';
scrubHostEnv();
const root = mkdtempSync(join(tmpdir(), 'pi-140-sdk-')), agentDir = join(root, 'agent');
mkdirSync(agentDir);
const sessions = [], gates = new Map(), entered = [], events = new Map(), pending = [];
const issued = new Set(), recoveryRequests = [];
const server = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	const body = JSON.parse(raw), content = body.messages.find(m => m.role === 'user')?.content;
	const name = typeof content === 'string' ? content : content?.map(block => block.text ?? '').join('');
	const recovery = name?.startsWith('recovery-fixture');
	if (recovery) recoveryRequests.push(body);
	const first = !recovery && !issued.has(name); issued.add(name);
	const delta = first ? { tool_calls: [{ index: 0, id: `code-${name}`, type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code: `text(await tools.fixture_gate({name:${JSON.stringify(name)}}));` }) } }] } : { content: 'Done' };
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [choice] })}\n\n`);
	res.end('data: [DONE]\n\n');
});
const until = async predicate => {
	for (let i = 0; i < 1000; i++) { if (predicate()) return; await sleep(10); }
	throw new Error('Timed out waiting for worker state: ' + JSON.stringify({ entered, messages: sessions.map(s => s.messages) }));
};
try {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	assert(server.address().port >= 8900);
	writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1024 }] } } }));
	for (const name of ['first', 'second', 'queued', 'cancelled']) {
		const settingsManager = SettingsManager.inMemory({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultTools: ['+codemode', '+fixture_gate'], retry: { enabled: false }, compaction: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, extensionFactories: [...nativeToolExtensions(), { name: 'gate', factory: pi => pi.registerTool({ name: 'fixture_gate', label: 'Gate', description: 'Wait for test release', parameters: Type.Object({ name: Type.String() }), execute: async (_id, args, signal) => {
			entered.push(args.name);
			await new Promise(resolve => { gates.set(args.name, resolve); signal?.addEventListener('abort', resolve, { once: true }); });
			return { content: [{ type: 'text', text: args.name }], details: {} };
		} }) }] });
		await resourceLoader.reload();
		const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) });
		sessions.push(session); events.set(name, []);
		await session.bindExtensions({ mode: 'rpc' }); session.subscribe(event => events.get(name).push(event));
	}
	pending.push(sessions[0].prompt('first'), sessions[1].prompt('second'));
	await until(() => entered.length === 2);
	pending.push(sessions[2].prompt('queued'), sessions[3].prompt('cancelled'));
	await until(() => ['queued', 'cancelled'].every(name => events.get(name).some(e => e.type === 'tool_execution_start' && e.toolName === 'codemode')));
	await sleep(100);
	assert.deepEqual([...entered].sort(), ['first', 'second'], 'third and fourth sessions wait for shared workers');
	assert(sessions[2].isStreaming, 'queued session stays running');
	await sessions[3].abort(); await pending[3];
	assert(!entered.includes('cancelled'), 'cancelled waiter never executes its tool');
	assert(events.get('cancelled').some(e => e.type === 'agent_settled' && e.aborted));
	gates.get('first')(); await pending[0];
	await until(() => entered.includes('queued'));
	gates.get('queued')(); gates.get('second')(); await Promise.all(pending);
	for (let index = 0; index < 3; index++) {
		const session = sessions[index], name = ['first', 'second', 'queued'][index];
		const result = session.messages.find(m => m.role === 'toolResult' && m.toolName === 'codemode');
		assert(result && !result.isError, JSON.stringify(result));
		assert(serializeMessage(result, 0).codemode.calls.every(call => call.status === 'ok'));
		assert(events.get(name).some(e => e.type === 'agent_settled'));
		assert(session.isIdle);
	}
	// Exercise the native summary boundary with deterministic local results.
	const { generateSummary, compact } = await import(pathToFileURL(join(getPackageDir(), 'dist/core/compaction/compaction.js')));
	const { createFileOps } = await import(pathToFileURL(join(getPackageDir(), 'dist/core/compaction/utils.js')));
	const captured = [];
	const usage = {input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
	const stream = async (model, context, options) => {
		captured.push({ context, options });
		return { result: async () => ({ role:'assistant',content:[{type:'text',text:'Fixture summary'}],api:model.api,provider:model.provider,model:model.id,usage,stopReason:'stop',timestamp:Date.now() }) };
	};
	const model = sessions[0].model, messages = [{role:'user',content:'Summarize this fixture',timestamp:Date.now()}];
	assert.equal(await generateSummary(messages, model, 1, 'fixture', undefined, undefined, 'Keep fixture decisions', undefined, undefined, stream), 'Fixture summary');
	assert.equal(captured[0].options.maxTokens, undefined, 'reserveTokens does not cap summary output');
	assert(JSON.stringify(captured[0].context).includes('Keep fixture decisions'));
	for (const history of [[], messages]) {
		const start = captured.length;
		const result = await compact({ firstKeptEntryId:'fixture',messagesToSummarize:history,turnPrefixMessages:messages,isSplitTurn:true,tokensBefore:10,fileOps:createFileOps(),settings:{enabled:true,reserveTokens:1,keepRecentTokens:1} }, model, 'fixture', undefined, 'Keep split instructions', undefined, undefined, stream);
		assert(result.summary.includes('Fixture summary'));
		assert.equal(captured.length-start, history.length ? 2 : 1);
		for (const request of captured.slice(start)) {
			assert(JSON.stringify(request.context).includes('Keep split instructions'));
			assert.equal(request.options.maxTokens, undefined);
		}
	}
	console.log('PASS native summary output cap and split-turn custom instructions');
	// Recover a persisted truncated tool attempt, including its matching result.
	const manager = SessionManager.create(root, join(agentDir, 'sessions'));
	manager.appendModelChange(model.provider, model.id);
	manager.appendMessage({role:'user',content:'recovery-fixture '+ 'context '.repeat(100),timestamp:Date.now()});
	manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:'truncated-call',name:'read',arguments:{path:'fixture.txt'}}],api:model.api,provider:model.provider,model:model.id,usage,stopReason:'length',timestamp:Date.now()});
	manager.appendMessage({role:'toolResult',toolCallId:'truncated-call',toolName:'read',content:[{type:'text',text:'partial result'}],isError:false,timestamp:Date.now()});
	const recoverySettings = SettingsManager.inMemory({defaultProvider:'fixture',defaultModel:'fixture',compaction:{enabled:true,reserveTokens:1,keepRecentTokens:1},retry:{enabled:false}});
	const recoveryLoader = new DefaultResourceLoader({cwd:root,agentDir,settingsManager:recoverySettings}); await recoveryLoader.reload();
	const {session: recoverySession} = await createAgentSession({cwd:root,agentDir,settingsManager:recoverySettings,resourceLoader:recoveryLoader,sessionManager:SessionManager.open(manager.getSessionFile())});
	sessions.push(recoverySession);
	await recoverySession.bindExtensions({mode:'rpc'});
	await recoverySession.prompt('Continue after the truncated response');
	assert(recoveryRequests.length > 0);
	for (const request of recoveryRequests) assert(!JSON.stringify(request.messages).includes('truncated-call'), 'recovery removes both the tool call and matching result from the next provider request');
	assert(recoverySession.isIdle);
	const restored = SessionManager.open(recoverySession.sessionFile).buildSessionContext().messages;
	assert(!restored.some(message => message.role === 'toolResult' && message.toolCallId === 'truncated-call'), 'omission survives session reopen');
	console.log('PASS persisted truncated tool recovery has no orphan result in provider request or restored context');
	console.log('PASS Pi 1.4 cross-session worker queue, cancellation without execution, released slot reuse, serialized completion and agent_settled');
} finally {
	for (const release of gates.values()) release();
	await Promise.allSettled(sessions.map(session => session.abort()));
	await Promise.allSettled(pending);
	for (const session of sessions) session.dispose();
	server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
