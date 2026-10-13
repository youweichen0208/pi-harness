import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, statSync, unwatchFile, watchFile } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ProjectWorkspaceAction, ProjectWorkspaceCatalog } from "./protocol.js";
import { writeFileAtomic } from "./private-file.js";

/** UI-only catalog. No session or filesystem deletion belongs to this module.
 * The file may be shared by the desktop app and the CLI server, so every read
 * checks whether another process replaced it. */
export class ProjectWorkspaceStore {
	private catalog: ProjectWorkspaceCatalog | undefined;
	private stamp = "";

	constructor(private readonly file: string) {}

	read(): ProjectWorkspaceCatalog {
		const stamp = fileStamp(this.file);
		if (!this.catalog || stamp !== this.stamp) {
			this.catalog = readCatalog(this.file);
			this.stamp = stamp;
		}
		return structuredClone(this.catalog);
	}

	/** Calls back when another process changes the file; returns the unsubscribe function. */
	watch(onChange: (catalog: ProjectWorkspaceCatalog) => void): () => void {
		const listener = () => {
			const before = this.stamp;
			let catalog: ProjectWorkspaceCatalog;
			try { catalog = this.read(); } catch { return; /* keep a corrupt file for recovery */ }
			if (this.stamp !== before) onChange(catalog);
		};
		watchFile(this.file, { interval: 1000, persistent: false }, listener);
		return () => unwatchFile(this.file, listener);
	}

	/** One-time merge of an older per-app catalog into this one. Same-named workspaces
	 * combine their projects; the old file is renamed afterwards so it is merged only once. */
	importFrom(legacyFile: string): void {
		let legacy: ProjectWorkspaceCatalog;
		try { legacy = readCatalog(legacyFile, false); } catch { return; /* missing or corrupt: leave it alone */ }
		const next = this.read();
		let changed = false;
		for (const group of legacy.workspaces) {
			const same = next.workspaces.find((entry) => entry.name.toLowerCase() === group.name.toLowerCase());
			if (same) {
				for (const path of group.paths) if (!same.paths.includes(path) && same.paths.length < 1000) { same.paths.push(path); changed = true; }
			} else if (next.workspaces.length < 100) {
				const id = next.workspaces.some((entry) => entry.id === group.id) ? randomUUID() : group.id;
				next.workspaces.push({ id, name: group.name, paths: [...group.paths] });
				changed = true;
			}
		}
		if (changed) this.write(next);
		renameSync(legacyFile, `${legacyFile}.merged`);
	}

	apply(revision: number, action: ProjectWorkspaceAction): { catalog: ProjectWorkspaceCatalog; workspaceId: string } {
		const next = this.read();
		if (revision !== next.revision) throw new Error("Workspace changed in another window. Refresh and retry.");
		if (!action || typeof action !== "object") throw new Error("Invalid workspace action");
		let workspaceId: string;
		if (action.kind === "create") {
			if (next.workspaces.length >= 100) throw new Error("Workspace limit reached (100)");
			const name = checkedName(action.name);
			checkDuplicate(next, name);
			workspaceId = randomUUID();
			next.workspaces.push({ id: workspaceId, name, paths: [] });
		} else {
			const group = next.workspaces.find((entry) => entry.id === action.id);
			if (!group) throw new Error("Workspace no longer exists");
			workspaceId = group.id;
			switch (action.kind) {
				case "rename": {
					const name = checkedName(action.name);
					checkDuplicate(next, name, group.id);
					group.name = name;
					break;
				}
				case "delete": next.workspaces = next.workspaces.filter((entry) => entry.id !== group.id); break;
				case "add": {
					if (typeof action.path !== "string" || !isAbsolute(action.path)) throw new Error("Project path must be absolute");
					const path = resolve(action.path);
					if (!statSync(path).isDirectory()) throw new Error("Project path must be a directory");
					if (!group.paths.includes(path)) {
						if (group.paths.length >= 1000) throw new Error("Project limit reached (1000 per workspace)");
						group.paths.push(path);
					}
					break;
				}
				case "remove": {
					if (typeof action.path !== "string" || !isAbsolute(action.path)) throw new Error("Project path must be absolute");
					// Missing directories can still be removed from a group.
					group.paths = group.paths.filter((path) => path !== resolve(action.path));
					break;
				}
				default: throw new Error("Invalid workspace action");
			}
		}
		this.write(next);
		return { catalog: structuredClone(next), workspaceId };
	}

	private write(next: ProjectWorkspaceCatalog): void {
		next.revision++;
		writeFileAtomic(this.file, JSON.stringify(next, null, "\t") + "\n");
		this.catalog = next;
		this.stamp = fileStamp(this.file);
	}
}

/** Changes whenever the file is replaced (atomic writes swap the inode) or rewritten. */
function fileStamp(file: string): string {
	try {
		const info = statSync(file);
		if (!info.isFile()) return "";
		return `${info.ino}:${info.mtimeMs}:${info.size}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

function readCatalog(file: string, missingIsEmpty = true): ProjectWorkspaceCatalog {
	let data: unknown;
	try { data = JSON.parse(readFileSync(file, "utf8")); }
	catch (error) {
		if (!missingIsEmpty || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		data = { revision: 0, workspaces: [] };
	}
	if (!validCatalog(data)) throw new Error("Invalid project workspace catalog");
	return data;
}

function checkedName(value: unknown): string {
	if (typeof value !== "string") throw new Error("Workspace name is required");
	const name = value.trim().normalize("NFC");
	if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Workspace name must contain 1–80 characters without control characters");
	return name;
}

function checkDuplicate(catalog: ProjectWorkspaceCatalog, name: string, exceptId?: string): void {
	if (catalog.workspaces.some((group) => group.id !== exceptId && group.name.toLowerCase() === name.toLowerCase())) {
		throw new Error("Workspace name already exists");
	}
}

function validCatalog(value: unknown): value is ProjectWorkspaceCatalog {
	if (!value || typeof value !== "object") return false;
	const data = value as ProjectWorkspaceCatalog;
	if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.workspaces) || data.workspaces.length > 100) return false;
	const ids = new Set<string>();
	const names = new Set<string>();
	return data.workspaces.every((group) => {
		if (!group || typeof group.id !== "string" || !group.id || ids.has(group.id)) return false;
		try { if (checkedName(group.name) !== group.name || names.has(group.name.toLowerCase())) return false; } catch { return false; }
		ids.add(group.id); names.add(group.name.toLowerCase());
		return Array.isArray(group.paths) && group.paths.length <= 1000 && group.paths.every((path) => typeof path === "string" && isAbsolute(path)) && new Set(group.paths).size === group.paths.length;
	});
}
