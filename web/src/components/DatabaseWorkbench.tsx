import { useEffect, useRef, useState } from "react";
import { LuDatabase as FiDatabase, LuTable as FiTable, LuSearch as FiSearch, LuPlus as FiPlus, LuRefreshCw as FiRefreshCw, LuLink as FiLink, LuX as FiX } from "react-icons/lu";
import { useT } from "../i18n";
import { databaseRequest } from "../database-api";
import { randomUuid } from "../uuid";
import type { DatabaseConfig, DatabaseConnection, DatabaseGrid, DatabaseImportPreview, DatabaseOperation } from "../types";
import type { ChatReferenceRequest } from "../chat-reference";

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
	const [busy, setBusy] = useState(false), [selectedRows, setSelectedRows] = useState<number[]>([]);
	const life = useRef(new AbortController()), operation = useRef<AbortController>(), sequence = useRef(0), job = useRef<string>();
	const connection = connections.find(c => c.id === selected);
	const sourceManaged = !!form?.id && !!connections.find(c => c.id === form.id)?.source;
	useEffect(() => {
		life.current = new AbortController(); void task(async (signal, current) => { const r = await databaseRequest(cwd, conversationId, { action: "list" }, signal); if (current()) { setConnections(r.connections ?? []); setGrants(r.grants ?? []); } });
		return () => { life.current.abort(); operation.current?.abort(); sequence.current++; };
	}, [cwd, conversationId]);
	useEffect(() => { try { sessionStorage.setItem(`pi-db-sql:${cwd}:${conversationId}`, sql); } catch { /* optional draft cache */ } }, [sql, cwd, conversationId]);
	async function task(fn: (signal: AbortSignal, current: () => boolean) => Promise<void>) {
		operation.current?.abort(); const controller = new AbortController(); operation.current = controller;
		const n = ++sequence.current, current = () => !controller.signal.aborted && !life.current.signal.aborted && n === sequence.current;
		setBusy(true); setError("");
		try { await fn(controller.signal, current); } catch (e) { if (current()) setError((e as Error).message); }
		finally { if (current()) setBusy(false); }
	}
	async function request(op: DatabaseOperation, signal: AbortSignal) { const id = randomUuid(); job.current = id; return databaseRequest(cwd, conversationId, op, signal, id); }
	function run(c: DatabaseConnection, operation: "databases" | "tables" | "page" | "describe" | "query", db = database, target = table, start = offset) {
		return { action: "run", id: c.id, version: c.version, operation, database: db, schema: target?.schema, table: target?.name, offset: start, sql } as const;
	}
	function openConnection(c: DatabaseConnection) {
		setSelected(c.id); setDatabase(""); setDatabases([]); setTables([]); setTable(undefined); setGrid(undefined); setForm(undefined); setImporting(false);
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
		void task(async (signal, current) => { const r = await request({ action: "preview", kind, path: filePath, content }, signal); if (current()) { setPreview(r.preview); setChosen(r.preview?.items.filter(i => (!i.issue || i.change !== "new") && i.change !== "unchanged").map(i => i.key) ?? []); } });
	}
	const refresh = () => void task(async (signal, current) => { const r = await request({ action: "list" }, signal); if (current()) { setConnections(r.connections ?? []); setGrants(r.grants ?? []); } });
	return <section className="database-workbench" aria-label={t("dbTitle")}>
		<aside className="database-sidebar">
			<label className="file-search-trigger"><FiSearch /><input aria-label={t("dbSearch")} placeholder={t("dbSearch")} value={search} onChange={e => setSearch(e.target.value)} /></label>
			<div className="database-actions"><button onClick={() => { setForm(blank()); setTested(false); setImporting(false); }}><FiPlus />{t("dbNew")}</button><button onClick={() => { setImporting(true); setForm(undefined); }}>{t("dbImport")}</button><button aria-label={t("dbRefresh")} onClick={refresh}><FiRefreshCw /></button></div>
			<div className="database-tree">{connections.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.id === selected).map(c => <div key={c.id}>
				<button className={`database-tree-row${selected === c.id ? " selected" : ""}`} title={`${c.host}:${c.port}`} onClick={() => openConnection(c)}><FiDatabase /><span>{c.name}</span>{c.issue || c.needsTest ? <small>!</small> : null}</button>
				{selected === c.id && databases.map(db => <div key={db} className="database-indent"><button className={`database-tree-row${database === db ? " selected" : ""}`} onClick={() => openDatabase(db)}><FiDatabase /><span>{db}</span></button>
					{database === db && [...new Set(tables.map(t => t.schema))].map(schema => <details key={schema} open className="database-indent"><summary>{schema}</summary>{tables.filter(t => t.schema === schema && t.name.toLowerCase().includes(search.toLowerCase())).map(item => <div className="database-table-row" key={item.name}><button className={`database-tree-row${table?.name === item.name && table.schema === item.schema ? " selected" : ""}`} onClick={() => show(item, "page")}><FiTable /><span>{item.name}</span></button><button aria-label={`${t("dbAsk")} ${item.name}`} title={t("dbAsk")} onClick={() => { setTable(item); onReference({ id: randomUuid(), cwd, conversationId, path: `database:${c.id} · ${c.name}/${db}/${schema}/${item.name}`, text: t("dbReferenceText"), database: { id: c.id, name: c.name, version: c.version } }); }}><FiLink /></button></div>)}</details>)}
				</div>)}
			</div>)}</div>
			<p className="database-hint">{t("dbWorkbenchReadOnly")}</p>
		</aside>
		<div className="database-main">
			{error && <div role="alert" className="database-error">{error}<button aria-label={t("close")} onClick={() => setError("")}><FiX /></button></div>}
			{busy && <div className="database-busy">{t("loading")}<button onClick={() => { if (job.current) void databaseRequest(cwd, conversationId, { action: "cancel", target: job.current }).catch(() => {}); operation.current?.abort(); setBusy(false); }}>{t("cancel")}</button></div>}
			{form ? <form className="database-form" onSubmit={e => { e.preventDefault(); void task(async (signal, current) => { const r = await request({ action: "save", connection: form }, signal); if (current()) { setConnections(r.connections ?? []); setForm(undefined); } }); }}>
				<h3>{form.id ? t("dbEdit") : t("dbNew")}</h3>
				{sourceManaged && <p className="database-hint">{t("dbSourceManaged")}</p>}
				<label>{t("dbName")}<input required disabled={sourceManaged} value={form.name} onChange={e => { setForm({ ...form, name: e.target.value }); setTested(false); }} /></label>
				<label>driver<select disabled={sourceManaged} value={form.driver} onChange={e => { const driver = e.target.value as DatabaseConfig["driver"]; setForm({ ...form, driver, port: driver === "mysql" ? 3306 : 5432 }); setTested(false); }}><option value="mysql">MySQL / MariaDB</option><option value="postgres">PostgreSQL</option></select></label>
				{(["host", "port", "user", "db_name"] as const).map(field => <label key={field}>{field}<input disabled={sourceManaged} required={field === "host" || field === "port"} type={field === "port" ? "number" : "text"} value={form[field]} onChange={e => { setForm({ ...form, [field]: field === "port" ? Number(e.target.value) : e.target.value }); setTested(false); }} /></label>)}
				<label>password<input type="password" autoComplete="new-password" value={form.password ?? ""} placeholder={form.id ? t("dbKeepPassword") : ""} onChange={e => { setForm({ ...form, password: e.target.value || (form.id ? undefined : "") }); setTested(false); }} /></label>
				<label className="database-checkbox"><input type="checkbox" disabled={sourceManaged} checked={form.tls?.enabled ?? false} onChange={e => { setForm({ ...form, tls: { ...form.tls, enabled: e.target.checked } }); setTested(false); }} />TLS</label>
				{form.tls?.enabled && <label>{t("dbCA")}<textarea disabled={sourceManaged} value={form.tls.ca ?? ""} onChange={e => { setForm({ ...form, tls: { enabled: true, ca: e.target.value || undefined } }); setTested(false); }} /></label>}
				<div className="database-actions"><button type="button" disabled={busy} onClick={() => void task(async (signal, current) => { const r = await request({ action: "test", connection: form }, signal); if (current()) { setTested(true); setConnections(r.connections ?? []); } })}>{tested ? t("dbTestSuccess") : t("dbTest")}</button><button disabled={busy} type="submit">{t("save")}</button><button type="button" onClick={() => setForm(undefined)}>{t("cancel")}</button></div>
			</form> : importing ? <div className="database-import"><h3>{t("dbImport")}</h3><p className="database-hint">{t("dbImportHint")}</p>
				<div className="database-actions"><select aria-label={t("dbSource")} value={kind} onChange={e => { setKind(e.target.value as typeof kind); setPreview(undefined); }}><option value="dbeaver">DBeaver</option><option value="datagrip">DataGrip</option></select><button disabled={busy} onClick={() => void task(async (signal, current) => { const r = await request({ action: "scan" }, signal); if (current()) setSources(r.sources ?? []); })}>{t("dbScan")}</button><label className="database-upload">{t("dbUpload")}<input type="file" accept=".json,.xml" onChange={async e => { const f = e.target.files?.[0]; if (f) { if (f.size > 2 * 1024 * 1024) { setError(t("dbFileTooLarge")); return; } previewSource(await f.text(), f.name); } }} /></label></div>
				{sources.map(s => <button className="database-source" key={s.path} onClick={() => { setPath(s.path); setKind(s.kind); setPreview(undefined); }}>{s.kind} · {s.path}</button>)}
				<label>{t("dbSourcePath")}<input placeholder={kind === "datagrip" ? "/path/.idea/dataSources.xml" : "/path/.dbeaver/data-sources.json"} value={path} onChange={e => setPath(e.target.value)} /></label><button disabled={busy || !path} onClick={() => previewSource()}>{t("dbPreview")}</button>
				{preview && <><p>{preview.source}</p><div className="database-import-list">{preview.items.map(i => <label key={i.key}><input type="checkbox" disabled={!!i.issue && i.change === "new"} checked={chosen.includes(i.key)} onChange={e => setChosen(v => e.target.checked ? [...v, i.key] : v.filter(k => k !== i.key))} /><span><strong>{i.connection.name}</strong> · {t(({ new: "dbAdded", updated: "dbUpdated", unchanged: "dbUnchanged", missing: "dbMissing" } as const)[i.change])}<small>{i.connection.driver} · {i.connection.host}:{i.connection.port} · {i.connection.user} · {i.connection.db_name}</small>{!i.hasPassword && <small>{t("dbPasswordMissing")}</small>}{i.issue && <small className="database-error">{i.issue}</small>}</span></label>)}</div><button disabled={busy || !chosen.length} onClick={() => void task(async (signal, current) => { const r = await request({ action: "import", ticket: preview.ticket, keys: chosen }, signal); if (current()) { setConnections(r.connections ?? []); setPreview(undefined); setImporting(false); } })}>{t("dbApplyImport")}</button></>}
			</div> : connection ? <>
				<header className="database-heading"><div><strong>{connection.name}</strong><small>{connection.driver} · {connection.host}:{connection.port}{database ? ` / ${database}` : ""}{table ? ` / ${table.schema}.${table.name}` : ""}</small></div><button onClick={() => ask()}><FiLink />{t("dbAsk")}</button></header>
				<div className="database-actions"><button onClick={() => { setForm({ ...connection, password: undefined }); setTested(false); }}>{t("dbEdit")}</button><button onClick={() => { const { id, version, hasPassword, source, issue, needsTest, ...copy } = connection; setForm({ ...copy, name: `${copy.name} ${t("dbCopy")}`, password: "" }); setTested(false); }}>{t("dbCopy")}</button><button onClick={() => { setPath(connection.source?.path.replace(/^upload:/, "") ?? ""); setKind(connection.source?.kind ?? "dbeaver"); setImporting(true); }}>{t("dbSync")}</button><button disabled={busy} onClick={() => void task(async (signal, current) => { const r = await request({ action: "delete", id: connection.id, version: connection.version }, signal); if (current()) { setConnections(r.connections ?? []); setSelected(""); } })}>{t("dbDelete")}</button></div>
				{connection.issue && <p className="database-error">{connection.issue}</p>}
				<p className="database-hint">{t("dbGrantHint")}{grants.includes(connection.id) && <button onClick={() => void task(async (_signal, current) => { await onRevoke(connection.id); if (current()) setGrants(g => g.filter(id => id !== connection.id)); })}>{t("dbRevoke")}</button>}</p>
				<nav className="database-tabs">{(["page", "describe", "query"] as const).map(value => <button key={value} aria-pressed={tab === value} onClick={() => value === "query" ? (setTab(value), setGrid(undefined), setSelectedRows([])) : show(table, value)}>{t(({ page: "dbData", describe: "dbStructure", query: "dbSql" } as const)[value])}</button>)}</nav>
				{tab === "query" && <div className="database-sql"><textarea aria-label={t("dbSql")} spellCheck={false} value={sql} onChange={e => setSql(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); show(table, "query"); } }} /><button disabled={busy} onClick={() => show(table, "query")}>{t("dbRun")}</button></div>}
				{grid ? <><div className="database-result-meta"><span>{grid.rows.length} {t("dbRowCount")} · {grid.elapsedMs} ms{grid.truncated ? ` · ${t("dbTruncated")}` : ""}</span><button disabled={!selectedRows.length} onClick={() => ask(true)}>{t("dbAskRows")} ({selectedRows.length})</button></div><div className="database-grid"><table><thead><tr><th aria-label={t("dbSelectRows")} />{grid.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead><tbody>{grid.rows.map((row, index) => <tr key={index}><td><input type="checkbox" aria-label={`${t("dbSelectRows")} ${index + 1}`} checked={selectedRows.includes(index)} onChange={e => setSelectedRows(rows => e.target.checked ? [...rows, index] : rows.filter(i => i !== index))} /></td>{row.map((v, i) => <td key={i}>{v === null ? <span className="database-null">NULL</span> : String(v)}</td>)}</tr>)}</tbody></table></div>{tab === "page" && <div className="database-actions"><button disabled={busy || offset === 0} onClick={() => show(table, "page", Math.max(0, offset - 50))}>{t("dbPrevious")}</button><span>{offset + 1}–{offset + grid.rows.length}</span><button disabled={busy || !grid.truncated} onClick={() => show(table, "page", offset + 50)}>{t("dbNext")}</button></div>}</> : <p className="database-empty">{t("dbSelectTable")}</p>}
			</> : <div className="database-empty"><FiDatabase /><h3>{t("dbTitle")}</h3><p>{t("dbEmpty")}</p></div>}
		</div>
	</section>;
}
