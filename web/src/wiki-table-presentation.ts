import { isGutter } from "./table-geometry";

/**
 * Editor-only classes: never rewrite Markdown's explicit alignment.
 *
 * Every row carries a leading row gutter, so `cell.cellIndex` counts one more
 * than the logical column. Status columns are matched by header text, then
 * compared against the logical position of each content cell — never against a
 * DOM index, or the status styling lands one column to the right.
 */
export function decorateWikiTables(root: HTMLElement): void {
	for (const table of root.querySelectorAll<HTMLTableElement>('table')) {
		const headers = table.tHead?.rows[0]?.cells;
		const statusColumns = new Set<number>();
		if (headers) {
			let logical = -1;
			for (const header of headers) {
				if (isGutter(header)) continue;
				logical += 1;
				if (/^(状态|进度|status|state)$/i.test(header.textContent?.trim() ?? '')) statusColumns.add(logical);
			}
		}
		for (const row of table.rows) {
			// The gutter is never a status column, whatever the numbers say.
			let logical = -1;
			for (const cell of row.cells) {
				if (isGutter(cell)) continue;
				logical += 1;
				cell.classList.toggle('wiki-table-status', statusColumns.has(logical));
			}
		}
	}
}
