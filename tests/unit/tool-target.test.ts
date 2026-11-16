import { expect, test } from "vitest";
import type { UiMessage, UiToolCallBlock } from "../../server/protocol.js";
import { deriveTaskProgress } from "../../server/task-progress.js";
import { editWriteChange } from "../../web/src/edit-write-presentation.js";
import { taskOutputs } from "../../web/src/task-outputs.js";

function fixture(path: string) {
	const call: UiToolCallBlock = { type: "toolCall", id: "device-call", name: "write", argumentsText: JSON.stringify({ path, content: '{"a":2,"b":3}' }) };
	const messages: UiMessage[] = [
		{ id: "u", role: "user", content: [{ type: "text", text: "Call MCP" }] },
		{ id: "a", role: "assistant", content: [call] },
		{ id: "r", role: "toolResult", toolCallId: call.id, isError: false, content: [{ type: "text", text: "5" }] },
	];
	return { call, messages };
}

test("OMP device writes remain tools, never file diffs or changed-file artifacts", () => {
	const { call, messages } = fixture("xd://mcp__fixture_add");
	const before = structuredClone(messages);
	expect(editWriteChange(call, messages[2])).toBeNull();
	const task = deriveTaskProgress("conversation", messages, null, false);
	expect(task?.steps[0].artifacts[0].path).toBeUndefined();
	expect(task?.steps[0].artifacts[0].label).toBe("xd://mcp__fixture_add");
	expect(taskOutputs(task, messages, "/repo")).toEqual([]);
	expect(messages).toEqual(before);
});

test("ordinary and Windows file writes retain change presentation", () => {
	for (const path of ["src/example.ts", "C:\\project\\example.ts", "C://project/example.ts", "/repo/example.ts"]) {
		const { call, messages } = fixture(path);
		expect(editWriteChange(call, messages[2])?.path).toBe(path);
		const task = deriveTaskProgress("conversation", messages, null, false);
		expect(task?.steps[0].artifacts[0].path).toBe(path);
		expect(taskOutputs(task, messages, "/repo")).toHaveLength(1);
	}
});
