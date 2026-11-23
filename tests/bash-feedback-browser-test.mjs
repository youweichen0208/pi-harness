import assert from "node:assert/strict";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

// Render the real command card with controlled transport state, without a model or server.
const fixture = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '/src/i18n.tsx';
import { BashGroup } from '/src/components/BashGroup.tsx';
import '/src/styles.css';
const root = createRoot(document.getElementById('root'));
window.renderCommand = (overrides = {}, key = 'stable') => {
 const view = { streaming:true, connected:true, liveOutput:'[1/104] smoke-runner-test', lastOutputAt:Date.now()-31000, ...overrides };
 root.render(React.createElement(LanguageProvider, {}, React.createElement(BashGroup, { key, active:true, items:[{block:{type:'toolCall',id:'fixture',name:'bash',argumentsText:JSON.stringify({command:'npm run test:smoke'})},view}],onKill:()=>{window.stopped=true;} })));
};
window.renderCommand();`;
const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../web", import.meta.url)), server: { host: "127.0.0.1", port: 9890, strictPort: false }, plugins: [{ name: "command-feedback-fixture", resolveId(id) { if (id === "/fixture.js") return "\0command-fixture"; }, load(id) { if (id === "\0command-fixture") return fixture; }, configureServer(server) {
	server.middlewares.use((req, res, next) => {
		if (req.url === "/fixture") { res.setHeader("Content-Type", "text/html"); res.end('<html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
		else next();
	});
} }] });
let browser;
try {
	await server.listen();
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath(), headless: true });
	const page = await browser.newPage();
	await page.emulateMedia({ reducedMotion: "reduce" });
	const errors = []; page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
	page.setDefaultTimeout(12000);
	await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/fixture`);
	await page.getByText(/No new output for/).waitFor();
	await page.locator(".bash-row-head").click();
	await page.locator(".bash-output-feedback").waitFor();
	assert.equal(await page.locator(".bash-group").count(), 1);
	assert.equal(await page.getByRole("button", { name: /在终端|terminal/i }).count(), 0);
	assert.equal(await page.locator(".bash-detail-card button").count() > 0, true);
	for (const theme of ["light", "dark"]) {
		await page.evaluate(theme => document.documentElement.dataset.appearance = theme, theme);
		for (const width of [1280, 390]) {
			await page.setViewportSize({ width, height: 800 });
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow");
			await page.screenshot({ path: `/tmp/pi-bash-feedback-${theme}-${width}.png`, animations: "disabled" });
		}
	}
	await page.evaluate(() => window.renderCommand({lastOutputAt:Date.now(),liveOutput:'[2/104] next'}));
	await page.waitForFunction(() => !document.querySelector('.bash-output-feedback'));
	await page.evaluate(() => window.renderCommand({connected:false}));
	await page.getByText('Disconnected · waiting to reconnect', {exact:true}).first().waitFor();
	await page.evaluate(() => window.renderCommand({lastOutputAt:undefined}, 'remounted'));
	await page.getByText('Waiting for output…', {exact:true}).first().waitFor();
	await page.clock.install();
	await page.evaluate(() => window.renderCommand({lastOutputAt:undefined, liveOutput:''}, 'first-output'));
	await page.getByText('Waiting for output…', {exact:true}).first().waitFor();
	await page.clock.fastForward(31000);
	await page.getByText(/部分命令会在结束时才输出|Some commands only print/).first().waitFor();
	await page.evaluate(() => window.renderCommand({lastOutputAt:Date.now(),liveOutput:'received'}, 'first-output'));
	await page.getByText('received', {exact:true}).first().waitFor();
	await page.evaluate(() => window.renderCommand({status:{running:false,isError:false,exitCode:0}}));
	if (!await page.locator('.bash-row-body').isVisible()) await page.locator('.bash-row-head').click();
	await page.getByText('Command finished', {exact:true}).first().waitFor();
	await page.evaluate(() => window.renderCommand({result:{id:'result',role:'toolResult',isError:true,content:[{type:'text',text:'failed'}],details:{exitCode:7}}}));
	await page.locator('.bash-row.err').waitFor();
	assert.equal(await page.locator('.bash-output-feedback').count(), 0);
	assert.deepEqual(errors, []);
	console.log('PASS: command silence, reconnect, completion, failure, removed terminal action, light/dark and narrow layouts');
} finally { await browser?.close(); await server.close(); }
