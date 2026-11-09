import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expandJdbcPath, resolveDataGripJdbc, listJdbcDrivers } from "../../server/database/datagrip-jdbc.js";
import { loadSource } from "../../server/database/sources.js";
import { synchronizeSources } from "../../server/database/sync.js";
import { getConnection, listConnections, saveConnection, markTested, deleteConnection } from "../../server/database/store.js";
import { databaseAction, grantedConnections } from "../../server/database/service.js";
import { executeQuery } from "../../server/database/query.js";
import { executeJdbc } from "../../server/database/jdbc-runtime.js";
import { verifyJdbcFiles } from "../../server/database/jdbc-profile.js";

let root: string, driverJar: string;
const dirs: string[] = [];
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-jdbc-driver-")); driverJar = join(root, "gauss fixture.jar");
	for (const [tool, args] of [["javac", ["--release", "8", "-encoding", "UTF-8", "-d", root, resolve("tests/fixtures/jdbc/GaussDriver.java")]], ["jar", ["cf", driverJar, "-C", root, "fixture"]]] as const) {
		const executable = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", `${tool}${process.platform === "win32" ? ".exe" : ""}`) : tool;
		const r = spawnSync(executable, [...args], { encoding: "utf8" }); expect(r.status, r.stderr || r.error?.message).toBe(0);
	}
}, 30000);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-jdbc-source-")); dirs.push(dir);
	const configDir = join(dir, "DataGrip2026.1"), sourcePath = join(dir, "project/.idea/dataSources.xml");
	mkdirSync(join(configDir, "options"), { recursive: true }); mkdirSync(join(dir, "project/.idea"), { recursive: true });
	writeFileSync(join(configDir, "options/databaseDrivers.xml"), `<application><component name="DatabaseDrivers"><driver id="gauss" name="GaussDB"><driver-class>fixture.GaussDriver</driver-class><library><url>file://${driverJar.replaceAll("\\", "/")}</url></library></driver></component></application>`);
	const write = (url = "jdbc:gaussdb://localhost:5432/analytics?password=url-secret", extra = "") => writeFileSync(sourcePath, `<project><component><data-source uuid="a" name="Gauss"><driver-ref>gauss</driver-ref><jdbc-url>${url.replaceAll("&", "&amp;")}</jdbc-url><user-name>reader</user-name>${extra}</data-source></component></project>`);
	write(); vi.stubEnv("PI_WEB_DATA_DIR", join(dir, "state"));
	const source = { kind: "datagrip" as const, path: sourcePath, jdbcSelection: { configDir } };
	return { dir, configDir, sourcePath, source, write, sync: () => synchronizeSources(dir, [source]), item: () => loadSource("datagrip", sourcePath, { configDir })[0] };
}
it("loads exact DataGrip local libraries, encrypts URL/properties and preserves local passwords during sync", () => {
	const f = fixture(), item = f.item(); expect(item.issue).toBeUndefined(); expect(item.config.driver).toBe("gaussdb"); expect(item.password).toBe("url-secret");
	expect(f.sync()).toEqual([]); const c = listConnections()[0]; expect(c.needsTest).toBe(true);
	const disk = readFileSync(join(f.dir, "state/database/connections.json"), "utf8"); expect(disk).not.toContain("jdbc:gaussdb"); expect(disk).not.toContain("url-secret"); expect(JSON.stringify(c)).not.toContain("properties");
	const saved = saveConnection({ ...c, password: "local-secret" }); f.sync(); expect(listConnections()[0].version).toBe(saved.version);
	f.write("jdbc:gaussdb://localhost:5432/changed?password=changed-secret"); f.sync(); expect(getConnection(c.id).password).toBe("local-secret"); expect(listConnections()[0].version).not.toBe(saved.version);
	deleteConnection(c.id, listConnections()[0].version); f.sync(); expect(listConnections()).toEqual([]);
});
it("isolates driver discovery, rejects missing dependencies, tunnels, unknown properties and unverified TLS", () => {
	const f = fixture(); expect(listJdbcDrivers(f.configDir)).toHaveLength(1);
	for (const [url, extra, issue] of [
		["jdbc:gaussdb://localhost/db?sslmode=require", "", "JDBC_TLS_UNSUPPORTED"],
		["jdbc:gaussdb://localhost/db?socketFactory=evil", "", "JDBC_SETTINGS_UNSUPPORTED"],
		["jdbc:gaussdb://localhost/db", "<ssh-properties/>", "JDBC_SETTINGS_UNSUPPORTED"],
		["jdbc:gaussdb://localhost/db?sslrootcert=/not-a-certificate", "", "JDBC_CERTIFICATE_MISSING"],
	]) { f.write(url, extra); expect(f.item().issue).toBe(issue); }
	f.write(); rmSync(join(f.configDir, "options/databaseDrivers.xml")); expect(f.item().issue).toBe("JDBC_DRIVER_MISSING");
});
it("expands Windows paths and macros without interpreting shell syntax or unknown macros", () => {
	const value = expandJdbcPath("file://$APPLICATION_CONFIG_DIR$/drivers/高斯 driver.jar", "/config", "/project", "/home"); expect(value).toContain("高斯 driver.jar");
	expect(() => expandJdbcPath("$UNKNOWN$/driver.jar", "/config", "/project")).toThrow("JDBC_DRIVER_FILES");
	expect(() => expandJdbcPath("relative.jar", "/config", "/project")).toThrow();
});
it("uses the actual Java process with isolated class loading, lossless numbers and bounded results", async () => {
	const f = fixture(), item = f.item();
	const run = (sql: string) => executeQuery({ ...item.config, password: item.password, jdbcProfile: item.jdbcProfile }, { action: "run", id: "test", version: "1", operation: "query", sql });
	const result = await run("SELECT 1"); expect(result.rows).toEqual([["9223372036854775807", "1234567890.123456789", null, true]]); expect(JSON.stringify(result)).not.toContain("url-secret");
	expect((await run("SELECT * FROM many")).rows).toHaveLength(1000); expect((await run("SELECT * FROM many")).truncated).toBe(true);
	const long = await run("SELECT * FROM longtext"); expect(String(long.rows[0][0])).toHaveLength(4000); expect(long.truncated).toBe(true);
	await expect(run("DELETE FROM foo")).rejects.toThrow();
	await expect(run("SELECT * FROM badquery")).rejects.toThrow("SQLSTATE_42601");
}, 30000);
it("rejects writable transactions, cancels the process and never exposes raw driver errors", async () => {
	const f = fixture(), profile = f.item().jdbcProfile!;
	await expect(executeJdbc({ ...profile, url: "jdbc:gaussdb://localhost/writable" }, "r", "secret", "SELECT 1", "writable", 50, new AbortController().signal)).rejects.toThrow("JDBC_READONLY_REQUIRED");
	await expect(executeJdbc({ ...profile, url: "jdbc:gaussdb://localhost/authfail" }, "r", "secret", "SELECT 1", "authfail", 50, new AbortController().signal)).rejects.toThrow("SQLSTATE_28P01");
	const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 800);
	try { await expect(executeJdbc(profile, "r", "secret", "SELECT * FROM hang", "analytics", 50, controller.signal)).rejects.toThrow(/cancelled|abort/i); } finally { clearTimeout(timer); }
}, 30000);
it("requires testing before authorization, invalidates changes and rejects client forged JDBC references", async () => {
	const f = fixture(); f.sync(); let c = listConnections()[0];
	await expect(databaseAction("owner", f.dir, "grant", { action: "grant", ids: [c.id], versions: { [c.id]: c.version } })).rejects.toThrow(/test/);
	await databaseAction("owner", f.dir, "test", { action: "test", connection: c }); c = listConnections()[0]; expect(c.needsTest).toBe(false);
	await databaseAction("owner", f.dir, "grant", { action: "grant", ids: [c.id], versions: { [c.id]: c.version } }); expect(grantedConnections("owner")).toHaveLength(1);
	await expect(databaseAction("owner", f.dir, "test", { action: "test", connection: { ...c, host: "different" } })).rejects.toThrow("JDBC_CONFIG_INVALID");
	f.write("jdbc:gaussdb://localhost/changed"); f.sync(); expect(grantedConnections("owner")).toHaveLength(0);
	const { id, version, ...copy } = c; expect(() => saveConnection(copy)).toThrow("JDBC_CONFIG_INVALID");
}, 30000);

