/**
 * 终端粘贴分类 —— 纯函数（零依赖、无 DOM 类型，可在 Node 下单测）。
 *
 * 背景：xterm 的 paste 处理只把剪贴板里的纯文本送进 PTY，完全不看图片。
 * 而 TUI（codex / Claude Code 等）的贴图是「收到 Ctrl+V 按键 → 自己读系统
 * 剪贴板」，所以在浏览器终端里粘贴图片必须由我们把 `^V`(0x16) 转发给前台
 * 程序，它才有机会贴图。转发的前提是先把一次 paste 事件分成三类：
 *
 *   · text  → 维持现状，交给 xterm 的原生粘贴（含 bracketed paste）
 *   · image → 剪贴板只有图片，转发 ^V 让 TUI 自己读剪贴板
 *   · none  → 空剪贴板，什么都不做
 *
 * 优先级是文本优先：剪贴板里既有文本又有图片时按文本处理，避免破坏
 * `echo $PATH` 这类普通粘贴。
 */

export type TerminalPasteKind = "text" | "image" | "none";

/**
 * 判定一次终端 paste 事件该怎么处理。
 *
 * @param text  `clipboardData.getData("text/plain")` 的结果
 * @param types `clipboardData.items` 与 `clipboardData.files` 的 MIME 列表
 *              （Safari 等环境可能只给 files 不给 items，所以两者都要传）
 */
export function classifyTerminalPaste(
	text: string | null | undefined,
	types: Iterable<string | null | undefined> | null | undefined,
): TerminalPasteKind {
	if (text && text.length > 0) return "text";
	if (!types) return "none";
	for (const type of types) {
		if (typeof type === "string" && /^image\//i.test(type)) return "image";
	}
	return "none";
}
