// Native SDK configuration/accounting and SSH disposal. No model requests.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubHostEnv } from "./lib/test-env.mjs";
scrubHostEnv();
const root = mkdtempSync(join(tmpdir(), "pi-cache-warming-"));
const agentDir = join(root, "agent"), project = join(root, "project");
mkdirSync(agentDir); mkdirSync(project); mkdirSync(join(project, ".pi"));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: [], compaction: { enabled: false } }));
writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
const { SettingsManager, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
const { cacheWarmingSettings, cacheWarmingView, setGlobalCacheWarming } = await import("../dist/server/cache-warming.js");
const { ClientSession } = await import("../dist/server/agent-service.js");
const { ClientStateStore } = await import("../dist/server/client-state.js");
const { ThinkingDurationStore } = await import("../dist/server/thinking-timing.js");
const { NodeAgent } = await import("../dist/server/node-agent.js");
const { NodeWorkbench } = await import("../dist/server/node-workbench.js");
const clients = [], nodes = [];
let workbench;
const operations = { command: async () => { throw new Error("Unexpected command"); }, read: async () => "", write: async () => {} };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const node = suffix => { const value = new NodeAgent(join(root, suffix), "/srv", operations, () => {}); nodes.push(value); return value; };
try {
	const settings = cacheWarmingSettings(SettingsManager.create(project, agentDir, { projectTrusted: true }));
	assert.equal(settings.getProjectSettings().cacheWarming, "idle");
	assert.equal(settings.getCacheWarmingMode(), "streaming", "project cannot enable idle warming");
	for (const mode of ["off", "idle", "streaming"]) assert.equal(cacheWarmingSettings(SettingsManager.inMemory({ cacheWarming: mode })).getCacheWarmingMode(), mode);
	assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"))).cacheWarming, undefined);
	const stores = [new ClientStateStore(join(root, "state.json")), new ThinkingDurationStore(join(root, "thinking.json"))];
	const normal = await ClientSession.create("normal", project, ...stores); clients.push(normal);
	const wiki = await ClientSession.create("wiki", project, ...stores, true); clients.push(wiki);
	const ssh = node("ssh"); await ssh.start();
	const wire = []; normal.attachSink(message => wire.push(message));
	for (const mode of ["off", "idle", "streaming"]) {
		await setGlobalCacheWarming(agentDir, mode);
		for (const session of [normal.session, wiki.session, ssh.session]) assert.equal(session.settingsManager.getCacheWarmingMode(), mode);
		assert.equal(ssh.snapshot().stats.cacheWarming.mode, mode);
		assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"))).cacheWarming, mode);
		assert.deepEqual(JSON.parse(readFileSync(join(project, ".pi", "settings.json"))), { cacheWarming: "idle" });
	}
	await Promise.all([setGlobalCacheWarming(agentDir, "idle"), setGlobalCacheWarming(agentDir, "off")]);
	assert.equal(normal.session.settingsManager.getCacheWarmingMode(), "off");
	const savedSettings = readFileSync(join(agentDir, "settings.json"), "utf8");
	writeFileSync(join(agentDir, "settings.json"), "{invalid");
	await assert.rejects(setGlobalCacheWarming(agentDir, "idle"), /Could not save/);
	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), "{invalid");
	assert.equal(normal.session.settingsManager.getCacheWarmingMode(), "off");
	writeFileSync(join(agentDir, "settings.json"), savedSettings);
	const fresh = node("fresh"); await fresh.start();
	assert.equal(fresh.session.settingsManager.getCacheWarmingMode(), "off");
	await assert.rejects(setGlobalCacheWarming(agentDir, "invalid"), /Invalid/);
	const usage = { input: 1, output: 0, cacheRead: 5, cacheWrite: 0, totalTokens: 6, cost: { input: 0.01, output: 0, cacheRead: 0.02, cacheWrite: 0, total: 0.03 } };
	const session = normal.session, conv = normal.conv;
	const beforeMessages = session.messages.length, beforeCost = session.getSessionStats().cost;
	const entry = session.sessionManager.appendUsage("cache_warm", "fixture", "fixture", usage);
	conv.lastSdkEventAt = 123; conv.stallNoticed = true;
	const eventIndex = wire.length;
	session._emit({ type: "entry_appended", entry }); normal.flushSnapshot(true);
	const snapshot = wire.findLast(message => message.type === "snapshot").state;
	assert.equal(snapshot.stats.cost, beforeCost + 0.03); assert.equal(snapshot.stats.cacheWarming.cost, 0.03);
	assert.equal(snapshot.messages.length, beforeMessages); assert.equal(snapshot.isStreaming, false);
	assert.equal(conv.lastSdkEventAt, 123); assert.equal(conv.stallNoticed, true);
	assert(!wire.slice(eventIndex).some(message => message.type === "agent_silence"));
	const other = session.sessionManager.appendUsage("other", "fixture", "fixture", usage);
	session._emit({ type: "entry_appended", entry: other });
	assert.equal(cacheWarmingView(session).cost, 0.03);
	const sshEntry = ssh.session.sessionManager.appendUsage("cache_warm", "fixture", "fixture", usage);
	ssh.session._emit({ type: "entry_appended", entry: sshEntry });
	assert.equal(ssh.snapshot().stats.cacheWarming.cost, 0.03); assert.equal(ssh.snapshot().running, false);
	const manager = SessionManager.create(project, join(root, "history"));
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture" }], api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(), usage });
	manager.appendUsage("cache_warm", "fixture", "fixture", usage);
	assert.equal(SessionManager.open(manager.getSessionFile()).getEntries().find(item => item.type === "usage").usage.cost.total, 0.03);
	// Closing stays pending until the native credential write completes.
	const gate = deferred(), entered = deferred();
	const runtime = ssh.session.modelRuntime, settle = runtime.settleCredentialWrites.bind(runtime);
	runtime.settleCredentialWrites = async () => { entered.resolve(); await gate.promise; await settle(); };
	let closed = false; const closing = ssh.close().then(() => { closed = true; });
	await entered.promise; await tick(); assert.equal(closed, false);
	assert.equal(ssh.snapshot().phase, "closed"); assert.equal(ssh.close(), ssh.closing);
	gate.resolve(); await closing;
	// Replacement also waits for the previous session's credential writes.
	const replacementGate = deferred(), replacementEntered = deferred();
	const previousSession = fresh.session, previousSettle = previousSession.modelRuntime.settleCredentialWrites.bind(previousSession.modelRuntime);
	previousSession.modelRuntime.settleCredentialWrites = async () => { replacementEntered.resolve(); await replacementGate.promise; await previousSettle(); };
	let replaced = false; const replacing = fresh.newSession().then(() => { replaced = true; });
	await replacementEntered.promise; await tick(); assert.equal(replaced, false);
	replacementGate.resolve(); await replacing; assert.notEqual(fresh.session, previousSession);
	// Shutdown must also wait for agents already removed by a prior disconnect.
	workbench = new NodeWorkbench(join(root, "workbench"));
	const disconnected = node("disconnected"); await disconnected.start();
	const shutdownGate = deferred(), shutdownEntered = deferred();
	const disconnectedRuntime = disconnected.session.modelRuntime, disconnectedSettle = disconnectedRuntime.settleCredentialWrites.bind(disconnectedRuntime);
	disconnectedRuntime.settleCredentialWrites = async () => { shutdownEntered.resolve(); await shutdownGate.promise; await disconnectedSettle(); };
	const connection = { clientId: "fixture", nodeId: "node", agent: disconnected, terminals: new Map(), client: { end() {} } };
	workbench.connections.set(JSON.stringify([connection.clientId, connection.nodeId]), connection);
	const dropping = workbench.drop(connection); await shutdownEntered.promise;
	assert.equal(workbench.connections.size, 0);
	let shutDown = false; const disposing = workbench.dispose().then(() => { shutDown = true; });
	await tick(); assert.equal(shutDown, false);
	shutdownGate.resolve(); await Promise.all([dropping, disposing]);
	// Closing during resource loading cannot leave a late ready session.
	const loading = deferred(), loadingEntered = deferred(), reload = DefaultResourceLoader.prototype.reload;
	DefaultResourceLoader.prototype.reload = async function (...args) { loadingEntered.resolve(); await loading.promise; return reload.apply(this, args); };
	const racing = node("race");
	try {
		const starting = racing.start(); const rejected = assert.rejects(starting, /已关闭/);
		await loadingEntered.promise;
		let finished = false; const closingRace = racing.close().then(() => { finished = true; });
		await tick(); assert.equal(finished, false);
		loading.resolve(); await Promise.all([rejected, closingRace]);
		assert.equal(racing.snapshot().phase, "closed"); assert.equal(racing.session, undefined);
	} finally { loading.resolve(); DefaultResourceLoader.prototype.reload = reload; }
	console.log("PASS global cache modes, normal/Wiki/SSH synchronization, native accounting and credential teardown races");
} finally {
	await workbench?.dispose();
	await Promise.all(nodes.map(value => value.close()));
	await Promise.all(clients.map(value => value.dispose()));
	rmSync(root, { recursive: true, force: true });
}
