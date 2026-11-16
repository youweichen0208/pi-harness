/** Bun-only package settings. Manifest inspection never imports package code. */
import { readFile, lstat, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getConfigDirPaths } from "@oh-my-pi/pi-coding-agent/config";
import { getProjectPluginOverridesPath } from "@oh-my-pi/pi-utils";
import { validateSetting } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { normalizePluginRuntimeConfig, writePluginRuntimeConfig } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/runtime-config";
import type { PluginRuntimeConfig, PluginSettingSchema } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import type { OmpPackageScope, UiOmpPackageSettings, UiOmpPackageSetting } from "../protocol.js";
import { replaceFileWithRetry } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";
import { isRecord } from "./framing.js";

const safeKey = (key: string) => key.length > 0 && key.length <= 256 && !["__proto__", "prototype", "constructor"].includes(key);
async function bytes(file: string, writable = false) {
	try {
		const stat = await lstat(file);
		if (writable && (!stat.isFile() || stat.isSymbolicLink()) || stat.size > 4 * 1024 * 1024) throw Error("Invalid settings file");
		const raw = await readFile(file, "utf8"); if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw Error("Oversized settings file"); return raw;
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
function object(raw: string) { const value: unknown = raw ? JSON.parse(raw) : {}; if (!isRecord(value)) throw Error("Invalid settings document"); return value; }
function map(value: unknown): Record<string, unknown> { if (value === undefined) return {}; if (!isRecord(value)) throw Error("Invalid settings map"); return value; }
function scalar(value: unknown): value is string | number | boolean { return typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 4096; }
function schema(value: unknown): PluginSettingSchema {
	if (!isRecord(value) || !["string", "number", "boolean", "enum"].includes(String(value.type))) throw Error("Invalid setting schema");
	if (value.secret !== undefined && typeof value.secret !== "boolean") throw Error("Invalid secret declaration");
	if (value.type === "enum" && (!Array.isArray(value.values) || !value.values.length || value.values.length > 256 || value.values.some(item => typeof item !== "string" || item.length > 4096))) throw Error("Invalid enum schema");
	for (const key of ["min", "max", "step"]) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) throw Error("Invalid number schema");
	return value as unknown as PluginSettingSchema;
}
function valid(value: unknown, definition: PluginSettingSchema): value is string | number | boolean { return scalar(value) && validateSetting(value, definition).valid && (definition.type !== "enum" || typeof value === "string"); }

export async function packageSettings(path: string, root: string, cwd: string, scope: unknown) {
	if (scope !== "user" && scope !== "project") throw Error("Invalid settings scope");
	const manifestBytes = await bytes(join(path, "package.json"));
	const pkg = object(manifestBytes); if (typeof pkg.name !== "string" || !safeKey(pkg.name)) throw Error("Invalid package name");
	const manifest = isRecord(pkg.omp) ? pkg.omp : isRecord(pkg.pi) ? pkg.pi : {};
	const definitions = Object.entries(map(manifest.settings)).map(([key, value]) => { if (!safeKey(key)) throw Error("Invalid setting key"); return [key, schema(value)] as const; });
	if (definitions.length > 256) throw Error("Too many settings");
	const userFile = join(root, "omp-plugins.lock.json"), userBytes = await bytes(userFile, true), user = object(userBytes);
	const hash = createHash("sha256").update(path).update(manifestBytes).update(userFile).update(userBytes);
	let projectFile = getProjectPluginOverridesPath(cwd), project: Record<string, unknown> = {}, found = false;
	// Match the native loader's first readable JSON override, including parent
	// project discovery. Hash all candidates so external precedence changes conflict.
	for (const file of getConfigDirPaths("plugin-overrides.json", { user: false, cwd })) {
		const raw = await bytes(file, true); hash.update(file).update(raw);
		if (!raw || found) continue;
		let parsed: unknown;
		try { parsed = JSON.parse(raw); } catch { continue; }
		// A valid non-object wins discovery too; do not silently edit a lower
		// priority file that the native loader would never consult.
		if (!isRecord(parsed)) throw Error("Invalid project overrides");
		project = parsed; projectFile = file; found = true;
	}
	if (!found && await bytes(projectFile, true)) throw Error("Repair invalid project overrides before editing settings");
	const userSettings = map(map(user.settings)[pkg.name]), projectSettings = map(map(project.settings)[pkg.name]);
	const selected = scope === "project" ? projectSettings : userSettings;
	const fields: UiOmpPackageSetting[] = definitions.map(([key, definition]) => {
		const configured = Object.hasOwn(selected, key), stored = selected[key];
		const merged = { ...userSettings, ...projectSettings };
		const effective = merged[key] ?? definition.default;
		const source = merged[key] != null ? Object.hasOwn(projectSettings, key) ? "project" : "user" : definition.default !== undefined ? "default" : "unset";
		const secret = definition.secret === true;
		return { key, type: definition.type, secret, configured, invalid: configured && !valid(stored, definition), source,
			...(typeof definition.description === "string" ? { description: definition.description.slice(0, 2048) } : {}),
			...(typeof definition.env === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(definition.env) ? { env: definition.env } : {}),
			...(!secret && valid(stored, definition) ? { value: stored } : {}),
			...(!secret && valid(effective, definition) ? { effective } : {}),
			...(!secret && definition.type === "enum" ? { values: definition.values } : {}),
			...(definition.type === "number" ? { min: definition.min, max: definition.max, step: definition.step } : {}),
		};
	});
	const view: UiOmpPackageSettings = { name: pkg.name, scope, path: scope === "project" ? projectFile : userFile, version: hash.digest("hex"), fields };
	return { view, definitions, user, project };
}

export async function savePackageSettings(path: string, root: string, cwd: string, scope: OmpPackageScope, expectedVersion: unknown, patch: unknown) {
	const state = await packageSettings(path, root, cwd, scope);
	if (state.view.version !== expectedVersion) throw Error("conflict");
	if (!isRecord(patch) || !Object.keys(patch).length || Object.keys(patch).length > 256 || JSON.stringify(patch).length > 12000) throw Error("Invalid settings patch");
	const document = scope === "project" ? state.project : state.user;
	const settings = { ...map(document.settings) }, selected = { ...map(settings[state.view.name]) };
	for (const [key, change] of Object.entries(patch)) {
		const definition = state.definitions.find(([name]) => name === key)?.[1];
		if (!definition || !isRecord(change)) throw Error("Unknown setting");
		if (change.action === "reset") { if (Object.keys(change).length !== 1) throw Error("Invalid reset"); delete selected[key]; }
		else if (change.action === "set" && Object.keys(change).length === 2 && valid(change.value, definition)) selected[key] = change.value;
		else throw Error("Invalid setting value");
	}
	settings[state.view.name] = selected;
	const updated = { ...document, settings };
	// All changes are validated before the single atomic write. Native user
	// settings and project overrides remain keyed by package name, not install ID.
	if (scope === "user") await writePluginRuntimeConfig(state.view.path, { ...updated, ...normalizePluginRuntimeConfig(updated as Partial<PluginRuntimeConfig>) });
	else {
		await mkdir(dirname(state.view.path), { recursive: true, mode: 0o700 });
		const staged = `${state.view.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(staged, JSON.stringify(updated, null, 2), { flag: "wx", mode: 0o600 });
			await replaceFileWithRetry(staged, state.view.path);
		} finally { await rm(staged, { force: true }).catch(() => {}); }
	}
	return (await packageSettings(path, root, cwd, scope)).view;
}
