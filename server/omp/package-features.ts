/** Native package feature metadata. Reading this module never imports factories. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getConfigDirPaths } from "@oh-my-pi/pi-coding-agent/config";
import { normalizePluginRuntimeConfig, writePluginRuntimeConfig } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/runtime-config";
import type { PluginRuntimeConfig } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import type { UiOmpPackageFeatures } from "../protocol.js";
import { isRecord } from "./framing.js";

async function bytes(file: string): Promise<string> {
	try { return await readFile(file, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
function selection(value: unknown): string[] | null {
	if (value === null || value === undefined) return null;
	if (!Array.isArray(value) || value.length > 256 || value.some(item => typeof item !== "string" || !item || item.length > 256)) throw Error("Invalid native feature selection");
	return value;
}
export function validatePackageFeatures(value: unknown, view: UiOmpPackageFeatures): string[] | null {
	if (value === undefined) throw Error("Missing feature selection");
	const selected = selection(value);
	if (selected && (new Set(selected).size !== selected.length || selected.some(name => !view.available.some(feature => feature.name === name)))) throw Error("Unknown package feature");
	return selected;
}

export async function readPackageFeatures(path: string, root: string, cwd: string) {
	const manifestBytes = await bytes(join(path, "package.json"));
	const pkg: unknown = JSON.parse(manifestBytes);
	if (!isRecord(pkg) || typeof pkg.name !== "string") throw Error("Invalid package manifest");
	const manifest = isRecord(pkg.omp) ? pkg.omp : isRecord(pkg.pi) ? pkg.pi : {};
	const definitions = isRecord(manifest.features) ? manifest.features : {};
	const available: UiOmpPackageFeatures["available"] = Object.entries(definitions).map(([name, feature]) => {
		if (!name || name.length > 256 || !isRecord(feature)) throw Error("Invalid feature definition");
		return { name, default: !!feature.default, ...(typeof feature.description === "string" ? { description: feature.description.slice(0, 2048) } : {}) };
	});
	if (available.length > 256) throw Error("Too many package features");
	const runtimeBytes = await bytes(join(root, "omp-plugins.lock.json"));
	const runtime: unknown = runtimeBytes ? JSON.parse(runtimeBytes) : {};
	const stored = isRecord(runtime) && isRecord(runtime.plugins) ? runtime.plugins[pkg.name] : undefined;
	const selected = selection(isRecord(stored) ? stored.enabledFeatures : null);
	const hash = createHash("sha256").update(manifestBytes).update(runtimeBytes);
	let effective = selected, overridden = false, foundOverrideFile = false;
	// Same public discovery order as the SDK loader. Malformed override files
	// fall through there too; hash every candidate so edits invalidate previews.
	for (const file of getConfigDirPaths("plugin-overrides.json", { user: false, cwd })) {
		const raw = await bytes(file); hash.update(file).update(raw);
		if (!raw || foundOverrideFile) continue;
		try {
			const overrides: unknown = JSON.parse(raw);
			if (!isRecord(overrides)) continue;
			foundOverrideFile = true;
			if (isRecord(overrides.features) && overrides.features[pkg.name] != null) {
				effective = selection(overrides.features[pkg.name]); overridden = true;
			}
		} catch { /* Native loader ignores unreadable JSON and tries the next source. */ }
	}
	const view: UiOmpPackageFeatures = { selected, effective, overridden, available };
	return { name: pkg.name, view, version: hash.digest("hex") };
}

/** Project runtime roots use the SDK's atomic writer; PluginManager's setter is user-only. */
export async function writeProjectPackageFeatures(path: string, root: string, cwd: string, value: unknown) {
	const { name, view } = await readPackageFeatures(path, root, cwd);
	const selected = validatePackageFeatures(value, view);
	const file = join(root, "omp-plugins.lock.json");
	const raw = JSON.parse(await bytes(file));
	if (!isRecord(raw) || !isRecord(raw.plugins) || !isRecord(raw.plugins[name])) throw Error("Native runtime entry unavailable");
	const config = { ...raw, ...normalizePluginRuntimeConfig(raw as Partial<PluginRuntimeConfig>) };
	config.plugins[name] = { ...config.plugins[name], enabledFeatures: selected };
	await writePluginRuntimeConfig(file, config);
}
