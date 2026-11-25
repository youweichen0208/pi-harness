import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { KnowledgeLibrary } from "./knowledge-library.js";
import type { ProjectWorkspaceCatalog } from "./protocol.js";
import type { KnowledgeEvidence, KnowledgeScope, KnowledgeSource, KnowledgeSourceKind } from "./knowledge-requests.js";

const exec = promisify(execFile);

export interface KnowledgeSourceState {
	catalog: ProjectWorkspaceCatalog;
	library: ReturnType<KnowledgeLibrary["read"]>;
}

export interface WorkspaceScopeResult {
	candidates: { id: string; name: string }[];
	issue?: "ambiguous_workspace" | "workspace_unavailable" | "workspace_mismatch";
	scope: KnowledgeScope;
}

export class KnowledgeScopeError extends Error {
	constructor(message: string, readonly sources: KnowledgeSource[] = []) {
		super(message);
		this.name = "KnowledgeScopeError";
	}
}

export function knowledgeSource(kind: KnowledgeSourceKind, path: string): KnowledgeSource {
	if (!isAbsolute(path)) throw new KnowledgeScopeError("Knowledge sources require absolute paths");
	const root = resolve(path);
	const id = createHash("sha256").update(JSON.stringify([kind, root])).digest("hex");
	return { id: `${kind}:${id}`, kind, name: basename(root) || root, root };
}

