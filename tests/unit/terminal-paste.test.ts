import { expect, test } from "vitest";
import { classifyTerminalPaste } from "../../web/src/terminal-paste.js";

test("text wins so ordinary paste keeps going through xterm", () => {
	expect(classifyTerminalPaste("echo $PATH", [])).toBe("text");
	expect(classifyTerminalPaste("multi\nline\ntext", ["text/plain"])).toBe("text");
	// 剪贴板里既有文本又有图片：按文本处理，不能转发 ^V 吞掉文本粘贴。
	expect(classifyTerminalPaste("hello", ["text/plain", "image/png"])).toBe("text");
	expect(classifyTerminalPaste(" ", ["image/png"])).toBe("text");
});

test("image-only clipboard is forwarded as ^V", () => {
	expect(classifyTerminalPaste("", ["image/png"])).toBe("image");
	expect(classifyTerminalPaste("", ["text/plain", "image/jpeg"])).toBe("image");
	expect(classifyTerminalPaste(null, ["IMAGE/PNG"])).toBe("image");
});

test("empty clipboard is a no-op", () => {
	expect(classifyTerminalPaste("", [])).toBe("none");
	expect(classifyTerminalPaste(undefined, undefined)).toBe("none");
	expect(classifyTerminalPaste("", null)).toBe("none");
	// 非图片的二进制（例如从 Finder 复制的文件）不去猜路径，直接忽略。
	expect(classifyTerminalPaste("", ["application/pdf", null, ""])).toBe("none");
});
