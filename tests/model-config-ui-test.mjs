// Model-config modal — "自动获取模型列表" (fetch model list) UI test.
// Opens 模型管理 → 新增服务商, fills baseUrl/apiKey, clicks the fetch button
// and verifies the model rows get auto-filled from the mock /models endpoint,
// plus the inline success/error messages.
// Usage: npm run build && node model-config-ui-test.mjs
import { CHROME_PATH } from "./lib/chrome.mjs";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME =
	CHROME_PATH;
const PORT = 8900 + Math.floor(Math.random() * 500);
const MOCK_PORT = PORT + 1;
const URL = `http://127.0.0.1:${PORT}`;
const base = mkdtempSync(join(tmpdir(), "pi-web-mcui-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

// Mock OpenAI-compatible /models endpoint with vLLM-style metadata.
const mock = createServer((req, res) => {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(
		JSON.stringify({
			data: [
				{ id: "mock-a", context_window: 32768, modalities: ["text", "image"] },
				{ id: "mock-b", max_model_len: 128000, supports_vision: true, reasoning: true },
				{ id: "mock-c" },
			],
		}),
	);
});
await new Promise((res) => mock.listen(MOCK_PORT, "127.0.0.1", res));
console.log(`mock /models on :${MOCK_PORT}`);

writeFileSync(
	join(agentDir, "auth.json"),
	JSON.stringify({ main: { type: "api_key", key: "k" } }),
);
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "k",
				models: [{ id: "mock-a" }],
			},
		},
	}),
);

