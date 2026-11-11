import { expect, it } from "vitest";
import {
	canRemoveColumn,
	canRemoveRow,
	cellAt,
	cellIndexFor,
	dataCellCount,
	dataCells,
	dataColumn,
	gutterCell,
	isGutter,
	isInLogicalColumn,
	type CellLike,
} from "../../web/src/table-geometry.js";

/** A cell that reports which attributes it carries. */
const cell = (tagName: string, attributes: string[] = []): CellLike => ({
	tagName,
	hasAttribute: (name: string) => attributes.includes(name),
});

const gutter = () => cell("TD", ["data-rich-gutter"]);
const headerRow = (...names: string[]) => ({ cells: names.map(name => cell("TH")) });
const bodyRow = (...values: string[]) => ({ cells: [gutter(), ...values.map(() => cell("TD"))] });

/** The layout the editor actually produces for a 2-column table. */
const table = () => [headerRow("A", "B"), bodyRow("1", "2"), bodyRow("3", "4")];

it("keeps the header row and data rows at different DOM lengths on purpose", () => {
	expect(headerRow("A", "B").cells.length).toBe(2);
	expect(bodyRow("1", "2").cells.length).toBe(3);
	// Both describe two logical columns, which is the number that reaches Markdown.
	expect(dataCellCount(table()[0])).toBe(2);
	expect(dataCellCount(table()[1])).toBe(2);
});

it("reports the gutter without treating it as content", () => {
	expect(isGutter(gutter())).toBe(true);
	expect(isGutter(cell("TD"))).toBe(false);
	expect(gutterCell(table()[1])).not.toBeNull();
	expect(gutterCell(table()[0])).toBeNull(); // header rows have no gutter
	expect(dataCells(table()[1]).length).toBe(2);
});

it("converts DOM indices to logical columns and back", () => {
	const row = table()[1];
	const [first, second] = dataCells<CellLike>(row);
	expect(dataColumn(first, row)).toBe(0);
	expect(dataColumn(second, row)).toBe(1);
	// The gutter is not column 0; it is not a column at all.
	expect(dataColumn(row.cells[0], row)).toBe(-1);
	// cellIndexFor adds the gutter back, which is what deleteCell() needs.
	expect(cellIndexFor(row, 0)).toBe(1);
	expect(cellIndexFor(row, 1)).toBe(2);
	expect(cellIndexFor(row, 2)).toBe(-1);
	expect(cellAt(row, 1)).toBe(second);
	expect(cellAt(row, 9)).toBeNull();
});

it("treats header rows as having no gutter offset", () => {
	const row = table()[0];
	expect(dataColumn(row.cells[1], row)).toBe(1);
	expect(cellIndexFor(row, 1)).toBe(1);
});

it("refuses to delete the last column or the last data row", () => {
	expect(canRemoveColumn(headerRow("only"))).toBe(false);
	expect(canRemoveColumn(headerRow("A", "B"))).toBe(true);
	const rows = table();
	expect(canRemoveRow(rows, 0)).toBe(false); // header
	expect(canRemoveRow(rows, 1)).toBe(true);
	expect(canRemoveRow([headerRow("A"), bodyRow("1")], 1)).toBe(false); // last data row
	expect(canRemoveRow(rows, 99)).toBe(false);
});

it("matches a cell to a logical column for column highlighting", () => {
	const row = table()[1];
	expect(isInLogicalColumn(row.cells[1], row, 0)).toBe(true);
	expect(isInLogicalColumn(row.cells[2], row, 0)).toBe(false);
	expect(isInLogicalColumn(row.cells[0], row, 0)).toBe(false); // gutter is not column 0
});
