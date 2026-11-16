#!/usr/bin/env node
// Explicit, local maintenance command. Never called automatically on upgrade.
import { lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function stat(path) {
	try { return lstatSync(path); }
	catch (error) { if (error.code === "ENOENT") return; throw error; }
}
function directory(path) {
	const entry = stat(path);
	if (!entry) return false;
	if (entry.isSymbolicLink() || !entry.isDirectory()) throw Error(`Expected a real directory: ${path}`);
	return true;
}
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Only selected legacy transcript locations; never walk omp, uploads or Wiki revisions. */
export function planPiHistoryCleanup({ agentDir, dataDirs = [] }) {
	const files = new Map();
	function add(path) {
		const entry = stat(path);
		if (!entry) return;
		if (!entry.isFile() || entry.isSymbolicLink()) throw Error(`Expected a regular history file: ${path}`);
		if (path.endsWith(".jsonl")) {
			let header;
			try { header = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]); } catch { return; }
			if (header?.type !== "session" || typeof header.id !== "string" || typeof header.timestamp !== "string") return;
		}
		files.set(path, { path, bytes: entry.size, hash: digest(path) });
	}
	function walk(path, accept) {
		if (!directory(path)) return;
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isSymbolicLink()) throw Error(`Refusing history symlink: ${child}`);
			if (entry.isDirectory()) walk(child, accept);
			else if (accept(entry.name)) add(child);
		}
	}
	if (agentDir && directory(resolve(agentDir))) walk(join(resolve(agentDir), "sessions"), name => name.endsWith(".jsonl"));
	for (const raw of dataDirs) {
		const root = resolve(raw);
		if (!directory(root)) continue;
		walk(join(root, "node-sessions"), name => name.endsWith(".jsonl"));
		walk(join(root, "subagent-tasks"), name => name.endsWith(".json") || name.endsWith(".json.tmp"));
		walk(join(root, "playground-chat"), name => name.endsWith(".jsonl"));
		for (const name of ["state.json", "prompt-receipts.json"]) add(join(root, "playground-chat", name));
		const wiki = join(root, "wiki");
		if (directory(wiki)) for (const entry of readdirSync(wiki, { withFileTypes: true })) {
			if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
			const workspace = join(wiki, entry.name);
			if (directory(workspace)) walk(join(workspace, "sessions"), name => name.endsWith(".jsonl") || name.endsWith(".meta.json"));
		}
		// The shared prompt-receipts ledger has no bodies and must remain to prevent duplicate execution.
		add(join(root, "thinking-durations.json"));
	}
	return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function applyPiHistoryCleanup(plan) {
	// Check the entire selection before deleting anything. A changed transcript means a writer is still active.
	for (const file of plan) {
		const entry = stat(file.path);
		if (!entry?.isFile() || entry.isSymbolicLink() || digest(file.path) !== file.hash) throw Error(`History changed since inspection: ${file.path}`);
	}
	for (const file of plan) unlinkSync(file.path);
}

async function refuseRunningServer(dataDir) {
	// On Windows callers must close the application first; pipe names are keyed by port, not data directory.
	if (process.platform === "win32") return;
	await new Promise((resolveCheck, reject) => {
		const socket = createConnection(join(resolve(dataDir), "pi-harness.sock"));
		socket.setTimeout(1500, () => { socket.destroy(); reject(Error("Cannot determine whether the old application is closed")); });
		socket.once("connect", () => { socket.destroy(); reject(Error(`Close the application using ${dataDir} before clearing history`)); });
		socket.once("error", error => { socket.destroy(); if (["ENOENT", "ECONNREFUSED"].includes(error.code)) resolveCheck(); else reject(error); });
	});
}

async function main() {
	const args = process.argv.slice(2), dataDirs = [];
	let agentDir, apply = false;
	while (args.length) {
		const arg = args.shift();
		if (arg === "--apply") apply = true;
		else if (["--agent-dir", "--data-dir"].includes(arg) && args[0] && !args[0].startsWith("--")) {
			const value = args.shift();
			if (arg === "--agent-dir") agentDir = value; else dataDirs.push(value);
		} else throw Error("Usage: clear-pi-history.mjs [--agent-dir PATH] [--data-dir PATH ...] [--apply]");
	}
	if (!agentDir && !dataDirs.length) throw Error("Specify the legacy directories explicitly; no default deletion targets");
	const plan = planPiHistoryCleanup({ agentDir, dataDirs });
	console.log(JSON.stringify({ action: apply ? "delete" : "preview", files: plan.map(({ path, bytes }) => ({ path, bytes })), totalBytes: plan.reduce((sum, file) => sum + file.bytes, 0) }, null, 2));
	if (apply) {
		for (const dataDir of dataDirs) await refuseRunningServer(dataDir);
		applyPiHistoryCleanup(plan);
		console.log(`Deleted ${plan.length} legacy history files.`);
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
