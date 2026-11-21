/** Host-side snapshot + tool-output latency benchmark. Zero tokens, no browser.
 *
 * node tests/host-latency-benchmark.mjs [--out=docs/review-data/host-latency.json] [--rounds=3] [--groups=small,medium,large,nested,mixed]
 *
 * S1-S5 are in-process micro-benchmarks. S6 drives the REAL production server
 * (dist/server/index.js) over ws and reads the opt-in PI_SNAPSHOT_TIMINGS dump
 * written on SIGTERM. S6 alone decides the M2 items: a micro-benchmark can show
 * that a string operation is slow, not that it sits in the snapshot path.
 *
 * JSON holds only aggregates (times, sizes, counts) — never conversation text.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, arch, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { testEnv, scrubHostEnv } from "./lib/test-env.mjs";
import { samplingOverheadRatio } from "./lib/sampling-overhead-ratio.mjs";

scrubHostEnv();
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const ROUNDS = Number(arg('rounds', '3'));
const OUT = resolve(arg('out', 'docs/review-data/host-latency.json'));
const GROUPS = arg('groups', 'small,medium,large,nested,mixed').split(',').filter(Boolean);
const { PROTOCOL_VERSION } = await import("../dist/server/protocol-version.js");

if (!existsSync('dist/server/serialize.js')) execFileSync('npm', ['run', 'build:server'], { stdio: 'inherit' });

const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), 'pi-host-latency-'));
const agentDir = join(base, 'agent');
const projectDir = join(base, 'project');
mkdirSync(agentDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
const timingsDir = join(base, 'timings');
const fixtureDir = join(base, 'fixtures');
mkdirSync(timingsDir);
mkdirSync(fixtureDir);

// Model discovery must never read the developer's other agents.
isolateModelSources();
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], retry: { enabled: false }, compaction: { enabled: false } }));

/** Keep auto-discovered providers away from the host's CLAUDE/CODEX config dirs. */
function isolateModelSources() {
	const noSources = join(base, 'no-external-sources');
	for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) process.env[key] = join(noSources, key);
}

// ---------------------------------------------------------------------------
// Fixtures: real SessionManagers written by the SDK, never hand-built JSONL.
// ---------------------------------------------------------------------------
const { SessionManager, createBashToolDefinition } = await import('@earendil-works/pi-coding-agent');

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, cost: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const SMALL_TEXT = 'line of output\n'.repeat(50);            // ~750 B
const MEDIUM_TEXT = 'x'.repeat(64 * 1024);                   // 64 KB
const LARGE_TEXT = 'x'.repeat(1600 * 1024);                  // 1.6 MB
const NESTED_TEXT = 'y'.repeat(1024);                        // 1 KB
const TOOL_NAMES = ['bash', 'read', 'codemode'];

function nestedCallsFor(count, argumentBytes) {
	return { complete: true, calls: Array.from({ length: count }, (_, i) => ({
		id: `nested-${i}`, name: 'read', status: 'ok', durationMs: 3,
		argumentsBytes: argumentBytes, arguments: { path: `src/file-${i}.ts`, limit: argumentBytes },
	})) };
}

function writeConversation(manager, count, textFor, decorate = () => {}) {
	// A fixed base: Date.now() per message made the persisted entries appear
	// older than the session header, so a reopened file projected them in a
	// different order (8 system-prompt messages inserted mid-transcript).
	const baseTimestamp = Date.now();
	for (let i = 0; i < count; i++) {
		const timestamp = baseTimestamp + i * 2;
		const toolCallId = `call-${i}`;
		const toolName = TOOL_NAMES[i % TOOL_NAMES.length];
		manager.appendMessage({ role: 'user', content: [{ type: 'text', text: `question ${i}` }], timestamp });
		manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `answer ${i} ` + 'a'.repeat(300) }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'stop', timestamp });
		manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: { command: `echo ${i}` } }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp });
		const message = { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text: textFor(i) }], isError: false, timestamp, durationMs: 5 };
		decorate(message, i);
		manager.appendMessage(message);
	}
}

const fixtures = {};
/**
 * The server's SDK appends its own session setup (system prompt + thinking
 * changes) to the transcript it opens, so the loaded message count is not
 * byte-for-byte the fixture's: small@100 loaded 400 and small@2000 loaded
 * 8017. The tolerance is what those setup entries can add (one message per
 * 500 fixture messages, plus the system prompt); anything beyond it means the
 * history did not load and S6 is reported unmeasured.
 */

async function buildFixture(name, count, textFor, decorate, { keepAtOrigin = false } = {}) {
	const manager = SessionManager.create(projectDir);
	writeConversation(manager, count, textFor, decorate);
	// keepAtOrigin: hand back the path the SDK itself wrote under
	// <agentDir>/sessions/<encoded-cwd>/. A fixture only this process ever wrote
	// has a file size that GROWS when the server appends, which is exactly what
	// SessionTailValidator needs to stay non-blocking. A copy at an arbitrary
	// path never grows, so `assertWritable()` throws "正在校验会话文件" on every
	// model switch (the S6c failure this benchmark used to record).
	if (keepAtOrigin) {
		await sleep(400);
		const path = manager.getSessionFile();
		fixtures[name] = { path, count: manager.buildSessionProjection().messages.length, turnMessages: count * 4 };
		return fixtures[name];
	}
	// SessionManager keeps a process-global cache keyed by path, so opening the
	// file we just wrote returns the WRITER's object graph, not the persisted
	// one. Copy the bytes to a new path and open THAT: it is what a fresh
	// server process will load, and the in-memory vs on-disk layouts differ
	// (toolCall arguments/calls are stored separately and re-merged on load).
	const path = join(fixtureDir, `${name.replace(/[^a-z0-9]+/gi, '-')}_${Date.now().toString(36)}.jsonl`);
	// Writes are synchronous, but the SDK keeps pumping its own session setup
	// (system prompt + thinking-level changes) asynchronously: copying right
	// away produced fixtures with 17 extra messages for every 500 turns of
	// setup appended afterwards. Let it settle, then copy once.
	await sleep(400);
	copyFileSync(manager.getSessionFile(), path);
	if (process.env.PI_HOST_LATENCY_DEBUG) {
		const count = (f) => { const types = {}; for (const line of readFileSync(f, 'utf8').split('\n').slice(1)) if (line) { const e = JSON.parse(line); types[e.type] = (types[e.type] ?? 0) + 1; } return JSON.stringify(types); };
		console.error('[bench] fixture', name, 'source', count(manager.getSessionFile()), 'copy', count(path));
	}
	// Do not re-open the copy here: timestamps are fixed at write time, so the
	// writer's projection and a fresh open agree (verified separately), and
	// opening a header-less copy would append a header to the real file.
	const projection = manager.buildSessionProjection().messages;
	fixtures[name] = { path, count: projection.length, turnMessages: count * 4 };
	return fixtures[name];
}

const built = [];
if (GROUPS.includes('small')) for (const n of [100, 500, 2000]) built.push(await buildFixture(`small@${n}`, n, () => SMALL_TEXT));
if (GROUPS.includes('medium')) for (const n of [100, 500]) built.push(await buildFixture(`medium@${n}`, n, () => MEDIUM_TEXT));
if (GROUPS.includes('large')) built.push(await buildFixture('large@100', 100, () => LARGE_TEXT));
if (GROUPS.includes('nested')) built.push(await buildFixture('nested@500', 500, () => NESTED_TEXT, (m) => { m.nestedCalls = nestedCallsFor(20, 2048); }));
if (GROUPS.includes('mixed')) built.push(await buildFixture('mixed@2000', 2000, (i) => (i < 50 ? LARGE_TEXT : i % 3 === 0 ? MEDIUM_TEXT : SMALL_TEXT)));

