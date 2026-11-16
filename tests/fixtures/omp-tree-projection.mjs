/** Compare Web tree output with the installed native selector, without a model. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectEntriesForBranchSummary } from '@oh-my-pi/pi-agent-core/compaction';
import { memoryNativeTree, nativeTree, savedNativeTree } from '../../dist/server/omp/tree-native.js';
import { OmpHistoryMetadata } from '../../dist/server/omp/history-metadata.js';
import { SessionManager } from '@oh-my-pi/pi-coding-agent';
import { TreeSelectorComponent } from '@oh-my-pi/pi-tui/overlays/tree-selector';
import { ensureTheme } from '@oh-my-pi/pi-tui/theme';
import { readTree } from '../../dist/server/omp/tree.js';
await ensureTheme();
const manager = SessionManager.inMemory(process.cwd());
const user = text => manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
const assistant = (text, stopReason = 'stop') => manager.appendMessage({ role: 'assistant', content: text ? [{ type: 'text', text }] : [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'fixture.txt' } }], stopReason, model: 'fixture', provider: 'fixture', api: 'anthropic-messages', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const root = user('Root question');
const old = assistant('Old branch answer');
user('Old branch next question');
manager.branch(root);
const active = assistant('Active branch answer');
const toolOnly = assistant('', 'toolUse');
const tool = manager.appendMessage({ role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'A tool result' }], isError: false, timestamp: Date.now() });
const failed = assistant('', 'error');
manager.appendCustomEntry('fixture-metadata', { private: 'never in preview' });
const long = user('x'.repeat(220) + ' beyondsearchcap');
manager.appendLabelChange(old, 'Bookmark blue');
const leaf = user('Final question with separated alpha and omega');
manager.appendCustomMessageEntry('skill-prompt', '<system-skill>Expanded skill</system-skill>', true, { name: 'fixture', prompt: '/skill:fixture inspect' }, 'user');
manager.appendCustomMessageEntry('advisor', '<advisory>PRIVATE_WRAPPER</advisory>', true, { notes: [{ advisor: 'security', severity: 'blocker', note: 'Check escaping' }] });
let before = JSON.stringify(manager.getEntries());
const session = { treeData: (filter, query, previewTarget) => session.command("harness_tree", { filter, query, previewTarget }), command: async (command, args) => {
	if (command === 'get_entries') return { data: { entries: manager.getEntries(), leafId: manager.getLeafId() } };
	if (command === 'harness_tree') {
		const { nativeTree } = await import('../../dist/server/omp/tree-native.js');
		return { data: nativeTree(manager, args.filter, args.query, args.previewTarget) };
	}
	throw Error(command);
} };
function nativeIds(filter, query) {
	const selector = new TreeSelectorComponent(manager.getTree(), manager.getLeafId(), 30, () => assert.fail('selection must be read only'), () => assert.fail('cancel must be read only'), undefined, filter);
	try {
		// Public input handling, independent from the product adapter.
		if (query) selector.handleInput(`\x1b[200~${query}\x1b[201~`);
		return [...selector.getTreeList().pickerView().order];
	} finally { selector.dispose(); }
}
try {
	const checkPreviews = async targets => {
		const originalLeaf = manager.getLeafId(), originalBytes = JSON.stringify(manager.getEntries());
		for (const target of targets) {
			const expected = collectEntriesForBranchSummary(manager, originalLeaf, target);
			const expectedPreview = { entryCount: expected.entries.length, commonAncestorId: expected.commonAncestorId };
			const live = await readTree(session, 'all', '', target);
			assert.deepEqual(live.preview, expectedPreview);
			const frozen = await memoryNativeTree({ entries: manager.getEntries(), leafId: originalLeaf, sessionId: manager.getSessionId() }, { filter: 'all', query: '', previewTarget: target });
			assert.deepEqual(frozen.preview, expectedPreview, 'stopped-memory and live preview agree with public native collector');
		}
		assert.equal(manager.getLeafId(), originalLeaf); assert.equal(JSON.stringify(manager.getEntries()), originalBytes);
	};
	await checkPreviews([root, old, active, tool, leaf, manager.getLeafId()]);
	const initialLeaf = manager.getLeafId();
	const compacted = manager.appendCompaction('Compacted branch summary', undefined, root, 1000);
	manager.appendCustomEntry('after-compaction', {});
	await checkPreviews([old, compacted, initialLeaf]);
	assert((await readTree(session, 'all', '', old)).preview.entryCount >= 2, 'compaction does not stop native summary collection');
	manager.branch(initialLeaf);
	before = JSON.stringify(manager.getEntries());

	assert.throws(() => nativeTree(manager, 'all', '', 'missing-entry'), /Unknown tree entry/);
	const filtered = await readTree(session, 'default');
	assert(filtered.nodes.some(n => n.id === tool), 'native default includes tool results');
	assert(!filtered.nodes.some(n => n.id === toolOnly), 'non-leaf tool-only assistant is hidden');
	assert(filtered.nodes.some(n => n.id === failed), 'empty failed assistant remains visible');
	assert(filtered.nodes.findIndex(n => n.id === active) < filtered.nodes.findIndex(n => n.id === old), 'active branch precedes older branch');
	for (const filter of ['default', 'no-tools', 'user-only', 'labeled-only', 'all']) for (const query of ['', 'alpha omega', 'alp om', 'bookmark', 'beyondsearchcap', 'tool result', 'assistant', 'skill', 'security escaping', 'PRIVATE_WRAPPER']) {
		const result = await readTree(session, filter, query);
		assert.deepEqual(result.nodes.map(n => n.id), nativeIds(filter, query), `${filter}: ${query}`);
	}
	const labeled = await readTree(session, 'labeled-only');
	assert.equal(labeled.nodes.find(node => node.id === old)?.label, 'Bookmark blue');
	assert(!(await readTree(session, 'all', 'beyondsearchcap')).nodes.some(node => node.id === long));
	await assert.rejects(readTree(session, 'not-a-filter'), /Invalid tree filter/);
	await assert.rejects(readTree(session, 'all', {}), /Invalid tree filter/);
	assert.equal(JSON.stringify(manager.getEntries()), before, 'read-only projection never changes history');
	manager.appendLabelChange(old, undefined);
	assert(!(await readTree(session, 'labeled-only')).nodes.some(node => node.id === old), 'native label clear is reflected');
	manager.resetLeaf();
	const secondRoot = user('Independent root');
	await checkPreviews([root, old, secondRoot]);
	const multi = await readTree(session, 'all');
	assert.equal(multi.nodes[0].id, secondRoot, 'active root comes first');
	assert.equal(multi.nodes.find(node => node.id === old)?.rootId, root);
	const emptyLeaf = assistant('', 'toolUse');
	assert((await readTree(session, 'all')).nodes.some(node => node.id === emptyLeaf), 'current empty assistant leaf remains selectable');
	for (let i = 0; i < 10000; i++) user(`Long history ${i === 9999 ? 'unique-tail' : i}`);
	const started = performance.now();
	const large = await readTree(session, 'user-only', 'unique-tail');
	assert.equal(large.nodes.length, 1, 'filter runs before the output cap');
	assert.equal(large.truncated, false);
	const elapsed = performance.now() - started;
	const capped = await readTree(session, 'user-only');
	assert.equal(capped.nodes.length, 5000); assert.equal(capped.truncated, true);
	assert(elapsed < 3000, `10k native projection exceeded 3s: ${elapsed}ms`);
	console.log(`10k native projection: ${Math.round(elapsed)}ms`);
	manager.resetLeaf();
	await checkPreviews([root, secondRoot]);
	const directory = join(process.env.PI_CODING_AGENT_DIR, 'history-fixture'); mkdirSync(directory, { recursive: true });
	const disk = SessionManager.create(process.cwd(), directory), history = new OmpHistoryMetadata();
	try {
		await disk.ensureOnDisk();
		const a = disk.appendMessage({ role: 'user', content: 'disk question', timestamp: 1 });
		disk.appendCustomEntry('old branch', {}); disk.branch(a); disk.appendCustomEntry('new branch', {}); await disk.flush();
		const file = disk.getSessionFile(), bytes = readFileSync(file);
		assert.equal(await history.branchPoints(file), 1); assert.equal(await history.branchPoints(file), 1);
		assert.deepEqual(readFileSync(file), bytes, 'counting and cache hits never rewrite native files');
		const savedTree = await savedNativeTree(file, { filter: 'all', query: '', leafId: a, sessionId: disk.getSessionId() });
		const savedPreview = await savedNativeTree(file, { filter: 'all', query: '', sessionId: disk.getSessionId(), previewTarget: a });
		assert.deepEqual(savedPreview.preview, { entryCount: 1, commonAncestorId: a });
		assert.equal(savedTree.leafId, a, 'read-only native tree preserves explicitly selected branch');
		assert.deepEqual(readFileSync(file), bytes);
		await assert.rejects(savedNativeTree(file, { filter: 'all', query: '', leafId: 'missing-entry' }), /selected leaf/);
		await assert.rejects(savedNativeTree(file, { filter: 'all', query: '', sessionId: 'foreign-session' }), /changed or is invalid/);

		const second = disk.appendMessage({ role: 'user', content: 'another branch', timestamp: 2 });
		disk.appendCustomEntry('second old', {}); disk.branch(second); disk.appendCustomEntry('second new', {}); await disk.flush();
		assert.equal(await history.branchPoints(file), 2, 'native append invalidates the cached count');
		const empty = join(directory, 'empty.jsonl'), bad = join(directory, 'bad.jsonl');
		writeFileSync(empty, ''); writeFileSync(bad, '{invalid');
		assert.equal(await history.branchPoints(empty), undefined); assert.equal(await history.branchPoints(bad), undefined);
		assert.equal(readFileSync(empty, 'utf8'), ''); assert.equal(readFileSync(bad, 'utf8'), '{invalid');
		const info = { path: file, id: disk.getSessionId(), cwd: process.cwd(), created: new Date(1), modified: new Date(2), messageCount: 2, firstMessage: 'disk question', allMessagesText: '', size: readFileSync(file).length, parentSessionPath: '/fixture/parent.jsonl' };
		const rows = await history.list([info]); assert.equal(rows[0].branchPoints, 2); assert.equal(rows[0].parentSessionPath, info.parentSessionPath);
		const many = Array.from({ length: 205 }, (_, index) => ({ ...info, id: String(index), modified: new Date(index) }));
		const limited = await history.list(many); assert.equal(limited.length, 200); assert.equal(limited[0].id, '204'); assert.equal(limited.at(-1).id, '5');
	} finally { await disk.close(); }

	console.log('PASS native tree projection: five filters, fuzzy terms, labels, active-first ordering, empty errors and bounded search');
} finally { await manager.close(); }
