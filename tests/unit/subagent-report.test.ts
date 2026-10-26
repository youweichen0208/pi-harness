import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createSubagentResearchTools, SUBAGENT_REPORT_LIMITS } from "../../server/subagents/report.js";

let fixture: string;
let root: string;
let research: Awaited<ReturnType<typeof createSubagentResearchTools>>;

beforeEach(async () => {
	fixture = mkdtempSync(join(tmpdir(), "pi-source-report-"));
	root = join(fixture, "source"); mkdirSync(root);
	writeFileSync(join(root, "refund.ts"), "export const state = 'refunded';\nexport const partial = true;\nexport const event = 'order.refunded';\n");
	writeFileSync(join(root, "README.md"), "# Refunds\nOnly full refunds are documented.\n");
	research = await createSubagentResearchTools(root);
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

async function run(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
	const tool = research.tools.find(tool => tool.name === name);
	if (!tool) throw new Error(`Missing tool ${name}`);
	return tool.execute("test", args, signal, undefined, {} as ExtensionToolContext);
}

function text(result: Awaited<ReturnType<typeof run>>) {
	return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

async function read(path = "refund.ts", startLine = 1, limit = 3) {
	const result = await run("source_read", { path, startLine, limit });
	const id = text(result).match(/evidenceId (ev_[a-f0-9]{24})/)?.[1];
	if (!id) throw new Error("Missing evidence ID in source_read output");
	return id;
}

function submission(evidenceId: string, startLine = 1, endLine = startLine) {
	return { summary: "Refund findings", findings: [{ kind: "implementation", statement: "The implementation marks refunds.", citations: [{ evidenceId, startLine, endLine }] }], connections: [], openQuestions: [] };
}

async function expectRejected(args: Record<string, unknown>, message: RegExp) {
	const result = await run("source_report", args);
	expect(result.details).toMatchObject({ accepted: false });
	expect(text(result)).toMatch(message);
	expect(research.getReport()).toBeUndefined();
	expect(research.getReportError()).toMatch(message);
}

describe("structured research evidence", () => {
	test("resolves observed code/documentation/inference citations to exact excerpts and fingerprints", async () => {
		expect(research.tools.map(tool => tool.name)).toEqual(["source_list", "source_read", "source_search", "source_report"]);
		const code = await read();
		const docs = await read("README.md", 2, 1);
		const params = submission(code, 1, 2);
		params.findings.push({ kind: "documentation", statement: "Documentation describes full refunds.", citations: [{ evidenceId: docs, startLine: 2, endLine: 2 }] });
		params.findings.push({ kind: "inference", statement: "Documentation may lag the implementation.", citations: [{ evidenceId: code, startLine: 2, endLine: 2 }, { evidenceId: docs, startLine: 2, endLine: 2 }] });
		expect((await run("source_report", params)).details).toMatchObject({ accepted: true });
		const report = research.getReport()!;
		expect(report.findings.map(finding => finding.kind)).toEqual(["implementation", "documentation", "inference"]);
		expect(report.findings[0].citations[0]).toEqual({ evidenceId: code, path: "refund.ts", startLine: 1, endLine: 2, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), excerpt: "export const state = 'refunded';\nexport const partial = true;" });
		expect(report.findings[1].citations[0].excerpt).toBe("Only full refunds are documented.");
		expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
		expect(research.getReportError()).toBeUndefined();
		expect(JSON.stringify(report)).not.toContain(root);
	});

	test("IDs are stable for the same source contents and change after a file edit", async () => {
		const first = await read();
		expect(await read("refund.ts", 2, 1)).toBe(first);
		writeFileSync(join(root, "refund.ts"), "Changed implementation.\n");
		expect(await read()).not.toBe(first);
	});

	test("binds evidence IDs to their source root even for identical relative paths and bytes", async () => {
		const id = await read("README.md");
		const sibling = join(fixture, "sibling"); mkdirSync(sibling);
		writeFileSync(join(sibling, "README.md"), "# Refunds\nOnly full refunds are documented.\n");
		const original = research;
		research = await createSubagentResearchTools(sibling);
		const siblingId = await read("README.md");
		expect(siblingId).not.toBe(id);
		await expectRejected(submission(id), /Unknown.*evidenceId/);
		research = original;
		await expectRejected(submission(siblingId), /Unknown.*evidenceId/);
	});

	test("permits an insufficient-evidence report without claiming its evidence was checked", async () => {
		const result = await run("source_report", { summary: "No evidence available.", findings: [], connections: [], openQuestions: ["Where is the refund implementation?"] });
		expect(result.details).toMatchObject({ accepted: true, findings: 0 });
		expect(text(result)).toContain("evidence remains unverified");
		expect(research.getReport()!.findings).toEqual([]);
	});

	test("rejects invented IDs and lines loaded internally but never returned", async () => {
		await expectRejected(submission("ev_made_up"), /Unknown.*evidenceId/);
		const id = await read("refund.ts", 1, 1);
		await expectRejected(submission(id, 1, 2), /refund.ts:2 was not returned/);
	});

	test("search records only emitted matches, never unobserved intervening lines", async () => {
		const result = await run("source_search", { path: "refund.ts", query: "refunded" });
		const id = text(result).match(/\[(ev_[a-f0-9]{24})\]/)?.[1];
		expect(id).toBeTruthy();
		await expectRejected(submission(id!, 1, 3), /refund.ts:2 was not returned/);
		expect((await run("source_report", submission(id!, 3))).details).toMatchObject({ accepted: true });
		expect(research.getReport()!.findings[0].citations[0].excerpt).toBe("export const event = 'order.refunded';");
	});

	test("rejects partial search excerpts until a complete line is returned", async () => {
		writeFileSync(join(root, "excerpt.txt"), "x".repeat(100) + "needle\n");
		const result = await run("source_search", { query: "needle" });
		const id = text(result).match(/\[(ev_[a-f0-9]{24})\]/)![1];
		await expectRejected(submission(id), /partial or truncated line/);
		expect(await read("excerpt.txt", 1, 1)).toBe(id);
		expect((await run("source_report", submission(id))).details).toMatchObject({ accepted: true });
		expect(research.getReport()!.findings[0].citations[0].excerpt).toBe("x".repeat(100) + "needle");
	});

	test("does not treat truncated lines or output omitted by the byte cap as observed", async () => {
		writeFileSync(join(root, "minified.ts"), "x".repeat(1201));
		await expectRejected(submission(await read("minified.ts")), /partial or truncated line/);
		writeFileSync(join(root, "large.txt"), Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n"));
		await expectRejected(submission(await read("large.txt", 1, 100), 50), /large.txt:50 was not returned/);
	});

	test("changed fingerprints invalidate a prior report and re-reading permits a corrected submission", async () => {
		const id = await read();
		await run("source_report", submission(id));
		expect(research.getReport()).toBeDefined();
		writeFileSync(join(root, "refund.ts"), "new implementation\n");
		await expectRejected(submission(id), /changed since it was read/);
		await run("source_report", submission(await read()));
		expect(research.getReport()!.findings[0].citations[0].excerpt).toBe("new implementation");
	});

	test.each(["delete", "symlink"])("rejects a source file replaced by %s", async action => {
		const id = await read();
		rmSync(join(root, "refund.ts"));
		if (action === "symlink") {
			writeFileSync(join(fixture, "outside.ts"), "export const state = 'refunded';\n");
			symlinkSync(join(fixture, "outside.ts"), join(root, "refund.ts"), "file");
		}
		await expectRejected(submission(id), action === "delete" ? /ENOENT/ : /Symbolic links/);
	});

	test("verification pins the original root identity even when replaced with identical file contents", async () => {
		const id = await read();
		renameSync(root, join(fixture, "original"));
		mkdirSync(root);
		writeFileSync(join(root, "refund.ts"), "export const state = 'refunded';\nexport const partial = true;\nexport const event = 'order.refunded';\n");
		await expectRejected(submission(id), /Source root changed/);
	});

	test("verifying a report does not turn other internally loaded lines into evidence", async () => {
		const id = await read("refund.ts", 1, 1);
		await run("source_report", submission(id));
		await expectRejected(submission(id, 2), /was not returned/);
	});

	test("does not accept caller-provided paths/excerpts or invalid ranges and resets old success", async () => {
		const id = await read();
		await run("source_report", submission(id));
		const injected = { ...submission(id), findings: [{ ...submission(id).findings[0], citations: [{ evidenceId: id, startLine: 1, endLine: 1, path: "../outside.ts", excerpt: "forged" }] }] };
		await expectRejected(injected, /Invalid report fields/);
		await expectRejected(submission(id, 3, 1), /ordered/);
		await expectRejected(submission(id, 1, 101), /at most 100 lines/);
	});

	test("bounds schema counts and serialized Unicode report bytes including actual excerpts", async () => {
		const id = await read();
		await expectRejected({ ...submission(id), findings: Array.from({ length: 9 }, () => submission(id).findings[0]) }, /Invalid report fields/);
		const params = submission(id);
		params.summary = "证".repeat(2000);
		params.findings = Array.from({ length: 8 }, () => ({ ...submission(id).findings[0], statement: "证".repeat(1000) }));
		await expectRejected(params, /exceeds 24 KiB/);
		await run("source_report", submission(id));
		expect(Buffer.byteLength(JSON.stringify(research.getReport()))).toBeLessThanOrEqual(SUBAGENT_REPORT_LIMITS.outputBytes);
	});

	test("bounds retained evidence without evicting earlier observed files", async () => {
		let first = "", last = "";
		for (let index = 0; index <= SUBAGENT_REPORT_LIMITS.evidenceFiles; index++) {
			const path = `file-${index}.txt`;
			writeFileSync(join(root, path), `line ${index}\n`);
			last = await read(path, 1, 1);
			if (!index) first = last;
		}
		await expectRejected(submission(last), /unretained/);
		expect((await run("source_report", submission(first))).details).toMatchObject({ accepted: true });
	});

	test("cancelled submission rejects and discards a previous accepted report", async () => {
		const id = await read();
		await run("source_report", submission(id));
		const abort = new AbortController(); abort.abort(new Error("cancel report"));
		await expect(run("source_report", submission(id), abort.signal)).rejects.toThrow("cancel report");
		expect(research.getReport()).toBeUndefined();
	});

	test("invalidates prior success when the native SDK rejects a new submission before execution", async () => {
		const id = await read();
		await run("source_report", submission(id));
		research.invalidateReport("Native validation rejected the next submission. " + "x".repeat(3000));
		expect(research.getReport()).toBeUndefined();
		expect(research.getReportError()).toMatch(/^Native validation rejected/);
		expect(research.getReportError()).toHaveLength(2000);
		await run("source_report", submission(id));
		expect(research.getReport()).toBeDefined();
		expect(research.getReportError()).toBeUndefined();
	});
});
