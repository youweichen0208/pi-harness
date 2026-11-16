/** Own both database lifetimes; never seed a caller-supplied database. No image pulls. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import mysql from "mysql2/promise";
import { testEnv } from "./lib/test-env.mjs";

const context = execFileSync("docker", ["context", "show"], { encoding: "utf8", timeout: 10000 }).trim();
const docker = args => execFileSync("docker", ["--context", context, ...args], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const endpoint = JSON.parse(docker(["context", "inspect", context]))[0].Endpoints.docker.Host;
assert(/^(unix|npipe):\/\//.test(endpoint), "Integration databases require a local Docker context");
const owner = randomUUID(), label = "pi-harness.database-test";
const root = mkdtempSync(join(tmpdir(), "omp-database-containers-"));
const fixtures = [
	{ kind: "postgres", image: "postgres:17-alpine", port: 5432, memory: "512m", mount: "/var/lib/postgresql/data", env: ["POSTGRES_PASSWORD=pi_test_only", "POSTGRES_DB=analytics"] },
	{ kind: "mysql", image: "mysql:8.0", port: 3306, memory: "1g", mount: "/var/lib/mysql", env: ["MYSQL_ROOT_PASSWORD=pi_test_only", "MYSQL_ROOT_HOST=%", "MYSQL_DATABASE=analytics"] },
];
let child, childDone, interrupted = false;
const interrupt = () => { interrupted = true; child?.kill("SIGTERM"); };
process.once("SIGTERM", interrupt); process.once("SIGINT", interrupt);
try {
	for (const f of fixtures) {
		assert(!interrupted, "Interrupted before container creation");
		const image = JSON.parse(docker(["image", "inspect", f.image]))[0];
		f.cidfile = join(root, `${f.kind}.cid`);
		docker(["run", "--detach", "--rm", "--pull=never", "--name", `omp-db-${f.kind}-${owner}`, "--label", `${label}=${owner}`, "--cidfile", f.cidfile,
			"--memory", f.memory, "--cpus", "1", "--tmpfs", `${f.mount}:rw`, "--publish", `127.0.0.1::${f.port}`, ...f.env.flatMap(value => ["--env", value]), image.Id]);
		f.id = readFileSync(f.cidfile, "utf8").trim();
		const details = JSON.parse(docker(["inspect", f.id]))[0];
		assert.equal(details.Config.Labels[label], owner);
		const bindings = details.NetworkSettings.Ports[`${f.port}/tcp`];
		assert.equal(bindings.length, 1); assert.equal(bindings[0].HostIp, "127.0.0.1");
		f.hostPort = Number(bindings[0].HostPort);
		assert(Number.isInteger(f.hostPort) && f.hostPort >= 8900 && f.hostPort <= 65535);
		console.log(JSON.stringify({ database: f.kind, image: image.Id, digests: image.RepoDigests, port: f.hostPort, container: f.id }));
	}
	for (const f of fixtures) {
		let ready = false;
		const deadline = Date.now() + 120000;
		while (!ready && Date.now() < deadline && !interrupted) {
			const config = { host: "127.0.0.1", port: f.hostPort, user: f.kind === "postgres" ? "postgres" : "root", password: "pi_test_only", database: "analytics" };
			if (f.kind === "postgres") {
				const client = new pg.Client({ ...config, connectionTimeoutMillis: 1000 });
				try { await client.connect(); await client.query("SELECT 1"); ready = true; } catch {} finally { await client.end().catch(() => {}); }
			} else {
				let client;
				try { client = await mysql.createConnection({ ...config, connectTimeout: 1000 }); await client.query("SELECT 1"); ready = true; } catch {} finally { await client?.end(); }
			}
			if (!ready) await sleep(500);
		}
		assert(ready, `${f.kind} fixture did not become ready`);
	}
	assert(!interrupted, "Interrupted before integration test");
	child = spawn(process.execPath, ["tests/database-test.mjs", ...process.argv.slice(2)], {
		env: testEnv({ PI_TEST_DATABASE_FIXTURE: "owned-container", PI_TEST_PG_PORT: String(fixtures[0].hostPort), PI_TEST_MYSQL_PORT: String(fixtures[1].hostPort) }), stdio: "inherit",
	});
	childDone = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
	let timedOut = false, force;
	const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); force = setTimeout(() => child.kill("SIGKILL"), 15000); }, 600000);
	try {
		const result = await childDone;
		assert(!timedOut && !interrupted, "Database integration interrupted or timed out");
		assert.equal(result.code, 0, `Database integration failed (${result.code ?? result.signal})`);
	} finally { clearTimeout(timer); clearTimeout(force); }
} finally {
	process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt);
	if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await childDone; }
	const failures = [];
	for (const f of fixtures) {
		if (!f.cidfile || !existsSync(f.cidfile)) continue;
		const id = readFileSync(f.cidfile, "utf8").trim();
		if (!id) continue;
		try {
			// A dead --rm container is already gone. Never resolve ownership by name.
			const owned = docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${label}=${owner}`]).split("\n");
			if (!owned.includes(id)) { assert(!docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${id}`]), "Container ownership changed; refusing cleanup"); continue; }
			assert.equal(JSON.parse(docker(["inspect", id]))[0].Config.Labels[label], owner);
			docker(["rm", "--force", id]);
			assert(!docker(["ps", "--all", "--quiet", "--filter", `id=${id}`]));
			console.log(`Removed owned ${f.kind} fixture ${id}`);
		} catch (error) { failures.push(error); }
	}
	if (failures.length) throw new AggregateError(failures, `Container cleanup failed; ownership files retained at ${root}`);
	rmSync(root, { recursive: true, force: true });
}
