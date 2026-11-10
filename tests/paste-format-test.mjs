/**
 * Paste classification in the real editor: pasted Markdown must arrive as rich
 * nodes, delimited LaTeX as a formula, bare TeX untouched, and the saved source
 * must be legal Markdown. Unit tests cover the classifier; only a real browser
 * can prove `insertHTML` and the serializer agree.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { testEnv } from "./lib/test-env.mjs";

const base = mkdtempSync(join(tmpdir(), "pi-paste-"));
const port = 8998;
const file = join(base, "paste.md");
writeFileSync(file, "# 粘贴测试\n\n原有段落。\n");

let server, browser;
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ["dist/server/index.js"], {
		env: { ...testEnv(), PORT: String(port), PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: join(base, "agent") },
		stdio: "ignore",
	});
	for (let i = 0; i < 100 && !(await portUp(port)); i++) await sleep(100);
	assert(await portUp(port));
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".setup-modal .modal-close").click();
	await page.locator(".file-name", { hasText: "paste.md" }).click();
	await page.locator(".fp-more").evaluate((node) => { node.open = true; });
	await page.locator(".fp-more-actions").getByRole("button", { name: "编辑文件" }).click();
	const rich = page.locator(".fp-rich-document");
	await rich.waitFor();

	const paste = async (text) => {
		await rich.evaluate((node, value) => {
			node.focus();
			const range = document.createRange();
			range.selectNodeContents(node);
			range.collapse(false);
			const selection = window.getSelection();
			selection.removeAllRanges();
			selection.addRange(range);
			const data = new DataTransfer();
			data.setData("text/plain", value);
			node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
		}, text);
		await page.waitForTimeout(120);
	};

	const save = async () => {
		await page.locator(".fp-header-save").click();
		await page.waitForFunction(() => document.querySelector(".fp-header-status")?.textContent?.includes("已保存"));
		return readFileSync(file, "utf8");
	};

	// Markdown becomes rich nodes, not literal text.
	await paste("## 粘贴的标题\n\n| 甲 | 乙 |\n| :-- | --: |\n| 1 | 2 |\n");
	await rich.locator("h2", { hasText: "粘贴的标题" }).waitFor();
	assert.equal(await rich.locator("table").count(), 1);
	const savedTable = await save();
	assert(savedTable.includes("## 粘贴的标题"), savedTable);
	assert(!savedTable.includes("| 甲 | 乙 |\n\n"), savedTable);

	// Delimited TeX becomes a formula the source keeps as TeX.
	await paste("$$\nE = mc^2\n$$\n");
	await rich.locator("[data-rich-math]").first().waitFor();
	const savedMath = await save();
	assert(savedMath.includes("E = mc^2"), savedMath);
	assert(!savedMath.includes("data-rich-math"), savedMath);

	// Bare TeX is left alone: a guess would mangle prose.
	await paste("磁通量 x^2 与 a_i^{(j)} 保持字面。\n");
	assert.equal(await rich.locator("[data-rich-math]").count(), 1);
	const savedBare = await save();
	assert(savedBare.includes("x^2"), savedBare);

	// A note becomes a colored callout.
	await paste("> [!TIP]\n> 粘贴的提示\n");
	await rich.locator('blockquote[data-rich-highlight="tip"]').waitFor();
	assert((await rich.locator('blockquote[data-rich-highlight="tip"]').textContent()).includes("粘贴的提示"));

	// The Chinese prefix dialect is recognized on paste without rewriting a saved English marker.
	await paste("> 注：中文提醒\n");
	await rich.locator('blockquote[data-rich-highlight="note"]').first().waitFor();
	const savedNote = await save();
	assert(savedNote.includes("[!NOTE]"), savedNote);
	assert(savedNote.includes("中文提醒"), savedNote);

	// A code fence stays opaque: its `#` and `$$` are never re-parsed.
	await paste("```sh\n# 注释不是标题\n$$ 不是公式 $$\n```\n");
	await rich.locator("pre code.language-sh").first().waitFor();
	assert.equal(await rich.locator("pre code.language-sh").first().evaluate((n) => n.textContent), "# 注释不是标题\n$$ 不是公式 $$");
	const savedFence = await save();
	assert(savedFence.includes("```sh"), savedFence);

	assert.equal(await page.locator(".rich-source-block").count(), 0);
	console.log("paste-format e2e: ok");
} finally {
	await browser?.close();
	server?.kill();
}
