import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { designFirstResources, designFirstSettings, designFirstSkillPath, toggleDesignFirst } from "../../server/design-first-resources.js";

const roots: string[] = [];
function temporary() {
	const root = mkdtempSync(join(tmpdir(), "design-first-"));
	roots.push(root);
	return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("bundled Design First resources", () => {
	it("links stable requirements to scenarios, tasks and outcome evidence", () => {
		const root = resolve(designFirstSkillPath(resolve(".")), "..");
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
		const root = resolve(designFirstSkillPath(resolve(".")), "..");
		const skill = readFileSync(join(root, "SKILL.md"), "utf8");
		const verification = readFileSync(join(root, "references/verification.md"), "utf8");
		expect(verification).toContain("red → minimal green");
		expect(verification).toContain("## Code quality review");
		expect(verification).toContain("## Design and spec review");
		expect(skill).toContain("before editing business code");
		expect(skill).toContain("not implementation authorization by itself");
		for (const command of ["bug-fix", "feat"]) {
			expect(readFileSync(join(root, command, "SKILL.md"), "utf8")).toContain("does not authorize implementation by itself");
		}
	});

	it("adapts to existing OpenSpec conventions without installing or auto-archiving", () => {
		const root = resolve(designFirstSkillPath(resolve(".")), "..");
		const reconcile = readFileSync(join(root, "references/reconcile-design.md"), "utf8");
		expect(reconcile).toContain("### Requirement:");
		expect(reconcile).toContain("#### Scenario:");
		expect(reconcile).toContain("Do not install OpenSpec");
		expect(reconcile).toContain("not_run");
		expect(reconcile).toContain("explicit archive request");
	});

	it("resolves every disclosed local Markdown link", () => {
		const root = resolve(designFirstSkillPath(resolve(".")), "..");
		const pending = ["", "feat", "bug-fix"].map(name => join(root, name, "SKILL.md")), seen = new Set<string>();
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

	it("defaults on, persists explicit false and rejects stale settings writes", () => {
		const root = temporary(), initial = designFirstSettings(root);
		expect(initial.enabled).toBe(true);
		toggleDesignFirst(false, initial.version, root);
		expect(designFirstSettings(root).enabled).toBe(false);
		expect(() => toggleDesignFirst(true, initial.version, root)).toThrow("changed");
		toggleDesignFirst(true, designFirstSettings(root).version, root);
		expect(designFirstSettings(root).enabled).toBe(true);
	});

	it("loads the three native skills and refreshes the setting on reload", async () => {
		const root = temporary();
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(), noSkills: true, ...designFirstResources("normal", root) });
		const names = () => loader.getSkills().skills.map(skill => skill.name).sort();
		await loader.reload();
		expect(names()).toEqual(["bug-fix", "design-first", "feat"]);
		expect(loader.getPrompts().prompts).toEqual([]);
		toggleDesignFirst(false, designFirstSettings(root).version, root);
		await loader.reload();
		expect(names()).toEqual([]);
		toggleDesignFirst(true, designFirstSettings(root).version, root);
		await loader.reload();
		expect(names()).toEqual(["bug-fix", "design-first", "feat"]);
		writeFileSync(join(root, "design-first.json"), "broken");
		await loader.reload();
		expect(names()).toEqual([]);
		expect(loader.getSkills().diagnostics.some(d => d.message.includes("Design First skills unavailable"))).toBe(true);
	});

	it.each(["bug-fix", "design-first", "feat"])("preserves a user-owned %s skill across reloads", async name => {
		const root = temporary(), dir = join(root, "skills", name);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "SKILL.md");
		writeFileSync(path, `---\nname: ${name}\ndescription: User workflow\n---\nUser instructions\n`);
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(), ...designFirstResources("normal", root) });
		await loader.reload();
		expect(loader.getSkills().skills.find(skill => skill.name === name)?.filePath).toBe(path);
		toggleDesignFirst(false, designFirstSettings(root).version, root);
		await loader.reload();
		expect(loader.getSkills().skills.find(skill => skill.name === name)?.filePath).toBe(path);
	});

	it.each(["wiki", "node", "subagent", "playground"] as const)("does not inject into %s even when enabled", async kind => {
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
