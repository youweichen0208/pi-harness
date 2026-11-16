import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HistoryFileGuard } from "../../server/omp/history-file-guard.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(body = '{"type":"session","id":"fixture"}\n') {
	const root = mkdtempSync(join(tmpdir(), "omp-file-guard-")); roots.push(root);
	const file = join(root, "session.jsonl"), guard = new HistoryFileGuard(), failures: boolean[] = [];
	writeFileSync(file, body);
	guard.onFailure(external => failures.push(external));
	guard.loaded(file, readFileSync(file, "utf8"), guard.beforeRead(file));
	return { root, file, guard, failures };
}
it("tracks native appends without rescanning a large history and accepts a content-preserving touch", () => {
	const body = JSON.stringify({ type: "message", text: "x".repeat(12 * 1024 * 1024) }) + "\n";
	const { file, guard, failures } = setup(body);
	for (let i = 0; i < 50; i++) {
		guard.check(file); const line = JSON.stringify({ type: "message", id: i }) + "\n";
		appendFileSync(file, line); guard.appended(file, line);
	}
	guard.check(file); expect(guard.bytesRead).toBe(0);
	const size = readFileSync(file).length;
	const time = new Date(Date.now() + 5000); utimesSync(file, time, time);
	guard.check(file); expect(guard.bytesRead).toBe(size);
	guard.check(file); expect(guard.bytesRead).toBe(size); expect(failures).toEqual([]);
});
it.each(["same-size", "append", "truncate", "remove", "replace"])("latches external %s and never adopts it on a later read", kind => {
	const { root, file, guard, failures } = setup();
	const original = readFileSync(file, "utf8");
	if (kind === "same-size") writeFileSync(file, original.replace("fixture", "changed"));
	if (kind === "append") appendFileSync(file, '{"foreign":true}\n');
	if (kind === "truncate") writeFileSync(file, "");
	if (kind === "remove") unlinkSync(file);
	if (kind === "replace") { const temp = join(root, "new"); writeFileSync(temp, original); renameSync(temp, file); }
	expect(() => guard.check(file)).toThrow("outside");
	writeFileSync(file, original);
	expect(() => guard.beforeRead(file)).toThrow("outside");
	expect(failures).toEqual([true]);
});
it("recognizes native atomic replacement and Windows move-aside/restore without accepting external replacements", () => {
	const { root, file, guard, failures } = setup();
	const staged = join(root, "staged.tmp"), backup = join(root, "session.bak");
	const replacement = '{"type":"session","id":"replacement"}\n'; writeFileSync(staged, replacement);
	expect(() => guard.rename(staged, file, () => { throw Object.assign(Error("fixture"), { code: "EPERM" }); })).toThrow("fixture");
	guard.check(file);
	guard.rename(file, backup, () => renameSync(file, backup));
	guard.rename(staged, file, () => renameSync(staged, file));
	guard.check(file); expect(readFileSync(file, "utf8")).toBe(replacement);
	const second = join(root, "second.bak");
	guard.rename(file, second, () => renameSync(file, second));
	guard.rename(second, file, () => renameSync(second, file));
	guard.check(file); expect(failures).toEqual([]);
});
it("rejects a replacement if foreign content arrives after staging but before publish", () => {
	const { root, file, guard } = setup();
	const staged = join(root, "staged.tmp"); writeFileSync(staged, '{"new":true}\n');
	appendFileSync(file, '{"foreign":true}\n'); const foreign = readFileSync(file, "utf8");
	expect(() => guard.rename(staged, file, () => renameSync(staged, file))).toThrow("outside");
	expect(readFileSync(file, "utf8")).toBe(foreign);
});
it("rejects a baseline changed while native loading was in flight", () => {
	const { file } = setup(), guard = new HistoryFileGuard();
	const before = guard.beforeRead(file), text = readFileSync(file, "utf8");
	appendFileSync(file, '{"foreign":true}\n');
	expect(() => guard.loaded(file, text, before)).toThrow("outside");
});
