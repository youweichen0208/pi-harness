import { expect, test } from "vitest";
import { alignOutputCode, formatBashOutput, formattedOutputCanExpand } from "../../web/src/bash-output-format.js";

test("Markdown search snippets retain source location and indentation", () => {
	const result = formatBashOutput('cd /tmp && rg -n "目录" docs/a.md | head -6', '3:正文 **强调**\n7:  第二条', true);
	expect(result.kind).toBe("search");
	if (result.kind === "search") expect(result.records[1]).toMatchObject({ path: "docs/a.md", line: "7", text: "  第二条", markdown: true });
});
test("single-file reads use the file language, mixed commands stay raw", () => {
	expect(formatBashOutput("cat src/a.ts", "const a = 1;", true)).toMatchObject({kind:"code",language:"typescript"});
	expect(formatBashOutput("cat README.md", "# Title", true).kind).toBe("markdown");
	expect(formatBashOutput("cat README.md; echo finished", "# Title\nfinished", true).kind).toBe("terminal");
	expect(formatBashOutput("cat README.md", "# Title", false).kind).toBe("terminal");
	expect(formatBashOutput("ls -la", "total 123\n-rw-r--r--  file", true).kind).toBe("terminal");
});
test("JSON formatting preserves large integers, strings, and invalid data", () => {
	const result = formatBashOutput("curl localhost", '{"id":9007199254740993,"text":"a, b: c"}', true);
	expect(result.kind).toBe("code");
	if (result.kind === "code") { expect(result.text).toContain("9007199254740993"); expect(result.text).toContain('"a, b: c"'); }
	expect(formatBashOutput("curl localhost", '{"id":', true).kind).toBe("terminal");
	expect(formatBashOutput("rg -n x a.md", "3:match\nerror: failure", true).kind).toBe("terminal");
});

test("mixed script logs and trailing search results keep order and known source", () => {
	const command = "cd /tmp && python3 - <<'PY'\nprint('css ok')\nPY\nrg -n 'toc-level' web/src/a.ts";
	const result = formatBashOutput(command, 'css ok\n299:    entry.style.setProperty("--toc-level", "1");', true);
	expect(result.kind).toBe("mixed");
	if (result.kind === "mixed") {
		expect(result.log).toBe("css ok");
		expect(result.records[0]).toMatchObject({path:"web/src/a.ts",line:"299",language:"typescript"});
	}
	expect(formatBashOutput("echo css-ok; rg -n x src/a.ts", "css ok\n299:const x = 1;", true).kind).toBe("mixed");
	expect(formatBashOutput("python3 - <<'PY'\nprint('rg -n x a.ts')\nPY", "css ok\n299:example", true).kind).toBe("terminal");
	expect(formatBashOutput("echo ok; rg -n x src", "ok\n299:example", true).kind).toBe("terminal");
	expect(formatBashOutput(command, "css ok\n299:example", false).kind).toBe("terminal");
	expect(formatBashOutput(command, "css ok\n12:30 log\n299:example\nfinished", true).kind).toBe("terminal");
});

test("expansion follows rendered sections rather than total raw lines", () => {
	const format = formatBashOutput('echo log; rg -n x src/a.ts', 'a\nb\nc\nd\n1:x\n2:x\n3:x\n4:x', true);
	expect(formattedOutputCanExpand(format)).toBe(true);
	const short = formatBashOutput('echo log; rg -n x src/a.ts', 'a\nb\nc\n1:x\n2:x\n3:x', true);
	expect(formattedOutputCanExpand(short)).toBe(false);
});

test("display alignment preserves relative indentation and numeric literals", () => {
	expect(alignOutputCode('\tif (ready) {\n\t\twait(1200);\n\t}')).toBe('if (ready) {\n\twait(1200);\n}');
	expect(alignOutputCode('const n = 299;')).toBe('const n = 299;');
	expect(alignOutputCode('\n \n\t// comment\n\n\tawait open();')).toBe('// comment\n\nawait open();');
});

 test("same-file search chains share a consistent presentation", () => {
	const result = formatBashOutput('cd /repo && rg -n "placeCaretIn\\(" src/editor.tsx; echo ---; rg -n "detail" src/editor.tsx', '580:    const focus = 1;\n747:        focus();\n---\n900:  if (event.detail === 2) {', true);
	expect(result.kind).toBe("search");
	if (result.kind === "search") {
		expect(result.records).toHaveLength(3);
		expect(result.records.every(record => record.path === "src/editor.tsx")).toBe(true);
	}
	expect(formatBashOutput('rg -n x a.ts; echo ---; rg -n y b.ts', '1:x\n---\n2:y', true).kind).not.toBe("search");
});
