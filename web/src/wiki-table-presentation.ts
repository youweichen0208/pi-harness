/** Editor-only classes: never rewrite Markdown's explicit alignment. */
export function decorateWikiTables(root: HTMLElement): void {
	for (const table of root.querySelectorAll<HTMLTableElement>('table')) {
		const headers = table.tHead?.rows[0]?.cells;
		const statusColumns = new Set<number>();
		if (headers) for (const header of headers) {
			if (/^(状态|进度|status|state)$/i.test(header.textContent?.trim() ?? '')) statusColumns.add(header.cellIndex);
		}
		for (const row of table.rows) for (const cell of row.cells) {
			cell.classList.toggle('wiki-table-status', statusColumns.has(cell.cellIndex));
		}
	}
}
