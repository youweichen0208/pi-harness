import { mergeSnapshot } from "./lib/snapshots.mjs";
/** Embedded OMP onboarding: real credentials and catalog, no CLI installation or model calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
const root = mkdtempSync(join(tmpdir(), 'omp-setup-ui-'));
let harness, browser;
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	for (const lang of ['zh', 'en']) {
		const dataDir = join(root, lang), cwd = join(dataDir, 'workspace'), agent = join(dataDir, 'omp/agent'), oldAgent = join(dataDir, 'old-pi'), empty = join(dataDir, 'empty-bin');
		for (const dir of [cwd, agent, oldAgent, empty]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false } }));
		writeFileSync(join(oldAgent, 'models.json'), 'THIS IS NOT VALID PI CONFIGURATION');
		const env = { ...testEnv(), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: cwd, PI_CODING_AGENT_DIR: oldAgent, PATH: empty, Path: empty };
		for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AWS_|^AZURE_|^OMP_/.test(key)) env[key] = undefined;
		harness = await startIsolatedHarness({ env });
		const health = await (await fetch(`http://127.0.0.1:${harness.port}/api/health`)).json(); assert.equal(health.agentEngine, 'omp');
		const key = `fixture-setup-secret-${lang}`;
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(30000);
		await page.addInitScript(language => localStorage.setItem('pi-harness:lang', language), lang);
		const received = [], sent = [], requests = [], errors = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('request', request => { if (request.method() === 'POST') requests.push(request.postDataJSON()); });
		page.on('websocket', socket => {
			socket.on('framereceived', ({ payload }) => received.push(JSON.parse(String(payload))));
			socket.on('framesent', ({ payload }) => sent.push(JSON.parse(String(payload))));
		});
		await page.goto(`http://127.0.0.1:${harness.port}`);
		const dialog = page.getByRole('dialog', { name: lang === 'zh' ? '配置模型' : 'Set up a model', exact: true });
		await dialog.waitFor(); assert((await dialog.innerText()).includes('OMP'));
		assert(received.some(event => (event.type === 'snapshot' || event.type === 'snapshot_delta') && event.state.piConfigured === false));
		const provider = dialog.getByRole('combobox'); await provider.selectOption('anthropic');
		const save = dialog.getByRole('button', { name: lang === 'zh' ? '保存并开始使用' : 'Save and start using', exact: true });
		assert(await save.isDisabled());
		await dialog.getByRole('button', { name: lang === 'zh' ? '重新检测' : 'Recheck', exact: true }).click();
		await page.setViewportSize({ width: 390, height: 844 });
		assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
		mkdirSync('tests/scratch/omp-setup', { recursive: true });
		for (const appearance of ['light', 'dark']) {
			await page.evaluate(value => document.documentElement.dataset.appearance = value, appearance);
			await page.screenshot({ animations: 'disabled', path: `tests/scratch/omp-setup/${lang}-${appearance}.png` });
		}
		await dialog.getByLabel(lang === 'zh' ? 'API 密钥' : 'API key', { exact: true }).fill(key);
		await save.click(); await dialog.waitFor({ state: 'detached' });
		assert(received.some(event => (event.type === 'snapshot' || event.type === 'snapshot_delta') && event.state.piConfigured));
		assert(sent.some(event => event.type === 'set_provider_api_key' && event.provider === 'anthropic'));
		assert(!JSON.stringify(received).includes(key), 'saved credentials never return in snapshots or provider metadata');
		assert(existsSync(join(agent, 'agent.db')), 'credentials belong to the application OMP directory');
		assert.equal(readFileSync(join(oldAgent, 'models.json'), 'utf8'), 'THIS IS NOT VALID PI CONFIGURATION');
		assert(!sent.some(event => ['prompt', 'install_pi_agent', 'run_command'].includes(event.type)), 'setup does not call a model or install a CLI');
		assert(!requests.some(request => request?.action === 'cli-status'));
		await page.close(); await harness.stop();
		harness = await startIsolatedHarness({ env });
		const reopened = await browser.newPage(); const snapshots = [], modelLists = [];
		reopened.on('websocket', socket => socket.on('framereceived', ({ payload }) => { const event = JSON.parse(String(payload)); if (event.type === 'snapshot' || event.type === 'snapshot_delta') snapshots.push(mergeSnapshot(snapshots.at(-1), event)); if (event.type === 'models') modelLists.push(event.models); }));
		await reopened.goto(`http://127.0.0.1:${harness.port}`); await reopened.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
		assert(snapshots.some(state => state.piConfigured), 'restart reloads native credentials and catalog');
		await reopened.waitForFunction(() => !!document.querySelector('.conn-dot.ok'));
		assert(modelLists.some(models => models.some(model => model.provider === 'anthropic')), 'native provider catalog is restored');
		assert.equal(await reopened.locator('.setup-modal').count(), 0);
		assert.deepEqual(errors, []); await reopened.close(); await harness.stop(); harness = undefined;
		console.log(`PASS ${lang}: embedded OMP onboarding with empty PATH, native credential persistence, no old Pi configuration or install action, secret isolation and narrow themes`);
	}
} finally { await browser?.close(); await harness?.stop(); rmSync(root, { recursive: true, force: true }); }
