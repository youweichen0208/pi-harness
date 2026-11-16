/** Bun-only adapter for OMP's public MarketplaceManager and discovery rules. */
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
	MarketplaceManager, getMarketplacesRegistryPath, getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir, getPluginsCacheDir, getProjectRegistriesIndexPath,
	classifySource, fetchMarketplace, buildPluginId, parsePluginId, parseMarketplaceCatalog, validatePluginSource, nameSegmentCollisionKey,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/index";
import { resolveOrDefaultProjectRegistryPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { expandTilde } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { readPackageFeatures, validatePackageFeatures, writeProjectPackageFeatures } from "./package-features.js";
import type { UiOmpMarketplaceState, UiOmpPackagePlan, OmpPackageOperation, OmpPackageScope } from "../protocol.js";

export const marketplaceOperations: OmpPackageOperation[] = ["marketplace-add", "marketplace-refresh", "marketplace-remove", "plugin-install", "plugin-update", "plugin-remove", "plugin-enable", "plugin-disable", "plugin-features"];
export function displayPackageSource(value: string): string {
	try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
	catch { return value; }
}
async function bytes(path: string) {
	try { return await readFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0); throw error; }
}

export class OmpMarketplacePackages {
	private constructor(private root: string, private manager: MarketplaceManager, private registry: string, private installedRegistry: string, private projectRegistry?: string) {}
	static async create(cwd: string, root: string) {
		const registry = getMarketplacesRegistryPath(), installed = getInstalledPluginsRegistryPath(), project = await resolveOrDefaultProjectRegistryPath(cwd);
		return new OmpMarketplacePackages(root, new MarketplaceManager({ marketplacesRegistryPath: registry, installedRegistryPath: installed, projectInstalledRegistryPath: project, marketplacesCacheDir: getMarketplacesCacheDir(), pluginsCacheDir: getPluginsCacheDir() }), registry, installed, project);
	}
	async settingsPackage(target: unknown, scope: unknown) {
		if (typeof target !== "string" || (scope !== "user" && scope !== "project")) throw Error("Invalid package selection");
		const plugin = (await this.manager.listInstalledPlugins()).find(item => item.id === target && item.scope === scope);
		if (plugin?.entries.length !== 1) throw Error("Package unavailable");
		return plugin.entries[0].installPath;
	}
	async state(): Promise<{ view: UiOmpMarketplaceState; version: string }> {
		const entries = await this.manager.listMarketplaces();
		const marketplaces: UiOmpMarketplaceState["marketplaces"] = [];
		for (const entry of entries) {
			try {
				const plugins = await this.manager.listAvailablePlugins(entry.name);
				marketplaces.push({ name: entry.name, source: displayPackageSource(entry.sourceUri), available: true, plugins: plugins.map(plugin => ({ id: buildPluginId(plugin.name, entry.name), name: plugin.name, version: plugin.version, description: plugin.description?.slice(0, 2048) })) });
			} catch { marketplaces.push({ name: entry.name, source: displayPackageSource(entry.sourceUri), available: false, plugins: [] }); }
		}
		const featureVersions: string[] = [];
		const installed = await Promise.all((await this.manager.listInstalledPlugins()).map(async plugin => {
			let featureConfig: UiOmpMarketplaceState["installed"][number]["featureConfig"];
			if (plugin.entries.length === 1) {
				const runtimeRoot = plugin.scope === "project" && this.projectRegistry ? dirname(this.projectRegistry) : this.root;
				try {
					const features = await readPackageFeatures(plugin.entries[0].installPath, runtimeRoot, process.cwd());
					featureConfig = features.view; featureVersions.push(features.version);
				} catch { /* A broken package must remain removable. Feature editing is unavailable. */ }
			}
			return { id: plugin.id, scope: plugin.scope, versions: plugin.entries.map(entry => entry.version), paths: plugin.entries.map(entry => entry.installPath), enabled: plugin.entries[0]?.enabled !== false, shadowed: plugin.shadowedBy === "project", featureConfig };
		}));
		const view: UiOmpMarketplaceState = { projectRoot: this.projectRegistry ? dirname(this.projectRegistry) : undefined, marketplaces, installed };
		const hash = createHash("sha256").update(JSON.stringify(view));
		for (const version of featureVersions.sort()) hash.update(version);
		const files = [this.registry, this.installedRegistry, getProjectRegistriesIndexPath(this.installedRegistry), ...entries.map(entry => entry.catalogPath)];
		if (this.projectRegistry) files.push(this.projectRegistry, join(dirname(this.projectRegistry), "omp-plugins.lock.json"), join(dirname(this.projectRegistry), "package.json"));
		for (const file of files) {
			try { const data = await bytes(file); hash.update(file).update(String(data.length)).update(data); }
			catch (error) { hash.update(file).update(String((error as NodeJS.ErrnoException).code)); }
		}
		return { view, version: hash.digest("hex") };
	}
	async preview(operation: OmpPackageOperation, target: string, scope: unknown, version: string, selectedFeatures?: unknown): Promise<UiOmpPackagePlan> {
		if (operation !== "plugin-features" && selectedFeatures !== undefined) throw Error("Unexpected feature selection");
		let selection: string[] | null | undefined;
		let source: string | undefined, fromVersion: string | undefined, toVersion: string | undefined;
		let root = this.root;
		if (operation.startsWith("plugin-")) {
			if (scope !== "user" && scope !== "project") throw Error("Invalid marketplace scope");
			if (scope === "project") { if (!this.projectRegistry) throw Error("Project scope unavailable"); root = dirname(this.projectRegistry); }
			const id = parsePluginId(target); if (!id) throw Error("Invalid plugin ID");
			const entries = await this.manager.listMarketplaces();
			const marketplace = entries.find(entry => entry.name === id.marketplace);
			source = marketplace?.sourceUri;
			if (source) source = displayPackageSource(source);
			if (operation === "plugin-install") await this.manager.validateInstallPlugin(id.name, id.marketplace, { scope });
			else if (operation === "plugin-update") {
				const rows = await this.manager.previewUpgradePlugin(target, scope);
				fromVersion = rows[0]?.from; toVersion = rows[0]?.to;
			} else {
				const installed = await this.manager.listInstalledPlugins();
				if (!installed.some(plugin => plugin.id === target && plugin.scope === scope)) throw Error("Plugin unavailable in requested scope");
				if (operation === "plugin-remove") await this.manager.uninstallPlugin(target, scope, { dryRun: true });
				if (operation === "plugin-features") {
					const entry = installed.find(plugin => plugin.id === target && plugin.scope === scope)!;
					if (entry.entries.length !== 1) throw Error("Ambiguous installed package version");
					selection = validatePackageFeatures(selectedFeatures, (await readPackageFeatures(entry.entries[0].installPath, root, process.cwd())).view);
				}
			}
			if (marketplace && (operation === "plugin-install" || operation === "plugin-update")) {
				const catalog = parseMarketplaceCatalog((await bytes(marketplace.catalogPath)).toString("utf8"), marketplace.catalogPath);
				const plugin = catalog.plugins.find(entry => entry.name === id.name);
				if (!plugin) throw Error("Plugin unavailable");
				const local = await validatePluginSource(plugin, { marketplaceClonePath: marketplace.sourceType === "local" ? expandTilde(marketplace.sourceUri) : dirname(marketplace.catalogPath), catalogMetadata: catalog.metadata });
				if (local) {
					const hash = createHash("sha256").update(version);
					for (const file of [join(local, "package.json"), join(local, ".claude-plugin/plugin.json")]) hash.update(file).update(await bytes(file));
					version = hash.digest("hex");
				}
				if (operation === "plugin-install") toVersion = plugin.version;
			}
		} else {
			if (scope !== undefined) throw Error("Marketplace catalogs are user scoped");
			if (operation === "marketplace-add") {
				const kind = classifySource(target);
				if (kind === "local") {
					target = await realpath(expandTilde(target));
					const fetched = await fetchMarketplace(target, getMarketplacesCacheDir());
					if ((await this.manager.listMarketplaces()).some(entry => nameSegmentCollisionKey(entry.name) === nameSegmentCollisionKey(fetched.catalog.name))) throw Error("Marketplace already registered");
					version = createHash("sha256").update(version).update(JSON.stringify(fetched.catalog)).digest("hex");
				}
				source = displayPackageSource(target);
			} else {
				const entry = (await this.manager.listMarketplaces()).find(entry => entry.name === target);
				if (!entry) throw Error("Marketplace unavailable");
				source = displayPackageSource(entry.sourceUri);
			}
		}
		return { operation, target, root, version, ...(scope ? { scope: scope as OmpPackageScope, ...(operation !== "plugin-features" ? { sharedRoot: this.root } : {}) } : {}), ...(source ? { source } : {}), ...(fromVersion ? { fromVersion } : {}), ...(toVersion ? { toVersion } : {}), ...(selection !== undefined ? { selectedFeatures: selection } : {}) };
	}
	/** Native same-version cache replacement can also update the other scope. */
	async extraLock(plan: UiOmpPackagePlan): Promise<string | undefined> {
		if (!this.projectRegistry || !plan.operation.startsWith("plugin-")) return;
		if (plan.scope === "project") return dirname(this.projectRegistry);
		const installed = await this.manager.listInstalledPlugins();
		if (installed.some(plugin => plugin.id === plan.target && plugin.scope === "project")) {
			try { await stat(dirname(this.projectRegistry)); return dirname(this.projectRegistry); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	}
	async execute(plan: UiOmpPackagePlan) {
		const id = parsePluginId(plan.target);
		switch (plan.operation) {
			case "marketplace-add": await this.manager.addMarketplace(plan.target); break;
			case "marketplace-refresh": await this.manager.updateMarketplace(plan.target); break;
			case "marketplace-remove": await this.manager.removeMarketplace(plan.target); break;
			case "plugin-install": if (!id) throw Error("Invalid plugin ID"); await this.manager.installPlugin(id.name, id.marketplace, { scope: plan.scope }); break;
			case "plugin-update": await this.manager.upgradePlugin(plan.target, plan.scope); break;
			case "plugin-remove": await this.manager.uninstallPlugin(plan.target, plan.scope); break;
			case "plugin-enable": await this.manager.setPluginEnabled(plan.target, true, plan.scope); break;
			case "plugin-disable": await this.manager.setPluginEnabled(plan.target, false, plan.scope); break;
			case "plugin-features": {
				const plugin = (await this.manager.listInstalledPlugins()).find(plugin => plugin.id === plan.target && plugin.scope === plan.scope);
				if (plugin?.entries.length !== 1) throw Error("Plugin unavailable");
				const path = plugin.entries[0].installPath;
				if (plan.scope === "project") await writeProjectPackageFeatures(path, plan.root, process.cwd(), plan.selectedFeatures);
				else await new PluginManager(process.cwd()).setEnabledFeatures((await readPackageFeatures(path, this.root, process.cwd())).name, plan.selectedFeatures!);
				break;
			}
			default: throw Error("Unsupported marketplace operation");
		}
	}
}
