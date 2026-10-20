import { expect, it } from "vitest";
import { OutputBudget, introspectJavaSource, looksLikeMissingProjectDependency } from "../../server/playground-source.js";

it("names the file after the first public top-level type", () => {
	expect(introspectJavaSource("public class Foo { }"))
		.toEqual({ typeName: "Foo", packageName: undefined, fileName: "Foo.java", mainClass: "Foo" });
	expect(introspectJavaSource("public final class Bar {}").typeName).toBe("Bar");
	expect(introspectJavaSource("public abstract class Baz {}").typeName).toBe("Baz");
	expect(introspectJavaSource("public record Point(int x, int y) {}").typeName).toBe("Point");
	expect(introspectJavaSource("public enum Color { RED, GREEN }").typeName).toBe("Color");
	expect(introspectJavaSource("public interface Greeter { void greet(); }").typeName).toBe("Greeter");
	expect(introspectJavaSource("public sealed interface Shape permits Circle {}").typeName).toBe("Shape");
});

it("falls back to Main when nothing is public", () => {
	const expected = { typeName: "Main", packageName: undefined, fileName: "Main.java", mainClass: "Main" };
	expect(introspectJavaSource("class Foo { }")).toEqual(expected);
	expect(introspectJavaSource("void main() { System.out.println(1); }")).toEqual(expected);
	expect(introspectJavaSource("")).toEqual(expected);
});

it("honours a package declaration", () => {
	expect(introspectJavaSource("package com.example;\npublic class Foo {}"))
		.toEqual({ typeName: "Foo", packageName: "com.example", fileName: "com/example/Foo.java", mainClass: "com.example.Foo" });
	expect(introspectJavaSource("package  com.example ;\nclass Foo {}").fileName).toBe("com/example/Main.java");
	expect(introspectJavaSource("package com.example;\nclass Foo {}").mainClass).toBe("com.example.Main");
});

it("takes the first public type when several are declared", () => {
	expect(introspectJavaSource("public class First {}\npublic class Second {}").typeName).toBe("First");
});

it("ignores declarations hidden in comments and string literals", () => {
	expect(introspectJavaSource("// public class Fake {}\npublic class Real {}").typeName).toBe("Real");
	expect(introspectJavaSource("/* public class Fake {} */\npublic class Real {}").typeName).toBe("Real");
	expect(introspectJavaSource('String s = "public class Fake {}";\npublic class Real {}').typeName).toBe("Real");
	expect(introspectJavaSource('String s = """\npublic class Fake {}\n""";\npublic class Real {}').typeName).toBe("Real");
	expect(introspectJavaSource("char quote = '\\'';\npublic class Real {}").typeName).toBe("Real");
	expect(introspectJavaSource("// package fake;\npackage real;\npublic class Real {}").packageName).toBe("real");
	expect(introspectJavaSource("/* package fake; */\npublic class Real {}").packageName).toBeUndefined();
});

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

it("recognises compile errors that need the rest of the project", () => {
	expect(looksLikeMissingProjectDependency("Main.java:3: error: package org.example does not exist")).toBe(true);
	expect(looksLikeMissingProjectDependency("Main.java:5: error: cannot find symbol\n  symbol:   class Helper\n  location: class Main")).toBe(true);
	expect(looksLikeMissingProjectDependency("Main.java:5: error: cannot find symbol\n  symbol:   variable total")).toBe(false);
	expect(looksLikeMissingProjectDependency("Main.java:1: error: ';' expected")).toBe(false);
	expect(looksLikeMissingProjectDependency("")).toBe(false);
});
