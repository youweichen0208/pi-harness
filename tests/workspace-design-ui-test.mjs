/** Standalone design acceptance: real backend/tree, deterministic model-free transcript. */
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {CHROME_PATH} from './lib/chrome.mjs';
import {portUp} from './lib/port-utils.mjs';
import { testEnv } from "./lib/test-env.mjs";
const PORT=8993;
const root=mkdtempSync(join(tmpdir(),'workspace-design-'));
const cwd=join(root,'youwei-trading-agent');mkdirSync(cwd);
for(const path of ['.assets','.scratch/trading-agent-cockpit','.scratch/us-stock-research','docs'])mkdirSync(join(cwd,path),{recursive:true});
writeFileSync(join(cwd,'AGENTS.md'),'# Workspace\n\n| Module | File | Details |\n| --- | --- | --- |\n| Model | `docs/architecture-core.md` | preserved cell content |\n| Globals | `some/very/long/path/to/a/module.ts` | more contents |\n');writeFileSync(join(cwd,'CONTEXT.md'),'# Context\n');
writeFileSync(join(cwd,'docs/note.md'),'# Nested note\n');
mkdirSync(join(cwd,'docs/research'),{recursive:true});
writeFileSync(join(cwd,'docs/research/llm-gateway-options.md'),Array.from({length:30},(_,i)=>`Gateway paragraph ${i+1}`).join('\n\n'));
writeFileSync(join(cwd,'.scratch/us-stock-research/spec.md'),'# Spec\n');
execFileSync('git',['init','-q'],{cwd});execFileSync('git',['add','.'],{cwd});
execFileSync('git',['-c','user.name=UI test','-c','user.email=ui@example.test','commit','-qm','fixture'],{cwd});
for(const path of ['CONTEXT.md','docs/note.md','.scratch/us-stock-research/spec.md'])writeFileSync(join(cwd,path),'# Modified\n');
const lines=['CONTEXT.md','docs/adr/0001-embed-pi-sdk.md','docs/adr/0002-preserve-research-versions.md','docs/agents/domain.md','docs/agents/triage-labels.md','docs/agents/issue-tracker.md','.scratch/trading-agent-cockpit/data-source-research.md','.scratch/us-stock-research/spec.md',...Array.from({length:9},(_,i)=>`.scratch/us-stock-research/issues/${i}.md`)];
const command='ls ~/projects/youwei-knowledge-base/ 2>/dev/null | head; echo "---"; find ~/projects/youwei-trading-agent -type f -not -name ".DS_Store" | head -30; echo "---NEWEST---"; find … -exec stat -f "%Sm %N" -t "%m-%d %H:%M" {} \\; | sort -r | head -8';
const timestamp=new Date('2026-09-24T07:58:00+08:00').getTime();
const messages=[
...Array.from({length:3},(_,i)=>({id:`goal-${i}`,role:'user',content:[{type:'text',text:'【目标已设定】\n\n把首页标题改为 Goal Buddy\n\n请现在开始实现这个目标。'}]})),
{id:'user',role:'user',timestamp,content:[{type:'text',text:'审查一下最近的代码改动请求，先看看项目里都有哪些文件，最近改了什么。'}]},
{id:'assistant-tool',role:'assistant',model:'glm-5.3',timestamp,content:[{type:'thinking',thinking:'先检查目录与最近修改，再核对项目约束。',durationMs:3000},{type:'toolCall',id:'bash-design',name:'bash',argumentsText:JSON.stringify({command})}]},
{id:'result',role:'toolResult',toolCallId:'bash-design',toolName:'bash',isError:false,content:[{type:'text',text:lines.join('\n')+'\n'},...[...lines.slice(0,11),'docs/CONTEXT.md'].map((path,i)=>({type:'toolCall',id:`grep-${i}`,name:'grep',argumentsText:JSON.stringify({path})}))]},
{id:'assistant',role:'assistant',model:'glm-5.3',timestamp,usage:{input:7500,output:1000,cacheRead:86000,cacheWrite:6500},content:[{type:'thinking',thinking:'Confirmed: the workspace contains only docs — no code at all.'},{type:'text',text:'这个仓库目前**只有文档，没有代码**。最近的改动集中在 `.scratch/us-stock-research/issues/`，共 8 个 issue 草稿，另外有两份 ADR。要我逐个审查这些 issue 吗？'}]},
];
let server,browser;
try{
assert.equal(await portUp(PORT),false);
server=spawn(process.execPath,['dist/server/index.js'],{env:{...testEnv(),PORT:String(PORT),PI_WEB_CWD:cwd,PI_WEB_DATA_DIR:join(root,'data'),PI_CODING_AGENT_DIR:join(root,'agent')},stdio:['ignore','pipe','pipe']});
let log='';server.stderr.on('data',data=>log+=data);
for(let n=0;n<80&&!await portUp(PORT);n++)await sleep(250);
assert(await portUp(PORT),log);
browser=await chromium.launch({executablePath:CHROME_PATH});
const context=await browser.newContext({viewport:{width:1600,height:1000},permissions:['clipboard-read','clipboard-write']});
const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
const sent=[];
await page.routeWebSocket('**/ws',route=>{
const upstream=route.connectToServer();
route.onMessage(wire=>{const message=JSON.parse(wire.toString());sent.push(message);if(message.type==='prompt')throw Error('No model requests allowed');upstream.send(wire)});
upstream.onMessage(wire=>{
const message=JSON.parse(wire.toString());
if(message.type==='snapshot'){
Object.assign(message.state,{messages,piConfigured:true,model:{id:'glm-5.3',name:'GLM 5.3',provider:'volc-glm'},thinkingLevel:'minimal',availableThinkingLevels:['off','minimal','low','medium','high']});
message.state.stats.contextUsage={tokens:17300,contextWindow:1000000,percent:1.73};
message.state.stats.tokens={input:7500,output:1000,cacheRead:86000,cacheWrite:6500,total:101000};
message.state.stats.contextParts={system:1800,tools:5200,conversation:9300,attachments:1000};
message.state.cwdEvents=[{cwd,timestamp:Date.now()}];
}
if(message.type==='projects')message.projects=[{path:'/',lastUsed:1,firstAdded:1,conversationCount:1},{path:join(root,'recent'),lastUsed:100,firstAdded:100,conversationCount:1},{path:cwd,lastUsed:50,firstAdded:50,conversationCount:1}];
if(message.type==='settings_state')Object.assign(message.settings??message,{toolsWrap:true,thinkingWrap:false});
if(message.type!=='snapshot_delta')route.send(JSON.stringify(message));
});
});
await page.goto(`http://localhost:${PORT}`);
await page.locator('.tree-filter',{hasText:'3'}).waitFor();
await page.locator('.workspace-group-manager input').fill('Engineering');
await page.locator('.workspace-group-actions button[type=submit]').click();
await page.locator('.workspace-outside button').click();
await page.locator('.project-item.active').waitFor();
await page.locator('.bash-group-head').click();
await page.locator('.bash-row-head').click();
await page.locator('.cwd-event').waitFor();
assert((await page.locator('.cwd-event').textContent()).includes(cwd));
assert.equal(await page.locator('.notice',{hasText:'已切换到工作目录'}).count(),0);
assert.equal(await page.locator('.project-item.active .project-name').textContent(),'youwei-trading-agent');
await page.locator('.file-dir-main',{hasText:'.scratch'}).click();
await page.locator('.file-dir-main',{hasText:'us-stock-research'}).waitFor();
await page.locator('.tree-controls > .tree-menu-trigger').click();
await page.locator('.tree-hidden-toggle').click();
assert.equal(await page.locator('.file-dir-main',{hasText:'.scratch'}).count(),0);
await page.locator('.tree-hidden-toggle').click();
assert.equal(await page.locator('.tree-hidden-toggle').getAttribute('aria-checked'),'true');
await page.keyboard.press('Escape');
await page.locator('.file-dir-main',{hasText:'.scratch'}).waitFor();
assert(await page.locator('.file-name-text',{hasText:'AGENTS.md'}).isVisible());
await page.locator('.file-dir-main',{hasText:'docs'}).click();
await page.locator('.file-name-text',{hasText:'note.md'}).waitFor();
await page.locator('.file-dir-main',{hasText:'docs'}).focus();
await page.keyboard.press('ArrowLeft');
assert.equal(await page.locator('.file-name-text',{hasText:'note.md'}).count(),0);
assert.equal(await page.locator('.bash-numbered-line').count(),6);
await page.locator('.bash-row-body > .bash-group-more').click();
assert.equal(await page.locator('.bash-numbered-line').count(),17);
await page.locator('.bash-row-actions').getByRole('button',{name:'复制命令',exact:true}).click();
assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),command);
await page.locator('#sidebar-settings-slot .chip').click();
await page.locator('#sidebar-settings-slot .dd-menu').waitFor();
await page.keyboard.press('Escape');
const geometry=await page.evaluate(()=>{
	const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
	return {left:box('.drawer-left'),right:box('.drawer-right'),header:box('.topbar'),composer:box('.inputbox'),font:getComputedStyle(document.body).fontFamily};
});
assert.equal(geometry.header.h,44);
assert(geometry.left.w>=220 && geometry.right.w>=240);
assert(geometry.composer.w<=780);
assert(geometry.font.includes('IBM Plex Sans'));
assert.equal(await page.locator('.goal-event:not(.cwd-event)').count(),1);
assert.equal(await page.locator('.goal-event-count').textContent(),'×3');
assert.equal((await page.locator('.design-workspace > .statusbar').boundingBox()).width,1600);
await page.locator('.messages').evaluate(e=>e.scrollTop=0);
await page.evaluate(()=>document.fonts.ready);
await page.screenshot({path:join(root,'workspace.png')});
// Markdown opens the current document modal and keeps the original composer.
await page.locator('.inputbox textarea').fill('Keep this draft');
await page.locator('.file-name-text',{hasText:'AGENTS.md'}).click();
await page.locator('.wiki-document-dialog .fp-rich-document table').waitFor();
assert.equal(await page.locator('.wiki-agent-chat .inputbox textarea').inputValue(),'Keep this draft');
await page.locator('.wiki-modal-header > button').last().click();
assert.equal(await page.locator('.inputbox textarea').inputValue(),'Keep this draft');
// Search can still find and reveal tool output after restoring the flat transcript.
await page.locator('.messages').click();
await page.keyboard.press(process.platform==='darwin'?'Meta+f':'Control+f');
await page.locator('.search-bar input').fill('issue-tracker.md');
await page.locator('.search-count:not(.empty)').waitFor();
await page.keyboard.press('Escape');
for(const width of [1100,900,390]){
	await page.setViewportSize({width,height:900});
	assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`overflow at ${width}`);
	assert(await page.locator('.inputbox textarea').isVisible());
	assert((await page.locator('.input-tools .btn.send').first().boundingBox()).width>=28);
}
assert(!sent.some(message=>message.type==='prompt'));
assert.deepEqual(errors,[]);
console.log('PASS classic workspace: project groups, file tree, command output/copy, footer, document docking and responsive composer');
}finally{
	await browser?.close();
	if(server && server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
	rmSync(root,{recursive:true,force:true});
}
