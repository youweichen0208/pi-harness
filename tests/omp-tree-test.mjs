import { snapshotStates } from "./lib/snapshots.mjs";
/** Native tree writes stay bound to the conversation that admitted them. */
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
const root = mkdtempSync(join(tmpdir(), 'omp-tree-')), agent = join(root, 'omp/agent');
mkdirSync(agent, { recursive: true });
const summaryPreparation = join(root, 'summary-preparation.json');
mkdirSync(join(agent, 'extensions'));
writeFileSync(join(agent, 'extensions/summary-probe.js'), `import { writeFileSync } from 'node:fs'; export default api => api.on('session_before_tree', event => { const p = event.preparation; writeFileSync(${JSON.stringify(summaryPreparation)}, JSON.stringify({ targetId: p.targetId, entryCount: p.entriesToSummarize.length, commonAncestorId: p.commonAncestorId })); });`);
const requests = [], events = [];
let hang = false, fail = false, client, abortedBodies = 0;
const provider = createServer(async (req, res) => {
	let raw = '';
	try { for await (const part of req) raw += part; }
	catch (error) {
		if (req.aborted && error.code === 'ECONNRESET') { abortedBodies++; return; }
		throw error;
	}
	requests.push(JSON.parse(raw));
	if (fail) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'SUMMARY_FIXTURE_DENIED' } })); return; }
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: `m${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	if (hang) return;
	emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
	emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Native tree fixture response.' } });
	emit('content_block_stop', { index: 0 });
	emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } });
	emit('message_stop', {}); res.end();
});
const wait = async (test, label) => { for (let i = 0; i < 1000; i++) { if (test()) return; await new Promise(r => setTimeout(r, 20)); } throw Error(`Timed out ${label}`); };
try {
	const port = await listenIsolated(provider);
	// Cancellation can close an upload before the fixture has its whole JSON body.
	// Exercise that exact HTTP path before the native tree cancellation scenarios.
	const incoming = new Promise(resolve => provider.once('request', resolve));
	const unfinished = request({ hostname: '127.0.0.1', port, method: 'POST', headers: { 'content-length': '100' } });
	unfinished.on('error', () => {});
	unfinished.write('{');
	const partial = await incoming;
	const dropped = new Promise(resolve => partial.once('aborted', resolve));
	unfinished.destroy();
	await dropped;
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(abortedBodies, 1, 'fixture observes incomplete cancelled uploads');
	assert.equal(requests.length, 0, 'incomplete JSON is not a model request');
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 200000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ treeFilterMode: "user-only", skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	client = new OmpClientSession('tree', root, new ClientStateStore(join(root, 'client-state.json')));
	client.attachSink(event => events.push(event), false);
	await client.initialize(); await client.setModel('fixture/fixture');
	const first = client.conversationId;
	client.flushSnapshot(true);
	assert(snapshotStates(events).at(-1)?.tree?.revision, 'snapshot contains native tree metadata');
	assert.equal(snapshotStates(events).at(-1).tree.filterMode, 'user-only', 'native configuration controls the initial tree filter');
	for (const text of ['First user request', 'Second user request']) {
		await client.prompt(text); await wait(() => !client.session.state.running, 'initial reply');
	}
	await client.session.refresh();
	const originalRevision = client.session.state.tree.revision;
	const originalBranchLeaf = client.session.state.tree.leafId;
	const sessionFile = client.session.state.sessionFile;
	const user = client.session.state.messages.find(message => message.role === 'user');
	assert(user?.entryId);
	await client.handle({ type: 'edit_message', conversationId: first, entryId: user.entryId, text: 'Edited first request' });
	await wait(() => !client.session.state.running, 'edited reply');
	assert.equal(client.session.state.sessionFile, sessionFile, 'edit stays in native file');
	assert(client.session.state.messages.some(message => message.role === 'user' && message.content.some(block => block.text === 'Edited first request')));
	const entries = (await client.session.command('get_entries')).data;
	assert(entries.entries.some(entry => entry.id === user.entryId), 'abandoned original branch is retained');
	await client.session.refresh(); client.flushSnapshot(true);
	const editedState = snapshotStates(events).at(-1);
	assert(editedState.tree.branchPoints > 0); assert.notEqual(editedState.tree.revision, originalRevision);
	const edited = client.session.state.messages.find(message => message.role === 'user');
	assert.equal(edited.siblings.count, 2); assert.equal(edited.siblings.prevTarget, originalBranchLeaf);
	const beforePreview = requests.length, previewGeneration = client.session.generation;
	await client.handle({ type: 'tree_preview', conversationId: first, reqId: 'branch-preview', targetId: originalBranchLeaf });
	const preview = events.find(event => event.type === 'tree_preview_result' && event.reqId === 'branch-preview');
	assert(preview && Number.isInteger(preview.entryCount), 'preview must return the native summary entry count');
	const entryMap = new Map(entries.entries.map(entry => [entry.id, entry]));
	const path = id => { const found = []; while (id) { found.push(id); id = entryMap.get(id)?.parentId; } return found; };
	const oldPath = path(entries.leafId), targetPath = new Set(path(originalBranchLeaf));
	const commonAncestor = oldPath.find(id => targetPath.has(id)) ?? null;
	assert.equal(preview.commonAncestorId, commonAncestor);
	assert.equal(preview.entryCount, commonAncestor === null ? oldPath.length : oldPath.indexOf(commonAncestor));
	assert(preview.entryCount > 0);
	assert.equal(client.session.generation, previewGeneration); assert.equal(requests.length, beforePreview);
	assert.deepEqual((await client.session.command('get_entries')).data, entries, 'preview does not navigate or append');
	await client.handle({ type: 'tree_preview', conversationId: first, reqId: 'same-leaf-preview', targetId: entries.leafId });
	assert.equal(events.find(event => event.reqId === 'same-leaf-preview')?.entryCount, 0);
	await client.handle({ type: 'tree_preview', conversationId: first, reqId: 'foreign-preview', targetId: 'foreign-entry' });
	assert(!events.some(event => event.reqId === 'foreign-preview' && event.type === 'tree_preview_result'));
	// Preview after Stop uses the frozen native tree and cannot open an Agent.
	await client.abort(); const stoppedGeneration = client.session.generation, savedBytes = readFileSync(sessionFile);
	await client.handle({ type: 'tree_preview', conversationId: first, reqId: 'stopped-preview', targetId: originalBranchLeaf });
	const stoppedPreview = events.find(event => event.reqId === 'stopped-preview' && event.type === 'tree_preview_result');
	assert.equal(stoppedPreview?.entryCount, preview.entryCount); assert.equal(stoppedPreview?.commonAncestorId, preview.commonAncestorId);
	assert.equal(await client.session.requestIfOpen('get_state'), undefined);
	assert.equal(client.session.generation, stoppedGeneration); assert.equal(requests.length, beforePreview);
	assert.deepEqual(readFileSync(sessionFile), savedBytes);
	for (const [reqId, options] of [
		['replace-unsupported', { summary: 'custom', customInstructions: 'REPLACE_PRIVATE', replaceInstructions: true }],
		['empty-custom', { summary: 'custom', customInstructions: '  ' }],
		['oversize-custom', { summary: 'custom', customInstructions: 'x'.repeat(16001) }],
		['invalid-custom', { summary: 'custom', customInstructions: {} }],
	]) {
		await client.handle({ type: 'tree_navigate', conversationId: first, reqId, targetId: originalBranchLeaf, ...options });
		assert(events.some(event => event.reqId === reqId && event.type === 'tree_navigate_result' && event.status === 'error'), reqId);
		assert.equal(await client.session.requestIfOpen('get_state'), undefined, 'invalid summary must not reopen the worker');
	}
	assert.equal(requests.length, beforePreview); assert.deepEqual(readFileSync(sessionFile), savedBytes);
	await client.session.open(); await client.session.refresh();

	const countBeforeNavigation = requests.length;
	await client.handle({ type: 'tree_navigate', conversationId: first, reqId: 'previous-branch', targetId: edited.siblings.prevTarget, summary: 'none' });
	assert(client.session.state.messages.some(message => message.content.some(block => block.text === 'Second user request')), 'sibling restores retained branch through its tip');
	const original = client.session.state.messages.find(message => message.entryId === user.entryId);
	assert.equal(original.siblings.count, 2); assert(original.siblings.nextTarget);
	await client.handle({ type: 'tree_navigate', conversationId: first, reqId: 'next-branch', targetId: original.siblings.nextTarget, summary: 'none' });
	assert(client.session.state.messages.some(message => message.content.some(block => block.text === 'Edited first request')));
	assert.equal(requests.length, countBeforeNavigation, 'sibling navigation never calls the model');
	const beforeLabel = client.session.state.tree.revision;
	await client.handle({ type: 'tree_label', conversationId: first, reqId: 'bookmark', entryId: edited.entryId, label: 'Branch bookmark' });
	assert.equal(client.session.state.messages.find(message => message.entryId === edited.entryId).label, 'Branch bookmark');
	assert.notEqual(client.session.state.tree.revision, beforeLabel);
	await client.handle({ type: 'tree_get', conversationId: first, reqId: 'revision-parity', filter: 'all' });
	assert.equal(events.find(event => event.type === 'tree' && event.reqId === 'revision-parity').revision, client.session.state.tree.revision);
	const listed = await client.nativeSessions();
	assert.equal(listed.find(item => item.path === sessionFile)?.branchPoints, client.session.state.tree.branchPoints, 'disk listing and active snapshot agree');
	await client.handle({ type: 'tree_label', conversationId: first, reqId: 'bookmark-clear', entryId: edited.entryId, label: null });
	assert.equal(client.session.state.messages.find(message => message.entryId === edited.entryId).label, undefined);
	assert(events.filter(event => event.type === 'conversations').at(-1).conversations.find(item => item.id === first).branchPoints > 0);

	// Native attachment references must freeze the full body before any fork.
	const inlinePath = join(root, 'inline.txt'), linesPath = join(root, 'lines.txt'), editorPath = join(root, 'editor.txt');
	writeFileSync(inlinePath, 'ORIGINAL_INLINE'); writeFileSync(linesPath, 'first\nORIGINAL_LINES\nlast'); writeFileSync(editorPath, 'saved disk body');
	const draft = 'UNSAVED_EDITOR_' + 'x'.repeat(210000) + '_END_OF_FROZEN_EDITOR';
	await client.prompt('Attachment question', [
		{ path: inlinePath, mode: 'inline' }, { path: linesPath, mode: 'lines', lines: { start: 2, end: 2 } },
		{ path: editorPath, mode: 'inline', editorSnapshot: { cwd: root, text: draft, dirty: true } },
		{ path: inlinePath, mode: 'reference' },
	]);
	await wait(() => !client.session.state.running, 'attachment reply'); await client.session.refresh();
	let attachedUser = client.session.state.messages.find(message => message.questionText === 'Attachment question');
	assert(attachedUser?.entryId); assert.equal(attachedUser.userAttachments.length, 4);
	assert(attachedUser.userAttachments.every(attachment => attachment.preview.length <= 12000));
	assert(!JSON.stringify(attachedUser).includes('_END_OF_FROZEN_EDITOR'), 'UI copy really is bounded');
	writeFileSync(inlinePath, 'CHANGED_DISK_INLINE'); writeFileSync(linesPath, 'CHANGED_DISK_LINES'); rmSync(editorPath);
	for (const newSession of [false, true]) {
		const beforeEdit = client.session.state.sessionFile;
		await client.handle({ type: 'edit_message', conversationId: first, entryId: attachedUser.entryId, text: 'Edited attachments', newSession,
			attachments: attachedUser.userAttachments.map(attachment => ({ path: 'UNTRUSTED_CLIENT_PATH', mode: 'reference', nativeRef: attachment.nativeRef })) });
		await wait(() => !client.session.state.running, 'attachment edit'); await client.session.refresh();
		assert.equal(client.session.state.sessionFile === beforeEdit, !newSession);
		const body = requests.at(-1).messages.filter(message => message.role === 'user').at(-1).content;
		const text = typeof body === 'string' ? body : body.filter(block => block.type === 'text').map(block => block.text).join('\n');
		assert.match(text, /(?:^|\n)Edited attachments\n/);
		for (const frozen of ['ORIGINAL_INLINE', 'ORIGINAL_LINES', draft]) assert(text.includes(frozen), 'full original attachment preserved');
		for (const stale of ['CHANGED_DISK_INLINE', 'CHANGED_DISK_LINES', 'UNTRUSTED_CLIENT_PATH']) assert(!text.includes(stale));
		attachedUser = client.session.state.messages.findLast(message => message.role === 'user');
		assert.equal(attachedUser.userAttachments.length, 4);
	}
	// Validation failure cannot navigate, fork, append history or send a request.
	for (const attachments of [
		[{ path: inlinePath, nativeRef: { entryId: 'foreign-entry', index: 0 } }],
		[{ path: inlinePath, nativeRef: { entryId: attachedUser.entryId, index: 99 } }],
		[{ path: inlinePath, editorSnapshot: { cwd: root + '-other', text: 'invalid', dirty: true } }],
	]) {
		const before = (await client.session.command('get_entries')).data;
		const file = client.session.state.sessionFile, count = requests.length;
		await client.handle({ type: 'edit_message', conversationId: first, entryId: attachedUser.entryId, text: 'MUST_NOT_SEND', newSession: true, attachments });
		assert.deepEqual((await client.session.command('get_entries')).data, before);
		assert.equal(client.session.state.sessionFile, file); assert.equal(requests.length, count);
	}
	await client.abort(); await client.session.open(); await client.session.refresh();
	attachedUser = client.session.state.messages.findLast(message => message.role === 'user');
	assert.equal(attachedUser.userAttachments.length, 4, 'restore derives cards from the native transcript');
	await client.prompt('Continue with frozen editor', [{ path: 'ignored', nativeRef: attachedUser.userAttachments[2].nativeRef }]);
	await wait(() => !client.session.state.running, 'restored attachment prompt');
	assert(JSON.stringify(requests.at(-1).messages).includes('_END_OF_FROZEN_EDITOR'));
	// Use a target from the current fork for the cancellation exercise below.
	const currentEntries = (await client.session.command('get_entries')).data;
	await client.newChat(); const second = client.conversationId;
	const beforeForeign = requests.length;
	await client.prompt('Foreign attachment must fail', [{ path: inlinePath, nativeRef: attachedUser.userAttachments[0].nativeRef }], undefined, 'foreign-attachment');
	assert(events.some(event => event.type === 'prompt_result' && event.requestId === 'foreign-attachment' && event.receipt === 'rejected'));
	assert.equal(requests.length, beforeForeign, 'another conversation cannot resolve this native entry');
	await client.switchConversation(first);
	const target = currentEntries.entries.find(entry => entry.type === 'message' && entry.message.role === 'assistant').id;
	// A dedicated cancellation leaves this worker/history and a background task intact.
	hang = true;
	await client.switchConversation(second); const background = client.session;
	const beforeBackground = requests.length; await client.prompt('BACKGROUND_TASK');
	await wait(() => requests.length > beforeBackground, 'background request');
	const backgroundGeneration = background.generation;
	await client.handle({ type: 'tree_navigate', conversationId: second, reqId: 'invalid-running-summary', targetId: background.state.tree.leafId, summary: 'custom', customInstructions: {}, abortRunning: true });
	assert(events.some(event => event.reqId === 'invalid-running-summary' && event.type === 'tree_navigate_result' && event.status === 'error'));
	assert.equal(background.generation, backgroundGeneration); assert.equal(background.state.running, true, 'invalid options cannot stop a running task');

	await client.switchConversation(first);
	const originalLeaf = (await client.session.command('get_entries')).data.leafId;
	const originalGeneration = client.session.generation;
	const beforeDedicated = requests.length;
	const dedicated = client.handle({ type: 'tree_navigate', conversationId: first, reqId: 'dedicated', targetId: target, summary: 'default' });
	await wait(() => requests.length > beforeDedicated, 'dedicated branch summary');
	const operation = snapshotStates(events).at(-1).branchSummary; assert(operation?.operationId);
	const beforeMalformed = events.length;
	await client.handle({ type: 'tree_cancel_summary', conversationId: first, operationId: operation.operationId });
	assert(!events.slice(beforeMalformed).some(event => event.type === 'tree_cancel_result'), 'invalid request IDs cannot create malformed responses');
	await client.handle({ type: 'tree_cancel_summary', conversationId: second, reqId: 'wrong-owner', operationId: operation.operationId });
	await client.handle({ type: 'tree_cancel_summary', conversationId: first, reqId: 'wrong-operation', operationId: 'stale-id' });
	assert(events.some(event => event.type === 'tree_cancel_result' && event.reqId === 'wrong-owner' && event.status === 'stale'));
	assert(events.some(event => event.type === 'tree_cancel_result' && event.reqId === 'wrong-operation' && event.status === 'stale'));
	const beforeCancel = Date.now();
	await Promise.all(['cancel', 'duplicate-cancel'].map(reqId => client.handle({ type: 'tree_cancel_summary', conversationId: first, reqId, operationId: operation.operationId })));
	await dedicated; assert(Date.now() - beforeCancel < 5000);
	assert(events.some(event => event.type === 'tree_navigate_result' && event.reqId === 'dedicated' && event.status === 'aborted'));
	assert.equal(client.session.generation, originalGeneration);
	assert.equal((await client.session.command('get_entries')).data.leafId, originalLeaf);
	assert.equal(snapshotStates(events).at(-1).branchSummary, undefined);
	assert.equal(background.generation, backgroundGeneration); assert.equal(background.state.running, true);
	assert.equal(requests.length, beforeDedicated + 1);
	// Cancel before native navigate_tree is admitted. The first native abort is
	// deliberately too early; the same operation must still cancel after admission.
	const session = client.session, nativeCommand = session.command.bind(session), nativeRequest = session.requestIfOpen.bind(session);
	let releaseNavigation, held = false, cancellationCalls = 0;
	session.command = async (command, ...args) => { if (command === 'navigate_tree') { held = true; await new Promise(resolve => { releaseNavigation = resolve; }); } return nativeCommand(command, ...args); };
	session.requestIfOpen = async (command, ...args) => { if (command === 'abort_branch_summary') cancellationCalls++; return nativeRequest(command, ...args); };
	const early = client.handle({ type: 'tree_navigate', conversationId: first, reqId: 'early', targetId: target, summary: 'default' });
	await wait(() => held, 'held native navigation');
	const earlyOperation = snapshotStates(events).at(-1).branchSummary; assert(earlyOperation);
	await client.handle({ type: 'tree_cancel_summary', conversationId: first, reqId: 'old-id', operationId: operation.operationId });
	assert.equal(cancellationCalls, 0, 'stale operation cannot cancel a successor');
	await client.handle({ type: 'tree_cancel_summary', conversationId: first, reqId: 'early-cancel', operationId: earlyOperation.operationId });
	await wait(() => cancellationCalls >= 2, 'cancellation before native controller initialization');
	releaseNavigation(); await early;
	session.command = nativeCommand; session.requestIfOpen = nativeRequest;
	assert(events.some(event => event.type === 'tree_navigate_result' && event.reqId === 'early' && event.status === 'aborted'));
	assert.equal((await session.command('get_entries')).data.leafId, originalLeaf);
	assert.equal(session.generation, originalGeneration);
	assert.equal(background.state.running, true);
	// Once cancelled, normal requests continue without reopening or replaying.
	hang = false; const beforeContinue = requests.length;
	await client.prompt('CONTINUE_AFTER_SUMMARY_CANCEL'); await wait(() => !session.state.running, 'continue after summary cancel');
	assert.equal(requests.length, beforeContinue + 1); assert.equal(session.generation, originalGeneration);
	await client.switchConversation(second); await client.abort(); await client.switchConversation(first);
	const beforeSummary = requests.length; hang = true;
	const navigation = client.handle({ type: 'tree_navigate', conversationId: first, reqId: 'summary', targetId: target, summary: 'default' });
	await wait(() => requests.length > beforeSummary, 'native branch summary request');
	assert.equal(client.activeConversations(), 1, 'native summary keeps the product task busy');
	assert.equal(snapshotStates(events).at(-1).isStreaming, true);
	await assert.rejects(client.switchConversation(second), /in progress/);
	await assert.rejects(client.newChat(), /in progress/);
	await client.setCwd(root, 'blocked-cwd');
	assert(events.some(event => event.type === 'cwd_result' && event.requestId === 'blocked-cwd' && !event.ok));
	await client.prompt('MUST_NOT_BE_SENT', undefined, undefined, 'during-tree');
	assert(events.some(event => event.type === 'prompt_result' && event.requestId === 'during-tree' && event.receipt === 'rejected'));
	await client.handle({ type: 'tree_label', conversationId: first, reqId: 'competing-write', entryId: target, label: 'blocked' });
	assert(events.some(event => event.type === 'tree_navigate_result' && event.reqId === 'competing-write' && event.status === 'busy'));
	assert.equal(client.conversationId, first);
	const stopStarted = Date.now();
	await client.abort(); await navigation;
	assert(Date.now() - stopStarted < 5000, 'Stop must overtake the native summary, not wait for an RPC timeout');
	assert(!events.some(event => event.type === 'tree_navigate_result' && event.reqId === 'summary' && event.status === 'ok'));
	assert.equal(client.session.state.running, false);
	assert.equal(requests.length, beforeSummary + 1, 'Stop never repeats a summary or rejected prompt');
	await client.switchConversation(second);
	assert.equal(client.conversationId, second, 'operation releases ownership after Stop');
	// Independent cancellation must not alter the ordinary successful summary path.
	hang = false; await client.switchConversation(first);
	await client.prompt('A fresh turn for successful navigation'); await wait(() => !client.session.state.running, 'post-Stop reply');
	const successfulGeneration = client.session.generation, beforeSuccess = requests.length;
	await client.handle({ type: 'tree_preview', conversationId: first, reqId: 'successful-preview', targetId: target });
	await client.handle({ type: 'tree_navigate', conversationId: first, reqId: 'successful-summary', targetId: target, summary: 'custom', customInstructions: 'SUMMARY_CUSTOM_SENTINEL: preserve unresolved questions.' });
	assert(events.some(event => event.type === 'tree_navigate_result' && event.reqId === 'successful-summary' && event.status === 'ok'));
	assert.equal(requests.length, beforeSuccess + 1);
	const actualPreparation = JSON.parse(readFileSync(summaryPreparation, 'utf8'));
	const successPreview = events.find(event => event.reqId === 'successful-preview' && event.type === 'tree_preview_result');
	assert.equal(actualPreparation.targetId, target);
	assert.equal(successPreview?.entryCount, actualPreparation.entryCount, 'preview count equals native navigation preparation');
	assert.equal(successPreview?.commonAncestorId, actualPreparation.commonAncestorId);
	assert(JSON.stringify(requests.at(-1).messages).includes('SUMMARY_CUSTOM_SENTINEL: preserve unresolved questions.'), 'native summarizer receives custom instructions');
	assert.equal(client.session.generation, successfulGeneration);
	assert.equal(snapshotStates(events).at(-1).branchSummary, undefined);
	assert((await client.session.command('get_entries')).data.entries.some(entry => entry.type === 'branch_summary'));
	await client.prompt('A turn before rejected summary'); await wait(() => !client.session.state.running, 'pre-error reply');
	const errorLeaf = (await client.session.command('get_entries')).data.leafId, beforeFailure = requests.length;
	fail = true;
	await client.handle({ type: 'tree_navigate', conversationId: first, reqId: 'failed-summary', targetId: target, summary: 'default' });
	assert(events.some(event => event.type === 'tree_navigate_result' && event.reqId === 'failed-summary' && event.status === 'error'));
	assert.equal(snapshotStates(events).at(-1).branchSummary, undefined);
	assert.equal((await client.session.command('get_entries')).data.leafId, errorLeaf);
	assert.equal(requests.length, beforeFailure + 1, 'rejected summary is never replayed');


	console.log('PASS OMP native tree: in-place/fork frozen attachment edits, full-body restore, pre-navigation validation, original branches retained, concurrent navigation/prompt rejected, operation-bound cancellation before/after native admission, continued work/background isolation and Stop releases ownership');
} finally {
	await client?.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
