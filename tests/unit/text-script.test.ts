import { describe, expect, it } from "vitest";
import { isCjkDominant } from "../../web/src/text-script.js";

describe("isCjkDominant", () => {
	it("treats a Chinese paragraph as CJK, since the em box is already full", () => {
		expect(isCjkDominant("这次截图终于是渲染后的真实界面了，我能量到具体值了。")).toBe(true);
		expect(isCjkDominant("找到源头：这条下边距正是文档明令禁止的。")).toBe(true);
	});

	it("leaves Latin prose on the looser leading", () => {
		expect(isCjkDominant("This screenshot is finally the real rendered interface.")).toBe(false);
		expect(isCjkDominant("Fix the margin on the message box.")).toBe(false);
	});

	it("does not tighten a mixed paragraph, which already has mixed leading", () => {
		// Roughly half and half: tightening would crowd the English words without
		// helping the Chinese ones, so it stays on the Latin setting.
		expect(isCjkDominant("The quick brown fox 跳过 lazy dog")).toBe(false);
		expect(isCjkDominant("读取 agent_runtime.py 然后修改输出")).toBe(true);
	});

	it("ignores code, since fences are not prose and would skew the ratio", () => {
		expect(isCjkDominant("```\nconst alpha = beta + gamma;\n```\n这里补一句话。")).toBe(true);
		expect(isCjkDominant("```\nconst alpha = beta + gamma;\n```")).toBe(false);
		expect(isCjkDominant("运行 `console.log(alpha)` 看看结果如何。")).toBe(true);
	});

	it("needs enough letters to judge, so punctuation and fragments stay Latin", () => {
		expect(isCjkDominant("")).toBe(false);
		expect(isCjkDominant("……")).toBe(false);
		expect(isCjkDominant("好")).toBe(false);
		expect(isCjkDominant("1234 !!! ---")).toBe(false);
	});

	it("counts kana and hangul alongside Han", () => {
		expect(isCjkDominant("これは日本語の文章です。")).toBe(true);
		expect(isCjkDominant("이것은 한국어 문장입니다.")).toBe(true);
	});
});
