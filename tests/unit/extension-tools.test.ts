import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireExtensionCommand, extensionToolFailure } from "../../server/extension-tools.js";
import { extensionErrorMessage } from "../../web/src/extensions-presentation.js";

it("distinguishes missing tools, broken commands and custom wrappers without requiring npm", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-tools-"));
	try {
		const cwd = join(root, "目录 with spaces"); mkdirSync(cwd);
		const env = { ...process.env, PATH: cwd, Path: cwd };
		await expect(requireExtensionCommand(["npm"], cwd, env)).rejects.toThrow("[extension-tool-missing:npm]");
		await expect(requireExtensionCommand(["git"], cwd, env)).rejects.toThrow("[extension-tool-missing:git]");
		const script = join(cwd, "wrapper.cjs");
		writeFileSync(script, 'if (process.argv[2] !== "--custom" || process.argv[3] !== "--version") process.exit(3); console.log("fixture 1.0");');
		await requireExtensionCommand([process.execPath, script, "--custom"], cwd, env);
		writeFileSync(script, 'console.error("broken wrapper"); process.exit(2);');
		await expect(requireExtensionCommand([process.execPath, script], cwd, env)).rejects.toThrow("[extension-tool-unusable:");
		writeFileSync(script, 'console.log("x".repeat(20000));');
		await expect(requireExtensionCommand([process.execPath, script], cwd, env)).rejects.toThrow("Tool probe exceeded output limit");
		writeFileSync(script, 'console.log("fixed");');
		await requireExtensionCommand([process.execPath, script], cwd, env);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("adds hints only for explicit missing-command errors and retains diagnostics", () => {
	for (const diagnostic of ["env: node: No such file or directory", "sh: node: command not found", "'node' is not recognized as an internal or external command", "spawn node ENOENT"]) {
		const error = extensionToolFailure(Error("Install failed"), diagnostic);
		expect(error.message).toContain("[extension-tool-missing:node]");
		expect(error.message).toContain(diagnostic);
		expect(extensionErrorMessage(error.message, (key, vars) => `${key} ${vars?.tool ?? ""}`)).toContain("extToolMissing node");
	}
	const ordinary = Error("registry returned 503");
	expect(extensionToolFailure(ordinary, "npm install failed")).toBe(ordinary);
	expect(extensionErrorMessage(ordinary.message, key => key)).toBe(ordinary.message);
});
