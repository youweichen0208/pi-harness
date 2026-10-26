import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn }));
const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
import { createSourceReadTools, SOURCE_READ_LIMITS } from "../../server/subagents/read-tools.js";

let fixture: string;
let root: string;
let outside: string;
let tools: ToolDefinition[];

beforeEach(async () => {
	spawn.mockReset().mockImplementation(realSpawn);
	fixture = mkdtempSync(join(tmpdir(), "pi-source-read-"));
	root = join(fixture, "source"); outside = join(fixture, "outside");
	mkdirSync(root); mkdirSync(outside);
	writeFileSync(join(root, "README.md"), "# Orders\nPaid orders flow to billing.\nCaseSensitive\n");
	writeFileSync(join(outside, "secret.md"), "outside-secret needle\n");
	tools = await createSourceReadTools(root);
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(fixture, { recursive: true, force: true });
});

function run(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
	const tool = tools.find(tool => tool.name === name);
	if (!tool) throw new Error(`Missing tool ${name}`);
	return tool.execute("test", args, signal, undefined, {} as ExtensionToolContext);
}

function text(result: Awaited<ReturnType<typeof run>>) {
	return result.content.map(item => item.type === "text" ? item.text : "").join("\n");
}

function fakeChild() {
	const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
	child.kill.mockImplementation(() => { setImmediate(() => child.emit("close", null)); return true; });
	return child;
}

function rgMatch(path: string, line: number, content: string) {
	return JSON.stringify({ type: "match", data: { path: { text: path }, lines: { text: content }, line_number: line, submatches: [] } }) + "\n";
}

describe("source read boundaries", () => {
	test("exposes only read-only tools and preserves source-relative original line numbers", async () => {
		expect(tools.map(tool => tool.name).sort()).toEqual(["source_list", "source_read", "source_search"]);
		const result = await run("source_read", { path: "README.md", startLine: 2, limit: 1 });
		expect(text(result)).toContain("README.md:2: Paid orders flow to billing.");
		expect(text(result)).not.toContain("README.md:1:");
		expect(result.details).toMatchObject({ path: "README.md", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), totalLines: 3, truncated: true });
		expect(text(result)).not.toContain(root);
	});

	test.each(["../outside/secret.md", "nested/../../outside/secret.md", "/etc/passwd", "C:/outside/secret.md", "C:secret.md", "\\\\host\\share", "..\\outside\\secret.md", "README.md\u0000", "README.md\n"])("rejects escaping or ambiguous path %j", async path => {
		for (const name of ["source_read", "source_list", "source_search"]) await expect(run(name, { path, query: "needle" })).rejects.toThrow();
		expect(spawn).not.toHaveBeenCalled();
	});

	test("rejects file/directory symlinks and does not reveal them in listing or recursive search", async () => {
		symlinkSync(join(outside, "secret.md"), join(root, "linked.md"), "file");
		symlinkSync(outside, join(root, "external"), "junction");
		symlinkSync(join(root, "README.md"), join(root, "internal.md"), "file");
		await expect(run("source_read", { path: "linked.md" })).rejects.toThrow(/Symbolic links/);
		await expect(run("source_read", { path: "external/secret.md" })).rejects.toThrow(/Symbolic links/);
		await expect(run("source_read", { path: "internal.md" })).rejects.toThrow(/Symbolic links/);
		await expect(run("source_search", { path: "external", query: "needle" })).rejects.toThrow(/Symbolic links/);
		expect(text(await run("source_list", {}))).toBe("README.md");
		expect(text(await run("source_search", { query: "outside-secret" }))).toBe("No matches in readable source files.");
	});

	test("pins the source root identity even if its path is replaced by a symlink", async () => {
		renameSync(root, join(fixture, "previous-source"));
		symlinkSync(outside, root, "junction");
		await expect(run("source_read", { path: "secret.md" })).rejects.toThrow(/Source root changed/);
		await expect(run("source_search", { query: "outside-secret" })).rejects.toThrow(/Source root changed/);
		expect(spawn).not.toHaveBeenCalled();
	});

	test("omits generated/dependency trees in list/search and rejects direct access", async () => {
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "orders.ts"), "export const needle = 1;\n");
		for (const name of [".git", "node_modules", "dist", "build", "coverage", ".next"]) {
			mkdirSync(join(root, name)); writeFileSync(join(root, name, "skip.txt"), "needle\n");
			await expect(run("source_read", { path: `${name}/skip.txt` })).rejects.toThrow(/excluded/);
		}
		expect(text(await run("source_list", {}))).toBe("README.md\nsrc/");
		expect(text(await run("source_search", { query: "needle" }))).toBe("src/orders.ts:1: export const needle = 1;");
	});

	test("reports nonexistent, directory, binary, oversized and invalid inputs", async () => {
		writeFileSync(join(root, "binary.md"), Buffer.from([0, 1, 2, 3]));
		writeFileSync(join(root, "huge.txt"), Buffer.alloc(SOURCE_READ_LIMITS.fileBytes + 1, 65));
		await expect(run("source_read", { path: "missing.md" })).rejects.toThrow(/ENOENT/);
		await expect(run("source_read", { path: "." })).rejects.toThrow(/regular text file/);
		await expect(run("source_read", { path: "binary.md" })).rejects.toThrow(/binary/);
		await expect(run("source_read", { path: "huge.txt" })).rejects.toThrow(/1 MiB/);
		await expect(run("source_read", { path: "README.md", startLine: 0 })).rejects.toThrow(/startLine/);
		await expect(run("source_read", { path: "README.md", limit: 301 })).rejects.toThrow(/limit/);
		await expect(run("source_list", { limit: 201 })).rejects.toThrow(/limit/);
		await expect(run("source_search", { query: "x", limit: 101 })).rejects.toThrow(/limit/);
		for (const query of ["", "x\ny", "x\u0000y", "x".repeat(257)]) await expect(run("source_search", { query })).rejects.toThrow(/query/);
		await expect(run("source_search", { query: "x", caseSensitive: "false" })).rejects.toThrow(/caseSensitive/);
	});
});

