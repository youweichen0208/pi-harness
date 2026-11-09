import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { operationSql } from "../../server/database/sql.js";

// Execute the generated catalog SQL against the relevant PG 9.2 column layout.
// This fixture intentionally has no pg_matviews relation; it is not a vendor-server test.
describe("PG-compatible table catalogs (#163)", () => {
	for (const driver of ["postgres", "gaussdb"] as const) {
		for (const modern of [false, true]) {
			it(`${driver}: lists tables/views with ${modern ? "modern" : "9.2"} catalogs`, () => {
				const db = new DatabaseSync(":memory:");
				try {
					db.exec(`ATTACH ':memory:' AS information_schema; ATTACH ':memory:' AS pg_catalog;
						CREATE TABLE information_schema.tables (table_schema TEXT, table_name TEXT, table_type TEXT);
						CREATE TABLE pg_catalog.pg_namespace (oid INTEGER, nspname TEXT);
						CREATE TABLE pg_catalog.pg_class (relname TEXT, relnamespace INTEGER, relkind TEXT);
						INSERT INTO information_schema.tables VALUES ('CORE','orders','BASE TABLE'), ('CORE','order_view','VIEW'), ('pg_catalog','internal','BASE TABLE');
						INSERT INTO pg_catalog.pg_namespace VALUES (1,'CORE'), (2,'pg_catalog');
						INSERT INTO pg_catalog.pg_class VALUES ('orders',1,'r'), ('order_view',1,'v'), ('orders_idx',1,'i');`);
					if (modern) db.exec("INSERT INTO pg_catalog.pg_class VALUES ('totals',1,'m'), ('hidden',2,'m')");
					const sql = operationSql({ action: "run", id: "test", version: "1", operation: "tables", database: "analytics" }, driver);
					expect(db.prepare(sql).all()).toEqual([
						{ schema: "CORE", name: "order_view", kind: "VIEW" },
						{ schema: "CORE", name: "orders", kind: "BASE TABLE" },
						...(modern ? [{ schema: "CORE", name: "totals", kind: "MATERIALIZED VIEW" }] : []),
					]);
				} finally { db.close(); }
			});
		}
	}
});
