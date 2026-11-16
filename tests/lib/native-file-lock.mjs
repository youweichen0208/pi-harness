/** Hold the selected application's public native lock in an owned fixture process. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { testEnv } from './test-env.mjs';

export async function holdNativeFileLock(applicationRoot, file) {
	const require = createRequire(join(applicationRoot, 'package.json'));
	const bun = join(dirname(require.resolve('bun/package.json')), 'bin', 'bun.exe');
	const code = `
		import assert from 'node:assert/strict';
		import { realpathSync, readFileSync } from 'node:fs';
		import { relative, isAbsolute, sep, join } from 'node:path';
		import { pathToFileURL } from 'node:url';
		const [root, target] = process.argv.slice(1);
		const module = realpathSync(Bun.resolveSync('@oh-my-pi/pi-utils/file-lock', root));
		const inside = relative(realpathSync(root), module);
		assert(!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep));
		assert.equal(Bun.version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies.bun);
		const { acquireFileLock } = await import(pathToFileURL(module).href);
		const released = new Promise(resolve => { process.stdin.once('data', resolve); process.stdin.once('end', resolve); process.stdin.resume(); });
		const lock = await acquireFileLock(target, { retries: 10, retryDelayMs: 50 });
		console.log('LOCKED');
		try { await released; } finally { lock.release(); }
		process.exit(0);
	`;
	const child = spawn(bun, ['--no-install', '--eval', code, applicationRoot, file], {
		env: testEnv({ BUN_OPTIONS: '', NODE_OPTIONS: '', NODE_PATH: '', ELECTRON_RUN_AS_NODE: '' }),
		stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
	});
	let output = '', error = '', closed = false;
	child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
	const done = new Promise(resolve => { child.once('error', e => { error += e.message; closed = true; resolve(null); }); child.once('close', code => { closed = true; resolve(code); }); });
	let release;
	const close = () => release ??= (async () => {
		if (!closed) child.stdin.end('release\n');
		const timer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 3000);
		try { assert.equal(await done, 0, `Native lock fixture failed: ${error}`); } finally { clearTimeout(timer); }
	})();
	try {
		for (let i = 0; i < 200 && !closed && !output.includes('LOCKED'); i++) await new Promise(resolve => setTimeout(resolve, 25));
		assert(output.includes('LOCKED') && !closed, `Native config lock must be free during browser interaction: ${error}`);
		return close;
	} catch (error) { await close().catch(() => {}); throw error; }
}
