import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Express } from "express";
import type { IncomingMessage } from "node:http";
import type { Note, NoteInput } from "./protocol.js";
import { writeFileAtomic } from "./private-file.js";

export class NoteError extends Error {
	constructor(public status: number, message: string) { super(message); }
}
function input(value: NoteInput): NoteInput {
	if (!value || typeof value.title !== "string" || value.title.length > 500 || typeof value.body !== "string" || value.body.length > 1_000_000 || typeof value.pinned !== "boolean") throw new NoteError(400, "Invalid note");
	return { title: value.title, body: value.body, pinned: value.pinned };
}
/** Synchronous read/check/write keeps concurrent requests serialized within the service. */
export class NotesStore {
	constructor(private directory: string) {}
	private path(id: string) {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new NoteError(400, "Invalid note ID");
		return join(this.directory, `${id}.json`);
	}
	read(id: string): Note {
		let note: Note;
		try { note = JSON.parse(readFileSync(this.path(id), "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NoteError(404, "Note not found"); throw error; }
		input(note);
		if (note.id !== id || !Number.isSafeInteger(note.version) || note.version < 1 || !Number.isFinite(note.createdAt) || !Number.isFinite(note.updatedAt)) throw new Error("Invalid stored note");
		return note;
	}
	list(query = ""): Note[] {
		let files: string[];
		try { files = readdirSync(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
		const q = query.toLocaleLowerCase();
		return files.filter(file => /^[a-f0-9-]{36}\.json$/.test(file)).map(file => this.read(file.slice(0, -5)))
			.filter(note => `${note.title}\n${note.body}`.toLocaleLowerCase().includes(q))
			.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
	}
	create(value: NoteInput): Note {
		const note = { ...input(value), id: randomUUID(), version: 1, createdAt: Date.now(), updatedAt: Date.now() };
		writeFileAtomic(this.path(note.id), JSON.stringify(note));
		return note;
	}
	update(id: string, version: number, value: NoteInput): Note {
		const old = this.read(id);
		if (old.version !== version) throw new NoteError(409, "Note changed in another window");
		const note = { ...old, ...input(value), version: old.version + 1, updatedAt: Date.now() };
		writeFileAtomic(this.path(id), JSON.stringify(note));
		return note;
	}
	delete(id: string, version: number): void {
		if (this.read(id).version !== version) throw new NoteError(409, "Note changed in another window");
		unlinkSync(this.path(id));
	}
}
export function installNotesRoutes(app: Express, directory: string, allowed: (req: IncomingMessage) => boolean) {
	const store = new NotesStore(directory);
	app.all(["/api/notes", "/api/notes/:id"], (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req) || (!["GET", "HEAD"].includes(req.method) && !req.is("application/json"))) { res.status(403).json({ error: "Forbidden" }); return; }
		try {
			const id = req.params.id;
			if (req.method === "GET") res.json(id ? { note: store.read(id) } : { notes: store.list(typeof req.query.q === "string" ? req.query.q : "") });
			else if (req.method === "POST" && !id) res.status(201).json({ note: store.create(req.body) });
			else if (req.method === "PUT" && id) res.json({ note: store.update(id, req.body?.version, req.body) });
			else if (req.method === "DELETE" && id) { store.delete(id, req.body?.version); res.json({ ok: true }); }
			else res.sendStatus(405);
		} catch (error) { res.status(error instanceof NoteError ? error.status : 500).json({ error: error instanceof NoteError ? error.message : "Notes storage failed" }); }
	});
}
