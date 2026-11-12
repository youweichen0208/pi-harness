// The gutter line numbers must sit on the same rows as the code lines.
// Regression: the digit font-size (12px) was smaller than the code font-size
// (13.5px), and .cm-gutterElement inherited the scroller's line-height ratio,
// so every gutter row was a hair shorter than its code row and the numbers
// drifted upward — by line 13 they were a full line off.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { playgroundFixture } from "./lib/playground-fixture.mjs";

const source = Array.from({ length: 24 }, (_, i) => `x${i + 1} = ${i + 1}`).join("\n") + "\n";
const fixture = await playgroundFixture();
const failed = [];
let browser;
try {
	await fixture.api("config", { enabled: true });
	await fixture.api("scratch", { content: source, tests: { mode: "program", selectedMethod: "", casesByMethod: {} } }, "PUT");
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
	const errors = [];
	page.on("pageerror", e => errors.push(e.message));
	await page.goto(`${fixture.base}/?token=${fixture.token}`);
	await page.locator(".setup-modal .modal-close").click();
	await page.getByRole("button", { name: "Playground", exact: true }).click();
	const gutter = page.locator(".scratch-editor-cm .cm-lineNumbers .cm-gutterElement:visible").filter({ hasText: /^\d+$/ });
	await page.locator(".scratch-editor-cm .cm-line").first().waitFor();
	await gutter.first().waitFor();

	// Row heights must agree with the gutters; CodeMirror positions gutters by
	// line height, so any mismatch shows up as cumulative drift.
	const heights = await page.evaluate(() => {
		// The gutter keeps an extra zero-height spacer to reserve width; only the
		// visible, rounded rows correspond to real lines.
		const numbers = [...document.querySelectorAll(".scratch-editor-cm .cm-lineNumbers .cm-gutterElement")]
			.filter(el => el.getClientRects().length > 0)
			.map(el => el.getBoundingClientRect().height)
			.filter(h => h > 1);
		const lines = [...document.querySelectorAll(".scratch-editor-cm .cm-line")]
			.map(el => el.getBoundingClientRect().height);
		return { numbers, lines };
	});
	const lineStep = heights.lines[0];
	for (const [i, h] of heights.numbers.entries()) {
		if (Math.abs(h - lineStep) > 0.5) failed.push(`gutter row ${i + 1} is ${h}px, code row is ${lineStep}px`);
	}

	// End-to-end: every visible number's vertical center must land on a code row's center.
	const drift = await page.evaluate(() => {
		const centers = el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
		const lineCenters = [...document.querySelectorAll(".scratch-editor-cm .cm-line")]
			.map(el => (el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2));
		const out = [];
		document.querySelectorAll(".scratch-editor-cm .cm-lineNumbers .cm-gutterElement").forEach(el => {
			if (!el.getClientRects().length || el.getBoundingClientRect().height < 1) return;
			const text = el.textContent?.trim() ?? "";
			if (!/^\d+$/.test(text)) return;
			const c = centers(el);
			const nearest = Math.min(...lineCenters.map(l => Math.abs(l - c)));
			if (nearest > 0.5) out.push({ line: Number(text), off: +nearest.toFixed(2) });
		});
		return out;
	});
	for (const d of drift) failed.push(`number ${d.line} is ${d.off}px off the row center`);

	// Same check with a longer document that forces scrolling.
	await page.locator(".scratch-editor-cm .cm-content").fill(Array.from({ length: 120 }, (_, i) => `y${i + 1} = ${i + 1}`).join("\n") + "\n");
	await page.waitForTimeout(150);
	const scrolledDrift = await page.evaluate(() => {
		const lineCenters = [...document.querySelectorAll(".scratch-editor-cm .cm-line")]
			.map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
		const out = [];
		document.querySelectorAll(".scratch-editor-cm .cm-lineNumbers .cm-gutterElement").forEach(el => {
			if (!el.getClientRects().length || el.getBoundingClientRect().height < 1) return;
			const text = el.textContent?.trim() ?? "";
			if (!/^\d+$/.test(text)) return;
			const r = el.getBoundingClientRect();
			const nearest = Math.min(...lineCenters.map(l => Math.abs(l - (r.top + r.height / 2))));
			if (nearest > 0.5) out.push({ line: Number(text), off: +nearest.toFixed(2) });
		});
		return out;
	});
	for (const d of scrolledDrift) failed.push(`after growth, number ${d.line} is ${d.off}px off`);

	assert.deepEqual(failed, [], `gutter/code misalignment:\n${failed.join("\n")}`);
	assert.deepEqual(errors, []);
	console.log("PASS Playground gutter alignment: line numbers share each code row's height and center");
} finally {
	await browser?.close();
	await fixture.stop();
}
