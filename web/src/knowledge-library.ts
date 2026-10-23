import { withToken } from "./auth-token";
export interface KnowledgeLibraryConfig { cwd: string | null; path: string | null; available: boolean }
export async function knowledgeLibrary(action: "read" | "configure" | "remember", cwd?: string, path?: string | null): Promise<KnowledgeLibraryConfig> {
	const response = await fetch(withToken("/api/knowledge-library"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, cwd, path }), signal: AbortSignal.timeout(15000) });
	const result = await response.json();
	if (!response.ok) throw new Error(result.error || response.statusText);
	return result;
}
