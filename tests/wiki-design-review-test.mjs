// Markdown editor design review: production layout, isolated files and no model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';

const port = 9318;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-issues-'));
const longName = 'CODING_STANDARD-long-document-name-with-full-path.md';
const command = 'rsync -az --delete ' + Array.from({length: 12}, (_,i)=>`--exclude long-directory-${i}`).join(' ') + ' ./source remote:/opt/workbench/';
const original = '---\ntitle: Wiki 排版与工具栏对齐语雀：混合中英文 Long document title 展示与编辑验证\nowner: 较长属性值用于验证窄窗口换行与内容层级 Long property value without changing document bytes\n---\n\n# Markdown 编辑器优化\n\nOwner: 较长属性值用于验证窄窗口换行 Long property value\nStatus: Draft\n\n- 普通列表 ordinary list\n- [ ] 待办任务 task item\n\n正文行距应该紧凑，表格根据内容排列，代码保持完整。\n\n## 功能约定\n\n| 模块 | 描述 | 状态 |\n| --- | --- | --- |\n| 文档 | 自动保存与原生编辑器的光标和撤销行为保持一致 | 已完成 |\n| 索引 | 目录导航与反向链接使用当前工作区 | 待处理 |\n\n| Name | Status |\n| --- | ---: |\n| Explicit | Right |\n\n## 部署演练\n\n```bash\n' + command + '\n```\n';
writeFileSync(join(base,'note.md'), original);
writeFileSync(join(base,longName),'# Long filename\n');
writeFileSync(join(base,'backlink.md'),'# Ref\n\n[Note](./note.md)\n');
writeFileSync(join(base,'large.md'),'x'.repeat(3*1024*1024));
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused', models: [{ id: 'unused', name: 'Unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'unused' }));
writeFileSync(join(base, 'agent/auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));
let server, browser; const sockets=[];
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_PKG_ROOT: process.cwd(), PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	await page.context().routeWebSocket('**/ws', route => { sockets.push(route); route.connectToServer(); });
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	const popup = page.context().waitForEvent('page');
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	page = await popup;
	page.setDefaultTimeout(10000);
	const editor = page.locator('.wiki-prose .fp-rich-document');

	await editor.waitFor();
	await page.locator('.wiki-statusbar .wiki-index-status').waitFor();
	await page.locator('.wiki-meta-link').waitFor();
	assert.equal(await page.locator('.wiki-sidebar .wiki-index-status').count(), 0);
	assert.equal(await page.locator('.wiki-tree-main', { hasText: longName }).getAttribute('title'), longName);
	assert.equal(await page.locator('.wiki-prose .rich-format-tools').count(), 0);
	assert.equal(await page.locator('.wiki-document-toolbar').evaluate(el => el.getBoundingClientRect().height), 40);
	const properties = page.locator('.wiki-properties');
	assert.equal(await properties.getAttribute('open'), null);
	await properties.locator('summary').click();
	await page.waitForTimeout(1000);
	assert.equal(readFileSync(join(base,'note.md'),'utf8'), original, 'expanding properties never saves');
	await properties.locator('summary').click();
	const toolbar = page.locator('.wiki-unified-toolbar');
	await toolbar.getByRole('button', {name:'插入元素', exact:true}).click();
	await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
	assert.equal(await toolbar.getByRole('button', {name:'插入元素', exact:true}).evaluate(el=>el===document.activeElement), true);
	assert.equal(await page.locator('.wiki-toolbar-menu').count(), 0);
	const titleFont = await page.locator('.wiki-document-heading h1').evaluate(el => getComputedStyle(el).fontFamily);
	assert(titleFont.includes('Roboto'), titleFont);
	const bodyFont = await editor.evaluate(el => getComputedStyle(el).fontFamily);
	assert(bodyFont.startsWith('"Chinese Quote", "Segoe UI"'), bodyFont);
	assert(!bodyFont.includes('Roboto') && !bodyFont.includes('-apple-system'), bodyFont);
	assert.equal(await editor.evaluate(el => getComputedStyle(el).fontSize), '15px');
	assert.equal(await editor.evaluate(el => getComputedStyle(el).lineHeight), '26.1px');
	assert.equal(await editor.locator('h2').first().evaluate(el => getComputedStyle(el).fontWeight), '700');
	const meta = await page.locator('.wiki-document-meta .wiki-meta-chip').evaluateAll(elements => elements.map(el => { const s=getComputedStyle(el); return [s.backgroundColor,s.borderRadius,s.padding,s.color].join('|'); }));
	assert(meta.length >= 3); assert(meta.every(value => value === meta[0]));
	const code = editor.locator('pre > code');
	assert.equal(await code.textContent(), command + '\n');
	for (const appearance of ['light', 'dark']) {
		await page.evaluate(value => document.documentElement.dataset.appearance = value, appearance);
		for (const width of [1440, 720]) {
			await page.setViewportSize({ width, height: 1000 });
			const cells = await editor.locator('table').first().locator('tbody tr').first().locator('td').evaluateAll(nodes => nodes.map(el => ({ width: el.getBoundingClientRect().width, align: getComputedStyle(el).textAlign, wrap: getComputedStyle(el).whiteSpace })));
			assert.equal(cells[0].align, 'left'); assert.equal(cells[1].align, 'left'); assert.equal(cells[2].align, 'center');
			assert(cells[2].width < cells[1].width, JSON.stringify(cells)); assert.equal(cells[2].wrap, 'nowrap');
			assert.equal(await editor.locator('table').nth(1).locator('td').last().evaluate(el => getComputedStyle(el).textAlign), 'right', 'explicit Markdown alignment wins');
			const codeBox = await code.evaluate(el => { el.scrollLeft = 200; const style = getComputedStyle(el); return { whiteSpace: style.whiteSpace, width: el.clientWidth, scroll: el.scrollWidth, left: el.scrollLeft }; });
			assert.equal(codeBox.whiteSpace, 'pre'); assert(codeBox.scroll > codeBox.width && codeBox.left > 0, JSON.stringify(codeBox));
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
			await page.waitForTimeout(100);
			assert.equal(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth), true, JSON.stringify(await toolbar.evaluate(el => ({w:el.clientWidth,s:el.scrollWidth,children:[...el.children].map(x=>[x.className,x.getBoundingClientRect().width])}))));
			if (width === 720) await page.screenshot({ path: `/tmp/pi-wiki-review-narrow-${appearance}.png` });
		}
	}
	await page.setViewportSize({ width: 1440, height: 1100 });
	await page.evaluate(() => document.documentElement.dataset.appearance = 'light');
	const bodyHeight = await editor.locator('p').filter({ hasText: '正文行距' }).evaluate(el => {const s=getComputedStyle(el);return parseFloat(s.lineHeight)/parseFloat(s.fontSize);});
	assert(Math.abs(bodyHeight-1.74)<.01);
	await code.evaluate(el=>el.scrollLeft=0);
	await page.locator('.wiki-scroll').evaluate(el=>el.scrollTop=0);
	await page.screenshot({ path: '/tmp/pi-wiki-review-light.png' });
	sockets.at(-1).send(JSON.stringify({type:'notice',level:'info',text:'Design review: temporary information'}));
	const notice=page.locator('.wiki-statusbar .notice-info', {hasText:'Design review'});await notice.waitFor();
	assert.equal(await page.locator('.notices-overlay').count(), 0);
	const footerBox=await page.locator('.wiki-statusbar').boundingBox(), bodyBox=await page.locator('.wiki-window-body').boundingBox();
	assert(footerBox.y >= bodyBox.y+bodyBox.height-1, 'status area never overlays document');
	await notice.waitFor({state:'detached',timeout:4500});
	assert.equal(readFileSync(join(base,'note.md'),'utf8'), original, 'visual changes preserve original bytes');
	await page.getByRole('button',{name:'编辑源码',exact:true}).click();
	assert.equal(await page.locator('.wiki-unified-toolbar').count(),0);
	await page.locator('.wiki-source-toggle').click(); await editor.waitFor();
	assert.equal(readFileSync(join(base,'note.md'),'utf8'),original,'source toggle preserves bytes');
	const choose = async name => {
		let control = toolbar.getByRole('button', {name, exact:true});
		if (!await control.isVisible()) { await toolbar.getByRole('button', {name:'更多',exact:true}).click(); control = page.getByRole('menuitem', {name,exact:true}); }
		await control.click();
	};
	const selectBody = async () => editor.locator('p').filter({hasText:'正文行距'}).evaluate(el => { el.closest('[contenteditable]').focus(); const range=document.createRange();range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range); });
	await selectBody(); await choose('粗体');
	assert(await editor.locator('p').filter({hasText:'正文行距'}).locator('b,strong').count());
	await choose('撤销');
	assert.equal(await editor.locator('p').filter({hasText:'正文行距'}).locator('b,strong').count(),0);
	await choose('重做');
	assert(await editor.locator('p').filter({hasText:'正文行距'}).locator('b,strong').count());
	await selectBody(); await choose('文字颜色'); await page.getByRole('menuitem',{name:'红色',exact:true}).click();
	assert(await editor.locator('p').filter({hasText:'正文行距'}).locator('span[style*="color"]').count());
	await editor.locator('input[type=checkbox]').first().check();
	await page.keyboard.press('ControlOrMeta+s'); await page.locator('.wiki-save-status.saved').waitFor();
	assert(readFileSync(join(base,'note.md'),'utf8').includes('[x]'));
	await editor.locator('table').first().locator('td').first().fill('Updated');
	await page.keyboard.press('ControlOrMeta+s'); await page.locator('.wiki-save-status.saved').waitFor();
	const saved=readFileSync(join(base,'note.md'),'utf8');
	assert(saved.includes(command)); assert(saved.includes('| --- | ---: |')); assert(!saved.includes('wiki-table-status'));
	await page.reload(); await editor.waitFor();
	assert.equal(await editor.locator('p').filter({hasText:'正文行距'}).textContent(), '正文行距应该紧凑，表格根据内容排列，代码保持完整。');
	assert(await editor.locator('p').filter({hasText:'正文行距'}).locator('b,strong').count(), 'colored bold survives reopening');
	assert.equal(await editor.locator('table').first().locator('td').last().evaluate(el=>getComputedStyle(el).textAlign),'center');
	assert.equal(await code.textContent(),command+'\n');
	await page.evaluate(()=>document.documentElement.dataset.appearance='dark');
	await page.screenshot({ path: '/tmp/pi-wiki-review-dark.png' });
	console.log('PASS Wiki design review: unified type/icons/meta, table sizing/alignment, horizontal code, filenames, footer/index/notices, light/dark/narrow and byte preservation');

} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(base, { recursive: true, force: true });
}
