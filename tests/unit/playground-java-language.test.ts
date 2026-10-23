import { expect, it } from "vitest";
import { javaAnalysisSource } from "../../server/playground-java-language.js";

it("preserves exact offsets for complete sources and packages", () => {
	const code = 'package demo; public class Solution { int f(){ return 1; } }';
	expect(javaAnalysisSource(code)).toEqual({ code, prefix: 0, file: "demo/Solution.java" });
});
it("wraps fragments while retaining user offsets and extracting imports", () => {
	const code = 'import java.util.Map;\nint f(Map<String,Integer> map) { return map.size(); }';
	const result = javaAnalysisSource(code);
	expect(result.code.startsWith('import java.util.Map;\npublic class Main {\n')).toBe(true);
	const cursor = code.indexOf('map.size');
	expect(result.code.slice(cursor + result.prefix, cursor + result.prefix + 8)).toBe('map.size');
	expect(result.file).toBe('Main.java');
});
it("does not treat classes in strings and comments as a compilation unit", () => {
	const result = javaAnalysisSource('String f(){ return "class Fake {}"; }');
	expect(result.prefix).toBeGreaterThan(0);
	expect(result.file).toBe('Main.java');
});
