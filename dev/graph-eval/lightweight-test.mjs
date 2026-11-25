// The synthetic fixture deliberately uses different method, field and tag names
// from the authentic sample. Each edit is made on disk between index refreshes.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SampleGraph, rereadAnchor } from "./lightweight.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "pi-graph-extractor-"));
const graph = new SampleGraph();
const all = ["library", "client", "bridge"];
const scenarios = [];
const event = "finished";
const writeTarget = "record.time";
const adapter = "bridge/src/index.ts";
const lib = "library/src/stream.ts";
const client = "client/src/recorder.ts";

function write(file, contents) {
	const out = path.join(root, file);
	mkdirSync(path.dirname(out), { recursive: true });
	writeFileSync(out, contents);
}
function pkg(folder, name, deps) {
	write(folder + "/package.json", JSON.stringify({ name, version: "1.0.0", dependencies: deps,
		exports: { ".": { types: "./types/index.d.ts" } }, scripts: { build: "tsc -p tsconfig.build.json" } }));
	write(folder + "/tsconfig.build.json", JSON.stringify({ compilerOptions: { rootDir: "./src", outDir: "./types", declaration: true } }));
}
function check(name, expected, scope = all, target = writeTarget) {
	const index = graph.refresh(root, scope);
	const { paths } = graph.query(event, target);
	assert.equal(paths.length, expected, name);
	for (const p of paths) for (const a of p.anchors) assert.ok(rereadAnchor(root, scope, a).trim());
	scenarios.push({ name, matched: paths.length, ...index });
	return paths[0];
}

const stream = `type Notice = { kind: string };
export class Stream {
	private hooks: ((n: Notice) => void)[] = [];
	private decoys: ((n: Notice) => void)[] = [];
	deliver(n: Notice) { for (const sink of this.hooks) { sink(n); } }
	attach(cb: (n: Notice) => void) { this.hooks.push(cb); }
	finish() { this.deliver({ kind: "finished" }); }
}`;
const host = `import { Stream } from "graph-bridge";
interface Book { channel: Stream; time: number; }
export class Recorder {
	listen(record: Book) { record.channel.attach((msg) => { this.handle(record, msg); }); }
	handle(record: Book, notice: {kind: string}) {
		switch (notice.kind) {
			case "finished": { record.time = 1; break; }
			case "ignored": { record.time = 0; break; }
		}
	}
}`;

try {
	pkg("library", "graph-src", {});
	pkg("bridge", "graph-bridge", { "graph-src": "1.0.0" });
	pkg("client", "graph-user", { "graph-bridge": "1.0.0" });
	write(adapter, 'export { Stream } from "graph-src";');
	write("library/src/index.ts", 'export { Stream } from "./stream.js";');
	write(client, host);
	check("missing producer", 0);
	write(lib, stream);
	const original = check("add exported producer", 1);
	check("unchanged refresh", 1);
	check("middle repository excluded", 0, ["library", "client"]);
	check("middle repository restored", 1);
	write(lib, stream.replace("this.hooks.push(cb)", "this.decoys.push(cb)"));
	assert.throws(() => rereadAnchor(root, all, original.emit), /Stale evidence/);
	check("same event and methods on disjoint listener arrays", 0);
	write(lib, stream.replace("sink(n)", 'sink({ kind: "other" })'));
	check("dispatcher substitutes payload", 0);
	write(lib, stream.replace('kind: "finished"', 'kind: "finished", ...{kind:"other"}'));
	check("spread overwrites discriminator", 0);
	write(lib, stream.replace('this.deliver({ kind: "finished" });', 'while (false) { this.deliver({ kind: "finished" }); }'));
	check("emission in dead loop", 0);
	write(lib, stream.replace('this.deliver({ kind: "finished" });', 'const b = true; if (b && !b) this.deliver({ kind: "finished" });'));
	check("conditional emission with contradictory predicate", 0);
	write(lib, stream);
	write(client, host.replace("this.handle(record, msg)", 'this.handle(record, {kind:"finished"})'));
	check("subscription discards received event", 0);
	write(client, host.replace("this.handle(record, msg)", 'if (msg.kind === "finished") return; this.handle(record, msg)'));
	check("tag filtered before callback forwards", 0);
	write(client, host.replace("this.handle(record, msg)", 'msg = {kind:"other"}; this.handle(record, msg)'));
	check("callback parameter reassigned", 0);
	write(client, host.replace("this.handle(record, msg)", 'return; this.handle(record, msg)'));
	check("unreachable forward after return", 0);
	write(client, host.replace("notice.kind", "record.time"));
	check("switch tests unrelated object", 0);
	write(client, host.replace("record.time = 1", '(() => { record.time = 1; })'));
	check("assignment in deferred closure", 0);
	write(client, host.replace("record.time = 1", 'if (true) { switch ("ignored") { case "ignored": record.time = 1; } }'));
	check("nested case cannot claim outer guard", 0);
	write(client, host.replace("channel: Stream;", "channel: {attach: Stream['attach']};").replace("record.channel.attach(", "({ attach(cb: (e: {kind: string}) => void) {} }).attach("));
	check("unrelated receiver with matching member and event names", 0);
	write(client, host);
	pkg("bridge", "graph-bridge", { "graph-src": "2.0.0" });
	check("producer dependency version mismatch", 0);
	pkg("bridge", "graph-bridge", { "graph-src": "1.0.0" });
	check("version rebound", 1);
	renameSync(path.join(root, lib), path.join(root, "library/src/moved.ts"));
	check("rename without updating export", 0);
	write("library/src/index.ts", 'export { Stream } from "./moved.js";');
	const moved = check("renamed producer rebound", 1);
	assert.equal(moved.emit.path, "src/moved.ts");
	assert.throws(() => rereadAnchor(root, ["library", "bridge"], moved.write), /outside scope/);
	rmSync(path.join(root, adapter));
	check("delete intermediary", 0);
	write(adapter, 'export { Stream } from "graph-src";');
	check("restore intermediary", 1);
	write(client, host.replaceAll("time", "timestamp"));
	check("previous consumer assignment invalidated", 0);
	check("renamed consumer assignment found", 1, all, "record.timestamp");
	rmSync(path.join(root, "library/src/moved.ts"));
	check("delete producer", 0);
	console.log(JSON.stringify({ scenarios }, null, 2));
} finally {
	rmSync(root, { recursive: true, force: true });
}
