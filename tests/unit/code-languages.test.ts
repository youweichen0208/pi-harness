import { expect, test } from "vitest";
import type { Root } from "hast";
import { unified } from "unified";
import rehypeHighlight from "rehype-highlight";
import { common } from "lowlight";
import { extraCodeLanguages, highlightLine, highlightLines, langFromPath } from "../../web/src/hljs-lite.js";
import { formatBashOutput } from "../../web/src/bash-output-format.js";

const fixtures = [
	["app.dart", "dart", 'void main() { print("hello"); }'],
	["shell.nix", "nix", '{ pkgs ? import <nixpkgs> {} }: pkgs.mkShell { name = "hello"; }'],
	["task.groovy", "groovy", 'def greet = "hello"'],
	["build.gradle", "gradle", 'plugins { id "java" }'],
] as const;

test.each(fixtures)("%s highlights in file/diff/terminal/Markdown", (path, language, code) => {
	expect(langFromPath(path)).toBe(language);
	expect(highlightLine(code, language)).toContain('class="hljs-');
	expect(highlightLines(code, language)).toHaveLength(1);
	expect(formatBashOutput(`cat ${path}`, code, true)).toMatchObject({ kind: "code", language });
	const tree: Root = { type: "root", children: [{ type: "element", tagName: "pre", properties: {}, children: [{ type: "element", tagName: "code", properties: { className: [`language-${language}`] }, children: [{ type: "text", value: code }] }] }] };
	const result = unified().use(rehypeHighlight, { languages: { ...common, ...extraCodeLanguages } }).runSync(tree);
	expect(JSON.stringify(result)).toContain("hljs-");
});

test("Gradle Kotlin DSL remains Kotlin, and unsafe text is escaped", () => {
	expect(langFromPath("build.gradle.kts")).toBe("kotlin");
	expect(langFromPath("script.GVY")).toBe("groovy");
	expect(highlightLine('<script>alert("x")</script>', "dart")).not.toContain("<script>");
});
