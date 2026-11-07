import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => testHome }));
import { scanSources, dataGripProjectPaths } from "../../server/database/sources.js";
let testHome = "";
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
it.each(["windows", "mac", "linux"])("discovers non-default projects from %s configuration roots", platform => {
	const dir = mkdtempSync(join(tmpdir(), "pi-datagrip-")); dirs.push(dir); testHome = join(dir, "home");
	vi.stubEnv("APPDATA", join(dir, "appdata")); vi.stubEnv("XDG_CONFIG_HOME", join(dir, "xdg"));
	const config = platform === "windows" ? join(dir, "appdata/JetBrains") : platform === "mac" ? join(testHome, "Library/Application Support/JetBrains") : join(dir, "xdg/JetBrains");
	const options = join(config, "DataGrip2024.3/options"), project = join(dir, "other-drive/database");
	mkdirSync(options, { recursive: true }); mkdirSync(join(project, ".idea"), { recursive: true });
	writeFileSync(join(options, "recentProjects.xml"), `<application><component name="RecentProjectsManager"><option name="additionalInfo"><map><entry key="${project}"><value><RecentProjectMetaInfo /></value></entry></map></option></component></application>`);
	writeFileSync(join(project, ".idea/dataSources.xml"), '<project><component name="DataSourceManagerImpl"/></project>');
	expect(scanSources(join(dir, "unrelated"))).toContainEqual({ kind: "datagrip", path: join(project, ".idea/dataSources.xml") });
	const broken = join(config, "DataGrip2025.1/options"); mkdirSync(broken, { recursive: true }); writeFileSync(join(broken, "recentProjects.xml"), "<invalid");
	expect(scanSources(join(dir, "unrelated"))).toHaveLength(1);
	const nextProject = join(dir, "new-project"); mkdirSync(join(nextProject, ".idea"), { recursive: true }); writeFileSync(join(nextProject, ".idea/dataSources.xml"), "<project/>");
	writeFileSync(join(options, "recentProjects.xml"), `<application><component name="RecentProjectsManager"><option name="recentPaths"><list><option value="${nextProject}"/></list></option></component></application>`);
	expect(scanSources(join(dir, "unrelated"))).toEqual([{ kind: "datagrip", path: join(nextProject, ".idea/dataSources.xml") }]);

});

it("parses modern and legacy paths, expands home, deduplicates and handles Windows paths", () => {
	const xml = `<application><component name="RecentProjectsManager"><option name="additionalInfo"><map><entry key="D:/database"/><entry key="/data/A &amp; B"/><entry key="$USER_HOME$/db"/></map></option><option name="recentPaths"><list><option value="D:/database"/><option value="~/db"/><option value="relative/path"/><option value="$UNKNOWN$/db"/></list></option></component></application>`;
	expect(dataGripProjectPaths(xml, "/home/test")).toEqual(["D:/database", "/data/A & B", "/home/test/db"]);
	expect(dataGripProjectPaths('<application><component name="RecentProjectsManager"><option name="openPaths"><list><option value="D:\\database"/></list></option></component></application>', "/home/test")).toEqual(["D:\\database"]);
});
it("rejects unsafe or malformed XML and limits project entries", () => {
	for (const xml of ['<!DOCTYPE x><application/>', '<application>', 'x'.repeat(2 * 1024 * 1024 + 1)]) expect(() => dataGripProjectPaths(xml, "/home/test")).toThrow();
	const entries = Array.from({ length: 250 }, (_, i) => `<entry key="/db/${i}"/>`).join("");
	expect(dataGripProjectPaths(`<application><component name="RecentProjectsManager"><option name="additionalInfo"><map>${entries}</map></option></component></application>`, "/home/test")).toHaveLength(200);
});