// S6c's fixture stays at the path the SDK wrote it to: only a file this
// process owns has a growing size, which is what keeps the session-file
// validator non-blocking during a model switch. One per round — the SDK caches
// session objects by path, so re-opening the same path yields the writer's
// object graph instead of what a fresh server reads.
const buildChangeFixture = () => buildFixture(`change@50-${Date.now().toString(36)}`, 50, () => SMALL_TEXT, undefined, { keepAtOrigin: true });

// The production run loads ONE fixture; default to the heaviest realistic transcript.
const loadName = arg('s6-fixture', 'mixed@2000');
const loadFixture = fixtures[loadName] ?? built.at(-1);
assert(loadFixture, 'no fixture built for S6');
const loadFixtureName = fixtureLabel(loadFixture);
// Observed on macOS/Node 22: mixed@2000 loaded 8000/8009/8017 across rounds,
// small@2000 (6 MB) up to +25, small@100 +0. The server's SDK appends its own
// setup entries while parsing, and how many depends on timing — scale the
// allowed drift with the transcript size and keep it well below "did not load".
const loadFixtureBytes = existsSync(loadFixture.path) ? statSync(loadFixture.path).size : 0;
const LOAD_TOLERANCE = Math.ceil(loadFixtureBytes / 100_000) + 1;

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
const now = () => performance.now();
const started = Date.now();
const phase = (name) => console.error(`[bench +${((Date.now() - started) / 1000).toFixed(1)}s] ${name}`);
function quantile(values, q) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const pos = (sorted.length - 1) * q, lower = Math.floor(pos), upper = Math.ceil(pos);
	return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}
const stat = (samples) => ({
	count: samples.length,
	p50: quantile(samples, 0.5),
	p95: quantile(samples, 0.95),
	max: samples.reduce((a, b) => (b > a ? b : a), 0),
	total: samples.reduce((a, b) => a + b, 0),
});
const round = (record) => Object.fromEntries(Object.entries(record).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1000) / 1000 : v]));

/** Offline accounting for one uncompressed snapshot. Categories are exact by
 * construction: the residual is JSON property names, separators and the outer
 * messages array syntax, not hidden application payload. */
function snapshotComposition(message) {
	const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
	const state = message.state ?? {};
	const messages = Array.isArray(state.messages) ? state.messages : [];
	const categories = { toolResultContent: 0, otherMessageContent: 0, details: 0, nestedCalls: 0, messageRemainder: 0 };
	const roles = {};
	for (const item of messages) {
		roles[item.role] = (roles[item.role] ?? 0) + 1;
		const { content, details, nestedCalls, ...remainder } = item;
		categories[item.role === 'toolResult' ? 'toolResultContent' : 'otherMessageContent'] += jsonBytes(content ?? []);
		if (details !== undefined) categories.details += jsonBytes(details);
		if (nestedCalls !== undefined) categories.nestedCalls += jsonBytes(nestedCalls);
		categories.messageRemainder += jsonBytes(remainder);
	}
	const { messages: _messages, ...lightState } = state;
	const { state: _state, ...envelope } = message;
	categories.lightState = jsonBytes(lightState);
	categories.envelope = jsonBytes(envelope);
	const totalBytes = jsonBytes(message);
	const accounted = Object.values(categories).reduce((sum, value) => sum + value, 0);
	categories.jsonKeysAndArraySyntax = totalBytes - accounted;
	return {
		totalBytes,
		messageCount: messages.length,
		roles,
		categories,
		lightStateFields: Object.fromEntries(Object.entries(lightState).map(([key, value]) => [key, jsonBytes(value)])),
		toolResultContentRatio: totalBytes ? categories.toolResultContent / totalBytes : null,
	};
}

/** Mean host overhead of one process spawn, measured the same way everywhere. */
function spawnCost(command, args, samples) {
	return new Promise(async (done) => {
		const times = [];
		for (let i = 0; i < samples; i++) {
			const t = now();
			const child = spawn(command, args, { stdio: 'ignore' });
			await once(child, 'exit');
			times.push(now() - t);
		}
		done(stat(times));
	});
}

phase('S1 shell-spawn');
const s1 = { bashTrue: await spawnCost('/bin/bash', ['-c', 'true'], 20), bashGitStatus: await spawnCost('/bin/bash', ['-c', 'git status --short'], 20) };

phase('S2 bash-tool');
let s2;
{
	const tool = createBashToolDefinition(projectDir, { operations: { exec: async (_command, _cwd, { onData }) => {
		for (let i = 0; i < 64; i++) onData(Buffer.from(`chunk-${i} ` + 'z'.repeat(1000) + '\n'));
		return { exitCode: 0 };
	} } });
	const times = [];
	for (let i = 0; i < 10; i++) {
		const t = now();
		let last;
		await tool.execute('bench', { command: 'fixture' }, undefined, (partial) => { last = partial; });
		times.push(now() - t);
		assert(last, 'bash tool never emitted an update');
	}
	s2 = stat(times);
}

// S3 — mirror of AgentService.serializeCached's key + cache logic.
// MUST stay in sync with server/agent-service.ts serializeCached(); this is a
// regression baseline for cache math, NOT evidence about the production path.
function microCache(messages, rounds) {
	const msgIds = new Map(), cache = new Map(), contentIds = new WeakMap();
	let contentSeq = 0, nextId = 0;
	const fingerprint = new Map();
	const keyOf = (m) => m.role === 'toolResult' ? `t:${m.toolCallId}` : `${m.role}:${m.timestamp}:${createHash('sha256').update(JSON.stringify(m)).digest('hex')}`;
	const hitTimes = [], missKeys = [], metadataBytes = [], fingerprintTimes = [], dupKeyTimes = [];
	for (let round = 0; round < rounds; round++) {
		// Emulate a cold cache on round 0 only: later rounds measure the steady state.
		if (round === 1) cache.clear();
		for (const m of messages) {
			const tKey = now();
			// The production path separately recomputes this key in currentMessages().
			keyOf(m);
			dupKeyTimes.push(now() - tKey);
			const tf = now();
			const contentKey = keyOf(m);
			fingerprintTimes.push(now() - tf);
			let n = msgIds.get(contentKey);
			if (n === undefined) { n = nextId++; msgIds.set(contentKey, n); }
			let toolRevision = '', metaJson = '';
			if (m.role === 'toolResult') {
				let contentId = contentIds.get(m.content);
				if (contentId === undefined) { contentId = ++contentSeq; contentIds.set(m.content, contentId); }
				metaJson = JSON.stringify({ ...m, content: [] });
				toolRevision = `:${contentId}:${createHash('sha256').update(metaJson).digest('hex')}`;
				metadataBytes.push(Buffer.byteLength(metaJson, 'utf8'));
			}
			const cacheKey = `${contentKey}#${n}${toolRevision}`;
			const t = now();
			const cached = cache.get(cacheKey);
			hitTimes.push(now() - t);
			if (!cached) { missKeys.push(cacheKey); cache.set(cacheKey, {}); }
		}
	}
	const distinct = new Set(messages.map((m) => m.role === 'toolResult' ? `t:${m.toolCallId}` : fingerprint.get(m) ?? keyOf(m)));
	return {
		messages: messages.length,
		hitRate: hitTimes.length ? 1 - missKeys.length / hitTimes.length : 0,
		metadataBytesPerRound: metadataBytes.reduce((a, b) => a + b, 0) / Math.max(rounds, 1),
		metadataBytesPerMessage: metadataBytes.length ? metadataBytes.reduce((a, b) => a + b, 0) / metadataBytes.length : 0,
		fingerprintMs: round(stat(fingerprintTimes)),
		dupKeyMs: round(stat(dupKeyTimes.filter((_, i) => i % messages.length === 0))),
		hitMs: round(stat(hitTimes)),
		distinctKeys: distinct.size,
	};
}

