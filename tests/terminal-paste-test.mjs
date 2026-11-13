/* 终端图片粘贴回归：剪贴板里只有图片时，终端必须把 ^V(0x16) 转发给前台
 * 程序（codex / Claude Code 的贴图是「收到 Ctrl+V 后自己读系统剪贴板」），
 * 纯文本粘贴则继续走 xterm 原生路径。
 *
 * Run:  npm run build && node tests/terminal-paste-test.mjs
 *
 * 两条断言互相独立：
 *   · 协议层：在页面里包 WebSocket.send，看客户端到底发了什么（确定性强）；
 *   · PTY 层：跑 `stty raw -echo; head -c 1 | od -An -tx1`，看字节真的落到
 *     伪终端（cooked 模式下 ^V 会被 tty 的 lnext 吃掉，所以必须 raw）。
 * 合成的 paste 事件只覆盖「分类 + 转发」链路，不需要真实剪贴板权限。 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { scrubHostEnv } from "./lib/test-env.mjs";

scrubHostEnv();

const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-paste-"));
const dataDir = mkdtempSync(join(tmpdir(), "piweb-paste-data-"));
process.env.PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;
process.env.PI_WEB_DATA_DIR = dataDir;

const server = spawn(
	process.execPath,
	[join(new URL("..", import.meta.url).pathname, "dist", "server", "index.js")],
	{
		cwd: new URL("..", import.meta.url).pathname,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	},
);
server.on("error", (e) => console.error("[srv spawn error]", e));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
	try {
		rmSync(workdir, { recursive: true, force: true });
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};
const note = (name) => console.log(`  – ${name}`);

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/api/health`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

/** 在 xterm 的 helper textarea 上合成一次 paste 事件（可带文本 / 图片）。 */
async function paste(page, { text, image } = {}) {
	await page.locator(".term-xterm:not(.hidden)").first().evaluate(
		(el, payload) => {
			const ta = el.querySelector(".xterm-helper-textarea");
			const dt = new DataTransfer();
			if (payload.text !== undefined) dt.setData("text/plain", payload.text);
			if (payload.image) {
				dt.items.add(
					new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", {
						type: "image/png",
					}),
				);
			}
			ta.dispatchEvent(
				new ClipboardEvent("paste", {
					clipboardData: dt,
					bubbles: true,
					cancelable: true,
				}),
			);
		},
		{ text, image },
	);
}

async function sentInputs(page) {
	return page.evaluate(() => (window.__termInputs ?? []).slice());
}

async function main() {
	await waitServer();
	const browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));

	// 记录浏览器实际发给服务端的 terminal_input，绕开 shell 的回显差异。
	await page.addInitScript(() => {
		window.__termInputs = [];
		const send = WebSocket.prototype.send;
		WebSocket.prototype.send = function (data) {
			try {
				const msg = JSON.parse(String(data));
				if (msg && msg.type === "terminal_input") window.__termInputs.push(msg.data);
			} catch {
				/* 非 JSON 帧（终端输出走 WS 文本帧的 JSON，这里只是兜底） */
			}
			return send.call(this, data);
		};
	});

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".boot-wait", { state: "hidden", timeout: 60000 });
	await page.waitForSelector(".topbar", { timeout: 5000 });

	// 首次运行（临时 data-dir）会弹设置向导，遮罩会拦截后续点击。
	if (await page.locator(".setup-modal .modal-close").count()) {
		await page.locator(".setup-modal .modal-close").click({ timeout: 3000 }).catch(() => {});
		await sleep(300);
	}

	await page.click('.view-switch button:has-text("终端")');
	await page.waitForSelector(".terminal-view", { timeout: 10000 });
	if (!(await page.locator(".term-tab").count())) await page.click(".term-new-row");
	await page.waitForSelector(".term-tab", { timeout: 10000 });
	await sleep(2500);

	const rowsText = () => page.locator(".xterm-rows").first().textContent();
	const textarea = page.locator(".term-xterm:not(.hidden) .xterm-helper-textarea").first();
	await textarea.click();

	// 1) 只有图片 → 转发 ^V。
	let before = (await sentInputs(page)).length;
	await paste(page, { image: true });
	await sleep(700);
	let after = await sentInputs(page);
	check("image-only paste forwards ^V", after.slice(before).includes("\u0016"));
	check("image-only paste sends nothing else", after.length === before + 1);

	// 2) PTY 层：raw 模式下读 1 字节，od 打出 `16` 才算真的落到伪终端。
	if (process.platform === "win32") {
		note("PTY round-trip skipped on win32 (no stty/head -c)");
	} else {
		await page.keyboard.type("stty raw -echo; head -c 1 | od -An -tx1; stty sane");
		await page.keyboard.press("Enter");
		await sleep(1200);
		before = (await sentInputs(page)).length;
		await paste(page, { image: true });
		await sleep(1500);
		check("^V reaches the PTY (od shows 16)", /\b16\b/.test((await rowsText()) ?? ""));
		check("PTY round-trip still sends exactly one ^V", (await sentInputs(page)).length === before + 1);
	}

	// 3) 纯文本粘贴仍然是 xterm 原生路径：文本原样进 PTY，没有 ^V，且能执行。
	before = (await sentInputs(page)).length;
	await paste(page, { text: "echo TEXT_PASTE_OK" });
	await page.keyboard.press("Enter");
	await sleep(1200);
	const textInputs = (await sentInputs(page)).slice(before);
	check("text paste forwards the text, not ^V", textInputs.join("").includes("echo TEXT_PASTE_OK") && !textInputs.includes("\u0016"));
	check("text paste executes in the shell", ((await rowsText()) ?? "").includes("TEXT_PASTE_OK"));

	// 4) 文本 + 图片 → 文本优先，不再多发 ^V。
	before = (await sentInputs(page)).length;
	await paste(page, { text: "echo MIXED_PASTE_OK", image: true });
	await page.keyboard.press("Enter");
	await sleep(1200);
	const mixedInputs = (await sentInputs(page)).slice(before);
	check("text + image paste keeps the text path", mixedInputs.join("").includes("echo MIXED_PASTE_OK"));
	check("text + image paste forwards no ^V", !mixedInputs.includes("\u0016"));
	check("text + image paste executes", ((await rowsText()) ?? "").includes("MIXED_PASTE_OK"));

	// 5) 空剪贴板不触发我们的转发。xterm 自己会给一条空 bracketed paste
	//    （ESC[200~ ESC[201~），那是既有行为，这里只要求没有 ^V、没有文本。
	before = (await sentInputs(page)).length;
	await paste(page, {});
	await sleep(500);
	const emptyInputs = (await sentInputs(page)).slice(before);
	const stripEscapes = (s) => s.replace(/\u001b\[[0-9;]*[A-Za-z~]/g, "");
	check(
		"empty paste sends no ^V and no text",
		emptyInputs.every((d) => !d.includes("\u0016") && stripEscapes(d) === ""),
	);

	check("no console errors", consoleErrors.length === 0);
	if (consoleErrors.length > 0) console.log("    console errors:", consoleErrors.slice(0, 5));

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error("TEST ERROR:", err);
	process.exit(1);
});
