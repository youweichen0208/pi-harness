import { XMLParser, XMLValidator } from "fast-xml-parser";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { createHash } from "node:crypto";
import { dbeaverDataRoots, registeredDbeaverSources } from "./dbeaver-discovery.js";
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
		if (!config.host && !issue) issue = "Missing host";
		return { sourceId: String(id || createHash("sha256").update(JSON.stringify(config)).digest("hex")), config, password: typeof password === "string" ? password : undefined, issue };
	});
}
export function readSource(path: string): string {
	if (!["dataSources.xml", "data-sources.json"].includes(basename(path))) throw Error("Select dataSources.xml or data-sources.json");
	if (!statSync(path).isFile() || statSync(path).size > 2 * 1024 * 1024) throw Error("Invalid source file");
	return readFileSync(path, "utf8");
}
/** Read only registered project paths, never arbitrary path-like XML attributes. */
export function dataGripProjectPaths(text: string, home: string): string[] {
	if (Buffer.byteLength(text) > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw Error("Invalid recent projects XML");
	const document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false }).parse(text);
	const paths = new Set<string>();
	for (const component of array<any>(document.application?.component)) {
		if (!["RecentProjectsManager", "RecentProjectsManagerBase"].includes(component["@name"])) continue;
		for (const option of array<any>(component.option)) {
			const candidates = option["@name"] === "additionalInfo" ? array<any>(option.map?.entry).map(entry => entry["@key"])
				: ["recentPaths", "openPaths"].includes(option["@name"]) ? array<any>(option.list?.option).map(entry => entry["@value"]) : [];
			for (const candidate of candidates) {
				if (typeof candidate !== "string" || candidate.length > 4096 || /[\0\r\n]/.test(candidate)) continue;
				const path = candidate.replace(/^\$USER_HOME\$(?=[/\\]|$)/, () => home).replace(/^~(?=[/\\])/, () => home);
				if (path.includes("$") || (!isAbsolute(path) && !win32.isAbsolute(path))) continue;
				paths.add(path);
				if (paths.size >= 200) return [...paths];
			}
		}
	}
	return [...paths];
}

function registeredDataGripSources(home: string, configRoots: string[]): string[] {
	const projects = new Set<string>(); let registries = 0;
	for (const root of new Set(configRoots)) {
		try {
			for (const entry of readdirSync(root, { withFileTypes: true }).slice(0, 512)) {
				if (!entry.isDirectory() || !/^DataGrip[^/\\]*$/i.test(entry.name)) continue;
				if (++registries > 32) break;
				try {
					const options = join(root, entry.name, "options"), file = join(options, "recentProjects.xml");
					if (!lstatSync(options).isDirectory()) continue;
					const stat = lstatSync(file);
					if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
					for (const project of dataGripProjectPaths(readFileSync(file, "utf8"), home)) {
						if (projects.size >= 200) break;
						if (isAbsolute(project)) projects.add(resolve(project));
					}
				} catch { /* Missing, stale or invalid registry must not hide other versions. */ }
			}
		} catch { /* Optional IDE configuration directory. */ }
	}
	const sources: string[] = [];
	for (const project of projects) {
		try {
			const idea = join(project, ".idea"), file = join(idea, "dataSources.xml");
			if (lstatSync(project).isDirectory() && lstatSync(idea).isDirectory() && lstatSync(file).isFile()) sources.push(file);
		} catch { /* Deleted project or one without database connections. */ }
	}
	return sources;
}
/** Bounded known roots only; never walk the entire home directory. */
export function scanSources(cwd: string): { kind: "datagrip" | "dbeaver"; path: string }[] {
	const home = homedir(), dbeaverRoots = dbeaverDataRoots(home);
	const configRoots = [join(home, "Library/Application Support/JetBrains"), join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "JetBrains"), ...(process.env.APPDATA ? [join(process.env.APPDATA, "JetBrains")] : [])];
	const roots = [join(cwd, ".idea"), join(cwd, ".dbeaver"), ...configRoots, ...dbeaverRoots, join(home, "DataGripProjects")];
	const found = new Map<string, "datagrip" | "dbeaver">(); let visited = 0;
	for (const path of registeredDataGripSources(home, configRoots).slice(0, 100)) found.set(path, "datagrip");
	for (const path of registeredDbeaverSources(dbeaverRoots)) { if (found.size >= 100) break; found.set(path, "dbeaver"); }
	function walk(path: string, depth: number) {
		if (depth > 6 || ++visited > 2500 || found.size >= 100) return;
		try { for (const entry of readdirSync(path, { withFileTypes: true })) {
			if (found.size >= 100) break;
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
