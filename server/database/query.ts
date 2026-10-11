import mysql from "mysql2/promise";
import { createConnection } from "mysql2";
import pg from "pg";
import Cursor from "pg-cursor";
import type { DatabaseConfig, DatabaseGrid } from "../protocol.js";
import { operationSql, type Run } from "./sql.js";

type Config = DatabaseConfig & { id?: string; password?: string };
const active = new Set<AbortController>();
const cell = (v: unknown): string | number | boolean | null => v === null || v === undefined ? null : typeof v === "boolean" || typeof v === "number" ? v : Buffer.isBuffer(v) ? `[binary ${v.length} bytes]` : (v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, 4000);
/** A fresh connection/transaction per request: no mutable USE/search_path leaks between chats. */
export async function executeQuery(config: Config, request: Run, external?: AbortSignal): Promise<DatabaseGrid> {
	if (!config.user.trim()) throw Error("Database username is missing; complete the connection settings or duplicate the imported connection to edit");
	if (active.size >= 8) throw Error("Database queries busy; retry shortly");
	const database = request.database || config.db_name || (config.driver === "postgres" ? "postgres" : undefined);
	const sql = operationSql({ ...request, database }, config.driver);
	const controller = new AbortController(); active.add(controller);
	const forward = () => controller.abort(); external?.addEventListener("abort", forward, { once: true });
	if (external?.aborted) controller.abort();
	const timer = setTimeout(() => controller.abort(), 30000);
	const start = Date.now();
	const ssl = config.tls?.enabled ? { rejectUnauthorized: true, verifyIdentity: true, ...(config.tls.ca ? { ca: config.tls.ca } : {}) } : undefined;
	let close: (() => Promise<void>) | undefined;
	let cancel: (() => Promise<void>) | undefined;
	const aborted = () => { void cancel?.().catch(() => {}).finally(() => close?.().catch(() => {})); };
	controller.signal.addEventListener("abort", aborted, { once: true });
	try {
		controller.signal.throwIfAborted();
		let columns: string[] = [], bytes = 0, truncated = false;
		const rows: DatabaseGrid["rows"] = [], limit = request.operation === "page" ? 50 : 1000;
		const consume = (row: unknown[]) => {
			if (rows.length >= limit) { truncated = true; return false; }
			const values = row.map(cell); bytes += Buffer.byteLength(JSON.stringify(values));
			if (bytes > 2 * 1024 * 1024 - 65536) { truncated = true; return false; }
			if (row.some(v => typeof v === "string" && v.length > 4000)) truncated = true;
			rows.push(values); return true;
		};
		if (config.driver === "mysql") {
			const options = { host: config.host, port: config.port, user: config.user, password: config.password, database, ssl, connectTimeout: 10000, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, multipleStatements: false, enableKeepAlive: true };
			const raw = createConnection(options), conn = raw.promise();
			await conn.connect();
			close = async () => { conn.destroy(); };
			cancel = async () => { const killer = await mysql.createConnection(options); try { await killer.query(`KILL QUERY ${Number(conn.threadId)}`); } finally { killer.destroy(); } };
			controller.signal.throwIfAborted();
			const [versions] = await conn.query<any[]>("SELECT VERSION() AS version");
			await conn.query(String(versions[0].version).includes("MariaDB") ? "SET SESSION max_statement_time = 30" : "SET SESSION max_execution_time = 30000");
			await conn.query("START TRANSACTION READ ONLY");
			const query = raw.query({ sql: `SELECT * FROM (${sql}) AS pi_readonly_result LIMIT 1001`, rowsAsArray: true });
			query.on("fields", fields => { columns = (Array.isArray(fields) ? fields : [fields]).map(f => f.name); });
			const stream = query.stream({ highWaterMark: 16 });
			for await (const row of stream) { if (!consume(row)) { await cancel(); break; } }
		} else {
			const options = { host: config.host, port: config.port, user: config.user, password: config.password ?? "", database, ssl: ssl ?? false, connectionTimeoutMillis: 10000, statement_timeout: 30000, application_name: "pi-harness-readonly" };
			const conn = new pg.Client(options);
			conn.on("error", () => {});
			close = () => conn.end();
			await conn.connect();
			const pid = (await conn.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
			cancel = async () => { const killer = new pg.Client(options); try { await killer.connect(); await killer.query("SELECT pg_cancel_backend($1)", [pid]); } finally { await killer.end(); } };
			controller.signal.throwIfAborted();
			await conn.query("BEGIN READ ONLY");
			await conn.query("SET LOCAL search_path = pg_catalog, public");
			const cursor = conn.query(new Cursor(sql, [], { rowMode: "array" }));
			let more = true;
			while (more) {
				const batch = await new Promise<{ rows: unknown[][]; columns?: string[] }>((resolve, reject) => cursor.read(50, (error, data, result) => error ? reject(error) : resolve({ rows: data, columns: result?.fields.map(f => f.name) })));
				if (batch.columns) columns = batch.columns;
				for (const row of batch.rows) if (!consume(row)) { more = false; break; }
				if (batch.rows.length < 50) more = false;
			}
			await cursor.close();
		}
		controller.signal.throwIfAborted();
		const result = { connectionId: config.id ?? "test", database: database ?? "", sql, columns, rows, truncated, elapsedMs: Date.now() - start };
		while (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024 && result.rows.length) { result.rows.pop(); result.truncated = true; }
		return result;
	} catch (error) {
		if (controller.signal.aborted) throw Error("Query cancelled or timed out");
		// Driver messages can contain credentials, SQL literals or server paths: expose codes only.
		const code = (error as { code?: string }).code;
		throw Error(code && /^[A-Z0-9_]{2,60}$/.test(code) ? `Database error: ${code}` : "Database query failed; check connection settings and SQL");
	} finally {
		clearTimeout(timer); external?.removeEventListener("abort", forward); controller.signal.removeEventListener("abort", aborted);
		await close?.().catch(() => {}); active.delete(controller);
	}
}
