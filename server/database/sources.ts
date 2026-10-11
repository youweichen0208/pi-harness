import { XMLParser, XMLValidator } from "fast-xml-parser";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseConfig } from "../protocol.js";
export interface ImportedConnection { sourceId: string; config: DatabaseConfig; password?: string; issue?: string }
const array = <T>(v: T | T[] | undefined): T[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
export function parseSource(kind: "datagrip" | "dbeaver", text: string): ImportedConnection[] {
	if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error("Source exceeds 2 MiB");
	let entries: { id: string; name: string; driver: string; c: any; extra: any }[];
	if (kind === "datagrip") {
		if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw Error("Invalid data source XML");
		const document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false }).parse(text);
		const components = array<any>(document.project?.component ?? document.application?.component);
		const sources = [...array<any>(document["data-source"]), ...components.flatMap(c => array<any>(c["data-source"]))];
		entries = sources.map(c => ({ id: c["@uuid"] ?? "", name: c["@name"] ?? "", driver: c["driver-ref"] ?? "", c: { url: c["jdbc-url"], user: c["user-name"], password: c.password }, extra: c }));
	} else {
		let document; try { document = JSON.parse(text); } catch { throw Error("Invalid DBeaver JSON"); }
		if (!document.connections || typeof document.connections !== "object" || Array.isArray(document.connections)) throw Error("Missing DBeaver connections");
		entries = Object.entries<any>(document.connections).map(([id, c]) => ({ id, name: c.name ?? id, driver: c.driver ?? c.provider ?? "", c: c.configuration ?? {}, extra: c }));
	}
	if (entries.length > 200) throw Error("Too many source connections");
	return entries.map(({ id, name, driver, c, extra }) => {
		let issue: string | undefined, url: URL | undefined;
		const rawUrl = String(c.url ?? "").replace(/^jdbc:/, "").replace(/^postgresql:/, "postgres:").replace(/^mariadb:/, "mysql:");
		try { if (rawUrl) url = new URL(rawUrl); } catch { issue = "Unsupported connection URL"; }
		const hint = `${driver} ${url?.protocol ?? ""}`.toLowerCase();
		const type = /postgres/.test(hint) ? "postgres" : "mysql";
		if (!/mysql|maria|postgres/.test(hint)) issue = "Unsupported driver; only MySQL/MariaDB and PostgreSQL are supported";
		const handlers = c.handlers ?? extra.handlers ?? {};
		if (Object.values<any>(handlers).some(v => v.enabled === true || v.enabled === "true") || /<(?:ssh|ssh-tunnel)/i.test(JSON.stringify(extra)) || extra["ssh-properties"]) issue = "SSH/proxy settings are not supported; direct connection was not attempted";
		const properties = c.properties ?? {};
		const props = { ...properties, ...Object.fromEntries(url?.searchParams ?? []) };
		const tls = /require|verify/i.test(String(props.sslmode ?? props.sslMode ?? "")) || props.useSSL === "true" || props.ssl === "true";
		if (props.sslmode === "allow" || props.sslmode === "prefer" || props.sslMode === "PREFERRED" || props.trustServerCertificate === "true") issue = "TLS fallback or unverified TLS is not supported; configure verified TLS explicitly";
		const known = new Set(["sslmode", "sslMode", "useSSL", "ssl", "user", "password", "characterEncoding", "serverTimezone", "useUnicode", "applicationName", "ApplicationName"]);
		if (Object.keys(props).some(k => !known.has(k))) issue = "Unsupported connection properties; duplicate as a manual connection to configure explicitly";
		if ([extra, c].some(settings => Object.keys(settings).some(k => /ssl|proxy|ssh|kerberos|oauth/i.test(k) && settings[k] && JSON.stringify(settings[k]) !== "{}"))) issue = "Source TLS, proxy or tunnel settings require explicit manual configuration";
		if (extra["auth-model"] && extra["auth-model"] !== "native") issue = "Unsupported authentication method";
		const config: DatabaseConfig = { name: String(name || id || "Imported connection"), driver: type, host: String(c.host ?? url?.hostname ?? ""), port: Number(c.port ?? url?.port) || (type === "mysql" ? 3306 : 5432), user: String(c.user ?? c.userName ?? props.user ?? (url?.username ? decodeURIComponent(url.username) : "")), db_name: String(c.database ?? (url?.pathname ? decodeURIComponent(url.pathname.slice(1)) : "")), tls: { enabled: tls } };
		const password = c.password ?? props.password ?? (url?.password ? decodeURIComponent(url.password) : undefined);
		if (!config.host) issue = "Missing host";
		return { sourceId: String(id || createHash("sha256").update(JSON.stringify(config)).digest("hex")), config, password: typeof password === "string" ? password : undefined, issue };
	});
}
export function readSource(path: string): string {
	if (!["dataSources.xml", "data-sources.json"].includes(basename(path))) throw Error("Select dataSources.xml or data-sources.json");
	if (!statSync(path).isFile() || statSync(path).size > 2 * 1024 * 1024) throw Error("Invalid source file");
	return readFileSync(path, "utf8");
}
/** Bounded known roots only; never walk the entire home directory. */
export function scanSources(cwd: string): { kind: "datagrip" | "dbeaver"; path: string }[] {
	const home = homedir(), roots = [join(cwd, ".idea"), join(cwd, ".dbeaver"), join(home, "Library/Application Support/JetBrains"), join(home, "Library/DBeaverData"), join(home, ".local/share/DBeaverData"), join(home, ".config/JetBrains"), join(home, "DataGripProjects"), ...(process.env.APPDATA ? [join(process.env.APPDATA, "DBeaverData"), join(process.env.APPDATA, "JetBrains")] : [])];
	const found = new Map<string, "datagrip" | "dbeaver">(); let visited = 0;
	function walk(path: string, depth: number) {
		if (depth > 6 || ++visited > 2500 || found.size >= 100) return;
		try { for (const entry of readdirSync(path, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			const p = join(path, entry.name);
			if (entry.isFile() && ["dataSources.xml", "data-sources.json"].includes(entry.name)) found.set(resolve(p), entry.name === "dataSources.xml" ? "datagrip" : "dbeaver");
			else if (entry.isDirectory() && !["node_modules", ".git", "caches", "logs"].includes(entry.name.toLowerCase())) walk(p, depth + 1);
		} } catch { /* Missing or unreadable optional discovery root. */ }
	}
	roots.forEach(root => walk(root, 0));
	return [...found].map(([path, kind]) => ({ path, kind }));
}

/** DataGrip keeps the username in the adjacent local file in some versions. */
export function loadSource(kind: "datagrip" | "dbeaver", path: string): ImportedConnection[] {
	const result = parseSource(kind, readSource(path));
	if (kind !== "datagrip") return result;
	const localPath = join(dirname(path), "dataSources.local.xml");
	try {
		if (!statSync(localPath).isFile() || statSync(localPath).size > 2 * 1024 * 1024) throw Error("Invalid local data source XML");
		const local = parseSource(kind, readFileSync(localPath, "utf8"));
		for (const entry of result) {
			const override = local.find(c => c.sourceId === entry.sourceId);
			if (!override) continue;
			if (override.config.user) entry.config.user = override.config.user;
			if (override.password !== undefined) entry.password = override.password;
			if (override.issue?.includes("settings")) entry.issue = override.issue;
		}
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	return result;
}
