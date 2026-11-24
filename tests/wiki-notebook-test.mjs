import assert from "node:assert/strict";
import { statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { testEnv } from "./lib/test-env.mjs";
import { portUp } from "./lib/port-utils.mjs";

const dir = mkdtempSync(join(tmpdir(), "wiki-notebook-")),
	port = 19483;
const python = process.env.PI_WEB_PYTHON;
const env = {
	...testEnv(),
	PORT: String(port),
	PI_WEB_CWD: dir,
	PI_WEB_DATA_DIR: join(dir, "data"),
	PI_CODING_AGENT_DIR: join(dir, "agent"),
	...(python ? { PI_WEB_PYTHON: python } : {}),
};
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eN0AAAAASUVORK5CYII=";
writeFileSync(join(dir, "results.ipynb"), JSON.stringify({nbformat:4, nbformat_minor:5, metadata:{}, cells:[{
	id:"analysis", cell_type:"code", metadata:{}, source:"", execution_count:1, outputs:[
		{output_type:"stream", name:"stdout", text:"A log with ```"},
		{output_type:"display_data", data:{"image/png":png}},
		{output_type:"display_data", data:{"text/html":"<table><thead><tr><th>Value</th></tr></thead><tbody><tr><td>A|B</td></tr></tbody></table>"}}
	]
}]}));
writeFileSync(join(dir, "data.csv"), "value\n42\n");
const markdown = [
	"```python", "import pandas as pd", "df = pd.read_csv('data.csv')", "df", "```", "",
	"```py", "import matplotlib.pyplot as plt", "plt.plot(df.value)", "plt.show()", "```", "",
	"```python3", "print(df.value.sum())", "```", "", "```python3", "print(df.value.sum())", "```",
].join("\n");
writeFileSync(join(dir, "worksheet.markdown"), markdown);
const plain = '```\nprint("hello")\n```\n\n```javascript\nconsole.log("hello")\n```';
writeFileSync(join(dir, "plain.md"), plain + "\n\n```\n```");
writeFileSync(join(dir, "analysis.ipynb"), JSON.stringify({ nbformat:4, nbformat_minor:5, metadata:{}, cells:[{
	id:"first", cell_type:"code", metadata:{}, source:"", execution_count:null, outputs:[]
}]}));
writeFileSync(join(dir, "deletion.ipynb"), JSON.stringify({ nbformat:4, nbformat_minor:5, metadata:{}, cells:[
	{ id:"delete-first", cell_type:"code", metadata:{}, source:"first", execution_count:null, outputs:[] },
	{ id:"delete-second", cell_type:"code", metadata:{}, source:"second", execution_count:null, outputs:[] },
]}));
mkdirSync(join(dir, "agent"));
writeFileSync(
	join(dir, "agent/models.json"),
	JSON.stringify({
		providers: {
			fixture: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:9",
				apiKey: "unused",
				models: [{ id: "unused", name: "Unused", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
			},
		},
	}),
);
writeFileSync(join(dir, "agent/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "unused" }));
writeFileSync(join(dir, "agent/auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "unused" } }));
writeFileSync(join(dir, "list.md"), readFileSync(new URL("../docs/python-list-example.md", import.meta.url)));
let server, browser;
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ["dist/server/index.js"], { env, stdio: "ignore" });
	for (let i = 0; i < 100 && !(await portUp(port)); i++) await new Promise((r) => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage();
	const sent = [];
	page.on("websocket", ws => ws.on("framesent", ({payload}) => sent.push(JSON.parse(String(payload)))));
	await page.goto(`http://127.0.0.1:${port}/?wiki-window=1&cwd=${encodeURIComponent(dir)}`);
	if (python) {
		await page.locator('.wiki-tree-main[title="list.md"]').click();
		await page.locator("[data-code-run-kernel]").click();
		await page.locator(".wiki-cell-result pre").filter({hasText:"[5, 4, 3, 2, 1]"}).waitFor();
		assert.match(await page.locator(".wiki-cell-result").allTextContents().then(parts => parts.join("")), /\[1, 2, 3, 4, 5\]/);
		mkdirSync("tests/scratch", {recursive:true});
		await page.locator(".fp-rich-document").screenshot({path:"tests/scratch/python-list.png"});
	}
	await page.locator('.wiki-tree-main[title="results.ipynb"]').click();
	const output = page.locator(".nb-output");
	await output.locator("img").waitFor();
	assert.equal(await output.locator("table td").innerText(), "A|B");
	assert.match(await output.locator("pre").innerText(), /A log/);
	assert.equal(await output.getByRole("button").count(), 0);
	const resultCell = page.locator(".nb-editor section").first();
	await resultCell.locator("textarea").fill("print('updated')");
	await resultCell.locator(".nb-changed").waitFor();
	await page.route("**/api/wiki", async route => {
		if (route.request().postDataJSON()?.action !== "notebook-run") return route.continue();
		await route.fulfill({ contentType:"application/x-ndjson", body:JSON.stringify({ result:{ outputs:[{output_type:"stream", name:"stdout", text:"updated\n"}], execution_count:2 } })+"\n" });
	});
	await resultCell.getByRole("button", {name:/^(运行|Run)$/}).click();
	await resultCell.locator(".nb-changed").waitFor({state:"hidden"});
	await resultCell.locator(".nb-output pre").filter({hasText:"updated"}).waitFor();
	await page.unroute("**/api/wiki");
	await page.locator('.wiki-tree-main[title="plain.md"]').click();
	await page.locator(".wiki-prose pre > code").first().waitFor();
	assert.equal(await page.locator("[data-code-run-kernel]").count(), 0);
	await page.locator("pre:has(code.language-javascript) [data-code-fold]").waitFor();
	const empty = page.locator(".wiki-prose pre.codeblock").nth(2);
	const input = empty.locator("code");
	assert.ok((await input.boundingBox())?.height >= 16, "Empty code has an editable line");
	await empty.click({position:{x:4, y:8}});
	assert.equal(await empty.getAttribute("data-frame-selected"), "");
	await input.click();
	assert.equal(await empty.getAttribute("data-frame-selected"), null);
	await page.keyboard.insertText("hello");
	assert.equal(await input.textContent(), "hello");
	await empty.click({position:{x:4, y:8}});
	assert.equal(await empty.getAttribute("data-frame-selected"), "");
	await page.keyboard.press("Backspace");
	assert.equal(await page.locator(".wiki-prose pre.codeblock").count(), 2);
	const trigger = page.locator(".wiki-tree-actions .wiki-tree-new > button");
	const choices = page.locator(".wiki-new-list");
	await trigger.hover();
	assert.equal(await choices.getByRole("button").count(), 2);
	await choices.getByRole("button",{name:/文件夹|Folder/}).click();
	const folder = page.locator(".wiki-tree-create-form input");
	await folder.fill("Experiments");
	await folder.press("Enter");
	await page.locator(".wiki-tree-main").filter({hasText:"Experiments"}).waitFor();
	const nestedCreate = page.locator('.wiki-tree-main[title="Experiments"]').locator("..").locator(".wiki-create-in-folder");
	await nestedCreate.hover();
	assert.equal(await choices.getByRole("button").count(), 2);
	await choices.getByRole("button", {name:/Markdown/}).click();
	await folder.fill("nested");
	await folder.press("Enter");
	await page.waitForURL(url => url.searchParams.get("doc") === "Experiments/nested.md");
	assert.equal(readFileSync(join(dir, "Experiments/nested.md"), "utf8"), "");
	for (const name of ["notes", "summary.md"]) {
		await trigger.hover();
		await choices.getByRole("button",{name:/Markdown/}).click();
		const input = page.locator(".wiki-tree-create-form input");
		await input.fill(name);
		await input.press("Enter");
		const filename = name === "notes" ? "notes.md" : name;
		await page.waitForURL(url => url.searchParams.get("doc") === filename);
		assert.equal(readFileSync(join(dir, filename), "utf8"), "");
	}
	await page.locator(".wiki-toolbar-insert button").click();
	await page.getByRole("menuitem", {name:/Jupyter/}).waitFor();
	await page.keyboard.press("Escape");
	await page.locator(".fp-rich-document[contenteditable=true]").click();
	await page.keyboard.type("/");
	const jupyterCard = page.getByRole("option", {name:/Jupyter/});
	await jupyterCard.locator(".fp-slash-label").waitFor({state:"visible"});
	await jupyterCard.click();
	await page.locator("[data-code-run-kernel]").waitFor();
	await page.locator('.wiki-tree-main[title="notes.md"]').click();
	await page.waitForURL(url => url.searchParams.get("doc") === "notes.md");
	await page.locator(".fp-rich-document[contenteditable=true]").click();
	await page.keyboard.type("/jupyter");
	await page.getByRole("option", {name:/Jupyter/}).waitFor();
	await page.keyboard.press("Enter");
	await page.locator("[data-code-run-kernel]").waitFor();
	const emptyCell = page.locator("pre.codeblock:has([data-code-run-kernel])").first();
	assert.equal(await emptyCell.locator(".fp-code-language button[aria-label] svg").count(), 4);
	assert.equal((await emptyCell.locator(".fp-code-language").innerText()).trim(), "");
	const geometry = await emptyCell.evaluate(cell => {
		const code = cell.querySelector("code");
		const box = code.getBoundingClientRect();
		const css = getComputedStyle(code);
		const firstLine = box.top + code.clientTop + parseFloat(css.paddingTop) + parseFloat(css.lineHeight) / 2;
		const prompt = cell.querySelector(".wiki-cell-prompt").getBoundingClientRect();
		const buttons = [...cell.querySelectorAll(".fp-code-language button")].map(button => button.getBoundingClientRect());
		return {promptOffset: prompt.top + prompt.height / 2 - firstLine, tops: buttons.map(b => b.top), bottoms: buttons.map(b => b.bottom)};
	});
	assert(Math.abs(geometry.promptOffset) < 2, JSON.stringify(geometry));
	for (const edge of [geometry.tops, geometry.bottoms]) assert(Math.max(...edge) - Math.min(...edge) <= 1, JSON.stringify(geometry));
	await page.keyboard.insertText("print(42)");
	await page.waitForFunction(() => document.querySelector("code.language-python")?.textContent.includes("print(42)"));
	if (python) {
		// A cell previously dragged to its input height must still reveal new stdout.
		await page.locator("pre.codeblock:has([data-code-run-kernel])").evaluate(cell => {
			cell.style.height = cell.getBoundingClientRect().height + "px";
		});
		await page.keyboard.press("Shift+Enter");
		const block = page.locator("pre.codeblock").filter({has:page.locator("[data-code-run-kernel]")});
		const output = block.locator(".nb-output pre").filter({hasText:"42"});
		await output.waitFor();
		const frame = await block.boundingBox(), text = await output.boundingBox();
		assert.ok(text.y >= frame.y && text.y + text.height <= frame.y + frame.height);
		assert.equal(await output.isVisible(), true);
		assert.equal(await block.locator(".fp-code-language button").count(), 4);
		await block.locator(".fp-code-language").getByRole("button", {name:/复制|Copy/}).click();
		await block.getByRole("button", {name:/已复制|Copied/}).waitFor();
	}
	const cells = page.locator("pre.codeblock:has([data-code-run-kernel])");
	const firstCell = cells.first();
	assert.equal(await firstCell.locator("[data-code-fold]").count(), 0);
	const frame = await firstCell.boundingBox();
	const add = await firstCell.locator(".wiki-cell-insert").boundingBox();
	const runBox = await firstCell.locator("[data-code-run-kernel]").boundingBox();
	assert.ok(add.x > frame.x + frame.width / 2 && add.x + add.width <= runBox.x);
	assert.ok(add.y >= frame.y && add.y - frame.y < 16);
	assert.ok(Math.abs(add.y + add.height / 2 - runBox.y - runBox.height / 2) < 4);
	for (const [at, source] of [[0, "answer = 6 * 7"], [1, "print(answer)"], [0, "# inserted"]]) {
		await cells.nth(at).locator(".wiki-cell-insert").click();
		await page.keyboard.press("Backspace");
		const orphaned = await page.locator('.fp-rich-document pre:not(:has(code)):not(.nb-output pre)').evaluateAll(nodes => nodes.map(node => node.outerHTML));
		assert.equal(orphaned.length, 0, JSON.stringify({ at, orphaned }));
		await page.keyboard.insertText(source);
		assert.equal(await cells.nth(at + 1).locator("code").textContent(), source);
	}
	assert.equal(await cells.count(), 4);
	if (python) {
		await cells.nth(2).locator("[data-code-run-kernel]").click();
		await page.waitForFunction(() => document.querySelectorAll(".wiki-cell-prompt")[2]?.textContent === "In [2]:");
		await cells.nth(3).locator("[data-code-run-kernel]").click();
		await cells.nth(3).locator(".nb-output pre").filter({hasText:"42"}).waitFor();
		assert.equal(await cells.first().locator(".nb-output").isVisible(), true);
		assert.equal(await cells.nth(3).locator(".nb-output").isVisible(), true);
		await cells.nth(3).locator("[data-code-run-kernel]").click();
		await page.waitForFunction(() => document.querySelectorAll(".wiki-cell-prompt")[3]?.textContent === "In [4]:");
		assert.equal(await cells.first().locator(".wiki-cell-prompt").textContent(), "In [1]:");
		const shortcutCode = cells.nth(2).locator("code"), runModifier = process.platform === "darwin" ? "Meta" : "Control";
		await shortcutCode.click();
		await page.keyboard.press(`${runModifier}+Enter`);
		await page.waitForFunction(() => document.querySelectorAll(".wiki-cell-prompt")[2]?.textContent === "In [5]:");
		await page.keyboard.press("Shift+Enter");
		await page.waitForFunction(() => document.querySelectorAll(".wiki-cell-prompt")[2]?.textContent === "In [6]:");
		await page.waitForFunction(() => document.querySelectorAll("pre.codeblock")[3]?.contains(document.getSelection()?.anchorNode));
		assert.equal(await shortcutCode.textContent(), "answer = 6 * 7");
	}
	await page.locator(".fp-rich-document").locator("p").last().click();
	await page.keyboard.type("/jupyter");
	await page.getByRole("option", {name:/Jupyter/}).waitFor();
	await page.keyboard.press("Enter");
	await cells.nth(4).waitFor();
	await page.keyboard.insertText("# separate");
	await page.locator('.wiki-tree-main[title="plain.md"]').click();
	await page.locator(".fp-rich-document code.language-javascript").waitFor();
	await page.locator('.wiki-tree-main[title="notes.md"]').click();
	await cells.nth(4).waitFor();
	assert.equal(await cells.locator("code[data-fence-meta]").count(), 4);
	assert.equal(await page.locator("pre[data-group-next]").count(), 3);
	assert.equal(await cells.nth(4).getAttribute("data-group-prev"), null);
	for (let i = 0; i < 3; i++) {
		const upper = await cells.nth(i).boundingBox(), lower = await cells.nth(i + 1).boundingBox();
		assert.ok(Math.abs(upper.y + upper.height - lower.y) < 1, "Grouped cell borders meet");
	}
	const deleteButton = cells.nth(1).locator(".wiki-cell-delete");
	await deleteButton.click();
	const confirmDialog = page.getByRole("dialog").filter({has:page.locator(".wiki-cell-delete-actions")}).last();
	assert.equal(await confirmDialog.getByRole("button").count(), 2);
	await confirmDialog.getByRole("button", {name:/取消|Cancel/}).click();
	assert.equal(await cells.count(), 5);
	await deleteButton.click();
	await confirmDialog.getByRole("button", {name:/确定|OK/i}).click();
	assert.equal(await cells.count(), 4);
	await cells.nth(1).click({position:{x:5,y:8}});
	assert.equal(await page.locator("pre[data-frame-selected]").count(), 3);
	await cells.nth(1).locator("code").click();
	await page.keyboard.press("End");
	await page.keyboard.press("Backspace");
	assert.equal(await cells.count(), 4);
	await cells.nth(1).click({position:{x:5,y:8}});
	await page.keyboard.press("Backspace");
	assert.equal(await cells.count(), 1);
	assert.equal(await cells.locator("code").textContent().then(text => text.trim()), "# separate");
	await page.locator('.wiki-tree-main[title="worksheet.markdown"]').click();
	await page.waitForURL(url => url.searchParams.get("doc") === "worksheet.markdown");
	assert.equal(readFileSync(join(dir, "notes.md"), "utf8").trim(), "```python\n# separate\n```");
	const run = page.locator("[data-code-run-kernel]");
	await cells.filter({hasText:"read_csv"}).waitFor();
	await run.nth(3).waitFor();
	assert.equal(await run.count(), 4);
	const modifiedAt = statSync(join(dir,"worksheet.markdown")).mtimeMs;
	await page.route("**/api/wiki", async route => {
		if (route.request().postDataJSON().action !== "notebook-run") return route.continue();
		await route.fulfill({body: JSON.stringify({error:"ModuleNotFoundError: No module named 'ipykernel'"})+"\n"});
	});
	await run.nth(2).click();
	await page.getByRole("button",{name:/安装 Notebook|Install notebook runtime/}).waitFor();
	await page.unroute("**/api/wiki");
	if (python) {
		await run.first().click();
		await page.locator(".nb-output table").waitFor({timeout:60000});
		await page.getByText("Out[1]:", {exact:true}).waitFor();
		assert.equal(await page.locator(".wiki-cell-prompt").first().textContent(), "In [1]:");
		await run.nth(1).click();
		await page.locator(".nb-output img").waitFor({timeout:60000});
		await run.nth(3).click();
		await page.locator(".nb-output pre").filter({hasText:"42"}).waitFor();
		assert.equal(await page.locator(".nb-output").count(), 4);
		assert.equal(statSync(join(dir,"worksheet.markdown")).mtimeMs, modifiedAt);
		assert.equal(readFileSync(join(dir,"worksheet.markdown"),"utf8"), markdown);
		const codes = page.locator(".wiki-prose pre > code");
		await codes.nth(3).evaluate(code => {
			code.textContent = "import time\nprint('started',flush=True)\ntime.sleep(40)";
			code.dispatchEvent(new InputEvent("input", {bubbles:true}));
		});
		await page.getByText(/代码已修改|Code modified/).waitFor();
		await run.nth(3).click();
		await page.locator(".nb-output pre").filter({hasText:"started"}).waitFor();
		await run.nth(3).click();
		await page.locator(".nb-output pre").filter({hasText:"KeyboardInterrupt"}).waitFor();
		await run.nth(3).click();
		await page.locator(".nb-output pre").filter({hasText:"started"}).waitFor();
		await codes.nth(3).evaluate(code => {
			const editor = code.closest("[contenteditable=true]");
			code.closest("[data-rich-block]").remove();
			editor.dispatchEvent(new InputEvent("input", {bubbles:true}));
		});
		const confirmation = page.waitForEvent("dialog");
		const navigate = page.locator('.wiki-tree-main[title="notes.md"]').click();
		await (await confirmation).dismiss();
		await navigate;
		assert.equal(new URL(page.url()).searchParams.get("doc"), "worksheet.markdown");
		page.once("dialog", dialog => dialog.accept());
		await page.locator('.wiki-tree-main[title="notes.md"]').click();
		await page.waitForURL(url => url.searchParams.get("doc") === "notes.md");
		await page.locator('.wiki-tree-main[title="worksheet.markdown"]').click();
		await page.waitForURL(url => url.searchParams.get("doc") === "worksheet.markdown");
		await page.locator("pre.codeblock:has([data-code-run-kernel]) > code").filter({hasText:"read_csv"}).waitFor();
		await run.nth(2).waitFor();
		assert.equal(await run.count(), 3);
		assert.equal(await page.locator(".nb-output").count(), 0);
	}
	await page.locator('.wiki-tree-main[title="analysis.ipynb"]').click();
	const notebook = page.locator(".nb-editor");
	await notebook.waitFor();
	await notebook.locator("textarea").fill("import pandas as pd\ndf = pd.read_csv('data.csv')\ndf");
	await notebook.getByRole("button", {name:"Python", exact:true}).click();
	await notebook
		.locator("textarea")
		.nth(1)
		.fill("import matplotlib.pyplot as plt\nprint(df.value.sum())\nplt.plot(df.value)\nplt.show()");
	if (python) {
		await notebook.locator("section").first().getByRole("button", {name:/^(运行|Run)$/}).click();
		await notebook.locator(".nb-output table").waitFor();
		await notebook.locator("section").nth(1).getByRole("button",{name:/^(运行|Run)$/}).click();
		await notebook
			.locator(".nb-output img")
			.waitFor({ timeout: 60000 })
			.catch(async (e) => {
				throw new Error(await notebook.innerText(), { cause: e });
			});
		assert.match(await notebook.locator("table").innerText(), /42/);
		await page.waitForTimeout(1500);
		const file = join(dir, "analysis.ipynb");
		assert.equal(JSON.parse(readFileSync(file)).cells[1].execution_count, 2);
		execFileSync(python, [
			"-c",
			"import nbformat,sys; nbformat.validate(nbformat.read(sys.argv[1],as_version=4))",
			file,
		]);
	}
	await page.waitForFunction(() => !document.querySelector(".wiki-conflict"));
	for (let i = 0; i < 50 && JSON.parse(readFileSync(join(dir, "analysis.ipynb"))).cells.length !== 2; i++)
		await page.waitForTimeout(100);
	await page.reload();
	await notebook.locator("textarea").nth(1).waitFor();
	assert.match(await notebook.locator("textarea").first().inputValue(), /read_csv/);
	await notebook.locator(".nb-options").click();
	await notebook.getByRole("checkbox").check();
	await notebook.locator("textarea").nth(1).fill("print('unsaved selected cell')");
	await page.locator(".wiki-ask-toggle").click();
	await page.locator(".wiki-assistant textarea").fill("Explain this cell");
	await page.locator(".wiki-assistant textarea").press("Enter");
	for (let i=0; i<100 && !sent.some(m => m.type === "prompt"); i++) await page.waitForTimeout(100);
	const attachment = sent.find(m => m.type === "prompt")?.attachments.find(a=>a.editorSnapshot);
	assert.match(attachment.editorSnapshot.text, /Cell 2 · code · selected/);
	assert.match(attachment.editorSnapshot.text, /unsaved selected cell/);
	assert.doesNotMatch(attachment.editorSnapshot.text, /base64|read_csv|image\/png/);
	await page.locator('.wiki-tree-main[title="deletion.ipynb"]').click();
	const deletion = page.locator(".nb-editor");
	await deletion.locator("textarea").nth(1).waitFor();
	await page.waitForTimeout(300);
	const interrupt = page.getByRole("button", {name:/中断并继续|Interrupt and continue/i});
	if (await interrupt.count()) await interrupt.click();
	if (await page.locator(".wiki-assistant").isVisible()) await page.locator(".wiki-ask-toggle").click();
	await deletion.locator(".nb-options").click();
	await deletion.getByRole("checkbox").check();
	await deletion.locator("textarea").nth(1).click();
	await deletion.locator(".nb-cell-actions summary").click();
	await deletion.locator(".nb-delete").click();
	await deletion.locator("textarea").waitFor();
	assert.equal(await deletion.locator("textarea").count(), 1);
	assert.equal(await deletion.locator("textarea").inputValue(), "first");
	assert.equal(await deletion.locator("section").first().locator(".nb-cell-actions").count(), 1);
	await deletion.locator(".nb-cell-actions summary").click();
	await deletion.locator(".nb-delete").click();
	await deletion.locator("section").waitFor({state:"detached"});
	const assistant = page.locator(".wiki-assistant textarea");
	if (!await assistant.isVisible()) await page.locator(".wiki-ask-toggle").click();
	await assistant.fill("Do not send an empty notebook selection");
	const promptsBefore = sent.filter(message => message.type === "prompt").length;
	await assistant.press("Enter");
	await page.getByText(/没有可引用的单元|no cell to reference/).waitFor();
	await page.waitForTimeout(100);
	assert.equal(sent.filter(message => message.type === "prompt").length, promptsBefore);
	if (python) {
		await deletion.getByRole("button", {name:"Python", exact:true}).click();
		await deletion.locator("textarea").fill("import os,signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nprint(f'kernel-pid={os.getpid()}',flush=True)\nwhile True: pass");
		await deletion.locator("section").getByRole("button", {name:/^(运行|Run)$/}).click();
		const pidOutput = deletion.locator(".nb-output pre").filter({hasText:"kernel-pid="});
		await pidOutput.waitFor();
		const kernelPid = Number(/kernel-pid=(\d+)/.exec(await pidOutput.textContent())?.[1]);
		assert(kernelPid > 0);
		const exited = new Promise(resolve => server.once("exit", resolve));
		server.kill("SIGTERM");
		assert.equal(await exited, 0);
		for (let i = 0; i < 50; i++) {
			try { process.kill(kernelPid, 0); } catch (error) { assert.equal(error.code, "ESRCH"); break; }
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		assert.throws(() => process.kill(kernelPid, 0), error => error.code === "ESRCH");
	}
	console.log(
		"PASS Wiki Markdown creation, kernel controls and notebook editing, save and reload" +
			(python ? ", shared kernel, CSV, table, plot, nbformat validation" : ""),
	);
} finally {
	await browser?.close();
	server?.kill();
	rmSync(dir, { recursive: true, force: true });
}
