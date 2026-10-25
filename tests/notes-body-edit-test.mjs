import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { testEnv } from "./lib/test-env.mjs";
const root = mkdtempSync(join(tmpdir(),'rich-notes-'));
const probe = createServer(); await new Promise(r => probe.listen(0,'127.0.0.1',r)); const port = probe.address().port; await new Promise(r => probe.close(r)); assert(port >= 8900);
const base = `http://127.0.0.1:${port}`, token = 'rich-notes-test';
let server, browser, log = '';
const sleep = ms => new Promise(r => setTimeout(r,ms));
const api = (path, method = 'GET', body) => fetch(`${base}${path}?token=${token}`,{method,headers:{'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)});
async function until(fn) { for(let i=0;i<100;i++) { if(await fn()) return; await sleep(100); } throw Error('Condition timeout'); }
try {
	server = spawn(process.execPath,['dist/server/index.js'],{env:{...testEnv(),PORT:String(port),PI_WEB_TOKEN:token,PI_WEB_CWD:root,PI_WEB_DATA_DIR:join(root,'data'),PI_CODING_AGENT_DIR:join(root,'agent')},stdio:['ignore','pipe','pipe']});
	server.stdout.on('data',d=>log+=d); server.stderr.on('data',d=>log+=d);
	await until(async()=>{ try{return (await fetch(`${base}/api/health`)).ok;}catch{return false;} });
	let note = (await (await api('/api/notes','POST',{title:'Shared editor',body:'Hello mixed 中文\n\n- First\n- Second\n\n> [!TIP]\n> Green\n\n> [!WARNING]\n> Yellow\n',pinned:false})).json()).note;
	const read = async()=> (await (await api(`/api/notes/${note.id}`)).json()).note;
	browser=await chromium.launch({executablePath:CHROME_PATH,headless:true});
	const page=await browser.newPage({viewport:{width:1440,height:1000}}); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
	await page.goto(`${base}/?token=${token}`); await page.locator('.setup-modal .modal-close').click();
	await page.getByRole('button',{name:'小记',exact:true}).click(); await page.locator('.note-list-item').first().click();
	const editor=page.locator('.notes-editor .fp-rich-document');
	await editor.waitFor();

	await editor.locator('p').first().click();
	await page.keyboard.press('End'); await page.keyboard.type(' direct-edit');
	await until(async()=> (await read()).body.includes('direct-edit'));
	// Click the blank body below a short note, as a user does to continue writing.
	const body = await page.locator('.notes-editor .fp-markdown').boundingBox();
	await page.mouse.click(body.x + body.width / 2, body.y + body.height - 45);
	await page.keyboard.type(' blank-area-edit');
	await until(async()=> (await read()).body.includes('blank-area-edit'));

	await page.reload(); await page.locator('.setup-modal .modal-close').click();
	await page.getByRole('button',{name:'小记',exact:true}).click(); await page.locator('.note-list-item').first().click();
	assert((await editor.innerText()).includes('blank-area-edit'), 'editing survives reload');
	await page.getByRole('button', {name:'新建小记',exact:true}).click();
	await until(async()=> (await editor.innerText()).trim() === '');
	const blank = await page.locator('.notes-editor .fp-markdown').boundingBox();
	await page.mouse.click(blank.x + blank.width / 2, blank.y + blank.height - 45);
	await page.keyboard.type('New blank note');
	await until(async()=> (await (await api('/api/notes')).json()).notes.some(n => n.body.includes('New blank note')));
	assert.deepEqual(errors, []);
	console.log('PASS direct Notes body editing, blank-area editing, empty notes and reload');
} catch(error) {console.error(log.slice(-1000));throw error;}
finally {await browser?.close();if(server?.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),sleep(5000)]);if(server.exitCode===null)server.kill('SIGKILL');}rmSync(root,{recursive:true,force:true});}