phase('S3 micro-cache');
const s3 = {};
for (const fixture of built) {
	const projection = SessionManager.open(fixture.path).buildSessionProjection();
	s3[fixtureLabel(fixture)] = microCache(projection.messages, 20);
}
function fixtureLabel(fixture) {
	return Object.entries(fixtures).find(([, f]) => f.path === fixture.path)?.[0] ?? fixture.path;
}

phase('S4 light-state');
const { estimateContextParts } = await import('../dist/server/context-breakdown.js');
const { deriveTaskProgress } = await import('../dist/server/task-progress.js');
const { CodemodeHistory } = await import('../dist/server/codemode-history.js');
const { SnapshotTimings } = await import('../dist/server/snapshot-timings.js');
const s4 = {};
for (const fixture of built) {
	const manager = SessionManager.open(fixture.path);
	const messages = manager.buildSessionProjection().messages;
	const parts = [], progress = [], codemode = [];
	const history = new CodemodeHistory();
	const identity = (m) => ({ id: `m-${m.toolCallId ?? m.timestamp}`, role: m.role, content: [], timestamp: m.timestamp, toolCallId: m.toolCallId, toolName: m.toolName });
	for (let i = 0; i < 20; i++) {
		let t = now(); estimateContextParts(messages, 'system prompt fixture', 100000); parts.push(now() - t);
		t = now(); deriveTaskProgress('conversation', messages.map(identity), null, false, 0); progress.push(now() - t);
		t = now(); history.snapshot(manager, identity); codemode.push(now() - t);
	}
	s4[fixtureLabel(fixture)] = { estimateContextParts: round(stat(parts)), deriveTaskProgress: round(stat(progress)), codemodeSnapshot: round(stat(codemode)) };
}

phase('S5 tool-delta');
const { toolOutputUpdate } = await import('../dist/server/tool-output.js');
// M1 adds server/ansi.ts; before that lands the baseline measures replace-cost only.
const stripAnsi = await import('../dist/server/ansi.js').then((m) => m.stripAnsi).catch(() => null);
function deltaRun(chunkBytes, totalBytes) {
	const line = '\u001b[32m' + 'x'.repeat(60) + '\u001b[0m\n';
	const full = line.repeat(Math.ceil(totalBytes / line.length));
	const updateTimes = [], stripTimes = [];
	let accumulated = '', scannedBytes = 0;
	const memoryBefore = process.memoryUsage().heapUsed;
	for (let offset = 0; offset < full.length; offset += chunkBytes) {
		accumulated = full.slice(0, Math.min(offset + chunkBytes, full.length));
		let t = now();
		const update = toolOutputUpdate({ content: [{ type: 'text', text: accumulated }] });
		updateTimes.push(now() - t);
		if (stripAnsi) {
			t = now();
			const visible = stripAnsi(update?.delta ?? '');
			stripTimes.push(now() - t);
			scannedBytes += visible.length;
		}
	}
	return {
		chunkBytes,
		finalBytes: Buffer.byteLength(accumulated, 'utf8'),
		updates: updateTimes.length,
		update: round(stat(updateTimes)),
		stripAnsi: stripAnsi ? round(stat(stripTimes)) : null,
		scanAmplification: stripAnsi ? (accumulated.length ? scannedBytes / accumulated.length : 0) : null,
		heapDeltaBytes: process.memoryUsage().heapUsed - memoryBefore,
	};
}
const s5 = [deltaRun(8 * 1024, 1024 * 1024), deltaRun(64 * 1024, 1024 * 1024)];

// ---------------------------------------------------------------------------
// S6 — production path
// ---------------------------------------------------------------------------
const PORT = Number(arg('port', '8912'));
const LIVE_SERVERS = new Set();
for (const signal of ['SIGINT', 'SIGTERM', 'uncaughtException']) {
	process.on(signal, (error) => {
		for (const child of LIVE_SERVERS) child.kill('SIGKILL');
		if (signal === 'uncaughtException') { console.error(error); process.exit(1); }
		process.exit(0);
	});
}
const mockPort = await freePort();

