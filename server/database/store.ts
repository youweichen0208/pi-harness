import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { documentDataDir } from "../document-extension-settings.js";
import type { DatabaseConfig, DatabaseConnection } from "../protocol.js";

interface RecordConnection extends DatabaseConnection { secret?: string }
function folder() { const p = join(documentDataDir(), "database"); mkdirSync(p, { recursive: true, mode: 0o700 }); return p; }
function atomic(path: string, text: string | Buffer) {
	const tmp = `${path}.${randomUUID()}.tmp`;
	try { writeFileSync(tmp, text, { mode: 0o600, flag: "wx" }); renameSync(tmp, path); }
	finally { rmSync(tmp, { force: true }); }
}
function key(): Buffer {
	const path = join(folder(), "key");
	try { const value = readFileSync(path); if (value.length !== 32) throw Error("Invalid database key"); return value; }
	catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; const value = randomBytes(32); writeFileSync(path, value, { mode: 0o600, flag: "wx" }); return value; }
}
function seal(text: string) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString("base64"); }
function unseal(text: string) { const bytes = Buffer.from(text, "base64"), cipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString(); }
function read(): RecordConnection[] {
	try { const value: unknown = JSON.parse(readFileSync(join(folder(), "connections.json"), "utf8")); if (!Array.isArray(value)) throw Error("Invalid database connection store"); return value; }
	catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
function write(items: RecordConnection[]) { atomic(join(folder(), "connections.json"), JSON.stringify(items, null, "\t")); }
export function validateConfig(value: DatabaseConfig): DatabaseConfig {
	if (!value || !["mysql", "postgres"].includes(value.driver)) throw Error("Unsupported database driver");
	for (const field of ["name", "host", "user", "db_name"] as const) if (typeof value[field] !== "string" || value[field].length > 512 || /[\0\r\n]/.test(value[field])) throw Error(`Invalid ${field}`);
	if (!value.host.trim() || !value.name.trim() || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw Error("Invalid host, name or port");
	if (value.tls && (typeof value.tls.enabled !== "boolean" || (value.tls.ca !== undefined && (typeof value.tls.ca !== "string" || value.tls.ca.length > 65536)))) throw Error("Invalid TLS configuration");
	return { name: value.name.trim(), driver: value.driver, host: value.host.trim(), port: value.port, user: value.user, db_name: value.db_name, ...(value.tls ? { tls: { enabled: value.tls.enabled, ca: value.tls.ca } } : {}) };
}
export function listConnections(): DatabaseConnection[] { return read().map(({ secret, ...publicValue }) => ({ ...publicValue, hasPassword: secret !== undefined })); }
export function getConnection(id: string, version?: string): DatabaseConfig & { id: string; version: string; password?: string; needsTest?: boolean } {
	const c = read().find(c => c.id === id);
	if (!c || (version && c.version !== version)) throw Error("Connection changed; refresh and retry");
	if (c.issue) throw Error(c.issue);
	return { ...validateConfig(c), id: c.id, version: c.version, password: c.secret === undefined ? undefined : unseal(c.secret), needsTest: c.needsTest };
}
export function saveConnection(value: DatabaseConfig & { id?: string; version?: string; password?: string }, source?: DatabaseConnection["source"], issue?: string): DatabaseConnection {
	const config = validateConfig(value), items = read(), old = value.id ? items.find(c => c.id === value.id) : undefined;
	if (value.id && (!old || old.version !== value.version)) throw Error("Connection changed; refresh and retry");
	if (old?.source && !source && JSON.stringify(validateConfig(old)) !== JSON.stringify(config)) throw Error("Imported fields are source-managed; duplicate to edit");
	if (value.password !== undefined && (typeof value.password !== "string" || value.password.length > 16384)) throw Error("Invalid password");
	const changed = old && (old.host !== config.host || old.port !== config.port || old.user !== config.user || old.driver !== config.driver || old.db_name !== config.db_name || JSON.stringify(old.tls) !== JSON.stringify(config.tls));
	const next: RecordConnection = { ...config, id: old?.id ?? randomUUID(), version: randomUUID(), hasPassword: value.password !== undefined || !!old?.hasPassword, secret: value.password === undefined ? old?.secret : seal(value.password), source: source ?? old?.source, issue: source ? issue : old?.issue, needsTest: !!changed || old?.needsTest };
	if (old) items[items.indexOf(old)] = next; else { if (items.length >= 200) throw Error("Too many connections"); items.push(next); }
	write(items);
	return listConnections().find(c => c.id === next.id)!;
}
export function markTested(id: string, version: string) { const items = read(), item = items.find(c => c.id === id && c.version === version); if (!item) throw Error("Connection changed"); item.needsTest = false; write(items); }
export function deleteConnection(id: string, version: string) { const items = read(), item = items.find(c => c.id === id && c.version === version); if (!item) throw Error("Connection changed"); write(items.filter(c => c !== item)); }
export function markMissing(id: string, issue = "Source connection missing; synchronize its source before connecting") { const items = read(), item = items.find(c => c.id === id); if (item) { item.issue = issue; item.version = randomUUID(); write(items); } }
