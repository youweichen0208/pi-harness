/** Durability failures must survive a fresh host process. No model requests. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadOmpTestModule, ompTestExecutable, ompTestPackaged } from './lib/omp-runtime-location.mjs';
import { testEnv } from './lib/test-env.mjs';
const { OmpSession } = await loadOmpTestModule('session.js');
const wait = async (test, label) => { for (let i = 0; i < 500; i++) { if (test()) return; await new Promise(r => setTimeout(r, 20)); } throw Error(`Timed out ${label}`); };
const inherited = process.env.OMP_RESTART_FIXTURE;
if (inherited) {
	const { root, file, entryId, externallyModified } = JSON.parse(inherited);
	const session = new OmpSession({ conversationId: 'fresh-host', dataDir: root, cwd: root, sessionFile: file, env: testEnv(), restricted: { systemPrompt: 'No model calls.', toolNames: [] }, onChange() {} });
	try {
		assert.equal(session.state.persistence?.failed, true, 'a fresh host must retain the failed history restriction');
		assert.equal(session.state.persistence.externallyModified === true, externallyModified);
		await assert.rejects(session.open()); await assert.rejects(session.setThinking('off'));
		assert.equal(session.generation, undefined);
		const foreign = readFileSync(file, 'utf8');
		const { createOmpRuntime } = await loadOmpTestModule('runtime.js');
		await assert.rejects(createOmpRuntime({ conversationId: 'direct-worker', dataDir: root, cwd: root, sessionFile: file, env: testEnv(), onEvent() {}, onExit() {} }));
		await session.reopen(); assert.equal(session.state.persistence.failed, false);
		assert.equal(readFileSync(file, 'utf8'), foreign);
		await session.command('set_label', { entryId, label: 'EXPLICIT_RECOVERY_AFTER_HOST_RESTART' });
		assert(readFileSync(file, 'utf8').includes('EXPLICIT_RECOVERY_AFTER_HOST_RESTART'));
	} finally { await session.close(); }
	const healthy = new OmpSession({ conversationId: 'after-recovery', dataDir: root, cwd: root, sessionFile: file, env: testEnv(), restricted: { systemPrompt: 'No model calls.', toolNames: [] }, onChange() {} });
	try {
		assert(!healthy.state.persistence?.failed); await healthy.open();
		const { OmpPersistenceJournal } = await loadOmpTestModule('persistence-journal.js');
		new OmpPersistenceJournal(join(root, 'omp')).record(file, false);
		await assert.rejects(healthy.setThinking('off'));
		await wait(() => !healthy.generation, 'a newly recorded restriction stops an already open worker');
		await healthy.reopen(); assert.equal(healthy.state.persistence.failed, false);
	} finally { await healthy.close(); }
} else {
	const root = mkdtempSync(join(tmpdir(), 'omp-restart-')), agent = join(root, 'omp/agent');
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false } }));
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', models: [{ id: 'fixture', contextWindow: 200000 }] } } }));
	try {
		for (const externallyModified of [true, false]) {
			const session = new OmpSession({ conversationId: 'first-host', dataDir: root, cwd: root, env: testEnv(), restricted: { systemPrompt: 'No model calls.', toolNames: [] }, onChange() {} });
			let obstruction;
			try {
				await session.open(); await session.command('set_model', { provider: 'fixture', modelId: 'fixture' });
				const entryId = (await session.command('get_entries')).data.entries[0].id;
				await session.command('set_label', { entryId, label: 'NATIVE_ORIGINAL' }); await session.refresh();
				const file = session.state.sessionFile, original = readFileSync(file, 'utf8');
				if (externallyModified) writeFileSync(file, original.replace('NATIVE_ORIGINAL', 'EXTERN_CHANGED!'));
				else { obstruction = dirname(file); renameSync(obstruction, obstruction + '.saved'); writeFileSync(obstruction, 'storage unavailable'); }
				await wait(() => session.state.persistence?.failed && !session.generation, 'external failure');
				await session.close();
				if (obstruction) { rmSync(obstruction); renameSync(obstruction + '.saved', obstruction); obstruction = undefined; }
				const child = spawn(ompTestExecutable, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env: { ...testEnv(), ...(ompTestPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}), OMP_RESTART_FIXTURE: JSON.stringify({ root, file, entryId, externallyModified }) }, stdio: ['ignore', 'pipe', 'pipe'] });
				let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
				const timeout = setTimeout(() => child.kill(), 30000);
				try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); assert.equal(code, 0, output); }
				finally { clearTimeout(timeout); }
			} finally {
				if (obstruction) { rmSync(obstruction); renameSync(obstruction + '.saved', obstruction); }
				await session.close();
			}
		}
		console.log('PASS native OMP external/storage failures survive fresh hosts, worker bootstrap rejects bypass, explicit recovery clears restrictions');
	} finally { rmSync(root, { recursive: true, force: true }); }
}