it("tracks certificate contents and per-source class overrides without changing native connections", () => {
	const f = fixture(), cert = join(f.dir, "root.pem"); writeFileSync(cert, "first certificate");
	f.write(`jdbc:gaussdb://localhost/db?sslmode=verify-full&sslrootcert=${encodeURIComponent(cert)}`, "<jdbc-driver>fixture.CustomGaussDriver</jdbc-driver>");
	const first = f.item(); expect(first.issue).toBeUndefined(); f.sync(); const version = listConnections()[0].version;
	f.sync(); expect(listConnections()[0].version).toBe(version); expect(listConnections()[0].jdbc?.driverClass).toBe("fixture.CustomGaussDriver");
	writeFileSync(cert, "renewed certificate"); expect(() => verifyJdbcFiles(first.jdbcProfile!)).toThrow("JDBC_DRIVER_CHANGED");
	f.sync(); expect(listConnections()[0].version).not.toBe(version); expect(listConnections()[0].needsTest).toBe(true);
	expect(resolveDataGripJdbc({ "@uuid": "native", "driver-ref": "postgresql", "jdbc-url": "jdbc:postgresql://localhost/db" }, f.sourcePath, { configDir: f.configDir, driverId: "gauss", sourceId: "a" })).toBeUndefined();
	expect(resolveDataGripJdbc({ "@uuid": "native", "driver-ref": "mysql", "jdbc-url": "jdbc:mysql://localhost/db" }, f.sourcePath, { configDir: f.configDir })).toBeUndefined();
});
it("retains distinct connection mappings in a shared source file across repeated sync", async () => {
	const f = fixture();
	writeFileSync(f.sourcePath, `<project><component>${["a", "b"].map(id => `<data-source uuid="${id}" name="${id}"><driver-ref>custom</driver-ref><jdbc-url>jdbc:gaussdb://localhost/${id}</jdbc-url></data-source>`).join("")}</component></project>`);
	for (const id of ["a", "b"]) {
		const preview = await databaseAction("mapping-owner", f.dir, "preview", { action: "preview", kind: "datagrip", path: f.sourcePath, jdbcSelection: { configDir: f.configDir, driverId: "gauss", sourceId: id } });
		await databaseAction("mapping-owner", f.dir, "import", { action: "import", ticket: preview.preview!.ticket, keys: [id] });
	}
	const before = listConnections().map(c => c.version); f.sync(); f.sync();
	expect(listConnections().map(c => c.version)).toEqual(before); expect(listConnections().every(c => !c.issue)).toBe(true);
});

it("keeps unchanged import previews stable and detects driver changes and recovery", async () => {
	const f = fixture(); f.sync(); let c = listConnections()[0];
	const preview = await databaseAction("stable", f.dir, "p", { action: "preview", kind: "datagrip", path: f.sourcePath, jdbcSelection: { configDir: f.configDir } });
	expect(preview.preview!.items[0].change).toBe("unchanged");
	await databaseAction("stable", f.dir, "i", { action: "import", ticket: preview.preview!.ticket, keys: ["a"] }); expect(listConnections()[0].version).toBe(c.version);
	const definitions = join(f.configDir, "options/databaseDrivers.xml"), original = readFileSync(definitions, "utf8"), localJar = join(f.dir, "gauss-local.jar");
	writeFileSync(localJar, readFileSync(driverJar)); writeFileSync(definitions, original.replace(driverJar.replaceAll("\\", "/"), localJar.replaceAll("\\", "/"))); f.sync(); c = listConnections()[0];
	const before = getConnection(c.id).jdbcProfile!; writeFileSync(localJar, Buffer.concat([readFileSync(localJar), Buffer.from("changed")]));
	expect(() => verifyJdbcFiles(before)).toThrow("JDBC_DRIVER_CHANGED"); f.sync(); expect(listConnections()[0].version).not.toBe(c.version);
	rmSync(localJar); f.sync(); expect(listConnections()[0].issue).toBe("JDBC_JAR_MISSING");
	writeFileSync(localJar, readFileSync(driverJar)); f.sync(); expect(listConnections()[0].issue).toBeUndefined(); expect(listConnections()[0].needsTest).toBe(true);
});
it("repairs a source using explicit local jars without an IDE driver definition", async () => {
	const f = fixture(); rmSync(join(f.configDir, "options/databaseDrivers.xml"));
	const selection = { sourceId: "a", driverClass: "fixture.GaussDriver", jarPaths: [driverJar] };
	const preview = await databaseAction("manual", f.dir, "preview", { action: "preview", kind: "datagrip", path: f.sourcePath, jdbcSelection: selection });
	expect(preview.preview!.items[0].issue).toBeUndefined();
	await databaseAction("manual", f.dir, "import", { action: "import", ticket: preview.preview!.ticket, keys: ["a"] });
	const c = listConnections()[0]; expect(c.driver).toBe("gaussdb"); expect(c.needsTest).toBe(true);
	expect(f.sync()).toEqual([]); expect(listConnections()[0].version).toBe(c.version);
	await databaseAction("manual", f.dir, "test", { action: "test", connection: c }); expect(listConnections()[0].needsTest).toBe(false);
	expect(loadSource("datagrip", f.sourcePath, { ...selection, jarPaths: [join(f.dir, "missing.jar")] })[0].issue).toBe("JDBC_JAR_MISSING");
	expect(loadSource("datagrip", f.sourcePath, { ...selection, sourceId: undefined })[0].issue).toBe("JDBC_CONFIG_INVALID");
});

it("automatically matches a unique registered Gauss driver when the source driver ID differs", () => {
	const f = fixture();
	writeFileSync(f.sourcePath, readFileSync(f.sourcePath, "utf8").replace("<driver-ref>gauss</driver-ref>", "<driver-ref>custom</driver-ref>"));
	expect(f.item().issue).toBeUndefined();
	expect(f.item().config.driver).toBe("gaussdb");
	expect(f.sync()).toEqual([]);
	expect(listConnections()[0].needsTest).toBe(true);
});

it("repairs a PostgreSQL source explicitly, remembers the IDE directory, and keeps removal across sync", async () => {
	const f = fixture(); f.write("jdbc:postgresql://localhost/analytics");
	writeFileSync(f.sourcePath, readFileSync(f.sourcePath, "utf8").replace("<driver-ref>gauss</driver-ref>", "<driver-ref>postgresql</driver-ref>"));
	expect(f.item().config.driver).toBe("postgres"); f.sync(); const native = listConnections()[0];
	const result = await databaseAction("repair", f.dir, "configure", { action: "jdbc_configure", id: native.id, version: native.version, configDir: f.configDir });
	const c = result.connections![0]; expect(c.driver).toBe("gaussdb"); expect(c.needsTest).toBe(true);
	expect(c.source?.jdbcSelection?.configDir).toBe(f.configDir);
	await expect(databaseAction("repair", f.dir, "run", { action: "run", id: c.id, version: c.version, operation: "query", sql: "SELECT 1" })).rejects.toThrow(/test/);
	f.sync(); expect(listConnections()[0].version).toBe(c.version);
	await expect(databaseAction("repair", f.dir, "stale", { action: "jdbc_configure", id: c.id, version: native.version })).rejects.toThrow(/changed/);
	const removed = await databaseAction("repair", f.dir, "remove", { action: "jdbc_configure", id: c.id, version: c.version, mode: "disabled" });
	const disabled = removed.connections![0]; expect(disabled.jdbc).toBeUndefined(); expect(disabled.issue).toBe("JDBC_DISABLED");
	f.sync(); expect(listConnections()[0].version).toBe(disabled.version);
	await expect(databaseAction("repair", f.dir, "test", { action: "test", connection: disabled })).rejects.toThrow("JDBC_DISABLED");
	const restored = await databaseAction("repair", f.dir, "restore", { action: "jdbc_configure", id: disabled.id, version: disabled.version });
	expect(restored.connections![0].jdbc).toBeDefined(); expect(restored.connections![0].needsTest).toBe(true);
});
it("returns ambiguous candidates without executing or changing the connection, then persists the choice", async () => {
	const f = fixture(); f.write("jdbc:postgresql://localhost/analytics");
	writeFileSync(f.sourcePath, readFileSync(f.sourcePath, "utf8").replace("<driver-ref>gauss</driver-ref>", "<driver-ref>postgresql</driver-ref>"));
	f.sync(); const c = listConnections()[0];
	const definitions = join(f.configDir, "options/databaseDrivers.xml");
	writeFileSync(definitions, readFileSync(definitions, "utf8").replace("</component>", `<driver id="gauss-other" name="GaussDB other"><driver-class>fixture.GaussDriver</driver-class><library><url>file://${driverJar.replaceAll("\\", "/")}</url></library></driver></component>`));
	const ambiguous = await databaseAction("repair", f.dir, "ambiguous", { action: "jdbc_configure", id: c.id, version: c.version, configDir: f.configDir });
	expect(ambiguous.jdbcDrivers).toHaveLength(2); expect(listConnections()[0].version).toBe(c.version);
	const selected = await databaseAction("repair", f.dir, "selected", { action: "jdbc_configure", id: c.id, version: c.version, configDir: f.configDir, driverId: "gauss-other" });
	expect(selected.connections![0].jdbc?.driverId).toBe("gauss-other");
	f.sync(); expect(listConnections()[0].version).toBe(selected.connections![0].version);
});

it("pins automatic matches and exposes source IDs for a new ambiguous source", async () => {
	const f = fixture(); f.sync(); const first = listConnections()[0];
	expect(first.source?.jdbcSelection?.configDir).toBe(f.configDir);
	expect(first.source?.jdbcSelection?.driverId).toBe("gauss");
	const definitions = join(f.configDir, "options/databaseDrivers.xml");
	const original = readFileSync(definitions, "utf8");
	writeFileSync(definitions, original.replace("</component>", original.match(/<driver .*<\/driver>/)![0].replace('id="gauss"', 'id="gauss-other"') + "</component>"));
	f.sync(); expect(listConnections()[0].version).toBe(first.version);
	writeFileSync(f.sourcePath, readFileSync(f.sourcePath, "utf8").replace('uuid="a"', 'uuid="b"').replace("<driver-ref>gauss</driver-ref>", "<driver-ref>custom</driver-ref>"));
	expect(f.sync()).toContainEqual(expect.objectContaining({ sourceId: "b", issue: "Gauss: JDBC_DRIVER_AMBIGUOUS" }));
	const preview = await databaseAction("source", f.dir, "p", { action: "preview", kind: "datagrip", path: f.sourcePath, jdbcSelection: { mode: "automatic", sourceId: "b", configDir: f.configDir } });
	expect(preview.jdbcDrivers).toHaveLength(2);
});

it("reads DataGrip User Driver class attributes", () => {
	const f = fixture(), definitions = join(f.configDir, "options/databaseDrivers.xml");
	writeFileSync(definitions, readFileSync(definitions, "utf8").replace('name="GaussDB"', 'name="User Driver" driver-class="fixture.GaussDriver"').replace('<driver-class>fixture.GaussDriver</driver-class>', ''));
	expect(listJdbcDrivers(f.configDir)).toHaveLength(1);
	expect(f.item().issue).toBeUndefined();
	expect(f.item().jdbcProfile?.driverClass).toBe("fixture.GaussDriver");
});
it("uses explicit local libraries alongside artifact metadata without resolving artifacts", async () => {
	const f = fixture(), definitions = join(f.configDir, "options/databaseDrivers.xml");
	const original = readFileSync(definitions, "utf8");
	writeFileSync(definitions, original.replace('<library>', '<artifact id="PostgreSQL" version="42.7.3"/><library>'));
	expect(f.item().issue).toBeUndefined();
	expect(f.item().jdbcProfile?.jars.map(j => j.path)).toEqual([driverJar]);
	f.sync(); const c = listConnections()[0];
	await databaseAction("artifact", f.dir, "test", { action: "test", connection: c });
	expect(listConnections()[0].needsTest).toBe(false);
	writeFileSync(definitions, original.replace('<library>', '<artifact id="PostgreSQL" version="42.7.3"/><vm-options>-Dunsafe=true</vm-options><library>'));
	expect(f.item().issue).toBe("JDBC_LIBRARY_UNSUPPORTED");
	writeFileSync(definitions, original.replace(driverJar.replaceAll("\\", "/"), join(f.dir, "missing.jar").replaceAll("\\", "/")).replace('<library>', '<artifact id="PostgreSQL" version="42.7.3"/><library>'));
	expect(f.item().issue).toBe("JDBC_JAR_MISSING");
	writeFileSync(definitions, original.replace(/<library>.*?<\/library>/, '<artifact id="PostgreSQL" version="42.7.3"/>'));
	expect(f.item().issue).toBe("JDBC_LIBRARY_UNSUPPORTED");
});

it("loads a PG 9.2-derived table catalog through the real JDBC bridge (#163)", async () => {
	const item = fixture().item();
	const result = await executeQuery({ ...item.config, password: item.password, jdbcProfile: item.jdbcProfile }, { action: "run", id: "test", version: "1", operation: "tables", database: "analytics" });
	expect(result.columns).toEqual(["schema", "name", "kind"]);
	expect(result.rows).toEqual([["CORE", "orders", "BASE TABLE"]]);
}, 30000);
