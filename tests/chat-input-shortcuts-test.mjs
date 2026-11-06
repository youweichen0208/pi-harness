/** Isolated browser regression; intercept every prompt, never call a model. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-composer-"));
let server, browser;
try {
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent") } });
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	for (const locale of ["zh", "en"]) {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.addInitScript(lang => localStorage.setItem("pi-harness:lang", lang), locale);
		const prompts = [], errors = [];
		let socket, state, overrides = {};
		page.on("pageerror", error => errors.push(error.message));
		await page.routeWebSocket("**/ws", route => {
			socket = route;
			const upstream = route.connectToServer();
			route.onMessage(wire => {
				const message = JSON.parse(String(wire));
				if (message.type === "prompt") {
					prompts.push(message);
					route.send(JSON.stringify({ type: "prompt_result", requestId: message.requestId, ok: true }));
				} else upstream.send(wire);
			});
			upstream.onMessage(wire => {
				const message = JSON.parse(String(wire));
				if (message.type === "snapshot") {
					Object.assign(message.state, { piConfigured: true }, overrides);
					state = message.state;
				}
				route.send(JSON.stringify(message));
			});
		});
		await page.goto(`http://127.0.0.1:${server.port}`);
		const input = page.locator(".inputbox textarea");
		const prefix = locale === "zh" ? "Shift+Enter 换行，Enter 发送 · " : "Shift+Enter for newline, Enter to send · ";
		const placeholder = async expected => {
			await page.waitForFunction(value => document.querySelector(".inputbox textarea")?.placeholder === value, expected);
		};
		await placeholder(prefix + (locale === "zh" ? "给 pi 发送消息…" : "Message pi…"));
		const emit = patch => {
			overrides = { ...overrides, ...patch };
			state = { ...state, ...overrides, rev: state.rev + 1 };
			socket.send(JSON.stringify({ type: "snapshot", state }));
		};
		const send = async (text, key, queue) => {
			const before = prompts.length;
			await input.fill(text);
			await input.press(key);
			await page.waitForFunction(() => document.querySelector(".inputbox textarea").value === "");
			assert.equal(prompts.length, before + 1);
			assert.equal(prompts.at(-1).text, text);
			assert.equal(prompts.at(-1).queue, queue);
		};
		await input.fill("第一行");
		await input.press("Shift+Enter");
		await input.press("x");
		assert.equal(await input.inputValue(), "第一行\nx");
		assert.equal(prompts.length, 0);
		assert.equal(await input.evaluate(el => el.matches(":placeholder-shown")), false);
		await send("第一行\n第二行", "Enter", false);
		socket.send(JSON.stringify({ type: "slash_commands", commands: [{ name: "help", description: "Help", source: "builtin" }] }));
		for (const key of ["Shift+Enter", "Enter", "Tab"]) {
			await input.fill("/he");
			await page.locator(".slash-item").first().waitFor();
			const before = prompts.length;
			await input.press(key);
			assert.equal(await input.inputValue(), key === "Shift+Enter" ? "/he\n" : "/help ");
			assert.equal(prompts.length, before);
		}
		for (const text of ["中文", "/he"]) {
			await input.fill(text);
			const before = prompts.length;
			await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true });
			assert.equal(await input.inputValue(), text);
			assert.equal(prompts.length, before);
		}
		await input.fill("");
		emit({ isStreaming: true, messages: [], streamingMessage: null });
		await placeholder(prefix + (locale === "zh" ? "给 pi 发送消息…" : "Message pi…"));
		await send("steer", "Enter", false);
		await send("queue", "Alt+Enter", true);
		assert.equal(await page.locator(".delivery-control, .thinking-control").count(), 0);
		await input.fill("click steer");
		await page.locator(".composer-action.send").click();
		await page.waitForFunction(() => document.querySelector(".inputbox textarea").value === "");
		assert.equal(prompts.at(-1).queue, false);
		assert.equal(prompts.at(-1).text, "click steer");
		socket.send(JSON.stringify({ type: "agent_silence", conversationId: state.conversationId, phase: "silent", since: Date.now() - 60000, activity: "model" }));
		await placeholder(prefix + (locale === "zh" ? "模型暂时没有响应，可停止、重试或继续等待…" : "The model is quiet. Stop, retry, or keep waiting…"));
		emit({ isStreaming: false, messages: [{ id: "question", role: "assistant", content: [{ type: "text", text: "❓ **Q1** - **选择**：选哪个？(a) A;(b) B" }] }] });
		await placeholder(prefix + (locale === "zh" ? "补充说明，或直接输入其他回答…" : "Add context, or type a different answer…"));
		socket.close();
		await placeholder(locale === "zh" ? "正在连接服务器…" : "Connecting to server…");
		assert.deepEqual(errors, []);
		console.log(`PASS ${locale}: newline, command completion, IME guard, delivery modes, placeholders and exact payloads`);
		await context.close();
	}
} finally {
	await browser?.close();
	await server?.stop();
	rmSync(root, { recursive: true, force: true });
}
