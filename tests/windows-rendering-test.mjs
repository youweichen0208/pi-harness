/** Actual Electron/OS rendering; CI runs this on macOS and Windows at 100%/125%/150%. */
import assert from 'node:assert/strict';
import { testEnv } from './lib/test-env.mjs';
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const base = mkdtempSync(join(tmpdir(), 'pi-rendering-')), cwd = join(base, 'project'), agent = join(base, 'agent');
const output = resolve(process.env.PI_RENDER_OUTPUT || 'tests/scratch/rendering');
mkdirSync(cwd); mkdirSync(agent); mkdirSync(output, { recursive: true });
for (const name of ['.ruff_cache', 'raw', 'scripts', 'skills', ...Array.from({ length: 40 }, (_, i) => `source-${String(i).padStart(2, '0')}`)]) mkdirSync(join(cwd, name));
writeFileSync(join(cwd, 'README.md'), '# 本质：渲染验收\n\n同一份离线测试资料。\n');
writeFileSync(join(agent, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'render-test' }));
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', models: [{ id: 'render-test', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
const mixed = 'Render 中文 ✅';
const timestamp = 1791547200000;
const transcript = [
	{ id: 'render-user', role: 'user', content: [{ type: 'text', text: '请说明这个项目的本质，并检查文档转换与知识整理。' }], timestamp },
	{ id: 'render-assistant', role: 'assistant', model: 'render-test', content: [{ type: 'thinking', thinking: '先检查原始资料和已有知识，保留可追溯的来源。', durationMs: 2000 }, { type: 'text', text: '## 本质：职责分离\n\n文档转换保留文字、表格和代码；知识整理提取可信结论，并保留证据与适用条件。\n\n```python\ndef convert_document(source):\n    return source.read_text()  # 中文 ✅\n```' }, ...[1, 2, 3].map(n => ({ type: 'toolCall', id: `render-bash-${n}`, name: 'bash', argumentsText: JSON.stringify({ command: `echo '检查 PDF、CHM 与源码资料的转换结果并核对来源 ${n}'` }) }))], timestamp: timestamp + 1000 },
	...[1, 2, 3].map(n => ({ id: `render-result-${n}`, role: 'toolResult', toolCallId: `render-bash-${n}`, toolName: 'bash', content: [{ type: 'text', text: '检查完成。\n' }], isError: false, timestamp: timestamp + 2000 + n })),
	{ id: 'render-final', role: 'assistant', model: 'render-test', content: [{ type: 'text', text: '已检查转换结果。待验证结论保留草稿，人工复核后发布。' }], timestamp: timestamp + 4000 },
];
let app;
try {
	for (const scale of process.platform === 'win32' ? [1, 1.25, 1.5] : [1]) {
		app = await electron.launch({ ...(process.argv[2] ? { executablePath: resolve(process.argv[2]) } : {}), args: [...(process.argv[2] ? [] : ['.']), `--force-device-scale-factor=${scale}`, `--user-data-dir=${join(base, `profile-${scale}`)}`], env: { ...testEnv(), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, `data-${scale}`), PI_CODING_AGENT_DIR: agent } });
		let page;
		for (let i = 0; i < 200; i++) { page = app.windows().find(p => p.url().startsWith('http://127.0.0.1:')); if (page) break; await sleep(100); }
		assert(page, 'local app window starts'); page.setDefaultTimeout(15000);
		let conversation = false, socketRoute, activeConversationId;
		await page.routeWebSocket('**/ws*', socket => {
			socketRoute = socket;
			const upstream = socket.connectToServer();
			socket.onMessage(wire => {
				const message = JSON.parse(wire.toString());
				if (message.terminalId !== 'render-terminal') { upstream.send(wire); return; }
				if (message.type === 'terminal_replay') socket.send(JSON.stringify({
					type: 'terminal_output', conversationId: activeConversationId,
					terminalId: message.terminalId, reset: true, data: mixed,
				}));
			});
			upstream.onMessage(wire => {
				const message = JSON.parse(wire.toString());
				if (message.type === 'conversations') activeConversationId = message.activeId;
				if (message.type === 'snapshot' || message.type === 'snapshot_delta') { message.state.piConfigured = true; message.state.messages = conversation ? transcript : []; message.state.isStreaming = false; message.state.streamingMessage = null; if (message.type === 'snapshot_delta') { message.type = 'snapshot'; delete message.appended; delete message.baseRev; } }
				socket.send(JSON.stringify(message));
			});
		});
		await page.evaluate(() => { localStorage.setItem('pi-appearance', 'light'); localStorage.setItem('pi-left-collapsed', 'false'); });
		await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:')); w.setContentSize(1440, 900); w.show(); w.focus(); });
		const cdp = await page.context().newCDPSession(page);
		const nativeWindow = await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:')); return { size: w.getContentSize(), background: w.getBackgroundColor() }; });
		assert.equal(nativeWindow.background.toUpperCase(), '#FFFFFF');
		// Hosted macOS can clamp native windows to its small virtual display. Keep
		// the comparison canvas identical; still use this OS/Electron font renderer.
		if (nativeWindow.size[0] !== 1440 || nativeWindow.size[1] !== 900) await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: scale, mobile: false });
		await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
		const fonts = [], failures = [];
		page.on('response', response => { if (/\.woff2(?:\?|$)/.test(response.url())) { fonts.push({ url: new URL(response.url()).pathname, status: response.status() }); if (!response.ok()) failures.push(response.url()); } });
		await page.reload(); await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
		await page.locator('.compact-workspace-trigger').click();
		await page.locator('.workspace-picker-create').click();
		await page.getByLabel('Workspace 名称', { exact: true }).fill('Rendering');
		await page.getByRole('button', { name: '创建 Workspace', exact: true }).click();
		await page.locator('.lp-add-project').click();
		await page.locator('.fpk-modal-foot input').fill(cwd);
		await page.locator('.fpk-open-btn').click();
		await page.locator('.project-item.active').waitFor();
		await page.locator('.welcome-motto').waitFor();
		assert.equal(await page.evaluate(() => document.documentElement.dataset.platform), process.platform);
		await page.evaluate(async () => { await Promise.all([400, 500, 600].map(weight => document.fonts.load(`${weight} 16px "UI SC"`, '本质检查'))); await document.fonts.load('400 12px "JetBrains Mono"', '.ruff_cache'); await document.fonts.ready; });
		const prefix = `${process.platform}-${Math.round(scale * 100)}`;
		await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
		// React may replace a message node while file-tree data arrives. Resolve
		// the current node for each sample; only retry detached-node races.
		const platformFonts = async selector => {
			for (let attempt = 0; attempt < 20; attempt++) {
				await page.locator(selector).first().waitFor();
				const { root } = await cdp.send('DOM.getDocument');
				const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
				if (nodeId) {
					try { return await cdp.send('CSS.getPlatformFontsForNode', { nodeId }); }
					catch (error) { if (!/Could not find node with given id/.test(String(error))) throw error; }
				}
				await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
			}
			assert.fail(`No stable rendered node for ${selector}`);
		};
		const faces = {};
		const mac = process.platform === 'darwin';
		const emoji = mac ? 'Apple Color Emoji' : 'Noto Color Emoji';
		const measureFonts = async (name, selector, expected) => {
			const { fonts } = await platformFonts(selector);
			const used = fonts.filter(font => font.glyphCount > 0);
			assert(used.length, `${name}: no text rendered`);
			for (const alternatives of expected) {
				const choices = [alternatives].flat();
				assert(used.some(font => choices.includes(font.familyName)), `${name}: expected ${choices.join(' or ')}: ${JSON.stringify(used)}`);
			}
			faces[name] = used.map(({ familyName, postScriptName, isCustomFont }) => ({ familyName, postScriptName, isCustomFont }));
			return used;
		};
		for (const [name, selector] of [['motto', '.welcome-motto > span:first-child'], ['mottoEmphasis', '.welcome-motto em']]) {
			const used = await measureFonts(name, selector, ['Times New Roman']);
			assert(used.every(font => !font.isCustomFont && font.familyName === 'Times New Roman'), `${name}: use the native italic face from v1.34.1`);
			assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).fontStyle), 'italic');
		}
		const ui = {};
		const sampleControl = async (name, selector, size = false) => {
			const el = page.locator(selector).first();
			await el.waitFor();
			ui[name] = await el.evaluate((node, size) => {
				const style = getComputedStyle(node);
				const keys = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor', 'borderRadius', 'padding'];
				const result = Object.fromEntries(keys.map(key => {
					const value = style[key];
					return [key, /^-?[\d.]+px$/.test(value) ? parseFloat(value) : value];
				}));
				// Only intrinsically sized controls have comparable geometry across native shells.
				if (size) {
					// Layout dimensions exclude transient modal entrance transforms.
					result.width = node.offsetWidth;
					result.height = node.offsetHeight;
				}
				return result;
			}, size);
		};
		await sampleControl('welcome', '.welcome-motto');
		await page.screenshot({ path: join(output, `${prefix}-empty.png`) });
		assert(await page.locator('.welcome-motto').isVisible());
		assert.equal(failures.length, 0, `font resources load successfully: ${JSON.stringify(fonts)}`);
		assert.equal(new Set(fonts.filter(font => /ui-sc-/.test(font.url)).map(font => font.url)).size, 3);
		assert(fonts.some(font => /jetbrains-mono/.test(font.url) && font.status === 200));
		conversation = true; await page.reload(); await page.locator('.msg-text', { hasText: '职责分离' }).waitFor().catch(async error => { await page.screenshot({ path: join(output, `${prefix}-failure.png`) }); writeFileSync(join(output, `${prefix}-failure.txt`), await page.locator('body').innerText()); throw error; }); await page.evaluate(() => document.fonts.ready);
		const rendered = await platformFonts('.msg-text h2');
		assert(rendered.fonts.some(font => font.familyName === 'UI SC' && font.isCustomFont && font.glyphCount > 0), JSON.stringify(rendered));
		assert(await page.locator('.msg-text h2').evaluate(el => getComputedStyle(el).fontFamily.startsWith('"UI SC"')), 'prose prioritizes the bundled cross-platform UI font');
		await page.locator('.tree-hidden-summary').click();
		await page.locator('[data-tree-node=".ruff_cache"] .file-name').waitFor();
		const monoFonts = await platformFonts('.msg-text pre code');
		assert(monoFonts.fonts.some(font => font.familyName === 'JetBrains Mono' && font.isCustomFont), JSON.stringify(monoFonts));
		// v1.34.1 uses native fallbacks on Mac. Windows bundles symbol/emoji faces.
		await page.evaluate(async () => {
			const probe = document.createElement('div');
			probe.id = 'glyph-probe';
			probe.style.cssText = 'position:fixed;left:0;top:0;font-family:var(--sans);font-size:24px;white-space:nowrap';
			probe.textContent = '— · … → × ⌘ – − “ ” • ✓ ─ ⋯ ↑ ↓ ✗ ↵ ← ≤ › ⌄ │ ├ └ ▾ ● ⇒ ⚠ ➡️ ▸ ≥ π ✅ ❓ ₂ ⌫ ✕ ▴ ◫ ↺ ⇕ ά Ж Ā ł';
			document.body.append(probe);
		});
		// Chromium reports no faces for a node it has not painted yet.
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		const glyphCoverage = await platformFonts('#glyph-probe');
		assert(glyphCoverage.fonts.some(font => font.familyName === emoji && font.glyphCount > 0), JSON.stringify(glyphCoverage.fonts));
		if (!mac) assert(glyphCoverage.fonts.some(font => font.familyName === 'UI Symbols' && font.isCustomFont && font.glyphCount > 0), JSON.stringify(glyphCoverage.fonts));
		assert(glyphCoverage.fonts.some(font => font.isCustomFont && font.glyphCount > 0));
		await page.evaluate(() => document.querySelector('#glyph-probe')?.remove());
		if (process.platform !== 'darwin') {
			const controls = await page.locator('.desktop-window-controls').boundingBox();
			const width = await page.evaluate(() => innerWidth);
			assert.equal(Math.round(controls.x + controls.width), width, 'caption buttons align right');
			assert.equal(Math.round(controls.y), 0);
			const buttons = page.locator('.desktop-window-controls button');
			assert.equal(await buttons.count(), 3);
			assert(await buttons.last().evaluate(el => el.classList.contains('desktop-window-close')));
			assert((await buttons.first().boundingBox()).width >= 40);
		}
		assert(await page.locator('[data-tree-node=".ruff_cache"] .file-name').evaluate(el => getComputedStyle(el).fontFamily === getComputedStyle(el.closest('[data-tree-node]')).fontFamily), 'tree labels use the reference UI font');
		const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, platform: document.documentElement.dataset.platform, appearance: document.documentElement.dataset.appearance, bodySize: getComputedStyle(document.body).fontSize, fontSmoothing: getComputedStyle(document.body).webkitFontSmoothing, treeLabelWidth: (() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('[data-tree-node=".ruff_cache"] .file-name')); return range.getBoundingClientRect().width; })() }));
		assert.equal(metrics.fontSmoothing, 'antialiased');
		assert.equal(metrics.bodySize, '14px');
		assert.equal(metrics.width, 1440); assert.equal(metrics.height, 900); assert.equal(metrics.dpr, scale);
		for (const selector of ['.panel-right > .panel-title > span:first-child', '.bash-group-head > span']) for (const item of await page.locator(selector).all()) assert.equal(await item.evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
		await page.mouse.move(720, 880); await page.screenshot({ path: join(output, `${prefix}-conversation.png`) });
		const scroll = page.locator('.right-files-pane > .panel-body');
		await scroll.waitFor();
		assert(await scroll.evaluate(el => el.scrollHeight > el.clientHeight), 'fixture must exercise a real scroll container');
		const scrollbarState = () => scroll.evaluate(el => { const track = getComputedStyle(el, '::-webkit-scrollbar'), thumb = getComputedStyle(el, '::-webkit-scrollbar-thumb'); return { width: track.width, border: thumb.borderLeftWidth, radius: thumb.borderRadius, background: thumb.backgroundColor, scrollTop: el.scrollTop }; });
		// Chromium's computed custom-scrollbar pseudo style can remain transparent
		// while the hover thumb is painted. Sample the rendered track instead.
		const thumbRaster = async () => {
			const bounds = await scroll.boundingBox();
			const png = (await page.screenshot()).toString('base64');
			return page.evaluate(async ({ png, scale, bounds }) => { const img = new Image(); img.src = `data:image/png;base64,${png}`; await img.decode(); const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); const bytes = ctx.getImageData(Math.round((bounds.x + bounds.width - 4) * scale), Math.round(bounds.y * scale), 1, Math.floor(bounds.height * scale)).data; return Array.from({ length: Math.floor(bounds.height * scale) }, (_, y) => [...bytes.slice(y * 4, y * 4 + 4)]); }, { png, scale, bounds });
		};
		await page.mouse.move(720, 880);
		await page.waitForFunction(() => !document.querySelector('.right-files-pane > .panel-body').matches(':hover'));
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		const baseline = await thumbRaster();
		const paintedThumb = pixels => {
			const colors = new Map();
			for (let y = 0; y < pixels.length; y++) {
				if (!pixels[y].slice(0, 3).some((value, channel) => Math.abs(value - baseline[y][channel]) > 8)) continue;
				const key = pixels[y].join(','); const match = colors.get(key) ?? { pixel: pixels[y], rows: [] }; match.rows.push(y); colors.set(key, match);
			}
			const paint = [...colors.values()].sort((a, b) => b.rows.length - a.rows.length)[0];
			const counts = rows => [...rows.reduce((map, pixel) => { const key = pixel.join(','); map.set(key, (map.get(key) ?? 0) + 1); return map; }, new Map())].sort((a,b)=>b[1]-a[1]).slice(0,4);
			assert(paint && paint.rows.length > 4, `the rendered scrollbar thumb must be visible: ${JSON.stringify({baseline:counts(baseline),current:counts(pixels)})}`);
			return { pixel: paint.pixel, first: paint.rows[0] / scale, last: paint.rows.at(-1) / scale };
		};
		const resting = { ...await scrollbarState(), pixel: baseline[Math.round(12 * scale)] };
		assert.equal(resting.width, '8px'); assert.equal(parseFloat(resting.border), Math.floor(2 * scale) / scale, '2 CSS px borders are snapped to whole device pixels'); assert.equal(resting.radius, '4px'); assert.equal(resting.background, 'rgba(0, 0, 0, 0)');
		await scroll.hover();
		await page.waitForFunction(() => document.querySelector('.right-files-pane > .panel-body').matches(':hover'));
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		const hovered = { ...await scrollbarState(), ...paintedThumb(await thumbRaster()) };
		await page.screenshot({ path: join(output, `${prefix}-scrollbar.png`) });
		const bounds = await scroll.boundingBox();
		// Hit the observed thumb, not an assumed track offset: native geometry
		// and scrollbar minimum sizes differ across OS/DPI configurations.
		const grabY = bounds.y + (hovered.first + hovered.last) / 2;
		await page.mouse.move(bounds.x + bounds.width - 4, grabY); await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width - 4, grabY + 60, { steps: 8 });
		const dragged = { ...await scrollbarState(), ...paintedThumb(await thumbRaster()) };
		await page.screenshot({ path: join(output, `${prefix}-scrollbar-drag.png`) });
		await page.mouse.up(); assert(dragged.scrollTop > 0, 'scrollbar thumb can be dragged');
		assert(dragged.pixel[0] < hovered.pixel[0], `dragging darkens the thumb: ${JSON.stringify({ hovered, dragged })}`);


		const electronVersion = await app.evaluate(() => process.versions.electron);
		const typography = {}, surfaces = {};
		for (const appearance of ['light', 'dark']) {
			await page.evaluate(appearance => {
				const theme = appearance === 'dark' ? 'graphite' : 'warm';
				localStorage.setItem('pi-harness:theme', theme);
				window.dispatchEvent(new StorageEvent('storage', { key: 'pi-harness:theme' }));
			}, appearance);
			await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, appearance === 'dark' ? 'graphite' : 'warm');
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			for (const selector of ['.inputbox textarea', '[data-tree-node=".ruff_cache"] .file-name', '.msg-text h2', '.msg-text pre code', '.project-item.active']) {
				await sampleControl(appearance + selector, selector);
			}
			await sampleControl(appearance + '/send', '.inputbox button.send', true);
			await sampleControl(appearance + '/fileAction', '.right-files-pane .tree-menu-trigger', true);

			typography[appearance] = await page.evaluate(async () => {
				await document.fonts.ready;
				const samples = [];
				for (const weight of [400, 500, 600, 700]) for (const text of ['项目对话：检查文件与任务进度。', 'Workspace pi-harness 0123456789', '中文 English 混排：运行完成 123']) {
					const probe = document.createElement('div');
					probe.style.cssText = `position:fixed;left:0;top:0;width:180px;font-family:var(--sans);font-size:14px;font-weight:${weight};line-height:22px;visibility:hidden`;
					probe.textContent = text; document.body.append(probe);
					const range = document.createRange(); range.selectNodeContents(probe);
					const style = getComputedStyle(probe);
					samples.push({ text, weight, family: style.fontFamily, size: style.fontSize, color: style.color, lines: [...range.getClientRects()].map(rect => ({ width: rect.width, height: rect.height })) });
					probe.remove();
				}
				return samples;
			});
			// Measure real stylesheet contexts at a fixed width, excluding native titlebar geometry.
			surfaces[appearance] = await page.evaluate(async () => {
				const host = document.createElement('div');
				host.style.cssText = 'position:fixed;left:0;top:0;width:640px;visibility:hidden';
				const text = '项目文档 Workspace：检查文件与任务进度，运行完成 123。';
				const contexts = {
					wiki: '<div class="wiki-prose md"><p></p><h2></h2><table><tbody><tr><td></td></tr></tbody></table></div>',
					notes: '<div class="notes-preview md"><p></p><h2></h2></div>',
					file: '<div class="fp-markdown"><div class="md"><p></p><h2></h2></div></div>',
					settings: '<div class="system-prompt-panel"><p></p></div>',
					extensions: '<div class="extensions-panel"><p></p></div>',
					search: '<div class="wiki-search-modal"><input></div>',
					insert: '<div class="fp-slash-menu"><span></span></div>',
				};
				document.body.append(host);
				try {
					const result = {};
					for (const [name, html] of Object.entries(contexts)) {
						host.innerHTML = html;
						for (const el of host.querySelectorAll('p,h2,td,span,input')) {
							if (el instanceof HTMLInputElement) el.value = text; else el.textContent = text;
						}
						await document.fonts.ready;
						result[name] = [...host.querySelectorAll('p,h2,td,span,input')].map(el => {
							const cs = getComputedStyle(el), rect = el.getBoundingClientRect();
							const range = document.createRange(); range.selectNodeContents(el);
							return { tag: el.tagName, family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, lineHeight: cs.lineHeight, color: cs.color, background: cs.backgroundColor, radius: cs.borderRadius, width: rect.width, height: rect.height, lines: [...range.getClientRects()].map(r => ({ width: r.width, height: r.height })) };
						});
					}
					return result;
				} finally { host.remove(); }
			});
			await page.mouse.move(720, 880);
			await page.screenshot({ path: join(output, `${prefix}-${appearance}.png`) });
		}

		// Use real component nodes to verify the cascade and the glyph faces that actually painted.
		await measureFonts('code', '.msg-text pre code', mac
			? ['JetBrains Mono', emoji]
			: ['JetBrains Mono', 'UI SC', emoji]);
		await page.locator('.topbar-more .chip').click();
		await page.locator('.dd-menu').getByRole('button', { name: '所有设置', exact: true }).click();
		await sampleControl('settingsTab', '.settings-tab.active', true);
		await measureFonts('settingsTab', '.settings-tab.active .settings-tab-label', ['UI SC']);
		await page.keyboard.press('Escape');
		await page.locator('.settings-modal').waitFor({ state: 'hidden' });

		// Replay deterministic mixed-language output into the actual xterm renderer.
		assert(activeConversationId);
		socketRoute.send(JSON.stringify({ type: 'terminal_list', conversationId: activeConversationId, terminals: [
			{ id: 'render-terminal', title: 'Rendering', cwd, cols: 80, rows: 24, running: true, exitCode: null },
		] }));
		await page.getByRole('tab', { name: '终端', exact: true }).click();
		const rows = page.locator('.term-xterm:not(.hidden) .xterm-rows > div');
		const terminalRow = rows.filter({ hasText: 'Render' }).first();
		await terminalRow.waitFor();
		await terminalRow.evaluate(el => el.dataset.renderSample = 'terminal');
		await page.evaluate(() => document.fonts.ready);
		await measureFonts('terminal', '[data-render-sample="terminal"]', mac
			? [['SF Mono', '.SF NS Mono', 'JetBrains Mono'], emoji]
			: ['JetBrains Mono', 'UI SC', emoji]);
		// xterm computes per-DPI glyph spacing and line boxes after fitting.
		// Compare the font and active terminal palette independently of that adjustment.
		ui.terminal = await terminalRow.evaluate(row => {
			const { fontFamily, fontSize, fontWeight, color } = getComputedStyle(row);
			return { fontFamily, fontSize, fontWeight, color };
		});
		await page.screenshot({ path: join(output, `${prefix}-terminal.png`) });

		await page.getByRole('tab', { name: '对话', exact: true }).click();
		await page.getByRole('button', { name: '小记', exact: true }).click();
		await page.getByRole('button', { name: '新建小记', exact: true }).first().click();
		const noteEditor = page.locator('.notes-editor .fp-rich-document');
		await noteEditor.fill(mixed);
		await page.evaluate(() => document.fonts.ready);
		await measureFonts('notes', '.notes-editor .fp-rich-document', ['UI SC', emoji]);
		await sampleControl('noteTitle', '.notes-editor .note-title');
		await sampleControl('noteBody', '.notes-editor .fp-rich-document');
		await noteEditor.blur();
		await page.locator('.notes-editor [role=status]').filter({ hasText: '已保存' }).waitFor();
		await page.screenshot({ path: join(output, `${prefix}-notes.png`) });

		await page.getByRole('button', { name: 'Playground', exact: true }).click();
		const editor = page.locator('.scratch-editor-cm .cm-content');
		await editor.fill(`print("${mixed}")\n# ${mixed}`);
		const line = '.scratch-editor-cm .cm-line';
		await page.locator(line).filter({ hasText: `# ${mixed}` }).waitFor();
		await page.evaluate(() => document.fonts.ready);
		const regular = await measureFonts('playground', line, ['JetBrains Mono', 'PI Playground CJK', emoji]);
		const italic = await measureFonts('playgroundComment', line + ':nth-child(2)', ['JetBrains Mono', 'PI Playground CJK', emoji]);
		const sarasaFace = fonts => fonts.find(font => font.familyName === 'PI Playground CJK' && font.isCustomFont)?.postScriptName;
		assert(sarasaFace(regular) && sarasaFace(italic) && sarasaFace(regular) !== sarasaFace(italic), 'editor uses separate bundled regular and italic Sarasa glyphs');
		await sampleControl('playground', line);
		await page.screenshot({ path: join(output, `${prefix}-playground.png`) });

		// Exercise the dedicated document reader with its actual typography selectors.
		const wikiUrl = new URL(page.url());
		wikiUrl.searchParams.set('wiki-window', '1');
		wikiUrl.searchParams.set('cwd', cwd);
		wikiUrl.searchParams.set('doc', 'README.md');
		await page.goto(wikiUrl.href);
		const paragraph = '.wiki-prose .fp-rich-document p';
		await page.locator(paragraph).first().waitFor();
		await page.evaluate(() => document.fonts.ready);
		await measureFonts('wiki', paragraph, ['UI SC']);
		await sampleControl('wiki', paragraph);
		await page.screenshot({ path: join(output, `${prefix}-wiki.png`) });
		assert.deepEqual(failures, [], 'all requested font resources loaded');
		writeFileSync(join(output, `${prefix}-metrics.json`), JSON.stringify({ ...metrics, electron: electronVersion, faces, ui, typography, surfaces, nativeWindow, fonts, renderedFonts: rendered.fonts, glyphCoverage: glyphCoverage.fonts, monoFonts: monoFonts.fonts, scrollbar: { resting, hovered, dragged } }, null, 2));
		await app.close(); app = undefined;
		console.log(`PASS actual ${prefix} Electron: platform, fonts, SVG icons, labels, 1440x900 screenshots`);
	}
} finally { await app?.close().catch(() => {}); rmSync(base, { recursive: true, force: true }); }
