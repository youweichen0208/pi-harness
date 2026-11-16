/**
 * 全局搜索 UI 冒烟（真实 Chrome headless，零 token）：
 * Ctrl+K 打开弹窗 → 输入关键词 → 文件分区出现命中；
 * Ctrl+K 打开、Escape 关闭弹窗；模型下拉出现搜索框并可过滤。
 */
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const root = mkdtempSync(join(tmpdir(), "omp-gsui-")), workDir = join(root, "proj");
mkdirSync(join(workDir, "src"), { recursive: true });
writeFileSync(join(workDir, "src", "alpha-util.ts"), "export {};");
writeFileSync(join(workDir, "README.md"), "hi");

const dataDir = join(root, "data"), agent = join(dataDir, "omp/agent");
mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
writeFileSync(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "fixture", models: [{ id: "alpha-model" }, { id: "beta-model" }] } } }));
let harness = null;
let browser = null;

async function run() {
	harness = await startIsolatedHarness({ env: { PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: workDir } });
	const BASE = `http://127.0.0.1:${harness.port}`;
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage();
	page.on("pageerror", (e) => console.log("pageerror:", e.message));
	await page.goto(BASE);
	await page.locator(".inputbar textarea:not(:disabled)").waitFor({ timeout: 30000 });

	// 1) Global search keeps its keyboard entry after the topbar redesign.
	await page.keyboard.press("Control+k");
	await page.waitForSelector(".gs-modal", { timeout: 5000 });
	check("Ctrl+K 打开全局搜索弹窗", true);

	// 2) 输入关键词 → 文件分区命中
	await page.fill(".gs-input-row input", "util");
	await page.waitForSelector(".gs-item", { timeout: 8000 });
	const fileHit = await page
		.locator(".gs-item-title", { hasText: "alpha-util.ts" })
		.count();
	check("文件命中显示 alpha-util.ts", fileHit > 0);

	// 3) 点击文件 → 打开文件预览
	await page.locator(".gs-item", { hasText: "alpha-util.ts" }).first().click();
	await page.waitForSelector(".fp-modal, .file-preview, [class*=fp-]", { timeout: 5000 }).catch(() => {});
	const previewVisible = await page.locator("text=alpha-util.ts").count();
	check("点击后打开文件预览", previewVisible > 0);
	await page.keyboard.press("Escape");
	await sleep(300);

	// 4) Ctrl+K 打开、Escape 关闭
	await page.keyboard.press("Control+k");
	await page.waitForSelector(".gs-modal", { timeout: 3000 }).catch(() => {});
	check("Ctrl+K 打开弹窗", (await page.locator(".gs-modal").count()) > 0);
	await page.keyboard.press("Escape");
	await page.locator(".gs-modal").waitFor({state: "detached"});
	check("Escape 关闭弹窗", (await page.locator(".gs-modal").count()) === 0);

	// 5) 模型下拉搜索框
	await page.locator(".inputbar .chip-model").first().click();
	await page.waitForSelector(".dd-search", { timeout: 3000 }).catch(() => {});
	check("模型下拉出现搜索框", (await page.locator(".dd-search").count()) > 0);
	await page.locator(".dd-model-name", { hasText: "beta-model" }).waitFor();
	await page.locator(".dd-search").fill("alpha-model");
	await page.locator(".dd-model-name", { hasText: "beta-model" }).waitFor({ state: "detached" });
	check("模型搜索保留匹配项", await page.locator(".dd-model-name").allTextContents().then(names => names.length === 1 && names[0] === "alpha-model"));
	await page.locator(".dd-search").fill("");
	await page.locator(".dd-model-name", { hasText: "beta-model" }).waitFor();
	check("清空模型搜索恢复列表", await page.locator(".dd-model-name").count() === 2);

	await browser.close();
}

try {
	await run();
} catch (err) {
	console.error("FATAL:", err?.message ?? err);
	failures++;
} finally {
	await browser?.close();
	await harness?.stop();
	rmSync(root, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
