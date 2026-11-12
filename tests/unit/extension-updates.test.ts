import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionPackage, ExtensionUpdateResult } from "../../server/protocol.js";
import { updateExtensionPackages } from "../../server/extension-updates.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const pkg = (name: string, extra: Partial<ExtensionPackage> = {}): ExtensionPackage => ({ id: `user:npm:${name}`, source: `npm:${name}`, name, kind: "npm", scope: "user", enabled: true, pinned: false, trusted: true, resources: { extensions: [], skills: [], prompts: [], themes: [] }, ...extra });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-update-result-")); roots.push(root);
	return (item: ExtensionPackage, run: (emit: NonNullable<Parameters<DefaultPackageManager["setProgressCallback"]>[0]>, setVersion: (version: string) => void) => Promise<void>) => {
		const path = join(root, item.name); mkdirSync(path, { recursive: true });
		const setVersion = (version: string) => writeFileSync(join(path, "package.json"), JSON.stringify({ name: item.name, version }));
		setVersion("1.0.0");
		const manager = new DefaultPackageManager({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory() });
		vi.spyOn(manager, "getInstalledPath").mockReturnValue(path);
		let emit: NonNullable<Parameters<DefaultPackageManager["setProgressCallback"]>[0]> = () => {};
		vi.spyOn(manager, "setProgressCallback").mockImplementation(callback => { emit = callback ?? (() => {}); });
		vi.spyOn(manager, "update").mockImplementation(async () => run(emit, setVersion));
		return manager;
	};
}
describe("native package update outcomes", () => {
	it("reports actual installed versions and continues after a package failure", async () => {
		const make = fixture(), items = [pkg("changed"), pkg("broken"), pkg("same")];
		const managers = [
			make(items[0], async (emit, setVersion) => { setVersion("1.1.0"); emit({ type: "result", action: "update", source: items[0].source, message: "npm:changed 1.0.0 -> 1.1.0" }); }),
			make(items[1], async () => { throw Error("network unavailable"); }),
			make(items[2], async () => {}),
		];
		const delivered: ExtensionUpdateResult[] = [], progress = vi.fn();
		const results = await updateExtensionPackages(items, item => managers[items.indexOf(item)], async () => {}, progress, result => delivered.push(result), false);
		expect(results.map(result => result.status)).toEqual(["updated", "error", "unchanged"]);
		expect(results[0]).toMatchObject({ from: "1.0.0", to: "1.1.0" });
		expect(results[1].message).toBe("network unavailable");
		expect(progress).toHaveBeenCalledWith("result: npm:changed 1.0.0 -> 1.1.0");
		expect(delivered).toEqual(results);
		expect(managers[2].update).toHaveBeenCalledWith("npm:same");
	});
	it("retains native stale-metadata warnings instead of claiming success", async () => {
		const item = pkg("stale"), manager = fixture()(item, async emit => {
			emit({ type: "progress", action: "update", source: item.source, message: "npm:stale is still 1.0.0 (registry reports 1.1.0)" });
		});
		const [result] = await updateExtensionPackages([item], () => manager, async () => {}, () => {}, () => {}, false);
		expect(result).toMatchObject({ status: "warning", from: "1.0.0", to: "1.0.0" });
		expect(result.message).toContain("registry reports");
	});
	it("records files changed before an update's dependency step failed", async () => {
		const item = pkg("partially-written"), manager = fixture()(item, async (_emit, setVersion) => {
			setVersion("1.1.0"); throw Error("dependency build failed");
		});
		const [result] = await updateExtensionPackages([item], () => manager, async () => {}, () => {}, () => {}, false);
		expect(result).toMatchObject({ status: "error", from: "1.0.0", to: "1.1.0", message: "dependency build failed" });
	});
	it("does not probe commands or update offline, pinned, protected, local or untrusted packages", async () => {
		const items = [pkg("offline"), pkg("pin", { pinned: true }), pkg("app", { protected: true }), pkg("project", { scope: "project", trusted: false }), pkg("local", { kind: "local" })];
		const manager = vi.fn(), requireTools = vi.fn();
		const results = await updateExtensionPackages(items, manager, requireTools, () => {}, () => {}, true);
		expect(results.map(result => result.reason)).toEqual(["offline", "pinned", "protected", "untrusted", "local"]);
		expect(results.every(result => result.status === "skipped")).toBe(true);
		expect(manager).not.toHaveBeenCalled(); expect(requireTools).not.toHaveBeenCalled();
	});
});
