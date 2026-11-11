import { expect, test } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { deriveTaskProgress } from "../../server/task-progress.js";

const user = (id: string, text: string): UiMessage => ({ id, role: "user", timestamp: 100, content: [{ type: "text", text }] });
const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, argumentsText: JSON.stringify(args) });

test("a numeric option reply keeps the task intent and never invents a todo plan", () => {
	const messages: UiMessage[] = [user("u1", "实现预算校验并验证"), user("u2", "1"), { id: "a", role: "assistant", content: [{ type: "text", text: "工作区干净。" }, call("r", "read", { path: "README.md" })] }];
	const task = deriveTaskProgress("c", messages, null, true);
	expect(task?.title).toBe("实现预算校验并验证");
});

test("server groups narrative and adjacent tools into a stable current step", () => {
	const messages: UiMessage[] = [user("u1", "搭建 API、worker 和 budget 模块"),
		{ id: "a1", role: "assistant", timestamp: 110, content: [{ type: "text", text: "开始搭建三个模块的入口。" }, call("w1", "write", { path: "api/main.py", content: "a" }), call("w2", "write", { path: "worker/main.py", content: "b" })] },
		{ id: "r1", role: "toolResult", toolCallId: "w1", content: [{ type: "text", text: "done" }] },
	];
	const running = deriveTaskProgress("c1", messages, null, true);
	expect(running?.title).toBe("搭建 API、worker 和 budget 模块");
	expect(running?.steps[0]).toMatchObject({ id: "a1:0", title: "开始搭建三个模块的入口", status: "running" });
	expect(running?.steps[0].artifacts.map((item) => item.label)).toEqual(["api/main.py", "worker/main.py"]);
	const done = deriveTaskProgress("c1", [...messages, { id: "r2", role: "toolResult", toolCallId: "w2", content: [{ type: "text", text: "done" }] }], null, false);
	expect(done?.completed).toBe(1);
	expect(done?.status).toBe("done");
});

test("failed tool, cancellation and a new user turn have distinct outcomes", () => {
	const messages: UiMessage[] = [user("u1", "旧任务"), { id: "a1", role: "assistant", content: [call("b1", "bash", { command: "npm test" })] }, { id: "r1", role: "toolResult", toolCallId: "b1", isError: true, content: [{ type: "text", text: "exit 1" }] }];
	expect(deriveTaskProgress("c1", messages, null, false)?.status).toBe("failed");
	expect(deriveTaskProgress("c1", [...messages, user("u2", "新任务")], null, true)).toBeNull();
	expect(deriveTaskProgress("c1", [...messages, { id: "a2", role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "stopped" }] }], null, false)?.status).toBe("cancelled");
	expect(deriveTaskProgress("c1", [...messages, { id: "a3", role: "assistant", content: [call("b2", "bash", { command: "npm test" })] }, { id: "r2", role: "toolResult", toolCallId: "b2", content: [{ type: "text", text: "48 passed" }] }], null, false)?.status).toBe("done");
});

test("plain chat has no task; a short follow-up keeps the previous task name once a tool runs", () => {
	const messages: UiMessage[] = [user("u1", "完成 S02b 主体实现"), { id: "a1", role: "assistant", timestamp: 120, content: [{ type: "text", text: "好的" }] }, user("u2", "可以帮我继续吗"), { id: "a2", role: "assistant", timestamp: 140, content: [call("b1", "bash", { command: "pwd && ls -la" })] }, { id: "r2", role: "toolResult", timestamp: 150, toolCallId: "b1", content: [{ type: "text", text: "file-a\nfile-b\n" }] }, { id: "a3", role: "assistant", timestamp: 160, content: [{ type: "text", text: "完成。" }] }];
	expect(deriveTaskProgress("c1", messages.slice(0, 2), null, false)).toBeNull();
	const task = deriveTaskProgress("c1", messages, null, false);
	expect(task?.title).toBe("完成 S02b 主体实现");
	expect(task?.endedAt).toBe(160);
	expect(deriveTaskProgress("c1", messages, null, false, 190)?.endedAt).toBe(190);
	expect(task?.steps).toHaveLength(1);
	expect(task?.steps[0].artifacts[0]).toMatchObject({ label: "pwd && ls -la", outputLines: 2 });
});

test("vague next-step request inherits the previous substantive task title", () => {
	const messages: UiMessage[] = [user("u1", "S02b 主体实现"), { id: "a1", role: "assistant", content: [{ type: "text", text: "上一轮已完成主体模块。" }] }, user("u2", "可以开始下一步吗"), { id: "a2", role: "assistant", content: [call("b1", "bash", { command: "pytest tests/test_jobs.py" })] }];
	expect(deriveTaskProgress("c1", messages, null, true)?.title).toBe("S02b 主体实现");
});

