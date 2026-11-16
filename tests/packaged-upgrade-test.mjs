// Read state written by the previous shipped runtime with the newly installed
// runtime. Product settings/uploads survive the engine change. Legacy Pi files
// are neither loaded nor changed implicitly; deletion is a separate user action.
// All data and credentials are fixtures; no model/network calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const phase = ["seed", "verify"].includes(args[0]) ? args.shift() : null;
const paths = args.map(p => resolve(p));
assert(paths.length === (phase ? 3 : 4), "Expected seed/verify executable/root/state-dir, or previous executable/root and current executable/root");
const temp = phase ? paths[2] : mkdtempSync(join(tmpdir(), "pi-upgrade-"));
for (const dir of ["agent", "data", "workspace"]) mkdirSync(join(temp, dir), { recursive: true });
const fixture = join(temp, "fixture.mjs");
writeFileSync(fixture, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const [mode,root,temp]=process.argv.slice(2);
const load=p=>import(pathToFileURL(root+'/'+p).href);
const agent=temp+'/agent',data=temp+'/data',cwd=temp+'/workspace';
if(mode==='seed') {
 fs.writeFileSync(agent+'/settings.json',JSON.stringify({defaultTools:['read'],reviewPreference:'preserved'}));
 fs.writeFileSync(agent+'/auth.json',JSON.stringify({fixture:{type:'api_key',key:'fake-upgrade-fixture'}}));
 fs.mkdirSync(agent+'/sessions',{recursive:true});
 const sessionPath=agent+'/sessions/legacy.jsonl';
 fs.writeFileSync(sessionPath,JSON.stringify({type:'session',version:3,id:'legacy-fixture',cwd,timestamp:new Date().toISOString()})+'\\n'+JSON.stringify({type:'message',id:'legacy-user',parentId:null,message:{role:'user',content:'upgrade-history-marker',timestamp:Date.now()}})+'\\n');
 fs.mkdirSync(data+'/uploads/upgrade',{recursive:true});
 fs.writeFileSync(data+'/uploads/upgrade/attachment.txt','upgrade-attachment-marker');
 fs.writeFileSync(temp+'/session-path',sessionPath);
 const {ClientStateStore}=await load('dist/server/client-state.js');
 const store=new ClientStateStore(data+'/client-state.json');
 store.saveSettings('upgrade',{thinkingWrap:false,toolsWrap:true});
 fs.writeFileSync(data+'/desktop-client-id','upgrade');
} else {
 const path=fs.readFileSync(temp+'/session-path','utf8');
 const before=fs.readFileSync(path,'utf8');
 const {OmpClientSession}=await load('dist/server/omp/chat-service.js');
 const {ClientStateStore}=await load('dist/server/client-state.js');
 const store=new ClientStateStore(data+'/client-state.json');
 assert.equal(store.getSettings('upgrade').thinkingWrap,false);
 assert.equal(store.getSettings('upgrade').toolsWrap,true);
 assert.equal(fs.readFileSync(data+'/desktop-client-id','utf8'),'upgrade');
 fs.mkdirSync(data+'/omp/agent',{recursive:true});
 fs.writeFileSync(data+'/omp/agent/config.yml',JSON.stringify({skills:{enabled:false}}));
 const client=new OmpClientSession('upgrade',cwd,store);
 await client.initialize();
 try {
  assert(!JSON.stringify(client.session.state.messages).includes('upgrade-history-marker'),'legacy Pi history must not be loaded into OMP');
  assert(client.session.state.tools.includes('task'),'upgrade must start the OMP engine');
  assert.equal(JSON.parse(fs.readFileSync(agent+'/settings.json')).reviewPreference,'preserved');
  assert.equal(JSON.parse(fs.readFileSync(agent+'/auth.json')).fixture.key,'fake-upgrade-fixture');
  assert.equal(fs.readFileSync(data+'/uploads/upgrade/attachment.txt','utf8'),'upgrade-attachment-marker');
  assert.equal(fs.readFileSync(path,'utf8'),before,'unselected legacy files must not be mutated');
 } finally { await client.dispose(); }
}
console.log('PASS packaged upgrade '+mode);
`);
try {
	const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", NODE_PATH: "", PI_CODING_AGENT_DIR: join(temp, "agent"), PI_WEB_DATA_DIR: join(temp, "data"), PI_WEB_CWD: join(temp, "workspace") };
	const runs = phase ? [[phase, paths[0], paths[1]]] : [["seed", paths[0], paths[1]], ["verify", paths[2], paths[3]]];
	for (const [mode, executable, root] of runs) {
		process.stdout.write(execFileSync(executable, [fixture, mode, root, temp], { env, cwd: temp, timeout: 60000, encoding: "utf8" }));
	}
} finally { if (!phase) rmSync(temp, { recursive: true, force: true }); }
