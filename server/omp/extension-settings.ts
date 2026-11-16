/** Native discovery without importing factories; settings remain owned by OMP. */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { cfgExtensions, cfgDisabledExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { discoverExtensionPaths, listPackageExtensionModules } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { getExtensionNameFromPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, lstatSync, openSync, closeSync, fstatSync, readSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { replaceFileWithRetry } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";
import { isAbsolute, join, resolve, relative, sep, dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { OmpExtensionSettingKey, UiOmpExtensionState, UiOmpExtensionDocument } from "../protocol.js";
import { isRecord } from "./framing.js";

const definitions = { extensions: cfgExtensions, disabledExtensions: cfgDisabledExtensions };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
export class OmpExtensionError extends Error {}

const SOURCE_LIMIT = 512 * 1024;
const within = (root: string, path: string) => { const rel = relative(root, path); return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
function sourceFile(path: string) {
	if (realpathSync(path) !== path || realpathSync(dirname(path)) !== dirname(path)) throw new OmpExtensionError("Extension source must not be a symbolic link");
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SOURCE_LIMIT) throw new OmpExtensionError("Extension source must be a regular UTF-8 file of at most 512 KiB");
	const fd = openSync(path, "r");
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new OmpExtensionError("Extension source changed; read it again");
		const bytes = Buffer.alloc(SOURCE_LIMIT + 1);
		let count = 0, read = 0;
		do { read = readSync(fd, bytes, count, bytes.length - count, null); count += read; } while (read && count < bytes.length);
		if (count > SOURCE_LIMIT) throw new OmpExtensionError("Extension source exceeds 512 KiB");
		const raw = bytes.subarray(0, count);
		let content: string;
		try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); } catch { throw new OmpExtensionError("Extension source is not valid UTF-8"); }
		if (content.includes("\0")) throw new OmpExtensionError("Extension source is not a text file");
		return { content, version: hash(`${path}\0${stat.mode & 0o777}\0${content}`), mode: stat.mode & 0o777 };
	} finally { closeSync(fd); }
}

