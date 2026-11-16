import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpPersistenceJournal } from "../../server/omp/persistence-journal.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
	const root = mkdtempSync(join(tmpdir(), "omp-recovery-journal-")); roots.push(root);
	return { root, file: join(root, "history.jsonl"), journal: new OmpPersistenceJournal(root) };
}
it("keeps failure evidence across instances and clears only the explicitly acknowledged revision", () => {
	const { root, file, journal } = setup();
	expect(journal.read(file).tokens).toEqual([]);
	journal.record(file, true);
	const restored = new OmpPersistenceJournal(root), acknowledged = restored.read(file);
	expect(acknowledged.externallyModified).toBe(true);
	expect(() => restored.assertAllowed(file)).toThrow("explicit recovery");
	restored.assertAllowed(file, acknowledged.tokens);
	journal.record(file, false); // Another failure arrives while the first reopen is in flight.
	expect(() => restored.clear(file, acknowledged.tokens)).toThrow("explicit recovery");
	const remaining = restored.read(file);
	expect(remaining.tokens).toHaveLength(1); expect(remaining.tokens).not.toEqual(acknowledged.tokens);
	restored.clear(file, remaining.tokens); restored.assertAllowed(file);
});
it("does not store transcript paths or content and treats damaged records as a restriction", () => {
	const { root, file, journal } = setup(); journal.record(file, true);
	const directory = join(root, "recovery", readdirSync(join(root, "recovery"))[0]);
	const record = join(directory, journal.read(file).tokens[0]);
	expect(readFileSync(record, "utf8")).toBe('{"version":1,"externallyModified":true}');
	if (process.platform !== "win32") expect(statSync(record).mode & 0o777).toBe(0o600);
	writeFileSync(record, "incomplete");
	expect(() => journal.assertAllowed(file)).toThrow("explicit recovery");
	journal.clear(file, journal.read(file).tokens); expect(journal.read(file).tokens).toEqual([]);
});
it("keeps restrictions scoped by transcript and rejects unsafe acknowledgement names", () => {
	const { root, file, journal } = setup(); journal.record(file, false);
	journal.assertAllowed(join(root, "other.jsonl"));
	expect(() => journal.clear(file, ["../../other.json"])).toThrow("Invalid");
	expect(journal.read(file).tokens).toHaveLength(1);
});
