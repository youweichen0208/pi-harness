import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { KnowledgeLibrary } from "../knowledge-library.js";
import { ProjectWorkspaceStore } from "../project-workspaces.js";
import type { ProjectWorkspaceCatalog } from "../protocol.js";

export interface SubagentSource {
	id: string;
	kind: "repository" | "knowledge";
	name: string;
	root: string;
}

export interface SubagentSources {
	workspace?: { id: string; name: string };
	/** Groups containing this conversation's cwd, never an implicit union. */
	workspaces: { id: string; name: string }[];
	sources: SubagentSource[];
	issue?: "ambiguous_workspace" | "workspace_unavailable" | "workspace_mismatch";
}

type SourceState = {
	catalog: ProjectWorkspaceCatalog;
	library: { cwd: string | null; available: boolean };
};

function source(kind: SubagentSource["kind"], path: string): SubagentSource {
	if (!isAbsolute(path)) throw new Error("Subagent sources require absolute paths");
	const root = resolve(path);
	const identity = createHash("sha256").update(JSON.stringify([kind, root])).digest("hex");
	return { id: `${kind}:${identity}`, kind, name: basename(root) || root, root };
}

/** Resolve registered sources without reading them. Missing directories remain
 * listed so execution can report their failure instead of silently omitting
 * evidence. Workspace membership is explicit; recent projects are not sources. */
export function resolveSubagentSources(
	{ cwd, workspaceId }: { cwd: string; workspaceId?: string },
	{ catalog, library }: SourceState,
): SubagentSources {
	const current = source("repository", cwd);
	const candidates = catalog.workspaces.filter(group => group.paths.some(path => isAbsolute(path) && resolve(path) === current.root));
	const selected = workspaceId ? catalog.workspaces.find(group => group.id === workspaceId) : candidates.length === 1 ? candidates[0] : undefined;
	const workspace = selected && candidates.includes(selected) ? selected : undefined;
	const issue = workspaceId && !selected ? "workspace_unavailable"
		: selected && !workspace ? "workspace_mismatch"
			: !workspaceId && candidates.length > 1 ? "ambiguous_workspace" : undefined;
	const sources = new Map<string, SubagentSource>([[current.id, current]]);
	for (const root of workspace?.paths ?? []) {
		const entry = source("repository", root);
		sources.set(entry.id, entry);
	}
	if (library.available && library.cwd) {
		const entry = source("knowledge", library.cwd);
		sources.set(entry.id, entry);
	}
	return {
		...(workspace ? { workspace: { id: workspace.id, name: workspace.name } } : {}),
		workspaces: candidates.map(({ id, name }) => ({ id, name })),
		sources: [...sources.values()],
		...(issue ? { issue } : {}),
	};
}

/** Match the main server's data directory and shared desktop/CLI catalog. */
export function readSubagentSources(cwd: string, workspaceId?: string): SubagentSources {
	const dataDir = resolve(process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
	const catalogFile = resolve(process.env.PI_WEB_WORKSPACES_FILE || join(dataDir, "project-workspaces.json"));
	return resolveSubagentSources({ cwd, workspaceId }, {
		catalog: new ProjectWorkspaceStore(catalogFile).read(),
		library: new KnowledgeLibrary(dataDir).read(),
	});
}
