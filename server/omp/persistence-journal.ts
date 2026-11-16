import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../private-file.js";

export interface PersistenceRestriction { tokens: string[]; externallyModified: boolean }
/** Immutable failure records are independent of the transcript directory and client identity. */
export class OmpPersistenceJournal {
	constructor(private readonly ompRoot: string) {}
	private directory(file: string) {
		const path = resolve(file);
		const key = createHash("sha256").update(process.platform === "win32" ? path.toLowerCase() : path).digest("hex");
		return join(this.ompRoot, "recovery", key);
	}
	read(file: string): PersistenceRestriction {
		const directory = this.directory(file);
		let tokens: string[];
		try { tokens = readdirSync(directory).filter(name => name.endsWith(".json")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tokens: [], externallyModified: false }; throw Error("OMP recovery state unavailable"); }
		let externallyModified = false;
		for (const token of tokens) {
			try { externallyModified ||= JSON.parse(readFileSync(join(directory, token), "utf8")).externallyModified === true; }
			catch { /* A damaged record still blocks writes until explicit recovery. */ }
		}
		return { tokens, externallyModified };
	}
	record(file: string, externallyModified: boolean) {
		writeFileAtomic(join(this.directory(file), `${randomUUID()}.json`), JSON.stringify({ version: 1, externallyModified }));
	}
	assertAllowed(file: string, allowed: readonly string[] = []) {
		if (this.read(file).tokens.some(token => !allowed.includes(token))) throw Error("OMP history requires explicit recovery");
	}
	/** Delete only records acknowledged by this reopen; concurrent failures remain blocked. */
	clear(file: string, acknowledged: readonly string[]) {
		const directory = this.directory(file);
		for (const token of acknowledged) {
			if (!/^[\w.-]+\.json$/.test(token)) throw Error("Invalid OMP recovery record");
			try { unlinkSync(join(directory, token)); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("OMP recovery state unavailable"); }
		}
		this.assertAllowed(file);
	}
}
