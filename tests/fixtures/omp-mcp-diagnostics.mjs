/** Runs in Bun: bounded history and listener lifecycle at the public SDK seam. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { OmpMcpDiagnostics } = await import(pathToFileURL(join(process.argv[2], 'dist/server/omp/mcp-diagnostics.js')).href);
let listener, detached = 0, resolveStartup;
const manager = {
	addConnectionStatusListener(fn) { listener = fn; return () => { detached++; }; },
	getServerConfig() { return { type: 'http', url: 'https://example.invalid/PRIVATE' }; },
	getConnectionStatus() { return 'disconnected'; },
	waitForStartup(timeout) { assert.equal(timeout, 1); return new Promise(resolve => { resolveStartup = resolve; }); },
};
const diagnostics = new OmpMcpDiagnostics(manager), initializing = diagnostics.initialize();
listener({ type: 'connected', serverName: 'race' });
resolveStartup({ connected: [], pending: [], failed: [{ name: 'race', error: 'HTTP 403: stale' }] });
await initializing;
assert.equal(diagnostics.snapshot.events.length, 1, 'startup seed cannot overwrite newer listener events');
assert.equal(diagnostics.failure('race'), undefined);
const cases = [
	['HTTP 403: ARBITRARY_CREDENTIAL', 'http_status', 403],
	['connection timed out ARBITRARY_CREDENTIAL', 'timeout', undefined],
	['ECONNREFUSED ARBITRARY_CREDENTIAL', 'connect', undefined],
	['malformed JSON ARBITRARY_CREDENTIAL', 'malformed_response', undefined],
	['not-classifiable ARBITRARY_CREDENTIAL', 'unknown', undefined],
];
for (const [error, failure, httpStatus] of cases) {
	listener({ type: 'failed', serverName: 'classified', error });
	assert.deepEqual(diagnostics.failure('classified'), { transport: 'http', failure, ...(httpStatus ? { httpStatus } : {}) });
}
for (let i = 0; i < 1200; i++) listener({ type: 'failed', serverName: `server-${i}`, error: 'HTTP 403: ARBITRARY_CREDENTIAL' });
const snapshot = diagnostics.snapshot;
assert.equal(snapshot.events.length, 100); assert.equal(snapshot.dropped, 1106);
assert.equal(snapshot.events.at(-1).sequence, 1206);
assert.equal(diagnostics.failure('server-0'), undefined, 'current failure bookkeeping is bounded');
assert(diagnostics.failure('server-1199'));
assert(!JSON.stringify(snapshot).includes('ARBITRARY_CREDENTIAL')); assert(!JSON.stringify(snapshot).includes('PRIVATE'));
snapshot.events[0].name = 'mutated'; assert.notEqual(diagnostics.snapshot.events[0].name, 'mutated');
diagnostics.dispose(); diagnostics.dispose(); listener({ type: 'connected', serverName: 'late' });
assert.equal(detached, 1); assert.equal(diagnostics.snapshot.events.at(-1).sequence, 1206);
const absent = new OmpMcpDiagnostics(); await absent.initialize(); assert.deepEqual(absent.snapshot, { events: [], dropped: 0 }); absent.dispose();
console.log('PASS MCP diagnostic bounds, classification, startup race, copy isolation and listener disposal');