test("vague request without previous task falls back to the first concrete action", () => {
	const messages: UiMessage[] = [user("u1", "可以开始下一步吗"), { id: "a1", role: "assistant", content: [{ type: "text", text: "读取进度与测试约定" }, call("r1", "read", { path: "docs/progress.md" })] }];
	expect(deriveTaskProgress("c1", messages, null, true)?.title).toBe("读取进度与测试约定");
});

test("a greeting does not become the inherited task name", () => {
	const messages: UiMessage[] = [user("u0", "hello"), { id: "a0", role: "assistant", content: [{ type: "text", text: "Hi" }] }, user("u1", "可以开始下一步吗"), { id: "a1", role: "assistant", content: [{ type: "text", text: "读取进度与测试约定" }, call("r1", "read", { path: "docs/progress.md" })] }];
	expect(deriveTaskProgress("c1", messages, null, true)?.title).toBe("读取进度与测试约定");
});

test("a running turn keeps a pending step between completed tools and the next model response", () => {
	const messages: UiMessage[] = [user("u1", "生成文件"), { id: "a1", role: "assistant", content: [call("w1", "write", { path: "a.txt", content: "a" })] }, { id: "r1", role: "toolResult", toolCallId: "w1", content: [{ type: "text", text: "done" }] }];
	const progress = deriveTaskProgress("c1", messages, null, true);
	expect(progress?.steps.map((step) => step.status)).toEqual(["done", "running"]);
	expect(progress?.steps[1].messageId).toBe("a1");
	expect(progress?.status).toBe("running");
	expect(progress?.endedAt).toBeUndefined();
	expect(deriveTaskProgress("c1", messages, null, false, 200)?.status).toBe("done");
});


test("a settled call that never received a result concludes its step as failed, not done", () => {
	const messages: UiMessage[] = [user("u", "跑测试"), { id: "a1", role: "assistant", timestamp: 110, stopReason: "error", content: [call("b1", "bash", { command: "npm test" })] }];
	const step = deriveTaskProgress("c", messages, null, false)!.steps[0];
	expect(step.status).toBe("failed");
	expect(step.hint).toBe("有工具未执行");
	expect(deriveTaskProgress("c", messages, null, true)!.steps[0].status).toBe("running");
});

test("a failure the agent retried or worked around does not fail the turn", () => {
	// The screenshot case: 4 steps, step 1 fails, step 2 succeeds, step 3 fails,
	// then step 4 runs an exit command that succeeds. The turn ends on success.
	const messages: UiMessage[] = [user("u1", "优化任务面板"),
		{ id: "a1", role: "assistant", timestamp: 110, content: [call("b1", "bash", { command: "sed -n 1,60p missing.ts" })] },
		{ id: "r1", role: "toolResult", timestamp: 111, toolCallId: "b1", isError: true, content: [{ type: "text", text: "No such file" }] },
		{ id: "a2", role: "assistant", timestamp: 120, content: [call("b2", "bash", { command: "rg -n table web/src" })] },
		{ id: "r2", role: "toolResult", timestamp: 121, toolCallId: "b2", content: [{ type: "text", text: "found" }] },
		{ id: "a3", role: "assistant", timestamp: 130, content: [call("b3", "bash", { command: "npm test" })] },
		{ id: "r3", role: "toolResult", timestamp: 131, toolCallId: "b3", isError: true, content: [{ type: "text", text: "failed" }] },
		{ id: "a4", role: "assistant", timestamp: 140, content: [call("b4", "bash", { command: "echo exit 0" })] },
		{ id: "r4", role: "toolResult", timestamp: 141, toolCallId: "b4", content: [{ type: "text", text: "exit 0" }] },
	];
	// Step 4 is the latest completed group and it succeeded, so the turn is done
	// even though steps 1 and 3 failed on the way here.
	expect(deriveTaskProgress("c1", messages, null, false)?.status).toBe("done");
});

test("a turn that ends on an unrecovered failure stays failed", () => {
	const messages: UiMessage[] = [user("u1", "跑测试"),
		{ id: "a1", role: "assistant", timestamp: 110, content: [call("b1", "bash", { command: "ls" })] },
		{ id: "r1", role: "toolResult", timestamp: 111, toolCallId: "b1", content: [{ type: "text", text: "ok" }] },
		{ id: "a2", role: "assistant", timestamp: 120, content: [call("b2", "bash", { command: "npm test" })] },
		{ id: "r2", role: "toolResult", timestamp: 121, toolCallId: "b2", isError: true, content: [{ type: "text", text: "exit 1" }] },
	];
	expect(deriveTaskProgress("c1", messages, null, false)?.status).toBe("failed");
});
