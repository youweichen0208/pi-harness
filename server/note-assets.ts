import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Express } from "express";
import type { IncomingMessage } from "node:http";
import { sniffImageMime } from "./text-sniff.js";
export function imageBytes(data: unknown): { bytes: Buffer; mime: string } {
	if (typeof data !== "string" || data.length > 6990508 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("Invalid image");
	const bytes = Buffer.from(data, "base64"), mime = sniffImageMime(bytes, "");
	if (bytes.length > 5 * 1024 * 1024 || !mime || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) throw new Error("Invalid image");
	return { bytes, mime };
}
export function installNoteAssets(app: Express, directory: string, allowed: (req: IncomingMessage) => boolean) {
	app.post("/api/notes/assets", (req, res) => {
		if (!allowed(req) || !req.is("application/json")) { res.sendStatus(403); return; }
		let bytes: Buffer;
		try { bytes = imageBytes(req.body?.data).bytes; } catch { res.status(400).json({ error: "Invalid image (maximum 5 MiB)" }); return; }
		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const id = randomUUID(), path = join(directory, id), temporary = `${path}.tmp`;
			writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 }); renameSync(temporary, path);
			res.status(201).json({ path: `/api/notes/assets/${id}` });
		} catch { res.status(500).json({ error: "Image storage failed" }); }
	});
	app.get("/api/notes/assets/:asset", (req, res) => {
		if (!allowed(req)) { res.sendStatus(403); return; }
		if (!/^[a-f0-9-]{36}$/.test(req.params.asset)) { res.sendStatus(400); return; }
		try {
			const bytes = readFileSync(join(directory, req.params.asset));
			res.setHeader("Cache-Control", "private, no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
			res.type(sniffImageMime(bytes, "") ?? "application/octet-stream").send(bytes);
		} catch (error) { res.sendStatus((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500); }
	});
}
