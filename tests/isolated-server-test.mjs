/** Deterministic bind collisions, readiness identity and child cleanup. No model calls. */
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";

const fixture = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
createServer((_req, res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({pid:process.pid})); })
 .listen(port, '127.0.0.1', () => console.log('http://localhost:' + port));
`;
const args = ["--input-type=module", "--eval", fixture];
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
function occupiedFirst(port) {
	let first = true;
	return () => { if (first) { first = false; return port; } return randomInt(20000, 60000); };
}

test("listeners bind high ports and retry collisions without releasing successful sockets", async () => {
	const occupied = createServer(), target = createServer();
	try {
		const port = await listenIsolated(occupied);
		const selected = await listenIsolated(target, { nextPort: occupiedFirst(port) });
		assert.notEqual(selected, port); assert(target.listening); assert(occupied.listening);
		await assert.rejects(listenIsolated(createServer(), { nextPort: () => 8787 }), /8900/);
	} finally { await close(target); await close(occupied); }
});

test("child bind collision retries while leaving the competing listener untouched", async () => {
	let foreignRequests = 0, harness;
	const occupied = createServer((_req, res) => { foreignRequests++; res.end(JSON.stringify({ pid: process.pid })); });
	try {
		const port = await listenIsolated(occupied);
		harness = await startIsolatedHarness({ args, nextPort: occupiedFirst(port) });
		assert.notEqual(harness.port, port);
		assert.equal((await (await fetch(`http://127.0.0.1:${harness.port}/api/health`)).json()).pid, harness.child.pid);
		assert.equal(foreignRequests, 0, "occupied candidates are never probed as if they were our server");
		assert(occupied.listening);
	} finally { await harness?.stop(); await close(occupied); }
});

test("non-collision startup errors fail without retries", async () => {
	let attempts = 0;
	await assert.rejects(startIsolatedHarness({ args: ["--eval", "throw Error('fixture startup failure')"], nextPort: () => { attempts++; return 20000; } }), /fixture startup failure/);
	assert.equal(attempts, 1);
});

test("a live child without readiness is stopped on timeout", async () => {
	let output = "";
	await assert.rejects(startIsolatedHarness({ args: ["--eval", "console.log(process.pid); setInterval(() => {}, 1000)"], timeoutMs: 500, onOutput: value => output += value }), /readiness timed out/);
	const pid = Number(output.trim()); assert(Number.isInteger(pid) && pid > 0);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "only the timed-out child has been cleaned up");
});
