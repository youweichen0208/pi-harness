// Independent oracle for the pinned real case. Run only on the evaluation corpus.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SampleGraph } from "./lightweight.mjs";

const corpus = JSON.parse(await readFile(new URL("./corpus.json", import.meta.url), "utf8"));
const root = resolve(process.argv[2] || fileURLToPath(new URL("../../.scratch/graph-eval/samples", import.meta.url)));
const producer = "sdk/packages/coding-agent/src/core/agent-session.ts";
const consumer = "harness/server/agent-service.ts";
const receiver = "harness/server/conversation.ts";
const route = {
	emit: [producer, 1150], broadcast: [producer, 1106], register: [producer, 1458],
	receiver: [receiver, 47], subscribe: [consumer, 935], forward: [consumer, 938],
	guard: [consumer, 1088], write: [consumer, 1092],
};
const group = ["sdk", "harness"];
const temp = await mkdtemp(join(tmpdir(), "pi-graph-oracle-"));
const graph = new SampleGraph();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const ledger = [];

async function check(label, count, sources = group, shiftedFile) {
	graph.refresh(temp, sources);
	const paths = graph.query("agent_settled", "conv.lastTaskEndedAt").paths;
	assert.equal(paths.length, count, label);
	for (const path of paths) {
		for (const [role, [file, line]] of Object.entries(route)) {
			const anchor = path[role];
			assert.ok(sources.includes(anchor.source), role);
			assert.equal(anchor.source + "/" + anchor.path, file, role);
			assert.equal(anchor.line, line + Number(file === shiftedFile), role);
			assert.equal(anchor.sha256, digest(await readFile(join(temp, file))), role);
		}
	}
	ledger.push({ label, paths: count });
}

async function variant(label, file, original, replacement, expected, shiftedFile) {
	const full = join(temp, file);
	const before = await readFile(full, "utf8");
	assert.equal(before.split(original).length, 2, "mutation must be unique: " + label);
	try {
		await writeFile(full, before.replace(original, replacement));
		await check(label, expected, group, shiftedFile);
	} finally { await writeFile(full, before); }
}

try {
	for (const [source, entry] of Object.entries(corpus)) {
		for (const [path, sha] of Object.entries(entry.files)) {
			const from = join(root, source, path);
			assert.equal(digest(await readFile(from)), sha, "pinned input " + path);
			await cp(from, join(temp, source, path));
		}
	}
	await check("baseline and same-name extension channel", 1);
	await variant("inherited noEmit suppresses the declaration bridge", "sdk/tsconfig.base.json",
		'"declaration": true', '"noEmit": true, "declaration": true', 0);
	await variant("declaration emission disabled", "sdk/tsconfig.base.json",
		'"declaration": true', '"declaration": false', 0);
	const switchStart = 'switch (event.type) {\n\t\t\tcase "bash_execution_update":';
	await variant("handler returns for the matching tag", consumer, switchStart, 'if (event.type === "agent_settled") return; ' + switchStart, 0);
	await variant("handler returns on an unresolved condition", consumer, switchStart, 'if (conv.stallNoticed) return; ' + switchStart, 0);
	await variant("handler replaces the event before the switch", consumer, switchStart, 'event = { type: "agent_start" }; ' + switchStart, 0);
	await variant("handler retags the incoming object", consumer, switchStart, 'event.type = "agent_start"; ' + switchStart, 0);
	await variant("unrelated event tag guard does not block the target", consumer, switchStart, 'if (event.type === "message_end") return; ' + switchStart, 1);
	await variant("only extension channel still emits the queried event", producer,
		'this._emit({ type: "agent_settled", aborted });', 'this._emit({ type: "alternate", aborted });', 0);
	await variant("forwarded event replaced before dispatch", consumer,
		"try { this.onEvent(conv, event); }", 'try { this.onEvent(conv, { type: "agent_start" }); }', 0);
	await variant("matching event filtered before callback forwarding", consumer,
		"try { this.onEvent(conv, event); }",
		'if (event.type === "agent_settled") return; try { this.onEvent(conv, event); }', 0);
	await variant("callback parameter reassigned", consumer, "try { this.onEvent(conv, event); }",
		'event = { type: "agent_start" }; try { this.onEvent(conv, event); }', 0);
	await variant("unreachable producer", producer, 'this._emit({ type: "agent_settled", aborted });',
		'while (false) this._emit({ type: "agent_settled", aborted });', 0);
	await variant("consumer handles a different event", consumer,
		'case "agent_settled": {', 'case "alternate": {', 0);
	await variant("uncommitted line shift refreshes provenance", receiver,
		'session: AgentSession;', '\nsession: AgentSession;', 1, receiver);
	const original = join(temp, receiver);
	await rename(original, join(dirname(original), "renamed.ts"));
	await check("removed type bridge after rename", 0);
	await rename(join(dirname(original), "renamed.ts"), original);
	await check("removed publisher from workspace", 0, ["harness"]);
	await check("re-added publisher", 1);

	// A consumer may describe the same property name while having another
	// package identity. The prior answer must disappear without a source edit.
	await variant("package identity changed", "harness/package.json",
		'"@earendil-works/pi-coding-agent": "1.6.0"', '"@earendil-works/pi-coding-agent": "9.9.9"', 0);
	await check("restored package identity", 1);
	console.log(JSON.stringify(ledger, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
