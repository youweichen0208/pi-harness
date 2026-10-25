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
// #96: hand off immediately after manual input, before Bash emits its next prompt.
// Do not call ready() here: execute must wait for the manual command to finish itself.
await service.handle('fixture',{type:'node_request',action:'terminal_input',requestId:'manual-short',nodeId,terminalId:'term',conversationId:opened.conversationId,payload:{data:'sleep 0.2; printf "manual-finished\\n"\n'}});
assert.equal(terminal.promptReady,false);
const afterManual=await service.execute('fixture',nodeId,'term',root,'printf "agent-after-manual\\n"',5);
assert.equal(afterManual.output,'agent-after-manual');
assert(terminal.buffer.includes('manual-finished'));
await ready();
// #120: sudo/su/子 shell 或 source 配置会换掉 PS1（真实环境里 PS1 不由环境继承），
// 提示符标记永久丢失，之后每条 Agent 命令都报「手动终端正忙」。execute 应探测
// 空闲 shell 并重新安装标记。这里用直接覆盖 PS1 模拟同一结果状态。
await service.handle('fixture',{type:'node_request',action:'terminal_input',requestId:'ps1-override',nodeId,terminalId:'term',conversationId:opened.conversationId,payload:{data:`PS1='custom$ '\n`}});
await new Promise(r=>setTimeout(r,300));
assert.equal(terminal.promptReady,false,'overridden PS1 has no prompt marker');
// A full-screen program (alternate screen) must not receive probe keystrokes.
await service.handle('fixture',{type:'node_request',action:'terminal_input',requestId:'alt-on',nodeId,terminalId:'term',conversationId:opened.conversationId,payload:{data:'printf "\\033[?1049h"\n'}});
await new Promise(r=>setTimeout(r,300));
assert.equal(terminal.altScreen,true);
await assert.rejects(service.execute('fixture',nodeId,'term',root,'echo must-not-probe-altscreen',2),/手动终端正忙/);
await service.handle('fixture',{type:'node_request',action:'terminal_input',requestId:'alt-off',nodeId,terminalId:'term',conversationId:opened.conversationId,payload:{data:'printf "\\033[?1049l"\n'}});
await new Promise(r=>setTimeout(r,300));
assert.equal(terminal.altScreen,false);
const recovered=await service.execute('fixture',nodeId,'term',root,'printf "recovered-in-subshell\\n"',5);
assert.equal(recovered.output,'recovered-in-subshell');
// The post-command prompt marker can still be in flight when execute() returns; wait
// for it like the other manual handoffs above.
await ready();
assert.equal(terminal.promptReady,true,'probe re-armed the marker after the PS1 override');
// An unsubmitted manual line must not receive probe text either.
await service.handle('fixture',{type:'node_request',action:'terminal_input',requestId:'partial',nodeId,terminalId:'term',conversationId:opened.conversationId,payload:{data:'echo partial'}});
assert.equal(terminal.manualTyped,true);
await assert.rejects(service.execute('fixture',nodeId,'term',root,'echo must-not-probe-partial',2),/手动终端正忙/);
await service.handle('fixture',{type:'node_request',action:'interrupt',requestId:'partial-cancel',nodeId,terminalId:'term',conversationId:opened.conversationId,payload:{data:'\x03'}});
await ready();
assert.equal((await service.execute('fixture',nodeId,'term',root,'printf after-ctrl-c',5)).output,'after-ctrl-c');
await ready();
assert(!terminal.buffer.includes('must-not-probe-altscreen'));
assert(!terminal.buffer.includes('must-not-probe-partial'));
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
// The idle probe queued behind `sleep 20` runs after the interrupt and self-heals
// the marker; its framing is captured, so only the stealing command itself could
// ever surface in the visible buffer.
assert(!terminal.buffer.includes('__PI_DONE_'));
assert(!terminal.buffer.includes('__PI_BEGIN_'));
assert(!terminal.buffer.includes('must-not-steal'));
assert(!terminal.welcome.includes('__pi_prompt='));
console.log('PASS actual Bash PTY: UTF-8, output framing, exit code, abort, timeout, manual-to-agent handoff (#96), manual ownership, prompt-marker recovery (#120)');
}finally{service.dispose();client.end();for(const c of peers)c.end();for(const t of terms)t.kill();await new Promise(r=>ssh.close(r));rmSync(root,{recursive:true,force:true});}