const NODE = realpathSync(process.execPath);
const server = spawn(NODE, ["dist/server/index.js"], {
	env: {
		...process.env,
		PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
	windowsHide: true,
});
process.on("exit", () => {
	try {
		process.kill(server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});
process.on("SIGINT", () => {
	try {
		process.kill(server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
	process.exit(1);
});

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

async function run() {
	for (let i = 0; i < 60; i++) {
		try {
			const r = await fetch(`${URL}/`);
			if (r.ok) break;
		} catch {
			/* retry */
		}
		await sleep(250);
	}
	const browser = await chromium.launch({
		executablePath: CHROME,
		headless: true,
	});
	try {
		const page = await browser.newPage({
			viewport: { width: 1280, height: 900 },
		});
		// Present the local mock as a native fixture for testing the built-in form.
		// Route only its auth/clone commands back to main; no real provider is called.
		await page.routeWebSocket('**/ws*', socket => {
			const upstream = socket.connectToServer();
			upstream.onMessage(raw => {
				const message = JSON.parse(String(raw));
				if (message.type === 'providers_status') {
					const main = message.providers.find(provider => provider.id === 'main');
					if (main) message.providers.push({ ...main, id: 'fixture-builtin', name: 'Fixture builtin', source: 'stored' });
				}
				socket.send(JSON.stringify(message));
			});
			socket.onMessage(raw => {
				const message = JSON.parse(String(raw));
				if (message.provider === 'fixture-builtin') message.provider = 'main';
				upstream.send(JSON.stringify(message));
			});
		});
		await page.goto(URL);
		await page.waitForSelector(".chat-input, .inputbar, textarea", {
			timeout: 30000,
		});

		// Join the fixture workspace before opening the composer model menu.
		await page.locator('.workspace-group-manager input').fill('Models');
		await page.locator('.workspace-group-actions button[type=submit]').click();
		await page.locator('.workspace-outside button').click();
		await page.locator('.project-item.active').waitFor();
		// Open the visible composer model dropdown → 管理模型.
		const modelChip = page.locator(".chip-model:visible").first();
		await modelChip.click();
		const manageBtn = page
			.locator(".dd-refresh", { hasText: "管理模型" })
			.first();
		await manageBtn.waitFor({ timeout: 8000 });
		await manageBtn.click();
		await page.waitForSelector(".model-modal", { timeout: 10000 });


		// Catalog disclosure, search and draft retention.
		const search = page.locator('.model-catalog-toolbar input');
		check('custom provider appears only in custom section', await page.locator('.provider-card .provider-sub').filter({ hasText: /^main$/ }).count() === 0);
		await search.fill('openai');
		const openai = page.locator('.provider-card').filter({ has: page.locator('.provider-sub', { hasText: /^openai$/ }) });
		check('legacy provider absent', !(await page.locator('.model-modal').innerText()).includes('openai-codex'));
		await openai.getByRole('button', { name: '配置', exact: true }).click();
		check('ChatGPT login retained', await openai.getByRole('button', { name: '使用 ChatGPT 登录', exact: true }).isVisible());
		await openai.locator('input[type=password]').fill('fixture-draft');
		await openai.getByRole('button', { name: '收起', exact: true }).click();
		await search.fill('no-such-provider');
		check('empty search state', await page.getByText('没有匹配的服务商，请尝试其他名称或 ID。').isVisible());
		await search.fill('openai');
		await openai.getByRole('button', { name: '配置', exact: true }).click();
		check('key draft survives collapse and search', await openai.locator('input').inputValue() === 'fixture-draft');
		await page.locator('.model-catalog-toolbar .btn.primary').click();
		await page.locator('.provider-form .modal-actions .btn').first().click();
		check('search survives custom editor', await search.inputValue() === 'openai');
		await search.fill('');

		// Use only the local fixture provider for credential changes and cloning.
		await search.fill('fixture-builtin');
		const main = page.locator('.provider-card').filter({ has: page.locator('.provider-sub', { hasText: /^fixture-builtin$/ }) });
		await main.locator('button[aria-expanded]').click();
		for (const key of ['fixture-key-one', 'fixture-key-two']) {
			await main.getByRole('button', { name: '更换密钥', exact: true }).click();
			await main.locator('input[type=password]').fill(key);
			await main.getByRole('button', { name: '保存密钥', exact: true }).click();
			await main.getByRole('button', { name: '更换密钥', exact: true }).waitFor();
			check('save/replace fixture key', JSON.parse(readFileSync(join(agentDir, 'auth.json'))).main.key === key);
		}
		page.once('dialog', dialog => dialog.accept());
		await main.getByRole('button', { name: '清空', exact: true }).click();
		await page.waitForTimeout(500);
		check('clear fixture credential', !JSON.parse(readFileSync(join(agentDir, 'auth.json'))).main);
		// Restore the isolated credential and runtime before the later locale reload.
		const replace = main.getByRole('button', { name: '更换密钥', exact: true });
		if (await replace.isVisible()) await replace.click();
		await main.locator('input[type=password]').fill('k');
		await main.getByRole('button', { name: '保存密钥', exact: true }).click();
		await replace.waitFor();
		await main.getByRole('button', { name: '复制为自定义', exact: true }).click();
		await page.locator('.provider-form').waitFor();
		check('clone opens custom draft', await page.locator('.provider-form .field input').first().inputValue() === 'main-2');
		await page.locator('.provider-form .modal-actions .btn').first().click();
		await search.fill('');
		// 新增服务商 → edit form.
		const addBtn = page.locator(".model-catalog-toolbar .btn.primary");
		await addBtn.click();
		await page.waitForSelector(".provider-form", { timeout: 8000 });

		// Fill providerId / baseUrl / apiKey (field order: providerId, name,
		// apiType, baseUrl, apiKey).
		const inputs = page.locator(".provider-form .field input");
		await inputs.nth(0).fill("mock-provider");
		await inputs.nth(2).fill(`http://127.0.0.1:${MOCK_PORT}`);
		await inputs.nth(3).fill("sk-test");

		// Click 自动获取模型列表 and wait for the rows + success message.
		await page
			.locator(".model-section-actions button", { hasText: "自动获取模型列表" })
			.click();
		await page.waitForFunction(
			() => {
				const rows = [...document.querySelectorAll(".model-row")];
				const ids = rows.map((r) => r.querySelector("input")?.value ?? "");
				const okMsg = [...document.querySelectorAll(".fetch-msg.ok")].some(
					(el) => el.textContent.includes("已获取"),
				);
				return (
					ids.includes("mock-a") &&
					ids.includes("mock-b") &&
					ids.includes("mock-c") &&
					okMsg
				);
			},
			{ timeout: 15000 },
		);
		const rowCount = await page.locator(".model-row").count();
		check(
			"fetch fills 3 model rows from /models",
			rowCount === 3,
			`rows=${rowCount}`,
		);
		const okText = await page
			.locator(".fetch-msg.ok")
			.first()
			.textContent();
		check("success message shown", okText.includes("3"), okText);

		// Metadata from the endpoint lands in the rows:
		// mock-a → contextWindow 32768 + image support (modalities).
		// mock-b → contextWindow 128000 + image support + reasoning (extended fields).
		// mock-c → plain id, defaults.
		const rowFor = (id) =>
			page
				.locator(".model-row")
				.filter({ has: page.locator(`input[value="${id}"]`) })
				.first();
		const cwA = await rowFor("mock-a").locator('input[type="number"]').nth(0).inputValue();
		const inA = await rowFor("mock-a").locator("select").inputValue();
		const reA = await rowFor("mock-a").locator(".check input").isChecked();
		check("mock-a contextWindow filled", cwA === "32768", `cw=${cwA}`);
		check("mock-a marked as text-image", inA === "text-image", `input=${inA}`);

		const cwB = await rowFor("mock-b").locator('input[type="number"]').nth(0).inputValue();
		const inB = await rowFor("mock-b").locator("select").inputValue();
		const reB = await rowFor("mock-b").locator(".check input").isChecked();
		check("mock-b contextWindow filled", cwB === "128000", `cw=${cwB}`);
		check("mock-b marked as text-image", inB === "text-image", `input=${inB}`);
		check("mock-b reasoning checked", reB);

		const inC = await rowFor("mock-c").locator("select").inputValue();
		check("mock-c stays text (no metadata)", inC === "text", `input=${inC}`);
		check("mock-a reasoning stays unchecked (no metadata)", !reA);

		// Error path: invalid baseUrl → inline error message.
		await inputs.nth(2).fill("ht!tp://nope");
		await page
			.locator(".model-section-actions button", { hasText: "自动获取模型列表" })
			.click();
		await page.waitForSelector(".fetch-msg.err", { timeout: 10000 });
		const errText = await page.locator(".fetch-msg.err").first().textContent();
		check("invalid baseUrl shows error message", errText.includes("无效"), errText);

		await page.locator('.provider-form .modal-actions .btn').first().click();
		for (const lang of ['zh', 'en']) {
			if (lang === 'en') {
				await page.evaluate(() => localStorage.setItem('pi-harness:lang', 'en'));
				await page.setViewportSize({ width: 1280, height: 900 });
				await page.reload();
				await page.locator(".conn-dot.ok").first().waitFor({ state: "attached" });
				await page.locator('.chip-model:visible').first().click();
				await page.locator('.dd-refresh').filter({ hasText: /Manage models/i }).click();
			}
			for (const theme of ['light', 'dark']) {
				await page.evaluate(theme => document.documentElement.setAttribute('data-appearance', theme), theme);
				for (const width of [375, 768, 1440]) {
					await page.setViewportSize({ width, height: 900 });
					for (const zoom of width === 1440 ? [1, 2] : [1]) {
						// Desktop browser zoom reduces the effective CSS viewport.
						await page.setViewportSize({ width: Math.round(width / zoom), height: Math.round(900 / zoom) });
						await page.locator('.model-catalog-toolbar input').fill('openai');
						const card = page.locator('.provider-card').filter({ has: page.locator('.provider-sub', { hasText: /^openai$/ }) });
						const toggle = card.locator('button[aria-expanded]');
						if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
						await card.locator('input').scrollIntoViewIfNeeded();
						const layout = await page.locator('.model-modal').evaluate(root => {
							const close = root.querySelector('.modal-close').getBoundingClientRect();
							const title = root.querySelector('h2').getBoundingClientRect();
							const body = root.querySelector('.model-modal-body');
							return body.scrollWidth <= body.clientWidth + 1 && close.top >= 0 && close.right <= innerWidth && close.bottom <= innerHeight && title.right <= close.left;
						});
						check(`layout ${lang}/${theme}/${width}/${zoom * 100}% effective viewport`, layout);
						if (zoom === 1) {
							mkdirSync('tests/scratch/model-catalog', { recursive: true });
							await page.screenshot({ animations: "disabled", path: `tests/scratch/model-catalog/${lang}-${theme}-${width}.png` });
						}
					}
				}
			}
		}

		console.log(
			`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`,
		);
	} finally {
		await browser.close();
	}
}

await run();
try {
	process.kill(server.pid, "SIGKILL");
} catch {
	/* gone */
}
mock.close();
process.exit(failures === 0 ? 0 : 1);
