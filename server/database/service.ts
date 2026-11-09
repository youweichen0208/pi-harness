import { listGaussJdbcDrivers, listJdbcDrivers } from "./datagrip-jdbc.js";
import { jdbcJavaCandidates } from "./jdbc-runtime.js";
import type { DatabaseJdbcSelection } from "../protocol.js";
import { randomUUID } from "node:crypto";
import type { DatabaseImportPreview, DatabaseOperation, DatabaseResponse } from "../protocol.js";
import { getDocumentSettings } from "../document-extension-settings.js";
import { deleteConnection, getConnection, listConnections, markMissing, markTested, saveConnection, restoreSource, validateConfig } from "./store.js";
import { parseSource, loadSource, scanSources, type ImportedConnection } from "./sources.js";
import { executeQuery } from "./query.js";
import { synchronizeSources } from "./sync.js";

const scopes = new WeakMap<object, string>();
export function databaseScope(client: string, cwd: string, manager: { getSessionId(): string }): string {
	let key = scopes.get(manager); if (!key) { key = randomUUID(); scopes.set(manager, key); }
	return JSON.stringify([client, cwd, key, manager.getSessionId()]);
}
const grants = new Map<string, Map<string, string>>();
const tickets = new Map<string, { owner: string; until: number; kind: "datagrip" | "dbeaver"; source: string; items: ImportedConnection[]; preview: DatabaseImportPreview; versions: Map<string,string>; jdbcSelection?: DatabaseJdbcSelection }>();
const running = new Map<string, { owner: string; connectionId: string; controller: AbortController }>();
export function grantedConnections(owner: string) {
	const allowed = grants.get(owner);
	return listConnections().filter(c => allowed?.get(c.id) === c.version && !c.issue && !c.needsTest);
}
export function forgetDatabaseScope(owner: string) { grants.delete(owner); for (const job of running.values()) if (job.owner === owner) job.controller.abort(); }
export async function databaseAction(owner: string, cwd: string, requestId: string, op: DatabaseOperation, signal?: AbortSignal, agent = false): Promise<DatabaseResponse> {
	const response: DatabaseResponse = { requestId };
	if (agent && !getDocumentSettings().databaseEnabled) throw Error("Database tools disabled");
	if (agent && !["list", "run"].includes(op.action)) throw Error("Unsupported agent database action");
	const state = () => ({ ...response, connections: listConnections(), grants: grantedConnections(owner).map(c => c.id), jdbcRuntime: jdbcJavaCandidates().length ? "detected" as const : "missing" as const });
	switch (op.action) {
		case "sync": {
			const before = new Map(listConnections().map(c => [c.id, c.version]));
			try { response.syncIssues = synchronizeSources(cwd); }
			finally {
				const after = new Map(listConnections().map(c => [c.id, c.version]));
				for (const job of running.values()) if (before.get(job.connectionId) !== after.get(job.connectionId)) job.controller.abort();
			}
			return state();
		}
		case "list": return agent ? { ...response, connections: grantedConnections(owner) } : state();
		case "save": saveConnection(op.connection); return state();
		case "delete": deleteConnection(op.id, op.version); for (const job of running.values()) if (job.connectionId === op.id) job.controller.abort(); return state();
		case "jdbc_drivers": return { ...state(), jdbcDrivers: listJdbcDrivers(op.configDir) };
		case "jdbc_configure": {
			const saved = listConnections().find(c => c.id === op.id && c.version === op.version);
			if (!saved) throw Error("Connection changed; refresh and retry");
			const source = saved.source;
			if (source?.kind !== "datagrip" || source.path.startsWith("upload:")) throw Error("JDBC_CONFIG_INVALID");
			if (op.mode !== undefined && !["automatic", "disabled"].includes(op.mode)) throw Error("JDBC_CONFIG_INVALID");
			const selection: DatabaseJdbcSelection = { mode: op.mode ?? (op.driverId ? undefined : "automatic"), sourceId: source.id, configDir: op.configDir ?? source.jdbcSelection?.configDir, driverId: op.driverId };
			if (op.mode === "disabled") {
				saveConnection({ ...saved, driver: "postgres", jdbc: undefined }, { ...source, jdbcSelection: selection }, "JDBC_DISABLED");
			} else {
				const items = loadSource(source.kind, source.path, selection);
				if (new Set(items.map(i => i.sourceId)).size !== items.length) throw Error("JDBC_CONFIG_INVALID");
				const item = items.find(i => i.sourceId === source.id);
				if (!item) throw Error("JDBC_CONFIG_INVALID");
				if (item.issue === "JDBC_DRIVER_AMBIGUOUS" && !op.driverId) return { ...state(), jdbcDrivers: listGaussJdbcDrivers(selection.configDir) };
				if (item.issue) throw Error(item.issue);
				if (!item.jdbcProfile || !item.config.jdbc) throw Error("JDBC_DRIVER_MISSING");
				// Remember the exact IDE directory and ID for this connection, never a global guess.
				selection.configDir = item.config.jdbc.configDir; selection.driverId = item.config.jdbc.driverId;
				saveConnection({ ...item.config, id: saved.id, version: saved.version }, { ...source, jdbcSelection: selection }, undefined, item.jdbcProfile);
			}
			for (const job of running.values()) if (job.connectionId === saved.id) job.controller.abort();
			return state();
		}
		case "scan": return { ...response, sources: scanSources(cwd) };
		case "preview": {
			if (!["datagrip", "dbeaver"].includes(op.kind) || typeof op.path !== "string" || !op.path || op.path.length > 4096) throw Error("Invalid source");
			for (const [key, t] of tickets) if (t.until < Date.now()) tickets.delete(key);
			if (tickets.size >= 100) throw Error("Too many import previews");
			const source = op.content === undefined ? op.path : `upload:${op.path}`;
			const items = op.content === undefined ? loadSource(op.kind, op.path, op.jdbcSelection) : parseSource(op.kind, op.content);
			const old = listConnections().filter(c => c.source?.path === source && c.source.kind === op.kind);
			const keys = new Set<string>();
			for (const item of items) { if (keys.has(item.sourceId)) throw Error("Duplicate source connection ID"); keys.add(item.sourceId); }
			const preview: DatabaseImportPreview = { ticket: randomUUID(), source, items: items.map(item => {
				const previous = old.find(c => c.source?.id === item.sourceId);
				return { key: item.sourceId, sourceId: item.sourceId, connection: item.config, hasPassword: item.password !== undefined || !!previous?.hasPassword, issue: item.issue, change: !previous ? "new" : previous.issue !== item.issue || JSON.stringify(previous.source?.jdbcSelection) !== JSON.stringify(item.jdbcSelection ?? op.jdbcSelection) || JSON.stringify(validateConfig(previous)) !== JSON.stringify(item.issue ? item.config : validateConfig(item.config)) ? "updated" : "unchanged" };
			}) };
			for (const missing of old.filter(c => !keys.has(c.source!.id))) preview.items.push({ key: missing.source!.id, sourceId: missing.source!.id, connection: validateConfig(missing), hasPassword: missing.hasPassword, change: "missing" });
			tickets.set(preview.ticket, { owner, until: Date.now() + 10 * 60000, kind: op.kind, source, items, preview, jdbcSelection: op.jdbcSelection, versions: new Map(listConnections().map(c => [c.id, c.version])) });
			return { ...response, preview, ...(items.some(i => i.issue === "JDBC_DRIVER_AMBIGUOUS") ? { jdbcDrivers: listGaussJdbcDrivers(op.jdbcSelection?.configDir) } : {}) };
		}
		case "import": {
			const ticket = tickets.get(op.ticket);
			if (!ticket || ticket.owner !== owner || ticket.until < Date.now() || !Array.isArray(op.keys) || op.keys.some(k => !ticket.preview.items.some(i => i.key === k))) throw Error("Import preview expired or invalid");
			const current = listConnections();
			if (current.length !== ticket.versions.size || current.some(c => ticket.versions.get(c.id) !== c.version)) throw Error("Connections changed; preview again");
			const selected = new Set(op.keys);
			for (const item of ticket.items.filter(i => selected.has(i.sourceId))) { if (item.issue) { if (!current.some(c => c.source?.path === ticket.source && c.source.id === item.sourceId)) throw Error("Unsupported source connection cannot be imported"); } else validateConfig(item.config); }
			for (const item of ticket.items.filter(i => selected.has(i.sourceId))) {
				const previous = current.find(c => c.source?.path === ticket.source && c.source.id === item.sourceId && c.source.kind === ticket.kind);
				if (item.issue && previous) { markMissing(previous.id, item.issue); continue; }
				if (previous && JSON.stringify(validateConfig(previous)) === JSON.stringify(validateConfig(item.config)) && !previous.issue && JSON.stringify(previous.source?.jdbcSelection) === JSON.stringify(item.jdbcSelection ?? ticket.jdbcSelection)) continue;
				saveConnection({ ...item.config, id: previous?.id, version: previous?.version, password: previous ? undefined : item.password }, { path: ticket.source, id: item.sourceId, kind: ticket.kind, jdbcSelection: item.jdbcSelection ?? ticket.jdbcSelection }, undefined, item.jdbcProfile);
				restoreSource({ path: ticket.source, id: item.sourceId, kind: ticket.kind });
			}
			for (const item of ticket.preview.items.filter(i => selected.has(i.key) && i.change === "missing")) { const old = current.find(c => c.source?.path === ticket.source && c.source.id === item.sourceId); if (old) markMissing(old.id); }
			tickets.delete(op.ticket); return state();
		}
		case "grant": {
			if (!getDocumentSettings().databaseEnabled) throw Error("Database tools disabled; enable the built-in extension");
			if (!Array.isArray(op.ids) || op.ids.length > 20) throw Error("Invalid connection selection");
			if (!op.versions || op.ids.some(id => typeof op.versions[id] !== "string")) throw Error("Missing connection version");
			const configs = op.ids.map(id => getConnection(id, op.versions[id]));
			if (configs.some(c => c.needsTest)) throw Error("Connection changed; test it before attaching");
			const entries = grants.get(owner) ?? new Map<string,string>();
			configs.forEach(c => entries.set(c.id, c.version)); grants.set(owner, entries); return state();
		}
		case "revoke": {
			grants.get(owner)?.delete(op.id);
			for (const job of running.values()) if (job.owner === owner && job.connectionId === op.id) job.controller.abort();
			return state();
		}
		case "cancel": { const job = running.get(op.target); if (job?.owner === owner) job.controller.abort(); return response; }
		case "test": case "run": {
			const config = op.action === "test" ? { ...validateConfig(op.connection), password: op.connection.password ?? (op.connection.id ? getConnection(op.connection.id, op.connection.version).password : undefined), jdbcProfile: op.connection.id ? getConnection(op.connection.id, op.connection.version).jdbcProfile : undefined } : getConnection(op.id, op.version);
			if (op.action === "run" && "needsTest" in config && config.needsTest) throw Error("Connection changed; test it before querying");
			if (op.action === "run" && agent && !grantedConnections(owner).some(c => c.id === op.id && c.version === op.version)) throw Error("Attach this connection to the current conversation before querying");
			if (running.has(requestId)) throw Error("Duplicate query request");
			if (config.driver === "gaussdb" && (!config.jdbcProfile || op.action === "test" && (!op.connection.id || JSON.stringify(validateConfig(getConnection(op.connection.id, op.connection.version))) !== JSON.stringify(validateConfig(config))))) throw Error("JDBC_CONFIG_INVALID");
			const controller = new AbortController(), abort = () => controller.abort();
			signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
			running.set(requestId, { owner, controller, connectionId: op.action === "run" ? op.id : op.connection.id ?? "" });
			try {
				const grid = await executeQuery(config, op.action === "run" ? op : { action: "run", id: "test", version: "", operation: "query", sql: "SELECT 1 AS connected" }, controller.signal);
				if (op.action === "test" && op.connection.id) {
					const saved = getConnection(op.connection.id, op.connection.version);
					if (JSON.stringify(validateConfig(saved)) === JSON.stringify(validateConfig(config)) && saved.password === config.password) markTested(op.connection.id, op.connection.version!);
				}
				if (op.action === "run") getConnection(op.id, op.version);
				return { ...state(), grid };
			} finally { running.delete(requestId); signal?.removeEventListener("abort", abort); }
		}
		default: throw Error("Unknown database action");
	}
}
