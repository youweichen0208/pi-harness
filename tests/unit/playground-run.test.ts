import { expect, it } from "vitest";
import { ConcurrencyGate } from "../../server/playground-run.js";

it("allows up to the global limit and then refuses", () => {
	const gate = new ConcurrencyGate();
	const first = gate.acquire(undefined, 2, 1);
	const second = gate.acquire(undefined, 2, 1);
	expect(first).toBeTypeOf("function");
	expect(second).toBeTypeOf("function");
	expect(gate.acquire(undefined, 2, 1)).toBeUndefined();
	expect(gate.running).toBe(2);
});

it("frees a slot when the release function is called, and only once", () => {
	const gate = new ConcurrencyGate();
	const release = gate.acquire(undefined, 1, 1)!;
	expect(gate.acquire(undefined, 1, 1)).toBeUndefined();
	release();
	release();
	expect(gate.running).toBe(0);
	expect(gate.acquire(undefined, 1, 1)).toBeTypeOf("function");
});

it("holds one client to its own limit even while global room remains", () => {
	const gate = new ConcurrencyGate();
	const release = gate.acquire("tab-a", 2, 1)!;
	expect(gate.acquire("tab-a", 2, 1)).toBeUndefined();
	expect(gate.acquire("tab-b", 2, 1)).toBeTypeOf("function");
	expect(gate.running).toBe(2);
	release();
	expect(gate.acquire("tab-a", 2, 1)).toBeTypeOf("function");
});

it("tracks an anonymous caller against the global limit only", () => {
	const gate = new ConcurrencyGate();
	expect(gate.acquire(undefined, 2, 1)).toBeTypeOf("function");
	expect(gate.acquire(undefined, 2, 1)).toBeTypeOf("function");
	expect(gate.acquire(undefined, 2, 1)).toBeUndefined();
});

it("follows the limits it is handed, so a settings change takes effect", () => {
	const gate = new ConcurrencyGate();
	expect(gate.acquire(undefined, 1, 1)).toBeTypeOf("function");
	expect(gate.acquire(undefined, 2, 1)).toBeTypeOf("function");
	expect(gate.acquire(undefined, 2, 1)).toBeUndefined();
});
