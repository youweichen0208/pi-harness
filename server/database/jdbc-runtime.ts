import { spawn, execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killPidTree } from "../process-utils.js";
import { verifyJdbcFiles, type JdbcProfile } from "./jdbc-profile.js";
import type { DatabaseGrid } from "../protocol.js";

function javaEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key];
	return env;
}
/** Discovery is filesystem-only; probing Java is deferred until an explicit connection test/query. */
export function jdbcJavaCandidates(configDir?: string): string[] {
	if (process.env.PI_WEB_JAVA) return existsSync(process.env.PI_WEB_JAVA) ? [process.env.PI_WEB_JAVA] : [];
	const home = homedir(), exe = process.platform === "win32" ? "java.exe" : "java", found: string[] = [];
	const version = configDir?.match(/DataGrip([\d.]+)$/i)?.[1];
	const products: string[] = [];
	const roots = process.platform === "win32" ? [join(process.env.ProgramFiles || "C:\\Program Files", "JetBrains"), join(process.env.LOCALAPPDATA || home, "Programs"), join(process.env.LOCALAPPDATA || home, "JetBrains/Toolbox/apps")] : ["/Applications", join(home, "Applications"), join(home, ".local/share/JetBrains/Toolbox/apps"), "/opt"];
	let visited = 0;
	function walk(root: string, depth: number) {
		if (++visited > 256 || depth > 5) return;
		try {
			for (const e of readdirSync(root, { withFileTypes: true }).slice(0, 256)) {
				if (!e.isDirectory()) continue;
				const path = join(root, e.name);
				if (/datagrip/i.test(e.name) || depth > 0) {
					if (existsSync(join(path, "jbr/bin", exe)) || existsSync(join(path, "Contents/jbr/Contents/Home/bin", exe))) products.push(path);
					else walk(path, depth + 1);
				}
			}
		} catch { /* Optional installation root. */ }
	}
	roots.forEach(root => walk(root, 0));
	products.sort((a, b) => Number(!!version && b.includes(version)) - Number(!!version && a.includes(version)) || a.localeCompare(b));
	for (const p of products) found.push(join(p, "jbr/bin", exe), join(p, "Contents/jbr/Contents/Home/bin", exe));
	if (process.env.JAVA_HOME) found.push(join(process.env.JAVA_HOME, "bin", exe));
	for (const p of (process.env.PATH || process.env.Path || "").split(delimiter).filter(Boolean)) found.push(join(p, exe));
	return [...new Set(found)].filter(p => { try { return statSync(p).isFile(); } catch { return false; } });
}
async function javaExecutable(configDir: string, signal: AbortSignal): Promise<string> {
	for (const candidate of jdbcJavaCandidates(configDir)) {
		signal.throwIfAborted();
		const version = await new Promise<string>(resolve => execFile(candidate, ["-version"], { timeout: 3000, maxBuffer: 8192, windowsHide: true, env: javaEnv(), signal }, (error, stdout, stderr) => resolve(error ? "" : stdout + stderr)));
		const major = version.match(/version "(?:1\.)?(\d+)/)?.[1];
		if (major && Number(major) >= 8) return candidate;
	}
	throw Error("JDBC_JAVA_UNAVAILABLE");
}
const integer = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const string = (s: string) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([integer(b.length), b]); };
function input(profile: JdbcProfile, user: string, password: string, sql: string, database: string, limit: number): Buffer {
	const url = new URL(profile.url.replace(/^jdbc:[^:]+:/, "postgres:"));
	if (database) url.pathname = `/${encodeURIComponent(database)}`;
	const prefix = profile.url.slice(0, profile.url.indexOf("://"));
	const props = { ...profile.properties, user, password, connectTimeout: "10", loginTimeout: "10", socketTimeout: "30", cancelSignalTimeout: "2", allowReadOnly: "true" };
	const chunks = [integer(0x50494a31), integer(profile.jars.length), ...profile.jars.map(j => string(j.path)), string(profile.driverClass), string(`${prefix}://${url.host}${url.pathname}`), integer(Object.keys(props).length)];
	for (const [k, v] of Object.entries(props)) chunks.push(string(k), string(v));
	chunks.push(string(sql), integer(limit));
	const bytes = Buffer.concat(chunks); if (bytes.length > 1024 * 1024) throw Error("JDBC_CONFIG_INVALID"); return bytes;
}
function decode(buffer: Buffer): Pick<DatabaseGrid, "columns" | "rows" | "truncated"> {
	let offset = 0;
	const int = () => { if (offset + 4 > buffer.length) throw Error(); const n = buffer.readInt32BE(offset); offset += 4; return n; };
	const str = () => { const n = int(); if (n < 0 || n > 65536 || offset + n > buffer.length) throw Error(); const s = buffer.subarray(offset, offset + n).toString("utf8"); offset += n; return s; };
	try {
		if (int() !== 0x50494a31) throw Error();
		const status = int();
		if (status !== 0) { const code = str(); throw Error(/^(JDBC_[A-Z_]+|SQLSTATE_[A-Z0-9]{5})$/.test(code) ? code : "JDBC_QUERY_FAILED"); }
		const nc = int(); if (nc < 0 || nc > 1024) throw Error();
		const columns = Array.from({ length: nc }, str), nr = int(); if (nr < 0 || nr > 1000) throw Error();
		const rows = Array.from({ length: nr }, () => columns.map(() => { const type = int(); if (type === 0) return null; if (type === 1) return str(); if (type === 2) return true; if (type === 3) return false; throw Error(); }));
		const truncated = int() === 1; if (offset !== buffer.length) throw Error();
		return { columns, rows, truncated };
	} catch (error) { if (/^(JDBC_|SQLSTATE_)/.test((error as Error).message)) throw error; throw Error("JDBC_BRIDGE_FAILED"); }
}
export async function executeJdbc(profile: JdbcProfile, user: string, password: string, sql: string, database: string, limit: number, signal: AbortSignal): Promise<Pick<DatabaseGrid, "columns" | "rows" | "truncated">> {
	verifyJdbcFiles(profile);
	const java = await javaExecutable(profile.configDir, signal);
	const built = fileURLToPath(new URL("./jdbc/pi-jdbc.jar", import.meta.url));
	const jar = existsSync(built) ? built : fileURLToPath(new URL("../../dist/server/database/jdbc/pi-jdbc.jar", import.meta.url));
	if (!existsSync(jar)) throw Error("JDBC_BRIDGE_MISSING");
	signal.throwIfAborted();
	const payload = input(profile, user, password, sql, database, limit);
	return new Promise((resolve, reject) => {
		const child = spawn(java, ["-Xmx128m", "-jar", jar], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32", env: javaEnv() });
		let size = 0, overflow = false, killTimer: ReturnType<typeof setTimeout> | undefined;
		const chunks: Buffer[] = [];
		const kill = () => { if (child.pid) killPidTree(child.pid); };
		const abort = () => { child.stdin.write(Buffer.from([1]), () => {}); killTimer ??= setTimeout(kill, 1000); };
		child.stdin.on("error", () => {});
		child.stderr.on("data", () => {}); // Driver diagnostics may contain credentials; drain without retaining or logging.
		child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) { overflow = true; kill(); } else chunks.push(chunk); });
		child.once("error", () => { signal.removeEventListener("abort", abort); clearTimeout(killTimer); reject(Error("JDBC_JAVA_UNAVAILABLE")); });
		child.once("close", code => {
			signal.removeEventListener("abort", abort); clearTimeout(killTimer);
			if (signal.aborted) { reject(Error("Query cancelled or timed out")); return; }
			if (code !== 0 || overflow) { reject(Error("JDBC_BRIDGE_FAILED")); return; }
			try { verifyJdbcFiles(profile); resolve(decode(Buffer.concat(chunks))); } catch (error) { reject(error); }
		});
		signal.addEventListener("abort", abort, { once: true });
		child.stdin.write(payload);
		if (signal.aborted) abort();
	});
}
