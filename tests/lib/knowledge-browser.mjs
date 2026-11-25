import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./chrome.mjs";

/** Exercise the real renderer against the same isolated fixture model and server. */
export async function verifyKnowledgeBrowser({ port, scripted, tool, repoA, repoB, library }) {
	const targetLine = 6001, filename = "knowledge-browser.ts";
	const deepFile = join(repoB, filename);
	writeFileSync(deepFile, "// context\n".repeat(targetLine - 1) + 'events.on("volume.expanded", id => tasks.complete(id));\n');
	writeFileSync(join(repoA, filename), 'events.emit("volume.expanded", task.id);\n');
	const browser = await chromium.launch({ executablePath: CHROME_PATH || undefined, headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		const sent = [];
		let upstream, currentScope, producerId, deepId, wikiId, lateRead, deliverLate, catalog, onWorkspaceResult;
		await page.routeWebSocket("**/ws", route => {
			upstream = route.connectToServer();
			route.onMessage(raw => {
				const message = JSON.parse(String(raw));
				sent.push(message);
				upstream.send(raw);
			});
			upstream.onMessage(raw => {
				const message = JSON.parse(String(raw));
				if (message.type === "project_workspaces") catalog = message.catalog;
				if (message.type === "project_workspace_result") onWorkspaceResult?.(message);
				if (lateRead && message.type === "file_content" && message.evidence?.id === lateRead) {
					deliverLate = () => route.send(raw);
				} else route.send(raw);
			});
		});
		await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "knowledge-browser"));
		await page.goto(`http://127.0.0.1:${port}`);
		const composer = page.locator(".inputbox textarea:visible");
		await composer.waitFor();
		// Fresh clients can resume the Learn session. Give this client its own branch and empty history.
		upstream.send(JSON.stringify({ type: "new_chat" }));
		await page.locator(".messages .empty-state").waitFor();
		await composer.fill("/ask");
		await page.locator(".slash-name").filter({ hasText: /^\/ask$/ }).first().waitFor();
		await composer.fill("/skill:learn");
		await page.locator(".slash-name").filter({ hasText: /^\/skill:learn$/ }).first().waitFor();
		const submit = async text => {
			await composer.fill(text);
			await page.locator(".inputbox .btn.send:visible").click();
		};
		const lastTool = request => {
			const result = request.messages.findLast(message => message.role === "tool" || message.role === "toolResult");
			return typeof result.content === "string" ? result.content : result.content.map(part => part.text ?? "").join("\n");
		};
		const readId = request => {
			const id = /evidenceId (ev_[a-f0-9]{32})/.exec(lastTool(request))?.[1];
			assert(id, "source read issued a citation");
			return id;
		};
		scripted.push(tool("knowledge_sources", {}), request => {
			currentScope = JSON.parse(lastTool(request)).sources;
			const producer = currentScope.find(source => source.name === "repo-a");
			return tool("source_read", { sourceId: producer.id, path: filename, startLine: 1, limit: 1 })(request);
		}, request => {
			producerId = readId(request);
			assert.match(lastTool(request), /events\.emit\("volume\.expanded"/);
			const repo = currentScope.find(source => source.name === "repo-b");
			return tool("source_read", { sourceId: repo.id, path: filename, startLine: targetLine - 2, limit: 3 })(request);
		}, request => {
			deepId = readId(request);
			assert.match(lastTool(request), /tasks\.complete\(id\)/);
			const wiki = currentScope.find(source => source.kind === "knowledge");
			return tool("source_read", { sourceId: wiki.id, path: "history.md", limit: 1 })(request);
		}, request => {
			wikiId = readId(request);
			// The link label intentionally names the wrong path. Opening uses only the evidence ID.
			return { content: [
				"repo-a publishes the event that repo-b handles to complete the task.",
				"```mermaid\nflowchart LR\nA[repo-a] -->|volume.expanded| B[repo-b]\n```",
				`[repo-a/${filename}:1](#pi-evidence=${producerId}) → [repo-b/${filename}:${targetLine}](#pi-evidence=${deepId})`,
				`[wrong/local.md](#pi-evidence=${wikiId}) · [missing citation](#pi-evidence=ev_00000000000000000000000000000000)`,
			].join("\n\n") };
		});
		await submit("/ask Trace the volume expansion completion event across the workspace.");
		const diagram = page.locator(".msg-assistant .mermaid-svg svg").last();
		await diagram.waitFor();
		const diagramText = await diagram.textContent();
		for (const label of ["repo-a", "volume.expanded", "repo-b"]) assert(diagramText.includes(label));
		const producer = page.getByRole("link", { name: `repo-a/${filename}:1`, exact: true }).last();
		const deep = page.getByRole("link", { name: `repo-b/${filename}:${targetLine}`, exact: true }).last();
		const wiki = page.getByRole("link", { name: "wrong/local.md" }).last();
		const preview = page.locator(".fp-evidence");
		await producer.click();
		await preview.locator('[data-line="1"].from-tool').filter({ hasText: 'events.emit("volume.expanded"' }).waitFor();
		assert.match(await preview.locator(".fp-file-path").innerText(), /repo-a\/knowledge-browser\.ts:1/);
		await deep.click();
		const row = preview.locator(`[data-line="${targetLine}"].from-tool`);
		await row.waitFor();
		assert.match(await row.innerText(), /tasks\.complete\(id\)/);
		assert.equal(await row.evaluate(el => Math.abs(el.getBoundingClientRect().top - el.closest(".fp-code").getBoundingClientRect().top) < el.closest(".fp-code").clientHeight), true);
		assert.match(await preview.locator(".fp-file-path").innerText(), /repo-b\/knowledge-browser\.ts:5999–6001/);
		assert.equal(await preview.locator("textarea, [contenteditable=true], .fp-reference, .fp-quote-selection, .fp-header-save").count(), 0);
		assert.equal(await page.locator(".inputbox .attach-chip.current-file").count(), 0);
		const firstRead = sent.find(m => m.type === "read_file" && m.evidenceId === deepId);
		assert(firstRead?.requestId && firstRead.conversationId);
		assert.equal(firstRead.cwd, repoA);
		assert.equal(firstRead.path, "");
		assert.equal(firstRead.line, targetLine);
		await wiki.click();
		await preview.locator('[data-line="1"] .fp-code-text').filter({ hasText: "# Historical note" }).waitFor();
		assert.match(await preview.locator(".fp-file-path").innerText(), /library\/history\.md:1/);
		assert.equal(await page.locator(".single-document-editor:visible").count(), 0);
		await page.getByRole("link", { name: "missing citation" }).click();
		await preview.getByRole("alert").waitFor();
		const workspaceAction = async kind => {
			const requestId = `browser-${kind}`;
			assert(catalog);
			const result = new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`Missing Workspace reply for ${requestId}`)), 5000);
				onWorkspaceResult = response => {
					if (response.requestId === requestId) { clearTimeout(timer); resolve(response); }
				};
			});
			upstream.send(JSON.stringify({ type: "project_workspace_action", revision: catalog.revision, requestId,
				action: { kind, id: "workspace-a", path: repoB } }));
			assert.equal((await result).ok, true);
		};
		await workspaceAction("remove");
		await deep.click();
		await preview.getByRole("alert").waitFor();
		assert.equal(await preview.locator("[data-line]").count(), 0);
		await workspaceAction("add");
		writeFileSync(deepFile, "// new bytes\n");
		await deep.click();
		await preview.getByText(/原文件内容已更改|source file has changed/i).waitFor();
		assert.equal(await preview.locator("[data-line]").count(), 0);
		await preview.locator(".fp-back").click();

		const excluded = currentScope.find(source => source.name === "repo-b");
		scripted.push(tool("knowledge_sources", {}), request => {
			const permitted = JSON.parse(lastTool(request)).sources;
			assert(permitted.some(source => source.name === "repo-a"));
			assert(!permitted.some(source => source.id === excluded.id));
			return tool("source_read", { sourceId: excluded.id, path: filename, startLine: targetLine, limit: 1 })(request);
		}, request => {
			assert.match(lastTool(request), /不在本次请求允许的范围内/);
			assert.doesNotMatch(lastTool(request), /evidenceId ev_|tasks\.complete/);
			return { content: "The consumer cannot be verified within this request's sources." };
		});
		await submit("/ask Trace the completion event; exclude repo-b.");
		const restricted = page.locator(".msg-assistant").filter({ hasText: "The consumer cannot be verified within this request's sources." }).last();
		await restricted.waitFor();
		assert.equal(await restricted.locator('a[href^="#pi-evidence="], .mermaid-svg').count(), 0);
		console.log("PASS browser cross-repository event, rendered Mermaid, clickable evidence on both ends and narrowed Ask scope");

		const draft = "browser-unapproved.md";
		scripted.push(tool("knowledge_write", { path: draft, title: "Browser confirmation", text: "# Browser confirmation\n\nBrowser-only draft.\n" }), () => ({ content: "Browser Learn cancelled." }));
		await submit("/learn Review this browser confirmation.");
		const dialog = page.locator('[data-dialog-kind="confirm"]');
		await dialog.waitFor();
		assert.match(await dialog.innerText(), /Browser-only draft/);
		await dialog.getByRole("button", { name: /取消|cancel/i }).click();
		await page.getByText("Browser Learn cancelled.", { exact: true }).last().waitFor();
		assert(!existsSync(join(library, draft)));

		lateRead = wikiId;
		await wiki.click();
		await page.waitForFunction(() => document.querySelector(".fp-evidence [role=status]"));
		for (let i = 0; !deliverLate && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 25));
		assert(deliverLate, "server returned the deliberately delayed evidence response");
		upstream.send(JSON.stringify({ type: "new_chat" }));
		await preview.waitFor({ state: "hidden" });
		deliverLate();
		lateRead = undefined;
		assert.equal(await preview.count(), 0);
		upstream.send(JSON.stringify({ type: "switch_conversation", id: firstRead.conversationId }));
		await wiki.click();
		await preview.locator('[data-line="1"]').waitFor();
		upstream.send(JSON.stringify({ type: "set_cwd", path: repoB, requestId: "browser-project-switch", source: "ui" }));
		await preview.waitFor({ state: "hidden" });
		assert(!sent.some(message => message.type === "write_file"));
		console.log("PASS browser commands, Learn confirmation, deep source and Markdown citations, stale and revoked evidence, conversation and project switches");
	} finally { await browser.close(); }
}