/** One SSE tool call, then a final text message. Mirrors the SDK's wire shape. */
const mock = createHttpServer((req, res) => {
	void respond(req, res).catch(() => {});
});
async function respond(req, res) {
	// The SDK may abandon a request (model switch, teardown); that must not
	// reject out of this async handler and kill the benchmark.
	res.on('error', () => {});
	req.on('error', () => {});
	let body = '';
	try { for await (const chunk of req) body += chunk; } catch { return; }
	let payload;
	try { payload = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
	const hasToolResult = payload.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'call_bench');
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	res.write(`data: ${JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
	if (hasToolResult) {
		res.write(`data: ${JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
		res.end('data: [DONE]\n\n');
		return;
	}
	const toolCall = { id: 'call_bench', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_bench', type: 'function', function: { name: 'write', arguments: '' } }] }, finish_reason: null }] };
	const args = JSON.stringify({ path: 'note.txt', content: 'x' });
	res.write(`data: ${JSON.stringify(toolCall)}\n\n`);
	for (let i = 0; i < args.length; i += 16) {
		res.write(`data: ${JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 16) } }] }, finish_reason: null }] })}\n\n`);
	}
	res.write(`data: ${JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
	res.end('data: [DONE]\n\n');
}
mock.on('clientError', (_error, socket) => socket.destroy());
await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));

function writeMockModelConfig() {
	writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { bench: {
		api: 'openai-completions', baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: 'bench',
		models: [{ id: 'bench', input: ['text'], contextWindow: 1000000, maxTokens: 64 }],
	} } }));
	writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], defaultProvider: 'bench', defaultModel: 'bench', retry: { enabled: false }, compaction: { enabled: false } }));
}
writeMockModelConfig();

async function freePort() {
	const probe = (await import('node:net')).createServer();
	await new Promise((r) => probe.listen(0, '127.0.0.1', r));
	const port = probe.address().port;
	await new Promise((r) => probe.close(r));
	assert(port >= 8900, `benchmark port ${port} must be >= 8900`);
	return port;
}

/** Start the production server once; returns a client + the SIGTERM teardown. */
async function startServer(scenario, enabled) {
	const dataDir = join(base, `data-${scenario}-${enabled ? 'on' : 'off'}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dataDir, { recursive: true });
	const out = join(timingsDir, `${scenario}-${enabled ? 'on' : 'off'}-${Date.now()}.json`);
	// testEnv() only strips host PI_* when the caller has NOT scrubbed (we have),
	// so every PI_* the child gets must be named here explicitly.
	const env = testEnv({
		PORT: String(PORT), PI_WEB_CWD: projectDir, PI_WEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_NO_BROWSER: '1', PI_WEB_HOST: '127.0.0.1',
	});
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ELECTRON_NO_ATTACH_CONSOLE;
	if (process.env.PI_HOST_LATENCY_DEBUG) console.error('child env PI_CODING_AGENT_DIR=', env.PI_CODING_AGENT_DIR, 'PI_WEB_PKG_ROOT=', env.PI_WEB_PKG_ROOT);
	if (enabled) { env.PI_SNAPSHOT_TIMINGS = '1'; env.PI_SNAPSHOT_TIMINGS_OUT = out; }
	if (process.env.PI_HOST_LATENCY_DEBUG) console.error('[bench] spawn env PI_CODING_AGENT_DIR=', env.PI_CODING_AGENT_DIR, 'agentDir=', agentDir);
	const child = spawn(process.execPath, [join(root, 'dist/server/index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
	if (process.env.PI_HOST_LATENCY_DEBUG) {
		const first = readFileSync(loadFixture.path, 'utf8').split('\n');
		const types = {};
		for (const line of first.slice(1)) if (line) { const e = JSON.parse(line); types[e.type] = (types[e.type] ?? 0) + 1; }
		console.error('[bench] fixture at spawn', loadFixture.path.split('/').pop(), JSON.stringify(types), 'bytes', readFileSync(loadFixture.path).length);
	}
	// A failed scenario must never leave a server holding the port for the next one.
	LIVE_SERVERS.add(child);
	let log = '';
	child.stdout.on('data', (d) => (log += d));
	child.stderr.on('data', (d) => (log += d));
	const ws = await connectWithRetry(child, log);
	return {
		child, ws, out, enabled,
		log: () => log,
		agentDirEnv: () => `${env.PI_CODING_AGENT_DIR}|keys=${Object.keys(env).filter((k) => k.startsWith('PI_')).join(',')}`,
		async stop() {
			LIVE_SERVERS.delete(child);
			ws.close();
			const exited = once(child, 'exit');
			child.kill('SIGTERM');
			await Promise.race([exited, sleep(15000)]);
			if (child.exitCode === null) child.kill('SIGKILL');
			await sleep(120);
			return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
		},
	};
}

async function assertPortFree() {
	const net = await import('node:net');
	const taken = await new Promise((done) => {
		const probe = net.createServer();
		probe.once('error', () => done(true));
		probe.listen(PORT, '127.0.0.1', () => probe.close(() => done(false)));
	});
	if (taken) throw new Error(`port ${PORT} is already in use — stop it or pass --port=<n>`);
}

async function connectWithRetry(child, getLog) {
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`server exited early:\n${getLog()}`);
		try {
			return await new Promise((done, fail) => {
				const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
				socket.once('open', () => done(socket));
				socket.once('error', fail);
			});
		} catch { await sleep(150); }
	}
	throw new Error(`server never listened:\n${getLog()}`);
}

/** ws client that records every snapshot family message it sees. */
function attachClient(ws) {
	const client = { snapshots: [], deltas: [], notices: [], settled: 0, ws, parseTimes: [], receivedBytes: [], state: null,
		send(message) { ws.send(JSON.stringify(message)); },
		async waitFor(predicate, timeoutMs = 60000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const value = predicate(client);
				if (value) return value;
				await sleep(10);
			}
			throw new Error('timeout waiting for client state');
		},
	};
	ws.on('message', (raw) => {
		const t = now();
		const message = JSON.parse(raw.toString());
		client.parseTimes.push(now() - t);
		client.receivedBytes.push(raw.byteLength ?? Buffer.byteLength(raw));
		if (message.type === 'snapshot') { client.snapshots.push(message); client.state = message.state; }
		else if (message.type === 'snapshot_delta') {
			client.deltas.push(message);
			if (client.state && message.baseRev === client.state.rev) client.state = { ...client.state, ...message.state, messages: [...client.state.messages, ...message.appended] };
		}
		else if (message.type === 'notice') client.notices.push(message);
		else if (message.type === 'agent_settled') client.settled += 1;
	});
	return client;
}

/** hello + load the fixture transcript; verifies the history really arrived. */
async function openFixture(client, clientId, server, fixture = loadFixture) {
	const log = () => server?.log() ?? '';
	client.send({ type: 'hello', clientId, protocolVersion: PROTOCOL_VERSION });
	const first = await client.waitFor((c) => c.snapshots[0], 90000).catch(() => { throw new Error(`no snapshot after hello:\n${log()}`); });
	// Every round must load byte-identical input: the in-process micro phases
	// open the fixture to project it, and that open can append SDK setup
	// entries to the file. Copy per round and let the server own the copy —
	// except for origin fixtures (S6c), which must stay on their own growing
	// path (see buildFixture's keepAtOrigin).
	const perRound = fixture === loadFixture
		? join(fixtureDir, `load-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.jsonl`)
		: fixture.path;
	if (perRound !== fixture.path) copyFileSync(fixture.path, perRound);
	const tolerance = fixture === loadFixture ? LOAD_TOLERANCE : Math.ceil((statSync(perRound).size / 100_000) + 1);
	client.send({ type: 'switch_session', path: perRound });
	// Full snapshots carry `messages`; the subsequent ones carry the same
	// sessionFile but only light state, so both conditions are required.
	const loaded = await client.waitFor((c) => c.snapshots.find((s) => Array.isArray(s.state?.messages) && Math.abs(s.state.messages.length - fixture.count) <= tolerance && s.state.sessionFile && resolve(s.state.sessionFile) === resolve(perRound)), 180000)
		.catch(() => {
			const seen = client.snapshots.map((s) => `${String(s.state.sessionFile ?? '').split('/').pop()}#${Array.isArray(s.state.messages) ? s.state.messages.length : 'light'}`);
			throw new Error(`fixture never loaded: ${JSON.stringify(seen)} expected=${fixture.path.split('/').pop()}#${fixture.count}; agentDirEnv=${server.agentDirEnv()}; notices=${JSON.stringify(client.notices.map((n) => n.text).slice(0, 3))}\n${log()}`);
		});
	return { first, loaded };
}

async function scenarioFull(round) {
	const server = await startServer(`full-${round}`, true);
	const client = attachClient(server.ws);
	const clientId = `bench-full-${round}`;
	const loaded = await openFixture(client, clientId, server);
	const roundTrips = [];
	const startup = client.snapshots.length;
	client.snapshots.length = 0;
	for (let i = 0; i < 20; i++) {
		const before = client.snapshots.length;
		const t = now();
		client.send({ type: 'get_state' });
		await client.waitFor((c) => c.snapshots.length > before, 60000);
		roundTrips.push(now() - t);
	}
	void startup;
	const dump = await server.stop();
	return { loaded: loaded.loaded.state.messages.length, roundTrips: stat(roundTrips), jsonParse: stat(client.parseTimes), composition: snapshotComposition(loaded.loaded), dump };
}

async function scenarioIncremental(round) {
	const server = await startServer(`incremental-${round}`, true);
	const client = attachClient(server.ws);
	const clientId = `bench-incr-${round}`;
	await openFixture(client, clientId, server);
	client.snapshots.length = 0;
	client.deltas.length = 0;
	let emptyDeltas = 0, nonEmpty = 0;
	for (let i = 0; i < 20; i++) {
		const beforeFull = client.snapshots.length;
		client.send({ type: 'get_state' });
		await client.waitFor((c) => c.snapshots.length > beforeFull, 60000);
		const before = client.deltas.length;
		client.send({ type: 'set_thinking', level: i % 2 ? 'low' : 'medium' });
		const delta = await client.waitFor((c) => c.deltas.length > before ? c.deltas[c.deltas.length - 1] : null, 30000).catch(() => null);
		if (delta) { if (delta.appended.length === 0) emptyDeltas++; else nonEmpty++; }
	}
	const dump = await server.stop();
	return { emptyDeltas, nonEmpty, dump };
}

/** S6c — the tool-result evidence chain.
 *
 * Prove the CLIENT actually received everything one real turn produces: the
 * user message, the assistant toolCall, and exactly one matching toolResult
 * (carried in a delta, deduplicated). Never assert a raw message count — the
 * SDK appends its own setup entries — and never treat a `notice` as noise.
 */
async function scenarioChange(round) {
	const server = await startServer(`change-${round}`, true);
	const client = attachClient(server.ws);
	const clientId = `bench-change-${round}`;
	const fixture = await buildChangeFixture();
	await openFixture(client, clientId, server, fixture);
	const beforeIds = new Set((client.state?.messages ?? []).map((m) => m.id));
	client.deltas.length = 0;
	client.notices.length = 0;

	// 1. Model switch must be CONFIRMED, never assumed after a fixed sleep.
	client.send({ type: 'set_model', modelId: 'bench/bench' });
	const switched = await client.waitFor((c) => c.state?.model?.id === 'bench', 15000).then(() => true).catch(() => false);

	if (!switched) {
		const dump = await server.stop();
		return { modelSwitch: 'timeout', notices: client.notices.map((n) => n.text), dump };
	}

	// 2. One complete turn: write tool call, matching toolResult, then final text.
	client.send({ type: 'prompt', text: 'write a file' });
	const toolResultSeen = await client.waitFor(
		(c) => c.deltas.some((d) => (d.appended ?? []).some((m) => m.role === 'toolResult' && m.toolName === 'write')),
		120000,
	).then(() => true).catch(() => false);
	const finalAnswerSeen = await client.waitFor((c) => c.state?.isStreaming === false && c.state.messages.some((m) => m.role === 'assistant' && m.content?.some((b) => b.type === 'text' && b.text === 'done')), 120000).then(() => true).catch(() => false);
	const firstWrite = client.deltas.findIndex((d) => d.appended.some((m) => m.role === 'toolResult' && m.toolName === 'write'));
	const turnDeltas = firstWrite < 0 ? [] : client.deltas.slice(0, firstWrite + 1);
	// 3. Ask for the authoritative state instead of trusting the delta stream.
	const snapBefore = client.snapshots.length;
	client.send({ type: 'get_state' });
	await client.waitFor((c) => c.snapshots.length > snapBefore, 60000).catch(() => null);
	await sleep(300);

	const state = client.state;
	const messages = state?.messages ?? [];
	const newMessages = messages.filter((m) => !beforeIds.has(m.id));
	const textOf = (m) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]).filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
	const blocksOf = (m) => (Array.isArray(m.content) ? m.content : []);

	const userMessage = newMessages.find((m) => m.role === 'user' && textOf(m).includes('write a file')) ?? null;
	const assistantCall = newMessages.find((m) => m.role === 'assistant' && blocksOf(m).some((b) => b.type === 'toolCall' && b.name === 'write')) ?? null;
	const callId = assistantCall ? blocksOf(assistantCall).find((b) => b.type === 'toolCall' && b.name === 'write')?.id : null;
	// Locate the first write result to verify that its delta append is unique.
	const firstResultId = turnDeltas.at(-1)?.appended?.find((m) => m.role === 'toolResult' && m.toolName === 'write')?.id;
	const turnEnd = firstResultId ? messages.findIndex((m) => m.id === firstResultId) : messages.length - 1;
	const writeResults = messages.filter((m, i) => i <= turnEnd && i >= 0 && !beforeIds.has(m.id) && m.role === 'toolResult' && m.toolName === 'write');
	const matchingResult = writeResults.find((m) => m.toolCallId === callId) ?? null;

	const requiredRoles = {
		user: userMessage ? 1 : 0,
		assistantToolCall: assistantCall ? 1 : 0,
		toolResult: matchingResult ? 1 : 0,
	};
	const injectedIds = new Set([userMessage?.id, assistantCall?.id, matchingResult?.id].filter(Boolean));
	const extraNewMessages = newMessages
		.filter((m) => !injectedIds.has(m.id))
		.map((m) => ({ role: m.role, preview: textOf(m).slice(0, 40) }));
	const illegalExtra = extraNewMessages.filter((m) => !['assistant', 'system'].includes(m.role));

	// The delta carrying the toolResult must contain it exactly once.
	const appended = turnDeltas.flatMap((d) => d.appended ?? []);
	const resultAppends = matchingResult ? appended.filter((m) => m.id === matchingResult.id).length : 0;
	const writeResultText = matchingResult ? textOf(matchingResult).slice(0, 80) : null;
	const writeResultSucceeded = matchingResult ? (writeResultText.includes('note.txt') || matchingResult.isError === false) : false;

	const noticeKinds = {};
	for (const text of client.notices.map((n) => n.text)) {
		const kind = text.includes('正在校验会话文件') ? 'validator-blocking' : text.includes('切换模型失败') ? 'model-switch' : 'other';
		noticeKinds[kind] = (noticeKinds[kind] ?? 0) + 1;
	}

	const failures = [];
	if (!toolResultSeen) failures.push('turn produced no write toolResult');
	if (!finalAnswerSeen) failures.push('turn produced no final answer after the toolResult');
	if (requiredRoles.user !== 1) failures.push('user message missing from client state');
	if (requiredRoles.assistantToolCall !== 1) failures.push('assistant toolCall(write) missing from client state');
	if (requiredRoles.toolResult !== 1) failures.push('no toolResult matching the write toolCall');
	if (writeResults.length !== 1) failures.push(`${writeResults.length} write toolResults (expected 1)`);
	if (extraNewMessages.some((m) => m.role === 'toolResult')) failures.push('extra toolResult(s) appended beyond the turn');
	if (illegalExtra.length) failures.push(`unexpected roles in new messages: ${illegalExtra.map((m) => m.role).join(',')}`);
	if (resultAppends !== 1) failures.push(`toolResult appeared ${resultAppends}× in delta appends (expected 1)`);
	if (!writeResultSucceeded) failures.push('write tool did not succeed');
	if (noticeKinds['validator-blocking']) failures.push(`${noticeKinds['validator-blocking']} validator-blocking notice(s)`);
	if (noticeKinds['model-switch']) failures.push(`${noticeKinds['model-switch']} model-switch notice(s)`);

	const dump = await server.stop();
	return {
		modelSwitch: 'confirmed',
		modelId: state?.model?.id ?? null,
		requiredRoles,
		duplicateToolResults: Math.max(0, writeResults.length - 1),
		extraNewMessages: extraNewMessages.slice(0, 5),
		resultAppends,
		writeResultText,
		notices: client.notices.map((n) => n.text).slice(0, 5),
		noticeKinds,
		failures,
		dump,
	};
}

