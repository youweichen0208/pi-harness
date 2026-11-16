/** Exercise the production guard against isolated source/output graphs. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testEnv } from './lib/test-env.mjs';

const root = mkdtempSync(join(tmpdir(), 'omp-boundary-'));
const script = fileURLToPath(new URL('../scripts/check-engine-boundary.mjs', import.meta.url));
const write = (path, value) => writeFileSync(join(root, path), value);
function run(...args) {
	const result = spawnSync(process.execPath, [script, ...args], { cwd: root, env: testEnv(), encoding: 'utf8', timeout: 30000 });
	if (result.error) throw result.error;
	assert.equal(result.signal, null, result.stderr);
	return { status: result.status, output: result.stdout + result.stderr };
}
function rejected(pattern, ...args) {
	const result = run(...args);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, pattern);
}
try {
	for (const path of ['server', 'extensions', 'dist/server']) mkdirSync(join(root, path), { recursive: true });
	write('package.json', JSON.stringify({ type: 'module', dependencies: {} }));
	write('tsconfig.production.json', JSON.stringify({ compilerOptions: { noLib: true, types: [], module: 'NodeNext', moduleResolution: 'NodeNext' }, files: ['server/index.ts'] }));
	write('extensions/webui.ts', 'export {};');
	write('server/index.ts', 'export {};');
	assert.equal(run().status, 0);
	for (const source of [
		'import { SessionManager } from "@earendil-works/pi-coding-agent";',
		'import type { AgentSession } from "@earendil-works/pi-coding-agent";',
		'export type { AgentSession } from "@earendil-works/pi-coding-agent";',
		'type Session = import("@earendil-works/pi-coding-agent").AgentSession;',
		'import type Pi = require("@earendil-works/pi-coding-agent");',
		'const sdk = import("@earendil-works/pi-coding-agent");',
		'const sdk = require("@earendil-works/pi-coding-agent");',
	]) {
		write('server/index.ts', source);
		rejected(/server[/\\]index\.ts -> @earendil-works\/pi-coding-agent/);
	}
	// A shared type can pull retired code into the compiler without a runtime import.
	write('server/index.ts', 'import type { Shared } from "./shared.js";');
	write('server/shared.ts', 'export type Shared = import("@earendil-works/pi-ai").Model;');
	rejected(/server[/\\]shared\.ts -> @earendil-works\/pi-ai/);
	write('server/shared.ts', 'export {};');
	write('server/index.ts', 'export {};');
	write('package.json', JSON.stringify({ dependencies: { '@earendil-works/pi-ai': '1.5.2' } }));
	rejected(/production dependency: @earendil-works\/pi-ai/);
	write('package.json', JSON.stringify({ devDependencies: { '@earendil-works/pi-ai': '1.5.2' } }));
	rejected(/development dependency: @earendil-works\/pi-ai/);
	write('package.json', JSON.stringify({ type: 'module', dependencies: {} }));
	// Orphan modules and test-only imports must not reintroduce the retired engine.
	write('server/orphan.ts', 'import "@earendil-works/pi-ai";');
	rejected(/server[/\\]orphan\.ts -> @earendil-works\/pi-ai/);
	rmSync(join(root, 'server/orphan.ts'));
	mkdirSync(join(root, 'tests'));
	write('tests/stale.mjs', 'await import("../node_modules/@earendil-works/pi-ai/dist/index.js");');
	rejected(/tests[/\\]stale\.mjs ->/);
	rmSync(join(root, 'tests/stale.mjs'));
	mkdirSync(join(root, 'dev/context-eval'), { recursive: true });
	write('dev/context-eval/stale.mjs', 'await import("@earendil-works/pi-coding-agent");');
	rejected(/dev[/\\]context-eval[/\\]stale\.mjs ->/);
	rmSync(join(root, 'dev/context-eval/stale.mjs'));
	rejected(/missing production output: index\.js/, '--built');
	write('dist/server/index.js', 'export {};');
	assert.equal(run('--built').status, 0);
	write('dist/server/old-worker.js', 'export {};');
	rejected(/unexpected production output: old-worker\.js/, '--built');
	rmSync(join(root, 'dist/server/old-worker.js'));
	write('tsconfig.production.json', JSON.stringify({ compilerOptions: { noLib: true, types: [] }, files: ['server/index.ts', 'server/worker.ts'] }));
	write('server/worker.ts', 'export {};');
	rejected(/missing production output: worker\.js/, '--built');
	write('dist/server/worker.js', 'export {};');
	assert.equal(run('--built').status, 0);
	console.log('PASS production boundary: runtime/type imports, transitive types, production dependencies, stale outputs and independent workers');
} finally { rmSync(root, { recursive: true, force: true }); }
