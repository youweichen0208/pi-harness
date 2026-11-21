import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { designFirstResources, designFirstSettings, designFirstSkillPath, toggleDesignFirst } from "../../server/design-first-resources.js";
import { expandNativeTemplate } from "../../server/native-prompt-template.js";

const roots: string[] = [];
function temporary() {
	const root = mkdtempSync(join(tmpdir(), "design-first-"));
	roots.push(root);
	return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("bundled Design First resources", () => {
	it("links stable requirements to scenarios, tasks and outcome evidence", () => {
		const root = join(designFirstSkillPath(resolve(".")), "..");
		const design = readFileSync(join(root, "templates/design.md"), "utf8");
		const tasks = readFileSync(join(root, "templates/tasks.md"), "utf8");
		const outcome = readFileSync(join(root, "templates/outcome.md"), "utf8");
		const smallChanges = readFileSync(join(root, "references/small-changes.md"), "utf8");
		expect(design).toContain("Requirement ID");
		expect(design).toContain("Scenario");
		expect(design).toContain("## Domain model");
		expect(tasks).toContain("| Task ID | Requirement ID |");
		expect(outcome).toContain("Requirement ID");
		expect(smallChanges).toContain("upgrades and downgrades");
	});

	it("keeps implementation, review and confirmation inside the approved design", () => {
		const root = join(designFirstSkillPath(resolve(".")), "..");
		const skill = readFileSync(join(root, "SKILL.md"), "utf8");
		const verification = readFileSync(join(root, "references/verification.md"), "utf8");
		expect(verification).toContain("red → minimal green");
		expect(verification).toContain("## Code quality review");
		expect(verification).toContain("## Design and spec review");
		expect(skill).toContain("before editing business code");
		expect(skill).toContain("not implementation authorization by itself");
		for (const command of ["bug-fix", "design", "feat"]) {
			expect(readFileSync(join(root, `commands/${command}.md`), "utf8")).toContain("does not authorize implementation by itself");
		}
	});

	it("adapts to existing OpenSpec conventions without installing or auto-archiving", () => {
		const root = join(designFirstSkillPath(resolve(".")), "..");
		const reconcile = readFileSync(join(root, "references/reconcile-design.md"), "utf8");
		expect(reconcile).toContain("### Requirement:");
		expect(reconcile).toContain("#### Scenario:");
		expect(reconcile).toContain("Do not install OpenSpec");
		expect(reconcile).toContain("not_run");
		expect(reconcile).toContain("explicit archive request");
	});

	it("resolves every disclosed local Markdown link", () => {
		const root = join(designFirstSkillPath(resolve(".")), "..");
		const pending = [join(root, "SKILL.md")], seen = new Set<string>();
		while (pending.length) {
			const file = pending.pop()!;
			if (seen.has(file)) continue;
			seen.add(file);
			const content = readFileSync(file, "utf8");
			for (const match of content.matchAll(/\[[^]]*\]\(([^)]+)\)/g)) {
				const reference = match[1].split("#")[0];
				if (!reference || /^[a-z]+:/i.test(reference)) continue;
				const target = resolve(file, "..", reference);
				expect(() => readFileSync(target)).not.toThrow();
				if (target.endsWith(".md")) pending.push(target);
			}
		}
	});

	it("registers only prompt commands and leaves user skills untouched", async () => {
		const root = temporary(), userSkill = join(root, "skills/design-first/SKILL.md");
		mkdirSync(join(root, "skills/design-first"), { recursive: true });
		writeFileSync(userSkill, "---\nname: design-first\ndescription: User-owned workflow\n---\nUser instructions\n");
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root,
			settingsManager: SettingsManager.inMemory(), noExtensions: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
			...designFirstResources("normal", root, resolve(".")),
		});
		await loader.reload();
		expect(loader.getSkills().skills.find(s => s.name === "design-first")?.filePath).toBe(userSkill);
		expect(loader.getSkills().diagnostics.some(d => d.type === "collision")).toBe(false);
		expect(loader.getPrompts().prompts.map(prompt => prompt.name).sort()).toEqual(["bug-fix", "design", "feat"]);
		toggleDesignFirst(false, designFirstSettings(root).version, root);
		await loader.reload();
		expect(loader.getSkills().skills.find(s => s.name === "design-first")?.filePath).toBe(userSkill);
		expect(loader.getPrompts().prompts).toEqual([]);
	});
	it("defaults on, persists explicit false and rejects stale settings writes", () => {
		const root = temporary(), initial = designFirstSettings(root);
		expect(initial.enabled).toBe(true);
		toggleDesignFirst(false, initial.version, root);
		expect(designFirstSettings(root).enabled).toBe(false);
		expect(() => toggleDesignFirst(true, initial.version, root)).toThrow("changed");
		toggleDesignFirst(true, designFirstSettings(root).version, root);
		expect(designFirstSettings(root).enabled).toBe(true);
	});

	it("uses native prompt discovery and refreshes the shared setting on reload", async () => {
		const root = temporary();
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root,
			settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
			...designFirstResources("normal", root, resolve(".")),
		});
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getPrompts().prompts.map(prompt => prompt.name).sort()).toEqual(["bug-fix", "design", "feat"]);
		for (const prompt of loader.getPrompts().prompts) {
			expect(prompt.content).toContain(JSON.stringify(designFirstSkillPath(resolve("."))));
			expect(prompt.content).not.toContain("{{DESIGN_FIRST_SKILL_PATH}}");
		}
		toggleDesignFirst(false, designFirstSettings(root).version, root);
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getPrompts().prompts).toEqual([]);
		toggleDesignFirst(true, designFirstSettings(root).version, root);
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getPrompts().prompts.map(prompt => prompt.name).sort()).toEqual(["bug-fix", "design", "feat"]);
		writeFileSync(join(root, "design-first.json"), "broken");
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getPrompts().prompts).toEqual([]);
		expect(loader.getPrompts().diagnostics.some(d => d.message.includes("Design First shortcuts unavailable"))).toBe(true);
	});

	it.each(["bug-fix", "design", "feat"])("keeps the installed skill path literal when expanding %s arguments", async name => {
		const root = temporary(), packageRoot = join(root, "pi-$1-$ARGUMENTS-$@ space");
		mkdirSync(packageRoot);
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@youweichen/pi-harness" }));
		cpSync(new URL("../../assets/skills/design-first", import.meta.url), join(packageRoot, "assets/skills/design-first"), { recursive: true });
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root,
			settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
			...designFirstResources("normal", root, packageRoot),
		});
		await loader.reload();
		const expanded = await expandNativeTemplate(`/${name} "add sorting" '$1 $ARGUMENTS'`, loader.getPrompts().prompts);
		const encodedPath = expanded.match(/"(?:[^"\\]|\\.)*"/)?.[0];
		expect(encodedPath).toBeDefined();
		const skillPath: string = JSON.parse(encodedPath!);
		expect(skillPath).toBe(join(packageRoot, "assets/skills/design-first/SKILL.md"));
		expect(readFileSync(skillPath, "utf8")).toContain("# Design First");
		expect(expanded).toContain("add sorting $1 $ARGUMENTS");
	});

	it.each(["bug-fix", "design", "feat"])("preserves the user's %s prompt content and setting-independent availability", async name => {
		const root = temporary(), userPrompt = join(root, "prompts", `${name}.md`);
		const userContent = "User-owned instructions: {{DESIGN_FIRST_SKILL_PATH}} $ARGUMENTS";
		mkdirSync(join(root, "prompts"), { recursive: true });
		writeFileSync(userPrompt, `---\ndescription: User-owned shortcut\n---\n${userContent}\n`);
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root,
			settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
			noThemes: true, noContextFiles: true,
			...designFirstResources("normal", root, resolve(".")),
		});
		await loader.reload();
		expect(loader.getPrompts().prompts.map(prompt => prompt.name).sort()).toEqual(["bug-fix", "design", "feat"]);
		const own = loader.getPrompts().prompts.find(prompt => prompt.name === name);
		expect(own?.filePath).toBe(userPrompt);
		expect(own?.content.trim()).toBe(userContent);
		toggleDesignFirst(false, designFirstSettings(root).version, root);
		await loader.reload();
		expect(loader.getPrompts().prompts.map(prompt => prompt.name)).toEqual([name]);
		expect(loader.getPrompts().prompts[0].filePath).toBe(userPrompt);
		expect(loader.getPrompts().prompts[0].content.trim()).toBe(userContent);
	});

	it.each(["wiki", "node", "playground"] as const)("does not inject into %s even when enabled", async kind => {
		const root = temporary();
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root,
			settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
			...designFirstResources(kind, root, resolve(".")),
		});
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getPrompts().prompts).toEqual([]);
	});
});