/** Sampling overhead control: same 20 get_state round trips with sampling off. */
async function scenarioOverheadOff(iteration) {
	const server = await startServer(`off-${iteration}`, false);
	const client = attachClient(server.ws);
	await openFixture(client, `bench-off-${iteration}`, server);
	const roundTrips = [];
	client.snapshots.length = 0;
	for (let i = 0; i < 20; i++) {
		const before = client.snapshots.length;
		const t = now();
		client.send({ type: 'get_state' });
		await client.waitFor((c) => c.snapshots.length > before, 60000);
		roundTrips.push(now() - t);
	}
	const dump = await server.stop();
	return { roundTrips: stat(roundTrips), dump };
}

function pickClient(dump) {
	if (!dump) return null;
	const ids = Object.keys(dump.clients ?? {});
	// A second clientId means an unrelated (empty) session's numbers would be
	// mixed into the result — refuse rather than average.
	assert(ids.length <= 1, `timings dump has ${ids.length} clients (${ids.join(', ')}); expected exactly one`);
	return ids.length === 1 ? dump.clients[ids[0]] : null;
}

const s6 = { fixture: loadFixtureName, expectedMessages: loadFixture.count, rounds: ROUNDS };
await assertPortFree();
phase(`S6-load + S6a full (${ROUNDS} rounds)`);
const fullRounds = [], offRounds = [], incrRounds = [], changeRounds = [];
try {
	for (let round = 1; round <= ROUNDS; round++) {
		fullRounds.push(await scenarioFull(round));
		phase(`S6b incremental round ${round}`);
		incrRounds.push(await scenarioIncremental(round));
		phase(`S6c change round ${round}`);
		changeRounds.push(await scenarioChange(round));
		phase(`overhead control round ${round}`);
		offRounds.push(await scenarioOverheadOff(round));
	}
} finally {
	mock.close();
}

