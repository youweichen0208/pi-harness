import { expect, test } from "vitest";
import type { PlanSnapshot, UiMessage } from "../../server/protocol.js";
import { deriveTaskProgress } from "../../server/task-progress.js";

const user = (id: string, text: string): UiMessage => ({ id, role: "user", timestamp: 100, content: [{ type: "text", text }] });
const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, argumentsText: JSON.stringify(args) });

test("a numeric option reply keeps the task intent and never invents a todo plan", () => {
	const messages: UiMessage[] = [user("u1", "实现预算校验并验证"), user("u2", "1"), { id: "a", role: "assistant", content: [{ type: "text", text: "工作区干净。" }, call("r", "read", { path: "README.md" })] }];
	const task = deriveTaskProgress("c", messages, null, true);
	expect(task?.title).toBe("实现预算校验并验证");
	expect(task?.plan).toBeUndefined();
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

test("explicit plan revisions keep added and removed steps visible", () => {
	const first = { steps: [{ id: "read", title: "读取约定" }, { id: "build", title: "实现服务" }, { id: "test", title: "运行测试" }], currentStepId: "read" };
	const revised = { steps: [{ id: "read", title: "读取约定" }, { id: "build", title: "实现服务" }, { id: "migration", title: "补迁移" }], currentStepId: "build", completedStepIds: ["read"] };
	const messages: UiMessage[] = [user("u", "完成服务实现"), { id: "a1", role: "assistant", timestamp: 110, content: [call("p1", "task_plan", first)] }, { id: "r1", role: "toolResult", timestamp: 111, toolCallId: "p1", content: [{ type: "text", text: "Plan recorded" }] }, { id: "a2", role: "assistant", timestamp: 120, content: [call("p2", "task_plan", revised), call("b1", "bash", { command: "npm test" })] }];
	const task = deriveTaskProgress("c", messages, null, true);
	expect(task?.plan).toMatchObject({ revision: 2, added: 1, removed: 1 });
	expect(task?.plan?.items.map(({ id, status, added }) => [id, status, !!added])).toEqual([["read", "done", false], ["build", "running", false], ["migration", "pending", true], ["test", "removed", false]]);
	expect(task?.steps.flatMap((step) => step.artifacts.map((item) => item.kind))).toEqual(["bash"]);
});

test("outline metadata and changes persist while tool ownership follows transcript order", () => {
	const steps = [{ id: "read", title: "读取约定" }, { id: "build", title: "实现服务", detail: "Add service and tests" }, { id: "test", title: "运行测试" }];
	const plan = { title: "接入子进程", completionCriteria: "真实子进程可用且测试通过", steps, currentStepId: "read" };
	const messages: UiMessage[] = [user("u", "实现服务"), { id: "a", role: "assistant", timestamp: 110, content: [call("p1", "task_plan", plan), call("read1", "read", { path: "README.md" }), call("p2", "task_plan", { ...plan, currentStepId: "build", completedStepIds: ["read"] }), call("write1", "write", { path: "service.ts" })] }];
	let task = deriveTaskProgress("c", messages, null, true)!;
	expect(task.plan).toMatchObject({ title: plan.title, completionCriteria: plan.completionCriteria });
	expect(task.plan!.items[0].toolCallIds).toEqual(["read1"]);
	expect(task.plan!.items[1]).toMatchObject({ toolCallIds: ["write1"], detail: "Add service and tests", actions: { write: 1, read: 0 } });
	const revised = { ...plan, steps: [...steps.slice(0, 2), { id: "schema", title: "修正校验" }, steps[2]], currentStepId: "schema", completedStepIds: ["read", "build"] };
	messages.push({ id: "a2", role: "assistant", timestamp: 120, content: [call("p3", "task_plan", { ...revised, changeSummary: "新增校验步骤" })] });
	messages.push({ id: "a3", role: "assistant", timestamp: 130, content: [call("p4", "task_plan", { ...revised, currentStepId: "test", completedStepIds: ["read", "build", "schema"] })] });
	task = deriveTaskProgress("c", messages, null, true)!;
	expect(task.plan).toMatchObject({ changeSummary: "新增校验步骤", changes: [{ kind: "added", position: 3, title: "修正校验" }] });
	messages.push({ id: "error", role: "toolResult", toolCallId: "p3", isError: true, content: [] }, { id: "error2", role: "toolResult", toolCallId: "p4", isError: true, content: [] });
	expect(deriveTaskProgress("c", messages, null, true)!.plan!.items).toHaveLength(3);
});


test("an unresolved plan validation error cannot turn successful commands into a completed task", () => {
	const messages: UiMessage[] = [user("u", "Finish implementation"),
		{ id: "a", role: "assistant", content: [call("bash", "bash", { command: "git diff --check" }), call("plan", "plan", { action: "update", status: "completed" })] },
		{ id: "rb", role: "toolResult", toolCallId: "bash", content: [{ type: "text", text: "" }] },
		{ id: "rp", role: "toolResult", toolCallId: "plan", isError: true, content: [{ type: "text", text: "steps is required" }] },
	];
	expect(deriveTaskProgress("c", messages, null, true)?.status).toBe("running");
	expect(deriveTaskProgress("c", messages, null, false)?.status).toBe("failed");
	expect(deriveTaskProgress("c", [messages[0], { ...messages[1], content: [call("plan", "plan", {})] }, messages[3]], null, false)?.status).toBe("failed");
});

const snapshot = (overrides: Partial<PlanSnapshot>): PlanSnapshot => ({ schemaVersion: 3, planId: "p1", revision: 1, status: "active", title: "接入服务", steps: [{ id: "s1", title: "读取约定" }, { id: "s2", title: "实现服务" }], currentStepId: "s1", completedStepIds: [], completionCriteria: "测试通过", changes: [], ...overrides });
const planTurn = (final: PlanSnapshot, outcome: "ok" | "error", calls: { id: string; name: string }[]): UiMessage[] => [user("u", "完成服务实现"),
	{ id: "a1", role: "assistant", timestamp: 110, content: [call("p1", "plan", { action: "create" }), call("w1", "write", { path: "README.md", content: "x" })] },
	{ id: "r1", role: "toolResult", toolCallId: "p1", timestamp: 111, planSnapshot: snapshot({}), content: [{ type: "text", text: "Plan p1, revision 1: active." }] },
	{ id: "r2", role: "toolResult", toolCallId: "w1", timestamp: 112, content: [{ type: "text", text: "done" }] },
	{ id: "a3", role: "assistant", timestamp: 130, content: [call("p2", "plan", { action: "update" }), ...calls.map(({ id, name }) => call(id, name, name === "bash" ? { command: "npm test" } : { path: "service.ts", content: "x" }))] },
	{ id: "r3", role: "toolResult", toolCallId: "p2", timestamp: 131, planSnapshot: final, content: [{ type: "text", text: `Plan p1, revision ${final.revision}: ${final.status}.` }] },
	{ id: "r4", role: "toolResult", toolCallId: "b1", timestamp: 141, ...(outcome === "error" ? { isError: true } : {}), content: [{ type: "text", text: outcome === "error" ? "exit 1" : "48 passed" }] }];

test("issue #63: the projection never infers completion — only a plan call closes the plan", () => {
	// The settle reminder asks the model to close the plan; a model pausing
	// for the user may leave it active, and the panel must reflect that.
	const messages = planTurn(snapshot({ revision: 2, currentStepId: "s2", completedStepIds: ["s1"] }), "ok", [{ id: "b1", name: "bash" }]);
	const task = deriveTaskProgress("c", messages, null, false)!;
	expect(task.status).toBe("waiting");
	expect(task.plan?.status).toBe("active");
	expect(task.plan?.items.map((item) => item.status)).toEqual(["done", "running"]);
});

test("a settled call that never received a result concludes its step as failed, not done", () => {
	const messages: UiMessage[] = [user("u", "跑测试"), { id: "a1", role: "assistant", timestamp: 110, stopReason: "error", content: [call("b1", "bash", { command: "npm test" })] }];
	const step = deriveTaskProgress("c", messages, null, false)!.steps[0];
	expect(step.status).toBe("failed");
	expect(step.hint).toBe("有工具未执行");
	expect(deriveTaskProgress("c", messages, null, true)!.steps[0].status).toBe("running");
});

test("issue #63: a failed attributed call keeps the active plan waiting", () => {
	const messages = planTurn(snapshot({ revision: 2, currentStepId: "s2", completedStepIds: ["s1"] }), "error", [{ id: "b1", name: "bash" }]);
	const task = deriveTaskProgress("c", messages, null, false)!;
	expect(task.status).toBe("failed");
	expect(task.plan?.status).toBe("active");
	expect(task.plan?.items.map((item) => item.status)).toEqual(["done", "running"]);
});

test("issue #63: a running step without attributed calls cannot be inferred complete", () => {
	const messages = planTurn(snapshot({ revision: 2, currentStepId: "s2", completedStepIds: ["s1"] }), "ok", []);
	const task = deriveTaskProgress("c", messages, null, false)!;
	expect(task.status).toBe("waiting");
	expect(task.plan?.status).toBe("active");
	expect(task.plan?.items.map((item) => item.status)).toEqual(["done", "running"]);
});
