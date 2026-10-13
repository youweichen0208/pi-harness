import { expect, test } from "vitest";
import { preserveUserTree, repeatedUserMessages } from "../../web/src/user-message-presentation.js";
import type { UiMessage } from "../../server/protocol.js";

test("pasted tree lines become a fixed-width block with line breaks", () => {
	expect(preserveUserTree("Campaign\n├── Batch\n│  └── Forecast\n\nNext"))
		.toBe("```text\nCampaign\n├── Batch\n│  └── Forecast\n```\n\nNext");
});

test("existing fenced code stays untouched", () => {
	const text = "```text\n└── Batch\n```";
	expect(preserveUserTree(text)).toBe(text);
});

test("pasted box-rule tables become a single scrollable code block", () => {
	const rule = "─".repeat(80);
	expect(preserveUserTree(`Intro\n\n位置 │ 问题 │ 修改建议\n${rule}\ndocs/a.md:23 │ 错误 │ 修改\n${rule}\n\nAfter`))
		.toBe(`Intro\n\n\`\`\`ascii-table\n位置 │ 问题 │ 修改建议\n${rule}\ndocs/a.md:23 │ 错误 │ 修改\n${rule}\n\`\`\`\n\nAfter`);
});

test("plain user file paths become local links without changing code", () => {
	expect(preserveUserTree("Read docs/a.md:23 and `docs/b.md:4`"))
		.toBe("Read [docs/a.md:23](#pi-file=docs%2Fa.md:23) and `docs/b.md:4`");
});

test("identical user messages without a reply between them render once", () => {
	const user = (id: string, text: string): UiMessage => ({ id, role: "user", content: [{ type: "text", text }] });
	const { counts, hidden } = repeatedUserMessages([
		user("a", "hello"), { id: "s", role: "system", content: [] }, user("b", " hello "),
		{ id: "r", role: "assistant", content: [{ type: "text", text: "hi" }] }, user("c", "hello"),
	]);
	expect([...counts]).toEqual([["a", 2]]);
	expect([...hidden]).toEqual([["b", "a"]]);
	expect(repeatedUserMessages([user("a", "one"), user("b", "two")]).hidden.size).toBe(0);
});

test("an empty retry between identical questions does not count as a reply", () => {
	const ask = (id: string): UiMessage => ({ id, role: "user", content: [{ type: "text", text: 'skill text\n\n<file path="/u/Hermes.docx" />' }] });
	const { hidden } = repeatedUserMessages([ask("a"), { id: "empty", role: "assistant", content: [] }, ask("b")]);
	expect([...hidden]).toEqual([["b", "a"]]);
});
