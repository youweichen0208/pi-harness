/**
 * Wiki mode 独立窗口（ADR-0003）：进入 Wiki mode 打开一个独立顶层窗口，
 * 主窗口停留在 normal 对话，两边可以并行工作。
 *
 * URL 即窗口契约：`/?wiki-window=1&cwd=<工作区>&doc=<文档相对路径>&client=<id>`。
 * 鉴权 token 存于 localStorage，同源窗口自动继承，URL 不携带。
 * client 参数是窗口级客户端 ID：Chromium 的 window.open 会克隆 opener 的
 * sessionStorage（沿用主窗口 clientId 会让两个窗口镜像同一 ClientSession，
 * issue #10），所以打开方生成新 id 随 URL 传入；刷新 URL 不变，会话可挂回。
 *
 * 本模块同时被 tests tsconfig（无 DOM lib）类型检查，window 一律经 globalThis 访问。
 */

import { randomUuid } from "./uuid.js";

/** 浏览器端 window.open 的命名目标：重复进入复用同一窗口（导航到新文档）。 */
const WIKI_WINDOW_NAME = "pi-wiki";

/** 解析 URL 查询串中的 wiki 窗口参数（纯函数，供启动判断与单测）。 */
export function parseWikiWindowParams(search: string): { wikiWindow: boolean; cwd: string | null; doc: string | null; client: string | null; model: string | null; thinking: string | null } {
	try {
		const params = new URLSearchParams(search);
		return {
			wikiWindow: params.get("wiki-window") === "1",
			cwd: params.get("cwd"),
			doc: params.get("doc"),
			client: params.get("client"),
			model: params.get("model"),
			thinking: params.get("thinking"),
		};
	} catch {
		return { wikiWindow: false, cwd: null, doc: null, client: null, model: null, thinking: null };
	}
}

/** 当前页面的查询串；非浏览器环境（单测）返回空串。 */
function currentSearch(): string {
	const location = (globalThis as { location?: { search?: unknown } }).location;
	return typeof location?.search === "string" ? location.search : "";
}

/** 当前页面是否是 Wiki 独立窗口（模块加载时解析一次，随页面生命周期不变）。 */
export const isWikiWindow: boolean = parseWikiWindowParams(currentSearch()).wikiWindow;

/** Wiki 窗口 URL 携带的目标工作区与文档（非 Wiki 窗口返回空值）。 */
export function wikiWindowParams(): { cwd: string | null; doc: string | null } {
	if (!isWikiWindow) return { cwd: null, doc: null };
	const { cwd, doc } = parseWikiWindowParams(currentSearch());
	return { cwd, doc };
}

/** Wiki 窗口的窗口级客户端 ID（URL client 参数；非 Wiki 窗口或缺失时为 null）。
 * 刷新后 URL 不变，因此同一窗口刷新仍是同一客户端。 */
export function wikiWindowClient(): string | null {
	if (!isWikiWindow) return null;
	return parseWikiWindowParams(currentSearch()).client;
}

/** 打开方携带的模型与思考档位（URL 参数）：独立客户端不共享主窗口会话，
 * 常开思考的模型（如 GLM）会拒绝默认 off，Wiki 窗口自举时需先应用再建会话。 */
export function wikiWindowCarry(): { model: string | null; thinking: string | null } {
	if (!isWikiWindow) return { model: null, thinking: null };
	const { model, thinking } = parseWikiWindowParams(currentSearch());
	return { model, thinking };
}

/** 构建 Wiki 窗口 URL（同源根路径 + 查询参数；client 是窗口级客户端 ID）。 */
export function buildWikiWindowUrl(cwd: string, doc: string | null, client: string, carry?: { model?: string | null; thinking?: string | null }): string {
	const params = new URLSearchParams({ "wiki-window": "1", cwd, client });
	if (doc) params.set("doc", doc);
	if (carry?.model) params.set("model", carry.model);
	if (carry?.thinking) params.set("thinking", carry.thinking);
	return `/?${params.toString()}`;
}

/** 打开（或聚焦已打开的）Wiki 独立窗口。每次打开生成新的窗口级客户端 ID：
 * 复用窗口导航到新文档时 URL 变化，客户端随之更换，临时会话全新开始。
 * carry 传入主窗口当前的模型与思考档位，由新窗口自举时应用（跨客户端不共享会话）。 */
export function openWikiWindow(cwd: string, doc: string | null, carry?: { model?: string | null; thinking?: string | null }): void {
	const open = (globalThis as { open?: (url: string, target: string, features: string) => void }).open;
	open?.(buildWikiWindowUrl(cwd, doc, randomUuid(), carry), WIKI_WINDOW_NAME, "width=1100,height=800");
}

/** Resolve the configured folder inside the new window, leaving the opener untouched. */
export const isKnowledgeLibraryWindow = new URLSearchParams(currentSearch()).get("knowledge-library") === "1";
export function openKnowledgeLibrary(carry?: { model?: string | null; thinking?: string | null }): void {
	const open = (globalThis as { open?: (url: string, target: string, features: string) => void }).open;
	open?.(`${buildWikiWindowUrl("", null, randomUuid(), carry)}&knowledge-library=1`, WIKI_WINDOW_NAME, "width=1100,height=800");
}
