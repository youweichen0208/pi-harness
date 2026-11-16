/** Bun-only prompt file control. Composition and discovery remain native OMP. */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { discoverSystemPromptOverride } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { claimPromptSources } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, mkdirSync, writeFileSync, renameSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { UiOmpPromptDocument, UiOmpPromptFile, UiOmpPromptState } from "../protocol.js";

const LIMIT = 512 * 1024;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export class OmpPromptError extends Error {}
const fail = (message: string): never => { throw new OmpPromptError(message); };
function inspect(path: string) {
	// Canonical parents bind absent files too, without following a substituted directory.
	let parent = dirname(path);
	for (;;) {
		try { if (realpathSync(parent) !== resolve(parent)) fail("Prompt directories must not be symbolic links"); break; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const next = dirname(parent); if (next === parent) throw error; parent = next; }
	}
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) fail("Prompt source must be a regular UTF-8 file of at most 512 KiB");
		const bytes = readFileSync(path);
		if (bytes.length > LIMIT) fail("Prompt source exceeds 512 KiB");
		let content: string;
		try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("Prompt source is not valid UTF-8"); }
		return { exists: true, content, version: hash(Buffer.concat([Buffer.from(`${path}\0`), bytes])), mode: stat.mode & 0o777 };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, content: "", version: hash(`missing:${path}`), mode: 0o600 };
		throw error;
	}
}

export class OmpPromptControl {
	private loaded = "";
	private reloadError?: string;
	constructor(private session: AgentSession, private agentDir: string, private cancelled: () => boolean) {}
	private idle() { if (this.cancelled() || this.session.isDisposed || this.session.isStreaming || this.session.isCompacting || this.session.isRetrying) fail("Stop the current task before changing prompt files"); }
	private sources() {
		const blocks = this.session.systemPrompt;
		return [...claimPromptSources(blocks, this.session.systemPromptSources).byBlock.entries()].flatMap(([index, sources]) => sources.filter(source => source.kind === "instruction-files").map(source => ({ label: source.label, path: source.path ?? (isAbsolute(source.label) ? source.label : undefined), text: blocks[index].slice(source.start, source.end) })));
	}
	private async catalog() {
		const cwd = this.session.settings.getCwd();
		clearCache();
		const selected = await discoverSystemPromptOverride(cwd);
		const files = new Map<string, UiOmpPromptFile>();
		const add = (path: string, kind: UiOmpPromptFile["kind"], scope: UiOmpPromptFile["scope"]) => {
			path = resolve(path);
			if (files.has(path)) return;
			const file: UiOmpPromptFile = { id: hash(path), path, kind, scope, exists: false, editable: true, version: "", selectedOnDisk: !!selected && resolve(selected.path) === path };
			try { const disk = inspect(path); file.exists = disk.exists; file.version = disk.version; }
			catch (error) { file.editable = false; file.error = error instanceof OmpPromptError ? error.message : "Prompt source could not be read"; }
			files.set(path, file);
		};
		for (const scope of ["user", "project"] as const) {
			const dir = scope === "user" ? this.agentDir : join(cwd, ".omp");
			add(join(dir, "SYSTEM.md"), "system", scope);
			add(join(dir, "SYSTEM_TEMPLATE.md"), "template", scope);
		}
		if (selected) add(selected.path, selected.kind === "template" ? "template" : "system", "source");
		for (const source of this.sources()) if (source.path) add(source.path, "context", "source");
		add(join(cwd, "AGENTS.md"), "context", "project");
		return [...files.values()];
	}
	private signature(files: UiOmpPromptFile[]) { return hash(JSON.stringify(files.map(file => [file.id, file.version, file.error]))); }
	async markLoaded() { this.loaded = this.signature(await this.catalog()); this.reloadError = undefined; }
	async get(): Promise<UiOmpPromptState> {
		const files = await this.catalog();
		return { available: true, blocks: [...this.session.systemPrompt], sources: this.sources(), files, reloadRequired: this.signature(files) !== this.loaded, reloadError: this.reloadError };
	}
	private async file(id: unknown) {
		const file = (await this.catalog()).find(file => file.id === id);
		if (!file?.editable) return fail("Prompt source is unavailable or read-only");
		return file;
	}
	async read(id: unknown): Promise<UiOmpPromptDocument> {
		const file = await this.file(id), disk = inspect(file.path);
		return { file: { ...file, version: disk.version, exists: disk.exists }, content: disk.content };
	}
	async save(id: unknown, version: unknown, content: unknown, remove = false) {
		this.idle();
		const file = await this.file(id);
		if (!remove && (typeof content !== "string" || Buffer.byteLength(content) > LIMIT || Buffer.from(content).toString("utf8") !== content)) fail("Prompt text must be valid UTF-8 and at most 512 KiB");
		if (remove && file.kind === "context") fail("Context files cannot be deleted from prompt settings");
		inspect(file.path); mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
		await withFileLock(file.path, async () => {
			this.idle();
			const disk = inspect(file.path);
			if (version !== disk.version) fail("Prompt file changed; reload it before saving");
			if (remove) { if (!disk.exists) fail("Prompt file no longer exists"); unlinkSync(file.path); return; }
			const temp = `${file.path}.${randomUUID()}.tmp`;
			try { writeFileSync(temp, content as string, { flag: "wx", mode: disk.mode }); chmodSync(temp, disk.mode); renameSync(temp, file.path); }
			finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
		});
		return this.get();
	}
	async reload() {
		this.idle();
		const before = this.signature(await this.catalog());
		this.idle(); clearCache();
		// A concurrent disk edit must remain pending even if it lands during refresh.
		try { await this.session.refreshSkillsAndCommands(); this.idle(); this.loaded = before; this.reloadError = undefined; }
		catch { this.reloadError = "OMP could not reload the prompt; the saved file remains on disk"; }
		return this.get();
	}
}