const loadOk = fullRounds.every((r) => r.loaded === loadFixture.count) && fullRounds.length === ROUNDS;
const fullReports = fullRounds.map((r) => pickClient(r.dump));
const offReports = offRounds.map((r) => pickClient(r.dump));
const incrReports = incrRounds.map((r) => pickClient(r.dump));
const changeReports = changeRounds.map((r) => pickClient(r.dump));

const mergeCounters = (reports) => {
	const merged = {};
	for (const report of reports) for (const [key, value] of Object.entries(report?.counters ?? {})) merged[key] = (merged[key] ?? 0) + value;
	return merged;
};
const medianAcross = (reports, path) => {
	const values = reports.map((r) => path(r)).filter((v) => typeof v === 'number');
	return values.length ? quantile(values, 0.5) : 0;
};
const mark = (report, name, field) => report?.marks?.[name]?.[field] ?? 0;
const meanMark = (report, name) => mark(report, name, 'count') ? mark(report, name, 'totalMs') / mark(report, name, 'count') : 0;
const meanAcross = (reports, name) => medianAcross(reports, (r) => meanMark(r, name));
/** The two snapshot message kinds, in report order. */
const SNAPSHOT_KINDS = ['snapshot', 'snapshot_delta'];
const byteStat = (report, name) => report?.bytes?.[name] ?? null;
/** Median array of a byte field across rounds; null when a round had no sample
 *  (a 0 would read as "zero-byte message"). */
const byteAcross = (reports, name, field) => {
	const values = reports.map((r) => byteStat(r, name)?.[field]).filter((v) => typeof v === 'number');
	return values.length ? quantile(values, 0.5) : null;
};

/** `snapshot_total:<kind>` mark → { p50, p95, count }; count 0 when the kind
 *  never occurred (e.g. no delta in a full-snapshot round). */
const kindMark = (reports, kind) => ({
	p50: medianAcross(reports, (r) => mark(r, `snapshot_total:${kind}`, 'p50')),
	p95: medianAcross(reports, (r) => mark(r, `snapshot_total:${kind}`, 'p95')),
	count: reports.reduce((a, r) => a + mark(r, `snapshot_total:${kind}`, 'count'), 0),
});

/** One wire section entry, or null when the type never travelled. */
const wireEntry = (reports, type) => {
	const key = `wire_bytes_p50:${type}`;
	const count = reports.filter((r) => byteStat(r, key)).reduce((a, r) => a + byteStat(r, key).count, 0);
	if (count === 0) return null;
	return {
		count,
		totalBytes: reports.reduce((a, r) => a + (byteStat(r, key)?.total ?? 0), 0),
		p50Bytes: byteAcross(reports, key, 'p50'),
		p95Bytes: byteAcross(reports, key, 'p95'),
		maxBytes: reports.reduce((a, r) => Math.max(a, byteStat(r, key)?.max ?? 0), 0),
	};
};

/** S6c status rules (fixed, not discretionary):
 *  - any round never confirmed the model switch      → unmeasured
 *  - every round passes all checks, zero notices     → measured
 *  - anything else                                   → partial + reason
 */
function summarizeChange(rounds, reports) {
	const noticeKinds = {};
	for (const round of rounds) for (const [kind, count] of Object.entries(round.noticeKinds ?? {})) noticeKinds[kind] = (noticeKinds[kind] ?? 0) + count;
	const requiredRoles = { user: 0, assistantToolCall: 0, toolResult: 0 };
	for (const round of rounds) for (const key of Object.keys(requiredRoles)) requiredRoles[key] += round.requiredRoles?.[key] ?? 0;
	const reasons = [];
	const unconfirmed = rounds.filter((r) => r.modelSwitch !== 'confirmed').length;
	if (unconfirmed) reasons.push(`model switch not confirmed in ${unconfirmed}/${rounds.length} round(s)`);
	for (const round of rounds) for (const failure of round.failures ?? []) reasons.push(failure);
	const status = unconfirmed ? 'unmeasured' : reasons.length ? 'partial' : 'measured';
	return {
		writeToolResults: rounds.reduce((a, r) => a + (r.requiredRoles?.toolResult ?? 0), 0),
		model: rounds[0]?.modelId ?? null,
		requiredRoles,
		duplicateToolResults: rounds.reduce((a, r) => a + (r.duplicateToolResults ?? 0), 0),
		extraNewMessages: rounds.flatMap((r) => r.extraNewMessages ?? []).slice(0, 5),
		resultAppends: rounds.map((r) => r.resultAppends ?? 0),
		writeResultText: rounds.map((r) => r.writeResultText).filter(Boolean).slice(0, 1),
		notices: rounds.flatMap((r) => r.notices ?? []).slice(0, 5),
		noticeKinds,
		deltaGenerated: mergeCounters(reports)['snapshot_generated:snapshot_delta'] ?? 0,
		status,
		...(status === 'measured' ? {} : { reason: [...new Set(reasons)].join('; ') }),
	};
}

