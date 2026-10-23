import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYGROUND_DEFAULTS, PlaygroundConfigStore, normalizePlaygroundConfig, playgroundEnvLock } from "../../server/playground-config.js";

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "pi-playground-config-")); roots.push(root); return { root, file: join(root, "playground.json") }; }
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it("defaults the playground to off with the documented limits", () => {
	expect(PLAYGROUND_DEFAULTS).toEqual({ enabled: false, timeoutMs: 10000, maxOutputBytes: 262144, maxHeapMb: 256, maxConcurrent: 2 });
	expect(normalizePlaygroundConfig(undefined)).toEqual(PLAYGROUND_DEFAULTS);
	expect(normalizePlaygroundConfig({})).toEqual(PLAYGROUND_DEFAULTS);
});

it("keeps valid stored values", () => {
	expect(normalizePlaygroundConfig({ enabled: true, timeoutMs: 30000, maxOutputBytes: 4096, maxHeapMb: 512, maxConcurrent: 1 }))
		.toEqual({ enabled: true, timeoutMs: 30000, maxOutputBytes: 4096, maxHeapMb: 512, maxConcurrent: 1 });
});

it("clamps out-of-range numbers to the documented bounds", () => {
	expect(normalizePlaygroundConfig({ timeoutMs: 0 }).timeoutMs).toBe(1000);
	expect(normalizePlaygroundConfig({ timeoutMs: 999999 }).timeoutMs).toBe(60000);
	expect(normalizePlaygroundConfig({ maxHeapMb: 1 }).maxHeapMb).toBe(16);
	expect(normalizePlaygroundConfig({ maxHeapMb: 99999 }).maxHeapMb).toBe(4096);
	expect(normalizePlaygroundConfig({ maxOutputBytes: 1 }).maxOutputBytes).toBe(1024);
	expect(normalizePlaygroundConfig({ maxConcurrent: 0 }).maxConcurrent).toBe(1);
	expect(normalizePlaygroundConfig({ maxConcurrent: 99 }).maxConcurrent).toBe(8);
});

it("ignores wrong types and non-finite numbers instead of trusting them", () => {
	expect(normalizePlaygroundConfig({ enabled: "yes" }).enabled).toBe(false);
	expect(normalizePlaygroundConfig({ enabled: 1 }).enabled).toBe(false);
	expect(normalizePlaygroundConfig({ timeoutMs: "30000" }).timeoutMs).toBe(10000);
	expect(normalizePlaygroundConfig({ timeoutMs: Number.NaN }).timeoutMs).toBe(10000);
	expect(normalizePlaygroundConfig({ maxOutputBytes: Number.POSITIVE_INFINITY }).maxOutputBytes).toBe(262144);
	expect(normalizePlaygroundConfig("nonsense").enabled).toBe(false);
	expect(normalizePlaygroundConfig(null).enabled).toBe(false);
});

it("locks the feature off when the environment says so", () => {
	expect(playgroundEnvLock({ PI_WEB_PLAYGROUND: "off" })).toBe(true);
	expect(playgroundEnvLock({ PI_WEB_PLAYGROUND: "0" })).toBe(true);
	expect(playgroundEnvLock({ PI_WEB_PLAYGROUND: "FALSE" })).toBe(true);
	expect(playgroundEnvLock({ PI_WEB_PLAYGROUND: " off " })).toBe(true);
	expect(playgroundEnvLock({ PI_WEB_PLAYGROUND: "on" })).toBe(false);
	expect(playgroundEnvLock({ PI_WEB_PLAYGROUND: "1" })).toBe(false);
	expect(playgroundEnvLock({})).toBe(false);
});

it("reads defaults when the config file is missing or corrupt", () => {
	const { file } = fixture();
	expect(new PlaygroundConfigStore(file).read()).toEqual(PLAYGROUND_DEFAULTS);
	writeFileSync(file, "{ not json");
	expect(new PlaygroundConfigStore(file).read()).toEqual(PLAYGROUND_DEFAULTS);
	writeFileSync(file, JSON.stringify({ enabled: "yes", timeoutMs: "soon" }));
	expect(new PlaygroundConfigStore(file).read()).toEqual(PLAYGROUND_DEFAULTS);
});

it("round-trips a write and stores it privately", () => {
	const { file } = fixture();
	const store = new PlaygroundConfigStore(file);
	const saved = store.write({ ...PLAYGROUND_DEFAULTS, enabled: true, timeoutMs: 20000 });
	expect(saved).toEqual({ ...PLAYGROUND_DEFAULTS, enabled: true, timeoutMs: 20000 });
	expect(new PlaygroundConfigStore(file).read()).toEqual(saved);
	expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(true);
	if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
});

it("normalizes what it writes, so a bad value never lands on disk", () => {
	const { file } = fixture();
	const saved = new PlaygroundConfigStore(file).write({ ...PLAYGROUND_DEFAULTS, timeoutMs: 999999 } as never);
	expect(saved.timeoutMs).toBe(60000);
	expect(JSON.parse(readFileSync(file, "utf8")).timeoutMs).toBe(60000);
});

it("enables a fresh installation only when a JDK is available", () => {
	const { file } = fixture();
	const store = new PlaygroundConfigStore(file);
	expect(store.read(false).enabled).toBe(false);
	expect(store.read(true).enabled).toBe(true);
	// Discovery is not a user choice: installing a JDK later can enable it.
	expect(store.read(false).enabled).toBe(false);
	store.write({ ...store.read(true), enabled: false });
	expect(new PlaygroundConfigStore(file).read(true).enabled).toBe(false);
});

it("keeps damaged and invalid settings disabled even with a JDK", () => {
	const { file } = fixture();
	for (const data of ['{broken', '{}', '{"enabled":"true"}']) {
		writeFileSync(file, data);
		expect(new PlaygroundConfigStore(file).read(true).enabled).toBe(false);
	}
});
