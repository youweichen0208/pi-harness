import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const { ensurePrivateReaderDirectory } = await import(pathToFileURL(resolve("bin/page-reader-security.mjs")).href) as { ensurePrivateReaderDirectory(path: string): void };
const roots: string[] = [];
function temporary() {
	const root = mkdtempSync(join(tmpdir(), "pi-reader-directory-")); roots.push(root); return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.skipIf(process.platform === "win32")("creates a private directory and repairs an existing directory's permissions", () => {
	const path = join(temporary(), "reader");
	ensurePrivateReaderDirectory(path);
	expect(statSync(path).mode & 0o777).toBe(0o700);
	chmodSync(path, 0o755);
	ensurePrivateReaderDirectory(path);
	expect(statSync(path).mode & 0o777).toBe(0o700);
});

it("rejects a non-directory", () => {
	const path = join(temporary(), "reader"); writeFileSync(path, "not a directory");
	expect(() => ensurePrivateReaderDirectory(path)).toThrow();
});

it.skipIf(process.platform === "win32")("rejects a symbolic link", () => {
	const root = temporary(), actual = join(root, "actual"), path = join(root, "reader");
	ensurePrivateReaderDirectory(actual); symlinkSync(actual, path, "dir");
	expect(() => ensurePrivateReaderDirectory(path)).toThrow(/symbolic link/);
});
