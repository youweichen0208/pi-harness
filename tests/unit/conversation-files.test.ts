import { expect, test } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { conversationFileEntries, conversationFiles, mentionedHiddenDirs } from "../../web/src/conversation-files.js";
import { hasNumberedPipelineOutput, hasSearchSourceNumbers, searchSourceNumberParts, numberedOutputLine, selectVisibleOutputLines, displayBashCommand, isLikelyErrorLine, isSearchCommand, searchOutputKind } from "../../web/src/bash-presentation.js";
import { existingConversationFiles } from "../../server/files-service.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("conversation files include recent workspace tool targets and bash references", () => {
	const messages = [
		{ id: "1", role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", argumentsText: JSON.stringify({ path: "/tmp/work/CONTEXT.md" }) }] },
		{ id: "2", role: "assistant", content: [{ type: "toolCall", id: "t2", name: "bash", argumentsText: JSON.stringify({ command: "grep -n pattern .scratch/spec.md; cat ../other/private.md" }) }] },
	] as UiMessage[];
	expect(conversationFiles(messages, "/tmp/work")).toEqual([".scratch/spec.md", "CONTEXT.md"]);
	expect(conversationFileEntries(messages, "/tmp/work")).toEqual([{ path: ".scratch/spec.md", action: "grep" }, { path: "CONTEXT.md", action: "read" }]);
});

test("write targets are classified as writes and keep their directory", () => {
	const messages = [{ id: "1", role: "assistant", content: [
		{ type: "toolCall", id: "w1", name: "write", argumentsText: JSON.stringify({ path: "youwei_core/api/main.py", content: "hello" }) },
		{ type: "toolCall", id: "w2", name: "write", argumentsText: JSON.stringify({ path: "youwei_core/worker/__init__.py", content: "" }) },
	] }] as UiMessage[];
	expect(conversationFileEntries(messages, "/tmp/work")).toEqual([
		{ path: "youwei_core/worker/__init__.py", action: "write" },
		{ path: "youwei_core/api/main.py", action: "write" },
	]);
});

test("grep source lines replace generated output line numbers", () => {
	expect(numberedOutputLine("15:  匹配内容", 0, true)).toEqual({ number: "15", text: "匹配内容" });
	expect(numberedOutputLine("spec.md:27:  another match", 1, true)).toEqual({ number: "27", text: "spec.md: another match" });
	expect(numberedOutputLine("ordinary output", 2)).toEqual({ number: "3", text: "ordinary output" });
	expect(numberedOutputLine("12:34: started", 0)).toEqual({ number: "1", text: "12:34: started" });
	expect(numberedOutputLine("2026-09-27", 0, true)).toEqual({ number: "1", text: "2026-09-27" });
	expect(numberedOutputLine("---", 2, true)).toEqual({ number: "3", text: "---" });
	expect(numberedOutputLine("docs/ARCHITECTURE.md:212: matched", 3, true)).toEqual({ number: "212", text: "docs/ARCHITECTURE.md: matched" });
	expect(numberedOutputLine("2026-09-27", 0, "mixed")).toEqual({ number: "1", text: "2026-09-27" });
	expect(numberedOutputLine("docs/ARCHITECTURE.md:212: matched", 3, "mixed")).toEqual({ number: "212", text: "docs/ARCHITECTURE.md: matched" });
	expect(numberedOutputLine("331:      ordinary code", 0, false)).toEqual({ number: "1", text: "331:      ordinary code" });
	expect(isSearchCommand(JSON.stringify({ command: "date +%F; grep -rn pattern docs" }))).toBe(true);
	expect(isSearchCommand(JSON.stringify({ command: "grep pattern docs" }))).toBe(false);
	expect(searchOutputKind(JSON.stringify({ command: "date +%F; grep -rn pattern docs" }))).toBe("mixed");
});

