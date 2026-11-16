/** Exercise CLI dry-run generation; never install a service or write user config. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testEnv } from './lib/test-env.mjs';

const root = mkdtempSync(join(tmpdir(), 'omp-service-config-')), cli = resolve('bin/pi-harness.mjs');
const preload = join(root, 'dry-run.mjs'), selected = join(root, 'selected-data'), inherited = join(root, 'inherited-data');
mkdirSync(selected); mkdirSync(inherited);
writeFileSync(preload, `import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const refuse = () => { throw Error('Dry-run attempted a mutation or external command'); };
for (const key of ['writeFileSync','appendFileSync','mkdirSync','rmSync','unlinkSync','renameSync']) fs[key] = refuse;
for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) cp[key] = refuse;
syncBuiltinESMExports(); Object.defineProperty(process, 'platform', {value: process.env.HARNESS_TEST_PLATFORM});`);
try {
	for (const platform of ['darwin', 'linux', 'win32']) {
		const run = args => execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args], {
			cwd: root, encoding: 'utf8', timeout: 10000,
			env: testEnv({ HARNESS_TEST_PLATFORM: platform, APPDATA: join(root, 'appdata'), PI_WEB_DATA_DIR: inherited, PI_CODING_AGENT_DIR: join(root, 'old-pi-agent') }),
		});
		const help = run(['--help']);
		assert(!help.includes('PI_CODING_AGENT_DIR'), 'CLI must advertise OMP application data instead of the unused legacy override');
		assert(help.includes('omp/agent'));
		for (const explicit of [false, true]) {
			const output = run(['server', 'install', '--print', '--name', 'omp-fixture', '--port', '19087', '--cwd', root, ...(explicit ? ['--data-dir', selected] : [])]);
			assert(output.includes('PI_WEB_DATA_DIR'));
			assert(output.includes(explicit ? selected : inherited), 'service retains the selected application data directory');
			assert(!output.includes('PI_CODING_AGENT_DIR') && !output.includes('old-pi-agent'), 'service must not bake an obsolete agent directory into its environment');
			assert(output.includes('19087'));
			if (platform === 'linux') assert(output.includes('Oh My Pi (OMP)'));
		}
	}
	console.log('PASS OMP CLI service generation: supported data directory, flag precedence, no legacy override, no service or filesystem mutations');
} finally { rmSync(root, { recursive: true, force: true }); }
