/** Isolated browser regression for global-search request ownership; no model calls. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-global-search-recovery-"));
let server, browser, socket;
const requests = [], errors = [], reads = [];
try {
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent") } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage();
	page.setDefaultTimeout(10000);
	page.on("pageerror", error => errors.push(error.message));
	await page.routeWebSocket("**/ws", route => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === "search_files") requests.push(message);
			else { if (message.type === "read_file") reads.push(message); upstream.send(wire); }
		});
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === "snapshot") message.state.piConfigured = true;
			route.send(JSON.stringify(message));
		});
	});
	const result = (reqId, name, truncated = false) => socket.send(JSON.stringify({ type: "search_files_result", cwd: root, reqId, ok: true, truncated, results: [{ path: name, name, type: "file" }] }));
	const request = async query => {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const value = requests.findLast(item => item.query === query);
			if (value) return value;
			await sleep(20);
		}
		throw Error(`No request for ${query}`);
	};
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.locator(".conn-dot.ok").first().waitFor({ state: "attached" });
	await page.keyboard.press("Control+k");
	const input = page.locator(".gs-input-row input");
	await input.fill("alpha");
	const alpha = await request("alpha");
	result(alpha.reqId, "alpha.ts", true);
	await page.locator(".gs-item", { hasText: "alpha.ts" }).waitFor();
	await input.fill("beta");
	await sleep(60);
	assert.equal(await page.locator(".gs-item").count(), 0, "old files must disappear during debounce");
	assert.equal(await page.locator(".gs-truncated").count(), 0, "truncation belongs to the query that produced it");
	const beta = await request("beta");
	result(alpha.reqId, "late-alpha.ts");
	await sleep(60);
	assert.equal(await page.locator(".gs-item").count(), 0);
	result(beta.reqId, "beta.ts");
	await page.locator(".gs-item", { hasText: "beta.ts" }).waitFor();
	await input.fill("");
	await sleep(60);
	assert.equal(await page.locator(".gs-item").count(), 0);
	await page.keyboard.press("Escape");
	await page.keyboard.press("Control+k");
	await input.fill("gamma");
	const gamma = await request("gamma");
	assert(gamma.reqId > beta.reqId, "request IDs must survive modal remounts");
	result(alpha.reqId, "previous-dialog.ts");
	await sleep(60);
	assert.equal(await page.locator(".gs-item").count(), 0);
	result(gamma.reqId, "gamma.ts");
	await page.locator(".gs-item", { hasText: "gamma.ts" }).waitFor();
	const beforeClose = reads.length;
	await page.locator('.gs-close').focus();
	await page.keyboard.press('Enter');
	await page.locator('.gs-modal').waitFor({state:'detached'});
	assert.equal(reads.length, beforeClose, 'Enter on Close must not open the active file');
	await page.keyboard.press('Control+k');
	await input.fill('mixed');
	const mixed = await request('mixed');
	socket.send(JSON.stringify({type:'search_files_result',cwd:root,reqId:mixed.reqId,ok:true,results:[
		{path:'folder',name:'folder',type:'dir'},
		...Array.from({length:25},(_,i)=>({path:`file-${i}.ts`,name:`file-${i}.ts`,type:'file'})),
	]}));
	await page.locator('.gs-item', {hasText:'file-0.ts'}).first().waitFor();
	assert.match(await page.locator('.gs-item.active').innerText(),/file-0.ts/);
	await input.focus();
	for(let i=0;i<24;i++) await page.keyboard.press('ArrowDown');
	assert.match(await page.locator('.gs-item.active').innerText(),/file-24.ts/);
	await page.waitForFunction(()=>{const el=document.querySelector('.gs-item.active');const r=el.getBoundingClientRect(),p=el.closest('.gs-results').getBoundingClientRect();return r.top>=p.top-1&&r.bottom<=p.bottom+1;});
	await page.locator('.gs-item', {hasText:'file-3.ts'}).first().focus();
	await page.keyboard.press('Enter');
	await page.locator('.gs-modal').waitFor({state:'detached'});
	await sleep(50);
	assert.equal(reads.at(-1)?.path,'file-3.ts','native Enter must activate the focused result');
	assert.deepEqual(errors, []);
	console.log("PASS global search query changes, clearing, late results and modal remount isolation");
} finally {
	await browser?.close();
	await server?.stop();
	rmSync(root, { recursive: true, force: true });
}
