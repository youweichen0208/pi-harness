import type { Express, Request } from "express";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** One configured folder; changing it never moves documents or deletes Wiki history. */
export class KnowledgeLibrary {
	private readonly file: string;
	constructor(dataDir: string) { this.file = join(dataDir, "knowledge-library.json"); }
	private stored(): { cwd: string; path: string | null } | null {
		try {
			const value = JSON.parse(readFileSync(this.file, "utf8"));
			return typeof value?.cwd === "string" && isAbsolute(value.cwd) ? { cwd: value.cwd, path: typeof value.path === "string" ? value.path : null } : null;
		} catch { return null; }
	}
	private document(cwd: string, path: unknown): string | null {
		if (typeof path !== "string" || !/\.(md|markdown)$/i.test(path)) return null;
		try {
			const file = realpathSync(resolve(cwd, path));
			const rel = relative(cwd, file);
			if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(file).isFile()) return null;
			return rel.split(sep).join("/");
		} catch { return null; }
	}
	read() {
		const value = this.stored();
		if (!value) return { cwd: null, path: null, available: false };
		try {
			const cwd = realpathSync(value.cwd);
			return { cwd, path: this.document(cwd, value.path), available: statSync(cwd).isDirectory() };
		} catch { return { ...value, available: false }; }
	}
	private save(value: { cwd: string; path: string | null }) {
		mkdirSync(resolve(this.file, ".."), { recursive: true });
		writeFileSync(`${this.file}.tmp`, JSON.stringify(value), { mode: 0o600 });
		renameSync(`${this.file}.tmp`, this.file);
		return this.read();
	}
	configure(path: unknown) {
		if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Choose an absolute folder path");
		const cwd = realpathSync(path);
		if (!statSync(cwd).isDirectory()) throw new Error("Choose a folder");
		const previous = this.read();
		return this.save({ cwd, path: previous.cwd === cwd ? previous.path : null });
	}
	remember(cwd: unknown, path: unknown) {
		const current = this.read();
		// A stale window must never replace a newly configured library.
		if (typeof cwd !== "string" || !current.available || realpathSync(cwd) !== current.cwd) return current;
		return this.save({ cwd: current.cwd!, path: this.document(current.cwd!, path) });
	}
}

export function installKnowledgeLibraryRoutes(app: Express, dataDir: string, allowed: (req: Request) => boolean) {
	const library = new KnowledgeLibrary(dataDir);
	app.post("/api/knowledge-library", (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req) || !req.is("application/json")) { res.status(403).json({ error: "Forbidden" }); return; }
		try {
			const { action, cwd, path } = req.body ?? {};
			if (action === "read") res.json(library.read());
			else if (action === "configure") res.json(library.configure(cwd));
			else if (action === "remember") res.json(library.remember(cwd, path));
			else res.status(400).json({ error: "Invalid action" });
		} catch (error) { res.status(400).json({ error: (error as Error).message }); }
	});
}
