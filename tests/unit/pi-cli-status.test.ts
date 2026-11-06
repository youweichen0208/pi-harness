import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { cliProbeEnv, piCliStatus, probeCliTool } from "../../server/pi-cli-status.js";

it("detects external tools, excludes bundled CLI, and rechecks after prerequisites change", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-cli-probe-"));
	const bin = join(root, "node_modules", ".bin"); mkdirSync(bin, { recursive: true });
	const script = (dir: string, name: string, version: string, code = 0) => {
		const win = process.platform === "win32";
		writeFileSync(join(dir, name + (win ? ".cmd" : "")), win ? `@echo off\r\necho ${version}\r\nexit /b ${code}\r\n` : `#!/bin/sh\nprintf '%s\\n' '${version}'\nexit ${code}\n`, { mode: 0o755 });
	};
	const env = { ...process.env, PATH: [bin, root].join(delimiter), Path: [bin, root].join(delimiter) };
	try {
		script(bin, "pi", "1.5.0"); script(root, "node", "v22.19.0"); script(root, "npm", "10.9.0");
		// Use the platform's canonical PATH spelling to avoid duplicate Windows keys.
		if (process.platform === "win32") delete (env as NodeJS.ProcessEnv).PATH; else delete (env as NodeJS.ProcessEnv).Path;
		expect(Object.values(cliProbeEnv(env))).not.toContain(bin);
		expect(await piCliStatus(env)).toMatchObject({ pi: { status: "missing" }, canInstall: true });
		script(root, "node", "v22.18.0");
		expect((await piCliStatus(env)).canInstall).toBe(false);
		script(root, "node", "v24.0.0"); script(root, "pi", "1.5.0");
		expect(await piCliStatus(env)).toMatchObject({ pi: { status: "available", version: "1.5.0" }, canInstall: false });
		script(root, "pi", "failure", 1);
		expect((await piCliStatus(env)).pi.status).toBe("unusable");
		script(root, "pi", "x".repeat(17000));
		expect((await probeCliTool("pi", cliProbeEnv(env))).status).toBe("unusable");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("bounds a stalled version probe", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-cli-timeout-"));
	const win = process.platform === "win32", path = join(root, win ? "slow.cmd" : "slow");
	try {
		writeFileSync(path, win ? '@echo off\r\n"%SystemRoot%\\System32\\ping.exe" -n 20 127.0.0.1 >nul\r\n' : '#!/bin/sh\n/bin/sleep 20\n', { mode: 0o755 });
		expect(await probeCliTool(path, process.env, 100)).toMatchObject({ status: "unusable", reason: "timeout" });
	} finally { rmSync(root, { recursive: true, force: true }); }
});
