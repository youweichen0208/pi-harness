import { describe, expect, test, it } from "vitest";
import type { TaskProgress, UiMessage } from "../../server/protocol.js";
import { outputPath, taskOutputs } from "../../web/src/task-outputs.js";

function fixture() {
	const messages: UiMessage[] = [];
	const task: TaskProgress = { id: "task", conversationId: "c", sourceMessageId: "u", title: "task", status: "running", startedAt: 1, completed: 0, steps: [] };
	const add = (id: string, kind: string, path: string, error = false, completed = true) => {
		messages.push({ id: `a-${id}`, role: "assistant", content: [{ type: "toolCall", id, name: kind, argumentsText: JSON.stringify({ path, oldText: "old", newText: "new\nline", content: "replacement" }) }] });
		if (completed) messages.push({ id: `r-${id}`, role: "toolResult", toolCallId: id, isError: error, content: [] });
		task.steps.push({ id, messageId: `a-${id}`, title: kind, status: "done", startedAt: 1, artifacts: [{ toolCallId: id, kind, path, label: path }] });
	};
	return { task, messages, add };
}

test("empty and read-only tasks have no outputs", () => {
	const { task, messages, add } = fixture();
	expect(taskOutputs(null, messages, "/repo")).toEqual([]);
	add("read", "read", "file.ts"); add("bash", "bash", "file.ts");
	expect(taskOutputs(task, messages, "/repo")).toEqual([]);
});

test("successful edits merge path aliases and count each tool ID once", () => {
	const { task, messages, add } = fixture();
	add("one", "edit", "/repo/src/a.ts"); add("two", "edit", "./src/other/../a.ts");
	task.steps.push(task.steps[0]);
	add("failed", "edit", "src/a.ts", true); add("pending", "write", "pending.ts", false, false);
	add("outside-task", "write", "old.ts"); task.steps.pop();
	expect(taskOutputs(task, messages, "/repo")).toEqual([{ path: "src/a.ts", added: 4, removed: 2, counted: true }]);
});

test("writes are outputs but content length and truncated diffs are not reliable change totals", () => {
	const { task, messages, add } = fixture();
	add("write", "write", "a.ts"); add("edit", "edit", "b.ts");
	messages.at(-1)!.details = { diff: "+1 new", diffTruncated: true };
	expect(taskOutputs(task, messages, "/repo")).toEqual([
		{ path: "a.ts", added: 0, removed: 0, counted: false },
		{ path: "b.ts", added: 0, removed: 0, counted: false },
	]);
});

describe("outputPath", () => {
	const cwd = "/Users/me/project";

	it("strips the workspace prefix so the card shows what identifies the file", () => {
		expect(outputPath("/Users/me/project/docs/ui-design.md", cwd)).toBe("docs/ui-design.md");
		expect(outputPath("/Users/me/project/web/src/styles.css", cwd)).toBe("web/src/styles.css");
	});

	it("leaves paths outside the workspace absolute, since relativising them would lie", () => {
		expect(outputPath("/Users/other/x.ts", cwd)).toBe("/Users/other/x.ts");
		expect(outputPath("/etc/hosts", cwd)).toBe("/etc/hosts");
	});

	it("already-relative paths pass through unchanged", () => {
		expect(outputPath("docs/a.md", cwd)).toBe("docs/a.md");
	});

	it("normalises lexical aliases without touching the filesystem", () => {
		expect(outputPath("/Users/me/project/../project/a.ts", cwd)).toBe("a.ts");
		expect(outputPath("/Users/me/project/./a.ts", cwd)).toBe("a.ts");
	});

	it("does not treat a sibling directory with a shared prefix as inside the workspace", () => {
		// `/Users/me/project-old` starts with `/Users/me/project` but is a different tree.
		expect(outputPath("/Users/me/project-old/a.ts", cwd)).toBe("/Users/me/project-old/a.ts");
	});
});
