import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ssh2 from 'ssh2';
const {Server,Client}=ssh2;
import pty from 'node-pty';
import {NodeWorkbench} from '../dist/server/node-workbench.js';
if (process.platform === 'win32') { console.log('SKIP: native POSIX PTY regression'); process.exit(0); }
const root=mkdtempSync(join(tmpdir(),'pi-real-pty-'));
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
// Without a UTF-8 locale bash readline treats CJK bytes as meta keys and mangles the typed command.
const peers=new Set(); const terms=new Set();
const ssh=new Server({hostKeys:[key]},c=>{peers.add(c);c.on('error',()=>{});c.on('authentication',x=>x.accept());c.on('ready',()=>c.on('session',accept=>{const session=accept(); session.on('pty',a=>a());session.on('shell',a=>{const stream=a();const term=pty.spawn('/bin/bash',['--noprofile','--norc'],{cwd:root,env:{...process.env,LC_ALL:process.platform==='darwin'?'en_US.UTF-8':'C.UTF-8',PS1:'fixture$ '},cols:100,rows:24});terms.add(term);term.onData(s=>stream.write(s));stream.on('data',d=>term.write(d.toString()));stream.on('close',()=>{term.kill();terms.delete(term)});});}));});
await new Promise(r=>ssh.listen(0,'127.0.0.1',r));
const client=new Client();await new Promise((resolve,reject)=>{client.on('error',reject);client.on('ready',resolve);client.connect({host:'127.0.0.1',port:ssh.address().port,username:'fixture'});});
const service=new NodeWorkbench(join(root,'data'));
const nodeId=crypto.randomUUID();service.nodes.push({id:nodeId,defaultDir:root});
const conn={client,clientId:'fixture',nodeId,terminals:new Map(),ready:true,startedAt:Date.now()};service.connections.set(JSON.stringify(['fixture',nodeId]),conn);
const wire=[];service.attach('fixture',m=>wire.push(m));
try{
const opened=await service.openTerminal('fixture',{nodeId,payload:{},terminalId:'term'});
const result=await service.execute('fixture',nodeId,'term',root,"printf '你好\\nsecond\\n'",5,undefined,'tool-1');
assert.equal(result.output,'你好\nsecond');
await new Promise(r=>setTimeout(r,100));
await assert.rejects(service.execute('fixture',nodeId,'term',root,'exit 7',5),/exit: 7/);

const terminal=conn.terminals.get('term');
const ready=async()=>{for(let i=0;i<200;i++){if(terminal.promptReady)return;await new Promise(r=>setTimeout(r,10));}throw new Error('prompt not restored');};
await ready();
const cancellation=new AbortController();
const cancelled=service.execute('fixture',nodeId,'term',root,'sleep 20',5,cancellation.signal);
setTimeout(()=>cancellation.abort(),100);
await assert.rejects(cancelled,/中断/);
await ready();
await assert.rejects(service.execute('fixture',nodeId,'term',root,'sleep 20',1),/超时/);
await ready();
await service.handle('fixture',{type:'node_request',action:'terminal_input',requestId:'manual',nodeId,terminalId:'term',conversationId:opened.conversationId,payload:{data:'sleep 20\n'}});
// Ctrl+C racing bash's fork of the manual command loses: SIGINT reaches only the interactive
// shell, sleep runs to completion and the marker returns ~20s later. Give the command time
// to actually start, like the execute-abort case above.
await new Promise(r=>setTimeout(r,100));
await assert.rejects(service.execute('fixture',nodeId,'term',root,'echo must-not-steal',2),/手动终端正忙/);
await service.handle('fixture',{type:'node_request',action:'interrupt',requestId:'interrupt',nodeId,terminalId:'term',conversationId:opened.conversationId,payload:{}});
await ready();
assert(!terminal.buffer.includes('__PI_DONE_'));
assert(!terminal.buffer.includes('__PI_BEGIN_'));
assert(!terminal.welcome.includes('__pi_prompt='));
console.log('PASS actual Bash PTY: UTF-8, output framing, exit code, abort, timeout, manual ownership');
}finally{service.dispose();client.end();for(const c of peers)c.end();for(const t of terms)t.kill();await new Promise(r=>ssh.close(r));rmSync(root,{recursive:true,force:true});}
