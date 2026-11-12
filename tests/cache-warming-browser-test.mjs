// Exercise the production picker/popover without provider requests or host configuration.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";

const port = 9294;
assert.equal(await portUp(port), false);
const temp = mkdtempSync(join(tmpdir(), "pi-warming-browser-"));
let browser;
const bundle = await build({ stdin: { contents: `
import React, { useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageProvider, useI18n } from './web/src/i18n';
import { ModelPicker } from './web/src/components/ModelPicker';
import { UsagePopover } from './web/src/components/UsagePopover';
function Fixture() {
 const [mode, setMode] = useState('streaming'), [conversationId, setConversation] = useState('normal'), [mounted, setMounted] = useState(true);
 const { setLocale } = useI18n();
 const send = useCallback(message => { window.sent.push(message); if(message.type === 'set_cache_warming') setMode(message.mode); return true; }, []);
 const stats = {totalMessages:0,tokens:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0},cost:0.25,contextUsage:{tokens:0,percent:0,contextWindow:200000},cacheWarming:{mode,state:'scheduled',nextWarmAt:Date.now()+60000,cost:0.025}};
 return <main className='design-workspace' style={{display:'block',padding:20,paddingTop:400}}><div style={{position:'absolute',top:20,left:20}}><button onClick={()=>setConversation('wiki')}>Switch conversation</button><button onClick={()=>setMounted(false)}>Unmount</button><button onClick={()=>setLocale('en')}>English</button></div>
 <div className='input-tools' style={{display:'flex',gap:12}}><ModelPicker state={{conversationId,model:null,runSettings:{autoCompaction:true,autoRetry:true,cacheWarming:mode}}} models={[{id:'fixture/test',name:'Fixture',provider:'fixture'}]} modelsLoading={false} send={send} onManageModels={()=>{}} />
 {mounted && <UsagePopover stats={stats} conversationId={conversationId} send={send}/>}</div></main>;
}
window.sent=[]; createRoot(document.getElementById('root')).render(<LanguageProvider><Fixture/></LanguageProvider>);
`, resolveDir: process.cwd(), sourcefile: "fixture.tsx", loader: "tsx" }, bundle: true, write: false, format: "esm", jsx: "automatic", logLevel: "silent" });
const server = createServer((req, res) => {
	if (req.url === "/bundle.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].contents); }
	else if (req.url === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(resolve("web/src/styles.css"))); }
	else { res.setHeader("content-type", "text/html"); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>'); }
});
await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
	page.setDefaultTimeout(5000);
	const errors = []; page.on("pageerror", error => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${port}`);
	await page.clock.install();
	const polls = () => page.evaluate(() => window.sent.filter(item => item.type === "get_cache_warming").length);
	await page.locator(".usage-trigger").click();
	await page.getByText("本会话预热费用", { exact: true }).waitFor();
	assert.equal(await polls(), 1);
	await page.clock.fastForward(5100); assert.equal(await polls(), 2);
	assert.match(await page.locator(".usage-popover").innerText(), /\$0\.0250/);
	assert.match(await page.locator(".usage-popover").innerText(), /已计入/);
	await page.keyboard.press("Escape"); await page.clock.fastForward(5100); assert.equal(await polls(), 2);
	await page.locator(".dropdown").first().locator("button").first().click();
	await page.locator(".model-cache-warming select").waitFor();
	assert.match(await page.locator(".model-cache-warming").innerText(), /缓存预热/);
	await page.locator(".model-cache-warming select").selectOption("idle");
	assert.equal(await page.locator(".model-cache-warming select").inputValue(), "idle");
	assert.match(await page.locator(".model-cache-hint").innerText(), /额外费用/);
	assert.deepEqual(await page.evaluate(() => window.sent.findLast(item => item.type === "set_cache_warming")), { type: "set_cache_warming", mode: "idle" });
	await page.keyboard.press("Escape");
	await page.getByText("English", { exact: true }).click();
	await page.locator(".usage-trigger").click();
	await page.getByText("Session warming cost", { exact: true }).waitFor().catch(async error => { console.error(await page.locator("body").innerText()); throw error; });
	const beforeSwitch = await polls(); await page.getByText("Switch conversation", { exact: true }).click();
	await page.clock.fastForward(5100); assert.equal(await polls(), beforeSwitch);
	await page.locator(".usage-trigger").click();
	await page.clock.fastForward(5100);
	assert.equal(await page.evaluate(() => window.sent.findLast(item => item.type === "get_cache_warming").conversationId), "wiki");
	const beforeHidden = await polls();
	await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }));
	await page.clock.fastForward(5100); assert.equal(await polls(), beforeHidden);
	await page.evaluate(() => { delete document.visibilityState; });
	const beforeUnmount = await polls(); await page.getByText("Unmount", { exact: true }).click();
	await page.clock.fastForward(5100); assert.equal(await polls(), beforeUnmount);
	await page.reload(); await page.setViewportSize({ width: 375, height: 800 });
	await page.locator(".dropdown").first().locator("button").first().click();
	const control = page.getByLabel("Cache warming · global", { exact: true }); await control.waitFor();
	const box = await control.boundingBox(); assert(box && box.x >= 0 && box.x + box.width <= 375);
	await page.clock.runFor(250);
	mkdirSync("tests/scratch", { recursive: true });
	await page.screenshot({ path: "tests/scratch/cache-warming-mobile.png", animations: "disabled" });
	assert.deepEqual(errors, []);
	console.log("PASS global picker, cost explanation, 5-second polling cleanup, conversation scoping and narrow viewport");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); }
