import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parentPort, workerData } from "node:worker_threads";
import type ts from "typescript";
import { ripgrepBinary } from "./code-search.js";
import { KNOWLEDGE_READ_LIMITS, knowledgeRelativePath } from "./knowledge-source-reader.js";
import { decodeText, looksLikeText } from "./text-sniff.js";
import type { GraphAnchor, GraphEdge, GraphNode } from "./protocol.js";
import type { ExtractAnchor, ExtractInput } from "./workspace-graph-extractor.mjs";
import type { GraphIndexResult, GraphIndexSource, GraphJob, GraphRepoIndex } from "./workspace-graph-index.js";

const exec = promisify(execFile);
const fileLimit = 8000, byteLimit = 64 * 1024 * 1024, edgeLimit = 100_000;
const code = /\.(ts|tsx|mts|cts)$/;
const id = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const excludedDirs = ["node_modules", "vendor", "dist", "build", "generated", "coverage", "target", "__pycache__"];
const rgArgs = ["--files", "--null", "--no-config", "--no-require-git", "--no-ignore-parent", "--no-follow",
	"--type-add", "graph:*.{ts,tsx,mts,cts}", "--type-add", "graph:package.json", "--type-add", "graph:tsconfig*.json", "--type", "graph",
	...excludedDirs.map(name => "--glob=!**/" + name + "/**"), "--glob=!*.generated.*", "--glob=!*.gen.*", "--", "."];

function safeRelative(path: string): boolean {
	try { return !path.split("/").some(part => part.startsWith(".")) && knowledgeRelativePath(path) === path; }
	catch { return false; }
}

// This runs on a dedicated worker. Sync reads keep thousands of small files
// off the main event loop and avoid a separate async round trip per stat.
// The descriptor must still name the checked, non-symlink path after the read.
function readGraphFile(root: string, path: string): Buffer {
	const full = resolve(root, path);
	if (relative(full, realpathSync.native(full)) !== "") throw Error("Workspace Graph source contains a symbolic link.");
	const before = lstatSync(full);
	if (!before.isFile()) throw Error("Workspace Graph source changed during discovery.");
	if (before.size > KNOWLEDGE_READ_LIMITS.fileBytes) throw Error("Source file exceeds the 1 MiB reading limit.");
	const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
			|| relative(full, realpathSync.native(full)) !== "") throw Error("Workspace Graph source changed before reading.");
		const bytes = Buffer.allocUnsafe(before.size);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (!count) throw Error("Workspace Graph source changed during reading.");
			offset += count;
		}
		const after = lstatSync(full);
		if (relative(full, realpathSync.native(full)) !== "" || opened.ino !== after.ino || opened.dev !== after.dev
			|| after.size !== before.size || opened.ctimeMs !== after.ctimeMs || opened.mtimeMs !== after.mtimeMs) {
			throw Error("Workspace Graph source changed during reading.");
		}
		return bytes;
	} finally { closeSync(fd); }
}

