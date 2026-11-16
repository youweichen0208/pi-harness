import { expect, it } from "vitest";
import { OmpHostTools, type HostTool } from "../../server/omp/host-tools.js";
import type { OmpFrame, OmpEnvelope } from "../../server/omp/transport.js";
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = (frame: OmpFrame): OmpEnvelope => ({ conversationId: "owner", generation: "current", sequence: 1, frame });
const call = event({ type: "host_tool_call", id: "request", toolCallId: "tool", toolName: "test", arguments: {} });
async function fixture(execute: HostTool["execute"]) {
	const replies: OmpFrame[] = [];
	const bridge = new OmpHostTools("owner", [{ name: "test", description: "Test", parameters: { type: "object" }, execute }]);
	await bridge.bind({ generation: "current", request: async () => ({ type: "response", success: true }), send: frame => { replies.push(frame); } });
	return { bridge, replies };
}
it("rejects other conversations/generations and does not execute duplicate requests", async () => {
	let runs = 0;
	const { bridge, replies } = await fixture(async () => { runs++; return { content: [] }; });
	bridge.observe({ ...call, conversationId: "another" }); bridge.observe({ ...call, generation: "old" });
	bridge.observe(call); bridge.observe(call); await tick(); bridge.observe(call); await tick();
	expect(runs).toBe(1); expect(replies).toHaveLength(1);
	bridge.close();
});
it("cancels the owned request and suppresses its late result", async () => {
	let signal: AbortSignal | undefined, finish!: () => void;
	const { bridge, replies } = await fixture(async (_, context) => {
		signal = context.signal;
		await new Promise<void>(resolve => { finish = resolve; });
		return { content: [{ type: "text", text: "too late" }] };
	});
	bridge.observe(call); await tick();
	bridge.observe(event({ type: "host_tool_cancel", id: "cancel", targetId: "request" }));
	expect(signal?.aborted).toBe(true);
	finish(); await tick(); expect(replies).toEqual([]); bridge.close();
});
it("never forwards exception secrets or oversized results", async () => {
	for (const execute of [async () => { throw Error("credential=secret"); }, async () => ({ content: [{ type: "text" as const, text: "x".repeat(1024 * 1024) }] })]) {
		const { bridge, replies } = await fixture(execute);
		bridge.observe(call); await tick();
		expect(replies[0]).toMatchObject({ type: "host_tool_result", isError: true });
		expect(JSON.stringify(replies)).not.toContain("credential=secret"); bridge.close();
	}
});
it("rejects unregistered capabilities and aborts handlers at shutdown", async () => {
	let signal: AbortSignal | undefined;
	const { bridge, replies } = await fixture(async (_, context) => { signal = context.signal; await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve())); return { content: [] }; });
	bridge.observe(event({ ...call.frame, id: "unknown", toolName: "bash" }));
	expect(replies[0]).toMatchObject({ isError: true });
	bridge.observe(call); await tick(); bridge.close(); await tick();
	expect(signal?.aborted).toBe(true); expect(replies).toHaveLength(1);
});
