import { describe, expect, it } from "vitest";
import { subagentProgressDetails } from "../../server/subagent-presentation.js";

function item(index = 0) {
	return {
		sourceId: `repository:${index}`,
		source: `Repository ${index}`,
		root: `/workspace/repository-${index}`,
		task: `Investigate area ${index}`,
		phase: "running",
		tool: "source_search",
	};
}

describe("subagentProgressDetails", () => {
	it("projects only the progress allowlist and discards malformed entries", () => {
		expect(subagentProgressDetails({ subagents: [
			{ ...item(), phase: "queued", tool: "source_read", secret: "not-forwarded", extra: { token: "not-forwarded" } },
			null,
			"running",
			{ ...item(1), sourceId: 42 },
			{ ...item(2), phase: "waiting" },
			{ ...item(3), tool: "bash" },
		] })).toEqual([
			{ ...item(), phase: "queued", tool: "source_read" },
			{ ...item(3), tool: undefined },
		].map(({ tool, ...entry }) => tool ? { ...entry, tool } : entry));
	});

	it("keeps an empty snapshot distinct from missing or malformed details", () => {
		expect(subagentProgressDetails({ subagents: [] })).toEqual([]);
		expect(subagentProgressDetails({})).toBeUndefined();
		expect(subagentProgressDetails({ subagents: {} })).toBeUndefined();
		expect(subagentProgressDetails(null)).toBeUndefined();
		expect(subagentProgressDetails("subagents")).toBeUndefined();
	});

	it("bounds the number and length of live metadata fields", () => {
		const long = {
			sourceId: "s".repeat(200),
			source: "n".repeat(300),
			root: "r".repeat(5000),
			task: "t".repeat(600),
			phase: "completed",
		};
		const result = subagentProgressDetails({ subagents: [long, ...Array.from({ length: 10 }, (_, index) => item(index + 1))] });
		expect(result).toHaveLength(8);
		expect(result?.[0]).toEqual({ sourceId: "s".repeat(160), source: "n".repeat(240), root: "r".repeat(4096), task: "t".repeat(500), phase: "completed" });
		expect(result?.at(-1)?.sourceId).toBe("repository:7");
	});
});
