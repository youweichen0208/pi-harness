/** Native OMP settings persistence/discovery; no external model calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listenIsolated } from './lib/isolated-server.mjs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOmpTestModule } from './lib/omp-runtime-location.mjs';
import { testEnv } from './lib/test-env.mjs';
const { OmpSession } = await loadOmpTestModule('session.js');
const root = mkdtempSync(join(tmpdir(), 'omp-skill-settings-'));
const agent = join(root, 'omp', 'agent'), cwd = join(root, 'workspace'), skillDir = join(root, 'custom-skills');
for (const dir of [agent, cwd, join(skillDir, 'fixture-skill')]) mkdirSync(dir, { recursive: true });
writeFileSync(join(skillDir, 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: Native skill settings fixture.\n---\nUse this skill only when explicitly requested.\n');
let requests = 0;
const provider = createServer((req, res) => { requests++; req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); });
const port = await listenIsolated(provider);
writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'SECRET_DO_NOT_EXPOSE', models: [{ id: 'fixture', contextWindow: 200000, input: ['text'] }] } } }));
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false, enableAgentsUser: false, enableAgentsProject: false, enablePiUser: false, enablePiProject: false, enableClaudeUser: false, enableClaudeProject: false, enableCodexUser: false, customDirectories: [skillDir] }, retry: { enabled: false }, privateSentinel: { token: 'DO_NOT_EXPOSE_OR_REMOVE' } }));
const sessions = [];
const open = async (id, workspace = cwd, restricted) => {
	const session = new OmpSession({ conversationId: id, dataDir: root, cwd: workspace, model: 'fixture/fixture', env: testEnv(), restricted, onChange() {} });
	sessions.push(session); await session.open(); return session;
};
const resources = async session => (await session.command('harness_resources')).data;
const save = (session, version, patch) => session.command('harness_save_skills', { version, patch });
const current = (view, key) => view.skillSettings.entries.find(entry => entry.key === key);
const wait = async fn => { for (let n = 0; n < 200; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw Error('Native skill refresh timed out'); };
try {
	const a = await open('a'), b = await open('b');
	let view = await resources(a);
	assert.equal(view.skills.length, 0); assert.equal(current(view, 'enabled').value, false);
	assert(!JSON.stringify(view).includes('SECRET_DO_NOT_EXPOSE'));
	assert(!JSON.stringify(view).includes('DO_NOT_EXPOSE_OR_REMOVE'));
	const initialVersion = view.skillSettings.version;
	await save(a, initialVersion, { enabled: true });
	view = await resources(a);
	assert(view.skills.some(skill => skill.name === 'fixture-skill'));
	assert(JSON.stringify((await a.command('get_state')).data.systemPrompt).includes('fixture-skill'), 'native prompt rebuilt');
	await wait(async () => (await resources(b)).skills.some(skill => skill.name === 'fixture-skill'));
	const beforeConflict = readFileSync(join(agent, 'config.yml'), 'utf8');
	await assert.rejects(save(b, initialVersion, { enabled: false }), /changed/);
	assert.equal(readFileSync(join(agent, 'config.yml'), 'utf8'), beforeConflict);
	for (const patch of [{ enabled: 'false' }, { apiKey: 'bad' }, { ignoredSkills: [1] }, { ignoredSkills: Array(257).fill('x') }]) {
		await assert.rejects(save(a, view.skillSettings.version, patch));
		assert.equal(readFileSync(join(agent, 'config.yml'), 'utf8'), beforeConflict);
	}
	const concurrent = await Promise.allSettled([
		save(a, view.skillSettings.version, { ignoredSkills: ['fixture-*'] }),
		save(b, view.skillSettings.version, { enableSkillCommands: false }),
	]);
	assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1, 'one stale writer must lose');
	view = await resources(a);
	await save(a, view.skillSettings.version, { ignoredSkills: ['fixture-*'] });
	assert.equal((await resources(a)).skills.length, 0);
	view = await resources(a);
	await save(a, view.skillSettings.version, { ignoredSkills: null, enabled: null, enableSkillCommands: null });
	view = await resources(a);
	assert.deepEqual(current(view, 'enabled'), { key: 'enabled', value: true, global: null, source: 'default' });
	assert(view.skills.some(skill => skill.name === 'fixture-skill'));
	assert(readFileSync(join(agent, 'config.yml'), 'utf8').includes('DO_NOT_EXPOSE_OR_REMOVE'));
	const project = join(root, 'project'); mkdirSync(join(project, '.omp'), { recursive: true });
	writeFileSync(join(project, '.omp', 'config.yml'), JSON.stringify({ skills: { enabled: false } }));
	const c = await open('project', project);
	view = await resources(c); assert.equal(current(view, 'enabled').source, 'project');
	await save(c, view.skillSettings.version, { enabled: true });
	view = await resources(c); assert.equal(current(view, 'enabled').global, true); assert.equal(current(view, 'enabled').value, false); assert.equal(view.skills.length, 0);
	const emptySessionId = a.state.sessionId;
	await a.stop(); await a.open();
	assert.equal(a.state.sessionId, emptySessionId, 'an empty native session must retain its identity after Stop');
	assert((await resources(a)).skills.some(skill => skill.name === 'fixture-skill'), 'persists across native worker restart');
	assert.equal(requests, 0, 'settings and discovery must not send this fixture to the model');
	await a.prompt('Hold the stream for the busy-write check');
	await wait(() => requests === 1 && a.state.running);
	const beforeBusy = readFileSync(join(agent, 'config.yml'), 'utf8');
	await assert.rejects(save(a, (await resources(a)).skillSettings.version, { enabled: false }), /Stop/);
	assert.equal(readFileSync(join(agent, 'config.yml'), 'utf8'), beforeBusy);
	await a.stop();
	const restricted = await open('restricted', cwd, { systemPrompt: 'Restricted fixture', toolNames: [] });
	assert.equal((await resources(restricted)).skillSettings, undefined);
	await assert.rejects(save(restricted, (await resources(a)).skillSettings.version, { enabled: false }));
	console.log('PASS OMP skill settings: native persistence/discovery/prompt, concurrent conflict, defaults, project precedence, invalid values, secret projection, restart and restricted-session isolation');
} finally { await Promise.allSettled(sessions.map(session => session.close())); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true }); }