export class OmpExtensionSettings {
	private sourceChanged = false;
	constructor(private session: AgentSession, private cancelled: () => boolean) {}
	private settings(): UiOmpExtensionState["settings"] {
		const global = this.session.settings.getGlobalSettings();
		return (Object.keys(definitions) as OmpExtensionSettingKey[]).map(key => {
			const saved = global[key];
			if (saved != null && (!Array.isArray(saved) || saved.some(item => typeof item !== "string"))) throw new OmpExtensionError("Invalid native extension settings");
			return { key, value: definitions[key].get(this.session.settings), global: saved ?? null, source: this.session.settings.getProvenance(definitions[key]) };
		});
	}
	private idle() { if (this.cancelled() || this.session.isDisposed || this.session.isStreaming || this.session.isCompacting || this.session.isRetrying) throw new OmpExtensionError("Stop the current task before changing extensions"); }
	async get(): Promise<UiOmpExtensionState> {
		const settings = this.settings(), configured = cfgExtensions.get(this.session.settings), disabled = cfgDisabledExtensions.get(this.session.settings), cwd = this.session.settings.getCwd();
		clearCache();
		const [all, enabled, configuredModules, packageModules] = await Promise.all([
			discoverExtensionPaths(configured, cwd, [], { includeAmbientHooks: false }),
			discoverExtensionPaths(configured, cwd, disabled, { includeAmbientHooks: false }),
			listPackageExtensionModules(configured, cwd, { plugins: false }),
			listPackageExtensionModules([], cwd, { plugins: true }),
		]);
		const packaged = new Set(packageModules.map(item => canonical(item.path)));
		const local = new Set(configuredModules.map(item => canonical(item.path)));
		const roots = [join(this.session.settings.getAgentDir(), "extensions"), join(cwd, ".omp", "extensions")].map(canonical);
		const explicit = new Set(configuredModules.filter(item => !item.toggleable).map(item => canonical(item.path)));
		const enabledPaths = new Set(enabled.map(canonical));
		const runner = this.session.extensionRunner;
		const loaded = new Map((runner?.getLoadedExtensions() ?? []).filter(item => isAbsolute(item.resolvedPath)).map(item => [canonical(item.resolvedPath), { path: item.path, active: runner!.isExtensionActive(item.path) }]));
		const discovered = new Map(all.map(path => [canonical(path), path]));
		const paths = new Map([...discovered, ...[...loaded.keys()].filter(path => !discovered.has(path)).map(path => [path, path] as const)]);
		const modules = [...paths].map(([path, original]) => {
			const name = getExtensionNameFromPath(original), live = loaded.get(path), governed = discovered.has(path);
			const editable = governed && /\.[cm]?[jt]s$/.test(path) && !path.split(sep).includes("node_modules") && !packaged.has(path) && (local.has(path) || roots.some(root => within(root, path)));
			return { id: hash(path), name, path, editable, enabled: governed ? enabledPaths.has(path) : !!live?.active, loaded: !!live, active: !!live?.active, ...(governed && !explicit.has(path) ? { toggleKey: `extension-module:${name}` } : {}) };
		});
		return { available: true, version: hash(JSON.stringify(settings)), settings, modules, restartRequired: this.sourceChanged || modules.some(item => item.enabled && !item.loaded) };
	}
	private async source(id: unknown) {
		const module = (await this.get()).modules.find(item => item.id === id);
		if (!module?.editable) throw new OmpExtensionError("Extension source is unavailable or read-only");
		return module;
	}
	async readSource(id: unknown): Promise<UiOmpExtensionDocument> {
		const module = await this.source(id), disk = sourceFile(module.path);
		return { moduleId: module.id, path: module.path, content: disk.content, version: disk.version };
	}
	async saveSource(id: unknown, version: unknown, content: unknown): Promise<UiOmpExtensionDocument> {
		this.idle();
		if (typeof version !== "string" || !/^[a-f0-9]{64}$/.test(version) || typeof content !== "string" || Buffer.byteLength(content) > SOURCE_LIMIT || content.includes("\0") || Buffer.from(content).toString("utf8") !== content) throw new OmpExtensionError("Extension text must be valid UTF-8 and at most 512 KiB, with a current file version");
		const module = await this.source(id);
		return withFileLock(module.path, async () => {
			this.idle(); await this.source(id); this.idle();
			const disk = sourceFile(module.path);
			if (version !== disk.version) throw new OmpExtensionError("Extension file changed; read it again before saving");
			const temp = `${module.path}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temp, content, { flag: "wx", mode: disk.mode }); chmodSync(temp, disk.mode);
				this.idle();
				if (sourceFile(module.path).version !== version) throw new OmpExtensionError("Extension file changed; read it again before saving");
				await replaceFileWithRetry(temp, module.path);
				this.sourceChanged = true;
			} finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
			// Report the bytes we saved, never acknowledge a later external edit as this draft.
			return { moduleId: module.id, path: module.path, content, version: hash(`${module.path}\0${disk.mode}\0${content}`) };
		});
	}

	async save(version: unknown, patch: unknown) {
		this.idle();
		if (typeof version !== "string" || !isRecord(patch) || !Object.keys(patch).length || JSON.stringify(patch).length > 65536) throw new OmpExtensionError("Invalid extension settings");
		for (const [key, value] of Object.entries(patch)) {
			if (!Object.hasOwn(definitions, key)) throw new OmpExtensionError("Unknown extension setting");
			if (value === null) continue;
			if (!Array.isArray(value) || value.length > 256 || value.some(item => typeof item !== "string" || !item.trim() || item.length > 2048 || item.includes("\0"))) throw new OmpExtensionError("Invalid extension paths or disabled identifiers");
			definitions[key as OmpExtensionSettingKey].assertWritable(value);
		}
		const release = await lockfile.lock(join(this.session.settings.getAgentDir(), "web-extension-settings"), { realpath: false, stale: 30000, retries: { retries: 40, minTimeout: 20, maxTimeout: 200 } });
		try {
			this.idle(); await this.session.settings.reloadFromDisk(); this.idle();
			if (hash(JSON.stringify(this.settings())) !== version) throw new OmpExtensionError("Extension settings changed; refresh before saving");
			for (const [key, value] of Object.entries(patch)) {
				const definition = definitions[key as OmpExtensionSettingKey];
				if (value === null) this.session.settings.unsetGlobalValue(definition);
				else this.session.settings.writeValue(definition, value, "global");
			}
			await this.session.settings.flush(); await this.session.settings.reloadFromDisk();
			for (const [key, value] of Object.entries(patch)) if (JSON.stringify(this.settings().find(entry => entry.key === key)?.global) !== JSON.stringify(value)) throw new OmpExtensionError("Extension settings changed during save; refresh before continuing");
			return this.get();
		} finally { await release(); }
	}
	async toggle(version: unknown, id: unknown, enabled: unknown) {
		if (typeof enabled !== "boolean") throw new OmpExtensionError("Invalid extension switch");
		const state = await this.get(), module = state.modules.find(item => item.id === id);
		if (!module?.toggleKey) throw new OmpExtensionError("This module is not governed by a native name switch; edit its configured paths");
		const entry = state.settings.find(item => item.key === "disabledExtensions")!;
		if (entry.source === "project" || entry.source === "runtime" || entry.source === "env" || entry.source === "overlay") throw new OmpExtensionError("A higher-priority native setting controls this switch");
		const value = entry.global ?? entry.value;
		return this.save(version, { disabledExtensions: enabled ? value.filter(key => key !== module.toggleKey) : [...new Set([...value, module.toggleKey])] });
	}
}
