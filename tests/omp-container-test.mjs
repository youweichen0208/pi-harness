/** Real image, owned containers and one persistent volume; no host account/network access. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const imageName = process.argv[2];
assert(imageName && process.argv.length === 3, 'Usage: node tests/omp-container-test.mjs <locally built image>');
const context = execFileSync('docker', ['context', 'show'], { encoding: 'utf8', timeout: 10000 }).trim();
const docker = args => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
assert(/^(unix|npipe):\/\//.test(JSON.parse(docker(['context', 'inspect', context]))[0].Endpoints.docker.Host), 'Use a local Docker context');
const image = JSON.parse(docker(['image', 'inspect', imageName]))[0];
assert.equal(image.Config.User, 'node');
assert.deepEqual(image.Config.Cmd, ['node', 'dist/server/index.js']);
const owner = randomUUID(), label = 'pi-harness.container-test', volume = `omp-container-${owner}`;
const root = mkdtempSync(join(tmpdir(), 'omp-container-test-')), containers = [];
let volumeCreated = false, active, interrupted = false;
const interrupt = () => { interrupted = true; active?.kill('SIGTERM'); };
process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
try {
	docker(['volume', 'create', '--label', `${label}=${owner}`, volume]); volumeCreated = true;
	assert.equal(JSON.parse(docker(['volume', 'inspect', volume]))[0].Labels[label], owner);
	for (const phase of ['prepare', 'seed', 'restore']) {
		assert(!interrupted, 'Container test interrupted');
		const cidfile = join(root, `${phase}.cid`); containers.push(cidfile);
		const args = ['--context', context, 'run', '--pull=never', '--network=none', '--label', `${label}=${owner}`, '--cidfile', cidfile,
			'--mount', `type=volume,src=${volume},dst=/data`,
			'--mount', `type=bind,src=${resolve('tests/fixtures/omp-container.mjs')},dst=/test/omp-container.mjs,readonly`,
			'--mount', `type=bind,src=${resolve('tests/lib/snapshots.mjs')},dst=/test/snapshots.mjs,readonly`,
			'--env', 'PORT=9023', '--env', 'PI_WEB_HOST=0.0.0.0', '--env', 'PI_WEB_ALLOW_HOSTS=localhost,127.0.0.1',
			...(phase === 'prepare' ? ['--entrypoint', 'node', image.Id] : [image.Id, 'node']), '/test/omp-container.mjs', phase];
		active = spawn('docker', args, { stdio: 'inherit' });
		const done = new Promise((resolveExit, reject) => { active.once('error', reject); active.once('close', (code, signal) => resolveExit({ code, signal })); });
		const timer = setTimeout(() => { interrupted = true; active.kill('SIGTERM'); }, 180000);
		let result;
		try { result = await done; } finally { clearTimeout(timer); active = undefined; }
		assert(!interrupted, 'Container test timed out or interrupted');
		assert.equal(result.code, 0, `${phase} container failed (${result.code ?? result.signal})`);
		// Each phase gets a new container, rather than restarting an existing one.
		const id = readFileSync(cidfile, 'utf8').trim();
		assert.equal(JSON.parse(docker(['inspect', id]))[0].Config.Labels[label], owner);
		docker(['rm', id]);
	}
	console.log(`PASS OMP container: image ${image.Id}, non-root runtime, native tools, persistent session/config/package and no replay after container replacement`);
} finally {
	process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
	const failures = [];
	for (const cidfile of containers) {
		if (!existsSync(cidfile)) continue;
		const id = readFileSync(cidfile, 'utf8').trim(); if (!id) continue;
		try {
			if (!docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `id=${id}`])) continue;
			assert.equal(JSON.parse(docker(['inspect', id]))[0].Config.Labels[label], owner);
			docker(['rm', '--force', id]);
		} catch (error) { failures.push(error); }
	}
	if (volumeCreated && !failures.length) {
		try { assert.equal(JSON.parse(docker(['volume', 'inspect', volume]))[0].Labels[label], owner); docker(['volume', 'rm', volume]); }
		catch (error) { failures.push(error); }
	}
	if (failures.length) throw new AggregateError(failures, `Owned container cleanup failed; identity files retained at ${root}`);
	rmSync(root, { recursive: true, force: true });
}