async function scan(job: GraphJob) {
	const files = new Map<string, ExtractInput>();
	const repos: GraphRepoIndex[] = [];
	const seen = new Set<string>();
	let count = 0, size = 0;
	const binary = ripgrepBinary();
	// A bare executable name in a repository cwd can resolve a project-local binary.
	if (!isAbsolute(binary)) throw Error("Workspace Graph requires the bundled ripgrep executable.");
	for (const source of job.sources) {
		if (!/^[A-Za-z0-9:_-]+$/.test(source.id) || !isAbsolute(source.root) || seen.has(source.id)) throw Error("Invalid Workspace Graph source.");
		seen.add(source.id);
		const root = await realpath(source.root);
		const identity = await lstat(root);
		if (!identity.isDirectory() || (await lstat(source.root)).isSymbolicLink()) throw Error("Workspace Graph requires a registered directory.");
		let listing: string;
		try {
			({ stdout: listing } = await exec(binary, rgArgs, { cwd: root, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }));
		} catch (error) {
			if ((error as { code?: number }).code === 1) listing = "";
			else throw Error("Workspace Graph could not enumerate its supported files within the scan limits.");
		}
		const paths = listing.split("\0").filter(Boolean).map(p => (sep === "/" ? p : p.replaceAll("\\", "/")).replace(/^\.\//, "")).filter(safeRelative).sort();
		count += paths.length;
		if (count > fileLimit) throw Error("Workspace Graph exceeds the 8,000-file limit.");
		const hashes: [string, string][] = [];
		for (const path of paths) {
			const bytes = readGraphFile(root, path);
			size += bytes.length;
			if (size > byteLimit) throw Error("Workspace Graph exceeds the 64 MiB source limit.");
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			hashes.push([path, sha256]);
			if (job.op === "build") {
				if (!looksLikeText(bytes)) throw Error("Workspace Graph cannot parse a binary source file.");
				files.set("/" + source.id + "/" + path, { text: decodeText(bytes), sha256 });
			}
		}
		const final = await lstat(root);
		if (await realpath(source.root) !== root || identity.dev !== final.dev || identity.ino !== final.ino) throw Error("Workspace Graph source changed during scan.");
		// Salt results when extraction or resolution rules change.
		repos.push({ id: source.id, fingerprint: id("ts-graph-v4", source.id, JSON.stringify(hashes)), files: Object.fromEntries(hashes), nodes: [], edges: [] });
	}
	return { files, repos };
}

function anchor(ref: ExtractAnchor): GraphAnchor {
	return { ...(ref.role ? { role: ref.role } : {}), sourceId: ref.source, path: ref.path, sha256: ref.sha256, line: ref.line, endLine: ref.endLine };
}

async function build(job: GraphJob, repos: GraphRepoIndex[], files: Map<string, ExtractInput>): Promise<GraphIndexResult> {
	const { default: ts } = await import("typescript");
	const { analyze, packageResolver } = await import("./workspace-graph-extractor.mjs");
	const parsed = new Map<string, ts.SourceFile>();
	for (const [path, file] of files) {
		if (!code.test(path)) continue;
		const sourceFile = ts.createSourceFile(path, file.text, ts.ScriptTarget.Latest, true);
		if ((sourceFile as ts.SourceFile & { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) {
			throw Error("Cannot parse TypeScript file " + path.slice(1) + ".");
		}
		parsed.set(path, sourceFile);
	}
	const resolve = packageResolver(files);
	const previous = new Map(job.previous.map(r => [r.id, r]));
	const roots = new Map(job.sources.map(item => [item.id, item.root]));
	let edges = 0;
	const repositories = repos.map(repo => {
		const cached = previous.get(repo.id);
		if (cached && cached.fingerprint === repo.fingerprint) { edges += cached.edges.length; return cached; }
		const repository = repo.id;
		// A new/deleted path can resolve (or invalidate) an earlier missing
		// extensionless import. Revisit every importer after membership changes.
		const paths = Object.keys(repo.files);
		const samePaths = cached && Object.keys(cached.files).length === paths.length && paths.every(p => Object.hasOwn(cached.files, p));
		const reuse = new Map<string, GraphNode>();
		if (cached && samePaths) {
			const changed = new Set(paths.filter(p => repo.files[p] !== cached.files[p]));
			const invalid = new Set(changed);
			for (const edge of cached.edges) {
				if (edge.anchors.some(a => changed.has(a.path))) invalid.add(edge.anchors[0].path);
			}
			for (const node of cached.nodes) if (node.kind === "module" && node.anchor && !invalid.has(node.anchor.path)) reuse.set(node.anchor.path, node);
			for (const edge of cached.edges) if (reuse.has(edge.anchors[0].path)) { repo.edges.push(edge); edges++; }
		}
		repo.nodes.push({ id: repository, kind: "repository", sourceId: repository, label: basename(roots.get(repository)!) || repository });
		for (const [path, sha256] of Object.entries(repo.files)) {
			const oldModule = reuse.get(path);
			if (oldModule) { repo.nodes.push(oldModule); continue; }
			const name = "/" + repository + "/" + path;
			const file = parsed.get(name);
			if (!file) continue;
			const sourceAnchor = { sourceId: repository, path, line: 1, endLine: 1, sha256 };
			const from = id("module", repository, path);
			repo.nodes.push({ id: from, kind: "module", sourceId: repository, label: path, anchor: sourceAnchor });
			for (const statement of file.statements) {
				if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue;
				const specifier = statement.moduleSpecifier;
				if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
				const target = resolve(specifier.text, name);
				if (!target || !parsed.has(target)) continue;
				const relative = target.slice(repository.length + 2);
				const to = id("module", repository, relative);
				const line = file.getLineAndCharacterOfPosition(specifier.getStart(file)).line + 1;
				const endLine = file.getLineAndCharacterOfPosition(specifier.getEnd() - 1).line + 1;
				const targetAnchor = { ...sourceAnchor, path: relative, sha256: repo.files[relative] };
				repo.edges.push({ id: id("import", from, to, String(specifier.pos), sha256, targetAnchor.sha256), from, to, kind: "imports",
					label: ts.isExportDeclaration(statement) ? "re-exports" : "imports", anchors: [{ ...sourceAnchor, line, endLine }, targetAnchor] });
				if (++edges > edgeLimit) throw Error("Workspace Graph exceeds the 100,000-edge limit.");
			}
		}
		return repo;
	});
	if (edges > edgeLimit) throw Error("Workspace Graph exceeds the 100,000-edge limit.");
	const nodes = new Map<string, GraphNode>(), flows = new Map<string, GraphEdge>();
	function endpoint(ref: ExtractAnchor) {
		const label = ref.owner || ref.path;
		const nodeId = id("symbol", ref.source, ref.path, label, String(ref.ownerOffset ?? ref.line));
		if (!nodes.has(nodeId)) nodes.set(nodeId, { id: nodeId, kind: "symbol", label, sourceId: ref.source, anchor: anchor(ref) });
		return nodeId;
	}
	const analysis = analyze(files, parsed, 4000, true);
	for (const link of analysis.packages) {
		const anchors = link.anchors.map(anchor);
		const [imported, exported] = anchors;
		const from = id("module", imported.sourceId, imported.path), to = id("module", exported.sourceId, exported.path);
		const label = link.operation + (link.typeOnly ? " type " : " ") + link.binding + " · " + link.specifier;
		const moduleId = id("package-import", from, to, label, JSON.stringify(anchors));
		flows.set(moduleId, { id: moduleId, from, to, kind: "imports", label, anchors });
		// Keep one overview link per operation and package, with a real
		// statement as a witness. Individual statements remain in the module view.
		const overview = id("package-overview", imported.sourceId, exported.sourceId, link.operation, link.specifier);
		if (!flows.has(overview)) flows.set(overview, { id: id(overview, JSON.stringify(anchors)), from: imported.sourceId, to: exported.sourceId,
			kind: "imports", label: link.operation + " " + link.specifier, anchors });
	}
	for (const route of analysis.paths) {
		const from = endpoint(route.emit), to = endpoint(route.write);
		const anchors = route.anchors.map(anchor);
		const label = route.value + " → " + route.target;
		const flowId = id("flow", from, to, label, JSON.stringify(anchors));
		flows.set(flowId, { id: flowId, from, to, kind: "flow", label, anchors });
		if (route.emit.source !== route.write.source) {
			const summaryId = id("repo-flow", flowId);
			flows.set(summaryId, { id: summaryId, from: route.emit.source, to: route.write.source, kind: "flow", label, anchors });
		}
	}
	return { repositories, nodes: [...nodes.values()], edges: [...flows.values()] };
}

async function execute(job: GraphJob) {
	const { files, repos } = await scan(job);
	if (job.op === "fingerprint") return Object.fromEntries(repos.map(r => [r.id, r.fingerprint]));
	return build(job, repos, files);
}

if (parentPort) {
	execute(workerData as GraphJob).then(result => parentPort!.postMessage({ ok: true, result }), error => {
		// Native path errors can include an absolute directory. Never forward one to a client.
		const message = error instanceof Error ? error.message : "";
		const safe = /^(?:Workspace Graph |Invalid Workspace Graph |Cannot parse TypeScript file |Source file exceeds |Invalid package manifest)/.test(message);
		parentPort!.postMessage({ ok: false, error: safe ? message : "Workspace Graph could not read or parse its registered sources." });
	});
}
