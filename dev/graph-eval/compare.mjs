// Compare the owners nominated by each native index with the method bodies
// needed for the same independent source proof on a known-answer question.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { SampleGraph } from "./lightweight.mjs";

const here = new URL("./", import.meta.url);
const root = process.argv[2] ?? fileURLToPath(new URL("../../.scratch/graph-eval/samples/", here));
const engine = new SampleGraph();
engine.refresh(root, ["sdk", "harness"]);
const { paths } = engine.query("agent_settled", "conv.lastTaskEndedAt");
assert.equal(paths.length, 1);
assert.equal(paths[0].emit.line, 1150);

async function methodFor(anchor) {
	const input = await readFile(join(root, anchor.source, anchor.path), "utf8");
	const tree = ts.createSourceFile(anchor.path, input, ts.ScriptTarget.Latest, true);
	let owner;
	function visit(node) {
		const start = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
		const end = tree.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
		if (start > anchor.line || end < anchor.endLine) return;
		if (ts.isMethodDeclaration(node)) owner = { source: anchor.source, path: anchor.path, name: node.name.getText(), line: start };
		ts.forEachChild(node, visit);
	}
	visit(tree);
	assert.ok(owner, "Missing enclosing method: " + anchor.owner);
	return owner;
}

const required = new Map();
for (const anchor of paths[0].anchors) {
	if (anchor.role === "receiver") continue; // The interface field is supplied by the shared type checker.
	const owner = await methodFor(anchor);
	required.set(JSON.stringify(owner), owner);
}
for (const name of ["graphify", "gitnexus"]) {
	const { owners } = JSON.parse(await readFile(new URL(name + "-owners.json", here), "utf8"));
	const missing = [...required.values()].filter(ref => !owners.some(o =>
		o.source === ref.source && o.path === ref.path && o.name === ref.name && o.line === ref.line));
	console.log(JSON.stringify({ name, suppliedOwners: required.size - missing.length, missing, sourceVerifiedPaths: missing.length ? 0 : 1 }));
}
