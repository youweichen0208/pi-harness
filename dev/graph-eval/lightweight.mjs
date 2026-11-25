// Offline M2 candidate. All compiler inputs, including type bridges, come from
// the supplied sample. A query over a narrower scope gets its own program.
import ts from "typescript";
import { analyze } from "../../server/workspace-graph-extractor.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { posix } = path;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function readScope(root, sources) {
	const names = new Set(readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name));
	const files = new Map();
	function walk(id) {
		for (const entry of readdirSync(path.join(root, id), { withFileTypes: true })) {
			const key = posix.join(id, entry.name);
			if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name)) walk(key);
			if (!entry.isFile() || !/\.ts$|^package\.json$|^tsconfig[^/]*\.json$/.test(entry.name)) continue;
			const bytes = readFileSync(path.join(root, key));
			files.set("/" + key, { text: bytes.toString("utf8"), sha256: hash(bytes) });
		}
	}
	for (const source of new Set(sources)) {
		if (!names.has(source) || lstatSync(path.join(root, source)).isSymbolicLink()) throw Error("Unknown sample source " + source);
		walk(source);
	}
	return files;
}

export class SampleGraph {
	#files = new Map();
	#parsed = new Map();
	#graph = { paths: [], candidates: [] };
	refresh(root, sources) {
		const start = performance.now();
		const files = readScope(root, sources);
		const changed = [...files].filter(([id, f]) => this.#files.get(id)?.sha256 !== f.sha256);
		const removed = [...this.#files.keys()].filter(id => !files.has(id));
		let parsedFiles = 0;
		if (changed.length || removed.length) {
			for (const id of removed) this.#parsed.delete(id);
			for (const [id, file] of changed) {
				if (!id.endsWith(".ts")) continue;
				const tree = ts.createSourceFile(id, file.text, ts.ScriptTarget.Latest, true);
				if (tree.parseDiagnostics.length) this.#parsed.delete(id);
				else this.#parsed.set(id, tree);
				parsedFiles++;
			}
			this.#graph = analyze(files, this.#parsed);
			this.#files = files;
		}
		return { files: files.size, changed: changed.length, removed: removed.length, parsedFiles, ms: +(performance.now() - start).toFixed(2) };
	}
	query(eventValue, writeTarget) {
		const match = p => p.value === eventValue && (!writeTarget || p.target === writeTarget);
		return { paths: this.#graph.paths.filter(match), candidates: this.#graph.candidates.filter(match) };
	}
}

export function rereadAnchor(root, sources, anchor) {
	if (!sources.includes(anchor.source) || path.basename(anchor.source) !== anchor.source) throw Error("Evidence outside scope");
	const allowed = realpathSync(path.join(root, anchor.source));
	if (path.dirname(allowed) !== realpathSync(root)) throw Error("Invalid evidence source");
	const actual = realpathSync(path.join(allowed, anchor.path));
	if (!actual.startsWith(allowed + path.sep)) throw Error("Evidence outside source");
	const bytes = readFileSync(actual);
	if (hash(bytes) !== anchor.sha256) throw Error("Stale evidence " + anchor.path);
	const lines = bytes.toString("utf8").split(/\r?\n/);
	if (!Number.isInteger(anchor.line) || !Number.isInteger(anchor.endLine) || anchor.line < 1 || anchor.endLine < anchor.line || anchor.endLine > lines.length) throw Error("Invalid evidence lines");
	return lines.slice(anchor.line - 1, anchor.endLine).join("\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	const [root, value, target, ...sources] = process.argv.slice(2);
	if (!root || !value || !target || !sources.length) throw Error("Usage: node lightweight.mjs SAMPLE_DIR EVENT ASSIGNMENT_TARGET SOURCE_ID...");
	const graph = new SampleGraph();
	const cold = graph.refresh(root, sources);
	const warm = graph.refresh(root, sources);
	const result = graph.query(value, target);
	const readback = result.paths.map(path => path.anchors.map(a => ({ role: a.role, text: rereadAnchor(root, sources, a) })));
	console.log(JSON.stringify({ candidate: "typescript-listener-array", cold, warm, ...result, readback }, null, 2));
}
