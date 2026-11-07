import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => testHome }));
import { scanSources } from "../../server/database/sources.js";
let testHome = "";
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-dbeaver-")); dirs.push(root); testHome = join(root, "home");
	for (const name of ["APPDATA", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) vi.stubEnv(name, join(root, name));
	vi.stubEnv("DBEAVER_DATA", ""); vi.stubEnv("DBEAVER_WORKSPACE", "");
	const connection = (workspace: string, project = "General") => { const dir = join(workspace, project, ".dbeaver"); mkdirSync(dir, { recursive: true }); const path = join(dir, "data-sources.json"); writeFileSync(path, '{"connections":{}}'); return { kind: "dbeaver", path }; };
	return { root, connection, scan: () => scanSources(join(root, "unrelated")) };
}
it.each(["windows", "mac", "linux"])("discovers custom workspaces registered on %s", platform => {
	const f = fixture();
	const data = platform === "windows" ? join(f.root, "APPDATA/DBeaverData") : platform === "mac" ? join(testHome, "Library/DBeaverData") : join(f.root, "XDG_DATA_HOME/DBeaverData");
	mkdirSync(data, { recursive: true });
	const workspace = join(f.root, "other-drive/work space 中文"), expected = f.connection(workspace);
	writeFileSync(join(data, ".workspaces"), `${workspace}\r\n${workspace}\r\n${join(f.root, "missing")}\r\n`);
	expect(f.scan()).toEqual([expected]);
	const next = join(f.root, "next"), second = f.connection(next, "Analytics");
	writeFileSync(join(data, ".workspaces"), `${workspace}\n${next}\n`);
	expect(f.scan()).toEqual(expect.arrayContaining([expected, second]));
});
it("uses explicit workspace and data directory environment overrides", () => {
	const f = fixture(), workspace = join(f.root, "custom"), data = join(f.root, "data");
	const a = f.connection(workspace), b = f.connection(join(data, "workspace6"));
	vi.stubEnv("DBEAVER_WORKSPACE", workspace); vi.stubEnv("DBEAVER_DATA", data);
	expect(f.scan()).toEqual(expect.arrayContaining([a, b]));
});
it("ignores oversized histories and relative entries without scanning unrelated descendants", () => {
	const f = fixture(), data = join(f.root, "data"); mkdirSync(data, { recursive: true }); vi.stubEnv("DBEAVER_DATA", data);
	const workspace = join(f.root, "custom"); f.connection(join(workspace, "unrelated/deep"));
	writeFileSync(join(data, ".workspaces"), `${workspace}\nrelative-workspace\n`);
	expect(f.scan()).toEqual([]);
	writeFileSync(join(data, ".workspaces"), `${workspace}\n${"x".repeat(2 * 1024 * 1024)}`);
	expect(f.scan()).toEqual([]);
});
it("discovers at most 32 registered workspaces and 100 sources", () => {
	const f = fixture(), data = join(f.root, "data"); mkdirSync(data, { recursive: true }); vi.stubEnv("DBEAVER_DATA", data);
	const paths = Array.from({ length: 40 }, (_, i) => join(f.root, `workspace-${i}`));
	for (const path of paths) f.connection(path);
	writeFileSync(join(data, ".workspaces"), paths.join("\n"));
	expect(f.scan().length).toBeLessThanOrEqual(32);
	for (let i = 0; i < 120; i++) f.connection(paths[0], `Project-${i}`);
	expect(f.scan()).toHaveLength(100);
});
