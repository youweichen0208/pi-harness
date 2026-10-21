/** Integration fixture databases: PostgreSQL on 9277 and MySQL on 9278, pi_test_only password. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import WebSocket from "ws";
import pg from "pg";
import mysql from "mysql2/promise";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { testEnv } from "./lib/test-env.mjs";
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-database-"))), agent = join(root, "agent"), data = join(root, "data");
mkdirSync(agent); mkdirSync(data); mkdirSync(join(root, ".dbeaver"));
const port = 9274; assert.equal(await portUp(port), false); assert.equal(await portUp(port + 1), false);
const configs = [
	{ name: "Postgres analytics", driver: "postgres", host: "127.0.0.1", port: Number(process.env.PI_TEST_PG_PORT ?? 9277), user: "postgres", password: "pi_test_only", db_name: "analytics" },
	{ name: "MySQL analytics", driver: "mysql", host: "127.0.0.1", port: Number(process.env.PI_TEST_MYSQL_PORT ?? 9278), user: "root", password: "pi_test_only", db_name: "analytics" },
];
const postgres = new pg.Client({ host: "127.0.0.1", port: configs[0].port, user: "postgres", password: "pi_test_only", database: "analytics" });
await postgres.connect();
await postgres.query('CREATE SCHEMA IF NOT EXISTS "sales team"');
await postgres.query('DROP TABLE IF EXISTS "sales team".orders');
await postgres.query('CREATE TABLE "sales team".orders (id bigint primary key, customer text, amount numeric)');
await postgres.query('INSERT INTO "sales team".orders SELECT i, \'Customer \' || i, i * 10 FROM generate_series(1,120) AS i');
await postgres.query('CREATE TABLE IF NOT EXISTS public.bigint_test (id bigint)');
await postgres.query('TRUNCATE public.bigint_test');
await postgres.query('INSERT INTO public.bigint_test VALUES (9007199254740993)');
const my = await mysql.createConnection({ host: "127.0.0.1", port: configs[1].port, user: "root", password: "pi_test_only", database: "analytics" });
await my.query('DROP TABLE IF EXISTS orders'); await my.query('CREATE TABLE orders (id bigint PRIMARY KEY, customer varchar(100), amount decimal(12,2))');
await my.query('INSERT INTO orders (id,customer,amount) VALUES ?', [Array.from({ length: 120 }, (_, i) => [i + 1, `Customer ${i + 1}`, (i + 1) * 10])]);
let nextCode, calls = 0, child, browser, logs = "";
const clients = [];
const mock = createServer(async (req, res) => {
	for await (const _ of req) {}
	calls++; const code = nextCode; nextCode = undefined;
	const delta = code ? { tool_calls: [{ index: 0, id: `db-call-${calls}`, type: "function", function: { name: "codemode", arguments: JSON.stringify({ code }) } }] } : { content: "Database analysis complete: 120 orders." };
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const [d, finish_reason] of [[delta, null], [{}, code ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason }] })}\n\n`);
	res.end("data: [DONE]\n\n");
});
await new Promise(r => mock.listen(port + 1, "127.0.0.1", r));
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port + 1}`, apiKey: "fixture", models: [{ id: "fixture", input: ["text"], contextWindow: 64000, maxTokens: 8000 }] } } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", defaultTools: ["+codemode", "+tool_search"], retry: { enabled: false } }));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture" } }));
const source = join(root, ".dbeaver/data-sources.json");
writeFileSync(source, JSON.stringify({ connections: { pg: { name: "Imported Postgres", driver: "postgres-jdbc", configuration: { host: "127.0.0.1", port: configs[0].port, user: "postgres", database: "analytics" } } } }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(check, label) { for (let i = 0; i < 400; i++) { if (await check()) return; if (child?.exitCode != null) throw Error(logs); await sleep(50); } throw Error(`Timeout: ${label}\n${logs}`); }
async function connect(id) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`), c = { id, ws, state: undefined };
	clients.push(c); ws.on("message", raw => { const m = JSON.parse(raw); if (m.type === "snapshot") c.state = m.state; if (m.type === "snapshot_delta" && c.state) c.state = { ...c.state, ...m.state, messages: [...c.state.messages, ...(m.appended ?? [])] }; });
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	ws.send(JSON.stringify({ type: "hello", clientId: id, protocolVersion: 41 })); await wait(() => c.state, "hello"); return c;
}
async function request(c, body, status = 200) {
	const r = await fetch(`http://127.0.0.1:${port}/api/database`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: root, clientId: c.id, conversationId: c.state.conversationId, requestId: crypto.randomUUID(), ...body }) });
	const result = await r.json(); assert.equal(r.status, status, JSON.stringify(result)); return result;
}
async function prompt(c, code) {
	nextCode = code; const before = calls;
	c.ws.send(JSON.stringify({ type: "prompt", text: "Analyze attached database", requestId: crypto.randomUUID() }));
	await wait(() => calls >= before + 2 && !c.state.isStreaming, "agent query");
	return c.state.messages.findLast(m => m.role === "toolResult");
}
try {
	child = spawn(process.execPath, ["dist/server/index.js"], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: "", PI_WEB_CWD: root, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.on("data", b => logs += b); child.stderr.on("data", b => logs += b);
	await wait(() => portUp(port), "server");
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
	let tool = await prompt(a, `text(await tools.database_read({action:'query',connectionId:${JSON.stringify(c.id)},database:'analytics',sql:'select 1'}));`);
	assert(tool.isError && /not attached/.test(JSON.stringify(tool)));
	await request(a, { action: "grant", ids: [c.id], versions: { [c.id]: c.version } });
	assert.deepEqual((await request(b, { action: "list" })).grants, []);
	tool = await prompt(a, `text(await tools.database_read({action:'query',connectionId:${JSON.stringify(c.id)},database:'analytics',sql:'SELECT count(*) AS n FROM "sales team".orders'}));`);
	assert(!tool.isError, JSON.stringify(tool)); assert.match(JSON.stringify(tool), /120/);
	await request(a, { action: "revoke", id: c.id });
	tool = await prompt(a, `text(await tools.database_read({action:'query',connectionId:${JSON.stringify(c.id)},sql:'select 1'}));`); assert(tool.isError);
	// Cancellation must release a genuinely running database query.
	const queryId = crypto.randomUUID();
	const pending = request(a, { action: "run", id: c.id, version: c.version, requestId: queryId, operation: "query", sql: 'SELECT sum(a.amount*b.amount*c.amount*d.amount*e.amount) FROM "sales team".orders a CROSS JOIN "sales team".orders b CROSS JOIN "sales team".orders c CROSS JOIN "sales team".orders d CROSS JOIN "sales team".orders e' }, 400);
	await sleep(300); await request(a, { action: "cancel", target: queryId }); assert.match((await pending).error, /cancelled/);
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
		nextCode = `text(await tools.database_read({action:'query',connectionId:${JSON.stringify(c.id)},database:'analytics',sql:'SELECT count(*) AS n FROM "sales team".orders'}));`;
		const before = calls; await input.press("Enter"); await wait(() => calls >= before + 2, "browser analysis");
		await page.waitForFunction(() => document.querySelector('.messages')?.textContent.includes('120'));
		await page.screenshot({path:"/tmp/pi-database-workbench.png"});
		await page.locator(".wiki-modal-header > button").last().click(); await page.locator(".database-workbench").waitFor({state:"detached"});
		await page.getByRole("button", {name:"数据库",exact:true}).click();
		await page.getByRole("button", {name:"导入连接",exact:true}).click(); await page.getByRole("button", {name:"扫描服务所在机器"}).click(); await page.locator(".database-source").first().waitFor();
		await page.locator(".database-source").first().click(); await page.getByRole("button", {name:"预览同步"}).click(); await page.locator(".database-import-list").waitFor();
		for (let i=0;i<20;i++){await page.keyboard.press("Tab");assert(await page.locator(".wiki-document-dialog").evaluate(el=>el.contains(document.activeElement)));}
		await page.setViewportSize({width:390,height:844}); assert.equal(Math.round((await page.locator(".wiki-document-dialog").boundingBox()).width),390);
		assert.deepEqual(errors, []);
	}
	console.log("PASS database: real PG/MySQL, import, encrypted credentials, read-only execution, cancellation, Agent scope and browser");
} catch(error) { console.error(logs.slice(-3000)); throw error; }
finally { await browser?.close(); clients.forEach(c => c.ws.close()); child?.kill("SIGTERM"); await new Promise(r => mock.close(r)); await postgres.end(); await my.end(); rmSync(root,{recursive:true,force:true}); }
