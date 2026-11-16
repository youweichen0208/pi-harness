/** Real isolated PostgreSQL/MySQL; run through database-integration-test.mjs. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import WebSocket from "ws";
import pg from "pg";
import mysql from "mysql2/promise";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { mergeSnapshot } from "./lib/snapshots.mjs";
assert.equal(process.env.PI_TEST_DATABASE_FIXTURE, "owned-container", "Use database-integration-test.mjs to create owned, disposable databases");
const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-database-live-"))), data = join(root, "data"), agent = join(data, "omp/agent");
mkdirSync(agent, { recursive: true }); mkdirSync(join(root, ".dbeaver"));
const configs = [
	{ name: "Postgres analytics", driver: "postgres", host: "127.0.0.1", port: Number(process.env.PI_TEST_PG_PORT), user: "postgres", password: "pi_test_only", db_name: "analytics" },
	{ name: "MySQL analytics", driver: "mysql", host: "127.0.0.1", port: Number(process.env.PI_TEST_MYSQL_PORT), user: "root", password: "pi_test_only", db_name: "analytics" },
];
for (const config of configs) assert(Number.isInteger(config.port) && config.port >= 8900 && config.port <= 65535);
const postgres = new pg.Client({ host: "127.0.0.1", port: configs[0].port, user: "postgres", password: "pi_test_only", database: "analytics" });
let my, harness, browser, port, nextCall, calls = 0, cleaning, modelError;
const clients = [], modelRequests = [];
async function seed() {
	await postgres.connect();
	await postgres.query('CREATE SCHEMA "sales team"');
	await postgres.query('CREATE TABLE "sales team".orders (id bigint primary key, customer text, amount numeric)');
	await postgres.query('INSERT INTO "sales team".orders SELECT i, \'Customer \' || i, i * 10 FROM generate_series(1,120) AS i');
	await postgres.query('CREATE TABLE public.bigint_test (id bigint)');
	await postgres.query('INSERT INTO public.bigint_test VALUES (9007199254740993)');
	my = await mysql.createConnection({ host: "127.0.0.1", port: configs[1].port, user: "root", password: "pi_test_only", database: "analytics" });
	await my.query('CREATE TABLE orders (id bigint PRIMARY KEY, customer varchar(100), amount decimal(12,2))');
	await my.query('INSERT INTO orders (id,customer,amount) VALUES ?', [Array.from({ length: 120 }, (_, i) => [i + 1, `Customer ${i + 1}`, (i + 1) * 10])]);
	console.log(JSON.stringify({ postgres: (await postgres.query('SELECT version()')).rows[0].version, mysql: (await my.query('SELECT VERSION() AS version'))[0][0].version }));
}
const mock = createServer(async (req, res) => {
	try {
		let raw = ''; for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw); modelRequests.push(body);
		calls++; const args = nextCall; nextCall = undefined;
		const name = body.tools?.find(tool => /^(?:_)?database_read$/.test(tool.function?.name))?.function.name;
		assert(name, "OMP exposes the database host tool in the native schema");
		const delta = args ? { tool_calls: [{ index: 0, id: `db-call-${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : { content: "Database analysis complete: 120 orders." };
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const [d, finish_reason] of [[delta, null], [{}, args ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason }] })}\n\n`);
		res.end("data: [DONE]\n\n");
	} catch (error) { modelError = error; res.writeHead(500); res.end("Fixture assertion failed"); }
});
const source = join(root, ".dbeaver/data-sources.json");
writeFileSync(source, JSON.stringify({ connections: { pg: { name: "Imported Postgres", driver: "postgres-jdbc", configuration: { host: "127.0.0.1", port: configs[0].port, user: "postgres", database: "analytics" } } } }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(check, label) { for (let i = 0; i < 400; i++) { if (modelError) throw modelError; if (await check()) return; if (harness?.child.exitCode != null) throw Error(harness.logs); await sleep(50); } throw Error(`Timeout: ${label}\n${harness?.logs}`); }
async function connect(id) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`), c = { id, ws, state: undefined, ready: false };
	clients.push(c); ws.on("message", raw => { const m = JSON.parse(raw); c.state = mergeSnapshot(c.state, m); if (m.type === "ready") c.ready = true; });
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	ws.send(JSON.stringify({ type: "hello", clientId: id })); await wait(() => c.state && c.ready, "hello"); return c;
}
const queryArgs = (connection, sql) => ({ action: 'query', connectionId: connection.id, database: 'analytics', sql });
function cleanup() {
	return cleaning ??= (async () => { await browser?.close(); clients.forEach(c => c.ws.terminate()); await harness?.stop(); mock.closeAllConnections(); if (mock.listening) await new Promise(r => mock.close(r)); await postgres.end().catch(() => {}); await my?.end(); rmSync(root, { recursive: true, force: true }); })();
}
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });
async function request(c, body, status = 200) {
	const r = await fetch(`http://127.0.0.1:${port}/api/database`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: root, clientId: c.id, conversationId: c.state.conversationId, requestId: crypto.randomUUID(), ...body }) });
	const result = await r.json(); assert.equal(r.status, status, JSON.stringify(result)); return result;
}
async function prompt(c, args) {
	nextCall = args; const before = calls;
	c.ws.send(JSON.stringify({ type: "prompt", text: "Analyze attached database", requestId: crypto.randomUUID() }));
	const toolCallId = `db-call-${before + 1}`;
	await wait(() => calls === before + 2 && !c.state.isStreaming && c.state.messages.some(m => m.role === "toolResult" && m.toolCallId === toolCallId) && c.state.messages.at(-1)?.role === "assistant", "agent query and settled snapshot");
	const returned = modelRequests[before + 1].messages.find(m => m.role === "tool" && m.tool_call_id === toolCallId);
	assert(returned, "the exact native tool result returns to the model");
	return c.state.messages.find(m => m.role === "toolResult" && m.toolCallId === toolCallId);
}
try {
	await seed();
	const mockPort = await listenIsolated(mock);
	writeFileSync(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: "fixture", models: [{ id: "fixture", input: ["text"], contextWindow: 200000, maxTokens: 8000 }] } } }));
	writeFileSync(join(agent, "config.yml"), JSON.stringify({ modelRoles: { default: "fixture/fixture" }, skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: data } }); port = harness.port;
	const a = await connect("db-a"), b = await connect("db-b");
	const saved = [];
	for (const config of configs) {
		await request(a, { action: "test", connection: config });
		const c = (await request(a, { action: "save", connection: config })).connections.find(c => c.name === config.name); saved.push(c);
		const run = extra => request(a, { action: "run", id: c.id, version: c.version, database: "analytics", ...extra });
		assert((await run({ operation: "databases" })).grid.rows.some(row => row[0] === "analytics"));
		assert((await run({ operation: "tables" })).grid.rows.some(row => row[1] === "orders"));
		assert((await run({ operation: "describe", schema: "sales team", table: "orders" })).grid.rows.some(row => row[0] === "index"));
		const page = await run({ operation: "page", schema: "sales team", table: "orders" }); assert.equal(page.grid.rows.length, 50); assert.equal(page.grid.truncated, true);
		const sql = c.driver === "postgres" ? 'SELECT count(*) AS n FROM "sales team".orders' : 'SELECT count(*) AS n FROM orders';
		assert.equal(Number((await run({ operation: "query", sql })).grid.rows[0][0]), 120);
		const manySql = c.driver === "postgres" ? 'SELECT a.id FROM "sales team".orders a CROSS JOIN "sales team".orders b' : 'SELECT a.id FROM orders a CROSS JOIN orders b';
		const many = (await run({ operation: "query", sql: manySql })).grid;
		assert.equal(many.rows.length, 1000); assert.equal(many.truncated, true);
		await request(a, { action: "run", id: c.id, version: c.version, operation: "query", sql: "DELETE FROM orders" }, 400);
	}
	assert(!readFileSync(join(data, "database/connections.json"), "utf8").includes("pi_test_only"));
	const c = saved[0];
	assert.equal((await request(a, { action: "run", id: c.id, version: c.version, operation: "query", sql: "SELECT id FROM bigint_test" })).grid.rows[0][0], "9007199254740993");
	await request(a, { action: "list", conversationId: "wrong" }, 409);
	let tool = await prompt(a, queryArgs(c, "select 1"));
	assert.equal(tool.isError, true, JSON.stringify(tool));
	assert.match(JSON.stringify(tool.content), /Host tool failed/, "native bridge must redact raw business exceptions");
	await request(a, { action: "grant", ids: [c.id], versions: { [c.id]: c.version } });
	assert.deepEqual((await request(b, { action: "list" })).grants, []);
	tool = await prompt(a, queryArgs(c, 'SELECT count(*) AS n FROM "sales team".orders'));
	assert(!tool.isError, JSON.stringify(tool)); assert.deepEqual(JSON.parse(tool.content.find(part => part.type === "text").text).rows, [["120"]]);
	await request(a, { action: "revoke", id: c.id });
	tool = await prompt(a, queryArgs(c, "select 1")); assert(tool.isError);
	const mysqlConnection = saved[1];
	await request(a, { action: "grant", ids: [mysqlConnection.id], versions: { [mysqlConnection.id]: mysqlConnection.version } });
	tool = await prompt(a, queryArgs(mysqlConnection, 'SELECT count(*) AS n FROM orders'));
	assert(!tool.isError, JSON.stringify(tool)); assert.deepEqual(JSON.parse(tool.content.find(part => part.type === "text").text).rows, [["120"]]);
	await request(a, { action: "revoke", id: mysqlConnection.id });
	assert(!JSON.stringify(modelRequests).includes("pi_test_only"), "database credentials never enter native model requests");
	assert(modelRequests.some(r => r.messages.some(m => m.role === "tool" && String(m.content).includes("120"))), "successful database results return to the model");
	// Cancellation must release a genuinely running database query.
	const queryId = crypto.randomUUID();
	const pending = request(a, { action: "run", id: c.id, version: c.version, requestId: queryId, operation: "query", sql: 'SELECT sum(a.amount*b.amount*c.amount*d.amount*e.amount) FROM "sales team".orders a CROSS JOIN "sales team".orders b CROSS JOIN "sales team".orders c CROSS JOIN "sales team".orders d CROSS JOIN "sales team".orders e' }, 400);
	const activeQuery = () => postgres.query("SELECT pid FROM pg_stat_activity WHERE datname = 'analytics' AND pid <> pg_backend_pid() AND state = 'active' AND query ILIKE '%sum(%' AND query ILIKE '%CROSS JOIN%'");
	await wait(async () => (await activeQuery()).rowCount === 1, "real PostgreSQL query running before cancel");
	await request(a, { action: "cancel", target: queryId }); assert.match((await pending).error, /cancelled/);
	await wait(async () => (await activeQuery()).rowCount === 0, "cancelled query released");
	assert.equal(Number((await postgres.query('SELECT count(*) FROM "sales team".orders')).rows[0].count), 120);
	const preview = (await request(a, { action: "preview", kind: "dbeaver", path: source })).preview;
	assert.equal(preview.items[0].hasPassword, false); await request(a, { action: "import", ticket: preview.ticket, keys: ["pg"] });
	if (process.argv.includes("--browser")) {
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
		const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.setDefaultTimeout(15000);
		const errors = []; page.on("pageerror", e => errors.push(e.message));
		await page.goto(`http://127.0.0.1:${port}`); await page.locator(".conn-dot.ok").first().waitFor({state:"attached"});
		const input = page.locator(".inputbar textarea"); await input.fill("Existing analysis draft");
		await page.locator('.inputbar input[type=file]').first().setInputFiles({name:"keep.txt",mimeType:"text/plain",buffer:Buffer.from("keep")});
		await page.getByRole("button", { name: "数据库", exact: true }).click();
		await page.locator(".database-workbench").waitFor();
		await page.locator(".database-tree-row", {hasText:"Postgres analytics"}).click();
		await page.locator(".database-tree-row", {hasText:/^analytics$/}).click();
		await page.locator(".database-tree-row", {hasText:/^orders$/}).click();
		await page.locator(".database-grid tbody tr").first().waitFor();
		assert.equal(await page.locator(".database-grid tbody tr").count(), 50);
		await page.getByRole("button", {name:"下一页",exact:true}).click(); await page.waitForFunction(() => document.querySelector('.database-actions') && document.querySelector('.database-main').textContent.includes('51–100'));
		await page.getByRole("button", {name:"结构",exact:true}).click(); await page.waitForFunction(() => document.querySelector('.database-grid')?.textContent.includes('orders_pkey'));
		await page.locator(".database-heading").getByRole("button", {name:"问 pi"}).click();
		await page.waitForFunction(() => document.querySelector('.inputbar textarea').value.includes('database:'));
		assert((await input.inputValue()).startsWith("Existing analysis draft")); assert.equal(await page.locator(".attach-chip.file").count(), 1);
		assert.equal(await page.locator(".inputbar").count(), 1);
		nextCall = queryArgs(c, 'SELECT count(*) AS n FROM "sales team".orders');
		const before = calls; await input.press("Enter"); await wait(() => calls === before + 2, "browser analysis");
		const returned = modelRequests[before + 1].messages.find(m => m.role === "tool" && m.tool_call_id === `db-call-${before + 1}`);
		assert(returned, "browser grant reaches the native tool");
		assert.deepEqual(JSON.parse(returned.content).rows, [["120"]]);
		await page.waitForFunction(() => document.querySelector('.messages')?.textContent.includes('120'));
		mkdirSync("tests/scratch", { recursive: true });
		await page.screenshot({path:"tests/scratch/omp-database-live.png"});
		await page.locator(".wiki-modal-header > button").last().click(); await page.locator(".database-workbench").waitFor({state:"detached"});
		await page.getByRole("button", {name:"数据库",exact:true}).click();
		await page.getByRole("button", {name:"导入连接",exact:true}).click(); await page.getByRole("button", {name:"扫描服务所在机器"}).click(); await page.locator(".database-source").first().waitFor();
		await page.locator(".database-source").first().click(); await page.getByRole("button", {name:"预览同步"}).click(); await page.locator(".database-import-list").waitFor();
		for (let i=0;i<20;i++){await page.keyboard.press("Tab");assert(await page.locator(".wiki-document-dialog").evaluate(el=>el.contains(document.activeElement)));}
		await page.setViewportSize({width:390,height:844}); assert.equal(Math.round((await page.locator(".wiki-document-dialog").boundingBox()).width),390);
		assert.deepEqual(errors, []);
	}
	console.log(`PASS database: real PG/MySQL, import, encrypted credentials, read-only execution, cancellation, native Agent scope/results${browser ? " and browser" : ""}`);
} catch(error) { console.error(harness?.logs.slice(-3000)); throw error; }
finally { await cleanup(); }
