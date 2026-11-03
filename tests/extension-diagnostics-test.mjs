/** Inject a package-resolution failure without contacting a registry. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scrubHostEnv} from './lib/test-env.mjs';
scrubHostEnv();
const root = mkdtempSync(join(tmpdir(),'pi-extension-diagnostics-'));
process.env.PI_CODING_AGENT_DIR = join(root,'agent');
process.env.PI_WEB_DATA_DIR = join(root,'data');
const {DefaultPackageManager} = await import('@earendil-works/pi-coding-agent');
const {ClientSession} = await import('../dist/server/agent-service.js');
const {ClientStateStore} = await import('../dist/server/client-state.js');
const {ThinkingDurationStore} = await import('../dist/server/thinking-timing.js');
const resolve = DefaultPackageManager.prototype.resolve;
DefaultPackageManager.prototype.resolve = async function(...args) {
	const result = await resolve.apply(this,args);
	return {...result,installFailures:[{source:'npm:fixture-unavailable',scope:'user',message:'fixture install failure'}]};
};
let client;
try {
	mkdirSync(join(process.env.PI_CODING_AGENT_DIR,'extensions'),{recursive:true});
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR,'extensions','broken.ts'),"export default function() { throw new Error('fixture load failure'); }");
	client = await ClientSession.create('diagnostics',root,new ClientStateStore(join(root,'state.json')),new ThinkingDurationStore(join(root,'thinking.json')));
	const wire = []; client.attachSink(message=>wire.push(message));
	const check = () => {
		assert(wire.some(m=>m.type==='notice' && m.level==='warning' && m.text.includes('fixture install failure')));
		assert(wire.some(m=>m.type==='notice' && m.level==='error' && m.text.includes('fixture load failure')));
	};
	check(); wire.length = 0;
	await client.reloadExtensions(); check();
	console.log('PASS extension install/load failures are visible on initial attach and reload');
} finally {
	DefaultPackageManager.prototype.resolve = resolve;
	await client?.dispose(); rmSync(root,{recursive:true,force:true});
}
