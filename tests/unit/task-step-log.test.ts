import { expect, test } from "vitest";
import { displayPhasePath, phaseHeadline, phaseItems, phaseRecords, type ProgressPhase } from "../../web/src/task-progress-view.js";

const phase = (artifacts: { kind: string; label: string; path?: string }[], kind: ProgressPhase["kind"] = "read"): ProgressPhase => ({
	id: "p", kind, title: "读取文件", status: "done", startedAt: 0, endedAt: 400, counts: { read: 0, write: 0, edit: 0, command: 0 },
	steps: [{ id: "s", messageId: "m", title: "", status: "done", startedAt: 0, artifacts: artifacts.map((item, index) => ({ toolCallId: `t${index}`, ...item })) }],
});

test("step items show short file paths and compact commands once each", () => {
	expect(displayPhasePath("/repo/docs/ARCHITECTURE.md", "/repo")).toBe("docs/ARCHITECTURE.md");
	expect(displayPhasePath("/Users/me/.hermes/config.yaml", "/repo")).toBe("~/.hermes/config.yaml");
	expect(displayPhasePath("/Users/me/Downloads/deep/dir/hermes-api-server.md", "/repo")).toBe("hermes-api-server.md");
	const items = phaseItems(phase([
		{ kind: "read", label: "read", path: "/repo/package.json" },
		{ kind: "read", label: "read", path: "/repo/package.json" },
		{ kind: "bash", label: "cat /Users/alice/projects/app/config.json\necho done" },
	]), "/repo");
	expect(items.map(item => item.label)).toEqual(["package.json", "cat …/config.json"]);
	expect(items[1]).toMatchObject({ toolCallId: "t2", messageId: "m" });
});

test("read-only phases are titled by file count; mixed phases keep their title", () => {
	const reads = phase([{ kind: "read", label: "", path: "/repo/a.md" }, { kind: "read", label: "", path: "/repo/b.md" }, { kind: "read", label: "", path: "/repo/c.md" }]);
	expect(phaseHeadline(reads)).toBe("读取 3 个文件");
	expect(phaseHeadline(reads, "en")).toBe("Read 3 files");
	expect(phaseHeadline(phase([{ kind: "read", label: "", path: "/repo/a.md" }, { kind: "bash", label: "ls" }]))).toBe("读取 1 个文件 · 运行 1 条命令");
});

import { progressPhases } from "../../web/src/task-progress-view.js";
import type { TaskProgress, TaskStep } from "../../server/protocol.js";

const step = (id: string, status: TaskStep["status"], artifacts: TaskStep["artifacts"], title = "读取 2 项"): TaskStep => ({ id, messageId: id, title, status, startedAt: 0, endedAt: 1, artifacts });
const task = (steps: TaskStep[]): TaskProgress => ({ id: "t", conversationId: "c", sourceMessageId: "u", title: "", status: "done", startedAt: 0, completed: steps.length, steps });

test("a failure the agent moved past counts as done; the last unrecovered one stays failed", () => {
	const read = (id: string, status: TaskStep["status"]) => step(id, status, [{ toolCallId: id, kind: "read", label: "read", path: `/repo/${id}.md` }]);
	const recovered = progressPhases(task([read("a", "failed"), read("b", "done")]));
	expect(recovered.map(phase => phase.status)).toEqual(["done"]);
	const stuck = progressPhases(task([read("a", "done"), step("c", "failed", [{ toolCallId: "c", kind: "bash", label: "npm test" }], "运行测试")]));
	expect(stuck.at(-1)?.status).toBe("failed");
	expect(progressPhases(task([read("a", "done"), step("r", "running", [{ toolCallId: "r", kind: "bash", label: "npm test" }])])).at(-1)?.status).toBe("running");
});

test("generic step titles are rebuilt from what the phase did; same-named files show their folder", () => {
	const [phase] = progressPhases(task([step("a", "done", [
		{ toolCallId: "1", kind: "read", label: "", path: "/skills/grilling/SKILL.md" },
		{ toolCallId: "2", kind: "read", label: "", path: "/skills/domain-modeling/SKILL.md" },
		{ toolCallId: "3", kind: "bash", label: "cd /tmp && rm -rf grill-doc" },
	])]));
	expect(phaseHeadline(phase)).toBe("读取 2 个文件 · 运行 1 条命令");
	expect(phaseItems(phase, "/repo").map(item => item.label).slice(0, 2)).toEqual(["grilling/SKILL.md", "domain-modeling/SKILL.md"]);
	expect(phaseHeadline({ ...phase, title: "核对用户映射" })).toBe("核对用户映射");
});

test("the step record keeps every command and edit in order, untruncated", () => {
	const long = `rg -n "bash-group-head strong|strong \\{" web/src/styles.css | head -20 && npm run typecheck`;
	const steps: Parameters<typeof phaseRecords>[0] = [
		{ id: "a", messageId: "m1", title: "", status: "done", startedAt: 0, artifacts: [{ toolCallId: "c1", kind: "bash", label: "npm test" }] },
		{ id: "b", messageId: "m2", title: "", status: "failed", startedAt: 1, artifacts: [{ toolCallId: "c2", kind: "bash", label: "npm test" }] },
		{ id: "c", messageId: "m3", title: "", status: "done", startedAt: 2, artifacts: [
			{ toolCallId: "e1", kind: "edit", label: "styles.css", path: "/repo/web/src/styles.css" },
			{ toolCallId: "c3", kind: "bash", label: long },
		] },
	];
	const records = phaseRecords(steps, "/repo");
	// A rerun of the same command stays its own row instead of collapsing into one.
	expect(records.map(item => item.toolCallId)).toEqual(["c1", "c2", "e1", "c3"]);
	expect(records.map(item => item.messageId)).toEqual(["m1", "m2", "m3", "m3"]);
	expect(records[2]).toMatchObject({ label: "web/src/styles.css", path: "/repo/web/src/styles.css", kind: "edit" });
	expect(records[3].label).toBe(long);
	// Multiline commands read back as one line.
	expect(phaseRecords([{ id: "d", messageId: "m4", title: "", status: "done", startedAt: 0, artifacts: [{ toolCallId: "c4", kind: "bash", label: "git add -A &&\n  git commit -m x" }] }], "").at(0)?.label).toBe("git add -A && git commit -m x");
});
