import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionPackage, ExtensionUpdateResult } from "./protocol.js";
import { gitOutput } from "./component-updates.js";

async function installedRevision(item: ExtensionPackage, manager: DefaultPackageManager): Promise<string | undefined> {
	const path = manager.getInstalledPath(item.source, item.scope);
	if (!path) return undefined;
	if (item.kind === "git") return (await gitOutput(path, ["rev-parse", "HEAD"])).trim() || undefined;
	try {
		const version: unknown = JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version;
		return typeof version === "string" ? version : undefined;
	} catch { return undefined; }
}

/** Native update owns resolution/install. Report observed outcomes, never registry/latest guesses. */
export async function updateExtensionPackages(
	items: ExtensionPackage[],
	managerFor: (item: ExtensionPackage) => DefaultPackageManager,
	requireTools: (source: string) => Promise<void>,
	progress: (message: string) => void,
	onResult: (result: ExtensionUpdateResult) => void,
	offline: boolean,
): Promise<ExtensionUpdateResult[]> {
	const results: ExtensionUpdateResult[] = [];
	for (const item of items) {
		const result: ExtensionUpdateResult = { id: item.id, name: item.name, scope: item.scope, status: "skipped" };
		const reason = item.protected ? "protected" : !item.trusted ? "untrusted" : item.pinned ? "pinned"
			: item.kind === "file" || item.kind === "local" ? "local" : offline ? "offline" : undefined;
		if (reason) result.reason = reason;
		else {
			let manager: DefaultPackageManager | undefined;
			try {
				await requireTools(item.source);
				if (item.kind === "git" && item.path && await gitOutput(item.path, ["status", "--porcelain"])) {
					throw Error(`Local changes in ${item.name}; commit or save them before updating`);
				}
				manager = managerFor(item);
				result.from = await installedRevision(item, manager);
				let nativeResult: string | undefined;
				const warnings: string[] = [];
				manager.setProgressCallback(event => {
					progress(`${event.type}: ${event.message ?? event.source}`);
					if (event.type === "result") nativeResult = event.message;
					if (event.type === "progress" && event.message) warnings.push(event.message.slice(0, 2000));
				});
				await manager.update(item.source);
				result.to = await installedRevision(item, manager);
				result.status = warnings.length ? "warning" : result.from !== result.to && result.to ? "updated"
					: result.from && result.to ? "unchanged" : "warning";
				result.message = warnings.length ? warnings.slice(-4).join("\n") : nativeResult;
				if (!result.to) result.reason = "unverified";
			} catch (error) {
				result.status = "error";
				result.message = (error instanceof Error ? error.message : String(error)).slice(0, 8000);
				// A Git reset/npm install can change files before a later dependency step fails.
				if (manager) try { result.to = await installedRevision(item, manager); } catch { /* Preserve the original failure. */ }
			}
		}
		results.push(result);
		onResult(result);
	}
	return results;
}
