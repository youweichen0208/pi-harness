import sqlParser from "node-sql-parser";
import type { DatabaseDriver, DatabaseOperation } from "../protocol.js";
const parser = new sqlParser.Parser();
const functions = new Set("COUNT SUM AVG MIN MAX ABS ROUND FLOOR CEIL CEILING COALESCE NULLIF IFNULL IF CONCAT CONCAT_WS LOWER UPPER LENGTH CHAR_LENGTH TRIM LTRIM RTRIM SUBSTRING SUBSTR LEFT RIGHT REPLACE DATE DATE_FORMAT DATE_TRUNC EXTRACT YEAR MONTH DAY NOW CURRENT_DATE CURRENT_TIMESTAMP CAST CONVERT TO_CHAR TO_DATE TO_TIMESTAMP ROW_NUMBER RANK DENSE_RANK LAG LEAD FIRST_VALUE LAST_VALUE STRING_AGG GROUP_CONCAT ARRAY_AGG JSON_AGG JSON_EXTRACT JSON_UNQUOTE JSONB_EXTRACT_PATH_TEXT GREATEST LEAST STDDEV STDDEV_POP STDDEV_SAMP VARIANCE PERCENTILE_CONT PERCENTILE_DISC NTILE CUME_DIST PERCENT_RANK".split(" "));
/** Parse the entire statement, including every CTE, rather than checking a prefix. */
export function readOnlySql(sql: string, driver: DatabaseDriver): string {
	if (typeof sql !== "string" || !sql.trim() || sql.length > 100000 || /\/\*!|\/\*\+/.test(sql)) throw Error("Unsupported SQL");
	let ast: any;
	try { ast = parser.astify(sql, { database: driver === "mysql" ? "MySQL" : "Postgresql" }); } catch { throw Error("Unsupported SQL syntax; only a single SELECT query is allowed"); }
	if (Array.isArray(ast)) { if (ast.length !== 1) throw Error("Only one SELECT statement is allowed"); ast = ast[0]; }
	if (ast.type !== "select") throw Error("Only SELECT queries are allowed");
	function check(node: any) {
		if (!node || typeof node !== "object") return;
		if (["insert", "update", "delete", "create", "drop", "alter", "call", "set", "exec", "assign", "var", "param"].includes(node.type)) throw Error("Read-only SQL required");
		if (node.locking_read || node.for_update || node.into?.position || node.into?.keyword) throw Error("Locking and SELECT INTO are not allowed");
		if (["function", "aggr_func", "window_func"].includes(node.type)) {
			const names = typeof node.name === "string" ? [node.name] : node.name?.name?.map((n: any) => n.value);
			if (node.name?.schema || !names || names.length !== 1 || !functions.has(String(names[0]).toUpperCase())) throw Error("Unsupported SQL function; use built-in analytical functions");
		}
		for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(check); else check(value);
	}
	check(ast);
	// Re-serialize the validated AST: comments and parser-ignored suffixes never reach the server.
	return parser.sqlify(ast, { database: driver === "mysql" ? "MySQL" : "Postgresql" });
}
export type Run = Extract<DatabaseOperation, { action: "run" }>;
export function operationSql(request: Run, driver: DatabaseDriver): string {
	const q = (value?: string) => { if (!value || value.length > 512 || value.includes("\0")) throw Error("Invalid database identifier"); return driver === "mysql" ? `\`${value.replace(/`/g, "``")}\`` : `"${value.replace(/"/g, '""')}"`; };
	const lit = (value?: string) => { if (!value || value.includes("\0")) throw Error("Missing name"); return driver === "mysql" ? `CONVERT(0x${Buffer.from(value).toString("hex")} USING utf8mb4)` : `'${value.replace(/'/g, "''")}'`; };
	const db = request.database;
	switch (request.operation) {
		case "query": return readOnlySql(request.sql ?? "", driver);
		case "databases": return driver === "mysql" ? "SELECT schema_name AS name FROM information_schema.schemata ORDER BY schema_name" : "SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname";
		case "tables": return driver === "mysql" ? `SELECT table_schema AS ${q("schema")}, table_name AS name, table_type AS kind FROM information_schema.tables WHERE table_schema = ${lit(db)} ORDER BY table_name` : "SELECT table_schema AS schema, table_name AS name, table_type AS kind FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') UNION ALL SELECT schemaname AS schema, matviewname AS name, 'MATERIALIZED VIEW' AS kind FROM pg_matviews ORDER BY schema, name";
		case "describe": {
			const schema = lit(driver === "mysql" ? db : request.schema), table = lit(request.table);
			const columns = `SELECT 'column' AS kind, column_name AS name, data_type AS definition, is_nullable AS nullable, column_default AS default_value FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${table}`;
			return driver === "postgres" ? `${columns} UNION ALL SELECT 'index', indexname, indexdef, NULL, NULL FROM pg_indexes WHERE schemaname = ${schema} AND tablename = ${table}` : `${columns} UNION ALL SELECT 'index', index_name, CONCAT(index_type, ' (', GROUP_CONCAT(column_name ORDER BY seq_in_index), ')', IF(non_unique = 0, ' UNIQUE', '')), NULL, NULL FROM information_schema.statistics WHERE table_schema = ${schema} AND table_name = ${table} GROUP BY index_name, index_type, non_unique`;
		}
		case "page": {
			const offset = request.offset ?? 0;
			if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw Error("Invalid page offset");
			return `SELECT * FROM ${q(driver === "mysql" ? db : request.schema)}.${q(request.table)} LIMIT 51 OFFSET ${offset}`;
		}
		default: throw Error("Unknown database operation");
	}
}
