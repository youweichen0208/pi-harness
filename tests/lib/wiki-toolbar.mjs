// Open a top-level command or a group moved into the responsive overflow menu.
export async function wikiToolbar(page, label) {
	const toolbar = page.locator('.wiki-unified-toolbar');
	let button = toolbar.getByRole('button', { name: label, exact: true });
	if (!await button.isVisible()) {
		await toolbar.getByRole('button', { name: '更多', exact: true }).click();
		button = page.getByRole('menuitem', { name: label, exact: true });
	}
	await button.click();
}
export async function wikiInsert(page, label) {
	await wikiToolbar(page, '插入元素');
	await page.getByRole('menuitem', { name: label, exact: true }).click();
}
