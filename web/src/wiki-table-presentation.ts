import { isGutter } from "./table-geometry";

/**
 * Editor-only classes: never rewrite Markdown's explicit alignment.
 *
 * Data rows carry a leading row gutter, so `cell.cellIndex` counts one more than
 * the logical column. Status columns are matched by header text on the header
 * row, which has no gutter — so the column index found here is already logical
 * and must be compared against logical positions, not DOM ones.
 */
export function decorateWikiTables(root: HTMLElement): void {
	for (const table of root.querySelectorAll<HTMLTableElement>('table')) {
		const headers = table.tHead?.rows[0]?.cells;
		const statusColumns = new Set<number>();
		if (headers) for (const header of headers) {
			if (/^(状态|进度|status|state)$/i.test(header.textContent?.trim() ?? '')) statusColumns.add(header.cellIndex);
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
