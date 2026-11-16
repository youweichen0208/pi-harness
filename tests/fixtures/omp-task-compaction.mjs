/** Uses the native public SessionManager writer only on an already closed fixture transcript. */
import assert from 'node:assert/strict';
import { realpathSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const [file, mode = 'compact', leaf, applicationRoot] = process.argv.slice(2);
assert(applicationRoot, 'Select the application whose native history is under test');
const root = realpathSync(applicationRoot);
const assertInside = file => {
	const actual = realpathSync(file), inside = relative(root, actual);
	assert(!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep), `Native compaction must use the selected application runtime: ${JSON.stringify({ root, requested: file, actual, relative: inside })}`);
};
assertInside(process.execPath);
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(Bun.version, manifest.dependencies.bun);
assert.equal(JSON.parse(readFileSync(join(root, 'node_modules/@oh-my-pi/pi-coding-agent/package.json'), 'utf8')).version, manifest.dependencies['@oh-my-pi/pi-coding-agent']);
const loadNative = async name => {
	// A file-URL parent can fall back to Bun's global install cache on Windows.
	// Use the explicit filesystem directory and keep the resolved-path guard.
	const file = Bun.resolveSync(name, root);
	assertInside(file);
	return import(pathToFileURL(file).href);
};
const { SessionManager } = await loadNative('@oh-my-pi/pi-coding-agent');
const { loadSessionMessagesReadOnly } = await loadNative('@oh-my-pi/pi-coding-agent/session/session-loader');
const manager = await SessionManager.open(file, undefined, undefined, { throwIfMissing: true, suppressBreadcrumb: true });
const calls = messages => messages.filter(message => message.role === 'assistant').flatMap(message => message.content).filter(block => block.type === 'toolCall' && ['task', '_task'].includes(block.name)).length;
try {
	if (mode === 'compact') {
		const kept = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Continue after the finished nested task.' }], timestamp: Date.now() });
		manager.appendCompaction('Nested task finished; earlier history summarized.', undefined, kept, 10000);
	} else if (mode === 'hide') {
		const first = manager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'user');
		if (!first) throw Error('Missing initial user entry');
		manager.branch(first.id);
		manager.appendCustomEntry('fixture-child-branch', {});
	} else if (mode === 'restore') {
		manager.branch(leaf);
		manager.appendCustomEntry('fixture-child-restored', {});
	} else throw Error('Unknown fixture operation');
	await manager.flush();
	const branch = manager.getBranch();
	const collapsed = await loadSessionMessagesReadOnly(file);
	console.log(JSON.stringify({ leafId: manager.getLeafId(), hasCompaction: branch.some(entry => entry.type === 'compaction'), branchTaskCalls: calls(branch.flatMap(entry => entry.type === 'message' ? [entry.message] : [])), collapsedTaskCalls: calls(collapsed) }));
} finally { await manager.close(); }