describe("bounded source output and exact search", () => {
	test("caps output bytes with multibyte source text and marks line/entry truncation", async () => {
		writeFileSync(join(root, "long.md"), Array.from({ length: 100 }, () => "订单".repeat(500)).join("\n"));
		const result = await run("source_read", { path: "long.md", limit: 100 });
		expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(SOURCE_READ_LIMITS.outputBytes);
		expect(result.details).toMatchObject({ truncated: true });
		expect(text(result)).toContain("Results truncated");
		const listed = await run("source_list", { limit: 1 });
		expect(listed.details).toMatchObject({ truncated: true });
		writeFileSync(join(root, "empty.md"), "");
		expect(text(await run("source_read", { path: "empty.md" }))).toContain("Empty file.");
		expect(text(await run("source_read", { path: "README.md", startLine: 200 }))).toContain("beyond the end");
	});

	test("treats regex/shell punctuation and leading dashes as literal query text", async () => {
		writeFileSync(join(root, "literal.txt"), "a.b\naxb\n--needle $(touch SHOULD_NOT_EXIST)\n");
		expect(text(await run("source_search", { query: "a.b" }))).toBe("literal.txt:1: a.b");
		expect(text(await run("source_search", { query: "--needle $(touch SHOULD_NOT_EXIST)" }))).toBe("literal.txt:3: --needle $(touch SHOULD_NOT_EXIST)");
		expect(text(await run("source_search", { query: "casesensitive" }))).toContain("No matches");
		expect(text(await run("source_search", { query: "casesensitive", caseSensitive: false }))).toBe("README.md:3: CaseSensitive");
		const args = spawn.mock.calls.at(-1)?.[1];
		expect(args).toContain("--no-config");
		expect(args).toContain("--no-follow");
		expect(args).toContain("--fixed-strings");
		expect(spawn.mock.calls.at(-1)?.[2]).not.toHaveProperty("shell");
	});

	test("honors search limits and shows a matching excerpt from long lines", async () => {
		writeFileSync(join(root, "many.txt"), Array.from({ length: 70 }, () => "needle").join("\n"));
		const limited = await run("source_search", { query: "needle", limit: 3 });
		expect(limited.details).toMatchObject({ matches: 3, truncated: true });
		expect(text(limited).match(/many\.txt:\d+:/g)).toHaveLength(3);
		const fifty = await run("source_search", { query: "needle", limit: 50 });
		expect(fifty.details).toMatchObject({ matches: 50, truncated: true });
		writeFileSync(join(root, "minified.ts"), "x".repeat(5000) + "target-value" + "x".repeat(5000));
		expect(text(await run("source_search", { query: "target-value" }))).toContain("target-value");
	});

	test("verifies rg candidates against bounded original files instead of forwarding process text", async () => {
		writeFileSync(join(root, "real.md"), "needle current contents\n");
		symlinkSync(join(outside, "secret.md"), join(root, "linked.md"), "file");
		spawn.mockImplementationOnce(() => {
			const child = fakeChild();
			setImmediate(() => {
				child.stdout.emit("data", rgMatch("real.md", 1, "needle forged secret") + rgMatch("linked.md", 1, "outside-secret needle") + rgMatch("../outside/secret.md", 1, "outside-secret needle"));
				child.emit("close", 0);
			});
			return child;
		});
		const result = await run("source_search", { query: "needle" });
		expect(text(result)).toContain("real.md:1: needle current contents");
		expect(text(result)).not.toContain("secret");
		expect(result.details).toMatchObject({ matches: 1, skipped: 2 });
	});

	test("bounds malformed or excessive subprocess output", async () => {
		const child = fakeChild();
		spawn.mockImplementationOnce(() => {
			setImmediate(() => child.stdout.emit("data", "x".repeat(SOURCE_READ_LIMITS.searchBytes + 1)));
			return child;
		});
		const result = await run("source_search", { query: "needle" });
		expect(result.details).toMatchObject({ matches: 0, truncated: true });
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});
});

