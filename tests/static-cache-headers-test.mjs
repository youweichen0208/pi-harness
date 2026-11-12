// Static caching contract. Vite output under /assets carries a content hash, so
// it can be cached forever. Everything else — above all index.html — must
// revalidate on every load: a stale entry point pins the browser to the
// previous build's asset hashes, which looks exactly like "I rebuilt but the UI
// did not change" (see the task menu styling report: the shipped CSS had the
// new .fp-table-menu rules while the browser kept rendering the old ones).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 9387;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-static-cache-'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let server;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);

	const head = async path => (await fetch(`http://127.0.0.1:${port}${path}`)).headers;

	// The entry point revalidates: no-cache forbids reuse without a round trip.
	const root = await head('/');
	assert.equal(root.get('cache-control'), 'no-cache', 'the SPA entry point must revalidate every load');
	const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
	const asset = html.match(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/)?.[0];
	assert(asset, `index.html must reference a hashed asset bundle:\n${html.slice(0, 400)}`);

	// Hashed assets stay immutable — they are addressed by content.
	const assetHeaders = await head(asset);
	assert.equal(assetHeaders.get('cache-control'), 'public, max-age=31536000, immutable', `hashed assets keep the immutable policy (${asset})`);

	// A deep SPA route is served the same entry point and must revalidate too.
	const deep = await head('/some/deep/route');
	assert.equal(deep.get('cache-control'), 'no-cache', 'a deep SPA route reuses the entry point and revalidates with it');

	// The point of `no-cache` is that a load always yields the CURRENT document.
	// A conditional request therefore answers 200 with the fresh body rather than
	// 304 with stale bytes: `send` treats any response carrying `no-cache` as
	// never fresh, which is exactly the guarantee this test is about (the cost is
	// re-sending this ~1KB file, and correctness is what we are buying).
	const conditional = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'if-none-match': root.get('etag') ?? '' } });
	assert.equal(conditional.status, 200, 'a conditional load still delivers the current entry point instead of confirming a stale copy');
	assert.equal((await conditional.text()).match(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/)?.[0], asset, 'the delivered entry point references the same current asset hash');

	console.log('PASS static caching: index.html and SPA routes revalidate (no-cache), hashed assets stay immutable');
} finally {
	server?.kill('SIGTERM');
	await sleep(300);
	try { rmSync(base, { recursive: true, force: true }); } catch {}
}
