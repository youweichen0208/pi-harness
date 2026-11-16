import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface DocumentExtensionSettings {
	databaseEnabled: boolean;
}

export function documentDataDir(): string {
	return resolve(process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
}

function readSettings(): { document: Record<string, unknown>; version: string } {
	try {
		const raw = readFileSync(join(documentDataDir(), "document-extensions.json"), "utf8");
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
		return { document: value as Record<string, unknown>, version: createHash("sha256").update(`file:${raw}`).digest("hex") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { document: {}, version: createHash("sha256").update("missing").digest("hex") };
		throw new Error(`Cannot read document-extensions.json: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function validate(value: Record<string, unknown>): DocumentExtensionSettings {
	const result: DocumentExtensionSettings = { databaseEnabled: true };
	for (const key of ["databaseEnabled"] as const) {
		if (value[key] !== undefined) {
			if (typeof value[key] !== "boolean") throw new Error(`${key} must be a boolean`);
			result[key] = value[key];
		}
	}
	return result;
}

/** Read on every invocation so already loaded sessions honor a global disable. */
export function getDocumentSettings(): DocumentExtensionSettings {
	return validate(readSettings().document);
}

export function getDocumentSettingsState() {
	const saved = readSettings();
	return { settings: validate(saved.document), version: saved.version };
}

export class DocumentSettingsConflictError extends Error {
	constructor() { super("Database settings changed; refresh and retry"); }
}

export function updateDocumentSettings(patch: Partial<DocumentExtensionSettings>, expectedVersion?: string): DocumentExtensionSettings {
	const current = readSettings();
	if (expectedVersion !== undefined && expectedVersion !== current.version) throw new DocumentSettingsConflictError();
	const saved = current.document;
	const next = validate({ ...saved, ...patch });
	const output: Record<string, unknown> = { ...saved, ...next };
	for (const key of ["pdfEnabled", "pythonPath", "runtimePath", "okfEnabled"]) delete output[key];
	const folder = documentDataDir();
	mkdirSync(folder, { recursive: true });
	const target = join(folder, "document-extensions.json");
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(output, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} finally { rmSync(temporary, { force: true }); }
	return next;
}
