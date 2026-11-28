// Codex-style command group display (bash-group-codex-style): a pure command
// group collapses to "[terminal icon] 运行了命令" and expands to a guide-lined
// list of "[terminal icon] command…" rows. Model-free, deterministic fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';
const port = 9417;
assert.equal(await portUp(port), false, `Port ${port} busy`);
const root = mkdtempSync(join(tmpdir(), 'pi-codex-bash-'));
const cwd = join(root, 'workspace'); mkdirSync(cwd);
writeFileSync(join(cwd, 'README.md'), '# Codex bash group review\n');
const time = Date.now();
const bash = (id, command) => ({ type: 'toolCall', id, name: 'bash', argumentsText: JSON.stringify({ command }) });
const result = (call, text = 'ok\n') => ({ id: `r-${call.id}`, role: 'toolResult', toolCallId: call.id, toolName: 'bash', isError: false, details: { exitCode: 0 }, content: [{ type: 'text', text }] });
const assistant = (id, ...content) => ({ id, role: 'assistant', timestamp: time, content });
const user = (id, text) => ({ id, role: 'user', timestamp: time, content: [{ type: 'text', text }] });
const pure = [bash('p0', `cd '${cwd}' && ls -la`), bash('p1', `cd '${cwd}' && git status`), bash('p2', 'rg -n todo src'), bash('p3', 'cat server/security-headers.ts; echo "=== token-auth ===" && cat server/token-auth.ts && cat tests/unit/token-auth.test.ts && rg -n "token-auth" server web tests docs && git log -3 --oneline -- server/token-auth.ts')];
const pureTranscript = () => [user('u-pure', '看看项目'), ...pure.flatMap(c => [assistant(`a-${c.id}`, c), result(c)])];
let server, browser;
const attach = async (page) => {
	let socket, base, fixture = null;
	await page.routeWebSocket('**/ws', route => {
		socket = route; const upstream = route.connectToServer();
		route.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (['prompt', 'abort', 'recall_queue'].includes(message.type)) {
				if (message.type === 'prompt') route.send(JSON.stringify({ type: 'prompt_result', requestId: message.requestId, conversationId: base.state.conversationId, ok: true }));
				return;
			}
			upstream.send(wire);
		});
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === 'snapshot') {
				base = message;
				message.state.piConfigured = true;
				// Re-inject the fixture into every server snapshot so periodic real
				// snapshots cannot wipe the mocked transcript/streaming state.
				if (fixture) Object.assign(message.state, fixture);
			}
			if (message.type !== 'snapshot_delta') route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://localhost:${port}`);
	await page.locator('.inputbox textarea').first().waitFor();
	for (let i = 0; i < 100 && !base; i++) await sleep(100);
	assert(base, 'initial snapshot captured');
	const send = async (messages, extra = {}) => {
		fixture = { messages, isStreaming: false, streamingMessage: null, ...extra };
		const snap = structuredClone(base);
		Object.assign(snap.state, fixture);
		snap.state.rev += 1;
		socket.send(JSON.stringify(snap));
	};
	return { send };
};
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = ''; server.stderr.on('data', d => log += d); server.stdout.on('data', d => log += d);
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	assert(await portUp(port), log);
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	const page = await context.newPage(); page.setDefaultTimeout(10000);
	const errors = []; page.on('pageerror', e => errors.push(e.message));
	const { send } = await attach(page);

	// A) Pure group collapsed: headless line with icon + plain label + chevron, no count.
	await send(pureTranscript());
	const summary = page.locator('.process-group-summary-line').first();
	await summary.waitFor();
	assert.match(await summary.innerText(), /运行了命令/);
	assert.doesNotMatch(await summary.innerText(), /\d/, 'pure command header drops the count');
	assert.equal(await page.locator('.process-group-head').count(), 0, 'collapsed successful group is headless');
	assert.equal(await summary.locator('.process-group-icon').count(), 1);
	assert.equal(await summary.locator('.process-group-icon').evaluate(el => getComputedStyle(el).width), '16px');
	assert.equal(await summary.locator('.process-group-icon').evaluate(el => getComputedStyle(el).height), '16px');
	assert.equal(await summary.locator('.process-group-icon').evaluate(el => getComputedStyle(el).borderTopWidth), '0px', 'tool icons are borderless');
	assert.equal(await summary.locator('.process-group-chevron').count(), 0, 'collapsed GPT-style group has no chevron');
	assert.equal(await summary.locator('.process-group-summary-text').evaluate(el => getComputedStyle(el).backgroundImage), 'none', 'completed title uses solid gray, not a streaming gradient');
	assert.equal(await summary.locator('.process-group-summary-text').evaluate(el => getComputedStyle(el).animationName), 'none');
	await send(pureTranscript(), { isStreaming: true, streamingMessage: assistant('reply', { type: 'text', text: '这个' }) });
	await summary.locator('.streaming-color').waitFor();
	assert.equal(await summary.locator('.process-group-summary-text').evaluate(el => getComputedStyle(el).animationName), 'waiting-text-shimmer');
	await send(pureTranscript());
	await summary.locator('.streaming-color').waitFor({ state: 'detached' });
	const quietColor = await summary.locator('.process-group-summary-text').evaluate(el => getComputedStyle(el).color);
	const quietIconColor = await summary.locator('.process-group-icon').evaluate(el => getComputedStyle(el).color);
	await summary.screenshot({ path: '/tmp/pi-codex-bash-collapsed-light.png' });

	// B) Expand: header icon + adjacent chevron, guide-lined rows with terminal marks.
	await summary.click();
	const head = page.locator('.process-group-head').first();
	await head.waitFor();
	await page.mouse.move(1000, 500);
	assert.equal(await head.getAttribute('aria-expanded'), 'true');
	assert.equal(await head.locator('.process-group-icon').count(), 1);
	assert.equal(await head.locator('.process-group-icon').evaluate(el => getComputedStyle(el).width), '16px');
	assert.equal(await head.locator('.process-group-icon').evaluate(el => getComputedStyle(el).color), quietIconColor);
	assert.equal(await head.locator('.process-group-summary').evaluate(el => getComputedStyle(el).color), quietColor);
	assert.equal(await head.evaluate(el => getComputedStyle(el).fontWeight), '400');
	assert.equal(await head.evaluate(el => getComputedStyle(el).fontSize), '14px');
	assert.equal(await head.evaluate(el => getComputedStyle(el).lineHeight), '20px');
	assert(['0px', 'normal'].includes(await head.evaluate(el => getComputedStyle(el).letterSpacing)));
	assert.equal(await head.locator('.process-group-chevron').count(), 1);
	await page.locator('.bash-row.ok').first().waitFor();
	const commandRgb = await page.locator('.bash-row.ok .bash-row-subtitle').first().evaluate(el => {
		const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
		const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 1, 1);
		context.fillStyle = getComputedStyle(el).color; context.fillRect(0, 0, 1, 1);
		return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
	});
	assert.deepEqual(commandRgb, [100, 99, 103], 'command text uses #646367 on white');
	assert.equal(await page.locator('.bash-row.ok').count(), 4);
	assert.equal(await page.locator('.bash-row.ok .bash-row-icon').count(), 4, 'row icons stay in the DOM');
	assert.equal(await page.locator('.bash-row.ok .bash-state').first().evaluate(el => getComputedStyle(el).display), 'none', 'expanded group children drop the repeated terminal icon (parent icon carries the tool type)');
	assert.equal(await page.locator('.bash-row.ok .bash-state').filter({ hasText: '✓' }).count(), 0);
	assert.equal(await page.locator('.bash-row.ok :is(.bash-row-title, .bash-row-sep, .bash-row-stats, .bash-extra-lines)').count(), 0, 'successful rows contain only the command');
	// GPT-style rows: the chevron slot exists but stays invisible until hover/focus/expand.
	const rowArrow = page.locator('.bash-row.ok .bash-row-head > svg').first();
	assert.equal(await page.locator('.bash-row.ok .bash-row-head > svg').count(), 4, 'every successful row reserves the chevron slot');
	await page.mouse.move(1000, 900);
	assert.equal(await rowArrow.evaluate(el => getComputedStyle(el).opacity), '0', 'successful rows hide the chevron at rest');
	assert.equal(await page.locator('.process-group.open .process-group-rows').first().evaluate(el => getComputedStyle(el).borderLeftWidth), '1px', 'expanded list hangs on a left guide line');
	// 行列表贴着引导线：线到命令文字只留 14px（曾为 32px，用户反馈太宽）。
	const indent = await page.evaluate(() => {
		const rows = document.querySelector('.process-group.open .process-group-rows').getBoundingClientRect();
		const text = document.querySelector('.bash-row.ok .bash-row-subtitle').getBoundingClientRect();
		return Math.round(text.left - (rows.left + 1));
	});
	assert(indent <= 16 && indent >= 8, `guide line to command text gap stays tight (got ${indent}px)`);
	const cmd = page.locator('[data-tool-call-id="p2"] .bash-row-subtitle');
	assert.equal(await cmd.textContent(), 'rg -n todo src');
	assert.equal(await cmd.evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
	assert.equal(await cmd.evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis');
	assert.match(await cmd.evaluate(el => getComputedStyle(el).fontFamily), /JetBrains Mono/);
	assert.equal(await cmd.evaluate(el => getComputedStyle(el).fontWeight), '400');
	assert.equal(await cmd.evaluate(el => getComputedStyle(el).fontSize), '12.5px');
	assert.equal(await cmd.evaluate(el => getComputedStyle(el).lineHeight), '20px');
	assert(['0px', 'normal'].includes(await cmd.evaluate(el => getComputedStyle(el).letterSpacing)));
	const titleX = await head.locator('.process-group-summary').evaluate(el => el.getBoundingClientRect().left);
	const commandX = await cmd.evaluate(el => el.getBoundingClientRect().left);
	assert(Math.round(commandX - titleX) >= -4 && Math.round(commandX - titleX) <= 4, `iconless command text aligns with the title (got ${Math.round(commandX - titleX)}px)`);
	const firstRowBox = await page.locator('.bash-row.ok .bash-row-head').nth(0).boundingBox();
	const secondRowBox = await page.locator('.bash-row.ok .bash-row-head').nth(1).boundingBox();
	assert.equal(Math.round(secondRowBox.y + secondRowBox.height / 2 - firstRowBox.y - firstRowBox.height / 2), 37, 'command row centers are 37px apart');
	assert.notEqual(await head.locator('.process-group-chevron').evaluate(el => getComputedStyle(el).transform), 'none');
	const restCommandColor = await cmd.evaluate(el => getComputedStyle(el).color);
	await page.locator('[data-tool-call-id="p2"] .bash-row-head').hover();
	assert.notEqual(await cmd.evaluate(el => getComputedStyle(el).color), restCommandColor, 'hovered command darkens like the reference');
	assert.equal(await page.locator('[data-tool-call-id="p2"] .bash-row-head').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'hover adds no background wash');
	await page.waitForTimeout(200);
	assert.equal(await page.locator('[data-tool-call-id="p2"] .bash-row-head > svg').evaluate(el => getComputedStyle(el).opacity), '1', 'hover reveals the trailing chevron');
	// Long commands end-truncate: the text keeps the whole first line and CSS clips it,
	// instead of the old «first 28 chars … last 48 chars» middle ellipsis.
	const longRow = page.locator('[data-tool-call-id="p3"] .bash-row-subtitle');
	assert.equal(await longRow.textContent(), 'cat server/security-headers.ts; echo "=== token-auth ===" && cat server/token-auth.ts && cat tests/unit/token-auth.test.ts && rg -n "token-auth" server web tests docs && git log -3 --oneline -- server/token-auth.ts');
	assert.doesNotMatch(await longRow.textContent(), /…/, 'row text is not truncated in the middle');
	assert(await longRow.evaluate(el => el.scrollWidth > el.clientWidth), 'clipping happens at the row edge');
	await page.locator('.process-group').first().screenshot({ path: '/tmp/pi-codex-bash-reference-hover.png' });
	await page.mouse.move(1000, 500);

	// C) Row click opens the detail card; header click collapses.
	await page.locator('[data-tool-call-id="p2"] .bash-row-head').click();
	await page.locator('[data-tool-call-id="p2"] .bash-request-code').waitFor();
	assert.match(await page.locator('[data-tool-call-id="p2"] .bash-request-code').textContent(), /rg -n todo src/);
	assert.match(await page.locator('[data-tool-call-id="p2"] .bash-shell-card .bash-detail-heading').innerText(), /Shell/);
	assert.equal(await page.locator('[data-tool-call-id="p2"] .bash-request-card').count(), 0);
	assert.equal(await page.locator('[data-tool-call-id="p2"] .bash-response-card .bash-detail-heading').count(), 0);
	assert.equal(await page.locator('[data-tool-call-id="p2"] .bash-shell-status').count(), 0);
	assert.equal(await page.locator('[data-tool-call-id="p2"] .bash-row-body').evaluate(el => getComputedStyle(el).borderLeftWidth), '0px', 'Shell detail has no outer border');
	assert(await page.locator('[data-tool-call-id="p2"] .bash-row-body').evaluate(el => { const style = getComputedStyle(el); return style.borderLeftColor === style.borderTopColor; }), 'detail guide matches the other card borders');
	await head.click();
	await page.locator('.process-group-summary-line').first().waitFor();
	assert.equal(await page.locator('.bash-row:visible').count(), 0);

	// D) Keyboard Enter expands; pi:reveal-tool jumps open.
	await page.locator('.process-group-summary-line').first().focus();
	await page.keyboard.press('Enter');
	await page.locator('.bash-row').first().waitFor();
	await page.locator('.process-group-head').first().click();
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pi:reveal-tool', { detail: { toolCallId: 'p0' } })));
	await page.locator('[data-tool-call-id="p0"] .bash-row-body').waitFor();

	// E) Mixed group (thinking + commands) uses the plain label without count or collapsed thought time.
	const mixed = [assistant('a-mix', { type: 'thinking', thinking: 'plan', durationMs: 2000 }, bash('m0', 'echo a'), bash('m1', 'echo b')), result(bash('m0', 'echo a')), result(bash('m1', 'echo b'))];
	await send([user('u-mix', '混合'), ...mixed]);
	const mixSummary = page.locator('.process-group-summary-line').first();
	await mixSummary.waitFor();
	assert.match(await mixSummary.innerText(), /运行了命令/, 'mixed group uses the plain Codex label');
	assert.doesNotMatch(await mixSummary.innerText(), /已运行|\d+ 条命令/, 'command count is dropped');
	assert.doesNotMatch(await mixSummary.innerText(), /Thought/, 'collapsed thought time is omitted like GPT Desktop');
	assert.equal(await page.locator('.thinking:not(.live)').count(), 0, 'settled thought rows are removed entirely');
	await mixSummary.click();
	const mixHead = page.locator('.process-group-head').first();
	await mixHead.waitFor();
	assert.equal(await mixHead.locator('.process-group-thought').count(), 0, 'expanded settled header has no thought summary');
	assert.equal(await mixHead.locator('.process-group-dot').count(), 0);
	await page.locator('.process-group').first().screenshot({ path: '/tmp/pi-codex-bash-mixed-expanded.png' });

	// F) Single command: a quiet label row above the gray command block.
	const single = bash('s0', 'echo single');
	await send([user('u-single', '单条'), assistant('a-s0', single), result(single)]);
	await page.locator('.single-command .bash-row.ok').first().waitFor();
	const singleHead = page.locator('.process-group.single-command > .process-group-head.single-head');
	assert.equal(await singleHead.count(), 1, 'settled single command keeps a quiet label row');
	assert.match(await singleHead.innerText(), /运行了命令/);
	assert.equal(await singleHead.locator('.process-group-chevron').count(), 0, 'the label row has no chevron');
	assert.equal(await singleHead.evaluate(el => el.tagName), 'DIV', 'the label row is not clickable');
	assert.equal(await page.locator('.process-group-summary-line').count(), 0);
	assert.equal(await page.locator('.single-command .bash-row.ok .bash-state').first().evaluate(el => getComputedStyle(el).display), 'none', 'the gray command block drops the repeated terminal icon');
	const blockStyle = await page.locator('.single-command .bash-row.ok > .bash-row-head').first().evaluate(el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, radius: s.borderRadius, paddingLeft: s.paddingLeft }; });
	assert.notEqual(blockStyle.bg, 'rgba(0, 0, 0, 0)', 'single command row is a filled block');
	assert.equal(blockStyle.radius, '8px', 'command block uses the diff-card radius');
	assert.equal(blockStyle.paddingLeft, '12px', 'command text starts at the block padding');
	const labelX = await singleHead.locator('.process-group-summary').evaluate(el => el.getBoundingClientRect().x);
	const blockX = await page.locator('.single-command .bash-row.ok > .bash-row-head').first().evaluate(el => el.getBoundingClientRect().x);
	assert(Math.abs(labelX - blockX) <= 1, `gray block aligns under the label text (Δ=${Math.abs(labelX - blockX)}px)`);
	const commandText = page.locator('.single-command .bash-row-subtitle > span').first();
	assert.equal(await commandText.evaluate(el => getComputedStyle(el).animationName), 'none');
	await send([user('u-single-live', '运行单条')], { isStreaming: true, streamingMessage: assistant('a-single-live', single) });
	await page.locator('.single-command .bash-row.run').first().waitFor();
	assert.equal(await commandText.evaluate(el => getComputedStyle(el).animationName), 'waiting-text-shimmer');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	assert.equal(await commandText.evaluate(el => getComputedStyle(el).animationName), 'none');
	await page.emulateMedia({ reducedMotion: 'no-preference' });

	await send([user('u-fast', '快速命令'), assistant('a-first', pure[0]), result(pure[0]), assistant('a-next', {type:'text', text:'Checking diff'}, single), result(single)], {isStreaming:true});
	const current = page.locator('[data-tool-call-id="s0"] .current-command-step');
	await current.waitFor();
	assert.equal(await current.evaluate(el => getComputedStyle(el).animationName), 'waiting-text-shimmer');
	assert.equal(await page.locator('[data-tool-call-id="p0"] .bash-row-subtitle > span').evaluate(el => getComputedStyle(el).animationName), 'none');

	await send(pureTranscript(), { isStreaming: true });
	const group = page.locator('.process-group').first();
	await group.locator('.process-group-summary-line .streaming-color').waitFor();
	await group.locator('.process-group-summary-line').click();
	const labels = group.locator('.bash-row-subtitle > span');
	await labels.last().waitFor();
	assert.equal(await labels.count(), pure.length);
	assert.deepEqual(await labels.evaluateAll(nodes => nodes.map(el => getComputedStyle(el).animationName)),
		pure.map((_, i) => i === pure.length - 1 ? 'waiting-text-shimmer' : 'none'));

	await group.locator(".process-group-head").click();
	await group.locator(".process-group-summary-line").waitFor();

	const shimmerFrame = async (label, fraction) => {
		await label.evaluate((el, fraction) => {
			const animation = el.getAnimations()[0];
			animation.pause();
			animation.currentTime = animation.effect.getTiming().duration * fraction;
		}, fraction);
		return label.screenshot();
	};

	// An invisible failed attempt after a long command must not steal its highlight.
	const many = Array.from({ length: 35 }, (_, i) => bash(`many-${i}`, i === 34 ? 'grep ' + 'directory/file '.repeat(80) : `echo ${i}`));
	const hidden = bash('hidden-failure', 'false');
	await send([user('many', '检查项目'), ...many.flatMap(c => [assistant(`a-${c.id}`, c), result(c)]), assistant('a-hidden', hidden), { ...result(hidden), isError: true }], { isStreaming: true });
	await group.locator('.process-group-summary-line').click();
	const lastVisible = group.locator('.bash-row-subtitle > span').last();
	assert.equal(await group.locator('.bash-row').count(), 8);
	assert.equal(await group.locator('.process-group-summary').evaluate(el => getComputedStyle(el).animationName), 'waiting-text-shimmer');
	assert.equal(await lastVisible.evaluate(el => getComputedStyle(el).animationName), 'waiting-text-shimmer');
	assert(await lastVisible.evaluate(el => el.scrollWidth > el.clientWidth && el.clientWidth > 0 && el.clientWidth <= el.parentElement.clientWidth), 'text shimmer fits the visible portion of the truncated command');
	for (const label of [group.locator('.process-group-summary'), lastVisible]) {
		assert(!(await shimmerFrame(label, 0)).equals(await shimmerFrame(label, 0.5)), 'visible glyphs change during the sweep');
	}

	// G) Running group auto-expands with the plain label and neutral running feedback.
	const done = bash('r0', 'echo done');
	const live = bash('live', 'sleep 5');
	await send([...pureTranscript(), assistant('next-section', { type: 'text', text: '接下来运行检查。' }), assistant('a-r0', done), result(done)], { isStreaming: true, streamingMessage: assistant('a-live', live, { type: 'thinking', thinking: 'Check the current state' }) });
	const runHead = page.locator('.process-group.run .process-group-head').first();
	await runHead.waitFor();
	const completedTitle = page.locator('.process-group-summary-line .process-group-summary-text').first();
	assert.equal(await completedTitle.evaluate(el => getComputedStyle(el).animationName), 'none', 'earlier commands stay static while the next group runs');
	const shimmerTitle = runHead.locator('.process-group-summary');
	const firstFrame = await shimmerFrame(shimmerTitle, 0);
	const middleFrame = await shimmerFrame(shimmerTitle, 0.5);
	assert(!firstFrame.equals(middleFrame), 'running summary changes painted glyphs during the sweep');
	assert.match(await runHead.innerText(), /运行了命令/);
	assert.equal(await runHead.getAttribute('aria-expanded'), 'true');
	assert.equal(await runHead.locator('.process-group-status').count(), 0);
	assert.equal(await runHead.locator('.process-group-summary').evaluate(el => getComputedStyle(el).animationName), 'waiting-text-shimmer', 'command group title shimmers while running');
	assert.equal(await runHead.locator('.process-group-thought').evaluate(el => getComputedStyle(el).animationName), 'waiting-text-shimmer', 'thought suffix shimmers while running');
	await page.locator('.bash-row.run').first().waitFor();
	assert.equal(await page.locator('.bash-row.run .bash-row-icon').count(), 1, 'running rows keep the neutral terminal mark');
	assert.equal(await page.locator('.process-group .running-indicator').count(), 0, 'no green lights remain in the running process group');
	assert.equal(await page.locator('.bash-row.run .bash-row-stats').evaluate(el => getComputedStyle(el).animationName), 'waiting-text-shimmer');
	const liveThought = page.locator('.thinking.live').first();
	await liveThought.waitFor();
	assert.equal(await liveThought.locator('.running-indicator').count(), 0);
	assert.equal(await liveThought.locator('.thinking-label').evaluate(el => getComputedStyle(el).animationName), 'waiting-text-shimmer');
	assert.match(await liveThought.locator('.thinking-status').innerText(), /^用时 \d+ 秒/);
	const liveStatus = liveThought.locator('.thinking-status');
	const liveSummary = liveThought.locator('.thinking-summary');
	assert.equal(await liveSummary.innerText(), 'Check the current state');
	for (const element of [liveStatus, liveSummary]) {
		assert.equal(await element.evaluate(el => getComputedStyle(el).fontSize), '13px');
		assert.equal(await element.evaluate(el => getComputedStyle(el).fontWeight), '400');
		assert.equal(await element.evaluate(el => getComputedStyle(el).fontStyle), 'normal');
		assert.equal(await element.evaluate(el => getComputedStyle(el).lineHeight), '20px');
	}
	assert.equal(await liveSummary.evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
	assert.equal(await liveSummary.evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis');
	const statusBox = await liveStatus.boundingBox();
	const summaryBox = await liveSummary.boundingBox();
	assert(summaryBox.y >= statusBox.y + statusBox.height, 'summary sits on the second line');
	await liveThought.locator('.thinking-toggle').click();
	assert.equal(await liveThought.locator('.thinking-toggle').getAttribute('aria-expanded'), 'true');
	assert.equal(await liveThought.locator('.thinking-body').innerText(), 'Check the current state');
	assert.equal(await liveSummary.count(), 0);
	await liveThought.locator('.thinking-toggle').click();
	await liveSummary.waitFor();
	assert.equal(await runHead.evaluate(el => getComputedStyle(el, '::after').content), 'none');
	assert.equal(await runHead.evaluate(el => getComputedStyle(el, '::before').content), '""', 'the only ::before is the timeline dot');
	await page.screenshot({ path: '/tmp/pi-codex-bash-running.png' });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	assert.equal(await runHead.evaluate(el => getComputedStyle(el, '::after').content), 'none');
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await send([user('u-technical', '技术输出')], { isStreaming: true, streamingMessage: assistant('a-technical', { type: 'thinking', thinking: 'npm run build' }) });
	const technicalThought = page.locator('.thinking.live').first();
	await technicalThought.waitFor();
	assert.match(await technicalThought.locator('.thinking-status').innerText(), /^用时 \d+ 秒$/);
	assert.equal(await technicalThought.locator('.thinking-summary').count(), 0, 'technical-only content has no summary');
	assert.equal(await technicalThought.locator('.thinking-toggle').count(), 0, 'technical-only content has no empty disclosure');
	assert.equal(await technicalThought.locator('.thinking-body').count(), 0);

	// H) English locale uses "Ran commands" (isolated context, no reload race).
	const enContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	await enContext.addInitScript(() => localStorage.setItem('pi-harness:lang', 'en'));
	const enPage = await enContext.newPage(); enPage.setDefaultTimeout(10000);
	const en = await attach(enPage);
	await en.send(pureTranscript());
	await enPage.locator('.process-group-summary-line').first().waitFor();
	assert.match(await enPage.locator('.process-group-summary-line').first().innerText(), /Ran commands/);
	assert.equal(await enPage.locator('.process-group-summary-line .process-group-icon').count(), 1);
	await en.send([user('u-en-thinking', 'Thinking')], { isStreaming: true, streamingMessage: assistant('a-en-thinking', { type: 'thinking', thinking: 'Check the current state' }) });
	await enPage.locator('.thinking.live').waitFor();
	assert.match(await enPage.locator('.thinking.live .thinking-status').innerText(), /^Elapsed \d+s/);
	assert.equal(await enPage.locator('.thinking.live .thinking-summary').innerText(), 'Check the current state');
	await enContext.close();

	// I) Dark mode + narrow viewports: icon stays, no horizontal overflow, no page errors.
	await send(pureTranscript());
	await page.locator('.process-group-summary-line').first().waitFor();
	await page.evaluate(() => document.documentElement.dataset.platform = 'darwin');
	await page.locator('.process-group-summary-line').first().click();
	const macCommand = page.locator('.bash-row.ok .bash-row-subtitle').first();
	await macCommand.waitFor();
	assert.match(await macCommand.evaluate(el => getComputedStyle(el).fontFamily), /JetBrains Mono/, 'macOS command summaries use the monospace stack');
	assert.equal(await macCommand.evaluate(el => getComputedStyle(el).fontWeight), '400');
	assert.equal(await macCommand.evaluate(el => getComputedStyle(el).fontSize), '12.5px');
	await page.mouse.move(1000, 500);
	await page.locator('.process-group').first().screenshot({ path: '/tmp/pi-codex-bash-command-font.png' });
	await page.locator('.process-group-head').first().click();
	await page.locator('.process-group-summary-line').first().waitFor();
	await page.evaluate(() => document.documentElement.dataset.appearance = 'dark');
	await page.waitForTimeout(250);
	assert.equal(await page.locator('.process-group-summary-line .process-group-icon').count(), 1);
	for (const width of [900, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await page.waitForTimeout(250);
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow at ${width}`);
	}
	await page.screenshot({ path: '/tmp/pi-codex-bash-dark.png' });
	await page.evaluate(() => document.documentElement.dataset.appearance = 'light');
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.locator('.process-group-summary-line').first().click();
	await page.locator('.bash-row.ok').first().waitFor();
	assert.equal(await page.locator('.process-group-head').first().evaluate(el => getComputedStyle(el, '::after').content), 'none', 'completed groups do not retain the running line');
	await page.screenshot({ path: '/tmp/pi-codex-bash-light.png' });
	assert.deepEqual(errors, []);
	console.log('PASS Codex-style command group: collapsed icon line, guide-lined rows, detail card, keyboard/reveal, mixed plain label, single row, running, en locale, dark/narrow');
} finally {
	await browser?.close().catch(() => {});
	server?.kill('SIGTERM');
	await sleep(300);
	rmSync(root, { recursive: true, force: true });
}