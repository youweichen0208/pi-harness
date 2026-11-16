/** Exercise the injected adapter against the pinned native storage, including its EPERM fallback. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ompTestRoot, loadOmpTestModule } from './lib/omp-runtime-location.mjs';
import { testEnv } from './lib/test-env.mjs';
const require = createRequire(join(ompTestRoot, 'package.json'));
const root = mkdtempSync(join(tmpdir(), 'omp-storage-'));
try {
	if (!process.versions.bun) {
		const result = spawnSync(join(dirname(require.resolve('bun/package.json')), 'bin/bun.exe'), [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
			cwd: root, env: { ...testEnv(), PI_CODING_AGENT_DIR: join(root, 'agent') }, encoding: 'utf8', timeout: 30000,
		});
		assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout); process.stdout.write(result.stdout);
	} else {
		const { OmpSessionStorage } = await loadOmpTestModule('session-storage.js');
		const { FileSessionStorage } = await import(import.meta.resolve('@oh-my-pi/pi-coding-agent/session/session-storage', pathToFileURL(join(ompTestRoot, 'package.json')).href));
		const { SessionManager } = await import(import.meta.resolve('@oh-my-pi/pi-coding-agent', pathToFileURL(join(ompTestRoot, 'package.json')).href));
		const storage = new OmpSessionStorage(), failures = [];
		storage.guard.onFailure(external => failures.push(external));
		const file = join(root, 'native.jsonl');
		storage.writeLinesSync(file, ['{"initial":true}\n']);
		const writer = storage.openWriter(file); await writer.append('{"append":true}\n');
		await writer.flush(); await writer.close(); storage.check(file);
		await storage.writeLinesAtomic(file, ['{"async":true}\n']); storage.check(file);
		const current = readFileSync(file, 'utf8');
		await storage.writeTextAtomic(file, 'MUST_NOT_COMMIT', { commitGuard: () => false });
		assert.equal(readFileSync(file, 'utf8'), current); storage.check(file);
		// Inject at the native filesystem hook, after the adapter has validated.
		const rename = FileSessionStorage.prototype.renameSync;
		let rejectFirst = false, movedAside = false;
		FileSessionStorage.prototype.renameSync = function (source, target) {
			if (rejectFirst && source.endsWith('.tmp') && target === file) {
				rejectFirst = false; throw Object.assign(Error('fixture Windows sharing failure'), { code: 'EPERM' });
			}
			const result = rename.call(this, source, target);
			if (source === file && target.endsWith('.bak')) movedAside = true;
			return result;
		};
		try {
			rejectFirst = true; storage.writeTextSync(file, '{"syncFallback":true}\n'); storage.check(file); assert(movedAside);
			rejectFirst = true; movedAside = false;
			await storage.writeTextAtomic(file, '{"asyncFallback":true}\n'); storage.check(file); assert(movedAside);
			const beforeRestore = readFileSync(file, 'utf8'); rejectFirst = true; movedAside = false;
			await storage.writeTextAtomic(file, 'MUST_NOT_COMMIT', { commitGuard: () => !movedAside });
			assert(movedAside); assert.equal(readFileSync(file, 'utf8'), beforeRestore); storage.check(file);
		} finally { FileSessionStorage.prototype.renameSync = rename; }
		// A foreign edit during asynchronous staging must be rejected at publication.
		for (const withSize of [false, true]) {
			const stale = new OmpSessionStorage(), foreignFile = join(root, `foreign-${withSize}.jsonl`), detected = [];
			stale.guard.onFailure(external => detected.push(external));
			stale.writeTextSync(foreignFile, '{"original":true}\n');
			const pending = stale.writeTextAtomic(foreignFile, '{"stale":true}\n', withSize ? { expectedSize: readFileSync(foreignFile).length } : undefined);
			appendFileSync(foreignFile, '{"foreign":true}\n'); const foreign = readFileSync(foreignFile, 'utf8');
			await assert.rejects(pending); assert.equal(readFileSync(foreignFile, 'utf8'), foreign); assert.deepEqual(detected, [true]);
		}
		// Native manager exercises fixed title slots and image blob externalization.
		const manager = SessionManager.create(root, join(root, 'sessions'), storage);
		await manager.ensureOnDisk();
		const imageData = Buffer.alloc(2048, 7).toString('base64');
		manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'A native image' }, { type: 'image', mimeType: 'image/png', data: imageData }], timestamp: Date.now() });
		await manager.setSessionName('标题 native title', 'user'); await manager.flush();
		const sessionFile = manager.getSessionFile(); storage.check(sessionFile);
		assert(readFileSync(sessionFile, 'utf8').includes('标题 native title'));
		assert(!readFileSync(sessionFile, 'utf8').includes(imageData), 'native storage externalizes image data instead of mirroring memory entries');
		await manager.close();
		const loaded = await SessionManager.open(sessionFile, undefined, new OmpSessionStorage(), { throwIfMissing: true });
		assert(loaded.getEntries().some(entry => entry.type === 'message' && entry.message.content.some(block => block.type === 'image' && block.data === imageData)));
		await loaded.close(); assert.deepEqual(failures, []);
		console.log('PASS native OMP storage: append, sync/async rewrite, EPERM replace/restore, superseded commit, foreign edit during staging, title slot and image restore');
	}
} finally { rmSync(root, { recursive: true, force: true }); }