describe("source tool cancellation and failures", () => {
	test("pre-aborted calls fail before filesystem traversal or process launch", async () => {
		const abort = new AbortController(); abort.abort(new Error("cancelled by caller"));
		for (const name of ["source_read", "source_list", "source_search"]) await expect(run(name, { path: "README.md", query: "needle" }, abort.signal)).rejects.toThrow("cancelled by caller");
		expect(spawn).not.toHaveBeenCalled();
	});

	test("aborting an active search kills its own child and rejects promptly", async () => {
		const child = fakeChild();
		let started!: () => void;
		const launched = new Promise<void>(resolve => { started = resolve; });
		spawn.mockImplementationOnce(() => { started(); return child; });
		const abort = new AbortController();
		const result = run("source_search", { query: "needle" }, abort.signal);
		const rejected = expect(result).rejects.toThrow("cancelled while searching");
		await launched;
		abort.abort(new Error("cancelled while searching"));
		await rejected;
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});

	test("enforces the wall-clock search deadline and kills the blocked child", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const child = fakeChild();
		let started!: () => void;
		const launched = new Promise<void>(resolve => { started = resolve; });
		spawn.mockImplementationOnce(() => { started(); return child; });
		const result = run("source_search", { query: "needle" });
		const rejected = expect(result).rejects.toThrow(/5-second time limit/);
		await launched;
		await vi.advanceTimersByTimeAsync(SOURCE_READ_LIMITS.searchMs);
		await rejected;
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});

	test("reports missing ripgrep and failed searches rather than claiming no matches", async () => {
		spawn.mockImplementationOnce(() => { const child = fakeChild(); setImmediate(() => child.emit("error", new Error("ENOENT"))); return child; });
		await expect(run("source_search", { query: "needle" })).rejects.toThrow(/could not start.*ENOENT/);
		spawn.mockImplementationOnce(() => {
			const child = fakeChild();
			setImmediate(() => { child.stderr.emit("data", "Permission denied"); child.emit("close", 2); });
			return child;
		});
		await expect(run("source_search", { query: "needle" })).rejects.toThrow(/Source search failed.*Permission denied/);
	});
});
