// Self-contained WS regression: request identity, versions, errors and workspace checks.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";
import { testEnv } from "./lib/test-env.mjs";
const root = realpathSync(mkdtempSync(join(tmpdir(), "file-editor-ws-")));
const agent = join(root, "data/omp/agent"); mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
writeFileSync(join(root, "note.txt"), "before");
let harness, ws;
try {
	harness = await startIsolatedHarness({ env: { ...testEnv(), PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, "data") } });
	const port = harness.port;
	ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const messages = [];
	ws.on("message", (wire) => messages.push(JSON.parse(wire)));
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	const send = (msg) => ws.send(JSON.stringify(msg));
	const wait = async (predicate) => {
		for (let n = 0; n < 600; n++) {
			const index = messages.findIndex(predicate);
			if (index >= 0) return messages.splice(index, 1)[0];
			await sleep(50);
		}
		throw new Error("response timeout");
	};
	send({ type: "hello", clientId: "file-editor-protocol" });
	await wait((m) => m.type === "ready");
	send({ type: "get_state" });
	await wait((m) => m.type === "snapshot");
	send({ type: "read_file", path: "note.txt", cwd: root, requestId: "r1" });
	const content = await wait((m) => m.type === "file_content" && m.requestId === "r1");
	assert.equal(content.cwd, root);
	assert(content.version);
	send({ type: "write_file", path: "note.txt", cwd: root, requestId: "w1", expectedVersion: content.version, text: "after" });
	const saved = await wait((m) => m.type === "file_result" && m.requestId === "w1");
	assert.equal(saved.ok, true);
	assert.notEqual(saved.version, content.version);
	assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after");
	send({ type: "write_file", path: "note.txt", cwd: root, requestId: "w2", expectedVersion: content.version, text: "stale" });
	assert.equal((await wait((m) => m.requestId === "w2")).conflict, true);
	send({ type: "write_file", path: "note.txt", cwd: root + "-wrong", requestId: "w3", force: true, text: "wrong workspace" });
	assert.equal((await wait((m) => m.requestId === "w3")).ok, false);
	assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after");
	send({ type: "read_file", path: "missing", cwd: root, requestId: "r2" });
	assert.equal((await wait((m) => m.requestId === "r2")).ok, false);
	for (const [requestId, path, cwd] of [["context-workspace", "note.txt", root + "-wrong"], ["context-path", "../outside.txt", root]]) {
		send({ type: "prompt", requestId, text: "must reject before calling agent", attachments: [{ path, editorSnapshot: { cwd, text: "draft", dirty: true } }] });
		assert.equal((await wait((m) => m.type === "prompt_result" && m.requestId === requestId)).ok, false);
	}
	console.log("PASS versioned file WS protocol and editor context rejection");
} finally {
	ws?.terminate();
	await harness?.stop();
	rmSync(root, { recursive: true, force: true });
}
