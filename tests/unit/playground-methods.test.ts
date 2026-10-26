import { expect, it } from "vitest";
import { discoverPythonMethods, isCaseList, isTestConfig, validateCases } from "../../server/playground-methods.js";
it("discovers only top-level Python functions, ignoring strings, nested functions and class methods", () => {
	const { methods } = discoverPythonMethods('"def fake(x): pass"\n# def comment(x): pass\ndef add(a: int, b: int = 2) -> int:\n    def nested(): pass\n    return a+b\nclass C:\n    def f(self): pass\nasync def label(value: str) -> str:\n    return value\n');
	expect(methods.map(m => m.id)).toEqual(["add(a,b)", "label(value)"]);
	expect(methods[1].parameters[0].type).toBe("str");
	expect(methods[1].returnType).toBe("str");
});
it("rejects variadic and keyword-only tests explicitly", () => {
	for (const code of ["def f(*args): pass", "def f(**kwargs): pass", "def f(x, *, y=1): pass"]) expect(discoverPythonMethods(code).methods[0].unsupported).toBeTruthy();
});
it("supports JSON objects, nested arrays, nullable values and unannotated functions", () => {
	const method = discoverPythonMethods("def f(value): return value").methods[0];
	expect(() => validateCases(method, [{ id: "a", args: [{ text: '{"items":[1,true,null]}' }], expected: { text: "null" } }])).not.toThrow();
	expect(() => validateCases(method, [{ id: "a", args: [{ text: "invalid" }] }])).toThrow(/Case 1/);
	expect(() => validateCases(method, [{ id: "a", args: [] }])).toThrow(/Parameter count/);
	expect(() => validateCases(method, [])).toThrow(/1 and 50/);
});
it("preserves raw str and validates persisted case configuration", () => {
	const method = discoverPythonMethods("def f(value: str) -> str: return value").methods[0];
	const cases = [{ id: "one", args: [{ text: "not JSON" }], expected: { text: "" } }];
	expect(() => validateCases(method, cases)).not.toThrow();
	expect(isCaseList([...cases, ...cases])).toBe(false);
	expect(isTestConfig({ mode: "program", selectedMethod: "f(value)", casesByMethod: { "f(value)": cases } })).toBe(true);
});
