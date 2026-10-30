import { describe, expect, test } from "vitest";
import { projectSubagentResults, SUBAGENT_RESULT_LIMITS } from "../../server/subagents/results.js";
import type { SubagentResearchReport } from "../../server/subagents/report.js";
import type { SubagentResult } from "../../server/subagents/runner.js";

function report(): SubagentResearchReport {
	return {
		summary: "Orders request refunds from billing.", checkedAt: "2026-10-25T01:02:03.000Z",
		findings: [{ kind: "implementation", statement: "Orders call the refund endpoint.", citations: [{ evidenceId: "ev1", path: "src/refund.ts", startLine: 2, endLine: 2, sha256: "a".repeat(64), excerpt: 'await billing.refund(orderId);' }] }],
		connections: ["billing: POST /refund"], openQuestions: ["Verify billing's refund response."],
	};
}

function result(index = 0): SubagentResult {
	return { sourceId: `repository:${index}`, source: `Repository ${index}`, root: `/workspace/repo-${index}`, task: "Investigate refunds", status: "completed", text: "Orders use billing refunds.", truncated: false, durationMs: 10,
		evidenceStatus: "checked", report: report(), usage: { input: 12, output: 34, cacheRead: 56, cacheWrite: 78, cost: 0.1 } };
}

function evidenceHeavyResult(index = 0, findingCount = 8): SubagentResult {
	const item = result(index);
	item.report!.findings = Array.from({ length: findingCount }, (_, finding) => ({
		...report().findings[0],
		citations: [{ ...report().findings[0].citations[0], evidenceId: `evidence-${finding}`, startLine: 1, endLine: 85, excerpt: "await billing.refund(orderId);\n".repeat(85).trimEnd() }],
	}));
	return item;
}

