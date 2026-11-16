import { describe, expect, it } from "vitest";
import { repetitiveReasoning } from "../../server/reasoning-repetition.js";

describe("reasoning repetition saturation", () => {
	it("detects sustained English and Chinese cycles", () => {
		expect(repetitiveReasoning("Emit. Write tool call. Now. Ok, output.\n".repeat(100))).toBe(true);
		expect(repetitiveReasoning("现在调用工具。继续分析。现在调用工具。\n".repeat(200))).toBe(true);
	});
	it("does not confuse short repetition, progress or technical structure with a loop", () => {
		expect(repetitiveReasoning("Emit. Write tool call. Now. Ok, output.\n".repeat(15))).toBe(false);
		expect(repetitiveReasoning(Array.from({ length: 200 }, (_, i) => `Checking row ${i}, its value is ${i * 3}, next index ${i + 1}.`).join("\n"))).toBe(false);
		expect(repetitiveReasoning(Array.from({ length: 300 }, (_, i) => `第${i}项：检查文件${i}.ts中的函数，返回值${i * 2}。`).join("\n"))).toBe(false);
		expect(repetitiveReasoning("0123456789".repeat(1000))).toBe(false);
	});
});

import { ReasoningRepetitionWatchdog, type ReasoningStreamEvent } from "../../server/reasoning-repetition.js";
const update = (delta: string, contentIndex = 0, type: "thinking_delta" | "text_delta" | "toolcall_delta" = "thinking_delta"): ReasoningStreamEvent => ({ type: "message_update", assistantMessageEvent: { type, delta, contentIndex } });
it("is chunk-independent, fires once and resets for each message", () => {
	const text = "Emit. Write tool call. Now. Ok, output.\n".repeat(200);
	for (const size of [1, 31, text.length]) {
		const watch = new ReasoningRepetitionWatchdog(); let hits = 0;
		for (let i = 0; i < text.length; i += size) if (watch.observe(update(text.slice(i, i + size)))) hits++;
		expect(hits).toBe(1);
		expect(watch.observe(update(text))).toBe(false);
		watch.observe({ type: "message_start" });
		expect(watch.observe(update(text))).toBe(true);
	}
});
it("ignores repeated answer text and never combines separate thinking blocks or sessions", () => {
	const text = "Emit. Write tool call. Now. Ok, output.\n".repeat(200);
	const watch = new ReasoningRepetitionWatchdog();
	expect(watch.observe(update(text, 0, "text_delta"))).toBe(false);
	expect(watch.observe(update(text.slice(0, 1500), 0))).toBe(false);
	expect(watch.observe(update(text.slice(0, 1500), 1))).toBe(false);
	expect(new ReasoningRepetitionWatchdog().observe(update(text.slice(0, 1500)))).toBe(false);
});
it("ignores tool argument streams and resets at native OMP settling and block boundaries", () => {
	const text = "Emit. Write tool call. Now. Ok, output.\n".repeat(200);
	const watch = new ReasoningRepetitionWatchdog();
	expect(watch.observe(update(text, 0, "toolcall_delta"))).toBe(false);
	for (const event of [{ type: "session_settled" }, { type: "message_update", assistantMessageEvent: { type: "thinking_end" } }]) {
		watch.observe({ type: "message_start" });
		expect(watch.observe(update(text.slice(0, 1500)))).toBe(false);
		watch.observe(event);
		expect(watch.observe(update(text.slice(0, 1500)))).toBe(false);
	}
	watch.observe({ type: "session_settled" });
	expect(watch.observe(update(text + "A distinct ending to a very large chunk"))).toBe(true);
	watch.observe({ type: "session_settled" });
	expect(watch.observe(update(text))).toBe(true);
});
it("does not accumulate malformed RPC deltas", () => {
	const watch = new ReasoningRepetitionWatchdog();
	for (const delta of [null, [], { type: "thinking_delta", delta: 1, contentIndex: 0 }, { type: "thinking_delta", delta: "x".repeat(10000), contentIndex: -1 }]) expect(watch.observe({ type: "message_update", assistantMessageEvent: delta })).toBe(false);
});
