import type { DatabaseConnection, DatabaseResponse } from "../protocol.js";
import { loadSource, scanSources } from "./sources.js";
import { isSourceExcluded, listConnections, markMissing, saveConnection, validateConfig } from "./store.js";

type Source = Pick<NonNullable<DatabaseConnection["source"]>, "path" | "kind" | "jdbcSelection">;
/** Synchronous reconciliation has no await between reading versions and committing changes. */
export function synchronizeSources(cwd: string, discovered: Source[] = scanSources(cwd)): NonNullable<DatabaseResponse["syncIssues"]> {
	const issues: NonNullable<DatabaseResponse["syncIssues"]> = [];
	const previous = listConnections();
	const sources = new Map<string, Source>();
	for (const source of [...discovered, ...previous.flatMap(c => c.source && !c.source.path.startsWith("upload:") ? [c.source] : [])]) sources.set(JSON.stringify([source.kind, source.path]), source);
	for (const source of sources.values()) {
		const old = previous.filter(c => c.source?.path === source.path && c.source.kind === source.kind);
		let items;
		try {
			items = loadSource(source.kind, source.path, source.jdbcSelection);
			// Each connection retains its own mapping, even when several share one source file.
			const mappedSources = new Map<string, typeof items>([[JSON.stringify(source.jdbcSelection), items]]);
			for (const connection of old) {
				const selection = connection.source?.jdbcSelection;
				if (!selection) continue;
				const key = JSON.stringify(selection);
				let entries = mappedSources.get(key);
				if (!entries) { entries = loadSource(source.kind, source.path, selection); mappedSources.set(key, entries); }
				const mapped = entries.find(item => item.sourceId === connection.source?.id);
				if (mapped) items = items.map(item => item.sourceId === mapped.sourceId ? mapped : item);
			}
			if (new Set(items.map(i => i.sourceId)).size !== items.length) throw Error("Duplicate source IDs");
			for (const item of items) if (!item.issue) {
				validateConfig(item.config);
				if (item.password !== undefined && item.password.length > 16384) throw Error("Invalid source password");
			}
		} catch {
			// Parser and filesystem errors can include source contents; never expose them.
			const issue = "Source unavailable or invalid; connection disabled until the source is restored";
			issues.push({ path: source.path, issue });
			for (const c of old) markMissing(c.id, issue);
			continue;
		}
		for (const item of items) {
			const existing = old.find(c => c.source?.id === item.sourceId);
			const identity = { ...source, jdbcSelection: item.jdbcSelection ?? existing?.source?.jdbcSelection ?? source.jdbcSelection, id: item.sourceId };
			if (!existing && isSourceExcluded(identity)) continue;
			if (item.issue) {
				issues.push({ path: source.path, ...(source.kind === "datagrip" && item.issue.startsWith("JDBC_") ? { sourceId: item.sourceId } : {}), issue: `${item.config.name}: ${item.issue}`, ...(item.issue === "Unsupported driver; only MySQL/MariaDB and PostgreSQL are supported" ? { category: "unsupported-driver" as const } : {}) });
				if (existing) markMissing(existing.id, item.issue);
				continue;
			}
			if (existing && !existing.issue && JSON.stringify(validateConfig(existing)) === JSON.stringify(validateConfig(item.config))) continue;
			if (!existing && listConnections().length >= 200) { issues.push({ path: source.path, issue: "Connection limit reached (200)" }); continue; }
			saveConnection({ ...item.config, id: existing?.id, version: existing?.version, password: existing ? undefined : item.password }, identity, undefined, item.jdbcProfile);
		}
		for (const missing of old.filter(c => !items.some(i => i.sourceId === c.source!.id))) markMissing(missing.id);
	}
	return issues;
}
