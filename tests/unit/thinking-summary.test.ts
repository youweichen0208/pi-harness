import { describe, expect, it } from "vitest";
import { readableThinkingSummary } from "../../web/src/thinking-summary.js";

describe("readableThinkingSummary", () => {
	it("uses the latest readable line and removes list decoration", () => {
		expect(readableThinkingSummary("先核对现状。\n- 已完成消息快照分析，检查状态同步机制。\n")).toBe("已完成消息快照分析，检查状态同步机制。");
	});

	it("keeps readable English sentences", () => {
		expect(readableThinkingSummary("Check the current state")).toBe("Check the current state");
	});

	it("omits commands, paths, data and code", () => {
		for (const thinking of ["npm run build", "server/thinking-timing.ts", '{"status":"running"}', "const elapsed = 6;", "tool_execution_end"]) {
			expect(readableThinkingSummary(thinking)).toBeNull();
		}
	});

	it("does not fall back to an older line when the latest line is technical", () => {
		expect(readableThinkingSummary("已完成策略分析。\nrg -n timing server")).toBeNull();
	});
});
