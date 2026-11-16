/** Build real OMP histories in Bun without loading an agent or calling a model. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testEnv } from './test-env.mjs';
const require = createRequire(import.meta.url);
export async function createOmpHistory({ dataDir, cwd, messages, kind = 'chat', title }) {
	const bun = join(dirname(require.resolve('bun/package.json')), 'bin/bun.exe');
	const child = spawn(bun, [fileURLToPath(new URL('../fixtures/omp-history.mjs', import.meta.url))], {
		env: { ...testEnv(), PI_CODING_AGENT_DIR: join(dataDir, 'omp/agent') }, stdio: ['pipe', 'pipe', 'pipe'],
	});
	let output = '', error = '';
	child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
	const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(error || `OMP history fixture exited ${code}`))); });
	child.stdin.on('error', () => {});
	child.stdin.end(JSON.stringify({ dataDir, cwd, messages, kind, title }));
	const timeout = setTimeout(() => child.kill(), 30000);
	try { await completed; return JSON.parse(output); } finally { clearTimeout(timeout); }
}
