import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SessionManager, type AgentSession, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSubagentExtension, type SubagentHost } from "../../server/subagents/extension.js";
import { TOOL_TEXT_CONTINUE_PROMPT } from "../../server/tool-text.js";
import type { SubagentSources } from "../../server/subagents/sources.js";
import type { SubagentJob, SubagentParent, SubagentProgress } from "../../server/subagents/runner.js";

const { readSubagentSources, runSubagents, subagentSettings, inspectSubagentSources } = vi.hoisted(() => ({ readSubagentSources: vi.fn(), runSubagents: vi.fn(), subagentSettings: vi.fn(), inspectSubagentSources: vi.fn() }));
vi.mock("../../server/subagents/sources.js", () => ({ readSubagentSources }));
vi.mock("../../server/subagents/runner.js", () => ({ runSubagents }));
vi.mock("../../server/subagents/settings.js", () => ({ subagentSettings }));
vi.mock("../../server/subagents/inspect.js", () => ({ inspectSubagentSources }));

const cwd = join(tmpdir(), "subagent-extension-fixture");
const repository = { id: "repository:fixture", name: "Orders", kind: "repository" as const, root: cwd };
let sources: SubagentSources;
let enabled: boolean;
let sessionManager: SessionManager;
let bound: SubagentHost | undefined;
let tool: ToolDefinition;
let events: Map<string, () => void>;

async function register() {
	await createSubagentExtension(() => bound)({
		registerTool: (registered: ToolDefinition) => { tool = registered; },
		on: (name: string, handler: () => void) => { events.set(name, handler); },
	} as unknown as ExtensionAPI);
	return tool;
}

beforeEach(async () => {
	enabled = true;
	sources = { workspace: { id: "team", name: "Team" }, workspaces: [{ id: "team", name: "Team" }], sources: [repository] };
	readSubagentSources.mockReset().mockImplementation(() => sources);
	subagentSettings.mockReset().mockImplementation(() => ({ enabled, version: "fixture" }));
	runSubagents.mockReset().mockImplementation(async (jobs: SubagentJob[]) => jobs.map(job => ({ sourceId: job.source.id, source: job.source.name, root: job.source.root, task: job.task, status: "completed", text: "README.md:1 fixture evidence", evidenceStatus: "unverified", durationMs: 1, truncated: false })));
	inspectSubagentSources.mockReset().mockResolvedValue([{ sourceId: repository.id, status: "completed", entries: ["README.md"] }]);
	sessionManager = SessionManager.inMemory(cwd);
	sessionManager.appendMessage({ role: "user", content: "How do orders flow?", timestamp: Date.now() });
	bound = { agentDir: join(cwd, "agent"), workspaceId: "team", session: { model: { id: "fixture-model" }, thinkingLevel: "off", modelRuntime: { fixture: true } } as unknown as AgentSession };
	events = new Map();
	await register();
});

function tasks(count: number) { return Array.from({ length: count }, (_, index) => ({ sourceId: repository.id, task: `Investigate area ${index}` })); }

function execute(args: Record<string, unknown>, signal?: AbortSignal, update?: Parameters<ToolDefinition["execute"]>[3]) {
	return tool.execute("test", args, signal, update, { cwd, sessionManager } as unknown as ExtensionToolContext);
}

