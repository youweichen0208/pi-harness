import type { NotebookCellOutput, NotebookText } from "./protocol.js";

export const notebookPath = (path: string) => /\.ipynb$/i.test(path);
export interface Cell {
	id?: string;
	cell_type: string;
	metadata: Record<string, unknown>;
	source: NotebookText;
	execution_count?: number | null;
	outputs?: NotebookCellOutput[];
}
export interface Notebook {
	nbformat: number;
	nbformat_minor: number;
	metadata: { kernelspec?: { language: string; name: string; display_name: string }; language_info?: { name: string } };
	cells: Cell[];
}
export function cellText(value?: NotebookText) {
	return Array.isArray(value) ? value.join("") : typeof value === "string" ? value : "";
}
export function newCell(type = "code", id: string = crypto.randomUUID()): Cell {
	return {
		id,
		cell_type: type,
		metadata: {},
		source: "",
		...(type === "code" ? { execution_count: null, outputs: [] } : {}),
	};
}
export function emptyNotebook() {
	return (
		JSON.stringify(
			{
				nbformat: 4,
				nbformat_minor: 5,
				metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
				cells: [newCell()],
			},
			null,
			1,
		) + "\n"
	);
}
export function readNotebook(text: string): Notebook {
	const book = JSON.parse(text);
	if (
		book?.nbformat !== 4 ||
		!book.metadata || typeof book.metadata !== "object" || Array.isArray(book.metadata) ||
		!Array.isArray(book.cells) ||
		!book.cells.every(
			(c: Cell) =>
				c &&
				typeof c.cell_type === "string" &&
				(typeof c.source === "string" || (Array.isArray(c.source) && c.source.every((v) => typeof v === "string"))) &&
				(c.outputs === undefined || (Array.isArray(c.outputs) && c.outputs.every((o) => o && typeof o.output_type === "string" && (o.traceback === undefined || Array.isArray(o.traceback) && o.traceback.every(v => typeof v === "string"))))),
		)
	)
		throw new Error("Invalid or unsupported Notebook (nbformat 4 required)");
	return book;
}
export function notebookSource(text: string, selected?: number, selectedOnly = false) {
	return readNotebook(text)
		.cells.flatMap((cell, i) =>
			selectedOnly && i !== selected
				? []
				: `[Cell ${i + 1} · ${cell.cell_type}${i === selected ? " · selected" : ""}]\n${cellText(cell.source)}`,
		)
		.join("\n\n");
}
