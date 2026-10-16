// Real Chromium layout regression using the production stylesheet and Markdown DOM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';

const browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
try {
	const page = await browser.newPage();
	const table = columns => `<table><thead><tr>${Array.from({ length: columns }, (_, i) => `<th>列 ${i + 1}</th>`).join('')}</tr></thead><tbody>${'<tr>' + '<td><br></td>'.repeat(columns) + '</tr>'}</tbody></table>`;
	await page.setContent(`<div class="design-workspace"><div class="wiki-prose"><div class="fp-markdown"><div class="md fp-rich-document" contenteditable="true"><div class="rich-block">${table(3)}</div><div class="rich-block">${table(12)}</div></div></div></div></div>`);
	await page.addStyleTag({ content: readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8') });
	await page.addStyleTag({ content: '.design-workspace { display: block; width: 760px; }' });
	for (const wiki of [true, false]) {
		await page.locator('.design-workspace > div').evaluate((el, wiki) => { el.className = wiki ? 'wiki-prose' : ''; }, wiki);
		for (const theme of ['light', 'dark']) {
			await page.evaluate(theme => { document.documentElement.dataset.appearance = theme; }, theme);
			for (const width of [760, 320]) {
				await page.locator('.design-workspace').evaluate((el, width) => { el.style.width = `${width}px`; }, width);
				const small = await page.locator('table').first().evaluate(el => ({
					width: el.getBoundingClientRect().width,
					grid: el.querySelector('thead').getBoundingClientRect().width,
				}));
				assert(small.width - small.grid <= 3, `table has empty right area: ${JSON.stringify(small)}`);
				const wide = await page.locator('table').last().evaluate(el => {
					el.scrollLeft = 100;
					return { width: el.getBoundingClientRect().width, available: el.parentElement.clientWidth, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollLeft: el.scrollLeft };
				});
				assert(wide.width <= wide.available + 1, `wide table escapes its container: ${JSON.stringify(wide)}`);
				assert(wide.scrollWidth > wide.clientWidth && wide.scrollLeft > 0, 'wide table must scroll internally');
			}
		}
	}
	console.log('PASS Markdown tables: Wiki/preview, light/dark, no empty right area, wide-table scrolling at desktop/narrow widths');
} finally {
	await browser.close();
}
