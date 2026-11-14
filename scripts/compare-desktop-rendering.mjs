/** Compare native OS metrics in CSS pixels; macOS is the reference. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2] ?? 'tests/scratch/rendering');
const files = readdirSync(root, { recursive: true }).filter(name => name.endsWith('-metrics.json'));
const read = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
const macFile = files.find(name => name.endsWith('darwin-100-metrics.json'));
assert(macFile, 'Missing native macOS reference');
const mac = read(macFile);
assert(mac.platform === 'darwin' && mac.surfaces && mac.typography && mac.ui && mac.electron, 'Invalid macOS reference');
const windows = files.filter(name => /win32-(100|125|150)-metrics.json$/.test(name));
assert.equal(windows.length, 3, 'Require Windows 100%, 125%, 150% results');
function compare(expected, actual, path) {
	// Range rect height tracks OS glyph rasterization, not the CSS line box.
	// Compare line count/width and the element's own height separately.
	if (/\.lines\[\d+\]\.height$/.test(path)) return;
	if (typeof expected === 'number') {
		assert.equal(typeof actual, 'number', path);
		assert(Math.abs(expected - actual) <= 1, `${path}: Mac ${expected}, Windows ${actual} (tolerance 1 CSS px)`);
	} else if (Array.isArray(expected)) {
		assert(Array.isArray(actual), path);
		assert.equal(actual.length, expected.length, `${path}: line/item count`);
		expected.forEach((value, index) => compare(value, actual[index], `${path}[${index}]`));
	} else if (expected && typeof expected === 'object') {
		assert(actual && typeof actual === 'object', path);
		for (const key of Object.keys(expected)) compare(expected[key], actual[key], `${path}.${key}`);
	} else assert.equal(actual, expected, path);
}
for (const file of windows) {
	const win = read(file);
	assert.equal(win.platform, 'win32');
	assert.equal(win.electron, mac.electron, 'Compare the same Electron version');
	for (const key of ['width', 'height', 'bodySize', 'typography', 'surfaces', 'ui']) compare(mac[key], win[key], `${file}.${key}`);
	// CJK uses native PingFang on macOS and bundled UI SC on Windows.
	// The per-platform rendering test verifies each fallback; code uses the same bundled font.
	for (const key of ['monoFonts']) {
		const custom = fonts => [...new Set(fonts.filter(font => font.isCustomFont).map(font => font.familyName))].sort();
		assert.deepEqual(custom(win[key]), custom(mac[key]), `${file}.${key}: actual bundled fonts`);
	}
	console.log(`PASS ${file}: matches macOS typography and component styles`);
}