const s6report = {
	load: { fixture: loadFixtureName, expected: loadFixture.count, observed: fullRounds.map((r) => r.loaded), ok: loadOk },
	status: loadOk ? 'measured' : 'unmeasured',
	...(loadOk ? {} : { reason: 'history not loaded — fixture message count never appeared in a snapshot' }),
	s6a: loadOk ? {
		fullSnapshots: mergeCounters(fullReports)['snapshot_kind:snapshot'] ?? 0,
		roundTrip: round(stat(fullRounds.map((r) => r.roundTrips.p50))),
		roundTripP95: round(stat(fullRounds.map((r) => r.roundTrips.p95))),
		jsonParse: { p50: medianAcross(fullRounds, (r) => r.jsonParse.p50), p95: medianAcross(fullRounds, (r) => r.jsonParse.p95) },
		composition: fullRounds.map((r) => r.composition),
		scenario: 'forced-full-resync',
		snapshot_build_full: kindMark(fullReports, 'snapshot'),
		snapshot_build_delta: kindMark(fullReports, 'snapshot_delta'),
		// Mixed full+delta. Kept for continuity with older runs; never cite it
		// as "full snapshot p95" — use snapshot_build_full.
		snapshot_total: { p50: medianAcross(fullReports, (r) => mark(r, 'snapshot_total', 'p50')), p95: medianAcross(fullReports, (r) => mark(r, 'snapshot_total', 'p95')), count: fullReports.reduce((a, r) => a + mark(r, 'snapshot_total', 'count'), 0), label: 'mixed full+delta (legacy)' },
		current_messages: { p50: medianAcross(fullReports, (r) => mark(r, 'current_messages', 'p50')), p95: medianAcross(fullReports, (r) => mark(r, 'current_messages', 'p95')) },
		light_state: { p50: medianAcross(fullReports, (r) => mark(r, 'light_state', 'p50')), p95: medianAcross(fullReports, (r) => mark(r, 'light_state', 'p95')) },
		serialize_cached: { mean: meanAcross(fullReports, 'serialize_cached'), max: medianAcross(fullReports, (r) => mark(r, 'serialize_cached', 'maxMs')) },
		metadata_hash: { meanPerCall: meanAcross(fullReports, 'metadata_hash'), maxPerCall: medianAcross(fullReports, (r) => mark(r, 'metadata_hash', 'maxMs')) },
		metadata_hash_snapshot: { p50: medianAcross(fullReports, (r) => mark(r, 'metadata_hash_snapshot', 'p50')), p95: medianAcross(fullReports, (r) => mark(r, 'metadata_hash_snapshot', 'p95')) },
		fingerprint: { meanPerCall: meanAcross(fullReports, 'fingerprint') },
		cache_lookup: { meanPerCall: meanAcross(fullReports, 'cache_lookup') },
		// Session stats, cache-warming view, codemode history and task progress
		// share one mark: separate names would exceed the sampler's name cap.
		// Samples are not retained for it (mean/max only), so report those.
		light_rest: { mean: medianAcross(fullReports, (r) => (mark(r, 'light_rest', 'count') ? mark(r, 'light_rest', 'totalMs') / mark(r, 'light_rest', 'count') : 0)), max: medianAcross(fullReports, (r) => mark(r, 'light_rest', 'maxMs')) },
		ws_serialize_cold: { p50: medianAcross(fullReports, (r) => mark(r, 'ws_serialize_cold', 'p50')) },
		ws_serialize_hit: { p50: medianAcross(fullReports, (r) => mark(r, 'ws_serialize_hit', 'p50')) },
		ws_byte_length: { p50: medianAcross(fullReports, (r) => mark(r, 'ws_byte_length', 'p50')) },
		ws_send: { p50: medianAcross(fullReports, (r) => mark(r, 'ws_send', 'p50')) },
		// Per-MESSAGE-type wire sizes. `totalBytes` is cumulative for that type;
		// p50/p95 are the size of ONE message of that type — never divide one by
		// the other. null = the type never travelled in these rounds.
		wire: Object.fromEntries(
			[...new Set(fullReports.flatMap((r) => Object.keys(r?.bytes ?? {}).map((k) => k.slice('wire_bytes_p50:'.length))))]
				.filter((type) => type !== 'other' && !type.startsWith('other:'))
				// Snapshot kinds first (they are the subject), then by name.
				.sort((a, b) => (SNAPSHOT_KINDS.indexOf(a) + 1 || 99) - (SNAPSHOT_KINDS.indexOf(b) + 1 || 99) || a.localeCompare(b))
				.map((type) => [type, wireEntry(fullReports, type)]),
		),
		wire_other_total: wireEntry(fullReports, 'other')?.totalBytes ?? null,
		counters: mergeCounters(fullReports),
	} : null,
	s6b: loadOk ? {
		emptyDeltas: incrRounds.reduce((a, r) => a + r.emptyDeltas, 0),
		nonEmptyDeltas: incrRounds.reduce((a, r) => a + r.nonEmpty, 0),
		deltaGenerated: mergeCounters(incrReports)['snapshot_generated:snapshot_delta'] ?? 0,
		status: incrRounds.every((r) => r.emptyDeltas > 0) ? 'measured' : 'unmeasured',
		...(incrRounds.every((r) => r.emptyDeltas > 0) ? {} : { reason: 'no snapshot_delta with appended.length === 0 was observed between forced get_state calls' }),
	} : null,
	s6c: loadOk ? summarizeChange(changeRounds, changeReports) : null,
	classification: loadOk ? {
		snapshot_generated: Object.entries(mergeCounters(fullReports)).filter(([k]) => k.startsWith('snapshot_generated:')).reduce((a, [, v]) => a + v, 0),
		snapshot_sent: Object.entries(mergeCounters(fullReports)).filter(([k]) => k.startsWith('snapshot_sent:')).reduce((a, [, v]) => a + v, 0),
		snapshot_dropped: Object.entries(mergeCounters(fullReports)).filter(([k]) => k.startsWith('snapshot_dropped:')).reduce((a, [, v]) => a + v, 0),
	} : null,
};

// Ratio from RAW p50s (sampling-overhead-ratio.mjs): rounding both sides
// first collapsed any difference below 0.6 % to ratio === 1 and always passed.
const onP50 = stat(fullRounds.map((r) => r.roundTrips.p50)).p50;
const offP50 = stat(offRounds.map((r) => r.roundTrips.p50)).p50;
const { ratio, pass } = samplingOverheadRatio(onP50, offP50);
s6report.overhead = {
	samplingOnRoundTripP50: Math.round(onP50 * 100) / 100,
	samplingOffRoundTripP50: Math.round(offP50 * 100) / 100,
	ratio,
	pass,
};

// ---------------------------------------------------------------------------
// M2 decision rules — every item records the numbers that drove it.
// ---------------------------------------------------------------------------
function decide() {
	const a = s6report.s6a;
	const emptyMicro = { dupKeyMs: { p50: 0 }, metadataBytesPerRound: 0 };
	const largeMicro = s3['large@100'] ?? emptyMicro;
	const nestedMicro = s3['nested@500'] ?? emptyMicro;
	const rules = [];
	const pushed = (id, decision, trigger) => rules.push({ id, decision, trigger });

	if (s6report.status !== 'measured') {
		for (const id of ['key-once', 'metadata-hash-miss-only', 'estimate-context-parts', 'cache-warming-view']) pushed(id, 'skip', 'production path unmeasured (S6-load failed)');
		pushed('delete-lastMessagesSig', 'run', 'dead field, no reader — unconditional');
		return rules;
	}
	const cheap = a.current_messages.p50 < 2;
	pushed('key-once', cheap ? 'skip' : (largeMicro.dupKeyMs.p50 >= 2 || a.current_messages.p50 >= 5) ? 'run' : 'skip',
		`dupKeyMs(large).p50=${largeMicro.dupKeyMs.p50} current_messages.p50=${a.current_messages.p50} cheap=${cheap}`);
	// S6a's own trigger is the production number (metadata_hash on every
	// toolResult per full snapshot); the S3 nested-group figure is a fallback
	// for the case where the production run has too few toolResults to exceed
	// the 1 ms p50 threshold while the nested transcript is still heavy.
	pushed('metadata-hash-miss-only', cheap ? 'skip' : (a.metadata_hash_snapshot.p50 >= 1 || nestedMicro.metadataBytesPerRound >= 200 * 1024) ? 'run' : 'skip',
		`metadata_hash_snapshot.p50=${a.metadata_hash_snapshot.p50} nested.metadataBytesPerRound=${Math.round(nestedMicro.metadataBytesPerRound)} cheap=${cheap}`);
	pushed('delete-lastMessagesSig', 'run', 'dead field, no reader — unconditional');
	pushed('estimate-context-parts', cheap ? 'skip' : a.light_rest.mean >= 2 ? 'run' : 'skip', `light_rest.mean=${a.light_rest.mean} ms/call (stats + cacheWarming + codemode + taskProgress) cheap=${cheap}`);
	pushed('cache-warming-view', cheap ? 'skip' : a.light_rest.mean >= 5 ? 'run' : 'skip', `light_rest.mean=${a.light_rest.mean} cheap=${cheap}`);
	if (cheap) pushed('note', 'skip', `current_messages.p50 = ${Math.round(a.current_messages.p50 * 1000) / 1000} ms < 2 ms (serialize_cached is nested): production data does not support snapshot dedupe work`);
	return rules;
}

