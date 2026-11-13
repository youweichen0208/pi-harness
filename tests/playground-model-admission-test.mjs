import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubHostEnv } from './lib/test-env.mjs';
scrubHostEnv();
const root = mkdtempSync(join(tmpdir(), 'pg-model-admission-'));
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const { PlaygroundChat } = await import('../server/playground-chat.ts');
let chat;
try {
	chat = new PlaygroundChat(join(root, 'empty'));
	let state;
	const events = [];
	const reply = e => { events.push(e); if (e.type === 'playground_chat_state') state = e.state; };
	await chat.handle('test', { action: 'open', requestId: 'open' }, reply);
	await chat.handle('test', { action: 'send', requestId: 'hello', conversationId: state.id, text: 'hello', context: { code: '', parameters: '', output: '', partial: false, stale: false, truncated: false } }, reply);
	assert.equal(events.find(e => e.type === 'playground_chat_error')?.error, 'Error: pgChatModelUnavailable');
	assert.equal(state.model, undefined);
	await chat.close();
	mkdirSync(process.env.CLAUDE_CONFIG_DIR);
	writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8999', ANTHROPIC_MODEL: 'fixture-model' } }));
	chat = new PlaygroundChat(join(root, 'imported'));
	await chat.handle('test', { action: 'open', requestId: 'import' }, reply);
	assert(state.models.some(m => m.id === 'fixture-model'), 'Imported models must be available in Playground');
	assert(state.models.some(m => m.id === state.model?.id && m.provider === state.model?.provider));
	console.log('PASS: missing model rejects hello accurately; imported model catalog is available without model requests');
} finally { await chat?.close(); rmSync(root, { recursive: true, force: true }); }
