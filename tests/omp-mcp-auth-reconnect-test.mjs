/** Native OAuth reconnect selection regression; the separate write-back CAS probe still fails. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testEnv } from './lib/test-env.mjs';
import { ompTestExecutable, ompTestRoot, ompTestPackaged } from './lib/omp-runtime-location.mjs';

const probe = fileURLToPath(new URL('./diagnostics/omp-mcp-auth-conflict-probe.mjs', import.meta.url));
for (const mode of ['control', 'peer', 'definition-only', 'url-change', 'disable', 'delete', 'shadow', 'global-deny', 'project-policy', 'definition-edit', 'discovered', 'discovered-edit']) {
	const code = await new Promise((resolve, reject) => {
		const child = spawn(ompTestExecutable, [probe, mode, ompTestRoot], {
			env: testEnv({ NODE_OPTIONS: '', NODE_PATH: '', ...(ompTestPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }), stdio: 'inherit',
		});
		child.once('error', reject); child.once('exit', resolve);
	});
	assert.equal(code, 0, `OAuth reconnect selection: ${mode}`);
}
console.log('PASS native OAuth reconnect guard: unchanged/peer edits, URL/disable/delete/definition edits, project shadowing, global deny and project policy; no automatic obsolete reconnect');