const environment = {
	node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, totalmem: totalmem(), cpus: cpus().length,
	commit: safe(() => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()),
	// A commit alone cannot describe a run made on a dirty worktree: record how
	// much was uncommitted so two JSONs are comparable at all.
	gitDiffHead: safe(() => execFileSync('git', ['diff', '--stat', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').at(-1)?.trim() ?? null),
	gitStatusCount: safe(() => execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean).length),
	package: JSON.parse(readFileSync('package.json', 'utf8')).version,
	sdk: JSON.parse(readFileSync('node_modules/@earendil-works/pi-coding-agent/package.json', 'utf8')).version,
	protocolVersion: PROTOCOL_VERSION, rounds: ROUNDS, s6Fixture: loadFixtureName, s6ExpectedMessages: loadFixture.count,
};
function safe(fn) { try { return fn(); } catch { return null; } }

const report = {
	schemaVersion: 2,
	generatedAt: new Date().toISOString(),
	environment,
	fixtures: Object.fromEntries(Object.entries(fixtures).map(([name, f]) => [name, { messages: f.count }])),
	s1: round(s1),
	s2: round(s2),
	s3,
	s4,
	s5: s5.map(round),
	s6: s6report,
	decisions: decide(),
};

mkdirSync(resolve(OUT, '..'), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
printSummary(report);
rmSync(base, { recursive: true, force: true });
phase('done');

function printSummary(r) {
	const d = (v) => (Math.round(v * 1000) / 1000).toString();
	console.log(`\n# host-latency benchmark\n`);
	console.log(`| item | value |\n|---|---|`);
	console.log(`| node / sdk | ${r.environment.node} / ${r.environment.sdk} |`);
	console.log(`| fixture | ${r.environment.s6Fixture} (${r.environment.s6ExpectedMessages} messages) |`);
	console.log(`| S6 status | ${r.s6.status} |`);
	for (const [name, stat] of Object.entries({ S1bash: r.s1.bashTrue, S2bashTool: r.s2 })) console.log(`| ${name} p50/p95 (ms) | ${d(stat.p50)} / ${d(stat.p95)} |`);
	for (const [group, item] of Object.entries(r.s3)) console.log(`| S3 ${group} hitRate / meta KB/rnd / dupKey p50 | ${item.hitRate.toFixed(3)} / ${(item.metadataBytesPerRound / 1024).toFixed(0)} / ${d(item.dupKeyMs.p50)} |`);
	const a = r.s6.s6a;
	if (a) {
		const mib = (bytes) => (typeof bytes === 'number' ? (bytes / 1048576).toFixed(2) : 'n/a');
		console.log(`| S6a forced-full build p50/p95 (ms) | ${d(a.snapshot_build_full.p50)} / ${d(a.snapshot_build_full.p95)} (n=${a.snapshot_build_full.count}) |`);
		console.log(`| S6a delta snapshot build p50/p95 (ms) | ${d(a.snapshot_build_delta.p50)} / ${d(a.snapshot_build_delta.p95)} (n=${a.snapshot_build_delta.count}) |`);
		console.log(`| S6a mixed build p50/p95 (full+delta, legacy) | ${d(a.snapshot_total.p50)} / ${d(a.snapshot_total.p95)} |`);
		console.log(`| S6a one-message uncompressed snapshot p50/p95 (MiB) | ${mib(a.wire.snapshot?.p50Bytes)} / ${mib(a.wire.snapshot?.p95Bytes)} |`);
		console.log(`| S6a one-message uncompressed snapshot_delta p50/p95 (KiB) | ${a.wire.snapshot_delta ? (a.wire.snapshot_delta.p50Bytes / 1024).toFixed(1) : 'n/a'} / ${a.wire.snapshot_delta ? (a.wire.snapshot_delta.p95Bytes / 1024).toFixed(1) : 'n/a'} |`);
		console.log(`| S6a current_messages p50/p95 | ${d(a.current_messages.p50)} / ${d(a.current_messages.p95)} |`);
		console.log(`| S6a light_state p50/p95 | ${d(a.light_state.p50)} / ${d(a.light_state.p95)} |`);
		console.log(`| S6a metadata_hash per-snapshot p50/p95 | ${d(a.metadata_hash_snapshot.p50)} / ${d(a.metadata_hash_snapshot.p95)} |`);
		console.log(`| S6a light_rest mean/max | ${d(a.light_rest.mean)} / ${d(a.light_rest.max)} |`);
		console.log(`| S6a ws_serialize cold / hit p50 | ${d(a.ws_serialize_cold.p50)} / ${d(a.ws_serialize_hit.p50)} |`);
		console.log(`| S6a ws_byte_length / client JSON.parse p50 | ${d(a.ws_byte_length.p50)} / ${d(a.jsonParse.p50)} |`);
		console.log(`| S6a cache hits / misses | ${a.counters.cache_hit ?? 0} / ${a.counters.cache_miss ?? 0} |`);
		console.log(`| S6a uncompressed JSON bytes (cumulative, all types) | ${a.counters.uncompressed_json_bytes ?? 0} |`);
		const composition = a.composition[0];
		if (composition) console.log(`| S6a toolResult content / total snapshot | ${(composition.toolResultContentRatio * 100).toFixed(2)}% (${composition.categories.toolResultContent} / ${composition.totalBytes} B) |`);
		const others = Object.entries(a.wire).filter(([type]) => !SNAPSHOT_KINDS.includes(type)).sort(([, x], [, y]) => (y?.totalBytes ?? 0) - (x?.totalBytes ?? 0)).slice(0, 4);
		for (const [type, w] of others) console.log(`| S6a wire ${type} (count / total B) | ${w?.count ?? 0} / ${w?.totalBytes ?? 0} |`);
	}
	console.log(`| S6b empty deltas | ${r.s6.s6b?.emptyDeltas ?? 'n/a'} |`);
	console.log(`| S6c write toolResults | ${r.s6.s6c?.writeToolResults ?? 'n/a'} |`);
	if (r.s6.s6c) {
		console.log(`| S6c status | ${r.s6.s6c.status}${r.s6.s6c.reason ? ` — ${r.s6.s6c.reason}` : ''} |`);
		console.log(`| S6c required roles (user / toolCall / toolResult) | ${r.s6.s6c.requiredRoles.user} / ${r.s6.s6c.requiredRoles.assistantToolCall} / ${r.s6.s6c.requiredRoles.toolResult} |`);
		console.log(`| S6c duplicate toolResults / delta appends | ${r.s6.s6c.duplicateToolResults} / ${JSON.stringify(r.s6.s6c.resultAppends)} |`);
		console.log(`| S6c notice kinds | ${JSON.stringify(r.s6.s6c.noticeKinds)} |`);
	}
	console.log(`| sampling overhead ratio | ${d(r.s6.overhead.ratio)} (pass=${r.s6.overhead.pass}) |`);
	for (const rule of r.decisions) console.log(`| decision ${rule.id} | ${rule.decision} — ${rule.trigger} |`);
}
