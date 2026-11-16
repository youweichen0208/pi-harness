/** Isolated Bun native selector comparison; no external provider or credentials. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testEnv } from './lib/test-env.mjs';
const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'omp-tree-projection-'));
const env = testEnv({ PI_CODING_AGENT_DIR: join(root, 'agent') });
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_/.test(key)) delete env[key];
const child = spawn(join(dirname(require.resolve('bun/package.json')), 'bin/bun.exe'), [fileURLToPath(new URL('./fixtures/omp-tree-projection.mjs', import.meta.url))], { env, stdio: ['ignore', 'inherit', 'inherit'] });
const timer = setTimeout(() => child.kill(), 60000);
try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(`Native projection exited ${code}`))); }); }
finally { clearTimeout(timer); rmSync(root, { recursive: true, force: true }); }
