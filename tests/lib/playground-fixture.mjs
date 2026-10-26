import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startIsolatedHarness } from "./isolated-server.mjs";
export async function playgroundFixture(extra = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-python-test-"));
	const dataDir = join(root, "data"); mkdirSync(dataDir);
	writeFileSync(join(dataDir, "playground-scratch.json"), JSON.stringify({ content: "public class Legacy {}", updatedAt: 1 }));
	const token = "python-fixture-token";
	const harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: join(root, "agent"), PI_WEB_TOKEN: token, ...extra } });
	const base = `http://127.0.0.1:${harness.port}`;
	const api = (path, body, method = "POST", extras = {}) => fetch(`${base}/api/playground/${path}?token=${token}`, { method: body === undefined ? "GET" : method, headers: { "Content-Type": "application/json", "x-pi-client": "playground-test" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extras });
	const run = async (code, tests, options = {}) => {
		const response = await api("run", { code, ...(tests ? { tests } : {}) }, "POST", options);
		assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve("") : response.text()));
		return (await response.text()).split("\n\n").filter(x => x.startsWith("data: ")).map(x => JSON.parse(x.slice(6)));
	};
	return { root, dataDir, base, token, api, run, stop: async () => { await harness.stop(); rmSync(root, { recursive: true, force: true }); } };
}
export const end = events => events.find(e => e.type === "end");
export const stdout = events => events.filter(e => e.type === "out" && e.stream === "stdout").map(e => e.text).join("");