function samePath(left: string, right: string): boolean {
	const a = resolve(left), b = resolve(right);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function groupContains(group: ProjectWorkspaceCatalog["workspaces"][number], cwd: string): boolean {
	return group.paths.some(path => isAbsolute(path) && samePath(path, cwd));
}

export function resolveWorkspaceScope(
	{ cwd, workspaceId }: { cwd: string; workspaceId?: string },
	state: KnowledgeSourceState,
): WorkspaceScopeResult {
	const current = knowledgeSource("repository", cwd);
	const candidates = state.catalog.workspaces.filter(group => groupContains(group, cwd));
	const selected = workspaceId ? state.catalog.workspaces.find(group => group.id === workspaceId) : candidates.length === 1 ? candidates[0] : undefined;
	const workspace = selected && candidates.includes(selected) ? selected : undefined;
	const issue = workspaceId && !selected ? "workspace_unavailable"
		: selected && !workspace ? "workspace_mismatch"
			: !workspaceId && candidates.length > 1 ? "ambiguous_workspace" : undefined;
	const sources = new Map<string, KnowledgeSource>([[current.id, current]]);
	for (const root of workspace?.paths ?? []) {
		const entry = knowledgeSource("repository", root);
		sources.set(entry.id, entry);
	}
	if (state.library.available && state.library.cwd) {
		const entry = knowledgeSource("knowledge", state.library.cwd);
		sources.set(entry.id, entry);
	}
	const all = [...sources.values()];
	return {
		candidates: candidates.map(({ id, name }) => ({ id, name })),
		...(issue ? { issue } : {}),
		scope: {
			requestCwd: current.root,
			workspaceId: workspace?.id,
			workspaceSourceIds: all.map(entry => entry.id),
			sourceIds: all.map(entry => entry.id),
			sources: all,
		},
	};
}

function clauseSources(clause: string, scope: KnowledgeScope): KnowledgeSource[] {
	let remaining = clause.toLowerCase();
	const matches = new Map<string, KnowledgeSource>();
	// Consume full IDs and longest names first so "app-server" cannot grant access to "app".
	for (const entry of scope.sources) {
		if (remaining.includes(entry.id.toLowerCase())) {
			matches.set(entry.id, entry);
			remaining = remaining.replaceAll(entry.id.toLowerCase(), " ");
		}
	}
	const names = [...new Set(scope.sources.map(entry => entry.name.toLowerCase()))].sort((a, b) => b.length - a.length);
	for (const name of names) {
		if (!remaining.includes(name)) continue;
		const candidates = scope.sources.filter(entry => entry.name.toLowerCase() === name);
		if (candidates.length > 1) throw new KnowledgeScopeError(`来源名称“${name}”有歧义，请选择具体目录`, candidates);
		matches.set(candidates[0].id, candidates[0]);
		remaining = remaining.replaceAll(name, " ");
	}
	const library = scope.sources.find(entry => entry.kind === "knowledge");
	if (library && /知识库|\bknowledge(?:\s+base)?\b/i.test(remaining)) matches.set(library.id, library);
	return [...matches.values()];
}

function checkRemainder(clause: string, matches: KnowledgeSource[]): void {
	let remainder = clause;
	for (const entry of [...matches].sort((a, b) => b.name.length - a.name.length)) {
		remainder = remainder.replaceAll(entry.id, "").replace(new RegExp(entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "");
	}
	remainder = remainder
		.replace(/知识库|数据库|knowledge\s+base|knowledge|代码仓|源码|代码|仓库|项目|文档|资料/gi, "")
		.replace(/只|仅|查看|查询|检索|读取|使用|看|查|基于|根据|不要|不|排除|only|just|read|search|inspect|use|check|exclude|do\s+not|don't/gi, "")
		.replace(/\b(?:and|or)\b/gi, "").replace(/[\s,，、和与及以及或]+/g, "");
	if (/[\p{L}\p{N}_.\\/:-]/u.test(remainder)) throw new KnowledgeScopeError(`无法确定限定来源：${clause.trim()}，请使用登记名称或 sourceId`);
}

function requestClauses(text: string): { includes: string[]; excludes: string[] } {
	const includes: string[] = [], excludes: string[] = [];
	const includePatterns = [
		/(?:^|[，,。；;！？!?：:\s])(?:请(?:你)?\s*)?(?:只|仅)(?:是)?(?:查看|查询|检索|读取|使用|看|查|基于|根据)?\s*([^，,。；;：！？!?]+)/gi,
		/\b(?:only|just)\s+(?:read|search|inspect|use|check)?\s*([^,.;]+)/gi,
	];
	const excludePatterns = [
		/(?:不要|不)(?:查看|查询|检索|读取|使用|看|查)\s*([^，,。；;：！？!?]+)/gi,
		/\b(?:exclude|do\s+not\s+read|don't\s+read)\s+([^,.;]+)/gi,
	];
	for (const pattern of includePatterns) for (const match of text.matchAll(pattern)) if (match[1]?.trim()) includes.push(match[1].trim());
	for (const pattern of excludePatterns) for (const match of text.matchAll(pattern)) if (match[1]?.trim()) excludes.push(match[1].trim());
	return { includes, excludes };
}

export function resolveRequestScope(text: string, workspace: KnowledgeScope): KnowledgeScope {
	const { includes, excludes } = requestClauses(text);
	if (!includes.length && !excludes.length) return workspace;
	const included = new Set<string>(), excluded = new Set<string>();
	for (const clause of includes) {
		const matches = clauseSources(clause, workspace);
		if (!matches.length) throw new KnowledgeScopeError(`无法确定限定来源：${clause}`);
		checkRemainder(clause, matches);
		for (const entry of matches) included.add(entry.id);
	}
	for (const clause of excludes) {
		const matches = clauseSources(clause, workspace);
		if (!matches.length) throw new KnowledgeScopeError(`无法确定排除来源：${clause}`);
		checkRemainder(clause, matches);
		for (const entry of matches) excluded.add(entry.id);
	}
	const sourceIds = (included.size ? [...included] : workspace.sourceIds).filter(id => !excluded.has(id));
	if (!sourceIds.length) throw new KnowledgeScopeError("限定后来源为空，请调整检索范围");
	const ids = new Set(sourceIds);
	return { ...workspace, sourceIds, sources: workspace.sources.filter(entry => ids.has(entry.id)) };
}

export function assertKnowledgeSourceAccess(
	scope: KnowledgeScope,
	sourceId: string,
	state: KnowledgeSourceState,
): KnowledgeSource {
	if (!scope.sourceIds.includes(sourceId)) throw new KnowledgeScopeError("该来源不在本次请求允许的范围内");
	const current = resolveWorkspaceScope({ cwd: scope.requestCwd, workspaceId: scope.workspaceId }, state);
	if (current.issue) throw new KnowledgeScopeError("当前 Workspace 已改变，原知识请求范围失效");
	const source = current.scope.sources.find(entry => entry.id === sourceId);
	if (!source || !scope.workspaceSourceIds.includes(sourceId)) throw new KnowledgeScopeError("来源已移除或不再属于当前 Workspace");
	const configured = scope.sources.find(entry => entry.id === sourceId);
	if (!configured || (source.kind === "knowledge" && state.library.cwd !== source.root)) throw new KnowledgeScopeError("知识库已改变，原授权失效");
	return source;
}

export function assertKnowledgeEvidenceAccess(
	evidence: KnowledgeEvidence,
	conversationId: string,
	cwd: string,
	state: KnowledgeSourceState,
): KnowledgeSource {
	if (evidence.conversationId !== conversationId || !samePath(evidence.requestCwd, cwd)) throw new KnowledgeScopeError("证据所属项目或对话已改变");
	if (!evidence.scopeSourceIds.includes(evidence.source.id)) throw new KnowledgeScopeError("证据不在原请求范围内");
	const current = resolveWorkspaceScope({ cwd, workspaceId: evidence.workspaceId }, state);
	if (current.issue) throw new KnowledgeScopeError("证据所属 Workspace 已不可用");
	const source = current.scope.sources.find(entry => entry.id === evidence.source.id);
	if (!source || (source.kind === "knowledge" && state.library.cwd !== source.root)) throw new KnowledgeScopeError("证据来源已移除或知识库已改变");
	return source;
}

export async function gitFileEvidence(root: string, path: string): Promise<{ revision?: string; workingTree: KnowledgeEvidence["workingTree"] }> {
	try {
		const options = { cwd: root, timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } };
		const [head, status] = await Promise.all([
			exec("git", ["rev-parse", "--verify", "HEAD"], options),
			exec("git", ["status", "--porcelain=v1", "--", path], options),
		]);
		const state = status.stdout.trim();
		return { revision: head.stdout.trim() || undefined, workingTree: !state ? "clean" : state.startsWith("??") ? "untracked" : "modified" };
	} catch {
		return { workingTree: "unknown" };
	}
}

export function canonicalSourceRoot(root: string): string {
	return realpathSync(root);
}
