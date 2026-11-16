/** The footer receives the application's release version independently of the OMP SDK. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startIsolatedHarness } from './lib/isolated-server.mjs';

const root = mkdtempSync(join(tmpdir(), 'omp-version-handshake-'));
const data = join(root, 'data'), agent = join(data, 'omp/agent');
mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
let harness, socket;
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: data } });
	const version = await new Promise((resolve, reject) => {
		socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`, { origin: `http://127.0.0.1:${harness.port}` });
		const timer = setTimeout(() => { socket.terminate(); reject(new Error('ready timeout')); }, 30000);
		socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', clientId: 'version-regression' })));
		socket.on('message', raw => {
			const message = JSON.parse(raw);
			if (message.type !== 'ready') return;
			clearTimeout(timer); resolve(message.serverVersion);
		});
		socket.on('error', error => { clearTimeout(timer); reject(error); });
		socket.on('close', () => { clearTimeout(timer); reject(Error('Closed before ready')); });
	});
	assert.equal(version, expected, `ready.serverVersion should be pi-harness ${expected}, got ${version}`);
	console.log(`PASS ready.serverVersion is pi-harness v${expected}`);
} finally {
	socket?.terminate(); await harness?.stop(); rmSync(root, { recursive: true, force: true });
}
