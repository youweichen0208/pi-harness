import { expect, it } from "vitest";
import { OutputBudget, looksLikeMissingProjectDependency } from "../../server/playground-source.js";
it("forwards everything under the cap", () => {
	const budget = new OutputBudget(100);
	expect(budget.push("hello ")).toBe("hello ");
	expect(budget.push("world")).toBe("world");
	expect(budget.exceeded).toBe(false);
	expect(budget.bytes).toBe(11);
});

it("cuts the chunk that crosses the cap and stays quiet afterwards", () => {
	const budget = new OutputBudget(5);
	expect(budget.push("abc")).toBe("abc");
	expect(budget.push("defg")).toBe("de");
	expect(budget.exceeded).toBe(true);
	expect(budget.push("more")).toBe("");
	expect(budget.bytes).toBe(5);
});

it("counts bytes, not characters", () => {
	const budget = new OutputBudget(6);
	expect(budget.push("中文")).toBe("中文");
	expect(budget.push("x")).toBe("");
	expect(budget.exceeded).toBe(true);
	expect(budget.bytes).toBe(6);
});

it("never emits a partial character when the cap lands mid-character", () => {
	const budget = new OutputBudget(4);
	expect(budget.push("中文")).toBe("中");
	expect(budget.exceeded).toBe(true);
	expect(budget.bytes).toBe(3);
});

it("recognises missing Python imports", () => {
 expect(looksLikeMissingProjectDependency("ModuleNotFoundError: No module named 'custom'")).toBe(true);
 expect(looksLikeMissingProjectDependency("SyntaxError: invalid syntax")).toBe(false);
});
