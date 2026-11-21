import type { ProjectSummary, ProjectWorkspaceCatalog } from "../../server/protocol.js";

// Keep this window's selection separate from another tab's localStorage writes.
let selectedWorkspace: string | undefined;
export const PROJECT_WORKSPACE_SELECTION_EVENT = "pi-harness:project-workspace-selection";
export function selectedProjectWorkspace(): string {
	if (selectedWorkspace === undefined) {
		try { selectedWorkspace = localStorage.getItem("pi-harness:project-workspace") ?? ""; } catch { selectedWorkspace = ""; }
	}
	return selectedWorkspace;
}
export function selectProjectWorkspace(id: string): void {
	selectedWorkspace = id;
	try { localStorage.setItem("pi-harness:project-workspace", id); } catch { /* optional preference */ }
	if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PROJECT_WORKSPACE_SELECTION_EVENT, { detail: id }));
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
