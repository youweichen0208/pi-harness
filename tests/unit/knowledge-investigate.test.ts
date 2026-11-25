import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInvestigationReportTools } from "../../server/knowledge-investigate-report.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-ask-report-"));
	roots.push(root);
	writeFileSync(join(root, "engine.ts"), "one\ntwo\nthree\n");
	let authorized = true;
	const research = await createInvestigationReportTools(["engine"], () => {
		if (!authorized) throw new Error("Source revoked");
		return { id: "engine", kind: "repository", name: "Engine", root };
	}, new AbortController().signal);
	const invoke = async (name: string, args: Record<string, unknown>) => {
		const tool = research.tools.find(entry => entry.name === name)!;
		return tool.execute("test", args as never, undefined, undefined, {} as never);
	};
	const read = async () => {
		const result = await invoke("source_read", { sourceId: "engine", path: "engine.ts", startLine: 2, limit: 1 });
		return (result.details as { evidenceId: string }).evidenceId;
	};
	const report = (id: string) => invoke("source_report", { findings: [{ finding: "second line", evidenceIds: [id] }], uncertainties: [] });
	return { root, invoke, read, report, research, revoke: () => { authorized = false; } };
}

it("keeps the exact identity and original range, and rejects stale and invented citations", async () => {
	const f = await fixture();
	const id = await f.read();
	await f.report(id);
	expect(f.research.getReport()?.findings[0].evidence[0]).toMatchObject({
		sourceId: "engine", repository: "Engine", path: "engine.ts", startLine: 2, endLine: 2, sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
	await expect(f.report("invented")).rejects.toThrow(/unknown/i);
	expect(f.research.getReport()).toBeUndefined();
	writeFileSync(join(f.root, "engine.ts"), "changed\ntwo\nthree\n");
	await expect(f.report(id)).rejects.toThrow(/stale/i);
});

it("requires actual inspection and keeps observations private to each child", async () => {
	const a = await fixture(), b = await fixture();
	await expect(a.invoke("source_report", { findings: [], uncertainties: ["missing interface"] })).rejects.toThrow(/inspect/i);
	const id = await a.read();
	await b.read();
	await expect(b.report(id)).rejects.toThrow(/unknown/i);
	expect(a.research.tools.map(tool => tool.name).sort()).toEqual(["source_list", "source_read", "source_report", "source_search"]);
	await expect(a.invoke("source_list", { sourceId: "elsewhere" })).rejects.toThrow(/outside/i);
	a.revoke();
	await expect(a.report(id)).rejects.toThrow(/revoked/i);
});
