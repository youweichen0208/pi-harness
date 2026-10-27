/** Offline pip wheels exercise the real installer without downloading dependencies. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testEnv } from "./lib/test-env.mjs";
import { playgroundFixture } from "./lib/playground-fixture.mjs";
import { PythonTools } from "../dist/server/playground-python-tools.js";
import { probePython } from "../dist/server/playground-python.js";
const python = await probePython(testEnv());
if (!python.available) { console.log("SKIP Python tools installation: no Python 3.9+"); process.exit(0); }
const root = mkdtempSync(join(tmpdir(), "pi-tools-install-"));
let fixture, browser;
try {
	const venv = join(root, "venv"), wheels = join(root, "wheels"); mkdirSync(wheels);
	execFileSync(python.command, ["-m", "venv", venv], { timeout: 60000, env: testEnv() });
	const executable = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	const cancelledTools = new PythonTools(join(root, "cancelled"));
	const controller = new AbortController();
	const cancelled = cancelledTools.install({ command: executable, args: [] }, controller.signal);
	controller.abort();
	await assert.rejects(cancelled, /cancelled/);
	assert.equal(cancelledTools.path({ command: executable, args: [] }), undefined);
	for (const key of readdirSync(join(root, "cancelled", "python-tools"))) {
		assert.deepEqual(readdirSync(join(root, "cancelled", "python-tools", key)), [], "cancelled installation removes its incomplete generation");
	}
	const real = process.argv.includes("--real");
	if (!real) execFileSync(executable, ["-c", `
import zipfile, sys
modules = {
    'jedi': '''class Settings: pass
settings = Settings()
class Project:
    def __init__(self, *args, **kwargs): pass
class Script:
    def __init__(self, *args, **kwargs): pass
''',
    'black': '''class Mode: pass
def format_str(code, mode): return code.replace("value=1", "value = 1")
'''
}
for name, source in modules.items():
    dist = name + '-0.0.1.dist-info/'
    with zipfile.ZipFile(sys.argv[1] + '/' + name + '-0.0.1-py3-none-any.whl', 'w') as wheel:
        wheel.writestr(name + '/__init__.py', source)
        wheel.writestr(dist + 'METADATA', 'Metadata-Version: 2.1\\nName: ' + name + '\\nVersion: 0.0.1\\n')
        wheel.writestr(dist + 'WHEEL', 'Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
        wheel.writestr(dist + 'RECORD', '')
`, wheels], { env: testEnv() });
	fixture = await playgroundFixture({ PI_WEB_PYTHON: executable, ...(!real ? { PIP_NO_INDEX: "1", PIP_FIND_LINKS: wheels } : {}) });
	const { api } = fixture;
	assert.equal((await api("format", { code: "value=1\n" })).status, 422);
	assert.equal((await api("tools/install", { packages: ["anything"] })).status, 400);
	assert.equal((await api("tools/install", [])).status, 400);
	assert.equal((await api("tools/install", {}, "POST", { headers: { "Content-Type": "application/json", Origin: "https://example.invalid" } })).status, 403);
	const unauthenticated = await fetch(`${fixture.base}/api/playground/tools/install`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
	assert.equal(unauthenticated.status, 401);
	const attempts = await Promise.all([api("tools/install", {}), api("tools/install", {})]);
	assert.deepEqual(attempts.map(response => response.status).sort(), [200, 503]);
	const duplicate = attempts.find(response => response.status === 503);
	assert.match((await duplicate.json()).error, /already running/);
	const installed = attempts.find(response => response.status === 200);
	assert.equal(installed.status, 200, installed.status === 200 ? "" : await installed.text());
	assert.deepEqual(await installed.json(), { installed: true });
	const formatted = await api("format", { code: "value=1\n" });
	assert.equal(formatted.status, 200, formatted.status === 200 ? "" : await formatted.text());
	assert.equal((await formatted.json()).code, "value = 1\n");
	const diagnostics = await api("language", { code: "def broken(:", action: "diagnostics", offset: 0 });
	assert.equal(diagnostics.status, 200); assert((await diagnostics.json()).diagnostics.length);
	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core");
		const { CHROME_PATH } = await import("./lib/chrome.mjs");
		const toolsRoot = join(fixture.dataDir, "python-tools");
		for (const entry of readdirSync(toolsRoot)) rmSync(join(toolsRoot, entry, "current"));
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		const page = await browser.newPage();
		await page.goto(`${fixture.base}/?token=${fixture.token}`);
		await page.locator(".setup-modal .modal-close").click();
		await page.getByRole("button", { name: "Playground", exact: true }).click();
		const editor = page.locator(".scratch-editor-cm .cm-content");
		await editor.fill("value=1");
		await page.getByRole("button", { name: "安装补全与格式化工具", exact: true }).click();
		await page.getByRole("button", { name: "正在安装…", exact: true }).waitFor();
		await page.getByText("Python 语言服务已就绪", { exact: true }).waitFor({ timeout: 60000 });
		await page.getByRole("button", { name: "格式化", exact: true }).click();
		await page.waitForFunction(() => document.querySelector('.scratch-editor-cm .cm-content')?.textContent?.includes('value = 1'));
		console.log("PASS browser: missing-tools install button, busy state, automatic language retry and formatting");
		await browser.close(); browser = undefined;
	}
	if (!real) {
		rmSync(wheels, { recursive: true }); mkdirSync(wheels);
		const toolsRoot = join(fixture.dataDir, "python-tools");
		const before = readdirSync(toolsRoot).flatMap(key => readdirSync(join(toolsRoot, key))).sort();
		const failed = await api("tools/install", {});
		assert.equal(failed.status, 503); assert.match((await failed.json()).error, /No matching distribution|Could not find/);
		assert.equal((await api("format", { code: "value=1" })).status, 200, "failed reinstall preserves the working tools");
		assert.deepEqual(readdirSync(toolsRoot).flatMap(key => readdirSync(join(toolsRoot, key))).sort(), before, "failed installation leaves no partial files");
	}
	// App tools are not installed in the chosen environment's site-packages.
	const host = execFileSync(executable, ["-I", "-c", "import importlib.util; print(importlib.util.find_spec('black'))"], { encoding: "utf8", env: testEnv() });
	assert.equal(host.trim(), "None");
	console.log(`PASS ${real ? "real PyPI" : "offline wheel"} install: authentication, source/body restrictions, concurrency, immediate Python analysis/formatting, host isolation`);
} finally {
	await browser?.close(); await fixture?.stop(); rmSync(root, { recursive: true, force: true });
}
