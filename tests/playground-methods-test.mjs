import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { testEnv } from "./lib/test-env.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-method-test-"));
const probe = createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
assert(port >= 8900);
const dataDir = join(root, "data");
mkdirSync(dataDir);
writeFileSync(join(dataDir, "playground.json"), JSON.stringify({ enabled: true, timeoutMs: 10000 }));
const token = "method-test-token";
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["dist/server/index.js"], { env: testEnv({ PORT: String(port), PI_WEB_TOKEN: token, PI_WEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: join(root, "agent"), PI_WEB_CWD: root }), stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
server.stdout.on("data", d => { logs += d; });
server.stderr.on("data", d => { logs += d; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (path, body, method = "POST", extras = {}) => fetch(`${base}/api/playground/${path}?token=${token}`, { method: body === undefined ? "GET" : method, headers: { "Content-Type": "application/json", "x-pi-client": "method-test" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extras });
const value = text => ({ text: String(text) });
const testCase = (id, args, expected) => ({ id, args: args.map(value), ...(expected === undefined ? {} : { expected: value(expected) }) });
const results = events => events.filter(e => e.type === "case_result").map(e => e.result);
const end = events => events.find(e => e.type === "end");
async function run(code, methodId, cases, { signal, onEvent } = {}) {
	const response = await api("run", { code, tests: { methodId, cases } }, "POST", { signal });
	if (response.status !== 200) throw new Error(`${response.status}: ${await response.text()}`);
	const events = [];
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let at;
		while ((at = buffer.indexOf("\n\n")) >= 0) {
			const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2);
			const event = JSON.parse(frame.slice(6)); events.push(event); onEvent?.(event);
		}
	}
	return events;
}
let browser;
try {
	for (let i = 0; i < 150; i++) {
		try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
		if (server.exitCode !== null || i === 149) throw new Error(logs);
		await sleep(100);
	}
	const code = "public int add(int a, int b) { System.out.println(\"log\"); return a+b; }";
	const tests = { mode: "methods", selectedMethod: "Main#add(int,int)", casesByMethod: { "Main#add(int,int)": [testCase("a", [1, 2], 3)] } };
	assert.equal((await api("scratch", { content: code, tests }, "PUT")).status, 200);
	assert.deepEqual((await (await api("scratch")).json()).tests, tests);
	await api("scratch", { content: code }, "PUT");
	assert.deepEqual((await (await api("scratch")).json()).tests, tests, "legacy writes retain test config");
	assert.equal((await api("scratch", { content: code, tests: { ...tests, mode: "invalid" } }, "PUT")).status, 400);
	assert.equal((await api("run", { code, tests: { methodId: "Main#missing()", cases: [testCase("a", [])] } })).status, 400);
	assert.equal((await api("run", { code, tests: { methodId: tests.selectedMethod, cases: [testCase("a", ["bad", 2])] } })).status, 400);
	assert.equal((await api("run", { code: "import java.util.List; public int size(List<Integer> xs){ return xs.size(); }", tests: { methodId: "Main#size(List<Integer>)", cases: [testCase("a", ["[2147483648]"])] } })).status, 400);
	const status = await (await api("status")).json();
	if (!status.jdk.available) {
		console.log("SKIP real Java method execution: no host JDK");
	} else {
		const baseline = new Set(readdirSync(tmpdir()).filter(n => n.startsWith("pi-playground-")));
		const mixed = await run(code, tests.selectedMethod, [testCase("a", [1, 2], 3), testCase("b", [3, 4], 8), testCase("c", [5, 8])]);
		assert.deepEqual(results(mixed).map(r => r.status), ["passed", "failed", "unasserted"]);
		assert.equal(results(mixed)[2].actual, "13");
		assert.equal(mixed.filter(e => e.type === "out" && e.stream === "stdout").map(e => e.text).join(""), "log\nlog\nlog\n");
		const strings = await run('package demo; public class A { public static String echo(String s) {return s;} public static int echo(int n){return n;} }', "demo.A#echo(String)", [testCase("a", ['quote"\n\\中'], 'quote"\n\\中'), testCase("b", [""] , ""), { id: "c", args: [{ text: "", isNull: true }], expected: { text: "", isNull: true } }]);
		assert.deepEqual(results(strings).map(r => r.status), ["passed", "passed", "passed"]);
		const arrays = await run("public long[][] echo(long[][] a){return a;}", "Main#echo(long[][])", [testCase("a", ['[["9223372036854775807"],null]'], '[["9223372036854775807"],null]')]);
		assert.equal(results(arrays)[0].status, "passed");
		assert.match(results(arrays)[0].actual, /9223372036854775807/);
		const listCode = "import java.util.List; public int add(List<Integer> list){ return calculate(list); } private int calculate(List<Integer> list){ int result=0; for(int i=0;i<list.size();i++) result++; return result; }";
		const lists = await run(listCode, "Main#add(List<Integer>)", [testCase("a", ["[1,2,3]"], 3), testCase("b", ["[]"], 0), { id: "c", args: [{ text: "", isNull: true }] }]);
		assert.deepEqual(results(lists).map(r => r.status), ["passed", "passed", "error"]);
		const nestedCode = "public java.util.List<java.util.List<java.lang.Long>> echo(java.util.List<java.util.List<java.lang.Long>> xs){ return xs == null ? null : new java.util.LinkedList<>(xs); }";
		const nestedValue = '[["9223372036854775807",null],[],null]';
		const nested = await run(nestedCode, "Main#echo(List<List<Long>>)", [testCase("a", [nestedValue], nestedValue), testCase("b", ["[[1]]"], "[[2]]"), { id: "c", args: [{ text: "", isNull: true }], expected: { text: "", isNull: true } }]);
		assert.deepEqual(results(nested).map(r => r.status), ["passed", "failed", "passed"]);
		assert.equal(results(nested)[0].actual, "[[9223372036854775807, null], [], null]");
		const mutable = await run("import java.util.List; public List<List<Integer>> mutate(List<List<Integer>> xs){ xs.get(0).add(2); xs.add(new java.util.ArrayList<>()); xs.get(0).remove(0); return xs; }", "Main#mutate(List<List<Integer>>)", [testCase("a", ["[[1]]"], "[[2],[]]")]);
		assert.equal(results(mutable)[0].status, "passed");
		const listStrings = await run("import java.util.List; public List<String> echo(List<String> xs){return xs;}", "Main#echo(List<String>)", [testCase("a", [JSON.stringify(['quote"\n中', null])], JSON.stringify(['quote"\n中', null]))]);
		assert.equal(results(listStrings)[0].status, "passed");
		assert.match(results(listStrings)[0].actual, /quote/);
		const state = await run("public class Counter { static int n; int m; public int next(){ return ++n + ++m; } }", "Counter#next()", [testCase("a", [], 2), testCase("b", [], 2)]);
		assert.deepEqual(results(state).map(r => r.status), ["passed", "passed"]);
		const errors = await run('public int fail(int n){if(n==0) throw new IllegalArgumentException("bad"); return n;}', "Main#fail(int)", [testCase("a", [0]), testCase("b", [2], 2)]);
		assert.deepEqual(results(errors).map(r => r.status), ["error", "passed"]);
		assert.match(results(errors)[0].error, /IllegalArgumentException: bad/);
		const voidResult = await run("public void f(){}", "Main#f()", [testCase("a", [])]);
		assert.equal(results(voidResult)[0].actual, "void");
		const compile = await run("public int f(){return absent;}", "Main#f()", [testCase("a", [])]);
		assert.equal(end(compile).compileError, true); assert.equal(results(compile)[0].status, "skipped");
		await api("config", { maxOutputBytes: 1024 });
		const huge = await run('public String f(){return "x".repeat(10000);}', "Main#f()", [testCase("a", [])]);
		assert.equal(end(huge).truncated, true);
		const hugeList = await run('public java.util.List<String> f(){return java.util.Arrays.asList("x".repeat(10000));}', "Main#f()", [testCase("a", [])]);
		assert.equal(end(hugeList).truncated, true);
		await api("config", { maxOutputBytes: 262144, timeoutMs: 1000 });
		const timeout = await run("public int f(){while(true){}}", "Main#f()", [testCase("a", []), testCase("b", [])]);
		assert.equal(end(timeout).timedOut, true); assert.deepEqual(results(timeout).map(r => r.status), ["skipped", "skipped"]);
		await api("config", { timeoutMs: 10000 });
		const controller = new AbortController();
		let pid;
		await assert.rejects(run('public int f() throws Exception {System.out.println(ProcessHandle.current().pid()); Thread.sleep(60000); return 0;}', "Main#f()", [testCase("a", [])], { signal: controller.signal, onEvent(event) { if (event.type === "out" && event.stream === "stdout") { pid = Number(event.text.trim()); controller.abort(); } } }));
		assert.ok(pid > 0);
		for (let i = 0; i < 30; i++) { try { process.kill(pid, 0); } catch { break; } await sleep(100); }
		assert.throws(() => process.kill(pid, 0));
		for (let i = 0; i < 30 && readdirSync(tmpdir()).some(n => n.startsWith("pi-playground-") && !baseline.has(n)); i++) await sleep(100);
		assert.equal(readdirSync(tmpdir()).some(n => n.startsWith("pi-playground-") && !baseline.has(n)), false);
		console.log("PASS Java methods: assertions, overloads, null, arrays, nested Lists, mutable Lists, precision, state isolation, exceptions, compile errors, output cap, timeout, cancellation and cleanup");
	}
	if (process.argv.includes("--browser")) {
		await api("scratch", { content: code, tests: { ...tests, mode: "program" } }, "PUT");
		assert.ok(status.jdk.available);
		const { chromium } = await import("playwright-core");
		const { CHROME_PATH } = await import("./lib/chrome.mjs");
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
		await page.addLocatorHandler(page.locator(".setup-modal"), async () => { await page.locator(".setup-modal .modal-close").click(); });
		await page.goto(`${base}/?token=${token}`);
		await page.getByRole("button", { name: "Playground", exact: true }).click({ timeout: 30000 });
		await page.locator(".method-case").waitFor();
		assert.equal(await page.locator(".scratch-mode").count(), 0);
		await page.getByRole("button", { name: "运行全部用例", exact: true }).click();
		await page.locator(".method-result.passed").waitFor();
		await page.getByRole("button", { name: "添加用例", exact: true }).click();
		const second = page.locator(".method-case").nth(1);
		await second.getByRole("textbox", { name: "a", exact: true }).fill("5");
		await second.getByRole("textbox", { name: "b", exact: true }).fill("8");
		await page.getByRole("button", { name: "运行全部用例", exact: true }).click();
		await page.locator(".method-result.unasserted").waitFor();
		assert.match(await page.locator(".method-result.unasserted").innerText(), /13/);
		await page.waitForFunction(() => document.querySelector(".scratch-save-status")?.textContent.includes("已保存"));
		assert.equal((await (await api("scratch")).json()).tests.mode, "methods", "legacy program drafts switch to method tests");
		await page.reload();
		await page.getByRole("button", { name: "Playground", exact: true }).click();
		await page.locator(".method-case").nth(1).waitFor();
		await page.locator(".method-case").nth(1).locator(".method-case-toggle").click();
		assert.equal(await page.locator(".method-case").nth(1).getByRole("textbox", { name: "a", exact: true }).inputValue(), "5");
		assert.equal(await page.locator(".method-result").count(), 0, "refresh clears execution results");
		await page.locator(".method-case").nth(1).getByRole("button", { name: "删除用例" }).click();
		await page.waitForFunction(() => document.activeElement === document.querySelector(".method-case-toggle"));
		await page.locator(".cm-content").focus();
		await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
		await page.locator(".method-result.passed").waitFor();
		await page.getByRole("textbox", { name: "a", exact: true }).fill("9");
		await page.locator(".playground-badge.stale").waitFor();
		// A single-case run must not include the other registered cases.
		await page.locator(".method-case").first().getByRole("button", { name: "运行", exact: true }).click();
		await page.locator(".method-result.failed").waitFor();
		assert.equal(await page.locator(".method-result").count(), 1);
		await page.locator(".cm-content").fill(code + "\npublic static int twice(int n) { return n*2; }");
		await page.locator(".method-toolbar select").selectOption("Main#twice(int)");
		assert.equal(await page.locator(".method-case").count(), 0);
		await page.getByRole("button", { name: "添加用例", exact: true }).click();
		await page.getByRole("textbox", { name: "n", exact: true }).fill("6");
		await page.getByRole("button", { name: "运行全部用例", exact: true }).click();
		await page.locator(".method-result.unasserted").waitFor();
		assert.match(await page.locator(".method-result.unasserted").innerText(), /12/);
		await page.locator(".method-toolbar select").selectOption("Main#add(int,int)");
		assert.equal(await page.getByRole("textbox", { name: "a", exact: true }).inputValue(), "9");
		await page.waitForFunction(() => document.querySelector(".scratch-save-status")?.textContent.includes("已保存"));
		let delayed = false;
		await page.route("**/api/playground/scratch*", async route => {
			if (route.request().method() !== "PUT" || delayed) return route.continue();
			delayed = true;
			const response = await route.fetch();
			await sleep(1200);
			await route.fulfill({ response });
		});
		const firstWrite = page.waitForRequest(request => request.url().includes("/api/playground/scratch") && request.method() === "PUT");
		await page.getByRole("textbox", { name: "a", exact: true }).fill("10");
		await firstWrite;
		await page.getByRole("textbox", { name: "a", exact: true }).fill("9");
		await page.waitForFunction(() => document.querySelector(".scratch-save-status")?.textContent.includes("已保存"));
		assert.equal((await (await api("scratch")).json()).tests.casesByMethod["Main#add(int,int)"][0].args[0].text, "9", "reverting during an in-flight save must persist the latest draft");
		await page.unroute("**/api/playground/scratch*");
		await page.screenshot({ path: join(tmpdir(), "pi-methods-desktop.png") });
		await page.setViewportSize({ width: 580, height: 900 });
		await page.screenshot({ path: join(tmpdir(), "pi-methods-narrow.png") });
		assert.ok(await page.locator(".method-case").isVisible());
		await page.evaluate(() => document.documentElement.setAttribute("data-appearance", "dark"));
		await page.screenshot({ path: join(tmpdir(), "pi-methods-dark.png") });
		await page.setViewportSize({ width: 1280, height: 1000 });
		const listCode = "import java.util.List; public List<List<Integer>> echo(List<List<Integer>> xs){return xs;}";
		await page.locator(".cm-content").fill(listCode);
		await page.locator(".method-toolbar select").selectOption("Main#echo(List<List<Integer>>)");
		await page.getByRole("button", { name: "添加用例", exact: true }).click();
		const listInput = page.getByRole("textbox", { name: "xs", exact: true });
		assert.equal(await listInput.getAttribute("placeholder"), "[[1]]");
		await listInput.fill("[[1,2],[],null]");
		await page.getByRole("button", { name: "运行全部用例", exact: true }).click();
		await page.locator(".method-result.unasserted").waitFor();
		assert.match(await page.locator(".method-result").innerText(), /\[\[1, 2\], \[\], null\]/);
		await page.locator(".method-value input[type=checkbox]").check();
		assert.equal(await listInput.isDisabled(), true);
		await page.locator(".playground-badge.stale").waitFor();
		await page.locator(".method-case").getByRole("button", { name: "运行", exact: true }).click();
		await page.locator(".method-result.unasserted").waitFor();
		await page.waitForFunction(() => document.querySelector(".scratch-save-status")?.textContent.includes("已保存"));
		await page.reload();
		await page.getByRole("button", { name: "Playground", exact: true }).click();
		await page.getByRole("textbox", { name: "xs", exact: true }).waitFor();
		assert.equal(await page.getByRole("textbox", { name: "xs", exact: true }).inputValue(), "[[1,2],[],null]");
		assert.equal(await page.locator(".method-value input[type=checkbox]").isChecked(), true);
		console.log("PASS browser: method selection, case add/delete, batch run, no assertion, autosave/reload, shortcut, stale results and narrow layout");
	}
	console.log("PASS method test HTTP validation and backward-compatible draft persistence");
} finally {
	await browser?.close();
	if (server.exitCode === null) {
		server.kill("SIGTERM");
		await Promise.race([new Promise(resolve => server.once("exit", resolve)), sleep(5000)]);
		if (server.exitCode === null) { server.kill("SIGKILL"); await new Promise(resolve => server.once("exit", resolve)); }
	}
	rmSync(root, { recursive: true, force: true });
}
