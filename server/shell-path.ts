/**
 * macOS shebang PATH 兜底。
 *
 * GUI 启动（Dock / Spotlight / 访达 / launchd）不会加载 `~/.zprofile` 与
 * `~/.zshrc`——那是登录 shell 的事。于是桌面版继承到的 PATH 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`，而 Homebrew 装的 node / npm / git 都在
 * `/opt/homebrew/bin`（Apple Silicon）或 `/usr/local/bin`（Intel）。
 * 用户在 pi-harness 终端里敲 `npm` 会得到 `command not found`，而同一个用户
 * 在 Terminal.app 里明明是好的。
 *
 * 这里只补「系统标准、位置固定」的目录，**不**读 `brew shellenv`、也**不**猜
 * nvm / volta / asdf / fnm 的版本目录：这些是用户态管理器，路径随版本变化，
 * 猜错反而会把错误版本塞进 PATH。它们的正确做法仍是在 `~/.zshenv` 里导出。
 *
 * 语义：追加在末尾（绝不前置），已存在的不重复，原 PATH 的项目顺序不动——
 * 用户自己配的目录始终优先。
 */
import { delimiter, isAbsolute } from "node:path";

/** Homebrew (Apple Silicon) 与 Intel / 手工安装的标准 bin 目录，按优先级排列。 */
export const MACOS_STANDARD_BIN_DIRS = [
	"/opt/homebrew/bin",
	"/opt/homebrew/sbin",
	"/usr/local/bin",
	"/usr/local/sbin",
] as const;

/**
 * 计算补充后的 PATH。
 *
 * @param current 当前 PATH（可能为空 / undefined）
 * @param candidates 候选目录（默认 macOS 标准目录）
 * @param exists 目录存在性判定（测试注入用）
 * @returns 新的 PATH 字符串；无需补充时原样返回入参
 */
export function withStandardBinDirs(
	current: string | undefined,
	candidates: readonly string[] = MACOS_STANDARD_BIN_DIRS,
	exists: (dir: string) => boolean = () => true,
): string {
	const path = current ?? "";
	const present = new Set(path.split(delimiter).filter(Boolean));
	const missing = candidates.filter(dir => isAbsolute(dir) && !present.has(dir) && exists(dir));
	if (missing.length === 0) return path;
	return path ? `${path}${delimiter}${missing.join(delimiter)}` : missing.join(delimiter);
}

/**
 * 就地为 `process.env` 补 macOS 标准 bin 目录。非 darwin 平台是 no-op。
 *
 * @returns 实际追加的目录列表（已存在 / 不存在的目录不计入），便于日志与测试。
 */
export function ensureMacosShellPath(
	env: NodeJS.ProcessEnv = process.env,
	candidates: readonly string[] = MACOS_STANDARD_BIN_DIRS,
	exists: (dir: string) => boolean = () => true,
): string[] {
	if (process.platform !== "darwin") return [];
	const before = env.PATH ?? "";
	const after = withStandardBinDirs(before, candidates, exists);
	if (after === before) return [];
	env.PATH = after;
	return after.split(delimiter).slice(before ? before.split(delimiter).length : 0);
}
