import { describe, expect, it } from "vitest";
import { emptyNotebook, notebookSource, readNotebook } from "../../server/notebook.js";
describe("Notebook documents", () => {
	it("creates an editable v4 document with an empty code cell", () => {
		expect(readNotebook(emptyNotebook()).cells[0]).toMatchObject({
			cell_type: "code",
			execution_count: null,
			outputs: [],
		});
	});
	it("quotes source and the selected cell without including outputs or attachments", () => {
		const file = JSON.stringify({
			nbformat: 4,
			nbformat_minor: 3,
			metadata: { custom: 42 },
			cells: [
				{ cell_type: "markdown", source: ["one", " two"], metadata: {}, attachments: { secret: "bytes" } },
				{
					cell_type: "code",
					source: "print(42)",
					metadata: {},
					outputs: [{ output_type: "stream", text: "private result" }],
				},
			],
		});
		expect(notebookSource(file, 1)).toBe("[Cell 1 · markdown]\none two\n\n[Cell 2 · code · selected]\nprint(42)");
		expect(notebookSource(file, 1, true)).toBe("[Cell 2 · code · selected]\nprint(42)");
		expect(readNotebook(file)).toEqual(JSON.parse(file));
	});
	it("rejects malformed documents and unsupported major versions", () => {
		for (const input of [
			"{}",
			"{",
			'{"nbformat":3,"metadata":{},"cells":[]}',
			'{"nbformat":4,"metadata":{},"cells":[null]}',
		])
			expect(() => readNotebook(input)).toThrow();
	});
});
