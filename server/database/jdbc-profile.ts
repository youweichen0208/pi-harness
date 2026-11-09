import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, statSync } from "node:fs";

/** Server-only: never return this object to the browser or model. */
export interface JdbcProfile {
	url: string;
	properties: Record<string, string>;
	driverClass: string;
	jars: { path: string; sha256: string }[];
	configDir: string;
	certificates?: { path: string; sha256: string }[];
}
const digests = new Map<string, { signature: string; digest: string }>();
export function jarFingerprint(path: string, force = false): string {
	if (!/\.jar$/i.test(path)) throw Error("JDBC_DRIVER_FILES");
	return fileFingerprint(path, force);
}
export function fileFingerprint(path: string, force = false, limit = 128 * 1024 * 1024): string {
	const stat = statSync(path);
	if (!stat.isFile() || stat.size > limit) throw Error("JDBC_DRIVER_FILES");
	const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
	const cached = digests.get(path); if (!force && cached?.signature === signature) return cached.digest;
	const fd = openSync(path, "r"), hash = createHash("sha256"), buffer = Buffer.alloc(65536);
	try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
	finally { closeSync(fd); }
	const digest = hash.digest("hex");
	if (digests.size >= 256) digests.clear();
	digests.set(path, { signature, digest }); return digest;
}
export function verifyJdbcFiles(profile: JdbcProfile) {
	try {
		for (const jar of profile.jars) if (jarFingerprint(jar.path, true) !== jar.sha256) throw Error();
		for (const cert of profile.certificates ?? []) if (fileFingerprint(cert.path, true, 2 * 1024 * 1024) !== cert.sha256) throw Error();
	}
	catch { throw Error("JDBC_DRIVER_CHANGED"); }
}
export function jdbcFingerprint(profile: JdbcProfile): string {
	return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}
