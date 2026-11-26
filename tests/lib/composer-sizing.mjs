import assert from 'node:assert/strict';

export async function verifyComposerSizing(page) {
	const composer = page.locator('.inputbox textarea:visible').first();
	await composer.fill('first line\nsecond line');
	const initialHeight = await composer.evaluate(el => el.offsetHeight);
	const tracker = await composer.evaluateHandle(el => {
		const state = { writes: 0 };
		const observer = new MutationObserver(records => { state.writes += records.length; });
		observer.observe(el, { attributes: true, attributeFilter: ['style'] });
		return { state, observer };
	});
	try {
		await composer.press('End');
		await composer.pressSequentially(' typing');
		assert.equal(await composer.evaluate(el => el.offsetHeight), initialHeight);
		assert.equal(await tracker.evaluate(({ state }) => state.writes), 0, 'typing within a line does not reset composer height');
		await composer.fill('');
		assert(await composer.evaluate(el => el.offsetHeight) < initialHeight);
	} finally {
		await tracker.evaluate(({ observer }) => observer.disconnect());
		await tracker.dispose();
	}
}
