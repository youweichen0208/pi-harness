/** Classic v1.3.1 layout with current database and document workbenches. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from "./lib/test-env.mjs";
const port = 9286, root = mkdtempSync(join(tmpdir(), 'pi-classic-'));
const cwd = join(root, 'classic-workspace'); mkdirSync(cwd);
execFileSync('git', ['init', '-q'], { cwd });
writeFileSync(join(cwd, 'README.md'), '# Classic workspace\n\n用于阅读、编辑和分析的工作区。\n\n## A calmer workspace\n\nClassic body text and 中文正文。\n\n```js\nconst workspace = "classic";\n```\n');
let server, browser;
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 150 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	assert(await portUp(port));
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(12000);
	const errors = [], external = [];
	let socket, baseState;
	await page.routeWebSocket('**/ws', route => {
		socket = route; const upstream = route.connectToServer();
		route.onMessage(wire => upstream.send(wire));
		upstream.onMessage(wire => { const message = JSON.parse(wire.toString()); if (message.type === 'snapshot') baseState = message.state; route.send(wire); });
	});
	page.on('pageerror', e => errors.push(e.message));
	await page.route('**/*', route => { if (!route.request().url().startsWith(`http://127.0.0.1:${port}`)) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	await page.locator('.status-dot.ok').waitFor();
	mkdirSync('tests/scratch', { recursive: true });
	await page.locator('.workspace-group-manager input').fill('Studio');
	await page.locator('.workspace-group-actions button[type=submit]').click();
	await page.locator('.workspace-outside button').click();
	await page.locator('.project-item.active').waitFor();
	assert(await page.locator('.inputbar textarea').isVisible());
	assert.equal(await page.locator('.home-onboarding, .conversation-home-heading, .workbench-panel-tabs').count(), 0);
	await page.evaluate(() => document.fonts.ready);
	const tokens = await page.evaluate(() => Object.fromEntries(['--bg','--accent','--r-sm','--r-md','--r-lg','--r-waiting'].map(k => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim().toLowerCase()])));
	assert.deepEqual(tokens, {'--bg':'#fbf9f6','--accent':'#2f7aae','--r-sm':'6px','--r-md':'8px','--r-lg':'12px','--r-waiting':'1.5px'});
	assert(await page.locator('.statusbar').isVisible());
	assert.equal(Math.round((await page.locator('.statusbar').boundingBox()).height), 26);
	assert.deepEqual((await page.locator('.view-switch [role=tab]').allTextContents()).map(text => text.replace(/\d+$/, '')), ['对话','终端','节点','Git']);
	assert((await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily)).includes('IBM Plex Sans'));
	assert.equal(await page.locator('.panel-left').evaluate(el => getComputedStyle(el).borderTopLeftRadius), '0px');
	assert.equal(Math.round((await page.locator('.drawer-left').boundingBox()).x), 0);
	assert(await page.locator('.panel-right > .panel-body').isVisible());
	assert(await page.locator('.panel-right > .panel-lower').isVisible());
	await page.locator('.inputbar textarea').fill('Review this workspace');
	await page.screenshot({path:'tests/scratch/classic-chat.png'});
	const database = page.locator('.view-switch').getByRole('button',{name:'数据库',exact:true});
	await database.click();
	await page.locator('.database-workbench').waitFor();
	assert.equal(await page.locator('.wiki-agent-chat .inputbar textarea').inputValue(),'Review this workspace');
	await page.locator('.database-actions').getByRole('button',{name:'新建连接',exact:true}).click();
	await page.locator('.database-form').waitFor();
	await page.screenshot({path:'tests/scratch/classic-database.png'});
	await page.locator('.wiki-modal-header > button').last().click();
	await page.locator('.file-name',{hasText:'README.md'}).first().click();
	await page.locator('.wiki-prose .fp-rich-document').waitFor();
	assert.equal(await page.locator('.wiki-document-heading h1').evaluate(el => getComputedStyle(el).fontFamily.split(',')[0].replaceAll('"','')), 'Source Serif 4');
	await page.screenshot({path:'tests/scratch/classic-wiki.png'});
	await page.locator('.wiki-modal-header > button').last().click();
	await page.locator('#sidebar-settings-slot .chip').click();
	await page.locator('.workspace-settings-menu').getByRole('button',{name:'所有设置',exact:true}).click();
	await page.locator('.settings-modal').waitFor();
	await page.waitForFunction(() => getComputedStyle(document.querySelector('.settings-modal')).opacity === '1');
	await page.screenshot({path:'tests/scratch/classic-settings.png'});
	await page.keyboard.press('Escape');
	await page.evaluate(() => document.documentElement.dataset.appearance = 'dark');
	await page.waitForTimeout(250);
	await page.screenshot({path:'tests/scratch/classic-dark.png'});
	await page.evaluate(() => document.documentElement.dataset.appearance = 'light');
	await page.setViewportSize({width:390,height:844});
	await page.emulateMedia({reducedMotion:'reduce'});
	await database.click();
	await page.locator('.database-workbench').waitFor();
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	await page.screenshot({path:'tests/scratch/classic-mobile.png'});
	await page.locator('.wiki-modal-header > button').last().click();
	await page.locator('.topbar .brand .panel-toggle').click();
	await page.locator('.drawer-left.open .sidebar-brand').waitFor();
	await page.screenshot({path:'tests/scratch/classic-mobile-sidebar.png'});
	await page.setViewportSize({width:1440,height:1000});
	const processMessages = [
		{id:'home-user',role:'user',content:[{type:'text',text:'Review the workspace'}]},
		{id:'home-read',role:'assistant',content:[{type:'text',text:'Inspecting the project.'},{type:'toolCall',id:'home-read-call',name:'read',argumentsText:JSON.stringify({path:'README.md'})}]},
		{id:'home-read-result',role:'toolResult',toolCallId:'home-read-call',toolName:'read',content:[{type:'text',text:'Project overview'}]},
		{id:'home-bash',role:'assistant',content:[{type:'toolCall',id:'home-bash-call',name:'bash',argumentsText:JSON.stringify({command:'pwd'})}]},
		{id:'home-bash-result',role:'toolResult',toolCallId:'home-bash-call',toolName:'bash',content:[{type:'text',text:cwd}]},
		{id:'home-answer',role:'assistant',content:[{type:'text',text:'The workspace is ready for review.'}]},
	];
	socket.send(JSON.stringify({type:'snapshot',state:{...baseState,isStreaming:false,streamingMessage:null,messages:processMessages,taskProgress:{id:'home-task',conversationId:baseState.conversationId,sourceMessageId:'home-user',title:'Review workspace',status:'done',startedAt:Date.now(),completed:2,steps:[],plan:{revision:1,added:0,removed:0,items:[{id:'inspect',title:'Read the project',status:'done'},{id:'review',title:'Review the workspace',status:'done'}]}}}}));
	await page.getByText('The workspace is ready for review.',{exact:true}).waitFor();
	await page.getByText('Inspecting the project.',{exact:true}).first().waitFor();
	assert.equal(await page.locator('.process-summary').count(), 0);
	await page.screenshot({path:'tests/scratch/classic-conversation.png'});
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pi:jump-tool',{detail:{messageId:'home-bash',toolCallId:'home-bash-call'}})));
	await page.locator('.panel-right .task-progress').waitFor();
	assert(await page.locator('.panel-right > .panel-body').isVisible());
	assert.equal(await page.locator('.inputbar textarea').inputValue(),'Review this workspace');
	socket.send(JSON.stringify({type:'snapshot',state:{...baseState,isStreaming:true,streamingMessage:null,messages:[{id:'classic-wait',role:'user',content:[{type:'text',text:'Analyze this workspace'}]}]}}));
	await page.locator('.waiting-brand').waitFor();
	const dots = await page.locator('.waiting-brand i').evaluateAll(nodes => nodes.map(el => { const style = getComputedStyle(el); return [style.backgroundColor, style.borderRadius, style.animationName]; }));
	assert.deepEqual(dots, [['rgb(238, 140, 124)','1.5px','none'],['rgb(62, 143, 192)','1.5px','none'],['rgb(242, 188, 78)','1.5px','none']]);
	assert.deepEqual(errors, []); assert.deepEqual(external, []);
	console.log('PASS classic UI: tokens, fixed panels, footer, flat transcript, same-chat database/Wiki, settings, dark and mobile');
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit',r)); }
	rmSync(root,{recursive:true,force:true});
}
