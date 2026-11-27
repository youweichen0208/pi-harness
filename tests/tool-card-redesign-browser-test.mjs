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
	// Knowledge tools stay as quiet Thinking-style status rows in the same transcript renderer.
	const knowledgeCalls = [
		['knowledge_sources', {}], ['source_list', { sourceId: 'repo' }],
		['source_read', { sourceId: 'repo', path: 'src/main.ts' }],
		['source_search', { sourceId: 'repo', query: 'main' }],
		['knowledge_investigate', { tasks: [{ question: 'Verify the source' }] }],
		['knowledge_write', { path: 'notes/verified.md', text: '# Verified knowledge' }],
		['source_report', { findings: [{ finding: 'Verified', evidenceIds: ['ev_1'] }] }],
	];
	for (const [name, args] of knowledgeCalls) {
		messages[1].content.push({ type: 'toolCall', id: name, name, argumentsText: JSON.stringify(args) });
		messages.push({ id: name + '-result', role: 'toolResult', toolCallId: name, toolName: name, content: [{ type: 'text', text: output }] });
	}
	await page.setViewportSize({width:1440,height:1000});
	await page.reload();
	await page.locator('.knowledge-tool').first().waitFor();
	assert.equal(await page.locator('.knowledge-tool').count(), knowledgeCalls.length);
	assert.equal(await page.locator('.toolcall-structured').count(), 1, 'non-knowledge generic tools keep their cards');
	for (const [name] of knowledgeCalls) {
		const tool = page.locator(`[data-tool-call-id="${name}"]`);
		await tool.waitFor();
		assert(await tool.evaluate(el => el.classList.contains('thinking') && el.classList.contains('knowledge-tool')), name);
		assert.match(await tool.innerText(), new RegExp(name));
		assert.equal(await tool.getByRole('button').count(), 0, `${name} has no expansion or inspection action`);
		assert.equal(await tool.locator('.toolcall-parameters,.toolcall-output,.structured-tool-output,.tool-output-download-link,pre').count(), 0, `${name} hides parameters and output`);
		assert(!(await tool.innerText()).includes('Repository 0'), `${name} does not expose its result`);
		assert.equal(await tool.evaluate(el => getComputedStyle(el).borderLeftWidth), '0px', name);
	}
	await page.screenshot({path:'tests/scratch/knowledge-tool-rows.png'});
	await page.setViewportSize({width:390,height:844});
	assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
	console.log('PASS action, JSON highlight, expansion, raw download, knowledge status rows, dark and mobile');
} finally {await browser?.close();await fixture.stop();}
