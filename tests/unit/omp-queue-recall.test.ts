import { expect, it } from "vitest";
import { OmpQueueRecalls } from "../../server/omp/queue-recall.js";
import type { ServerMessage } from "../../server/protocol.js";

it("withdraws once across concurrent retries and replays until the owning conversation acknowledges", async () => {
	const sent: ServerMessage[] = [], replay: ServerMessage[] = [];
	const recalls = new OmpQueueRecalls(result => sent.push(result));
	let finish!: (result: { text: string; images: [] }) => void, calls = 0;
	const take = () => { calls++; return new Promise<{ text: string; images: [] }>(resolve => { finish = resolve; }); };
	const first = recalls.recall("a", "request", take), duplicate = recalls.recall("a", "request", take);
	await Promise.resolve(); expect(calls).toBe(1);
	await expect(recalls.recall("b", "request", take)).rejects.toThrow("another conversation");
	finish({ text: "original queue", images: [] }); await Promise.all([first, duplicate]);
	recalls.acknowledge("b", "request"); recalls.replay(result => replay.push(result));
	expect(replay).toEqual([sent[0]]);
	recalls.acknowledge("a", "request"); replay.length = 0; recalls.replay(result => replay.push(result));
	expect(replay).toEqual([]);
	await recalls.recall("a", "request", take); expect(calls).toBe(1);
});

it("does not retry an uncertain withdrawal or discard unacknowledged results at capacity", async () => {
	const recalls = new OmpQueueRecalls(() => {});
	let calls = 0;
	const failed = () => { calls++; return Promise.reject(Error("Acknowledgement lost")); };
	await expect(recalls.recall("a", "lost", failed)).rejects.toThrow("Acknowledgement lost");
	await expect(recalls.recall("a", "lost", failed)).rejects.toThrow("Acknowledgement lost");
	expect(calls).toBe(1);
	for (let i = 0; i < 7; i++) await recalls.recall("a", `r${i}`, async () => ({ text: `draft${i}`, images: [] }));
	await expect(recalls.recall("a", "overflow", async () => { throw Error("must not withdraw"); })).rejects.toThrow("previous recalled");
	recalls.acknowledge("a", "r0");
	await recalls.recall("a", "next", async () => ({ text: "next draft", images: [] }));
});