describe("subagent extension admission and request lifecycle", () => {
	test("listing sources needs no parent model and creates no child runs", async () => {
		bound = undefined;
		const result = await execute({ action: "sources", workspaceId: "chosen" });
		expect(result.content).toEqual([{ type: "text", text: JSON.stringify(sources, null, 2) }]);
		expect(readSubagentSources).toHaveBeenCalledWith(cwd, "chosen");
		expect(runSubagents).not.toHaveBeenCalled();
	});

	test("inspection reads selected sources without a model or child budget and isolates source admission", async () => {
		bound = undefined;
		const result = await execute({ action: "inspect", sourceIds: [repository.id, repository.id] });
		expect(JSON.parse(String(result.content[0].type === "text" && result.content[0].text))).toMatchObject({ workspace: { id: "team" }, inspections: [{ sourceId: repository.id }] });
		expect(inspectSubagentSources).toHaveBeenCalledWith([repository], expect.any(AbortSignal));
		expect(runSubagents).not.toHaveBeenCalled();
		for (const sourceIds of [[], Array(9).fill(repository.id), ["repository:other"]]) {
			await expect(execute({ action: "inspect", sourceIds })).rejects.toThrow();
		}
		expect(inspectSubagentSources).toHaveBeenCalledTimes(1);
		sources = { ...sources, issue: "ambiguous_workspace" };
		await expect(execute({ action: "inspect", sourceIds: [repository.id] })).rejects.toThrow(/ambiguous_workspace/);
		expect(inspectSubagentSources).toHaveBeenCalledTimes(1);
	});

	test("inspection observes cancellation and does not consume the research request budget", async () => {
		const controller = new AbortController();
		await execute({ action: "inspect", sourceIds: [repository.id] }, controller.signal);
		const signal = inspectSubagentSources.mock.calls[0][1] as AbortSignal;
		controller.abort(); expect(signal.aborted).toBe(true);
		await execute({ action: "run", tasks: tasks(8) });
		await execute({ action: "run", tasks: tasks(4) });
		expect(runSubagents).toHaveBeenCalledTimes(2);
	});

	test("refreshes source membership and rejects stale or ambiguous workspace selections", async () => {
		await execute({ action: "sources" });
		sources = { ...sources, sources: [] };
		await expect(execute({ action: "run", tasks: tasks(1) })).rejects.toThrow(/no longer available/);
		sources = { ...sources, issue: "workspace_mismatch", sources: [repository] };
		await expect(execute({ action: "run", workspaceId: "unrelated", tasks: tasks(1) })).rejects.toThrow(/workspace_mismatch/);
		expect(readSubagentSources).toHaveBeenLastCalledWith(cwd, "unrelated");
		expect(runSubagents).not.toHaveBeenCalled();
	});

	test("rejects batches above eight without consuming the twelve-child request budget", async () => {
		await expect(execute({ action: "run", tasks: tasks(9) })).rejects.toThrow(/batch limit.*8/);
		await expect(execute({ action: "run", tasks: [{ sourceId: repository.id, task: "  " }] })).rejects.toThrow(/concrete task/);
		expect(runSubagents).not.toHaveBeenCalled();
		await execute({ action: "run", tasks: tasks(8) });
		await execute({ action: "run", tasks: tasks(4) });
		await expect(execute({ action: "run", tasks: tasks(1) })).rejects.toThrow(/request budget.*12/);
		expect(runSubagents).toHaveBeenCalledTimes(2);
	});

	test("automatic continuation does not reset the request budget, while the next real user entry does", async () => {
		await execute({ action: "run", tasks: tasks(8) });
		await execute({ action: "run", tasks: tasks(4) });
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: TOOL_TEXT_CONTINUE_PROMPT }], timestamp: Date.now() });
		await expect(execute({ action: "run", tasks: tasks(1) })).rejects.toThrow(/request budget/);
		sessionManager.appendMessage({ role: "user", content: "Now investigate invoicing", timestamp: Date.now() });
		await execute({ action: "run", tasks: tasks(8) });
		expect(runSubagents).toHaveBeenCalledTimes(3);
	});

	test("disabled execution is rejected immediately and registration hides the tool", async () => {
		enabled = false;
		await expect(execute({ action: "sources" })).rejects.toThrow(/disabled/);
		await expect(execute({ action: "run", tasks: tasks(1) })).rejects.toThrow(/disabled/);
		expect(readSubagentSources).not.toHaveBeenCalled();
		expect(runSubagents).not.toHaveBeenCalled();
		expect((await register()).exposure).toBe("hidden");
	});

	test("forwards the selected model/runtime and binds caller/session cancellation to children", async () => {
		const signals: AbortSignal[] = [];
		runSubagents.mockImplementation(async (_jobs: SubagentJob[], parent: SubagentParent, signal: AbortSignal, update: (next: SubagentProgress) => void) => {
			expect(parent.model).toBe(bound!.session.model);
			expect(parent.modelRuntime).toBe(bound!.session.modelRuntime);
			expect(parent.thinkingLevel).toBe("off");
			signals.push(signal); update({ index: 0, phase: "running", tool: "source_search" });
			return [];
		});
		const abort = new AbortController(), update = vi.fn();
		await execute({ action: "run", tasks: tasks(1) }, abort.signal, update);
		expect(update).toHaveBeenCalledWith(expect.objectContaining({
			content: [{ type: "text", text: expect.stringContaining("Orders: running · source_search") }],
			details: { subagents: [{ sourceId: repository.id, source: "Orders", root: cwd, task: "Investigate area 0", phase: "running", tool: "source_search" }] },
		}));
		abort.abort(); expect(signals[0].aborted).toBe(true);
		await execute({ action: "run", tasks: tasks(1) });
		events.get("session_shutdown")!(); expect(signals[1].aborted).toBe(true);
		events.get("session_start")!();
		await execute({ action: "run", tasks: tasks(1) });
		expect(signals[2].aborted).toBe(false);
	});
});
