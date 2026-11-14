/** Compare layout metrics, never raster pixels or OS-native window controls. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const directory = resolve(process.argv[2] || 'tests/scratch/rendering');
const read = prefix => JSON.parse(readFileSync(resolve(directory, `${prefix}-metrics.json`), 'utf8'));
const reference = read('darwin-100');
for (const scale of [100, 125, 150]) {
	const candidate = read(`win32-${scale}`);
	assert.equal(candidate.platform, 'win32');
	assert.equal(candidate.dpr, scale / 100);
	assert.equal(candidate.bodySize, reference.bodySize);
	assert.deepEqual([...new Set(candidate.fonts.map(font => font.url))].sort(), [...new Set(reference.fonts.map(font => font.url))].sort(), 'same bundled font files');
	for (const appearance of ['light', 'dark']) {
		const baseline = reference.typography[appearance];
		const actual = candidate.typography[appearance];
		assert.equal(actual.length, baseline.length);
		for (let i = 0; i < baseline.length; i++) {
			const expected = baseline[i], sample = actual[i];
			const context = `Windows ${scale}% ${appearance} ${sample.weight} ${sample.text}`;
			for (const key of ['text', 'weight', 'family', 'size', 'color']) assert.equal(sample[key], expected[key], `${context}: ${key}`);
			assert.equal(sample.lines.length, expected.lines.length, `${context}: line wrapping`);
			for (let line = 0; line < expected.lines.length; line++) {
				// Native PingFang glyph advances differ slightly from bundled UI SC.
				const tolerance = /[^\x00-\x7f]/.test(expected.text) ? Math.max(1, expected.lines[line].width * 0.03) : 1;
				assert(Math.abs(sample.lines[line].width - expected.lines[line].width) <= tolerance, `${context}: line ${line} width exceeds ${tolerance} CSS px tolerance`);
			}
		}
	}
	console.log(`PASS Windows ${scale}% matches Mac typography: bundled files, colors, sizes, weights, wrapping and line widths (English 1 CSS px, native CJK 3%)`);
}
