import { expect, test } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const { verifyPackagedRuntime } = require("../../build/afterPack.cjs");
const { Arch } = require("builder-util");
const pins = require("../../package.json").dependencies;

test("desktop verifies the exact OMP/Bun pins, resources, platform and absence of retired Pi", () => {
	const out = mkdtempSync(join(tmpdir(), "omp-packaged-pin-"));
	try {
		const app = join(out, process.platform === "darwin" ? "pi.app/Contents/Resources/app" : "resources/app");
		const sdk = join(app, "node_modules/@oh-my-pi/pi-coding-agent");
		const entries = ["index.js", "omp/worker.js", "omp/package-worker.js", "sqlite-worker.js", "wiki-pdf-worker.js", "plugin-updater.js"];
		for (const entry of entries) { const file = join(app, "dist/server", entry); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "// fixture entry"); }
		const references = ["README.md", "CHANGELOG.md", "src/sdk.ts", "src/modes/rpc/rpc-mode.ts", "src/prompts"];
		for (const reference of references) { mkdirSync(dirname(join(sdk, reference)), { recursive: true }); writeFileSync(join(sdk, reference), "fixture resource"); }
		const bun = join(app, "node_modules/bun/bin/bun.exe");
		mkdirSync(dirname(bun), { recursive: true });
		copyFileSync(join(dirname(require.resolve("bun/package.json")), "bin/bun.exe"), bun, constants.COPYFILE_FICLONE);
		const manifest = { dependencies: { "@oh-my-pi/pi-coding-agent": pins["@oh-my-pi/pi-coding-agent"], bun: pins.bun } };
		const save = (value: unknown) => writeFileSync(join(app, "package.json"), JSON.stringify(value));
		save(manifest);
		writeFileSync(join(sdk, "package.json"), JSON.stringify({ version: pins["@oh-my-pi/pi-coding-agent"] }));
		const context = { appOutDir: out, electronPlatformName: process.platform, arch: Arch[process.arch], packager: { appInfo: { productFilename: "pi" } } };
		expect(() => verifyPackagedRuntime(context)).not.toThrow();
		for (const entry of entries) {
			const file = join(app, "dist/server", entry); rmSync(file);
			expect(() => verifyPackagedRuntime(context)).toThrow(`Packaged server entry is missing: ${entry}`);
			writeFileSync(file, "// fixture entry");
		}
		const oldEntry = join(app, "dist/server/agent-service.js"); writeFileSync(oldEntry, "// stale emitted file");
		expect(() => verifyPackagedRuntime(context)).toThrow("Retired Pi server output was packaged"); rmSync(oldEntry);
		const oldImport = join(app, "dist/server/omp/stale.js"); writeFileSync(oldImport, 'import "@earendil-works/pi-ai";');
		expect(() => verifyPackagedRuntime(context)).toThrow("Retired Pi import was packaged"); rmSync(oldImport);
		for (const reference of references) {
			rmSync(join(sdk, reference));
			expect(() => verifyPackagedRuntime(context)).toThrow(`Packaged OMP resource is missing: ${reference}`);
			writeFileSync(join(sdk, reference), "fixture resource");
		}
		mkdirSync(join(app, "extensions"));
		expect(() => verifyPackagedRuntime(context)).toThrow("Desktop must not bundle application extensions");
		rmSync(join(app, "extensions"), { recursive: true });
		save({ ...manifest, pi: { extensions: ["./extensions"] } });
		expect(() => verifyPackagedRuntime(context)).toThrow("Desktop must not bundle application extensions");
		save({ ...manifest, omp: { extensions: ["./extensions"] } });
		expect(() => verifyPackagedRuntime(context)).toThrow("Desktop must not bundle application extensions");
		save(manifest);
		const retired = join(app, "node_modules/@earendil-works/pi-coding-agent");
		mkdirSync(retired, { recursive: true });
		expect(() => verifyPackagedRuntime(context)).toThrow("Retired Pi runtime was packaged");
		rmSync(retired, { recursive: true });
		writeFileSync(join(sdk, "package.json"), JSON.stringify({ version: "1.0.0" }));
		expect(() => verifyPackagedRuntime(context)).toThrow(`expected ${pins["@oh-my-pi/pi-coding-agent"]}, got 1.0.0`);
		save({ dependencies: { ...manifest.dependencies, "@oh-my-pi/pi-coding-agent": "^1.0.0" } });
		expect(() => verifyPackagedRuntime(context)).toThrow("Unexpected packaged OMP SDK version");
		writeFileSync(join(sdk, "package.json"), JSON.stringify({ version: pins["@oh-my-pi/pi-coding-agent"] }));
		save({ dependencies: { ...manifest.dependencies, bun: "0.0.0" } });
		expect(() => verifyPackagedRuntime(context)).toThrow("Packaged Bun does not match");
		save(manifest);
		expect(() => verifyPackagedRuntime({ ...context, arch: process.arch === "arm64" ? Arch.x64 : Arch.arm64 })).toThrow("runner matching its target platform and architecture");
		rmSync(bun);
		expect(() => verifyPackagedRuntime(context)).toThrow("Bundled Bun runtime is missing");
	} finally { rmSync(out, { recursive: true, force: true }); }
});
