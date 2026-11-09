import { XMLParser, XMLValidator } from "fast-xml-parser";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import type { DatabaseJdbcDriver, DatabaseJdbcReference, DatabaseJdbcSelection } from "../protocol.js";
import { fileFingerprint, jarFingerprint, jdbcFingerprint, type JdbcProfile } from "./jdbc-profile.js";

export const array = <T>(v: T | T[] | undefined): T[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
export function sourceXml(text: string): any {
	if (Buffer.byteLength(text) > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw Error("JDBC_CONFIG_INVALID");
	return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false }).parse(text);
}
function readXml(path: string) {
	if (statSync(path).size > 2 * 1024 * 1024) throw Error("JDBC_CONFIG_INVALID");
	return sourceXml(readFileSync(path, "utf8"));
}
export function dataGripConfigDirs(): string[] {
	const home = homedir();
	const roots = [join(home, "Library/Application Support/JetBrains"), join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "JetBrains"), ...(process.env.APPDATA ? [join(process.env.APPDATA, "JetBrains")] : [])];
	const dirs: string[] = [];
	for (const root of roots) try { for (const e of readdirSync(root, { withFileTypes: true }).slice(0, 512)) if (e.isDirectory() && /^DataGrip[\d.]+$/i.test(e.name)) dirs.push(join(root, e.name)); } catch { /* Optional IDE. */ }
	return dirs.slice(0, 32);
}
export function expandJdbcPath(value: string, configDir: string, projectDir: string, home = homedir()): string {
	if (typeof value !== "string" || value.length > 4096 || /[\0\r\n]/.test(value)) throw Error("JDBC_DRIVER_FILES");
	let path = value.replace(/^jar:\/\//, "").replace(/!\/$/, "").replace(/^file:\/\//, "");
	try { path = decodeURIComponent(path); } catch { throw Error("JDBC_DRIVER_FILES"); }
	path = path.replace(/\$USER_HOME\$/g, () => home).replace(/\$APPLICATION_CONFIG_DIR\$/g, () => configDir).replace(/\$PROJECT_DIR\$/g, () => projectDir);
	if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
	if (path.includes("$") || (!isAbsolute(path) && !win32.isAbsolute(path))) throw Error("JDBC_DRIVER_FILES");
	return process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(path) ? win32.normalize(path) : resolve(path);
}
interface Definition extends DatabaseJdbcDriver { raw: any }
export function jdbcDefinitions(configDir?: string): Definition[] {
	if (configDir !== undefined && (typeof configDir !== "string" || !isAbsolute(configDir) || configDir.length > 4096 || /[\0\r\n]/.test(configDir))) throw Error("JDBC_CONFIG_INVALID");
	const result: Definition[] = [];
	for (const dir of configDir ? [configDir] : dataGripConfigDirs()) {
		for (const filename of ["databaseDrivers.xml", "jdbc-drivers.xml"]) {
			try {
				const doc = readXml(join(dir, "options", filename));
				for (const c of array<any>(doc.application?.component)) for (const d of array<any>(c.driver)) {
					const id = d["@id"], driverClass = d["driver-class"] ?? (id === "postgresql" ? "org.postgresql.Driver" : undefined);
					if (typeof id !== "string" || typeof driverClass !== "string" || !/^[\w.$]+$/.test(driverClass)) continue;
					result.push({ id, name: String(d["@name"] || d.name || id), driverClass, configDir: dir, raw: d });
					if (result.length >= 200) return result;
				}
			} catch (e) { if (configDir && (e as NodeJS.ErrnoException).code !== "ENOENT") throw Error("JDBC_CONFIG_INVALID"); }
		}
	}
	return result;
}
export function listJdbcDrivers(configDir?: string): DatabaseJdbcDriver[] {
	return jdbcDefinitions(configDir).map(({ raw, ...d }) => d);
}
export function sourceEntries(text: string): any[] {
	const doc = sourceXml(text);
	return [...array<any>(doc["data-source"]), ...array<any>(doc.project?.component ?? doc.application?.component).flatMap(c => array<any>(c["data-source"]))];
}
/** Resolve only explicit local classpath entries; never fetch Maven artifacts or guess a jar version. */
export function resolveDataGripJdbc(raw: any, sourcePath: string, selection?: DatabaseJdbcSelection): { profile: JdbcProfile; reference: DatabaseJdbcReference; host: string; port: number; database: string; user?: string; password?: string } | undefined {
	if (selection && (typeof selection !== "object" || Object.entries(selection).filter(([k]) => k !== "jarPaths").some(([, v]) => v !== undefined && (typeof v !== "string" || v.length > 4096 || /[\0\r\n]/.test(v))))) throw Error("JDBC_CONFIG_INVALID");
	if (selection?.jarPaths !== undefined && (!Array.isArray(selection.jarPaths) || !selection.jarPaths.length || selection.jarPaths.length > 32 || selection.jarPaths.some(p => typeof p !== "string" || p.length > 4096 || /[\0\r\n]/.test(p)))) throw Error("JDBC_CONFIG_INVALID");
	if ((selection?.driverClass || selection?.jarPaths) && (!selection.driverClass || !selection.jarPaths)) throw Error("JDBC_CONFIG_INVALID");
	if ((selection?.driverId || selection?.jarPaths) && !selection.sourceId) throw Error("JDBC_CONFIG_INVALID");
	if (selection?.sourceId && selection.sourceId !== raw["@uuid"]) selection = { configDir: selection.configDir };
	if (!selection?.driverId && !selection?.jarPaths && /mysql|mariadb/i.test(String(raw["jdbc-url"]))) return;
	const ref = selection?.driverId || raw["driver-ref"];
	const manual = !!selection?.jarPaths;
	let definitions: Definition[] = manual ? [{ id: "manual", name: "GaussDB JDBC", driverClass: selection!.driverClass!, configDir: selection?.configDir || dirname(sourcePath), raw: {} }] : jdbcDefinitions(selection?.configDir).filter(d => d.id === ref);
	const hint = `${raw["jdbc-driver"] ?? ""} ${raw["driver-ref"] ?? ""} ${raw["jdbc-url"] ?? ""} ${definitions.map(d => `${d.name} ${d.driverClass} ${JSON.stringify(d.raw.library ?? [])}`).join(" ")}`;
	if (!manual && !selection?.driverId && !/gauss|gsjdbc/i.test(hint)) return;
	// Prefer the IDE profile that explicitly registered this project, not the newest installation.
	if (!selection?.configDir && definitions.length > 1) {
		const project = dirname(dirname(sourcePath));
		const owners = definitions.filter(d => {
			try {
				const doc = readXml(join(d.configDir, "options/recentProjects.xml"));
				return array<any>(doc.application?.component).filter(c => /^RecentProjectsManager/.test(c["@name"] ?? "")).some(c => array<any>(c.option).some(o => {
					const values = o["@name"] === "additionalInfo" ? array<any>(o.map?.entry).map(e => e["@key"]) : ["recentPaths", "openPaths"].includes(o["@name"]) ? array<any>(o.list?.option).map(e => e["@value"]) : [];
					return values.some(v => { try { return expandJdbcPath(v, d.configDir, project) === resolve(project); } catch { return false; } });
				}));
			} catch { return false; }
		});
		if (owners.length) definitions = owners;
	}
	if (definitions.length !== 1) throw Error(definitions.length ? "JDBC_DRIVER_AMBIGUOUS" : "JDBC_DRIVER_MISSING");
	const d = definitions[0], project = dirname(dirname(sourcePath));
	const driverClass = manual || selection?.driverId ? d.driverClass : raw["jdbc-driver"] ?? d.driverClass;
	if (typeof driverClass !== "string" || !/^[\w.$]+$/.test(driverClass)) throw Error("JDBC_CONFIG_INVALID");
	if (["ssh-properties", "ssh-tunnel", "proxy", "ssl-config", "ssl-properties", "startup-script", "init-script"].some(k => k in raw) || raw["auth-model"] && raw["auth-model"] !== "native") throw Error("JDBC_SETTINGS_UNSUPPORTED");
	const libraries = manual ? selection!.jarPaths! : array<any>(d.raw.library);
	if (!libraries.length || libraries.length > 32 || d.raw.artifact || d.raw["vm-options"] || d.raw["native-library"]) throw Error("JDBC_LIBRARY_UNSUPPORTED");
	const paths = libraries.map(l => {
		if (l["@native"] === "true" || l["@type"] && !["java", "jar"].includes(l["@type"])) throw Error("JDBC_DRIVER_FILES");
		return expandJdbcPath(typeof l === "string" ? l : l.url ?? l["@path"], d.configDir, project);
	}).filter(p => !/license|\.txt$/i.test(basename(p)));
	if (!paths.length) throw Error("JDBC_LIBRARY_UNSUPPORTED");
	let jars;
	try {
		if (paths.reduce((n, p) => n + statSync(p).size, 0) > 128 * 1024 * 1024) throw Error("JDBC_JAR_TOO_LARGE");
		jars = [...new Set(paths)].map(path => ({ path, sha256: jarFingerprint(path) })); } catch (e) {
		const error = e as NodeJS.ErrnoException;
		throw Error(error.code === "ENOENT" ? "JDBC_JAR_MISSING" : error.code === "EACCES" || error.code === "EPERM" ? "JDBC_JAR_UNREADABLE" : error.message === "JDBC_JAR_TOO_LARGE" ? error.message : "JDBC_DRIVER_FILES");
	}
	const original = raw["jdbc-url"];
	if (typeof original !== "string" || original.length > 16384 || !/^jdbc:(gaussdb|postgresql|opengauss):\/\//i.test(original)) throw Error("JDBC_URL_UNSUPPORTED");
	const prefix = original.slice(0, original.indexOf("://"));
	let url: URL; try { url = new URL(original.replace(/^jdbc:[^:]+:/, "postgres:")); } catch { throw Error("JDBC_URL_UNSUPPORTED"); }
	if (!url.hostname || url.hostname.includes(",") || url.hash || !url.pathname.slice(1)) throw Error("JDBC_URL_UNSUPPORTED");
	const properties: Record<string, string> = {};
	for (const p of [...array<any>(d.raw["jdbc-additional-properties"]?.property), ...array<any>(raw["jdbc-additional-properties"]?.property), ...array<any>(raw["driver-properties"]?.property)]) {
		if (typeof p["@name"] !== "string" || typeof p["@value"] !== "string") throw Error("JDBC_SETTINGS_UNSUPPORTED");
		properties[p["@name"]] = p["@value"];
	}
	for (const [key, value] of url.searchParams) properties[key] = value;
	const user = raw["user-name"] || properties.user || decodeURIComponent(url.username), password = raw.password ?? properties.password ?? (url.password ? decodeURIComponent(url.password) : undefined);
	delete properties.user; delete properties.password;
	const allowed = new Set("ssl sslmode sslrootcert sslcert sslkey sslpassword ApplicationName applicationName currentSchema characterEncoding connectTimeout socketTimeout loginTimeout cancelSignalTimeout prepareThreshold binaryTransfer batchMode allowEncodingChanges allowReadOnly tcpKeepAlive targetServerType loadBalanceHosts hostRecheckSeconds".split(" "));
	if (Object.keys(properties).length > 64 || Object.entries(properties).some(([k, v]) => !allowed.has(k) || v.length > 16384 || v.includes("\0"))) throw Error("JDBC_SETTINGS_UNSUPPORTED");
	if (properties.sslmode && !["disable", "verify-ca", "verify-full"].includes(properties.sslmode) || properties.ssl && !["true", "false"].includes(properties.ssl)) throw Error("JDBC_TLS_UNSUPPORTED");
	if (properties.ssl === "true" && properties.sslmode === "disable") throw Error("JDBC_TLS_UNSUPPORTED");
	const certificates: NonNullable<JdbcProfile["certificates"]> = [];
	for (const name of ["sslrootcert", "sslcert", "sslkey"]) if (properties[name]) {
		properties[name] = expandJdbcPath(properties[name], d.configDir, project);
		try { certificates.push({ path: properties[name], sha256: fileFingerprint(properties[name], false, 2 * 1024 * 1024) }); } catch { throw Error("JDBC_CERTIFICATE_MISSING"); }
	}
	// Do not inherit JDBC's default 'prefer' mode, which silently downgrades TLS.
	properties.sslmode ||= properties.ssl === "true" ? "verify-full" : "disable";
	const profile: JdbcProfile = { url: `${prefix}://${url.host}${url.pathname}`, properties, driverClass, jars, configDir: d.configDir, ...(certificates.length ? { certificates } : {}) };
	return { profile, reference: { configDir: d.configDir, driverId: d.id, driverClass, jarNames: jars.map(j => basename(j.path)), fingerprint: jdbcFingerprint(profile) }, host: url.hostname, port: Number(url.port) || 5432, database: decodeURIComponent(url.pathname.slice(1)), user, password };
}
