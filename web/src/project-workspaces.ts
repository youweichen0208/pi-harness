import type { ClientMessage, ProjectSummary, ProjectWorkspaceCatalog } from "../../server/protocol.js";

// Keep this window's selection separate from another tab's localStorage writes.
let selectedWorkspace: string | undefined;
export function selectedProjectWorkspace(): string {
	if (selectedWorkspace === undefined) {
		try { selectedWorkspace = localStorage.getItem("pi-harness:project-workspace") ?? ""; } catch { selectedWorkspace = ""; }
	}
	return selectedWorkspace;
}
export function selectProjectWorkspace(id: string): void {
	selectedWorkspace = id;
	try { localStorage.setItem("pi-harness:project-workspace", id); } catch { /* optional preference */ }
}

type PromptTarget = NonNullable<Extract<ClientMessage, { type: "prompt" }>["target"]>;

/** Validate the captured selection against the catalog available at send time. */
export function promptWorkspaceTarget(target: PromptTarget, catalog: ProjectWorkspaceCatalog | null): PromptTarget {
	// Unknown membership is not a mismatch. Preserve the click-time scope while
	// the catalog loads; the server revalidates it against registered sources.
	if (!catalog) return target;
	const group = catalog.workspaces.find(group => group.id === target.workspaceId && group.paths.includes(target.cwd));
	return { ...target, workspaceId: group?.id };
}

/** Catalog membership survives eviction from the recent-project list. */
export function workspaceProjects(projects: ProjectSummary[], catalog: ProjectWorkspaceCatalog | null, selectedId: string, query: string): ProjectSummary[] {
	const all = new Map(projects.map((project) => [project.path, project]));
	for (const group of catalog?.workspaces ?? []) {
		for (const path of group.paths) {
			if (!all.has(path)) all.set(path, { path, firstAdded: 0, lastUsed: 0 });
		}
	}
	const group = catalog?.workspaces.find((entry) => entry.id === selectedId);
	if (!group) return [];
	const members = new Set(group.paths);
	const needle = query.trim().toLowerCase();
	return [...all.values()].filter((project) => members.has(project.path) && project.path.toLowerCase().includes(needle));
}
