import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { builtinExtensionsState } from "../../server/builtin-extensions.js";
import { conversationSettings, nativeToolExtensions } from "../../server/native-tools.js";
import { subagentDefaultActive } from "../../server/subagents/extension.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function fixture(defaultTools?: string[], disabled = false) {
	const root = mkdtempSync(join(tmpdir(), "subagent-activation-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	vi.stubEnv("PI_WEB_DATA_DIR", root);
	if (disabled) writeFileSync(join(root, "subagents.json"), JSON.stringify({ enabled: false }));
	const cwd = join(root, "repo"); mkdirSync(cwd);
	const writeSettings = (tools?: string[]) => writeFileSync(join(root, "settings.json"), JSON.stringify({ defaultTools: tools, codemode: { mode: "only" } }));
	writeSettings(defaultTools);
	const settings = conversationSettings(cwd, root);
	const services = await createAgentSessionServices({ cwd, agentDir: root, settingsManager: settings,
		resourceLoaderOptions: { extensionFactories: nativeToolExtensions(undefined, undefined, () => settings.getSettings().defaultTools) } });
	const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd) });
	cleanups.push(() => session.dispose());
	await session.bindExtensions({});
	return { session, settings, root, writeSettings, item: () => builtinExtensionsState(session, "conversation", true).items.find(item => item.id === "pi-harness-subagents") };
}

test.each([
	[undefined, true], [[], false], [["read"], false], [["subagent"], true], [["*"], true], [["sub*"], true], [["subagen?"], false],
	[["+codemode"], true], [["-subagent"], false], [["-subagent", "+subagent"], true], [["+subagent", "-subagent"], false],
	[["read", "+subagent"], true], [["sub*", "-subagent"], false], [["-sub*"], true],
] as const)("raw defaultTools %j activates subagent: %s", (value, expected) => {
	expect(subagentDefaultActive(value)).toBe(expected);
});

test.each([
	[undefined, true], [[], false], [["read"], false], [["-subagent"], false], [["+codemode"], true], [["sub*"], true],
] as const)("native sessions preserve actual activation under defaultTools %j", async (value, expected) => {
	const { session, item } = await fixture(value ? [...value] : undefined);
	expect(session.getActiveToolNames().includes("subagent")).toBe(expected);
	expect(session.getCallableToolNames()).not.toContain("subagent");
	expect(session.getAllTools().find(tool => tool.name === "subagent")?.exposure).toBe(expected ? "model-only" : "hidden");
	expect(session.systemPrompt.includes("Before substantial project research, call subagent action=sources")).toBe(expected);
	expect(item()).toMatchObject(expected ? { enabled: true, status: "loaded" } : { enabled: true, status: "disabled", reason: "filtered" });
});

test("native filtering blocks existing calls immediately and removes declarations on reload", async () => {
	const { session, settings, writeSettings, item } = await fixture(["+codemode"]);
	expect(session.getActiveToolNames()).toContain("subagent");
	const tool = session.extensionRunner.getAllRegisteredTools().find(tool => tool.definition.name === "subagent")!;
	writeSettings(["-subagent"]); await settings.reload();
	expect(item()).toMatchObject({ status: "disabled", reason: "filtered" });
	// The guard runs before touching its host or execution context.
	await expect(tool.definition.execute("filtered", { action: "sources" }, undefined, undefined, undefined!)).rejects.toThrow(/excluded by native defaultTools/);
	await session.reload();
	expect(session.getActiveToolNames()).not.toContain("subagent");
	expect(session.getAllTools().find(tool => tool.name === "subagent")?.exposure).toBe("hidden");
	writeSettings(["+codemode"]); await session.reload();
	expect(session.getActiveToolNames()).toContain("subagent");
	expect(session.getCallableToolNames()).not.toContain("subagent");
});

test("reenabling the global setting remains pending until reload when native tools permit it", async () => {
	const { session, root, item } = await fixture(undefined, true);
	expect(item()).toMatchObject({ enabled: false, status: "disabled" });
	expect(session.systemPrompt).not.toContain("Before substantial project research, call subagent action=sources");
	writeFileSync(join(root, "subagents.json"), JSON.stringify({ enabled: true }));
	expect(item()).toMatchObject({ enabled: true, status: "pending" });
	await session.reload();
	expect(item()).toMatchObject({ enabled: true, status: "loaded" });
});
