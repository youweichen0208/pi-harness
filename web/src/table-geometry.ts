/**
 * Table geometry for the rich editor.
 *
 * A table in the editor carries a **row gutter**: the first cell of every row is
 * an editor-only control (`data-rich-ui`, not editable) that selects that row.
 * Every row has one — header rows included — so a header row and a data row hold
 * the same number of cells and the browser aligns their columns:
 *
 *     <tr> <th gutter/> <th>A</th> <th>B</th> </tr>   3 cells, 2 logical columns
 *     <tr> <td gutter/> <td>1</td>  <td>2</td> </tr>   3 cells, 2 logical columns
 *
 * Header rows always did without one, which cost the alignment: the first visual
 * column then held both the header's first cell and the data row's gutter, so the
 * gutter was stretched to that cell's width and every header label sat one column
 * to the left of the body it named (ADR 0007, tenth item). The header gutter is a
 * `th` so `isHeaderRow` and the marker semantics stay intact.
 *
 * Every DOM index (`cell.cellIndex`, `row.cells[i]`, `deleteCell(i)`) counts the
 * gutter; users and Markdown count logical columns. Mixing the two silently
 * writes the wrong column — and that class of bug is invisible until a table is
 * saved and reopened. So this module is the **only** place allowed to convert,
 * and the editor must go through it rather than touching `cells` directly.
 *
 * The gutter carries `data-rich-ui`, so `readRichDocument` strips it and it
 * never reaches saved Markdown.
 */

/** Minimal structural view of a cell, so the pure functions stay DOM-free. */
export interface CellLike {
	readonly tagName: string;
	readonly hasAttribute?: (name: string) => boolean;
}

/** Minimal structural view of a row. */
export interface RowLike {
	readonly cells: ArrayLike<CellLike>;
}

/** Attribute the editor puts on the row gutter. */
export const GUTTER_ATTRIBUTE = "data-rich-gutter";

/** True when this cell is the row gutter rather than real content. */
export function isGutter(cell: CellLike | null | undefined): boolean {
	return !!cell && cell.hasAttribute?.(GUTTER_ATTRIBUTE) === true;
}

/**
 * True when this row is a header row: its first content cell is a `th`. The
 * leading gutter is skipped because header rows carry one too, and it is a `th`
 * itself — reading `cells[0]` would otherwise call every data row a header.
 */
export function isHeaderRow(row: RowLike | null | undefined): boolean {
	if (!row || !row.cells.length) return false;
	const cells = Array.from(row.cells);
	const first = cells.length && isGutter(cells[0]) ? cells[1] : cells[0];
	return String(first?.tagName ?? "").toUpperCase() === "TH";
}

/**
 * The cells that hold real content, i.e. everything but a leading gutter.
 * Every row carries one gutter, header rows included.
 */export function dataCells<T extends CellLike>(row: RowLike | null | undefined): T[] {
	if (!row) return [];
	const cells = Array.from(row.cells) as T[];
	return cells.length && isGutter(cells[0]) ? cells.slice(1) : cells;
}

/** How many logical (user-visible, Markdown) columns this row holds. */
export function dataCellCount(row: RowLike | null | undefined): number {
	return dataCells(row).length;
}

/**
 * Logical column index of a cell, counting from 0 and ignoring the gutter.
 * Returns -1 for the gutter itself and for detached cells.
 */
export function dataColumn(cell: CellLike | null | undefined, row: RowLike | null | undefined): number {
	if (!cell || !row || isGutter(cell)) return -1;
	const cells = Array.from(row.cells);
	const index = cells.indexOf(cell);
	if (index < 0) return -1;
	return cells.length && isGutter(cells[0]) ? index - 1 : index;
}

/**
 * DOM index of a logical column in this row, i.e. what `row.cells[i]` and
 * `deleteCell(i)` need. Returns -1 when the logical column does not exist.
 */
export function cellIndexFor(row: RowLike | null | undefined, column: number): number {
	if (!row || column < 0 || column >= dataCellCount(row)) return -1;
	const cells = Array.from(row.cells);
	return cells.length && isGutter(cells[0]) ? column + 1 : column;
}

/** The content cell at a logical column, or null when out of range. */
export function cellAt<T extends CellLike>(row: RowLike | null | undefined, column: number): T | null {
	const index = cellIndexFor(row, column);
	return index < 0 ? null : (Array.from(row!.cells)[index] as T);
}

/** The gutter cell of a row, or null when the row has none. */
export function gutterCell<T extends CellLike>(row: RowLike | null | undefined): T | null {
	if (!row || !row.cells.length) return null;
	const first = row.cells[0] as T;
	return isGutter(first) ? first : null;
}

/**
 * Whether a data column may be deleted. A table keeps at least one real column;
 * the gutter is never counted, so a one-column table reports false.
 */
export function canRemoveColumn(row: RowLike | null | undefined): boolean {
	return dataCellCount(row) > 1;
}

/**
 * Whether a data row may be deleted. `rows` is the full row list including the
 * header row: the header is never deletable, and at least one data row must stay.
 */
export function canRemoveRow(rows: ArrayLike<RowLike> | null | undefined, rowIndex: number): boolean {
	if (!rows || rowIndex < 0 || rowIndex >= rows.length) return false;
	// A header row is the first row and is never removable.
	if (rowIndex === 0 && isHeaderRow(rows[0])) return false;
	const headerRows = isHeaderRow(rows[0]) ? 1 : 0;
	return rows.length - headerRows > 1;
}

/** Attribute marking a row as the current table target. */
export const ROW_TARGET_ATTRIBUTE = "data-row-target";
/** Attribute marking a column as the current table target. */
export const COLUMN_TARGET_ATTRIBUTE = "data-column-target";
/**
 * Attribute marking the single cell the structure menu was opened on. This is
 * what a right-click paints: the menu acts on that cell's row and column, and
 * the caret already sits in it, so banding the whole row and column only added
 * colour the user had to interpret (see ADR 0007, ninth item).
 */
export const CELL_TARGET_ATTRIBUTE = "data-cell-target";

/**
 * Which logical column a DOM cell belongs to, used when stamping column-target
 * attributes. Every row carries a leading gutter, so the offset is uniform.
 */
export function isInLogicalColumn(cell: CellLike, row: RowLike, column: number): boolean {
	const cells = Array.from(row.cells);
	const index = cells.indexOf(cell);
	if (index < 0) return false;
	const gutter = cells.length && isGutter(cells[0]);
	return (gutter ? index - 1 : index) === column;
}
