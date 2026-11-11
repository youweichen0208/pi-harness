/** Conversation design fixture: real UI, isolated server, no model calls. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {startIsolatedHarness} from './lib/isolated-server.mjs';
import {deriveTaskProgress} from '../dist/server/task-progress.js';
const root=mkdtempSync(join(tmpdir(),'pi-chat-optimization-'));
const command=`cd ${root} && export PATH="/opt/bin:$PATH" && MODE=test pytest -q --require-postgres`;
const at=Date.now();
const user={id:'u',role:'user',timestamp:at,content:[{type:'text',text:'Implement the readiness contract and verify it.'}]};
const prose='One failure — expected, since I changed the readiness contract. Let me fix that test.';
const text=(id,body)=>({id,role:'assistant',timestamp:at+1000,content:[{type:'text',text:body}]});
const call=(id,cmd)=>({id:'a-'+id,role:'assistant',timestamp:at+2000,content:[{type:'toolCall',id,name:'bash',argumentsText:JSON.stringify({command:cmd})}]});
const result=id=>({id:'r-'+id,role:'toolResult',toolName:'bash',toolCallId:id,durationMs:1500,content:[{type:'text',text:'12 passed'}]});
const messages=[user,text('intro','Confirmed. Let me implement the degraded state.'),call('single',command),result('single'),text('prose',prose),
	call('first','grep -rn readiness services/alpha-engine'),result('first'),call('live','pytest -q --require-postgres --tb=short')];
let harness,browser;
try {
	harness=await startIsolatedHarness({env:{PI_WEB_CWD:root,PI_WEB_DATA_DIR:join(root,'data'),PI_CODING_AGENT_DIR:join(root,'agent')}});
	browser=await chromium.launch({executablePath:CHROME_PATH});
	mkdirSync('tests/scratch',{recursive:true});
	for (const language of ['zh','en']) {
		const page=await browser.newPage({viewport:{width:1440,height:1000}}); const errors=[]; let socket,baseline;
		page.on('pageerror',e=>errors.push(e.message));
		await page.addInitScript(language=>localStorage.setItem('pi-harness:lang',language),language);
		await page.routeWebSocket('**/ws',route=>{
			socket=route; const upstream=route.connectToServer(); route.onMessage(wire=>upstream.send(wire));
			upstream.onMessage(wire=>{const msg=JSON.parse(String(wire)); if(msg.type==='snapshot') {msg.state={...msg.state,piConfigured:true,messages,isStreaming:true,streamingMessage:null};msg.state.taskProgress=deriveTaskProgress(msg.state.conversationId,messages,null,true); baseline=msg.state;} if(msg.type!=='snapshot_delta')route.send(JSON.stringify(msg));});
		});
		await page.goto(`http://127.0.0.1:${harness.port}`);
		const single=page.locator('[data-tool-call-id="single"].bash-row');
		await single.waitFor();
		// 29a: borderless rows show the command without the old `$ ` prefix span.
		assert.equal((await single.locator('.bash-inline-command').innerText()).trim(),'pytest -q --require-postgres');
		assert.equal(await page.locator('.time-gap').count(),1);
		assert.equal(await page.locator('.msg-time:visible, .reply-actions time:visible').count(),0);
		assert.equal(await page.getByText(prose,{exact:true}).count(),1);
		assert.equal(await page.locator('.process-group-phase').count(),0);
		await single.locator('.bash-row-head').click();
		assert.equal(await single.locator('.bash-full-command').textContent(),command);
		// 展开后头部那份被截断的摘要必须消失，否则同一条命令出现两遍（一遍省略号）。
		assert.equal(await single.locator('.bash-row-head .bash-inline-command').isVisible(), false);
		await single.locator('.bash-row-head').click();
		const toggle=page.locator('.plan-progress-toggle');
		assert.equal(await toggle.getAttribute('aria-expanded'),'false');
		assert.match(await toggle.innerText(),/1\/3/);
		assert.equal(await page.locator('.todo-checklist-item:visible').count(),0);
		await toggle.click(); assert.equal(await page.locator('.todo-checklist-item:visible').count(),3);
		await toggle.click();
		await page.evaluate(()=>window.dispatchEvent(new CustomEvent('pi:jump-tool',{detail:{toolCallId:'plan',todoItemIds:['two']}})));
		await page.locator('[data-todo-item-id="two"].todo-item-flash').waitFor();
		assert.equal(await toggle.getAttribute('aria-expanded'),'true');
		await toggle.click();
		const spinner=page.locator('.bash-row.run .thinking-spinner');
		assert.notEqual(await spinner.evaluate(el=>getComputedStyle(el).animationName),'none');
		// Process-step copy is English in both locales (docs/ui-design.md 4.2).
		assert.match(await page.locator('.process-group.run .process-group-status').innerText(),/Running/);
		// 29a: the process group is borderless — no card wash, radius or outline.
		const card=single.locator('xpath=ancestor::section[contains(@class,"process-group")]');
		assert.equal(await card.evaluate(el=>getComputedStyle(el).borderRadius),'0px');
		assert.equal(await card.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
		assert.equal(await card.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
		await page.locator('.header-task-progress').click();
		// The native plan list is gone; a running step shows the spinner instead of the
		// old pulsing plan mark.
		const runMark=page.locator('.task-step.running .task-step-spinner, .task-step.current .task-step-spinner').first();
		await runMark.waitFor();
		assert.equal(await runMark.evaluate(el=>getComputedStyle(el).animationName),'spin');
		for(const appearance of ['light','dark']) {
			await page.evaluate(value=>document.documentElement.dataset.appearance=value,appearance);
			await page.screenshot({path:`tests/scratch/chat-optimization-${language}-${appearance}.png`});
		}
		await page.setViewportSize({width:390,height:900});
		assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
		await page.screenshot({path:`tests/scratch/chat-optimization-${language}-mobile.png`});
		await page.emulateMedia({reducedMotion:'reduce'});
		assert.equal(await spinner.evaluate(el=>getComputedStyle(el).animationName),'none');
		socket.send(JSON.stringify({type:'snapshot',state:{...baseline,rev:baseline.rev+1,isStreaming:false,messages:[...messages,result('live')],taskProgress:deriveTaskProgress(baseline.conversationId,[...messages,result('live')],null,false)}}));
		await page.locator('.bash-row.run').waitFor({state:'hidden'});
		assert.deepEqual(errors,[]); await page.close();
		console.log(`PASS ${language}: turn time, command prefix, unique prose, collapsed plan/jump, running state, themes and mobile`);
	}
} finally {await browser?.close(); await harness?.stop(); rmSync(root,{recursive:true,force:true});}