test("bash output separators are not treated as filename prefixes", () => {
	const messages = [{ id: "1", role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", argumentsText: JSON.stringify({ command: "rg AGENTS.md; echo ---AGENTS.md; cat server/conversation-files.ts" }) }] }] as UiMessage[];
	expect(conversationFiles(messages, "/tmp/work")).toContain("AGENTS.md");
	expect(conversationFiles(messages, "/tmp/work")).not.toContain("---AGENTS.md");
	expect(conversationFiles(messages, "/tmp/work")).toContain("server/conversation-files.ts");
});

test("conversation file candidates are confirmed in the selected workspace", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-conversation-files-"));
	try {
		mkdirSync(join(root, "current"));
		mkdirSync(join(root, "other"));
		writeFileSync(join(root, "current", "CONTEXT.md"), "current");
		writeFileSync(join(root, "other", "AGENTS.md"), "other");
		const messages = [{ id: "1", role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", argumentsText: JSON.stringify({ command: "cat CONTEXT.md; cat AGENTS.md; cat server/conversation-files.ts" }) }] }] as UiMessage[];
		const candidates = conversationFiles(messages, join(root, "current"));
		expect(candidates).toContain("AGENTS.md"); // extraction is deliberately broad
		expect(existingConversationFiles(join(root, "current"), candidates)).toEqual(["CONTEXT.md"]);
		expect(existingConversationFiles(join(root, "current"), ["../other/AGENTS.md", join(root, "other", "AGENTS.md")])).toEqual([]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("collapsed bash output retains likely error lines and the tail", () => {
	const lines = Array.from({ length: 21 }, (_, index) => index === 12 ? "ls: missing: No such file or directory" : `line ${index}`);
	expect(selectVisibleOutputLines(lines, false)).toContain(12);
	expect(selectVisibleOutputLines(lines, false)).toContain(20);
	expect(selectVisibleOutputLines(lines, false).length).toBeLessThan(21);
});

test("bash presentation keeps copy text intact while shortening the displayed home", () => {
	expect(displayBashCommand("ls /Users/alice/projects/app", "/Users/alice/projects/app")).toBe("ls ~/projects/app");
	expect(isLikelyErrorLine("ls: missing: No such file or directory")).toBe(true);
	expect(isLikelyErrorLine("total 104")).toBe(false);
	expect(isLikelyErrorLine("AssertionError [ERR_ASSERTION]: expected true")).toBe(true);
	expect(isLikelyErrorLine("TypeError: cannot read properties")).toBe(true);
	expect(isLikelyErrorLine("  code: 'ERR_ASSERTION',")).toBe(true);
	expect(isLikelyErrorLine("  at file:///tmp/test.mjs:91:2")).toBe(false);
	expect(isLikelyErrorLine("0 errors, 0 warnings")).toBe(false);
});

test("hidden folders named by a command remain discoverable in the tree", () => {
	const messages = [{ id: "1", role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", argumentsText: JSON.stringify({ command: "ls -la .assets .scratch; echo done" }) }] }] as UiMessage[];
	expect([...mentionedHiddenDirs(messages)]).toEqual([".assets", ".scratch"]);
});

test("source-number accents only apply to explicit numbered searches", () => {
	expect(hasSearchSourceNumbers('cd /tmp && rg -n "foo|bar" file.ts | head -20')).toBe(true);
	expect(hasSearchSourceNumbers('grep -rn pattern src')).toBe(true);
	expect(hasSearchSourceNumbers('rg pattern file.ts')).toBe(false);
	expect(hasSearchSourceNumbers('echo "12:34: log"; rg -n pattern file.ts')).toBe(false);
	expect(hasSearchSourceNumbers('rg -n pattern file.ts | sed s/x/y/')).toBe(false);
	expect(searchSourceNumberParts('123:    const x = 1;')).toEqual({ prefix: '', number: '123:', rest: '    const x = 1;' });
	expect(searchSourceNumberParts('src/file.ts:16:import x')).toEqual({ prefix: 'src/file.ts:', number: '16:', rest: 'import x' });
	expect(searchSourceNumberParts('ordinary output')).toBeNull();
});

test("numbered pipeline filters are recognized without changing ordinary numeric logs", () => {
	expect(hasNumberedPipelineOutput('cd /tmp && npm test 2>&1 | rg -n "Test Files|Tests |check:design" | head -3')).toBe(true);
	expect(hasNumberedPipelineOutput('npm test | grep -n passed')).toBe(true);
	expect(hasNumberedPipelineOutput('npm test | rg passed')).toBe(false);
	expect(hasNumberedPipelineOutput('echo "foo | rg -n bar"')).toBe(false);
	expect(hasNumberedPipelineOutput('npm test | rg -n passed; echo 3:plain')).toBe(false);
});
