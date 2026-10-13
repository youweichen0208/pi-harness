import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { CodeSearch, parseRipgrepLine, ripgrepArgs, ripgrepFileNames } from "../../server/code-search.js";
import type { ServerMessage } from "../../server/protocol.js";

test("arguments: literal by default, flags map to ripgrep, query never parsed as a flag", () => {
	const args = ripgrepArgs({ query: "-placeOrder", include: ["src/**/*.ts", " "] });
	expect(args).toContain("--fixed-strings");
	expect(args).toContain("--ignore-case");
	expect(args).toContain("--glob=src/**/*.ts");
	expect(args.slice(-4)).toEqual(["-e", "-placeOrder", "--", "."]);
	const strict = ripgrepArgs({ query: "a.b", caseSensitive: true, wholeWord: true, regex: true });
	expect(strict).toEqual(expect.arrayContaining(["--case-sensitive", "--word-regexp"]));
	expect(strict).not.toContain("--fixed-strings");
});

test("matches: byte offsets become string offsets; long lines keep a window around the hit", () => {
	const line = JSON.stringify({ type: "match", data: { path: { text: "./src/中文.ts" }, lines: { text: "const 名字 = placeOrder();\n" }, line_number: 14, submatches: [{ match: { text: "placeOrder" }, start: 15, end: 25 }] } });
	expect(parseRipgrepLine(line)).toEqual({ path: "src/中文.ts", line: 14, column: 12, text: "const 名字 = placeOrder();", ranges: [[11, 21]] });
	const long = "x".repeat(1000) + "needle" + "y".repeat(1000);
	const parsed = parseRipgrepLine(JSON.stringify({ type: "match", data: { path: { text: "min.js" }, lines: { text: long }, line_number: 1, submatches: [{ start: 1000, end: 1006 }] } }))!;
	expect(parsed.text.length).toBe(300);
	expect(parsed.text.slice(parsed.ranges[0][0], parsed.ranges[0][1])).toBe("needle");
	expect(parseRipgrepLine('{"type":"begin","data":{}}')).toBeNull();
	expect(parseRipgrepLine("not json")).toBeNull();
});

const root = mkdtempSync(join(tmpdir(), "pi-code-search-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(search: CodeSearch, messages: ServerMessage[], reqId: number, query: string, extra = {}) {
	return new Promise<Extract<ServerMessage, { type: "search_content_result" }>[]>((resolve) => {
		const start = messages.length;
		const timer = setInterval(() => {
			const mine = messages.slice(start).filter((message): message is Extract<ServerMessage, { type: "search_content_result" }> => message.type === "search_content_result" && message.reqId === reqId);
			if (mine.some((message) => message.done)) { clearInterval(timer); resolve(mine); }
		}, 10);
		search.search(root, reqId, { query, ...extra });
	});
}

test("real ripgrep: grouped matches, gitignore respected, newer request cancels older, bad regex reported", async () => {
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "order.ts"), "export class OrderService {\n  async placeOrder() {}\n  replace() { return this.placeOrder(); }\n}\n");
	writeFileSync(join(root, "notes.md"), "placeorder lower case\n");
	writeFileSync(join(root, ".gitignore"), "dist/\n");
	mkdirSync(join(root, "dist"));
	writeFileSync(join(root, "dist", "bundle.js"), "placeOrder\n");
	mkdirSync(join(root, ".git"));
	const messages: ServerMessage[] = [];
	const search = new CodeSearch((message) => messages.push(message));
	const all = (await run(search, messages, 1, "placeOrder")).flatMap((message) => message.matches);
	expect(all.map((match) => `${match.path}:${match.line}`).sort()).toEqual(["notes.md:1", "src/order.ts:2", "src/order.ts:3"]);
	const strict = (await run(search, messages, 2, "placeOrder", { caseSensitive: true, include: ["src/**"] })).flatMap((message) => message.matches);
	expect(strict.map((match) => match.path)).toEqual(["src/order.ts", "src/order.ts"]);
	search.search(root, 3, { query: "OrderService" });
	const latest = await run(search, messages, 4, "replace");
	expect(messages.some((message) => message.type === "search_content_result" && message.reqId === 3 && message.done)).toBe(false);
	expect(latest.flatMap((message) => message.matches).map((match) => match.line)).toEqual([3]);
	const bad = await run(search, messages, 5, "(unclosed", { regex: true });
	expect(bad.at(-1)).toMatchObject({ ok: false, done: true });
});

test("file names come from rg --files: gitignored trees skipped, dotfiles kept, limit honoured", async () => {
	writeFileSync(join(root, ".order.env"), "x\n");
	const listed = await ripgrepFileNames(root, "order", 50, 4000);
	expect(listed?.paths.sort()).toEqual([".order.env", "src/order.ts"]);
	expect((await ripgrepFileNames(root, "sr", 50, 4000))?.dirs).toEqual(["src"]);
	expect((await ripgrepFileNames(root, "order", 1, 4000))?.truncated).toBe(true);
});
