/** Read-only metadata adapters. Credential material never leaves this module in a SourceNode. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { homedir, userInfo } from "node:os";
import type { NodeProfile, NodeSource } from "./protocol.js";
import { decodeText } from "./text-sniff.js";

export type SourceNode = Omit<NodeProfile, "id"> & { sourceKey: string };
export function parseXshellIni(text: string): Record<string, Record<string, string>> {
	const sections: Record<string, Record<string, string>> = {};
	let section = "";
	for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const header = line.trim().match(/^\[([^\]]+)\]$/);
		if (header) { section = header[1].toUpperCase(); sections[section] ??= {}; continue; }
		const pair = line.match(/^\s*([^=;#]+?)\s*=(.*)$/);
		if (pair) (sections[section] ??= {})[pair[1].toUpperCase()] = pair[2].trim();
	}
	return sections;
}

export function parseXshell(text: string, file: string): SourceNode {
	const sections = parseXshellIni(text);
	const c = sections.CONNECTION ?? {}, a = sections["CONNECTION:AUTHENTICATION"] ?? {};
	const host = c.HOST ?? "", port = Number(c.PORT || 22);
	if (!host || /[\r\n\0]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${file}: 地址或端口无效`);
	const unsupported: string[] = [];
	if (c.PROTOCOL?.toUpperCase() !== "SSH") unsupported.push("protocol");
	for (const [name, values] of Object.entries(sections)) {
		for (const [key, value] of Object.entries(values)) {
			if ((/PROXY|JUMPHOST/.test(key) || /PROXY|JUMPHOST/.test(name)) && value && !/^(0|-1|none|false)$/i.test(value)) unsupported.push("proxy");
		}
	}
	if (Object.entries(a).some(([key, value]) => /AUTH.*PROFILE/.test(key) && value && !/^(0|false|none)$/i.test(value))) unsupported.push("authentication-profile");
	const keyPath = (a.PRIVATEKEY || a.PUBLICKEYFILE || a.USERKEY || "").replace(/^"(.*)"$/, "$1") || undefined;
	const auth = a.METHOD === "1" || keyPath ? "key" : "password";
	if (a.METHOD && !["0", "1"].includes(a.METHOD)) unsupported.push("authentication");

	if (auth === "key" && !keyPath) unsupported.push("key");
	return { name: basename(file).replace(/\.xsh$/i, ""), group: dirname(file) === "." ? "Xshell" : dirname(file), host, port, username: a.USERNAME || "", auth, keyPath, defaultDir: "/", sourceKey: file, sourceCredential: Boolean(auth === "key" ? a.PASSPHRASE : a.PASSWORD), xshellVersion: sections.SESSIONINFO?.VERSION, unsupported: [...new Set(unsupported)] };
}

/** First obtained value wins, matching OpenSSH's Host ordering. Complex directives are blocked. */
export function parseSshConfig(text: string): SourceNode[] {
	const blocks: { patterns: string[]; values: Record<string, string> }[] = [{ patterns: ["*"], values: {} }];
	let current = blocks[0];
	const unsupported = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		const m = line.trim().match(/^([^\s=#]+)(?:\s*=\s*|\s+)(.*)$/);
		if (!m || m[1].startsWith("#")) continue;
		const key = m[1].toLowerCase();
		const value = m[2].replace(/\s+#.*$/, "").trim().replace(/^"(.*)"$/, "$1");
		if (key === "host") { current = { patterns: value.split(/\s+/), values: {} }; blocks.push(current); }
		else if (key === "match" || key === "include") unsupported.add(key);
		else current.values[key] ??= value;
	}
	const match = (pattern: string, alias: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, "i").test(alias);
	const aliases = [...new Set(blocks.flatMap((b) => b.patterns).filter((p) => !/[*!?]/.test(p)))];
	return aliases.map((alias) => {
		const v: Record<string, string> = {};
		for (const b of blocks) if (b.patterns.some((p) => !p.startsWith("!") && match(p, alias)) && !b.patterns.some((p) => p.startsWith("!") && match(p.slice(1), alias))) for (const [k, val] of Object.entries(b.values)) v[k] ??= val;
		const blocked = [...unsupported];
		for (const key of ["proxyjump", "proxycommand", "localcommand", "remotecommand", "identityagent", "certificatefile", "localforward", "remoteforward", "dynamicforward"]) if (v[key] && v[key] !== "none") blocked.push(key);
		const port = Number(v.port || 22), host = v.hostname || alias;
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${alias}: 端口无效`);
		if (host.includes("%") || v.identityfile?.includes("%")) blocked.push("tokens");
		return { name: alias, group: "SSH config", host, port, username: v.user || userInfo().username, auth: v.identityfile ? "key" : "agent", keyPath: v.identityfile, defaultDir: "/", sourceKey: alias, unsupported: blocked };
	});
}

export async function readBounded(path: string): Promise<string> {
	if ((await stat(path)).size > 1024 * 1024) throw new Error("配置文件超过 1 MiB");
	const bytes = await readFile(path);
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
	return decodeText(bytes);
}
export async function scanSource(source: Pick<NodeSource, "kind" | "path">): Promise<SourceNode[]> {
	if (source.kind === "ssh") { const nodes = parseSshConfig(await readBounded(source.path)); if (nodes.length > 200) throw new Error("每个来源最多 200 个节点"); return nodes; }
	const nodes: SourceNode[] = [];
	let visited = 0;
	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > 12) throw new Error("会话目录层级过深");
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (++visited > 4000) throw new Error("会话目录文件过多");
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path, depth + 1);
			else if (entry.isFile() && /\.xsh$/i.test(entry.name)) {
				const node = resolveXshellNode(await readBounded(path), source.path, path);
				nodes.push(node);
				if (nodes.length > 200) throw new Error("每个来源最多 200 个节点");
			}
		}
	}
	await walk(source.path, 0);
	return nodes;
}
/** Resolve only metadata paths; do not load private keys while scanning. */
export function resolveXshellNode(text: string, root: string, path: string): SourceNode {
	const node = parseXshell(text, relative(root, path));
	if (node.keyPath) {
		node.keyPath = node.keyPath.replace(/%([^%]+)%/g, (original, name: string) => process.env[name] ?? original);
		if (/^\.\.?[\\/]/.test(node.keyPath)) node.keyPath = resolve(dirname(path), node.keyPath.replace(/[\\/]/g, "/"));
		if (!isAbsolute(node.keyPath) && !node.keyPath.startsWith("~/")) node.unsupported = [...node.unsupported ?? [], "key"];
	}
	return node;
}

export async function detectSources(): Promise<Pick<NodeSource, "kind" | "path" | "count" | "groups">[]> {
	const home = homedir();
	const candidates: Pick<NodeSource, "kind" | "path">[] = [{ kind: "ssh", path: join(home, ".ssh", "config") }];
	if (process.platform === "win32") {
		const bases = new Set([join(home, "Documents"), ...[process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter((path): path is string => !!path).map(path => join(path, "Documents"))]);
		try {
			const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetFolderPath("MyDocuments")'], { windowsHide: true, timeout: 5000, maxBuffer: 16384 });
			const documents = stdout.replace(/^\uFEFF/, "").trim(); if (documents) bases.add(documents);
		} catch { /* Default paths and the manual folder picker remain available. */ }
		for (const base of bases) candidates.unshift({ kind: "xshell", path: join(base, "NetSarang Computer", "7", "Xshell", "Sessions") });
	}
	const found = await Promise.all(candidates.map(async (source) => { try { const nodes = await scanSource(source); return { ...source, count: nodes.length, groups: new Set(nodes.map((n) => n.group)).size }; } catch { return null; } }));
	return found.filter((s) => s !== null);
}
export function sourcePath(value: string): string { return resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value); }
