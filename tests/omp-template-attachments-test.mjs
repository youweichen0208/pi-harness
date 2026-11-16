/** Real RPC dispatch: native templates/hooks/commands plus exact frozen attachment bodies. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOmpTestModule, ompTestRoot } from './lib/omp-runtime-location.mjs';
import { listenIsolated } from './lib/isolated-server.mjs';
import { scrubHostEnv } from './lib/test-env.mjs';
scrubHostEnv();
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_/.test(key)) delete process.env[key];
const { OmpClientSession } = await loadOmpTestModule('chat-service.js');
const { ClientStateStore } = await import(pathToFileURL(join(ompTestRoot, 'dist/server/client-state.js')).href);
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'omp-template-files-'))), agent = join(root, 'omp/agent');
for (const directory of ['prompts', 'commands', 'extensions']) mkdirSync(join(agent, directory), { recursive: true });
const hooks = join(root, 'hooks.jsonl'), commands = join(root, 'commands.jsonl'), releaseHook = join(root, 'release-hook');
writeFileSync(hooks, ''); writeFileSync(commands, '');
for (const [name, body] of Object.entries({ 'fixture-template': 'RENDERED $@', 'fixture-generated': '/fixture-shadow model text $@', 'fixture-shadow': 'WRONG_TEMPLATE', 'fixture-custom': 'WRONG_CUSTOM_TEMPLATE', 'fixture-file': 'WRONG_FILE_TEMPLATE', context: 'WRONG_BUILTIN_TEMPLATE' })) writeFileSync(join(agent, 'prompts', name + '.md'), body);
writeFileSync(join(agent, 'commands', 'fixture-file.md'), '/fixture-template file $@');
mkdirSync(join(agent, 'commands/fixture-custom'));
writeFileSync(join(agent, 'commands/fixture-custom/index.js'), `export default () => ({ name: 'fixture-custom', description: 'Custom command priority', execute: () => 'NATIVE_CUSTOM_RESULT' });`);
writeFileSync(join(agent, 'extensions', 'fixture.js'), `import { appendFileSync, existsSync } from 'node:fs';
export default api => {
 api.on('input', async event => {
  appendFileSync(${JSON.stringify(hooks)}, JSON.stringify({ text: event.text, source: event.source }) + '\\n');
  if (event.text.startsWith('HOOK_HOLD')) while (!existsSync(${JSON.stringify(releaseHook)})) await new Promise(resolve => setTimeout(resolve, 20));
  if (event.text.startsWith('HOOK_HANDLED')) return { handled: true };
  if (event.text.startsWith('HOOK_TEMPLATE')) return { text: event.text.replace('HOOK_TEMPLATE', '/fixture-template') };
  if (event.text.startsWith('/fixture-template TO_EXTENSION')) return { text: event.text.replace('/fixture-template TO_EXTENSION', '/fixture-shadow transformed') };
 });
 api.registerCommand('fixture-shadow', { description: 'Extension priority', handler: async args => { appendFileSync(${JSON.stringify(commands)}, JSON.stringify(args) + '\\n'); } });
 api.registerCommand('fixture-agent', { description: 'Native extension message tracking', handler: async () => { void api.sendUserMessage('EXTENSION_AGENT_WORK'); } });
};`);
const body = '# Literal file\r\nconst s = "a  b";\n\tkeep = \'quotes\';\n$@ {{arguments}} /fixture-shadow\n';
const file = join(root, 'literal.txt'); writeFileSync(file, body);
const attachment = () => [{ path: file, mode: 'inline' }];
const requests = [], events = [], held = [];
let client, holdNext = false;
const wait = async (predicate, label) => { for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('Timed out ' + label); };
const readLines = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const provider = createServer(async (req, res) => {
	let raw = ''; for await (const part of req) raw += part;
	const payload = JSON.parse(raw); if (payload.tools?.length) requests.push(payload);
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: `m${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	if (holdNext) { holdNext = false; await new Promise(resolve => held.push(resolve)); }
	emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
	emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Template attachment reply.' } });
	emit('content_block_stop', { index: 0 });
	emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } });
	emit('message_stop', {}); res.end();
});
const settled = async () => { await wait(() => !client.session.state.running, 'native settlement'); await client.session.refresh(); };
const requestText = () => { const content = requests.at(-1).messages.filter(message => message.role === 'user').at(-1).content; return typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n'); };
const send = async (text, expected, files = attachment()) => {
	const before = requests.length, beforeHooks = readLines(hooks).length;
	await client.prompt(text, files); await settled();
	assert.equal(requests.length, before + 1, 'one native model turn');
	assert(requestText().includes(expected), `expected native text: ${expected}`);
	if (files.length) assert.equal(requestText().split(body).length, 2, 'exact file whitespace, quotes and template-like text appear once');
	const observed = readLines(hooks).slice(beforeHooks);
	assert.equal(observed.length, 1, 'native input hooks run once');
	assert(observed[0].text.startsWith(text)); if (files.length) assert(observed[0].text.includes(body));
};
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 1000000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	client = new OmpClientSession('templates', root, new ClientStateStore(join(root, 'client-state.json')));
	client.attachSink(event => events.push(event), false);
	await client.initialize(); await client.setModel('fixture/fixture');
	await send('/fixture-template "one two" three', 'RENDERED one two three');
	await send('/fixture-template', 'RENDERED');
	await send('HOOK_TEMPLATE "one two" transformed', 'RENDERED one two transformed');
	await send('/fixture-generated literal', '/fixture-shadow model text literal');
	assert.equal(readLines(commands).length, 0, 'rendered slash never executes a command');
	await send('/fixture-file "one two"', 'RENDERED file one two');
	await send('/fixture-custom priority', 'NATIVE_CUSTOM_RESULT', []);
	const customBefore = requests.length, customHooks = readLines(hooks).length;
	await client.prompt('/fixture-custom with-attachment', attachment()); await settled();
	assert.equal(requests.length, customBefore + 1); assert(requestText().includes('NATIVE_CUSTOM_RESULT'));
	assert(!requestText().includes('WRONG_CUSTOM_TEMPLATE'), 'custom commands precede same-name templates with attachments too');
	assert.equal(readLines(hooks).length, customHooks + 1);
	for (const text of ['/fixture-shadow priority', '/fixture-template TO_EXTENSION']) {
		const before = requests.length, calls = readLines(commands).length, inputs = readLines(hooks).length;
		await client.prompt(text, attachment()); await settled();
		assert.equal(requests.length, before, 'extension commands take priority without a model call');
		assert.equal(readLines(commands).length, calls + 1); assert(readLines(commands).at(-1).includes(body));
		assert.equal(readLines(hooks).length, inputs + 1);
	}
	const handledBefore = requests.length;
	await client.prompt('HOOK_HANDLED', attachment()); await settled();
	assert.equal(requests.length, handledBefore, 'handled input stays local');
	await client.prompt('/context', attachment()); await settled();
	assert.equal(requests.length, handledBefore, 'native builtins precede same-name templates');
	await send('/fixture-agent', 'EXTENSION_AGENT_WORK', []);
	// Recall and actual queue delivery both retain exact file bytes.
	let nativeSteerAttachment;
	for (const [behavior, recall, nativeBaseline] of [['followUp', true, false], ['followUp', false, false], ['steer', false, true], ['steer', false, false]]) {
		const before = requests.length; holdNext = true;
		await client.prompt('PARENT_HOLD'); await wait(() => held.length === 1, 'held parent');
		const marker = `queued-${behavior}-${recall}-${nativeBaseline}`;
		const expected = nativeBaseline ? `NATIVE_STEER_BASELINE ${marker}` : `RENDERED ${marker}`;
		await client.prompt(nativeBaseline ? expected : `/fixture-template ${marker}`, attachment(), behavior);
		if (recall) { const restored = await client.session.recallQueue(); assert(restored.text.includes(body)); assert(restored.text.includes(`RENDERED ${marker}`)); }
		held.shift()(); await settled();
		assert.equal(requests.length, before + (recall ? 1 : 2));
		if (!recall) {
			const text = requests.at(-1).messages.map(message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).findLast(text => text.includes(expected));
			assert(text, `queued ${behavior} reaches its own model message`);
			const saved = client.session.state.messages.find(message => message.questionText === expected);
			assert.equal(saved?.userAttachments[0]?.preview, body, 'native history retains original CRLF even when steering normalizes provider text');
			if (behavior !== 'steer') assert(text.includes(body), 'follow-up sends exact original file bytes');
			else if (nativeBaseline) {
				assert(text.includes(body.replace(/\r\n/g, '\n')), 'native user-interjection rendering normalizes CRLF');
				nativeSteerAttachment = text.slice(text.indexOf('<file path='));
			} else assert.equal(text.slice(text.indexOf('<file path=')), nativeSteerAttachment, 'template steering preserves native provider rendering without additional changes');
		}
	}
	// Frozen history survives Stop/reopen and deletion of the original file.
	const user = client.session.state.messages.find(message => message.role === 'user' && message.questionText === 'RENDERED one two three');
	assert(user?.entryId); assert.equal(user.userAttachments.length, 1);
	await client.abort(); await client.session.open(); rmSync(file);
	const beforeEdit = requests.length;
	await client.handle({ type: 'edit_message', conversationId: client.conversationId, entryId: user.entryId, text: '/fixture-template edited', attachments: user.userAttachments.map(item => ({ nativeRef: item.nativeRef })) });
	await settled(); assert.equal(requests.length, beforeEdit + 1); assert(requestText().includes('RENDERED edited')); assert(requestText().includes(body));
	// Stop while a native input hook owns admission cannot run the deferred template.
	writeFileSync(file, body);
	const beforeStop = requests.length, pending = client.prompt('HOOK_HOLD /fixture-template stopped', attachment());
	await wait(() => readLines(hooks).some(item => item.text.startsWith('HOOK_HOLD')), 'held input hook');
	await client.abort(); await pending; writeFileSync(releaseHook, 'release');
	assert.equal(requests.length, beforeStop); assert.equal(client.session.generation, undefined);
	console.log('PASS OMP template attachments: exact bytes, native expansion and priority, hooks once, generated slash as text, extension completion, queue recall/delivery, frozen edit/reopen and Stop before admission');
} finally {
	for (const release of held.splice(0)) release();
	await client?.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
