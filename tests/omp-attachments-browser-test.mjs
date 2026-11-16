import { mergeSnapshot } from "./lib/snapshots.mjs";
/** Real browser edit controls -> WebSocket -> OMP -> local model fixture. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness, listenIsolated } from './lib/isolated-server.mjs';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-attachments-ui-')));
const dataDir = join(root, 'data'), cwd = join(root, 'project'), agent = join(dataDir, 'omp/agent');
for (const path of [cwd, agent]) mkdirSync(path, { recursive: true });
const file = join(cwd, 'note.txt'); writeFileSync(file, 'disk original');
const skillMode = process.argv.includes('--skill');
const templateMode = process.argv.includes('--template');
assert(!(skillMode && templateMode), 'Choose one attachment fixture mode');
const originalQuestion = skillMode ? '/skill:fixture Original question' : templateMode ? '/fixture-template Original question' : 'Original question';
const editedQuestion = skillMode ? 'Use /skill:fixture for the edited question' : templateMode ? '/fixture-template Edited question' : 'Edited question';
const originalDraft = templateMode ? 'TEMPLATE Original question' : originalQuestion;
const editedDraft = templateMode ? 'TEMPLATE Edited question' : editedQuestion;
if (templateMode) {
	mkdirSync(join(agent, 'prompts'), { recursive: true });
	writeFileSync(join(agent, 'prompts/fixture-template.md'), 'TEMPLATE $@');
}
if (skillMode) {
	mkdirSync(join(agent, 'skills/fixture'), { recursive: true });
	writeFileSync(join(agent, 'skills/fixture/SKILL.md'), '---\nname: fixture\ndescription: Attachment history fixture\n---\nNATIVE_BROWSER_SKILL_BODY\n');
}
const requests = [];
const provider = createServer(async (req, res) => {
	let raw = ''; for await (const part of req) raw += part;
	requests.push(JSON.parse(raw));
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: `m${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
	emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Attachment fixture reply.' } });
	emit('content_block_stop', { index: 0 });
	emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
	emit('message_stop', {}); res.end();
});
let harness, browser, page;
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 200000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: skillMode, enableAgentsUser: false, enableAgentsProject: false, enablePiUser: false, enablePiProject: false, enableClaudeUser: false, enableClaudeProject: false, enableCodexUser: false, customDirectories: skillMode ? [join(agent, 'skills')] : [] }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	harness = await startIsolatedHarness({ env: { PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: cwd } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await page.addInitScript({ content: `window.mergeFixtureSnapshot = ${mergeSnapshot.toString()};` });
	await page.addInitScript(() => {
		const NativeSocket = window.WebSocket;
		window.WebSocket = class extends NativeSocket {
			constructor(...args) {
				super(...args); window.fixtureSocket = this;
				this.addEventListener('message', event => { const message = JSON.parse(event.data); window.fixtureState = window.mergeFixtureSnapshot(window.fixtureState, message); });
			}
		};
	});
	await page.goto(`http://127.0.0.1:${harness.port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	const send = message => page.evaluate(message => window.fixtureSocket.send(JSON.stringify(message)), message);
	await send({ type: 'set_model', modelId: 'fixture/fixture' });
	await page.waitForFunction(() => window.fixtureState?.model?.id === 'fixture');
	await send({ type: 'prompt', requestId: 'attachments-ui', text: originalQuestion, attachments: [
		{ path: file, mode: 'inline', editorSnapshot: { cwd, text: 'FROZEN_UNSAVED_EDITOR', dirty: true } },
		{ path: file, mode: 'inline' },
	] });
	await page.waitForFunction(() => window.fixtureState?.messages.some(message => message.userAttachments?.length === 2) && !window.fixtureState.isStreaming);
	assert.equal(await page.locator('.user-attachment-card').count(), 2);
	const card = page.locator('.user-attachment-card').first();
	await card.locator('summary').click(); assert((await card.locator('pre').innerText()).includes('FROZEN_UNSAVED_EDITOR'));
	writeFileSync(file, 'CHANGED_DISK_MUST_NOT_REPLACE_HISTORY');
	await page.getByRole('button', { name: '编辑重问', exact: true }).first().click();
	const editor = page.locator('.msg-editor-input');
	assert.equal(await editor.inputValue(), originalDraft);
	assert.equal(await page.locator('.msg-editor-img.file-chip').count(), 2);
	await editor.fill(editedQuestion); await editor.press('Control+Enter');
	await page.waitForFunction(question => window.fixtureState?.messages.some(message => message.questionText === question) && !window.fixtureState.isStreaming, editedDraft);
	assert.equal(requests.length, 2);
	const content = requests.at(-1).messages.filter(message => message.role === 'user').at(-1).content;
	const text = typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n');
	// Native OMP may prepend its date/cwd reminder at provider conversion time.
	if (skillMode) { assert(text.includes('NATIVE_BROWSER_SKILL_BODY')); assert(text.includes('for the edited question')); }
	else if (templateMode) assert(text.includes('TEMPLATE Edited question\n\nCurrent editor file:'));
	else assert.match(text, /(?:^|\n)Edited question\n\nCurrent editor file:/);
	assert(text.includes('FROZEN_UNSAVED_EDITOR')); assert(text.includes('disk original'));
	assert(!text.includes('CHANGED_DISK_MUST_NOT_REPLACE_HISTORY'));
	await page.reload(); await page.getByRole('button', { name: '编辑重问', exact: true }).first().click();
	assert.equal(await editor.inputValue(), editedDraft); assert.equal(await page.locator('.msg-editor-img.file-chip').count(), 2);
	mkdirSync('tests/scratch', { recursive: true });
	await page.screenshot({ path: `tests/scratch/omp-${skillMode ? 'skill-' : templateMode ? 'template-' : ''}attachments-edit.png`, animations: 'disabled' });
	console.log(`PASS OMP ${skillMode ? 'skill ' : templateMode ? 'template ' : ''}attachment browser: native cards, original draft/chips, actual edit submission freezes files and unsaved editor, reload restores references`);
} catch (error) {
	console.error(harness?.logs); console.error(await page?.locator('body').innerText().catch(() => ''));
	throw error;
} finally {
	await browser?.close(); await harness?.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
