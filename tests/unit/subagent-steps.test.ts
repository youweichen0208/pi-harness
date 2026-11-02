import { serializeMessage } from "../../server/serialize.js";
import { projectSubagentResults } from "../../server/subagents/results.js";
import type { SubagentResult } from "../../server/subagents/runner.js";
import { describe, expect, it } from "vitest";
import { subagentSteps } from "../../server/subagent-steps.js";
import { subagentProgressDetails } from "../../server/subagent-presentation.js";
import { subagentPresentation } from "../../web/src/subagent-presentation.js";
const step = { id: "read-1", tool: "source_read", target: "server/index.ts", status: "completed", durationMs: 12 };
describe("subagent execution timeline", () => {
	it("limits records and excludes outputs, arguments and invalid tools", () => {
		expect(subagentSteps([{...step,args:{secret:"never-forward"},output:"private"},{...step,tool:"bash"}])).toEqual([step]);
		expect(subagentSteps(Array.from({length:40},()=>step))).toHaveLength(32);
		expect(subagentSteps([{...step,durationMs:Infinity}])?.[0].durationMs).toBeUndefined();
	});
	it("retains live and historical steps across both projections", () => {
		const item = {sourceId:"repo:1",source:"Repo",root:"/repo",task:"Read",phase:"running",steps:[step]};
		const live=subagentProgressDetails({subagents:[item]});
		const args=JSON.stringify({action:"run",tasks:[{sourceId:"repo:1",task:"Read"}]});
		expect(subagentPresentation(args,"",live)?.items[0].steps).toEqual([step]);
		const output=JSON.stringify({results:[{...item,status:"completed",text:"Done",evidenceStatus:"unverified"}]});
		expect(subagentPresentation(args,output)?.items[0].steps).toEqual([step]);
	});
});

it("recovers cropped timelines from persisted white-listed metadata after a JSON round trip", () => {
	const results: SubagentResult[] = Array.from({ length: 8 }, (_, i) => ({
		sourceId: `repo:${i}`, source: "Repo", root: "/repo", task: "Read", status: "completed",
		text: "回答".repeat(6000), evidenceStatus: "unverified", durationMs: 12, truncated: false,
		steps: [{ id: `read-${i}`, tool: "source_read", status: "completed", durationMs: 12 }],
	}));
	const projected = projectSubagentResults(results);
	expect(projected.some(item => item.steps === undefined)).toBe(true);
	const message = serializeMessage({ role: "toolResult", toolCallId: "call-1", toolName: "subagent", timestamp: 1, isError: false,
		content: [{ type: "text", text: JSON.stringify({ results: projected }) }],
		details: JSON.parse(JSON.stringify({ subagents: results.map(item => ({ ...item, secret: "never-forward" })) })),
	}, 1)!;
	expect(message.details).toBeUndefined();
	expect(JSON.stringify(message)).not.toContain("never-forward");
	const restored = JSON.parse(JSON.stringify(message));
	const model = subagentPresentation('{"action":"run","scope":"workspace"}', restored.content[0].text, undefined, restored.subagents)!;
	expect(model.items.map(item => item.steps)).toEqual(results.map(item => item.steps));
	expect(model.final).toBe(true);
});

it("matches final steps by source occurrence within a call, without borrowing live or other source steps", () => {
	const base = { sourceId: "repo:1", source: "Repo", root: "/repo", task: "Read", phase: "completed" as const };
	const args = '{"action":"run","tasks":[]}';
	const output = JSON.stringify({ results: [base, base, { ...base, sourceId: "repo:2" }].map(item => ({ ...item, status: "completed", text: "Done", evidenceStatus: "unverified" })) });
	const saved = [1, 2].map(id => ({ ...base, steps: [{ id: `read-${id}`, tool: "source_read" as const, status: "completed" as const }] }));
	const model = subagentPresentation(args, output, [{ ...base, steps: saved[0].steps }], saved)!;
	expect(model.items.map(item => item.steps?.[0].id)).toEqual(["read-1", "read-2", undefined]);
	expect(saved).toHaveLength(2);
});
