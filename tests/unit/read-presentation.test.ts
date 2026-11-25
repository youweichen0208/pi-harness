import { expect, test } from "vitest";
import { dedentReadPreview, displayReadPath, readPath, splitFrontmatter } from "../../web/src/read-presentation.js";

test("read calls show a compact path instead of internal JSON", () => {
	expect(readPath('{"path":"/Users/alice/.agents/skills/grilling/SKILL.md"}')).toBe("/Users/alice/.agents/skills/grilling/SKILL.md");
	expect(displayReadPath("/Users/alice/.agents/skills/grilling/SKILL.md")).toBe("~/.agents/skills/grilling/SKILL.md");
	expect(readPath('{"command":"ls"}')).toBeNull();
});

test("skill frontmatter is separated from Markdown prose", () => {
	expect(splitFrontmatter("---\nname: grilling\ndescription: Ask hard questions\n---\n# Usage\nBody")).toEqual({
		fields: [{ name: "name", value: "grilling" }, { name: "description", value: "Ask hard questions" }],
		body: "# Usage\nBody",
	});
	expect(splitFrontmatter("# Ordinary Markdown")).toEqual({ fields: [], body: "# Ordinary Markdown" });
});

test("read previews drop the indentation every line shares", () => {
	const text = "\t\t\t\t\t\t\t\tmodels={chat.models}\n\t\t\t\t\t\t\t\taccounts={chat.accounts}\n\t\t\t\t\t\t\t\t\tattachments={attachments}";
	expect(dedentReadPreview(text)).toBe("models={chat.models}\naccounts={chat.accounts}\n\tattachments={attachments}");
	// Ragged indentation keeps the shortest shared prefix, blank lines included.
	expect(dedentReadPreview("\tconst a = 1;\n\n\t  const b = 2;")).toBe("const a = 1;\n\n  const b = 2;");
});

test("read previews keep their text when nothing safe to strip", () => {
	// Flush-left code has no shared indent.
	expect(dedentReadPreview("import x from 'y';\n\treturn x;")).toBe("import x from 'y';\n\treturn x;");
	// Mixed tabs and spaces never share a prefix, so the preview stays put.
	expect(dedentReadPreview("\tconst a = 1;\n    const b = 2;")).toBe("\tconst a = 1;\n    const b = 2;");
	expect(dedentReadPreview("")).toBe("");
});

test("the tool's trailing hint does not pin the shared indent to zero", () => {
	const text = "\t\tconst a = 1;\n\t\tconst b = 2;\n\n[12 more lines in file. Use offset=41 to continue.]";
	expect(dedentReadPreview(text)).toBe("const a = 1;\nconst b = 2;\n\n[12 more lines in file. Use offset=41 to continue.]");
	expect(dedentReadPreview("\t\tconst a = 1;\n[Showing lines 3-5 of 120. Use offset=6 to continue.]")).toBe("const a = 1;\n[Showing lines 3-5 of 120. Use offset=6 to continue.]");
});
