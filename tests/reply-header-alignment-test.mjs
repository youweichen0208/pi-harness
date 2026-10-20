import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';

// Exercise both reply header structures against the actual application stylesheet.
const browser = await chromium.launch({ executablePath: CHROME_PATH });
try {
	const page = await browser.newPage();
	await page.setContent(`<div class="design-workspace"><main class="main"><button type="button" class="msg-collapsed role-assistant"><span class="msg-collapsed-role role-assistant">pi</span><span class="msg-collapsed-time">11:23</span><span class="msg-collapsed-body">检查 SSH 配置</span></button><div class="msg msg-assistant"><div class="msg-meta"><span class="msg-role">pi</span><span class="msg-time">11:26</span></div></div></main></div>`);
	await page.addStyleTag({ content: readFileSync('web/src/styles.css', 'utf8') });
	for (const width of [1440, 768, 390]) {
		await page.setViewportSize({ width, height: 900 });
		const positions = await page.evaluate(() => ['.msg-collapsed-role', '.msg-role'].map(selector => {
			const el = document.querySelector(selector);
			const range = document.createRange();
			range.selectNodeContents(el);
			return { avatarX: el.getBoundingClientRect().x, textX: range.getBoundingClientRect().x, fontSize: getComputedStyle(el).fontSize };
		}));
		assert.equal(positions[0].avatarX, positions[1].avatarX, `avatar alignment at ${width}`);
		assert.equal(positions[0].textX, positions[1].textX, `pi label alignment at ${width}: ${JSON.stringify(positions)}`);
		assert.equal(positions[0].fontSize, positions[1].fontSize, `pi label size at ${width}`);
	}
	console.log('PASS reply header alignment at 1440/768/390px');
} finally {
	await browser.close();
}
