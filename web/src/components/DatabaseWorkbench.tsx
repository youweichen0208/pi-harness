import { useEffect, useRef, useState } from "react";
import { FiDatabase, FiTable, FiSearch, FiPlus, FiRefreshCw, FiLink, FiX, FiCheckCircle } from "react-icons/fi";
import { DatabaseSqlEditor } from "./DatabaseSqlEditor";
import { quoteDatabaseName } from "../database-completion";
import { useT } from "../i18n";
import { startDatabaseSync } from "../database-sync";
import { databaseErrorMessages } from "../../../server/database/errors";
import { databaseRequest } from "../database-api";
import { randomUuid } from "../uuid";
import type { DatabaseJdbcSelection, DatabaseJdbcDriver, DatabaseConfig, DatabaseConnection, DatabaseGrid, DatabaseImportPreview, DatabaseOperation, DatabaseResponse } from "../types";
import type { ChatReferenceRequest } from "../chat-reference";

const jdbcErrors = {
	JDBC_DISABLED: "dbJdbcDisabled", JDBC_JAR_MISSING: "dbJdbcJarMissing", JDBC_JAR_UNREADABLE: "dbJdbcJarUnreadable", JDBC_JAR_TOO_LARGE: "dbJdbcJarTooLarge", JDBC_LIBRARY_UNSUPPORTED: "dbJdbcLibraryUnsupported",
	JDBC_CONFIG_INVALID: "dbJdbcConfigInvalid", JDBC_DRIVER_FILES: "dbJdbcFiles", JDBC_DRIVER_CHANGED: "dbJdbcChanged", JDBC_DRIVER_MISSING: "dbJdbcMissing", JDBC_DRIVER_AMBIGUOUS: "dbJdbcAmbiguous", JDBC_SETTINGS_UNSUPPORTED: "dbJdbcSettings", JDBC_URL_UNSUPPORTED: "dbJdbcUrl", JDBC_TLS_UNSUPPORTED: "dbJdbcTls", JDBC_CERTIFICATE_MISSING: "dbJdbcCertificate", JDBC_JAVA_UNAVAILABLE: "dbJdbcJavaMissing", JDBC_BRIDGE_MISSING: "dbJdbcBridge", JDBC_DRIVER_LOAD_FAILED: "dbJdbcLoad", JDBC_CONNECTION_FAILED: "dbJdbcConnect", JDBC_READONLY_REQUIRED: "dbJdbcReadOnly", JDBC_QUERY_FAILED: "dbJdbcQuery", JDBC_BRIDGE_FAILED: "dbJdbcBridge",
} as const;
const blank = (): DatabaseConfig & { password?: string; id?: string; version?: string } => ({ name: "", driver: "mysql", host: "localhost", port: 3306, user: "", db_name: "", password: "", tls: { enabled: false } });
type Table = { schema: string; name: string; kind: string };
export function DatabaseWorkbench({ cwd, conversationId, onReference, onRevoke }: { cwd: string; conversationId: string; onReference: (request: ChatReferenceRequest) => void; onRevoke: (id: string) => Promise<void> }) {
	const t = useT();
	const [connections, setConnections] = useState<DatabaseConnection[]>([]), [grants, setGrants] = useState<string[]>([]);
	const [selected, setSelected] = useState(""), [databases, setDatabases] = useState<string[]>([]), [database, setDatabase] = useState("");
	const [tables, setTables] = useState<Table[]>([]), [table, setTable] = useState<Table>();
	const [catalogTruncated, setCatalogTruncated] = useState(false);
	const [catalogFailed, setCatalogFailed] = useState(false);
	const [tab, setTab] = useState<"page" | "describe" | "query">("page"), [grid, setGrid] = useState<DatabaseGrid>();
	const [offset, setOffset] = useState(0), [search, setSearch] = useState(""), [error, setError] = useState("");
	const [sql, setSql] = useState(() => { try { return sessionStorage.getItem(`pi-db-sql:${cwd}:${conversationId}`) ?? "SELECT 1 AS example"; } catch { return "SELECT 1 AS example"; } });
	const [form, setForm] = useState<ReturnType<typeof blank>>();
	const [importing, setImporting] = useState(false), [kind, setKind] = useState<"datagrip" | "dbeaver">("dbeaver"), [path, setPath] = useState("");
	const [sources, setSources] = useState<{ kind: "datagrip" | "dbeaver"; path: string }[]>([]), [preview, setPreview] = useState<DatabaseImportPreview>(), [chosen, setChosen] = useState<string[]>([]);
	const [jdbcChoices, setJdbcChoices] = useState<{ connection: DatabaseConnection; drivers: DatabaseJdbcDriver[] }>();
	const [jdbcEditing, setJdbcEditing] = useState(false);
	const [jdbcManual, setJdbcManual] = useState(false), [jdbcClass, setJdbcClass] = useState("org.postgresql.Driver"), [jdbcPaths, setJdbcPaths] = useState("");
	const [jdbcSourceId, setJdbcSourceId] = useState(""), [jdbcTargets, setJdbcTargets] = useState<{ id: string; name: string }[]>([]);
	const [jdbcConfigDir, setJdbcConfigDir] = useState(""), [jdbcDriverId, setJdbcDriverId] = useState(""), [jdbcDrivers, setJdbcDrivers] = useState<DatabaseJdbcDriver[]>([]), [jdbcRuntime, setJdbcRuntime] = useState<DatabaseResponse["jdbcRuntime"]>();
	const jdbcMessage = (message: string) => { const code = message.match(/JDBC_[A-Z_]+$/)?.[0] as keyof typeof jdbcErrors | undefined; return code && jdbcErrors[code] ? message.replace(code, t(jdbcErrors[code])) : /^SQLSTATE_/.test(message) ? `${t("dbJdbcQuery")} (${message.slice(9)})` : message; };
	const [syncError, setSyncError] = useState("");
	const [success, setSuccess] = useState("");
	useEffect(() => { if (!success) return; const timer = setTimeout(() => setSuccess(""), 5000); return () => clearTimeout(timer); }, [success]);
	const errorLabel = error === databaseErrorMessages.authProtocol ? t("dbAuthProtocolError") : error === databaseErrorMessages.auth ? t("dbAuthError") : error === databaseErrorMessages.network ? t("dbNetworkError") : error === databaseErrorMessages.tls ? t("dbTlsError") : jdbcMessage(error);
	const foreground = useRef(false), synchronize = useRef<() => Promise<void>>();
	const [busy, setBusy] = useState(false), [selectedRows, setSelectedRows] = useState<number[]>([]);
	const life = useRef(new AbortController()), operation = useRef<AbortController>(), sequence = useRef(0), job = useRef<string>();
	const connection = connections.find(c => c.id === selected);
	const formSource = connections.find(c => c.id === form?.id)?.source;
	const sourceManaged = !!form?.id && !!connections.find(c => c.id === form.id)?.source;
	useEffect(() => {
		life.current = new AbortController(); foreground.current = false;
		setConnections([]); setGrants([]); setSelected(""); setForm(undefined); setImporting(false); setJdbcEditing(false); setPreview(undefined); setJdbcSourceId(""); setJdbcTargets([]); setSyncError(""); setError(""); setJdbcChoices(undefined);
		const sync = startDatabaseSync({
			request: signal => databaseRequest(cwd, conversationId, { action: "sync" }, signal),
			canStart: () => !foreground.current,
			revision: () => sequence.current,
			receive: r => { setConnections(r.connections ?? []); setJdbcRuntime(r.jdbcRuntime); setGrants(r.grants ?? []); setSyncError(""); },
			error: e => setSyncError((e as Error).message),
		});
		synchronize.current = sync.refresh;
		const focus = () => { void sync.refresh(); };
		window.addEventListener("focus", focus);
		return () => { sync.stop(); window.removeEventListener("focus", focus); life.current.abort(); operation.current?.abort(); sequence.current++; };
	}, [cwd, conversationId]);
	useEffect(() => { setDatabases([]); setDatabase(""); setTables([]); setCatalogTruncated(false); setTable(undefined); setGrid(undefined); setSelectedRows([]); setError(""); }, [connection?.id, connection?.version]);
	useEffect(() => { try { sessionStorage.setItem(`pi-db-sql:${cwd}:${conversationId}`, sql); } catch { /* optional draft cache */ } }, [sql, cwd, conversationId]);
	async function task(fn: (signal: AbortSignal, current: () => boolean) => Promise<void>) {
		operation.current?.abort(); const controller = new AbortController(); operation.current = controller;
		const n = ++sequence.current, current = () => !controller.signal.aborted && !life.current.signal.aborted && n === sequence.current;
		foreground.current = true; setBusy(true); setError(""); setSuccess(""); setCatalogFailed(false);
		try { await fn(controller.signal, current); } catch (e) { if (current()) setError((e as Error).message); }
		finally { if (current()) { foreground.current = false; setBusy(false); } }
	}
	async function request(op: DatabaseOperation, signal: AbortSignal) { const id = randomUuid(); job.current = id; return databaseRequest(cwd, conversationId, op, signal, id); }
	function run(c: DatabaseConnection, operation: "databases" | "tables" | "page" | "describe" | "query", db = database, target = table, start = offset) {
		return { action: "run", id: c.id, version: c.version, operation, database: db, schema: target?.schema, table: target?.name, offset: start, sql } as const;
	}
	function resetOperation() {
		operation.current?.abort(); sequence.current++; foreground.current = false; setBusy(false); setError(""); setSuccess(""); setCatalogFailed(false); setJdbcChoices(undefined);
	}
	function configureJdbc(sourcePath: string, sourceId = "", selection?: DatabaseJdbcSelection) {
		resetOperation(); setForm(undefined); setImporting(true); setKind("datagrip"); setPath(sourcePath); setPreview(undefined);
		const mapped = connections.find(c => c.source?.path === sourcePath && c.source.id === sourceId);
		selection ??= mapped?.source?.jdbcSelection;
		setJdbcConfigDir(selection?.configDir ?? ""); setJdbcDriverId(selection?.driverId ?? ""); setJdbcDrivers([]);
		setJdbcSourceId(sourceId); setJdbcTargets(sourceId ? [{ id: sourceId, name: mapped?.name ?? sourceId }] : []);
		setJdbcEditing(!!sourceId); setJdbcManual(true); setJdbcClass(selection?.driverClass ?? mapped?.jdbc?.driverClass ?? "org.postgresql.Driver"); setJdbcPaths(selection?.jarPaths?.join("\n") ?? "");
	}
	function allowJdbc(c: DatabaseConfig & { needsTest?: boolean }) {
		return !c.jdbc || c.needsTest === false || window.confirm(`${t("dbJdbcConfirm")}\n${c.jdbc.driverClass}\n${c.jdbc.jarNames.join(", ")}`);
	}
	function repairJdbc(c: DatabaseConnection, driver?: DatabaseJdbcDriver) {
		setJdbcChoices(undefined);
		void task(async (signal, current) => {
			let target = c;
			if (form?.id === c.id && form.password !== undefined) {
				const saved = await request({ action: "save", connection: { ...c, password: form.password } }, signal);
				if (!current()) return;
				target = saved.connections!.find(item => item.id === c.id)!;
				setConnections(saved.connections ?? []);
			}
			let configured: DatabaseResponse;
			try { configured = await request({ action: "jdbc_configure", id: target.id, version: target.version, configDir: driver?.configDir, driverId: driver?.id }, signal); }
			catch (e) {
				if (current() && /^JDBC_/.test((e as Error).message) && target.source) { configureJdbc(target.source.path, target.source.id, target.source.jdbcSelection); setError((e as Error).message); return; }
				throw e;
			}
			if (!current()) return;
			setConnections(configured.connections ?? []); setJdbcRuntime(configured.jdbcRuntime);
			if (configured.jdbcDrivers) { setJdbcChoices({ connection: target, drivers: configured.jdbcDrivers }); return; }
			const updated = configured.connections?.find(item => item.id === target.id);
			if (!updated) return;
			setForm(undefined); setSelected(updated.id);
			if (!allowJdbc(updated)) return;
			const result = await request({ action: "test", connection: updated }, signal);
			if (!current()) return;
			setConnections(result.connections ?? []); setJdbcRuntime(result.jdbcRuntime); setSuccess(t("dbTestSuccess"));
			await loadCatalog(updated, signal, current);
			if (!current()) return;
			const synced = await request({ action: "sync" }, signal);
			if (current()) { setConnections(synced.connections ?? []); setSyncError(""); }
		});
	}

	async function requestCatalog(c: DatabaseConnection, op: "databases" | "tables", db: string, signal: AbortSignal, current: () => boolean) {
		try { return await request(run(c, op, db), signal); }
		catch (e) { if (current()) { setCatalogFailed(true); setSuccess(""); } throw e; }
	}
	async function loadCatalog(c: DatabaseConnection, signal: AbortSignal, current: () => boolean) {
		const r = await requestCatalog(c, "databases", c.db_name, signal, current);
		if (!current()) return;
		const names = r.grid?.rows.map(row => String(row[0])) ?? [];
		setDatabases(names);
		const db = c.db_name || names[0];
		if (db && !names.includes(db)) setDatabases([db, ...names]);
		if (!db) return;
		setDatabase(db);
		const result = await requestCatalog(c, "tables", db, signal, current);
		if (current()) { setTables(result.grid?.rows.map(row => ({ schema: String(row[0]), name: String(row[1]), kind: String(row[2]) })) ?? []); setCatalogTruncated(!!result.grid?.truncated); }
	}
	function openConnection(c: DatabaseConnection) {
		resetOperation();
		setSelected(c.id); setDatabase(""); setDatabases([]); setTables([]); setCatalogTruncated(false); setTable(undefined); setGrid(undefined); setForm(undefined); setImporting(false);
		if (c.issue || c.needsTest) return;
		void task((signal, current) => loadCatalog(c, signal, current));
	}
	function openDatabase(db: string) {
		if (!connection) return; setDatabase(db); setTables([]); setCatalogTruncated(false); setTable(undefined); setGrid(undefined);
		void task(async (signal, current) => { const r = await requestCatalog(connection, "tables", db, signal, current); if (current()) { setTables(r.grid?.rows.map(row => ({ schema: String(row[0]), name: String(row[1]), kind: String(row[2]) })) ?? []); setCatalogTruncated(!!r.grid?.truncated); } });
	}
	function show(target: Table | undefined, nextTab = tab, start = 0) {
		if (!connection) return; setTable(target); setTab(nextTab); setOffset(start); setSelectedRows([]); setGrid(undefined);
		if (nextTab !== "query" && !target) return;
		void task(async (signal, current) => { const r = await request(run(connection, nextTab, database, target, start), signal); if (current()) setGrid(r.grid); });
	}
	function ask(rows = false) {
		if (!connection) return;
		const location = [connection.name, database, table?.schema, table?.name].filter(Boolean).join(" / ");
		let content = `${t("dbReferenceText")} ${location}`;
		if (rows && grid) {
			const snapshot = { sql: grid.sql, columns: grid.columns, rows: grid.rows.filter((_, index) => selectedRows.includes(index)), truncated: grid.truncated };
			while (JSON.stringify(snapshot).length > 24000 && snapshot.rows.length) { snapshot.rows.pop(); snapshot.truncated = true; }
			content = JSON.stringify(snapshot);
		}
		onReference({ id: randomUuid(), cwd, conversationId, path: `database:${connection.id} · ${location}`, text: content, database: { id: connection.id, name: connection.name, version: connection.version } });
	}
	function previewSource(content?: string, filePath = path, fromDataGrip = false) {
		void task(async (signal, current) => { const r = await request({ action: "preview", kind, path: filePath, content, ...(kind === "datagrip" ? { jdbcSelection: { configDir: jdbcConfigDir || undefined, driverId: (fromDataGrip || !jdbcManual) && jdbcSourceId ? jdbcDriverId || undefined : undefined, sourceId: jdbcSourceId || undefined, ...(!fromDataGrip && jdbcManual && jdbcSourceId ? { driverClass: jdbcClass.trim(), jarPaths: jdbcPaths.split(/\r?\n/).map(p => p.trim()).filter(Boolean) } : {}) } } : {}) }, signal); if (current()) { if (fromDataGrip) setJdbcManual(!!r.preview?.items.some(i => (!jdbcSourceId || i.sourceId === jdbcSourceId) && i.issue)); setPreview(r.preview); setJdbcTargets(r.preview?.items.map(i => ({ id: i.sourceId, name: i.connection.name })) ?? []); setChosen(r.preview?.items.filter(i => (!i.issue || i.change !== "new") && i.change !== "unchanged").map(i => i.key) ?? []); } });
	}
	function saveManualJdbc() {
		void task(async (signal, current) => {
			const r = await request({ action: "preview", kind: "datagrip", path, jdbcSelection: { sourceId: jdbcSourceId, driverClass: jdbcClass.trim(), jarPaths: jdbcPaths.split(/\r?\n/).map(p => p.trim()).filter(Boolean) } }, signal);
			if (!current()) return;
			const item = r.preview?.items.find(i => i.sourceId === jdbcSourceId);
			if (!item || !r.preview) throw Error("JDBC_CONFIG_INVALID");
			if (item.issue) throw Error(item.issue);
			const saved = await request({ action: "import", ticket: r.preview.ticket, keys: [item.key] }, signal);
			if (!current()) return;
			setConnections(saved.connections ?? []); setJdbcRuntime(saved.jdbcRuntime);
			const updated = saved.connections?.find(c => c.source?.path === path && c.source.id === jdbcSourceId);
			if (!updated) return;
			setSelected(updated.id); setImporting(false);
			if (!allowJdbc(updated)) return;
			const result = await request({ action: "test", connection: updated }, signal);
			if (!current()) return;
			setConnections(result.connections ?? []); setSuccess(t("dbTestSuccess"));
			await loadCatalog(updated, signal, current);
			if (!current()) return;
			const synced = await request({ action: "sync" }, signal);
			if (current()) { setConnections(synced.connections ?? []); setSyncError(""); }
		});
	}

	const refresh = () => { void synchronize.current?.(); };
	return <section className="database-workbench" aria-label={t("dbTitle")}>
		<aside className="database-sidebar">
			<label className="file-search-trigger"><FiSearch /><input aria-label={t("dbSearch")} placeholder={t("dbSearch")} value={search} onChange={e => setSearch(e.target.value)} /></label>
			<div className="database-actions"><button onClick={() => { resetOperation(); setForm(blank()); setImporting(false); }}><FiPlus />{t("dbNew")}</button><button onClick={() => { resetOperation(); setJdbcEditing(false); setJdbcManual(false); setJdbcSourceId(""); setJdbcDriverId(""); setJdbcDrivers([]); setPreview(undefined); setImporting(true); setForm(undefined); }}>{t("dbImport")}</button><button disabled={busy} aria-label={t("dbRefresh")} onClick={refresh}><FiRefreshCw /></button></div>
			<div className="database-tree">{connections.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.id === selected).map(c => <div key={c.id}>
				<button className={`database-tree-row${selected === c.id ? " selected" : ""}`} title={`${c.host}:${c.port}`} onClick={() => openConnection(c)}><FiDatabase /><span>{c.name}</span>{c.issue || c.needsTest ? <small>!</small> : null}</button>
				{selected === c.id && databases.map(db => <div key={db} className="database-indent"><button className={`database-tree-row${database === db ? " selected" : ""}`} onClick={() => openDatabase(db)}><FiDatabase /><span>{db}</span></button>
					{database === db && [...new Set(tables.map(t => t.schema))].map(schema => <details key={schema} open className="database-indent"><summary>{schema}</summary>{tables.filter(t => t.schema === schema && t.name.toLowerCase().includes(search.toLowerCase())).map(item => <div className="database-table-row" key={item.name}><button className={`database-tree-row${table?.name === item.name && table.schema === item.schema ? " selected" : ""}`} onClick={() => show(item, "page")}><FiTable /><span>{item.name}</span></button><button aria-label={`${t("dbAsk")} ${item.name}`} title={t("dbAsk")} onClick={() => { setTable(item); onReference({ id: randomUuid(), cwd, conversationId, path: `database:${c.id} · ${c.name}/${db}/${schema}/${item.name}`, text: t("dbReferenceText"), database: { id: c.id, name: c.name, version: c.version } }); }}><FiLink /></button></div>)}</details>)}
				</div>)}
			</div>)}</div>
			<p className="database-hint">{t("dbAutoSync")}</p>
			<p className="database-hint">{t("dbWorkbenchReadOnly")}</p>
		</aside>
		<div className="database-main">
			{success && <div className="database-success" role="status"><FiCheckCircle aria-hidden="true" />{success}</div>}
			{syncError && <div role="alert" className="database-error">{t("dbSyncFailed")} · {syncError}<button onClick={refresh}>{t("dbRefresh")}</button></div>}
			{error && <div role="alert" className="database-error"><span>{catalogFailed && <strong>{t("dbCatalogFailed")} </strong>}{errorLabel}</span>{catalogFailed && connection && <button disabled={busy} onClick={() => database ? openDatabase(database) : openConnection(connection)}>{t("dbCatalogRetry")}</button>}{error === databaseErrorMessages.authProtocol && (form?.id ? connections.find(c => c.id === form.id) : connection)?.source?.kind === "datagrip" && !(formSource ?? connection?.source)?.path.startsWith("upload:") && <button disabled={busy} onClick={() => repairJdbc((form?.id ? connections.find(c => c.id === form.id) : connection)!)}>{t("dbJdbcRepair")}</button>}<button aria-label={t("close")} onClick={() => setError("")}><FiX /></button></div>}
			{jdbcChoices && <div role="dialog" aria-label={t("dbJdbcChoose")} className="database-hint database-jdbc-choices"><p>{t("dbJdbcChoose")}</p>{jdbcChoices.drivers.map(d => <button disabled={busy} key={JSON.stringify([d.configDir, d.id])} onClick={() => repairJdbc(jdbcChoices.connection, d)}>{d.name} · {d.driverClass} · {d.configDir}</button>)}<button onClick={() => setJdbcChoices(undefined)}>{t("cancel")}</button></div>}
			{busy && <div className="database-busy">{t("loading")}<button onClick={() => { if (job.current) void databaseRequest(cwd, conversationId, { action: "cancel", target: job.current }).catch(() => {}); operation.current?.abort(); foreground.current = false; setBusy(false); }}>{t("cancel")}</button></div>}
			{form ? <form className="database-form" onSubmit={e => { e.preventDefault(); void task(async (signal, current) => { const r = await request({ action: "save", connection: form }, signal); if (current()) { setConnections(r.connections ?? []); setForm(undefined); } }); }}>
				<h3>{form.id ? t("dbEdit") : t("dbNew")}</h3>
				{sourceManaged && <p className="database-hint">{t("dbSourceManaged")}</p>}
				{formSource?.kind === "datagrip" && !formSource.path.startsWith("upload:") && <button type="button" onClick={() => configureJdbc(formSource.path, formSource.id, formSource.jdbcSelection)}>{t("dbJdbcConfigure")}</button>}
				<label>{t("dbName")}<input required disabled={sourceManaged} value={form.name} onChange={e => { setForm({ ...form, name: e.target.value }); }} /></label>
				<label>driver<select disabled={sourceManaged} value={form.driver} onChange={e => { const driver = e.target.value as DatabaseConfig["driver"]; setForm({ ...form, driver, port: driver === "mysql" ? 3306 : 5432 }); }}><option value="mysql">MySQL / MariaDB</option><option value="postgres">PostgreSQL</option>{form.driver === "gaussdb" && <option value="gaussdb">GaussDB / PostgreSQL (JDBC)</option>}</select></label>
				{(["host", "port", "user", "db_name"] as const).map(field => <label key={field}>{field}<input disabled={sourceManaged} required={field === "host" || field === "port"} type={field === "port" ? "number" : "text"} value={form[field]} onChange={e => { setForm({ ...form, [field]: field === "port" ? Number(e.target.value) : e.target.value }); }} /></label>)}
				<label>password<input type="password" autoComplete="new-password" value={form.password ?? ""} placeholder={form.id ? t("dbKeepPassword") : ""} onChange={e => { setForm({ ...form, password: e.target.value || (form.id ? undefined : "") }); }} /></label>
				<label className="database-checkbox"><input type="checkbox" disabled={sourceManaged} checked={form.tls?.enabled ?? false} onChange={e => { setForm({ ...form, tls: { ...form.tls, enabled: e.target.checked } }); }} />TLS</label>
				{form.driver === "gaussdb" && jdbcRuntime === "missing" && <p className="database-hint">{t("dbJdbcJavaMissing")}</p>}
				{form.driver === "gaussdb" && <p className="database-hint">{t("dbJdbcSourceManaged")}</p>}
				{form.tls?.enabled && form.driver !== "gaussdb" && <label>{t("dbCA")}<textarea disabled={sourceManaged} value={form.tls.ca ?? ""} onChange={e => { setForm({ ...form, tls: { enabled: true, ca: e.target.value || undefined } }); }} /></label>}
				<div className="database-actions"><button type="button" disabled={busy} onClick={() => void task(async (signal, current) => { if (!allowJdbc({ ...form, needsTest: connections.find(c => c.id === form.id)?.needsTest })) return; const r = await request({ action: "test", connection: form }, signal); if (current()) { setSuccess(t("dbTestSuccess")); setConnections(r.connections ?? []); } })}>{t("dbTest")}</button><button disabled={busy} type="submit">{t("save")}</button><button type="button" onClick={() => setForm(undefined)}>{t("cancel")}</button></div>
			</form> : importing ? <div className="database-import"><h3>{t(jdbcEditing ? "dbJdbcConfigure" : "dbImport")}</h3>{!jdbcEditing && <><p className="database-hint">{t("dbImportHint")}</p>
				<div className="database-actions"><select aria-label={t("dbSource")} value={kind} onChange={e => { setKind(e.target.value as typeof kind); setPreview(undefined); }}><option value="dbeaver">DBeaver</option><option value="datagrip">DataGrip</option></select><button disabled={busy} onClick={() => void task(async (signal, current) => { const r = await request({ action: "scan" }, signal); if (current()) setSources(r.sources ?? []); })}>{t("dbScan")}</button><label className="database-upload">{t("dbUpload")}<input type="file" accept=".json,.xml" onChange={async e => { const f = e.target.files?.[0]; if (f) { if (f.size > 2 * 1024 * 1024) { setError(t("dbFileTooLarge")); return; } previewSource(await f.text(), f.name); } }} /></label></div>
				{sources.map(s => <button className="database-source" key={s.path} onClick={() => { setPath(s.path); setKind(s.kind); setPreview(undefined); }}>{s.kind} · {s.path}</button>)}
				<label>{t("dbSourcePath")}<input aria-describedby="database-source-path-hint" placeholder={kind === "datagrip" ? "/path/.idea/dataSources.xml" : "/path/.dbeaver/data-sources.json"} value={path} onChange={e => { setPath(e.target.value); setJdbcSourceId(""); setJdbcTargets([]); setPreview(undefined); }} /></label><p id="database-source-path-hint" className="database-hint">{t("dbSourcePathHint")}</p><button disabled={busy || !path.trim()} onClick={() => previewSource()}>{t("dbPreview")}</button>
				</>}
				{kind === "datagrip" && jdbcRuntime === "missing" && <p className="database-hint">{t("dbJdbcJavaMissing")}</p>}
				{kind === "datagrip" && <details key={jdbcManual ? "manual" : "auto"} open={jdbcManual || undefined} className="database-hint database-jdbc-mapping"><summary>{t("dbJdbcMapping")}</summary>{jdbcManual && <><label>{t("dbJdbcClass")}<input aria-label={t("dbJdbcClass")} value={jdbcClass} onChange={e => { setJdbcClass(e.target.value); setPreview(undefined); }} /></label><label>{t("dbJdbcPaths")}<textarea aria-label={t("dbJdbcPaths")} rows={4} spellCheck={false} value={jdbcPaths} onChange={e => { setJdbcPaths(e.target.value); setPreview(undefined); }} /></label><p>{t("dbJdbcManualHint")}</p></>}<button disabled={busy || !path} onClick={() => previewSource(undefined, path, true)}>{t("dbJdbcReadDataGrip")}</button>{jdbcManual && jdbcEditing && <button disabled={busy || !jdbcSourceId || !jdbcClass.trim() || !jdbcPaths.trim()} onClick={saveManualJdbc}>{t("dbJdbcSaveTest")}</button>}<details open={!jdbcEditing || undefined}><summary>{t("dbJdbcOptions")}</summary><label>{t("dbJdbcConfigDir")}<input value={jdbcConfigDir} onChange={e => { setJdbcConfigDir(e.target.value); setJdbcDriverId(""); setJdbcDrivers([]); setPreview(undefined); }} /></label><button disabled={busy} onClick={() => void task(async (signal, current) => { const r = await request({ action: "jdbc_drivers", configDir: jdbcConfigDir || undefined }, signal); if (current()) { setJdbcDrivers(r.jdbcDrivers ?? []); setJdbcRuntime(r.jdbcRuntime); } })}>{t("dbJdbcFindDrivers")}</button><label>{t("dbJdbcDriver")}<select aria-label={t("dbJdbcDriver")} disabled={jdbcManual} value={jdbcDriverId ? JSON.stringify([jdbcConfigDir, jdbcDriverId]) : ""} onChange={e => { const [dir, id] = e.target.value ? JSON.parse(e.target.value) : [jdbcConfigDir, ""]; setJdbcConfigDir(dir); setJdbcDriverId(id); setPreview(undefined); }}><option value="">{t("dbJdbcAutomatic")}</option>{jdbcDrivers.map(d => <option key={JSON.stringify([d.configDir, d.id])} value={JSON.stringify([d.configDir, d.id])}>{d.name} · {d.driverClass} · {d.configDir}</option>)}</select></label><label>{t("dbJdbcTarget")}<select aria-label={t("dbJdbcTarget")} value={jdbcSourceId} onChange={e => { setJdbcSourceId(e.target.value); setPreview(undefined); }}><option value="">{t("dbJdbcSelectTarget")}</option>{jdbcTargets.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="database-checkbox"><input type="checkbox" checked={jdbcManual} onChange={e => { setJdbcManual(e.target.checked); setPreview(undefined); }} />{t("dbJdbcManual")}</label><p>{t("dbJdbcMappingHint")}</p></details></details>}
				{jdbcEditing && jdbcManual && preview?.items.filter(i => i.sourceId === jdbcSourceId && i.issue).map(i => <p key={i.key} className="database-error">{jdbcMessage(i.issue!)}</p>)}
				{preview && (!jdbcEditing || !jdbcManual) && <><p>{preview.source}</p><div className="database-import-list">{preview.items.map(i => <label key={i.key}><input type="checkbox" disabled={!!i.issue && i.change === "new"} checked={chosen.includes(i.key)} onChange={e => setChosen(v => e.target.checked ? [...v, i.key] : v.filter(k => k !== i.key))} /><span><strong>{i.connection.name}</strong> · {t(({ new: "dbAdded", updated: "dbUpdated", unchanged: "dbUnchanged", missing: "dbMissing" } as const)[i.change])}<small>{i.connection.driver} · {i.connection.host}:{i.connection.port} · {i.connection.user} · {i.connection.db_name}</small>{!i.hasPassword && <small>{t("dbPasswordMissing")}</small>}{i.issue && <small className="database-error">{jdbcMessage(i.issue)}</small>}</span></label>)}</div><button disabled={busy || !chosen.length} onClick={() => void task(async (signal, current) => { const r = await request({ action: "import", ticket: preview.ticket, keys: chosen }, signal); if (current()) { setConnections(r.connections ?? []); setPreview(undefined); setImporting(false); const synced = await request({ action: "sync" }, signal); if (current()) { setConnections(synced.connections ?? []); setSyncError(""); } } })}>{t("dbApplyImport")}</button></>}
			</div> : connection ? <>
				<header className="database-heading"><div><strong>{connection.name}</strong><small>{connection.jdbc ? "GaussDB / PostgreSQL (JDBC)" : connection.driver} · {connection.host}:{connection.port}{database ? ` / ${database}` : ""}{table ? ` / ${table.schema}.${table.name}` : ""}</small></div><button onClick={() => ask()}><FiLink />{t("dbAsk")}</button></header>
				<div className="database-actions"><button onClick={() => { resetOperation(); setForm({ ...connection, password: undefined }); }}>{t("dbEdit")}</button><button disabled={busy || !!connection.issue} onClick={() => void task(async (signal, current) => { if (!allowJdbc(connection)) return; const r = await request({ action: "test", connection }, signal); if (current()) { setConnections(r.connections ?? []); setJdbcRuntime(r.jdbcRuntime); setSuccess(t("dbTestSuccess")); await loadCatalog(r.connections?.find(c => c.id === connection.id) ?? connection, signal, current); } })}>{t("dbTest")}</button>
				<details className="database-connection-options" key={connection.id}><summary>{t("dbConnectionOptions")}</summary><div className="database-options-body"><div className="database-actions"><button disabled={connection.driver === "gaussdb"} onClick={() => { resetOperation(); const { id, version, hasPassword, source, issue, needsTest, ...copy } = connection; setForm({ ...copy, name: `${copy.name} ${t("dbCopy")}`, password: "" }); }}>{t("dbCopy")}</button><button disabled={busy} onClick={() => { if (connection.source?.path.startsWith("upload:")) { setPath(connection.source.path.slice(7)); setKind(connection.source.kind); setImporting(true); } else refresh(); }}>{t("dbSync")}</button><button disabled={busy} onClick={() => void task(async (signal, current) => { const r = await request({ action: "delete", id: connection.id, version: connection.version }, signal); if (current()) { setConnections(r.connections ?? []); setSelected(""); } })}>{t("dbDelete")}</button></div>
				{connection.source?.kind === "datagrip" && !connection.source.path.startsWith("upload:") && <button onClick={() => configureJdbc(connection.source!.path, connection.source!.id, connection.source!.jdbcSelection)}>{t("dbJdbcConfigure")}</button>}
				{connection.source?.kind === "datagrip" && !connection.source.path.startsWith("upload:") && <button disabled={busy} onClick={() => repairJdbc(connection)}>{t("dbJdbcRepair")}</button>}
				{connection.jdbc && <button disabled={busy} onClick={() => void task(async (signal, current) => { const r = await request({ action: "jdbc_configure", id: connection.id, version: connection.version, mode: "disabled" }, signal); if (current()) setConnections(r.connections ?? []); })}>{t("dbJdbcRemove")}</button>}
				{connection.jdbc && <div className="database-hint"><strong>GaussDB / PostgreSQL (JDBC)</strong><p>{t(!connection.source?.jdbcSelection?.jarPaths ? "dbJdbcAutoMatched" : "dbJdbcConfigured")}</p><p>{connection.jdbc.driverClass} · {connection.jdbc.jarNames.join(", ")}</p>{jdbcRuntime && <p>{t(jdbcRuntime === "detected" ? "dbJdbcJavaDetected" : "dbJdbcJavaMissing")}</p>}</div>}
				<p className="database-hint">{t("dbGrantHint")}</p></div></details></div>
				{connection.issue && <p className="database-error">{jdbcMessage(connection.issue)}</p>}
				{connection.needsTest && <p className="database-hint">{t("dbRetest")}</p>}
				{!connection.hasPassword && <p className="database-hint">{t("dbPasswordMissing")}</p>}
				{grants.includes(connection.id) && <p className="database-hint"><button onClick={() => void task(async (_signal, current) => { await onRevoke(connection.id); if (current()) setGrants(g => g.filter(id => id !== connection.id)); })}>{t("dbRevoke")}</button></p>}
				{catalogTruncated && <p className="database-hint">{t("dbMetadataTruncated")}</p>}
				<nav className="database-tabs">{(["page", "describe", "query"] as const).map(value => <button key={value} disabled={busy} aria-pressed={tab === value} onClick={() => { if (catalogFailed && error) { setTab(value); return; } resetOperation(); if (value === "query") { setTab(value); setGrid(undefined); setSelectedRows([]); } else show(table, value); }}>{t(({ page: "dbData", describe: "dbStructure", query: "dbSql" } as const)[value])}</button>)}</nav>
				{tab === "query" && <div className="database-sql"><DatabaseSqlEditor key={`${connection.id}:${connection.version}:${database}`} value={sql} onChange={setSql} onRun={() => { if (!busy && !connection.needsTest && !connection.issue) show(table, "query"); }} tables={tables} mysql={connection.driver === "mysql"} /><div className="database-query-actions"><small id="database-sql-help">{t(tables.length ? "dbSqlHelp" : "dbSqlNoMetadata")}</small><button className="database-primary" disabled={busy || !!connection.needsTest || !!connection.issue} onClick={() => show(table, "query")}>{t("dbRun")}</button></div></div>}
				{grid ? <><div className="database-result-meta"><span>{grid.rows.length} {t("dbRowCount")} · {grid.elapsedMs} ms{grid.truncated ? ` · ${t("dbTruncated")}` : ""}</span><button disabled={!selectedRows.length} onClick={() => ask(true)}>{t("dbAskRows")} ({selectedRows.length})</button></div><div className="database-grid"><table><thead><tr><th scope="col">#</th>{grid.columns.map((c, i) => <th scope="col" key={i}>{c}</th>)}</tr></thead><tbody>{!grid.rows.length && <tr><td colSpan={grid.columns.length + 1} className="database-empty">{t("dbResultEmpty")}</td></tr>}{grid.rows.map((row, index) => <tr key={index} className={selectedRows.includes(index) ? "selected" : undefined}><td><span className="database-row-number">{(tab === "page" ? offset : 0) + index + 1}</span><input type="checkbox" aria-label={`${t("dbSelectRows")} ${index + 1}`} checked={selectedRows.includes(index)} onChange={e => setSelectedRows(rows => e.target.checked ? [...rows, index] : rows.filter(i => i !== index))} /></td>{row.map((v, i) => <td key={i}>{v === null ? <span className="database-null">NULL</span> : String(v)}</td>)}</tr>)}</tbody></table></div>{tab === "page" && <div className="database-actions"><button disabled={busy || offset === 0} onClick={() => show(table, "page", Math.max(0, offset - 50))}>{t("dbPrevious")}</button><span>{grid.rows.length ? offset + 1 : 0}–{offset + grid.rows.length}</span><button disabled={busy || !grid.truncated} onClick={() => show(table, "page", offset + 50)}>{t("dbNext")}</button></div>}</> : !busy && tables.length > 0 && tab !== "query" ? <div className="database-catalog"><h3>{t("dbTables")} <small>{tables.length}</small></h3>{tables.filter(item => `${item.schema}.${item.name}`.toLowerCase().includes(search.toLowerCase())).map(item => <article key={JSON.stringify([item.schema, item.name])}><FiTable aria-hidden="true" /><div><strong>{item.name}</strong><small>{item.schema} · {item.kind}</small></div><div className="database-catalog-actions"><button onClick={() => show(item, "page")}>{t("dbData")}</button><button onClick={() => show(item, "describe")}>{t("dbStructure")}</button><button onClick={() => { const q = (name: string) => quoteDatabaseName(name, connection.driver === "mysql"); setSql(`SELECT * FROM ${q(item.schema)}.${q(item.name)} LIMIT 50`); setTable(item); setTab("query"); }}>{t("dbSql")}</button></div></article>)}</div> : !busy && <p className="database-empty">{t(tab === "query" ? "dbSqlReady" : "dbSelectTable")}</p>}
			</> : <div className="database-empty"><FiDatabase /><h3>{t("dbTitle")}</h3><p>{t("dbEmpty")}</p></div>}
		</div>
	</section>;
}
