import { describe, expect, it } from "vitest";
import { discoverJavaMethods, isCaseList, isTestConfig, validateCases, valueLiteral } from "../../server/playground-methods.js";

it("discovers fragments, overloads, arrays and public static methods without main", () => {
	const found = discoverJavaMethods(`import java.util.*;
public int add(int a, int b) { return a+b; }
public static long add(long a, long b) { return a+b; }
public String[] echo(String... a) { return a; }
private int hidden() { return 1; }
public static void main(String[] args) {}`);
	expect(found.methods.map(m => m.id)).toEqual(["Main#add(int,int)", "Main#add(long,long)", "Main#echo(String[])"]);
	expect(found.methods[1].isStatic).toBe(true);
	expect(found.code.indexOf("import")).toBeLessThan(found.code.indexOf("class Main"));
});

it("preserves complete source and excludes nested/private methods and fake declarations", () => {
	const source = `package com /* comment */ . example;
public class Demo {
// public int fake() {}
String s = "public int fake() {}";
public int[] echo(final int xs[])[] { return null; }
class Nested { public int hidden() { return 0; } }
}`;
	const found = discoverJavaMethods(source);
	expect(found.code).toBe(source);
	expect(found.fileName).toBe("com/example/Demo.java");
	expect(found.methods).toHaveLength(1);
	expect(found.methods[0]).toMatchObject({ id: "com.example.Demo#echo(int[])", returnType: "int[][]" });
});

it("handles incomplete edits and non-class top-level declarations", () => {
	for (const source of ["", "public class", "public class Main", "public class Main { public int", "public int f(", "public interface A {}", "public record A(int n) {}"])
		expect(() => discoverJavaMethods(source)).not.toThrow();
});

it("explains unsupported construction and types, while permitting static methods", () => {
	const methods = discoverJavaMethods("public class A { public A(int a) {} public int f() {return 1;} public static int g(){return 1;} public java.util.List<String> h(){return null;} }").methods;
	expect(methods[0].unsupported).toMatch(/constructor/);
	expect(methods[1].unsupported).toBeUndefined();
	expect(methods[2].unsupported).toMatch(/types/);
});

it("validates integer precision and bounds without rounding long", () => {
	expect(valueLiteral("long", { text: "9223372036854775807" })).toBe("9223372036854775807L");
	expect(valueLiteral("long[]", { text: '["9223372036854775807"]' })).toContain("9223372036854775807L");
	for (const [type, text] of [["byte", "128"], ["int", "2147483648"], ["long", "9223372036854775808"], ["long[]", "[9223372036854775807]"], ["int[]", "[[1]]"], ["int", "1);System.exit(0)"]])
		expect(() => valueLiteral(type, { text })).toThrow();
});

it("distinguishes null, empty text and a missing assertion", () => {
	expect(valueLiteral("String", { text: "" })).toContain("new char[]{}");
	expect(valueLiteral("String", { text: "", isNull: true })).toBe("(String)null");
	expect(() => valueLiteral("int", { text: "", isNull: true })).toThrow();
	const method = discoverJavaMethods("public String f(){ return null; }").methods[0];
	expect(() => validateCases(method, [{ id: "a", args: [] }])).not.toThrow();
	expect(() => validateCases(method, [{ id: "a", args: [], expected: { text: "" } }])).not.toThrow();
});

it("validates draft shape and duplicate case IDs", () => {
	expect(isCaseList([{ id: "a", args: [] }, { id: "a", args: [] }])).toBe(false);
	expect(isCaseList([{ id: "a", args: [{ text: 1 }] }])).toBe(false);
	expect(isTestConfig({ mode: "methods", selectedMethod: "A#f()", casesByMethod: { "A#f()": [{ id: "a", args: [] }] } })).toBe(true);
});

describe("typed input", () => {
	it.each(["boolean", "char", "float", "double", "Integer", "Boolean", "String[][]"])("accepts %s", type => {
		const values: Record<string, string> = { boolean: "true", char: "中", float: "1.2", double: "1e3", Integer: "42", Boolean: "false", "String[][]": '[["a"],null]' };
		expect(valueLiteral(type, { text: values[type] })).toBeTruthy();
	});
});
