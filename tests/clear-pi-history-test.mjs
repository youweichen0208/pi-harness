import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { testEnv } from "./lib/test-env.mjs";
import { planPiHistoryCleanup, applyPiHistoryCleanup } from "../scripts/clear-pi-history.mjs";

const root = mkdtempSync(join(tmpdir(), "clear-pi-history-"));
const agentDir = join(root, "agent"), dataDir = join(root, "data"), wiki = `wiki/${"a".repeat(64)}`;
const transcript = JSON.stringify({ type: "session", id: "old-pi", timestamp: new Date().toISOString() }) + "\n";
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path; };
try {
	const removed = [
		put(join(agentDir, "sessions/project/session.jsonl"), transcript),
		put(join(dataDir, "playground-chat/old/session.jsonl"), transcript),
		put(join(dataDir, "playground-chat/state.json"), "{}"),
		put(join(dataDir, "node-sessions/client/node/session.jsonl"), transcript),
		put(join(dataDir, "subagent-tasks/session/task.json"), "old research details"),
		put(join(dataDir, "subagent-tasks/session/task.json.summary.json"), "old research summary"),
		put(join(dataDir, `${wiki}/sessions/session.jsonl`), transcript),
		put(join(dataDir, `${wiki}/sessions/old-pi.meta.json`), "{}"),
		put(join(dataDir, "thinking-durations.json"), "{}"),
	];
	const kept = [
		put(join(agentDir, "auth.json"), "credential fixture"),
		put(join(agentDir, "settings.json"), "settings fixture"),
		put(join(agentDir, "models.json"), "128000"),
		put(join(dataDir, "omp/sessions/chat/session.jsonl"), transcript),
		put(join(dataDir, "omp/playground-chat/state.json"), "OMP history"),
		put(join(dataDir, "node-sessions/client/node/omp-session.json"), "OMP pointer"),
		put(join(dataDir, `${wiki}/history.json`), "document revisions"),
		put(join(dataDir, `${wiki}/blobs/file.txt`), "document revision body"),
		put(join(dataDir, "client-state.json"), "preferences"),
		put(join(dataDir, "prompt-receipts.json"), "deduplication tombstones"),
		put(join(dataDir, "uploads/file.txt"), "attachment"),
		put(join(dataDir, "playground-chat/old/dataset.jsonl"), '{"customer":"fixture"}\n'),
	].map(path => [path, readFileSync(path, "utf8")]);
	const plan = planPiHistoryCleanup({ agentDir, dataDirs: [dataDir] });
	assert.deepEqual(plan.map(file => file.path).sort(), removed.sort());
	assert(removed.every(existsSync), "preview must not delete");
	if (process.platform !== "win32") {
		const server = createServer(socket => socket.end());
		server.listen(join(dataDir, "pi-harness.sock")); await once(server, "listening");
		try {
			assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/clear-pi-history.mjs", import.meta.url)), "--data-dir", dataDir, "--apply"], { env: testEnv(), stdio: "pipe" }), /Close the application/);
			assert(removed.every(existsSync), "live server must prevent deletion");
		} finally { await new Promise(resolve => server.close(resolve)); }
	}
	writeFileSync(removed[0], transcript + "changed\n");
	assert.throws(() => applyPiHistoryCleanup(plan), /changed/);
	assert(removed.every(existsSync), "changed selection must fail before any deletion");
	applyPiHistoryCleanup(planPiHistoryCleanup({ agentDir, dataDirs: [dataDir] }));
	assert(removed.every(path => !existsSync(path)));
	for (const [path, content] of kept) assert.equal(readFileSync(path, "utf8"), content);
	assert.deepEqual(planPiHistoryCleanup({ agentDir, dataDirs: [dataDir] }), []);
	const external = put(join(root, "external/session.jsonl"), transcript);
	symlinkSync(dirname(external), join(agentDir, "sessions/linked"), process.platform === "win32" ? "junction" : "dir");
	assert.throws(() => planPiHistoryCleanup({ agentDir, dataDirs: [dataDir] }), /symlink/);
	assert(existsSync(external));
	console.log("PASS explicit Pi history cleanup: preview, changed-file refusal, retained OMP/config/project data and symlink boundary");
} finally { rmSync(root, { recursive: true, force: true }); }
