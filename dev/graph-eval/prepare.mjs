// Materialize a byte-identical, bounded corpus without fetching entire source trees.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const corpus = JSON.parse(await readFile(new URL("./corpus.json", import.meta.url), "utf8"));
const project = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({ options: {
	output: { type: "string", default: join(project, ".scratch/graph-eval/samples") },
	"sdk-repo": { type: "string" }, "harness-repo": { type: "string" },
} });
const output = resolve(values.output);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const files = Object.entries(corpus).flatMap(([id, source]) =>
	Object.entries(source.files).map(([path, sha]) => ({ id, source, path, sha })));

async function load({ id, source, path }) {
	const checkout = values[id + "-repo"] ?? (id === "harness" ? project : undefined);
	if (checkout) {
		return execFileSync("git", ["-C", checkout, "show", source.commit + ":" + path], { maxBuffer: 4 << 20 });
	}
	const url = "https://api.github.com/repos/" + source.repository + "/contents/" + path + "?ref=" + source.commit;
	const accept = "application/vnd.github.raw+json";
	try {
		const response = await fetch(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(15000) });
		if (!response.ok) throw Error("GitHub HTTP " + response.status);
		return Buffer.from(await response.arrayBuffer());
	} catch (error) {
		try {
			return execFileSync("gh", ["api", "-H", "Accept: " + accept, url], { timeout: 30000, maxBuffer: 4 << 20 });
		} catch {
			throw Error("Cannot read the pinned SDK. Provide --sdk-repo pointing to a clone containing " + source.commit, { cause: error });
		}
	}
}

async function verify(dir) {
	const expected = new Set(files.map(({ id, path }) => join(id, path)));
	async function visit(relative) {
		for (const entry of await readdir(join(dir, relative), { withFileTypes: true })) {
			const name = join(relative, entry.name);
			if (entry.isDirectory()) await visit(name);
			else if (!entry.isFile() || !expected.has(name)) throw Error("Unexpected corpus entry: " + name);
		}
	}
	await visit("");
	for (const { id, path, sha } of files) {
		if (digest(await readFile(join(dir, id, path))) !== sha) throw Error("Corpus fingerprint mismatch: " + id + "/" + path);
	}
}

await mkdir(dirname(output), { recursive: true });
let exists = true;
try { await readdir(output); } catch (error) {
	if (error.code !== "ENOENT") throw error;
	exists = false;
}
if (!exists) {
	const temp = await mkdtemp(join(dirname(output), ".prepare-"));
	try {
		for (const item of files) {
			const bytes = await load(item);
			if (digest(bytes) !== item.sha) throw Error("Pinned source fingerprint mismatch: " + item.path);
			const target = join(temp, item.id, item.path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, bytes);
		}
		await rename(temp, output);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}
await verify(output);
console.log("Verified " + files.length + " pinned source files in " + output);
