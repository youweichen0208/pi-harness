/** Content sniffing, binary hex, image metadata and empty-file previews through real OMP. */
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";
const root = mkdtempSync(join(tmpdir(), "omp-preview-")), WS = join(root, "work"), data = join(root, "data"), agent = join(data, "omp/agent");
for (const directory of [WS, agent]) mkdirSync(directory, { recursive: true });
writeFileSync(join(agent, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
writeFileSync(join(WS, "notes.weird"), "hello from an unknown extension\nline2\n");
writeFileSync(join(WS, "data.jsonl"), '{"k":1}\n');
writeFileSync(join(WS, "app.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]));
writeFileSync(join(WS, "mixed.txt"), Buffer.from([0x61, 0x62, 0x00, 0x63]));
writeFileSync(join(WS, "pixel.png"), Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
));
writeFileSync(join(WS, "empty.bin"), "");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

let harness, ws;
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: WS, PI_WEB_DATA_DIR: data } });
	const clientId = randomUUID();
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	let ready = false;
	const results = new Map();
	const expected = ["notes.weird", "data.jsonl", "app.zip", "mixed.txt", "pixel.png", "empty.bin"];
	ws.on("message", (d) => {
		let m;
		try {
			m = JSON.parse(d.toString());
		} catch {
			return;
		}
		if (m.type === "ready") ready = true;
		if (m.type === "file_content") results.set(m.path, m);
	});
	ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));
	for (let i = 0; i < 600 && !ready; i++) await sleep(50);
	if (!ready) throw Error("OMP ready handshake timed out");
	for (const p of expected) ws.send(JSON.stringify({ type: "read_file", path: p }));

	const t0 = Date.now();
	while (Date.now() - t0 < 8000 && results.size < expected.length) await sleep(150);

	const get = (p) => results.get(p);
	check(
		"unknown extension text previews as text",
		get("notes.weird")?.kind === "text" &&
			!get("notes.weird")?.binary &&
			get("notes.weird")?.text.includes("unknown extension"),
		get("notes.weird") ? `kind=${get("notes.weird").kind}` : "no result",
	);
	check(
		"jsonl still text",
		get("data.jsonl")?.kind === "text" && !get("data.jsonl")?.binary,
	);
	check(
		"binary zip gets hex dump",
		get("app.zip")?.binary === true && /50 4b 03 04/.test(get("app.zip")?.text ?? ""),
		get("app.zip") ? `text=${(get("app.zip").text ?? "").slice(0, 30)}` : "no result",
	);
	check(
		"NUL inside text-extension file → hex",
		get("mixed.txt")?.binary === true && /00/.test(get("mixed.txt")?.text ?? ""),
		get("mixed.txt") ? `text=${(get("mixed.txt").text ?? "").slice(0, 30)}` : "no result",
	);
	check(
		"image stays metadata-only",
		get("pixel.png")?.binary === true && get("pixel.png")?.kind === "image" && get("pixel.png")?.text === "",
	);
	check(
		"empty file previews as empty text",
		get("empty.bin")?.kind === "text" && get("empty.bin")?.text === "",
	);

} finally {
	ws?.terminate(); await harness?.stop(); rmSync(root, { recursive: true, force: true });
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures ? 1 : 0;
