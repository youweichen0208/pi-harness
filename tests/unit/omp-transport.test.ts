import { describe, expect, it } from "vitest";
import { OmpTransport, type OmpEnvelope } from "../../server/omp/transport.js";

const fixture = `
const readline = require('node:readline');
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.type==='hang' || m.type==='compact') return;
 if(m.type==='prompt') {
  send({type:'response',id:m.id,success:true,command:m.type});
  setTimeout(() => {
   send({type:'prompt_result',id:'unrelated',agentInvoked:false,status:'completed',sessionSettled:true});
   const result={type:'prompt_result',id:m.id,agentInvoked:false,status:'completed',sessionSettled:true,marker:m.marker};
   send(result); send(result);
  },m.delay);
  return;
 }
 if(m.type==='crash') return process.exit(7);
 if(m.type==='bad') return process.stdout.write('not-json\\n');
 send({type:'response',id:m.id,success:true,command:m.type});
 if(m.type==='run') {
  send({type:'agent_start'});
  send({type:'agent_end'});
  send({type:'prompt_result',sessionSettled:false,status:'completed'});
 }
 if(m.type==='settle') send({type:'session_settled'});
});`;
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
function start(timeout = 2000) {
	const events: OmpEnvelope[] = [], errors: Error[] = [];
	const transport = new OmpTransport({ conversationId: "test", executable: process.execPath, args: ["-e", fixture], cwd: process.cwd(), env: {}, onEvent: e => events.push(e), onExit: e => errors.push(e), requestTimeoutMs: timeout });
	return { transport, events, errors };
}
describe("OMP subprocess transport", () => {
	it("correlates commands and keeps background work busy after agent_end", async () => {
		const { transport, events } = start();
		try {
			await transport.request("run", { id: "spoof", type: "crash" }); await tick();
			expect(transport.isBusy).toBe(true);
			expect(events.map(e => e.frame.type)).toEqual(["agent_start", "agent_end", "prompt_result"]);
			expect(events.every(e => e.conversationId === "test" && e.generation === transport.generation)).toBe(true);
			await transport.request("settle"); await tick();
			expect(transport.isBusy).toBe(false);
			expect(events.map(e => e.sequence)).toEqual([1, 2, 3, 4]);
		} finally { await transport.close(); }
	});
	it.each(["crash", "bad"])("rejects pending work on %s without replay", async command => {
		const { transport, errors } = start();
		try {
			await expect(transport.request(command)).rejects.toThrow();
			await expect(transport.request("run")).rejects.toThrow("closed");
			expect(errors).toHaveLength(1);
		} finally { await transport.close(); }
	});
	it("treats an acknowledgement timeout as unknown outcome", async () => {
		const { transport, events } = start(150);
		try { await expect(transport.request("hang")).rejects.toThrow("outcome is unknown"); expect(events).toEqual([]); }
		finally { await transport.close(); }
	});
	it("closes idempotently and rejects outstanding requests", async () => {
		const { transport, errors } = start();
		const pending = expect(transport.request("hang")).rejects.toThrow("closed");
		await Promise.all([transport.close(), transport.close(), pending]);
		expect(errors).toEqual([]);
	});
	it("waits for summary completion beyond the admission deadline, but rejects on close", async () => {
		const { transport } = start(100);
		let settled = false;
		const result = transport.request("compact").then(() => { settled = true; }, () => { settled = true; });
		try {
			await new Promise(resolve => setTimeout(resolve, 250));
			expect(settled).toBe(false);
			await transport.close(); await result;
			expect(settled).toBe(true);
		} finally { await transport.close(); }
	});
});

it("correlates delayed local outcomes after admission, ignores duplicates and closes outstanding observers", async () => {
	const { transport } = start();
	const outcomes: string[] = [];
	try {
		await transport.request("prompt", { marker: "slow", delay: 200 }, frame => outcomes.push(String(frame.marker)));
		await transport.request("prompt", { marker: "fast", delay: 20 }, frame => outcomes.push(String(frame.marker)));
		expect(outcomes).toEqual([]);
		await new Promise(resolve => setTimeout(resolve, 300));
		expect(outcomes).toEqual(["fast", "slow"]);
		await transport.request("prompt", { marker: "closed", delay: 100 }, frame => outcomes.push(String(frame.marker)));
		await transport.close();
		expect(outcomes).toEqual(["fast", "slow"]);
	} finally { await transport.close(); }
});
