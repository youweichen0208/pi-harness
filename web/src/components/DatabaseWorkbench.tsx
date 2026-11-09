import { useEffect, useRef, useState } from "react";
import { FiDatabase, FiTable, FiSearch, FiPlus, FiRefreshCw, FiLink, FiX } from "react-icons/fi";
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
	const [tab, setTab] = useState<"page" | "describe" | "query">("page"), [grid, setGrid] = useState<DatabaseGrid>();
	const [offset, setOffset] = useState(0), [search, setSearch] = useState(""), [error, setError] = useState("");
	const [sql, setSql] = useState(() => { try { return sessionStorage.getItem(`pi-db-sql:${cwd}:${conversationId}`) ?? "SELECT 1 AS example"; } catch { return "SELECT 1 AS example"; } });
	const [form, setForm] = useState<ReturnType<typeof blank>>(), [tested, setTested] = useState(false);
	const [importing, setImporting] = useState(false), [kind, setKind] = useState<"datagrip" | "dbeaver">("dbeaver"), [path, setPath] = useState("");
	const [sources, setSources] = useState<{ kind: "datagrip" | "dbeaver"; path: string }[]>([]), [preview, setPreview] = useState<DatabaseImportPreview>(), [chosen, setChosen] = useState<string[]>([]);
	const [jdbcChoices, setJdbcChoices] = useState<{ connection?: DatabaseConnection; source?: { path: string; id: string }; drivers: DatabaseJdbcDriver[] }>();
	const [jdbcManual, setJdbcManual] = useState(false), [jdbcClass, setJdbcClass] = useState(""), [jdbcPaths, setJdbcPaths] = useState("");
	const [jdbcSourceId, setJdbcSourceId] = useState(""), [jdbcTargets, setJdbcTargets] = useState<{ id: string; name: string }[]>([]);
	const [jdbcConfigDir, setJdbcConfigDir] = useState(""), [jdbcDriverId, setJdbcDriverId] = useState(""), [jdbcDrivers, setJdbcDrivers] = useState<DatabaseJdbcDriver[]>([]), [jdbcRuntime, setJdbcRuntime] = useState<DatabaseResponse["jdbcRuntime"]>();
	const jdbcMessage = (message: string) => { const code = message.match(/JDBC_[A-Z_]+$/)?.[0] as keyof typeof jdbcErrors | undefined; return code && jdbcErrors[code] ? message.replace(code, t(jdbcErrors[code])) : /^SQLSTATE_/.test(message) ? `${t("dbJdbcQuery")} (${message.slice(9)})` : message; };
	const [syncError, setSyncError] = useState(""), [syncIssues, setSyncIssues] = useState<NonNullable<DatabaseResponse["syncIssues"]>>([]);
	const skippedSources = syncIssues.filter(item => item.category === "unsupported-driver");
	const sourceWarnings = syncIssues.filter(item => item.category !== "unsupported-driver");
	const errorLabel = error === databaseErrorMessages.authProtocol ? t("dbAuthProtocolError") : error === databaseErrorMessages.auth ? t("dbAuthError") : error === databaseErrorMessages.network ? t("dbNetworkError") : error === databaseErrorMessages.tls ? t("dbTlsError") : jdbcMessage(error);
	const foreground = useRef(false), synchronize = useRef<() => Promise<void>>();
	const [busy, setBusy] = useState(false), [selectedRows, setSelectedRows] = useState<number[]>([]);
	const life = useRef(new AbortController()), operation = useRef<AbortController>(), sequence = useRef(0), job = useRef<string>();
	const connection = connections.find(c => c.id === selected);
	const formSource = connections.find(c => c.id === form?.id)?.source;
	const sourceManaged = !!form?.id && !!connections.find(c => c.id === form.id)?.source;
	useEffect(() => {
		life.current = new AbortController(); foreground.current = false;
		setConnections([]); setGrants([]); setSelected(""); setForm(undefined); setImporting(false); setPreview(undefined); setJdbcSourceId(""); setJdbcTargets([]); setSyncIssues([]); setSyncError(""); setError(""); setJdbcChoices(undefined);
		const sync = startDatabaseSync({
			request: signal => databaseRequest(cwd, conversationId, { action: "sync" }, signal),
			canStart: () => !foreground.current,
			revision: () => sequence.current,
			receive: r => { setConnections(r.connections ?? []); setJdbcRuntime(r.jdbcRuntime); setGrants(r.grants ?? []); setSyncIssues(r.syncIssues ?? []); setSyncError(""); },
			error: e => setSyncError((e as Error).message),
		});
		synchronize.current = sync.refresh;
		const focus = () => { void sync.refresh(); };
		window.addEventListener("focus", focus);
		return () => { sync.stop(); window.removeEventListener("focus", focus); life.current.abort(); operation.current?.abort(); sequence.current++; };
	}, [cwd, conversationId]);
	useEffect(() => { setDatabases([]); setDatabase(""); setTables([]); setTable(undefined); setGrid(undefined); setSelectedRows([]); setError(""); setTested(false); }, [connection?.id, connection?.version]);
	useEffect(() => { try { sessionStorage.setItem(`pi-db-sql:${cwd}:${conversationId}`, sql); } catch { /* optional draft cache */ } }, [sql, cwd, conversationId]);
	async function task(fn: (signal: AbortSignal, current: () => boolean) => Promise<void>) {
		operation.current?.abort(); const controller = new AbortController(); operation.current = controller;
		const n = ++sequence.current, current = () => !controller.signal.aborted && !life.current.signal.aborted && n === sequence.current;
		foreground.current = true; setBusy(true); setError("");
		try { await fn(controller.signal, current); } catch (e) { if (current()) setError((e as Error).message); }
		finally { if (current()) { foreground.current = false; setBusy(false); } }
	}
	async function request(op: DatabaseOperation, signal: AbortSignal) { const id = randomUuid(); job.current = id; return databaseRequest(cwd, conversationId, op, signal, id); }
	function run(c: DatabaseConnection, operation: "databases" | "tables" | "page" | "describe" | "query", db = database, target = table, start = offset) {
		return { action: "run", id: c.id, version: c.version, operation, database: db, schema: target?.schema, table: target?.name, offset: start, sql } as const;
	}
	function resetOperation() {
		operation.current?.abort(); sequence.current++; foreground.current = false; setBusy(false); setError(""); setJdbcChoices(undefined);
	}
	function configureJdbc(sourcePath: string, sourceId = "", selection?: DatabaseJdbcSelection) {
		resetOperation(); setForm(undefined); setImporting(true); setKind("datagrip"); setPath(sourcePath); setPreview(undefined);
		const mapped = connections.find(c => c.source?.path === sourcePath && c.source.id === sourceId);
		setJdbcConfigDir(selection?.configDir ?? ""); setJdbcDriverId(selection?.driverId ?? ""); setJdbcDrivers([]);
		setJdbcSourceId(sourceId); setJdbcTargets(sourceId ? [{ id: sourceId, name: mapped?.name ?? sourceId }] : []);
		setJdbcManual(!!selection?.jarPaths); setJdbcClass(selection?.driverClass ?? mapped?.jdbc?.driverClass ?? ""); setJdbcPaths(selection?.jarPaths?.join("\n") ?? "");
	}
	function allowJdbc(c: DatabaseConfig & { needsTest?: boolean }) {
		return !c.jdbc || c.needsTest === false || window.confirm(`${t("dbJdbcConfirm")}\n${c.jdbc.driverClass}\n${c.jdbc.jarNames.join(", ")}`);
	}
	function repairJdbc(c: DatabaseConnection, driver?: DatabaseJdbcDriver) {
		setJdbcChoices(undefined); setTested(false);
		void task(async (signal, current) => {
			let target = c;
			if (form?.id === c.id && form.password !== undefined) {
				const saved = await request({ action: "save", connection: { ...c, password: form.password } }, signal);
				if (!current()) return;
				target = saved.connections!.find(item => item.id === c.id)!;
				setConnections(saved.connections ?? []);
			}
			const configured = await request({ action: "jdbc_configure", id: target.id, version: target.version, configDir: driver?.configDir, driverId: driver?.id }, signal);
			if (!current()) return;
			setConnections(configured.connections ?? []); setJdbcRuntime(configured.jdbcRuntime);
			if (configured.jdbcDrivers) { setJdbcChoices({ connection: target, drivers: configured.jdbcDrivers }); return; }
			const updated = configured.connections?.find(item => item.id === target.id);
			if (!updated) return;
			setForm(undefined); setSelected(updated.id);
			if (!allowJdbc(updated)) return;
			const result = await request({ action: "test", connection: updated }, signal);
			if (!current()) return;
			setConnections(result.connections ?? []); setJdbcRuntime(result.jdbcRuntime); setTested(true);
			const synced = await request({ action: "sync" }, signal);
			if (current()) { setConnections(synced.connections ?? []); setSyncIssues(synced.syncIssues ?? []); setSyncError(""); }
		});
	}

	function repairSourceJdbc(source: { path: string; id: string }, driver?: DatabaseJdbcDriver) {
		const existing = connections.find(c => c.source?.path === source.path && c.source.id === source.id);
		if (existing) { repairJdbc(existing, driver); return; }
		setJdbcChoices(undefined); setTested(false);
		void task(async (signal, current) => {
			const previewed = await request({ action: "preview", kind: "datagrip", path: source.path, jdbcSelection: { mode: "automatic", sourceId: source.id, configDir: driver?.configDir, driverId: driver?.id } }, signal);
			if (!current()) return;
			const item = previewed.preview?.items.find(i => i.sourceId === source.id);
			if (item?.issue === "JDBC_DRIVER_AMBIGUOUS" && previewed.jdbcDrivers?.length) { setJdbcChoices({ source, drivers: previewed.jdbcDrivers }); return; }
			if (!item || !previewed.preview) throw Error("JDBC_CONFIG_INVALID");
			if (item.issue) throw Error(item.issue);
			if (!item.connection.jdbc) throw Error("JDBC_DRIVER_MISSING");
			const imported = await request({ action: "import", ticket: previewed.preview.ticket, keys: [item.key] }, signal);
			if (!current()) return;
			setConnections(imported.connections ?? []); setJdbcRuntime(imported.jdbcRuntime);
			const updated = imported.connections?.find(c => c.source?.path === source.path && c.source.id === source.id);
			if (!updated) return;
			setSelected(updated.id); setForm(undefined); setImporting(false);
			if (!allowJdbc(updated)) return;
			const result = await request({ action: "test", connection: updated }, signal);
			if (!current()) return;
			setConnections(result.connections ?? []); setTested(true);
			const synced = await request({ action: "sync" }, signal);
			if (current()) { setConnections(synced.connections ?? []); setSyncIssues(synced.syncIssues ?? []); setSyncError(""); }
		});
	}

	function openConnection(c: DatabaseConnection) {
		resetOperation();
		setSelected(c.id); setTested(false); setDatabase(""); setDatabases([]); setTables([]); setTable(undefined); setGrid(undefined); setForm(undefined); setImporting(false);
		if (c.issue || c.needsTest) return;
		void task(async (signal, current) => { const r = await request(run(c, "databases", c.db_name), signal); if (current()) setDatabases(r.grid?.rows.map(row => String(row[0])) ?? []); });
	}
	function openDatabase(db: string) {
		if (!connection) return; setDatabase(db); setTables([]); setTable(undefined); setGrid(undefined);
		void task(async (signal, current) => { const r = await request(run(connection, "tables", db), signal); if (current()) setTables(r.grid?.rows.map(row => ({ schema: String(row[0]), name: String(row[1]), kind: String(row[2]) })) ?? []); });
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
	function previewSource(content?: string, filePath = path) {
		void task(async (signal, current) => { const r = await request({ action: "preview", kind, path: filePath, content, ...(kind === "datagrip" ? { jdbcSelection: { configDir: jdbcConfigDir || undefined, driverId: !jdbcManual && jdbcSourceId ? jdbcDriverId || undefined : undefined, sourceId: jdbcSourceId || undefined, ...(jdbcManual && jdbcSourceId ? { driverClass: jdbcClass.trim(), jarPaths: jdbcPaths.split(/\r?\n/).map(p => p.trim()).filter(Boolean) } : {}) } } : {}) }, signal); if (current()) { setPreview(r.preview); setJdbcTargets(r.preview?.items.map(i => ({ id: i.sourceId, name: i.connection.name })) ?? []); setChosen(r.preview?.items.filter(i => (!i.issue || i.change !== "new") && i.change !== "unchanged").map(i => i.key) ?? []); } });
	}
	const refresh = () => { void synchronize.current?.(); };
	return <section className="database-workbench" aria-label={t("dbTitle")}>
		<aside className="database-sidebar">
			<label className="file-search-trigger"><FiSearch /><input aria-label={t("dbSearch")} placeholder={t("dbSearch")} value={search} onChange={e => setSearch(e.target.value)} /></label>
			<div className="database-actions"><button onClick={() => { resetOperation(); setForm(blank()); setTested(false); setImporting(false); }}><FiPlus />{t("dbNew")}</button><button onClick={() => { resetOperation(); setImporting(true); setForm(undefined); }}>{t("dbImport")}</button><button disabled={busy} aria-label={t("dbRefresh")} onClick={refresh}><FiRefreshCw /></button></div>
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
			{syncError && <div role="alert" className="database-error">{t("dbSyncFailed")} · {syncError}<button onClick={refresh}>{t("dbRefresh")}</button></div>}
			{sourceWarnings.length > 0 && <details className="database-hint database-source-warnings"><summary>{t("dbSyncIssues")} ({sourceWarnings.length})</summary>{sourceWarnings.map((item, i) => <p key={i}>{item.path} · {jdbcMessage(item.issue)}{item.issue.includes("JDBC_") && item.sourceId && <button disabled={busy} onClick={() => repairSourceJdbc({ path: item.path, id: item.sourceId! })}>{t("dbJdbcRepair")}</button>}{item.issue.includes("JDBC_") && <button onClick={() => configureJdbc(item.path)}>{t("dbJdbcConfigure")}</button>}</p>)}</details>}
			{skippedSources.length > 0 && <details className="database-hint database-source-skipped"><summary>{t("dbSkippedDrivers", { n: skippedSources.length })}</summary>{skippedSources.map((item, i) => <p key={i}>{item.path} · {jdbcMessage(item.issue)}</p>)}</details>}
			{error && <div role="alert" className="database-error">{errorLabel}{error === databaseErrorMessages.authProtocol && (form?.id ? connections.find(c => c.id === form.id) : connection)?.source?.kind === "datagrip" && !(formSource ?? connection?.source)?.path.startsWith("upload:") && <button disabled={busy} onClick={() => repairJdbc((form?.id ? connections.find(c => c.id === form.id) : connection)!)}>{t("dbJdbcRepair")}</button>}<button aria-label={t("close")} onClick={() => setError("")}><FiX /></button></div>}
			{jdbcChoices && <div role="dialog" aria-label={t("dbJdbcChoose")} className="database-hint database-jdbc-choices"><p>{t("dbJdbcChoose")}</p>{jdbcChoices.drivers.map(d => <button disabled={busy} key={JSON.stringify([d.configDir, d.id])} onClick={() => jdbcChoices.connection ? repairJdbc(jdbcChoices.connection, d) : repairSourceJdbc(jdbcChoices.source!, d)}>{d.name} · {d.driverClass} · {d.configDir}</button>)}<button onClick={() => setJdbcChoices(undefined)}>{t("cancel")}</button></div>}
			{busy && <div className="database-busy">{t("loading")}<button onClick={() => { if (job.current) void databaseRequest(cwd, conversationId, { action: "cancel", target: job.current }).catch(() => {}); operation.current?.abort(); foreground.current = false; setBusy(false); }}>{t("cancel")}</button></div>}
			{form ? <form className="database-form" onSubmit={e => { e.preventDefault(); void task(async (signal, current) => { const r = await request({ action: "save", connection: form }, signal); if (current()) { setConnections(r.connections ?? []); setForm(undefined); } }); }}>
				<h3>{form.id ? t("dbEdit") : t("dbNew")}</h3>
				{sourceManaged && <p className="database-hint">{t("dbSourceManaged")}</p>}
				{formSource?.kind === "datagrip" && !formSource.path.startsWith("upload:") && <button type="button" onClick={() => configureJdbc(formSource.path, formSource.id, formSource.jdbcSelection)}>{t("dbJdbcConfigure")}</button>}
				<label>{t("dbName")}<input required disabled={sourceManaged} value={form.name} onChange={e => { setForm({ ...form, name: e.target.value }); setTested(false); }} /></label>
				<label>driver<select disabled={sourceManaged} value={form.driver} onChange={e => { const driver = e.target.value as DatabaseConfig["driver"]; setForm({ ...form, driver, port: driver === "mysql" ? 3306 : 5432 }); setTested(false); }}><option value="mysql">MySQL / MariaDB</option><option value="postgres">PostgreSQL</option>{form.driver === "gaussdb" && <option value="gaussdb">GaussDB / PostgreSQL (JDBC)</option>}</select></label>
				{(["host", "port", "user", "db_name"] as const).map(field => <label key={field}>{field}<input disabled={sourceManaged} required={field === "host" || field === "port"} type={field === "port" ? "number" : "text"} value={form[field]} onChange={e => { setForm({ ...form, [field]: field === "port" ? Number(e.target.value) : e.target.value }); setTested(false); }} /></label>)}
				<label>password<input type="password" autoComplete="new-password" value={form.password ?? ""} placeholder={form.id ? t("dbKeepPassword") : ""} onChange={e => { setForm({ ...form, password: e.target.value || (form.id ? undefined : "") }); setTested(false); }} /></label>
				<label className="database-checkbox"><input type="checkbox" disabled={sourceManaged} checked={form.tls?.enabled ?? false} onChange={e => { setForm({ ...form, tls: { ...form.tls, enabled: e.target.checked } }); setTested(false); }} />TLS</label>
				{form.driver === "gaussdb" && jdbcRuntime === "missing" && <p className="database-hint">{t("dbJdbcJavaMissing")}</p>}
				{form.driver === "gaussdb" && <p className="database-hint">{t("dbJdbcSourceManaged")}</p>}
				{form.tls?.enabled && form.driver !== "gaussdb" && <label>{t("dbCA")}<textarea disabled={sourceManaged} value={form.tls.ca ?? ""} onChange={e => { setForm({ ...form, tls: { enabled: true, ca: e.target.value || undefined } }); setTested(false); }} /></label>}
				<div className="database-actions"><button type="button" disabled={busy} onClick={() => void task(async (signal, current) => { if (!allowJdbc({ ...form, needsTest: connections.find(c => c.id === form.id)?.needsTest })) return; const r = await request({ action: "test", connection: form }, signal); if (current()) { setTested(true); setConnections(r.connections ?? []); } })}>{tested ? t("dbTestSuccess") : t("dbTest")}</button><button disabled={busy} type="submit">{t("save")}</button><button type="button" onClick={() => setForm(undefined)}>{t("cancel")}</button></div>
			</form> : importing ? <div className="database-import"><h3>{t("dbImport")}</h3><p className="database-hint">{t("dbImportHint")}</p>
				<div className="database-actions"><select aria-label={t("dbSource")} value={kind} onChange={e => { setKind(e.target.value as typeof kind); setPreview(undefined); }}><option value="dbeaver">DBeaver</option><option value="datagrip">DataGrip</option></select><button disabled={busy} onClick={() => void task(async (signal, current) => { const r = await request({ action: "scan" }, signal); if (current()) setSources(r.sources ?? []); })}>{t("dbScan")}</button><label className="database-upload">{t("dbUpload")}<input type="file" accept=".json,.xml" onChange={async e => { const f = e.target.files?.[0]; if (f) { if (f.size > 2 * 1024 * 1024) { setError(t("dbFileTooLarge")); return; } previewSource(await f.text(), f.name); } }} /></label></div>
				{sources.map(s => <button className="database-source" key={s.path} onClick={() => { setPath(s.path); setKind(s.kind); setPreview(undefined); }}>{s.kind} · {s.path}</button>)}
				<label>{t("dbSourcePath")}<input aria-describedby="database-source-path-hint" placeholder={kind === "datagrip" ? "/path/.idea/dataSources.xml" : "/path/.dbeaver/data-sources.json"} value={path} onChange={e => { setPath(e.target.value); setJdbcSourceId(""); setJdbcTargets([]); setPreview(undefined); }} /></label><p id="database-source-path-hint" className="database-hint">{t("dbSourcePathHint")}</p><button disabled={busy || !path.trim()} onClick={() => previewSource()}>{t("dbPreview")}</button>
				{kind === "datagrip" && jdbcRuntime === "missing" && <p className="database-hint">{t("dbJdbcJavaMissing")}</p>}
				{kind === "datagrip" && <details key={jdbcManual ? "manual" : "auto"} open={jdbcManual || undefined} className="database-hint database-jdbc-mapping"><summary>{t("dbJdbcMapping")}</summary><label>{t("dbJdbcConfigDir")}<input value={jdbcConfigDir} onChange={e => { setJdbcConfigDir(e.target.value); setJdbcDriverId(""); setJdbcDrivers([]); setPreview(undefined); }} /></label><button disabled={busy} onClick={() => void task(async (signal, current) => { const r = await request({ action: "jdbc_drivers", configDir: jdbcConfigDir || undefined }, signal); if (current()) { setJdbcDrivers(r.jdbcDrivers ?? []); setJdbcRuntime(r.jdbcRuntime); } })}>{t("dbJdbcFindDrivers")}</button><label>{t("dbJdbcDriver")}<select aria-label={t("dbJdbcDriver")} disabled={jdbcManual} value={jdbcDriverId ? JSON.stringify([jdbcConfigDir, jdbcDriverId]) : ""} onChange={e => { const [dir, id] = e.target.value ? JSON.parse(e.target.value) : [jdbcConfigDir, ""]; setJdbcConfigDir(dir); setJdbcDriverId(id); setPreview(undefined); }}><option value="">{t("dbJdbcAutomatic")}</option>{jdbcDrivers.map(d => <option key={JSON.stringify([d.configDir, d.id])} value={JSON.stringify([d.configDir, d.id])}>{d.name} · {d.driverClass} · {d.configDir}</option>)}</select></label><label>{t("dbJdbcTarget")}<select aria-label={t("dbJdbcTarget")} value={jdbcSourceId} onChange={e => { setJdbcSourceId(e.target.value); setPreview(undefined); }}><option value="">{t("dbJdbcSelectTarget")}</option>{jdbcTargets.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="database-checkbox"><input type="checkbox" checked={jdbcManual} onChange={e => { setJdbcManual(e.target.checked); setPreview(undefined); }} />{t("dbJdbcManual")}</label>{jdbcManual && <><label>{t("dbJdbcClass")}<input value={jdbcClass} onChange={e => { setJdbcClass(e.target.value); setPreview(undefined); }} /></label><label>{t("dbJdbcPaths")}<textarea rows={4} spellCheck={false} value={jdbcPaths} onChange={e => { setJdbcPaths(e.target.value); setPreview(undefined); }} /></label><p>{t("dbJdbcManualHint")}</p></>}<p>{t("dbJdbcMappingHint")}</p></details>}
				{preview && <><p>{preview.source}</p><div className="database-import-list">{preview.items.map(i => <label key={i.key}><input type="checkbox" disabled={!!i.issue && i.change === "new"} checked={chosen.includes(i.key)} onChange={e => setChosen(v => e.target.checked ? [...v, i.key] : v.filter(k => k !== i.key))} /><span><strong>{i.connection.name}</strong> · {t(({ new: "dbAdded", updated: "dbUpdated", unchanged: "dbUnchanged", missing: "dbMissing" } as const)[i.change])}<small>{i.connection.driver} · {i.connection.host}:{i.connection.port} · {i.connection.user} · {i.connection.db_name}</small>{!i.hasPassword && <small>{t("dbPasswordMissing")}</small>}{i.issue && <small className="database-error">{jdbcMessage(i.issue)}</small>}</span></label>)}</div><button disabled={busy || !chosen.length} onClick={() => void task(async (signal, current) => { const r = await request({ action: "import", ticket: preview.ticket, keys: chosen }, signal); if (current()) { setConnections(r.connections ?? []); setPreview(undefined); setImporting(false); const synced = await request({ action: "sync" }, signal); if (current()) { setConnections(synced.connections ?? []); setSyncIssues(synced.syncIssues ?? []); setSyncError(""); } } })}>{t("dbApplyImport")}</button></>}
			</div> : connection ? <>
				<header className="database-heading"><div><strong>{connection.name}</strong><small>{connection.jdbc ? "GaussDB / PostgreSQL (JDBC)" : connection.driver} · {connection.host}:{connection.port}{database ? ` / ${database}` : ""}{table ? ` / ${table.schema}.${table.name}` : ""}</small></div><button onClick={() => ask()}><FiLink />{t("dbAsk")}</button></header>
				<div className="database-actions"><button onClick={() => { resetOperation(); setForm({ ...connection, password: undefined }); setTested(false); }}>{t("dbEdit")}</button><button disabled={connection.driver === "gaussdb"} onClick={() => { resetOperation(); const { id, version, hasPassword, source, issue, needsTest, ...copy } = connection; setForm({ ...copy, name: `${copy.name} ${t("dbCopy")}`, password: "" }); setTested(false); }}>{t("dbCopy")}</button><button disabled={busy} onClick={() => { if (connection.source?.path.startsWith("upload:")) { setPath(connection.source.path.slice(7)); setKind(connection.source.kind); setImporting(true); } else refresh(); }}>{t("dbSync")}</button><button disabled={busy} onClick={() => void task(async (signal, current) => { const r = await request({ action: "delete", id: connection.id, version: connection.version }, signal); if (current()) { setConnections(r.connections ?? []); setSelected(""); } })}>{t("dbDelete")}</button></div>
				{connection.source?.kind === "datagrip" && !connection.source.path.startsWith("upload:") && <button onClick={() => configureJdbc(connection.source!.path, connection.source!.id, connection.source!.jdbcSelection)}>{t("dbJdbcConfigure")}</button>}
				{connection.source?.kind === "datagrip" && !connection.source.path.startsWith("upload:") && <button disabled={busy} onClick={() => repairJdbc(connection)}>{t("dbJdbcRepair")}</button>}
				{connection.jdbc && <button disabled={busy} onClick={() => void task(async (signal, current) => { const r = await request({ action: "jdbc_configure", id: connection.id, version: connection.version, mode: "disabled" }, signal); if (current()) setConnections(r.connections ?? []); })}>{t("dbJdbcRemove")}</button>}
				{connection.issue && <p className="database-error">{jdbcMessage(connection.issue)}</p>}
				{connection.jdbc && <div className="database-hint"><strong>GaussDB / PostgreSQL (JDBC)</strong><p>{t(!connection.source?.jdbcSelection?.jarPaths ? "dbJdbcAutoMatched" : "dbJdbcConfigured")}</p><p>{connection.jdbc.driverClass} · {connection.jdbc.jarNames.join(", ")}</p>{jdbcRuntime && <p>{t(jdbcRuntime === "detected" ? "dbJdbcJavaDetected" : "dbJdbcJavaMissing")}</p>}<button disabled={busy || !!connection.issue} onClick={() => void task(async (signal, current) => { if (!allowJdbc(connection)) return; const r = await request({ action: "test", connection }, signal); if (current()) { setConnections(r.connections ?? []); setJdbcRuntime(r.jdbcRuntime); setTested(true); } })}>{tested && !connection.needsTest ? t("dbTestSuccess") : t("dbTest")}</button></div>}
				{connection.needsTest && <p className="database-hint">{t("dbRetest")}</p>}
				{!connection.hasPassword && <p className="database-hint">{t("dbPasswordMissing")}</p>}
				<p className="database-hint">{t("dbGrantHint")}{grants.includes(connection.id) && <button onClick={() => void task(async (_signal, current) => { await onRevoke(connection.id); if (current()) setGrants(g => g.filter(id => id !== connection.id)); })}>{t("dbRevoke")}</button>}</p>
				<nav className="database-tabs">{(["page", "describe", "query"] as const).map(value => <button key={value} aria-pressed={tab === value} onClick={() => value === "query" ? (setTab(value), setGrid(undefined), setSelectedRows([])) : show(table, value)}>{t(({ page: "dbData", describe: "dbStructure", query: "dbSql" } as const)[value])}</button>)}</nav>
				{tab === "query" && <div className="database-sql"><textarea aria-label={t("dbSql")} spellCheck={false} value={sql} onChange={e => setSql(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); show(table, "query"); } }} /><button disabled={busy} onClick={() => show(table, "query")}>{t("dbRun")}</button></div>}
				{grid ? <><div className="database-result-meta"><span>{grid.rows.length} {t("dbRowCount")} · {grid.elapsedMs} ms{grid.truncated ? ` · ${t("dbTruncated")}` : ""}</span><button disabled={!selectedRows.length} onClick={() => ask(true)}>{t("dbAskRows")} ({selectedRows.length})</button></div><div className="database-grid"><table><thead><tr><th aria-label={t("dbSelectRows")} />{grid.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead><tbody>{grid.rows.map((row, index) => <tr key={index}><td><input type="checkbox" aria-label={`${t("dbSelectRows")} ${index + 1}`} checked={selectedRows.includes(index)} onChange={e => setSelectedRows(rows => e.target.checked ? [...rows, index] : rows.filter(i => i !== index))} /></td>{row.map((v, i) => <td key={i}>{v === null ? <span className="database-null">NULL</span> : String(v)}</td>)}</tr>)}</tbody></table></div>{tab === "page" && <div className="database-actions"><button disabled={busy || offset === 0} onClick={() => show(table, "page", Math.max(0, offset - 50))}>{t("dbPrevious")}</button><span>{offset + 1}–{offset + grid.rows.length}</span><button disabled={busy || !grid.truncated} onClick={() => show(table, "page", offset + 50)}>{t("dbNext")}</button></div>}</> : <p className="database-empty">{t("dbSelectTable")}</p>}
			</> : <div className="database-empty"><FiDatabase /><h3>{t("dbTitle")}</h3><p>{t("dbEmpty")}</p></div>}
		</div>
	</section>;
}
