/** Deletion keeps ownership while closing an actual OMP worker; new windows cannot reopen its file. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { scrubHostEnv } from './lib/test-env.mjs';
import { createOmpHistory } from './lib/omp-history-fixture.mjs';
import { OmpPersistenceJournal } from '../dist/server/omp/persistence-journal.js';
import { OmpChatService } from '../dist/server/omp/chat-service.js';

scrubHostEnv();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-history-owner-')));
const cwd = join(root, 'project'), data = join(root, 'data'), agent = join(data, 'omp/agent');
for (const path of [cwd, agent]) mkdirSync(path, { recursive: true });
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
let service, release, deletion;
try {
	const history = await createOmpHistory({ dataDir: data, cwd, messages: [{ role: 'user', content: 'Native deletion ownership', timestamp: Date.now() }] });
	service = new OmpChatService(cwd, join(data, 'client-state.json'));
	const events = [], client = await service.attach('owner', message => events.push(message));
	assert.equal(client.session.state.sessionFile, history.sessionFile);
	const target = client.session, close = target.close.bind(target);
	await client.newChat(true);
	const selected = client.conversationId;
	const before = readFileSync(history.sessionFile);
	const journal = new OmpPersistenceJournal(join(data, 'omp'));
	journal.record(history.sessionFile, true);
	let entered = false, failure;
	const gate = new Promise(resolve => { release = resolve; });
	// Delay the host adapter's public close method, never the SDK or worker code.
	target.close = async () => { entered = true; await gate; await close(); };
	deletion = client.deleteSession(history.sessionFile);
	deletion.catch(error => { failure = error; });
	for (let i = 0; i < 600 && !entered && !failure; i++) await sleep(25);
	if (failure) throw failure;
	assert(entered, 'delete must reach worker closure');
	assert(readFileSync(history.sessionFile).equals(before), 'history remains intact until its worker closes');
	const otherId = 'reconnecting-during-delete';
	const selection = join(data, 'omp/clients', `${createHash('sha256').update(otherId).digest('hex')}.json`);
	writeFileSync(selection, JSON.stringify({ cwd, wiki: false, sessionFile: history.sessionFile }));
	await assert.rejects(service.attach(otherId, () => {}), /正在删除/, 'saved selection cannot open another worker while deletion holds ownership');
	await client.prompt('Must not run during history deletion', undefined, undefined, 'blocked-by-delete');
	assert(events.some(event => event.type === 'prompt_result' && event.requestId === 'blocked-by-delete' && event.receipt === 'rejected'));
	assert(events.some(event => event.type === 'notice' && event.text.includes('conversation change')));
	assert.equal(client.conversationId, selected);
	release(); await deletion;
	assert(!existsSync(history.sessionFile));
	assert.equal(journal.read(history.sessionFile).tokens.length, 0, 'explicit deletion clears the acknowledged recovery markers');
	await service.disposeAll();
	service = new OmpChatService(cwd, join(data, 'client-state.json'));
	const reopened = await service.attach(otherId, () => {});
	assert.notEqual(reopened.session.state.sessionFile, history.sessionFile, 'returning window selects an existing history instead of reviving a deleted transcript');
	assert(!existsSync(history.sessionFile));
	console.log('PASS OMP history deletion ownership: close-before-delete, concurrent saved selection and prompt refused, reservation released, deleted history never revived on restart');
} finally {
	release?.(); await deletion?.catch(() => {}); await service?.disposeAll();
	rmSync(root, { recursive: true, force: true });
}
