/** Bun-only, one operation per process. Never create an agent or call a model. */
import { readFile, mkdir, writeFile, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { JSONC } from "bun";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { getPluginsDir, getPluginsNodeModules, getProjectPluginOverridesPath } from "@oh-my-pi/pi-utils";
import lockfile from "proper-lockfile";
import type { OmpPackageOperation, UiOmpPackagePlan, UiOmpPackages } from "../protocol.js";
import { isRecord } from "./framing.js";
import { OmpMarketplacePackages, marketplaceOperations } from "./marketplace-packages.js";
import { readPackageFeatures, validatePackageFeatures } from "./package-features.js";

import { packageSettings, savePackageSettings } from "./package-settings.js";

class PackageError extends Error {
	constructor(readonly code: "conflict" | "busy" | "invalid") { super(code); }
}
const manager = new PluginManager(process.cwd());
const root = getPluginsDir();
const operations: OmpPackageOperation[] = ["install", "link", "update", "remove", "enable", "disable", "features", ...marketplaceOperations];
let marketplace: OmpMarketplacePackages;
async function bytes(file: string) {
	try { return await readFile(file); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0); throw error; }
}
async function state(): Promise<UiOmpPackages> {
	const plugins = await manager.list();
	const configBytes = await bytes(join(root, "omp-plugins.lock.json"));
	const config: unknown = configBytes.length ? JSONC.parse(configBytes.toString("utf8")) : {};
	const states = isRecord(config) && isRecord(config.plugins) ? config.plugins : {};
	const featureVersions: string[] = [];
	const items = await Promise.all(plugins.map(async plugin => {
		let updatable = true;
		try { await manager.validateUpgrade(plugin.name); } catch { updatable = false; }
		const saved = states[plugin.name];
		const features = await readPackageFeatures(plugin.path, root, process.cwd());
		featureVersions.push(features.version);
		return { name: plugin.name, version: plugin.version, path: plugin.path, enabled: !isRecord(saved) || saved.enabled !== false, effectiveEnabled: plugin.enabled, updatable, features: plugin.enabledFeatures, featureConfig: features.view };
	}));
	items.sort((a, b) => a.name.localeCompare(b.name));
	const hash = createHash("sha256").update(JSON.stringify(items));
	for (const version of featureVersions.sort()) hash.update(version);
	for (const file of [join(root, "package.json"), join(root, "omp-plugins.lock.json"), join(root, "bun.lock"), getProjectPluginOverridesPath(process.cwd())]) hash.update(await bytes(file));
	const market = await marketplace.state(); hash.update(market.version);
	return { root, version: hash.digest("hex"), items, marketplace: market.view };
}
async function plan(input: Record<string, unknown>): Promise<UiOmpPackagePlan> {
	if (!operations.includes(input.operation as OmpPackageOperation) || typeof input.target !== "string" || !input.target.trim() || input.target.length > 2048 || /[\x00-\x1f]/.test(input.target)) throw new PackageError("invalid");
	const operation = input.operation as OmpPackageOperation;
	let target = input.target.trim();
	// Credentials in URLs would otherwise persist in previews, manifests and jobs.
	if (/:\/\/[^/]*@|:\/\/.*\?/.test(target)) throw new PackageError("invalid");
	const snapshot = await state();
	if (input.expectedVersion !== undefined && input.expectedVersion !== snapshot.version) throw new PackageError("conflict");
	if (marketplaceOperations.includes(operation)) return marketplace.preview(operation, target, input.scope, snapshot.version, input.selectedFeatures);
	if (input.scope !== undefined) throw new PackageError("invalid");
	if (operation !== "features" && input.selectedFeatures !== undefined) throw new PackageError("invalid");
	if (operation === "install") await manager.install(target, { dryRun: true });
	else if (operation === "link") {
		target = await realpath(target);
		const manifest = await readFile(join(target, "package.json"), "utf8");
		const pkg = JSON.parse(manifest);
		if (!isRecord(pkg) || typeof pkg.name !== "string") throw new PackageError("invalid");
		await manager.install(pkg.name, { dryRun: true });
		// Native link replaces the destination recursively. Never link over an
		// installed package or a directory inside its own runtime directory.
		const destination = join(getPluginsNodeModules(), pkg.name);
		if (snapshot.items.some(item => item.name === pkg.name) || target === destination || target.startsWith(destination + "/") || target.startsWith(destination + "\\") || destination.startsWith(target + "/") || destination.startsWith(target + "\\")) throw new PackageError("invalid");
		try { await lstat(destination); throw new PackageError("invalid"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		snapshot.version = createHash("sha256").update(snapshot.version).update(manifest).digest("hex");
	} else {
		if (!snapshot.items.some(item => item.name === target)) throw new PackageError("invalid");
		if (operation === "update") await manager.validateUpgrade(target);
	}
	const result: UiOmpPackagePlan = { operation, target, root, version: snapshot.version };
	if (operation === "features") result.selectedFeatures = validatePackageFeatures(input.selectedFeatures, snapshot.items.find(item => item.name === target)!.featureConfig!);
	return result;
}
let result: unknown;
const releases: (() => Promise<void>)[] = [];
async function lock(directory: string) {
	await mkdir(directory, { recursive: true });
	try { releases.push(await lockfile.lock(join(directory, "harness-package-management"), { realpath: false, stale: 60_000, retries: 0 })); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new PackageError("busy"); throw error; }
}
try {
	let raw = "";
	for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 16384) throw new PackageError("invalid"); }
	const input: unknown = JSON.parse(raw);
	if (!isRecord(input)) throw new PackageError("invalid");
	marketplace = await OmpMarketplacePackages.create(process.cwd(), root);
	if (input.action === "list") result = { ok: true, data: await state() };
	else if (input.action === "settings-read" || input.action === "settings-save") {
		if (input.settingsScope !== "user" && input.settingsScope !== "project") throw new PackageError("invalid");
		if (input.action === "settings-save") await lock(root);
		const path = input.scope !== undefined ? await marketplace.settingsPackage(input.target, input.scope) : (await manager.list()).find(item => item.name === input.target)?.path;
		if (!path) throw new PackageError("invalid");
		try {
			result = { ok: true, data: input.action === "settings-read" ? (await packageSettings(path, root, process.cwd(), input.settingsScope)).view : await savePackageSettings(path, root, process.cwd(), input.settingsScope, input.expectedVersion, input.patch) };
		} catch (error) { throw new PackageError(error instanceof Error && error.message === "conflict" ? "conflict" : "invalid"); }
	}
	else if (input.action === "preview") result = { ok: true, data: await plan(input) };
	else if (input.action === "execute" && isRecord(input.plan)) {
		await lock(root);
		let next = await plan(input.plan);
		if (JSON.stringify(next) !== JSON.stringify(input.plan)) throw new PackageError("conflict");
		const extra = await marketplace.extraLock(next);
		if (extra && extra !== root) {
			await lock(extra);
			next = await plan(input.plan);
			if (JSON.stringify(next) !== JSON.stringify(input.plan)) throw new PackageError("conflict");
		}
		if (marketplaceOperations.includes(next.operation)) await marketplace.execute(next);
		else switch (next.operation) {
			case "install": await manager.install(next.target); break;
			case "link": await manager.link(next.target); break;
			case "update": await manager.upgrade(next.target); break;
			case "remove": await manager.uninstall(next.target); break;
			case "enable": await manager.setEnabled(next.target, true); break;
			case "disable": await manager.setEnabled(next.target, false); break;
			case "features": await manager.setEnabledFeatures(next.target, next.selectedFeatures!); break;
		}
		result = { ok: true };
	} else throw new PackageError("invalid");
} catch (error) {
	// Native errors/logs can include registry authentication and arbitrary factory
	// output. Keep them out of browser responses and persisted job records.
	result = { ok: false, error: error instanceof PackageError ? error.code : "native" };
} finally { for (const release of releases.reverse()) await release(); }
await writeFile(process.argv[2], JSON.stringify(result), { mode: 0o600 });
// Extension validation may leave timers alive. This worker owns no chat state.
process.exit(0);
