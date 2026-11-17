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
assert(mac.platform === 'darwin' && mac.surfaces && mac.typography && mac.ui && mac.faces && mac.electron, 'Invalid macOS reference');
const windows = [100, 125, 150].map(scale => {
	const matches = files.filter(file => file.endsWith(`win32-${scale}-metrics.json`));
	assert.equal(matches.length, 1, `Require one Windows ${scale}% result`);
	return { file: matches[0], scale };
});
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
	} else if (/(?:\.fontFamily|\.family)$/.test(path)) {
		// The per-OS fallback lists intentionally differ. Compare the first choice;
		// the rendering test separately verifies native SF Mono vs Windows JetBrains Mono in xterm.
		if (!path.endsWith('.ui.terminal.fontFamily')) assert.equal(actual.split(',')[0], expected.split(',')[0], path);
	} else assert.equal(actual, expected, path);
}
function commonFonts(metrics) {
	return [...new Set(metrics.fonts.map(font => font.url)
		.filter(url => url.includes('/ui-sc-') || url.includes('/fonts/jetbrains-mono/')))].sort();
}
function sharedFace(metrics, sample, family) {
	const face = metrics.faces[sample]?.find(font => font.familyName === family);
	assert(face, `Missing ${family} in ${metrics.platform} ${sample}`);
	return { family: face.familyName, bundled: face.isCustomFont };
}
for (const { file, scale } of windows) {
	const win = read(file);
	assert.equal(win.platform, 'win32');
	assert.equal(mac.dpr, 1);
	assert.equal(win.dpr, scale / 100);
	assert.deepEqual(commonFonts(win), commonFonts(mac), 'same bundled UI SC and JetBrains Mono resources');
	assert.equal(win.electron, mac.electron, 'Compare the same Electron version');
	for (const key of ['width', 'height', 'bodySize', 'typography', 'surfaces', 'ui']) compare(mac[key], win[key], `${file}.${key}`);
	for (const [sample, family] of Object.entries({ motto: 'Times New Roman', mottoEmphasis: 'Times New Roman', code: 'JetBrains Mono', notes: 'UI SC', wiki: 'UI SC', settingsTab: 'UI SC', playground: 'JetBrains Mono' })) {
		assert.deepEqual(sharedFace(win, sample, family), sharedFace(mac, sample, family), `${file}.${sample}: actual primary face`);
	}
	assert.deepEqual(sharedFace(win, 'playground', 'PI Playground CJK'), sharedFace(mac, 'playground', 'PI Playground CJK'), 'same Sarasa Chinese glyphs in the editor');
	console.log(`PASS ${file}: matches macOS typography and component styles`);
}
