/** Real OMP storage and worker: reject stale writes without adopting foreign history. No model calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOmpTestModule } from './lib/omp-runtime-location.mjs';
import { testEnv } from './lib/test-env.mjs';
const { OmpSession } = await loadOmpTestModule('session.js');
const root = mkdtempSync(join(tmpdir(), 'omp-external-history-')), agent = join(root, 'omp/agent');
mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false } }));
writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', models: [{ id: 'fixture', contextWindow: 200000 }] } } }));
const sessions = [];
const wait = async (test, label) => { for (let i = 0; i < 500; i++) { if (test()) return; await new Promise(r => setTimeout(r, 20)); } throw Error(`Timed out ${label}`); };
async function create(id) {
	const session = new OmpSession({ conversationId: id, dataDir: root, cwd: root, env: testEnv(), restricted: { systemPrompt: 'No model calls.', toolNames: [] }, onChange() {} });
	sessions.push(session); await session.open();
	await session.command('set_model', { provider: 'fixture', modelId: 'fixture' });
	const entryId = (await session.command('get_entries')).data.entries[0].id;
	await session.command('set_label', { entryId, label: 'NATIVE_ORIGINAL' }); await session.refresh();
	return { session, entryId, file: session.state.sessionFile };
}
try {
	const healthy = await create('healthy');
	const touched = new Date(Date.now() + 5000); utimesSync(healthy.file, touched, touched);
	await healthy.session.command('set_label', { entryId: healthy.entryId, label: 'TOUCH_ACCEPTED' });
	for (const kind of ['same-size', 'append', 'truncate', 'remove', 'replace', 'idle']) {
		const { session, entryId, file } = await create(kind), original = readFileSync(file, 'utf8');
		assert(original.includes('NATIVE_ORIGINAL'));
		if (kind === 'same-size' || kind === 'idle') {
			const changed = original.replace('NATIVE_ORIGINAL', 'EXTERN_CHANGED!');
			assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original)); writeFileSync(file, changed);
		}
		if (kind === 'append') appendFileSync(file, '{"foreign":true}\n');
		if (kind === 'truncate') writeFileSync(file, '');
		if (kind === 'remove') rmSync(file);
		if (kind === 'replace') { writeFileSync(file + '.new', original); renameSync(file + '.new', file); }
		const foreign = existsSync(file) ? readFileSync(file) : undefined;
		if (kind !== 'idle') await assert.rejects(session.command('set_label', { entryId, label: 'MUST_NOT_APPEND' }));
		await wait(() => session.state.persistence?.externallyModified && !session.generation, `${kind} stops only its worker`);
		assert.deepEqual(existsSync(file) ? readFileSync(file) : undefined, foreign, `${kind}: foreign history preserved`);
		await assert.rejects(session.setThinking('off')); assert.equal(session.generation, undefined);
		assert(healthy.session.generation); assert(!healthy.session.state.persistence?.failed);
		await healthy.session.command('set_label', { entryId: healthy.entryId, label: `UNRELATED_${kind}` });
		// Only an explicit reopen accepts a fresh baseline; it never calls a model.
		writeFileSync(file, original); await session.reopen();
		assert.equal(session.state.persistence.failed, false);
		await session.command('set_label', { entryId, label: 'EXPLICIT_RECOVERY' });
		assert(readFileSync(file, 'utf8').includes('EXPLICIT_RECOVERY')); await session.close();
	}
	console.log('PASS native OMP external history: same-size edit, append, truncate, remove, replacement, idle detection, touch, isolated stop and explicit recovery');
} finally { for (const session of sessions) await session.close(); rmSync(root, { recursive: true, force: true }); }
