import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSource, loadSource } from "../../server/database/sources.js";
import { readOnlySql } from "../../server/database/sql.js";
import { listConnections, saveConnection, getConnection } from "../../server/database/store.js";
import { databaseAction, grantedConnections } from "../../server/database/service.js";
const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); directories.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function setup() { const dir = mkdtempSync(join(tmpdir(), "pi-db-unit-")); directories.push(dir); vi.stubEnv("PI_WEB_DATA_DIR", dir); return dir; }
const config = { name: "analytics", driver: "postgres" as const, host: "localhost", port: 5432, user: "reader", db_name: "analytics" };
describe("database SQL boundary", () => {
	for (const driver of ["mysql", "postgres"] as const) {
		it(`${driver}: accepts analytical SELECT and CTEs`, () => {
			expect(readOnlySql("with a as (select 2 as n) select sum(n) from a", driver)).toMatch(/SELECT/);
		});
		for (const sql of ["delete from t", "select 1; delete from t", "select pg_sleep(1)", "select dangerous_function()", "select * from t for update", "select * into outfile '/tmp/x' from t", "with a as (delete from t returning *) select * from a", "select 1 /*! INTO OUTFILE '/tmp/x' */", "select public.count(*) from t"]) {
			it(`${driver}: rejects ${sql}`, () => expect(() => readOnlySql(sql, driver)).toThrow());
		}
	}
});
describe("database sources and credentials", () => {
	it("imports DataGrip XML and DBeaver JSON without requiring encrypted credentials", () => {
		const xml = '<project><component name="DataSourceManagerImpl"><data-source uuid="a" name="Analytics"><driver-ref>postgresql</driver-ref><jdbc-url>jdbc:postgresql://localhost:5433/analytics</jdbc-url><user-name>reader</user-name></data-source></component></project>';
		expect(parseSource("datagrip", xml)[0]).toMatchObject({ sourceId: "a", config: { driver: "postgres", host: "localhost", port: 5433, user: "reader", db_name: "analytics" } });
		expect(parseSource("dbeaver", JSON.stringify({ connections: { a: { driver: "mysql8", name: "A", configuration: { host: "localhost", port: "3307", database: "a", user: "u" } } } }))[0].config.port).toBe(3307);
		expect(() => parseSource("datagrip", '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><project/>')).toThrow();
	});
	it("reads a DataGrip adjacent local username without reading a password vault", () => {
		const dir = setup();
		writeFileSync(join(dir, "dataSources.xml"), '<project><component><data-source uuid="a" name="A"><driver-ref>postgresql</driver-ref><jdbc-url>jdbc:postgresql://localhost/app</jdbc-url></data-source></component></project>');
		writeFileSync(join(dir, "dataSources.local.xml"), '<project><component><data-source uuid="a"><user-name>local-reader</user-name></data-source></component></project>');
		expect(loadSource("datagrip", join(dir, "dataSources.xml"))[0].config.user).toBe("local-reader");
	});
	it("marks tunnels and unknown drivers as unsupported", () => {
		const content = JSON.stringify({ connections: { a: { driver: "postgres", configuration: { host: "localhost", handlers: { ssh: { enabled: true } } } }, b: { driver: "oracle", configuration: { host: "localhost" } } } });
		expect(parseSource("dbeaver", content).every(c => !!c.issue)).toBe(true);
	});
	it("encrypts passwords and detects stale configuration versions", () => {
		const dir = setup(), saved = saveConnection({ ...config, password: "secret-marker" });
		expect(readFileSync(join(dir, "database/connections.json"), "utf8")).not.toContain("secret-marker");
		expect(JSON.stringify(listConnections())).not.toContain("secret-marker");
		expect(getConnection(saved.id).password).toBe("secret-marker");
		expect(() => saveConnection({ ...saved, version: "stale" })).toThrow(/changed/);
	});
	it("syncs idempotently, preserves passwords, marks source removals and confines grants", async () => {
		setup();
		const content = (host = "localhost") => JSON.stringify({ connections: { original: { driver: "postgres", name: "Analytics", configuration: { host, port: 5432, user: "u", database: "a", password: "p" } } } });
		const preview = async (text: string) => (await databaseAction("owner", "/work", "p", { action: "preview", kind: "dbeaver", path: "data-sources.json", content: text })).preview!;
		let p = await preview(content());
		await expect(databaseAction("other", "/work", "i", { action: "import", ticket: p.ticket, keys: ["original"] })).rejects.toThrow();
		await databaseAction("owner", "/work", "i", { action: "import", ticket: p.ticket, keys: ["original"] });
		const saved = listConnections()[0];
		await databaseAction("owner", "/work", "g", { action: "grant", ids: [saved.id], versions: { [saved.id]: saved.version } });
		expect(grantedConnections("owner")).toHaveLength(1); expect(grantedConnections("other")).toHaveLength(0);
		p = await preview(content()); expect(p.items[0].change).toBe("unchanged");
		await databaseAction("owner", "/work", "i", { action: "import", ticket: p.ticket, keys: ["original"] });
		expect(listConnections()).toHaveLength(1);
		p = await preview(content("changed"));
		await databaseAction("owner", "/work", "i", { action: "import", ticket: p.ticket, keys: ["original"] });
		expect(getConnection(saved.id).password).toBe("p"); expect(grantedConnections("owner")).toHaveLength(0);
		p = await preview('{"connections":{}}'); expect(p.items[0].change).toBe("missing");
		await databaseAction("owner", "/work", "i", { action: "import", ticket: p.ticket, keys: ["original"] });
		expect(() => getConnection(saved.id)).toThrow(/missing/);
	});
});
