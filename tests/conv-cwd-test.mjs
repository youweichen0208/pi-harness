/** Per-project warm conversation reuse and visible-panel directory refresh. */
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";
import { mergeSnapshot } from "./lib/snapshots.mjs";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
const root = mkdtempSync(join(tmpdir(), "omp-cwd-")), A = join(root, "a"), B = join(root, "b"), data = join(root, "data"), agent = join(data, "omp/agent");
for (const directory of [A, B, agent]) mkdirSync(directory, { recursive: true });
writeFileSync(join(A, "only-in-A.txt"), "A\n");
writeFileSync(join(B, "only-in-B.txt"), "B\n");
writeFileSync(join(agent, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

let harness, ws, browser;
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: A, PI_WEB_DATA_DIR: data } });
	const clientId = randomUUID();
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	let seq = 0;
	const send = (msg) => ws.send(JSON.stringify({ ...msg, seq: ++seq }));

	// State mirrors
	let snapshot = null, ready = false;
	let conversations = [];
	let files = null;
	const notices = [], cwdResults = new Map();

	ws.on("message", (d) => {
		let m;
		try {
			m = JSON.parse(d.toString());
		} catch {
			return; // malformed frame — ignore
		}
		snapshot = mergeSnapshot(snapshot, m);
		if (m.type === "conversations") conversations = m.conversations;
		else if (m.type === "files") files = m;
		else if (m.type === "notice") notices.push(m.text);
		else if (m.type === "cwd_result") cwdResults.set(m.requestId, m);
		else if (m.type === "ready") {
			ready = true; console.log("ready");
			send({ type: "list_files", path: undefined });
		}
	});

	const waitFor = async (pred, what, timeout = 30000) => {
		const t0 = Date.now();
		while (Date.now() - t0 < timeout) {
			if (pred()) return true;
			await sleep(100);
		}
		throw Error(`Timed out waiting for ${what}`);
	};

	ws.on("open", () => {
		ws.send(JSON.stringify({ type: "hello", clientId }));
	});
	await waitFor(() => ready && snapshot !== null && !snapshot.isStreaming, "ready snapshot");

	// --- conv1 in A (server cwd) ---
	check("conv1 cwd = A", snapshot?.cwd === A, snapshot?.cwd);
	const conv1 = snapshot.conversationId;

	// --- new_chat: conv1 is BLANK → reused in place (ac5a4c8 semantics: the
	// active blank chat IS the new chat; clicking 新对话 must not pile up ids).
	// The active blank chat is visible in the sidebar immediately. ---
	send({ type: "new_chat" });
	await sleep(600); // any snapshot/delta would have arrived by now
	const conv2 = snapshot.conversationId;
	check(
		"new_chat reuses the blank active conversation (same id)",
		conv2 === conv1,
		`${conv1} → ${conv2}`,
	);
	check("conv2 cwd = A", snapshot?.cwd === A);
	await sleep(300);
	check(
		"blank active conversation is listed once in the sidebar",
		conversations.length === 1 && conversations[0]?.id === conv1,
		`${conversations.length} listed`,
	);

	const change = async (path, source) => {
		const requestId = randomUUID();
		send({ type: "set_cwd", path, source, requestId });
		await waitFor(() => cwdResults.has(requestId), "workspace acknowledgement");
		const result = cwdResults.get(requestId);
		if (!result.ok) throw Error(result.error);
		await waitFor(() => snapshot.cwd === path && !snapshot.isStreaming, "settled workspace");
	};
	// B gets its own conversation; A stays warm.
	await change(B, "ui");
	await waitFor(() => snapshot?.cwd === B, "cwd=B");
	send({ type: "list_files" });
	const convB = snapshot.conversationId;
	check(
		"set_cwd(B) → B gets its OWN conversation id",
		convB && convB !== conv2,
		`${conv2} → ${convB}`,
	);
	check("convB cwd = B", snapshot?.cwd === B);
	await waitFor(
		() => files?.entries?.some((e) => e.name === "only-in-B.txt"),
		"B file tree",
	);
	check("UI project switch has no timeline event", snapshot.cwdEvents.length === 0, JSON.stringify(snapshot.cwdEvents));
	check(
		"file tree shows B's files",
		files?.entries?.some((e) => e.name === "only-in-B.txt"),
	);

	// Returning to A reuses its runtime.
	await change(A);
	await waitFor(() => snapshot?.cwd === A, "cwd=A");
	send({ type: "list_files" });
	const convA2 = snapshot.conversationId;
	check(
		"set_cwd(A) → reuse A conversation",
		convA2 && convA2 !== convB && convA2 === conv2,
		`${convB} → ${convA2}`,
	);
	await waitFor(
		() => files?.entries?.some((e) => e.name === "only-in-A.txt"),
		"A file tree",
	);
	check(
		"file tree shows A's files",
		files?.entries?.some((e) => e.name === "only-in-A.txt"),
	);

	// Returning to B reuses its runtime.
	await change(B);
	await waitFor(
		() => snapshot?.cwd === B && snapshot?.conversationId === convB,
		"cwd=B again",
	);
	check(
		"set_cwd(B) again → reuse B conversation",
		snapshot?.conversationId === convB,
		`${convB} → ${snapshot?.conversationId}`,
	);

	// --- conversations summary: only current project, and nothing listed ---
	await sleep(300);
	check(
		"conversation summaries belong to B",
		conversations.every((c) => c.cwd === B),
		`${conversations.length} listed`,
	);
	check("workspace switches do not use toast notices", !notices.some((n) => n.includes("已切换到工作目录")), notices.join(" | "));
	check("command switch produces conversation event", snapshot.cwdEvents.some((event) => event.cwd === B), JSON.stringify(snapshot.cwdEvents));
	check("exactly one command event belongs to B", snapshot.cwdEvents.length === 1 && snapshot.messages.length === 0);
	if (process.argv.includes("--browser")) {
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		const page = await browser.newPage();
		await page.addInitScript(id => sessionStorage.setItem("pi-web-client-id", id), clientId);
		await page.goto(`http://127.0.0.1:${harness.port}`);
		await page.locator(".setup-modal .modal-close").click({ timeout: 30000 });
		const event = page.locator(".cwd-event");
		await event.filter({ hasText: B }).waitFor();
		check("command event renders in an otherwise empty chat", await event.count() === 1);
		await change(A, "ui");
		await event.filter({ hasText: A }).waitFor();
		check("browser switches to A's event without retaining B", await event.count() === 1);
		await page.reload();
		await event.filter({ hasText: A }).waitFor({ timeout: 30000 });
		check("browser reload restores the native event without duplication", await event.count() === 1);
	}

	console.log("--- conversation summaries ---");
	for (const c of conversations)
		console.log(`  ${c.id} title="${c.title}" cwd=${c.cwd}`);
	console.log("--- notices ---");
	for (const n of notices) console.log("  ", n);

} finally {
	await browser?.close(); ws?.terminate(); await harness?.stop(); rmSync(root, { recursive: true, force: true });
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures ? 1 : 0;
