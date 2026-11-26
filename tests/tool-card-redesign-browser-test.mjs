import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { playgroundFixture } from './lib/playground-fixture.mjs';
const fixture = await playgroundFixture();
let browser;
try {
	browser = await chromium.launch({executablePath:CHROME_PATH});
	const page = await browser.newPage({viewport:{width:1440,height:1000}});
	const output = JSON.stringify({workspace:{id:'fixture',name:'pi-harness'},sources:Array.from({length:8},(_,i)=>({id:`repo:${i}`,name:`Repository ${i}`}))});
	// Retired host tools remain readable as generic cards in old transcripts.
	const messages = [{id:'u',role:'user',timestamp:1,content:[{type:'text',text:'分析项目来源'}]},{id:'a',role:'assistant',timestamp:2,content:[{type:'toolCall',id:'sources',name:'subagent',argumentsText:'{"action":"sources"}'}]},{id:'r',role:'toolResult',toolCallId:'sources',toolName:'subagent',timestamp:3,durationMs:50,content:[{type:'text',text:output}]}];
	let base;
	await page.routeWebSocket(/\/ws(?:\?|$)/,route=>{const upstream=route.connectToServer();route.onMessage(w=>upstream.send(w));upstream.onMessage(w=>{const m=JSON.parse(String(w));if(m.type==='snapshot'||m.type==='snapshot_delta'){base={...base,...m.state};route.send(JSON.stringify({type:'snapshot',state:{...base,piConfigured:true,isStreaming:false,messages,streamingMessage:null,taskProgress:null}}));}else route.send(w);});});
	await page.goto(`${fixture.base}/?token=${fixture.token}`);
	const card=page.locator('.toolcall-structured');
	await card.waitFor();
	assert.equal(await card.locator('.toolcall-action').textContent(),'action: sources');
	const actionBelowName = await card.locator('.toolcall-name-toggle').evaluate(button =>
		button.querySelector('small').getBoundingClientRect().top >= button.querySelector('span').getBoundingClientRect().bottom);
	assert(actionBelowName, 'action appears beneath the tool name');
	assert(await card.locator('.hljs-attr').count()>0);
	const toggle=card.locator('.structured-tool-code > button');
	assert.equal(await toggle.getAttribute('aria-expanded'),'false');
	assert(!await card.locator('pre').last().textContent().then(text=>text.includes('Repository 7')));
	await toggle.click();
	assert.match(await card.locator('.structured-tool-code pre').innerText(),/Repository 7/);
	await toggle.press('Enter');
	const downloadEvent=page.waitForEvent('download');
	await card.locator('footer').getByRole('button',{name:'下载完整输出',exact:true}).click();
	const download=await downloadEvent;
	assert.equal(download.suggestedFilename(),'tool-output.json');
	assert.equal(readFileSync(await download.path(),'utf8'),output);
	await page.screenshot({path:'tests/scratch/tool-card-light.png'});
	await page.evaluate(()=>document.documentElement.setAttribute('data-appearance','dark'));
	await page.screenshot({path:'tests/scratch/tool-card-dark.png'});
	await page.setViewportSize({width:390,height:844});
	assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
	await page.screenshot({path:'tests/scratch/tool-card-mobile.png'});
	messages[1].content[0].name = 'compress';
	messages[2].toolName = 'compress';
	messages[2].content[0].truncated = true;
	await page.reload();
	await page.locator('.structured-tool-output').waitFor();
	assert.equal(await page.locator('.structured-tool-output footer').getByRole('button',{name:'下载完整输出',exact:true}).count(),0);
	assert.equal(await card.evaluate(el => getComputedStyle(el).borderLeftWidth), '1px');
	assert.match(await card.locator('.toolcall-name-toggle').innerText(), /compress/i);
	// Exercise the same transcript renderer with the knowledge tools' own names and arguments.
	const knowledgeCalls = [
		['knowledge_sources', {}], ['source_list', { sourceId: 'repo' }],
		['source_read', { sourceId: 'repo', path: 'src/main.ts' }],
		['source_search', { sourceId: 'repo', query: 'main' }],
	];
	for (const [name, args] of knowledgeCalls) {
		messages[1].content.push({ type: 'toolCall', id: name, name, argumentsText: JSON.stringify(args) });
		messages.push({ id: name + '-result', role: 'toolResult', toolCallId: name, toolName: name, content: [{ type: 'text', text: output }] });
	}
	await page.reload();
	for (const [name] of knowledgeCalls) {
		const heading = page.getByRole('button', { name, exact: true });
		const tool = page.locator('.transcript-tool').filter({ has: heading });
		await tool.locator('.structured-tool-output').waitFor();
		assert.equal(await tool.evaluate(el => getComputedStyle(el).borderLeftWidth), '1px', name);
		await heading.click();
		assert.equal(await heading.getAttribute('aria-expanded'), 'false', name);
		assert.equal(await tool.evaluate(el => getComputedStyle(el).borderLeftWidth), '0px', name);
		await heading.click();
		await tool.locator('.structured-tool-output').waitFor();
	}
	console.log('PASS action, JSON highlight, expansion, raw download, dark and mobile');
} finally {await browser?.close();await fixture.stop();}
