import { expect, test } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const afterPack = createRequire(import.meta.url)("../../build/afterPack.cjs");

test("desktop packaging follows the exact SDK pin and rejects mismatches or ranges", async () => {
	const out = mkdtempSync(join(tmpdir(), "pi-packaged-pin-"));
	try {
		const app = join(out, "resources/app"), sdk = join(app, "node_modules/@earendil-works/pi-coding-agent");
		const source = join(out, "source"), sourceSkillRoot = join(source, "assets/skills/design-first");
		mkdirSync(join(sdk, "docs"), { recursive: true });
		cpSync(new URL("../../assets/skills/design-first", import.meta.url), sourceSkillRoot, { recursive: true });
		const skillRoot = join(app, "assets/skills/design-first");
		cpSync(sourceSkillRoot, skillRoot, { recursive: true });
		mkdirSync(join(sdk, "examples/extensions"), { recursive: true });
		const references = ["README.md", "docs/extensions.md", "examples/extensions/README.md", "examples/extensions/hello.ts"];
		for (const reference of references) writeFileSync(join(sdk, reference), "fixture reference");
		writeFileSync(join(sdk, "docs/codemode.md"), "models.generateImages");
		const context = { appOutDir: out, electronPlatformName: "linux", packager: { projectDir: source, appInfo: { productFilename: "pi" } } };
		for (const version of ["1.0.1", "2.0.0"]) {
			writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { "@earendil-works/pi-coding-agent": version } }));
			writeFileSync(join(sdk, "package.json"), JSON.stringify({ version }));
			await expect(afterPack(context)).resolves.toBeUndefined();
		}
		for (const reference of references) {
			rmSync(join(sdk, reference));
			await expect(afterPack(context)).rejects.toThrow(`Packaged Pi reference is missing: ${reference}`);
			writeFileSync(join(sdk, reference), "fixture reference");
		}
		for (const reference of readdirSync(skillRoot, { recursive: true }).filter(name => String(name).endsWith(".md"))) {
			const file = join(skillRoot, String(reference)), body = readFileSync(file);
			rmSync(file);
			await expect(afterPack(context)).rejects.toThrow("Packaged Design First resource is missing");
			writeFileSync(file, body);
		}
		writeFileSync(join(sourceSkillRoot, "references/future.md"), "# Future resource\n");
		await expect(afterPack(context)).rejects.toThrow("Packaged Design First resource is missing: references/future.md");
		writeFileSync(join(skillRoot, "references/future.md"), "# Future resource\n");
		await expect(afterPack(context)).resolves.toBeUndefined();
		writeFileSync(join(skillRoot, "references/future.md"), "");
		await expect(afterPack(context)).rejects.toThrow("Packaged Design First resource is empty: references/future.md");
		writeFileSync(join(skillRoot, "references/future.md"), "# Future resource\n");
		writeFileSync(join(skillRoot, "references/unexpected.md"), "# Unexpected resource\n");
		await expect(afterPack(context)).rejects.toThrow("Packaged Design First resource is unexpected: references/unexpected.md");
		rmSync(join(skillRoot, "references/unexpected.md"));
		mkdirSync(join(app, "extensions"));
		writeFileSync(join(app, "extensions/webui.ts"), "export default () => {};");
		await expect(afterPack(context)).rejects.toThrow("Desktop must not bundle application extensions");
		rmSync(join(app, "extensions"), { recursive: true });
		writeFileSync(join(app, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions"] } }));
		await expect(afterPack(context)).rejects.toThrow("Desktop must not bundle application extensions");
		writeFileSync(join(app, "package.json"), JSON.stringify({ pi: { extensions: [] }, dependencies: { "@earendil-works/pi-coding-agent": "2.0.0" } }));
		await expect(afterPack(context)).resolves.toBeUndefined();
		writeFileSync(join(sdk, "package.json"), JSON.stringify({ version: "1.0.0" }));
		await expect(afterPack(context)).rejects.toThrow("expected 2.0.0, got 1.0.0");
		writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { "@earendil-works/pi-coding-agent": "^1.0.0" } }));
		await expect(afterPack(context)).rejects.toThrow("Unexpected packaged Pi SDK version");
	} finally { rmSync(out, { recursive: true, force: true }); }
});