describe("bounded parent subagent results", () => {
	test("preserves small results, exact evidence and originals", () => {
		const original = result();
		const output = projectSubagentResults([original]);
		expect(output).toEqual([original]);
		expect(output[0]).not.toBe(original);
		expect(output[0].report).not.toBe(original.report);
	});

	test("clipping an echoed task does not claim the failed report was truncated", () => {
		const original: SubagentResult = { ...result(), task: "调查任务".repeat(150), status: "failed", text: "Error: This operation was aborted", report: undefined, evidenceStatus: "unverified" };
		const [output] = projectSubagentResults([original]);
		expect(Array.from(output.task)).toHaveLength(240);
		expect(output.text).toBe(original.text);
		expect(output.truncated).toBe(false);
		expect(output.outputTruncated).toBeUndefined();
		expect(output.evidenceWarning).toBeUndefined();
		expect(original.task).toHaveLength(600);
	});

	test("preserves a near-limit structured report when the whole batch fits", () => {
		const original = evidenceHeavyResult();
		original.text = "Refunds follow the documented order and payment flow. ".repeat(24);
		const reportBytes = Buffer.byteLength(JSON.stringify(original.report));
		expect(reportBytes).toBeGreaterThan(23 * 1024);
		expect(reportBytes).toBeLessThanOrEqual(24 * 1024);
		const before = structuredClone(original);
		expect(projectSubagentResults([original])).toEqual([original]);
		expect(original).toEqual(before);
	});

	test("shares the total budget across uneven reports without removing evidence", () => {
		const inputs = [evidenceHeavyResult(0), evidenceHeavyResult(1, 4), ...Array.from({ length: 6 }, (_, index) => result(index + 2))];
		expect(Buffer.byteLength(JSON.stringify({ results: inputs }))).toBeLessThan(SUBAGENT_RESULT_LIMITS.outputBytes);
		expect(projectSubagentResults(inputs)).toEqual(inputs);
	});

	test("shrinks expendable prose across the batch before dropping any findings", () => {
		const inputs = [evidenceHeavyResult(), result(1), result(2)];
		for (const item of inputs.slice(1)) item.text = "重复说明🙂".repeat(2500);
		expect(Buffer.byteLength(JSON.stringify({ results: inputs }))).toBeGreaterThan(SUBAGENT_RESULT_LIMITS.outputBytes);
		const output = projectSubagentResults(inputs);
		expect(Buffer.byteLength(JSON.stringify({ results: output }))).toBeLessThanOrEqual(SUBAGENT_RESULT_LIMITS.outputBytes);
		expect(output.map(item => item.report!.findings)).toEqual(inputs.map(item => item.report!.findings));
		expect(output.map(item => item.omittedFindings)).toEqual([undefined, undefined, undefined]);
	});

	test("caps eight multibyte escaped reports without losing sources or corrupting retained citations", () => {
		const inputs = Array.from({ length: 8 }, (_, index) => {
			const item = result(index);
			item.task = "退款业务🙂".repeat(2400);
			item.text = '退款引用\\"\n'.repeat(2000);
			item.report = {
				summary: "退款说明🙂".repeat(300), checkedAt: item.report!.checkedAt,
				findings: Array.from({ length: 8 }, (_, finding) => ({ kind: "implementation", statement: `finding ${finding}: ${"业务".repeat(80)}`, citations: [{ ...report().findings[0].citations[0], evidenceId: `evidence-${finding}`, excerpt: '退款\\"\n🙂'.repeat(180) }] })),
				connections: Array.from({ length: 8 }, () => "关联端点".repeat(200)), openQuestions: Array.from({ length: 8 }, () => "待核查问题".repeat(200)),
			};
			return item;
		});
		const before = structuredClone(inputs);
		const output = projectSubagentResults(inputs);
		const json = JSON.stringify({ results: output });
		expect(Buffer.byteLength(json)).toBeLessThanOrEqual(SUBAGENT_RESULT_LIMITS.outputBytes);
		expect(JSON.parse(json).results).toHaveLength(8);
		expect(json).not.toContain("�");
		expect(inputs).toEqual(before);
		for (const [index, item] of output.entries()) {
			expect(item).toMatchObject({ sourceId: inputs[index].sourceId, root: inputs[index].root, status: "completed", usage: inputs[index].usage, truncated: true, outputTruncated: true });
			expect(Array.from(item.task).length).toBeLessThanOrEqual(240);
			expect(item.omittedFindings).toBeGreaterThan(0);
			expect(item.report!.checkedAt).toBe(inputs[index].report!.checkedAt);
			expect(item.report!.findings).toEqual(inputs[index].report!.findings.slice(0, item.report!.findings.length));
			expect(item.report!.findings.length + item.omittedFindings!).toBe(8);
			expect(item.evidenceWarning).toContain("Output shortened");
		}
	});

	test("marks checked reports unverified when a complete finding cannot fit", () => {
		const inputs = Array.from({ length: 8 }, (_, index) => {
			const item = result(index);
			item.report!.findings[0].citations[0].excerpt = "exact quotation\n".repeat(1000);
			return item;
		});
		const output = projectSubagentResults(inputs).find(item => !item.report!.findings.length)!;
		expect(output.report!.findings).toEqual([]);
		expect(output.omittedFindings).toBe(1);
		expect(output.evidenceStatus).toBe("unverified");
		expect(output.evidenceWarning).toContain("No cited findings are retained");
		expect(inputs.every(item => item.report!.findings[0].citations[0].excerpt === "exact quotation\n".repeat(1000))).toBe(true);
	});

	test("keeps failures, cancellation reasons and usage alongside completed sources", () => {
		const failed: SubagentResult = { ...result(1), report: undefined, status: "failed", evidenceStatus: "unverified", text: "The repository model failed", evidenceWarning: "No report is available" };
		const cancelled: SubagentResult = { ...result(2), report: undefined, status: "cancelled", evidenceStatus: "unverified", text: "Parent stopped" };
		const output = projectSubagentResults([result(), failed, cancelled]);
		expect(output.map(item => item.status)).toEqual(["completed", "failed", "cancelled"]);
		expect(output[1]).toEqual(failed);
		expect(output[2]).toEqual(cancelled);
	});

	test("bounds plain fallback text and keeps it unverified", () => {
		const original = { ...result(), report: undefined, evidenceStatus: "unverified" as const, text: "无法证实🙂".repeat(4000), evidenceWarning: "No structured report" };
		const [output] = projectSubagentResults([original]);
		expect(Buffer.byteLength(JSON.stringify({ results: [output] }))).toBeLessThanOrEqual(SUBAGENT_RESULT_LIMITS.outputBytes);
		expect(output.text).toMatch(/^无法证实🙂/);
		expect(output.evidenceStatus).toBe("unverified");
		expect(output.evidenceWarning).toContain("No structured report");
		expect(output.truncated).toBe(true);
	});

	test("preserves unusually long real source paths and uses the aggregate budget", () => {
		const inputs = Array.from({ length: 8 }, (_, index) => ({ ...result(index), root: `/workspace/${"x".repeat(4096)}/${index}` }));
		const output = projectSubagentResults(inputs);
		expect(output.map(item => item.root)).toEqual(inputs.map(item => item.root));
		expect(Buffer.byteLength(JSON.stringify({ results: output }))).toBeLessThanOrEqual(SUBAGENT_RESULT_LIMITS.outputBytes);
	});

	test("rejects impossible identity sizes and oversized batches instead of changing source roots", () => {
		const original = { ...result(), root: "r".repeat(70 * 1024) };
		expect(() => projectSubagentResults([original])).toThrow(/identities exceed/);
		expect(original.root).toHaveLength(70 * 1024);
		expect(() => projectSubagentResults(Array.from({ length: 9 }, (_, index) => result(index)))).toThrow(/at most 8/);
		expect(projectSubagentResults([])).toEqual([]);
	});
});
